import express, { type Request, type Response, type NextFunction } from 'express'
import cors, { type CorsOptions } from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { auth } from 'express-oauth2-jwt-bearer'
import { ManagementClient } from 'auth0'
import {
  AUTH0_AUDIENCE,
  AUTH0_DOMAIN,
  AUTH0_MGMT_CLIENT_ID,
  AUTH0_MGMT_CLIENT_SECRET,
  ALLOWED_ORIGINS,
  IS_PROD,
  TRUST_PROXY,
} from './config'
import { createTranslateRouter } from './translate'
import { createFavoritesRouter } from './favorites'
import type { LlmProvider } from './providers/llm'
import type { DictionaryProvider } from './providers/dictionary'
import type { TranslationCache } from './cache/translationCache'

export interface AppDeps {
  llmProvider: LlmProvider | null
  dictionaryProvider: DictionaryProvider
  translationCache: TranslationCache | null
}

const MAX_HISTORY = 30

interface Auth0Payload {
  sub?: string
}

function userIdFromReq(req: Request): string | undefined {
  const payload = (req as unknown as { auth?: { payload?: Auth0Payload } }).auth?.payload
  return payload?.sub
}

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

interface HandledError {
  status?: number
  statusCode?: number
  message?: string
}

export function createApp({ llmProvider, dictionaryProvider, translationCache }: AppDeps) {
  const app = express()

  if (TRUST_PROXY !== '0') {
    const n = Number(TRUST_PROXY)
    app.set('trust proxy', Number.isNaN(n) ? TRUST_PROXY : n)
  }

  app.use(helmet())

  const originAllowlist = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  const corsOptions: CorsOptions = {
    origin(origin, cb) {
      if (!origin) return cb(null, true)
      if (originAllowlist.includes(origin)) return cb(null, true)
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

  app.locals.llm = llmProvider

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  app.use('/api', createTranslateRouter(dictionaryProvider, translationCache))
  app.use('/api', createFavoritesRouter())

  app.get(
    '/api/user-data',
    apiLimiter,
    checkJwt,
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  )

  app.put(
    '/api/user-data',
    apiLimiter,
    checkJwt,
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  )

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' })
  })

  app.use((err: HandledError, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500
    if (status >= 500) {
      console.error('[api] %s %s ->', req.method, req.path, err)
    }
    const body: { error: string; detail?: string } = {
      error: status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'internal',
    }
    if (!IS_PROD && status >= 500) body.detail = err.message
    res.status(status).json(body)
  })

  return app
}
