import 'dotenv/config'
import { config as loadEnvFile } from 'dotenv'
import express, { type Request, type Response, type NextFunction } from 'express'
import cors, { type CorsOptions } from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { auth } from 'express-oauth2-jwt-bearer'
import { ManagementClient } from 'auth0'
import { createLlmProviderFromEnv } from './providers/llm'
import { createDictionaryProvider } from './providers/dictionary'
import { createTranslateRouter } from './translate'
import { connectMongo } from './db'
import { createTranslationCache, type TranslationCache, type TranslationDoc } from './cache/translationCache'
import { createFavoritesRouter } from './favorites'

// Load server-only secrets (e.g. ZAI_API_KEY) from server/.env. Additive only —
// never overrides values already in the environment or the root .env.
loadEnvFile({ path: 'server/.env' })

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error('Missing required env var in server/.env:', name)
    console.error(
      'Need: AUTH0_DOMAIN, AUTH0_AUDIENCE, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET'
    )
    process.exit(1)
  }
  return value
}

const AUTH0_DOMAIN = required('AUTH0_DOMAIN')
const AUTH0_AUDIENCE = required('AUTH0_AUDIENCE')
const AUTH0_MGMT_CLIENT_ID = required('AUTH0_MGMT_CLIENT_ID')
const AUTH0_MGMT_CLIENT_SECRET = required('AUTH0_MGMT_CLIENT_SECRET')
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
const TRUST_PROXY = process.env.TRUST_PROXY ?? '0'
const NODE_ENV = process.env.NODE_ENV ?? 'development'
const PORT = Number(process.env.PORT ?? 3001)

const isProd = NODE_ENV === 'production'

const app = express()

// Behind a load balancer / reverse proxy (Heroku, Fly, Render, nginx) the
// real client IP arrives in X-Forwarded-For. Rate limiting needs that to be
// trusted to avoid being keyed off the proxy IP.
if (TRUST_PROXY !== '0') {
  const n = Number(TRUST_PROXY)
  app.set('trust proxy', Number.isNaN(n) ? TRUST_PROXY : n)
}

app.use(helmet())

const originAllowlist = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
const corsOptions: CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true) // same-origin / curl
    if (originAllowlist.includes(origin)) return cb(null, true)
    // Silently deny — browser will block the request without a CORS header.
    return cb(null, false)
  },
  methods: ['GET', 'PUT', 'OPTIONS'],
  credentials: false,
  maxAge: 86400,
}
app.use(cors(corsOptions))

app.use(express.json({ limit: '64kb' }))

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

const checkJwt = auth({
  audience: AUTH0_AUDIENCE,
  issuerBaseURL: `https://${AUTH0_DOMAIN}/`,
  tokenSigningAlg: 'RS256',
})

const mgmt = new ManagementClient({
  domain: AUTH0_DOMAIN,
  clientId: AUTH0_MGMT_CLIENT_ID,
  clientSecret: AUTH0_MGMT_CLIENT_SECRET,
})

// Primary translation tier (LLM). Null when unconfigured/disabled — the translate
// route falls back to the dictionary tier in that case (design doc §5).
const llmRegistry = createLlmProviderFromEnv()
app.locals.llm = llmRegistry.provider
console.log(`[llm] ${llmRegistry.status.toUpperCase()} — ${llmRegistry.message}`)

// Fallback tier (dictionary). Called by the translate route only when the LLM
// tier is unavailable or fails (design doc §5).
const dictionaryProvider = createDictionaryProvider({
  baseUrl: process.env.FREE_DICTIONARY_API_BASE?.trim() || undefined,
})

// MongoDB: translation cache + favorites. Connects at boot (top-level await);
// degrades gracefully (cache=null, favorites return empty) if unavailable.
const MONGODB_URI = process.env.MONGODB_URI?.trim()
const MONGODB_DB = process.env.MONGODB_DB?.trim() || undefined
let translationCache: TranslationCache | null = null
if (MONGODB_URI) {
  try {
    const db = await connectMongo(MONGODB_URI, MONGODB_DB)
    translationCache = createTranslationCache(db.collection<TranslationDoc>('translations'))
    console.log(`[mongo] connected (db: ${db.databaseName})`)
  } catch (err) {
    console.error('[mongo] connection failed — cache/favorites degraded:', err)
  }
} else {
  console.log('[mongo] MONGODB_URI not set — cache/favorites disabled')
}

interface Auth0Payload {
  sub?: string
}

function userIdFromReq(req: Request): string | undefined {
  const payload = (req as unknown as { auth?: { payload?: Auth0Payload } }).auth?.payload
  return payload?.sub
}

const MAX_HISTORY = 30

function sanitizeWordList(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of list) {
    if (typeof w !== 'string') continue
    const trimmed = w.trim().toLowerCase()
    if (!trimmed || trimmed.length > 64) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// GET /api/translate/:text — cache → LLM → dictionary fallback (design doc §5, §6, §8).
app.use('/api', createTranslateRouter(dictionaryProvider, translationCache))
// GET/POST/DELETE /api/favorites — Mongo-backed, keyed by (userKey, word, langs).
app.use('/api', createFavoritesRouter())

app.get('/api/user-data', apiLimiter, checkJwt, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = userIdFromReq(req)
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const user = await mgmt.users.get({ id: userId })
    const meta = (user?.data?.user_metadata ?? {}) as Record<string, unknown>
    res.json({
      history: Array.isArray(meta.history) ? meta.history : [],
    })
  } catch (err) {
    next(err)
  }
})

app.put('/api/user-data', apiLimiter, checkJwt, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = userIdFromReq(req)
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const body = (req.body ?? {}) as { history?: unknown }
    const history = sanitizeWordList(body.history, MAX_HISTORY)
    await mgmt.users.update({ id: userId }, { user_metadata: { history } })
    res.json({ history })
  } catch (err) {
    next(err)
  }
})

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found' })
})

interface HandledError {
  status?: number
  statusCode?: number
  message?: string
}

app.use((err: HandledError, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? err.statusCode ?? 500
  if (status >= 500) {
    console.error('[api] %s %s ->', req.method, req.path, err)
  }
  const body: { error: string; detail?: string } = {
    error: status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'internal',
  }
  if (!isProd && status >= 500) body.detail = err.message
  res.status(status).json(body)
})

const server = app.listen(PORT, () => {
  console.log(`open-dictionary API listening on http://localhost:${PORT} (${NODE_ENV})`)
})

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
