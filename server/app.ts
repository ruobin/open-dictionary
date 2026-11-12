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
  USERDATA_RATE_LIMIT_RPM,
} from './config'
import { createTranslateRouter, modelNameFromProviderId } from './translate'
import { createFavoritesRouter } from './favorites'
import { getMongoDb } from './db'
import { createUsageService, type UsageService } from './usage'
import { createUsageRouter } from './usage/router'
import { createAuth0Directory } from './usage/verification'
import { createSuggestRouter } from './suggest'
import { createReportRouter } from './report'
import { createActivityPingRouter } from './activityPing'
import { createWordOfDayRouter } from './wordOfDay'
import { createMoreExamplesRouter } from './moreExamples'
import { createBrowseRouter } from './browse'
import { createAdminRouter } from './admin/router'
import { blocklistGuard } from './abuseGuard'
import { createRequireAdmin } from './admin/auth'
import type { LlmService } from './llm/service'
import type { DictionaryProvider } from './providers/dictionary'
import type { TranslationCache } from './cache/translationCache'
import type { FavoriteKey } from '../shared/favorites'

export interface AppDeps {
  llmService: LlmService
  dictionaryProvider: DictionaryProvider
  translationCache: TranslationCache | null
  /** Usage metering; built from Mongo and the Auth0 Management API when omitted. */
  usage?: UsageService
}

/** Model names of the owner's full setup, e.g. ["deepseek-v4-flash", "glm-5.2"]. */
function fullModelsOf(llmService: LlmService): string[] {
  const s = llmService.status()
  if (s.model) return [s.model, ...(s.secondaryModel ? [s.secondaryModel] : [])]
  const id = llmService.current()?.id
  return id ? [modelNameFromProviderId(id)] : []
}

const MAX_HISTORY = 30

interface Auth0Payload {
  sub?: string
}

function userIdFromReq(req: Request): string | undefined {
  const payload = (req as unknown as { auth?: { payload?: Auth0Payload } }).auth?.payload
  return payload?.sub
}

function sanitizeHistoryList(list: unknown, max: number): FavoriteKey[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: FavoriteKey[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const word = typeof e.word === 'string' ? e.word.trim().toLowerCase() : ''
    const sourceLang = typeof e.sourceLang === 'string' ? e.sourceLang.trim().toLowerCase() : ''
    const targetLang = typeof e.targetLang === 'string' ? e.targetLang.trim().toLowerCase() : ''
    if (!word || !sourceLang || !targetLang || word.length > 256) continue
    const key = `${sourceLang}:${targetLang}:${word}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ word, sourceLang, targetLang })
    if (out.length >= max) break
  }
  return out
}

interface HandledError {
  status?: number
  statusCode?: number
  message?: string
}

export function createApp({ llmService, dictionaryProvider, translationCache, usage: usageDep }: AppDeps) {
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: false,
    maxAge: 86400,
  }
  app.use(cors(corsOptions))

  app.use(express.json({ limit: '64kb' }))

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: USERDATA_RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  })

  const checkJwt = auth({
    audience: AUTH0_AUDIENCE,
    issuerBaseURL: `https://${AUTH0_DOMAIN}/`,
    tokenSigningAlg: 'RS256',
  })

  // Lookup routes are public: a valid token identifies the caller (owner,
  // signed-in user); a missing or invalid one leaves the request anonymous
  // (docs/design-llm-usage-quotas.md §5.2).
  const optionalJwt = auth({
    audience: AUTH0_AUDIENCE,
    issuerBaseURL: `https://${AUTH0_DOMAIN}/`,
    tokenSigningAlg: 'RS256',
    authRequired: false,
  })

  const mgmt = new ManagementClient({
    domain: AUTH0_DOMAIN,
    clientId: AUTH0_MGMT_CLIENT_ID,
    clientSecret: AUTH0_MGMT_CLIENT_SECRET,
  })

  const usage =
    usageDep ??
    createUsageService({
      db: getMongoDb(),
      directory: createAuth0Directory(mgmt),
      meteredProviderId: () => llmService.currentMetered()?.id,
    })

  app.locals.llmService = llmService
  app.locals.usage = usage

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  // Public routers first: createFavoritesRouter applies `checkJwt` via
  // `router.use()`, which runs unconditionally for every path that reaches
  // that router — mounting it before these would 401 unauthenticated
  // requests to /suggest, /report, /word-of-day, and /more-examples before
  // they ever reach these handlers.
  // Admin-managed IP/CIDR blocklist (server/abuseGuard.ts). It runs before
  // every public router; /api/admin/* is exempt.
  app.use('/api', blocklistGuard)
  app.use('/api', createTranslateRouter(dictionaryProvider, translationCache, { usage, optionalJwt }))
  app.use('/api', createSuggestRouter())
  app.use('/api', createReportRouter())
  app.use('/api', createActivityPingRouter())
  app.use('/api', createWordOfDayRouter())
  app.use('/api', createMoreExamplesRouter({ usage, optionalJwt }))
  app.use('/api', createUsageRouter({ usage, optionalJwt, fullModels: () => fullModelsOf(llmService) }))
  app.use('/api', createBrowseRouter())
  app.use('/api', createFavoritesRouter(checkJwt))

  // Allowlist-only admin portal (design doc §17 Q1: no Auth0 RBAC/permissions
  // check, just checkJwt + sub ∈ ADMIN_USER_IDS). createRequireAdmin returns
  // [checkJwt, adminOnly], spread directly per its own doc comment.
  app.use(
    '/api/admin',
    ...createRequireAdmin(checkJwt),
    createAdminRouter(llmService, { usage, dictionary: dictionaryProvider, cache: translationCache })
  )

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
        const history = sanitizeHistoryList(body.history, MAX_HISTORY)
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
