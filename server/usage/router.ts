import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { USERDATA_RATE_LIMIT_RPM } from '../config'
import type { UsageService } from './index'
import { todayBudgetMicros, type AllowanceView } from './meter'
import { coldStartEstimateMicros } from './pricing'
import { identify, identityOf, rateLimitKey, type UsageIdentity } from './principal'
import type { UsageSettings } from './settings'
import type { AccountDoc, AuthState, EnforcementMode, UsagePool } from './types'
import { counterKeys, nextUtcDay, utcDay, utcMonth } from './windows'

/**
 * `GET /api/usage/me` and the email-verification helpers
 * (docs/design-llm-usage-quotas.md §5.7). Optional auth: anonymous visitors
 * get their IP's allowance.
 */

export type FreeTierState = 'open' | 'budget_reached' | 'paused'

export interface UsageMeView {
  tier: 'owner' | 'exempt' | 'user' | 'anon'
  authState: AuthState
  enforcement: EnforcementMode
  /** Signed-in users only; null otherwise. */
  emailVerified: boolean | null
  /** The admin blocked this account. */
  blocked?: true
  /** The caller's free allowance today; null when nothing is counted (owner, unlimited, metering off). */
  today: AllowanceView | null
  freeTier: FreeTierState
  /** Anonymous and unverified callers: the daily allowance a verified account gets ("sign in for 20 a day"). */
  verifiedLimit?: number
  /** Owner only: the models of the full setup (for the Regenerate link). */
  fullModels?: string[]
}

export interface UsageRouterOptions {
  usage: UsageService
  optionalJwt: RequestHandler
  /** Models of the owner's full setup, e.g. ["deepseek-v4-flash", "glm-5.2"]. */
  fullModels: () => string[]
}

async function freeTierState(
  usage: UsageService,
  settings: UsageSettings,
  pool: UsagePool,
  now: Date
): Promise<FreeTierState> {
  if (!settings.freeTierEnabled) return 'paused'
  const store = usage.store
  if (!store) return 'open'
  const day = utcDay(now)
  const keys = [counterKeys.free(day), counterKeys.freeAnon(day), counterKeys.monthFree(utcMonth(now))]
  const counters = await store.getCounters(keys)
  const daySpent = counters.get(keys[0])?.costMicros ?? 0
  const anonSpent = counters.get(keys[1])?.costMicros ?? 0
  const monthSpent = counters.get(keys[2])?.costMicros ?? 0
  const budget = todayBudgetMicros(settings, daySpent, monthSpent, now)
  const oneMore = coldStartEstimateMicros(usage.meteredProviderId(), 'lookup')
  if (daySpent + oneMore > budget) return 'budget_reached'
  if (pool === 'ip' && anonSpent + oneMore > Math.floor(budget * settings.anonShare)) return 'budget_reached'
  return 'open'
}

export async function describeUsage(
  usage: UsageService,
  identity: UsageIdentity,
  fullModels: () => string[],
  now: Date = new Date()
): Promise<UsageMeView> {
  const settings = usage.settings()
  const p = identity.principal
  const base = { authState: identity.authState, enforcement: settings.enforcement }
  const store = usage.store

  if (p.kind === 'owner') {
    return {
      ...base,
      tier: 'owner',
      emailVerified: null,
      today: null,
      freeTier: await freeTierState(usage, settings, 'account', now),
      fullModels: fullModels(),
    }
  }

  let account: AccountDoc | null = null
  if (p.kind === 'user' && store) account = await store.ensureAccount(p.sub, now)
  if (account?.plan === 'unlimited') {
    return { ...base, tier: 'exempt', emailVerified: null, today: null, freeTier: 'open' }
  }
  const verified = account ? await usage.verifier.isVerified(account) : false
  const pool: UsagePool = account && verified ? 'account' : 'ip'
  const tier = p.kind === 'user' ? 'user' : 'anon'
  const emailVerified = p.kind === 'user' ? verified : null
  const blocked = account?.status === 'blocked' ? ({ blocked: true } as const) : {}
  const upgrade = pool === 'ip' ? { verifiedLimit: settings.userDailyFree } : {}

  if (!store || settings.enforcement === 'off') {
    return {
      ...base,
      tier,
      emailVerified,
      ...blocked,
      today: null,
      freeTier: settings.freeTierEnabled ? 'open' : 'paused',
      ...upgrade,
    }
  }

  const day = utcDay(now)
  const key = pool === 'account' ? counterKeys.user(day, (account as AccountDoc)._id) : counterKeys.ip(day, p.ipKey)
  const limit = pool === 'account' ? (account?.dailyAllowance ?? settings.userDailyFree) : settings.anonDailyPerIp
  const used = (await store.getCounters([key])).get(key)?.n ?? 0
  return {
    ...base,
    tier,
    emailVerified,
    ...blocked,
    today: { used: Math.min(used, limit), limit, pool, resetAt: nextUtcDay(now).toISOString() },
    freeTier: await freeTierState(usage, settings, pool, now),
    ...upgrade,
  }
}

export function createUsageRouter(opts: UsageRouterOptions): Router {
  const { usage, optionalJwt } = opts
  const router = Router()

  const meLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: USERDATA_RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => rateLimitKey(identityOf(req, res)),
    message: { error: 'rate_limited' },
  })
  const verifyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => rateLimitKey(identityOf(req, res)),
    message: { error: 'rate_limited' },
  })

  router.get('/usage/me', optionalJwt, identify, meLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(await describeUsage(usage, identityOf(req, res), opts.fullModels))
    } catch (err) {
      console.warn('[usage] GET /usage/me failed:', err)
      if (!res.headersSent) res.status(503).json({ error: 'usage_unavailable' })
      else next(err)
    }
  })

  /** Resolves the signed-in (non-owner) account, or answers the request itself. */
  async function accountFor(req: Request, res: Response): Promise<AccountDoc | null> {
    const { principal } = identityOf(req, res)
    if (principal.kind === 'anon') {
      res.status(401).json({ error: 'unauthorized' })
      return null
    }
    if (principal.kind === 'owner') {
      res.status(400).json({ error: 'not_applicable' })
      return null
    }
    if (!usage.store) {
      res.status(503).json({ error: 'usage_unavailable' })
      return null
    }
    return usage.store.ensureAccount(principal.sub, new Date())
  }

  router.post('/usage/verify-email/resend', optionalJwt, identify, verifyLimiter, async (req, res, next) => {
    try {
      const account = await accountFor(req, res)
      if (!account) return
      const result = await usage.verifier.resend(account)
      const status = result === 'rate_limited' ? 429 : result === 'unavailable' ? 503 : 200
      res.status(status).json({ result, emailVerified: result === 'already_verified' })
    } catch (err) {
      next(err)
    }
  })

  router.post('/usage/verify-email/refresh', optionalJwt, identify, verifyLimiter, async (req, res, next) => {
    try {
      const account = await accountFor(req, res)
      if (!account) return
      res.json({ emailVerified: await usage.verifier.isVerified(account, { force: true }) })
    } catch (err) {
      next(err)
    }
  })

  return router
}
