import { MongoClient, type Db } from 'mongodb'

let client: MongoClient | null = null
let database: Db | null = null

const TRANSLATION_TTL_SECONDS = 365 * 24 * 60 * 60 // 1 year (design doc §6)
const MORE_EXAMPLES_TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days — more speculative/long-tail than the main cache

// Admin portal (docs/design-admin-portal.md §4, retention confirmed §17 Q4).
const LLM_BENCHMARKS_TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days
const LLM_LATENCY_PROBES_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
const ADMIN_AUDIT_TTL_SECONDS = 365 * 24 * 60 * 60 // 1 year

/** Connects to MongoDB and ensures required indexes (idempotent). */
export async function connectMongo(uri: string, dbName = 'open-dictionary'): Promise<Db> {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  database = client.db(dbName)
  await ensureIndexes(database)
  return database
}

/** Returns the connected DB, or null if never connected / unavailable. */
export function getMongoDb(): Db | null {
  return database
}

async function ensureIndexes(db: Db): Promise<void> {
  // Dict cache: unique per (word, sourceLang, targetLang, version) + TTL on fetchedAt.
  // `version` was added to the key (to-do §2) so prompt/schema bumps get a fresh
  // cache slot instead of serving a frozen pre-bump entry for the full TTL.
  const translations = db.collection('translations')
  try {
    await translations.dropIndex('translations_key')
  } catch (err) {
    if ((err as { codeName?: string })?.codeName !== 'IndexNotFound') throw err
  }
  await translations.createIndex(
    { word: 1, sourceLang: 1, targetLang: 1, version: 1 },
    { unique: true, name: 'translations_key_v2' }
  )
  await translations.createIndex(
    { fetchedAt: 1 },
    { expireAfterSeconds: TRANSLATION_TTL_SECONDS, name: 'translations_ttl' }
  )
  // Autocomplete (to-do §6): prefix scan over cached words for a given source
  // language, e.g. { sourceLang: 'en', word: /^ser/ }.
  await translations.createIndex(
    { sourceLang: 1, word: 1 },
    { name: 'translations_suggest' }
  )

  // Favorites: one per (userKey, word, sourceLang, targetLang); list by userKey.
  const favorites = db.collection('favorites')
  await favorites.createIndex(
    { userKey: 1, word: 1, sourceLang: 1, targetLang: 1 },
    { unique: true, name: 'favorites_key' }
  )
  await favorites.createIndex({ userKey: 1 }, { name: 'favorites_user' })

  // Reports ("Report this entry", to-do §4): reviewed by word, newest first.
  const reports = db.collection('reports')
  await reports.createIndex(
    { word: 1, sourceLang: 1, targetLang: 1 },
    { name: 'reports_word' }
  )
  await reports.createIndex({ createdAt: -1 }, { name: 'reports_recent' })

  // "More examples like this" (to-do §3): _id is already the cache-key hash
  // (word + sense + constraints), so only a TTL index is needed.
  const moreExamples = db.collection('more_examples')
  await moreExamples.createIndex(
    { fetchedAt: 1 },
    { expireAfterSeconds: MORE_EXAMPLES_TTL_SECONDS, name: 'more_examples_ttl' }
  )

  // --- Admin portal (docs/design-admin-portal.md §4) ---

  // Providers: unique human-readable name (design doc §4.1 validation rules).
  const llmProviders = db.collection('llm_providers')
  await llmProviders.createIndex({ name: 1 }, { unique: true, name: 'llm_providers_name' })

  // Settings is a singleton (`_id: "llm"`); the default _id index is enough.

  // Benchmarks (Latency Lab history): lookup by runId, list newest-first,
  // filter by target provider; TTL bounds the collection (§4.3, 90d confirmed).
  const llmBenchmarks = db.collection('llm_benchmarks')
  await llmBenchmarks.createIndex({ runId: 1 }, { unique: true, name: 'llm_benchmarks_run_id' })
  await llmBenchmarks.createIndex({ finishedAt: -1 }, { name: 'llm_benchmarks_recent' })
  await llmBenchmarks.createIndex({ 'targets.providerId': 1 }, { name: 'llm_benchmarks_provider' })
  await llmBenchmarks.createIndex(
    { finishedAt: 1 },
    { expireAfterSeconds: LLM_BENCHMARKS_TTL_SECONDS, name: 'llm_benchmarks_ttl' }
  )

  // Scheduled probe samples (§4.4, §9.6, off by default): trend series per
  // provider. TTL indexes can't be compound, so it's a second single-field one.
  const llmLatencyProbes = db.collection('llm_latency_probes')
  await llmLatencyProbes.createIndex(
    { providerId: 1, ts: -1 },
    { name: 'llm_latency_probes_series' }
  )
  await llmLatencyProbes.createIndex(
    { ts: 1 },
    { expireAfterSeconds: LLM_LATENCY_PROBES_TTL_SECONDS, name: 'llm_latency_probes_ttl' }
  )

  // Append-only change log (§4.5): `?limit&before` pagination reads off the
  // same TTL field, newest first.
  const adminAudit = db.collection('admin_audit')
  await adminAudit.createIndex(
    { ts: 1 },
    { expireAfterSeconds: ADMIN_AUDIT_TTL_SECONDS, name: 'admin_audit_ttl' }
  )
}
