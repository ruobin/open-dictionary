import {
  DICTIONARY_API_BASE,
  MERRIAM_WEBSTER_API_KEY,
  MONGODB_DB,
  MONGODB_URI,
  PORT,
} from './config'
import { connectMongo } from './db'
import { createLlmProviderFromEnv } from './providers/llm'
import { createLlmService } from './llm/service'
import { createDictionaryProvider } from './providers/dictionary'
import { createTranslationCache, type TranslationDoc } from './cache/translationCache'
import { createApp } from './app'
import { logMetricsSummary } from './metrics'

const dictionaryProvider = createDictionaryProvider({
  baseUrl: DICTIONARY_API_BASE || undefined,
  apiKey: MERRIAM_WEBSTER_API_KEY || undefined,
})

const llmRegistry = createLlmProviderFromEnv()
console.log(`[llm] ${llmRegistry.status.toUpperCase()} — ${llmRegistry.message}`)
const llmService = createLlmService(llmRegistry)

// MongoDB: translation cache + favorites.
let translationCache: ReturnType<typeof createTranslationCache> | null = null
if (MONGODB_URI) {
  try {
    const db = await connectMongo(MONGODB_URI, MONGODB_DB)
    translationCache = createTranslationCache(db.collection<TranslationDoc>('translations'))
    console.log(`[mongo] connected (db: ${db.databaseName})`)
    // Layer any admin-portal DB config on top of the env baseline (§7.2) —
    // reloadFromDb() never throws, it falls back to the env provider on any
    // DB-config failure.
    await llmService.reloadFromDb()
    console.log(`[llm] state: ${JSON.stringify(llmService.status())}`)
  } catch (err) {
    console.error('[mongo] connection failed — cache/favorites degraded:', err)
  }
} else {
  console.log('[mongo] MONGODB_URI not set — cache/favorites disabled')
}

const app = createApp({
  llmService,
  dictionaryProvider,
  translationCache,
})

const server = app.listen(PORT, () => {
  console.log(`open-dictionary API listening on http://localhost:${PORT} (${process.env.NODE_ENV ?? 'development'})`)
})

// Periodic metrics summary (to-do §9, design doc §12) — plain structured
// logs, queryable via whatever log aggregation is already in place; no new
// metrics infra. unref() so this timer never keeps the process alive.
setInterval(logMetricsSummary, 5 * 60 * 1000).unref()

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`)
  server.close((err) => {
    if (err) {
      console.error('Error during shutdown', err)
      process.exit(1)
    }
    process.exit(0)
  })
  setTimeout(() => {
    console.error('Forcing shutdown after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
