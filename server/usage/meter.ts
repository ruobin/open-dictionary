import type { ActivityChannel } from '../activityLog'
import type { LlmUsageRecord, UsageSink } from '../providers/llm/types'
import { coldStartEstimateMicros, costOf, percentile } from './pricing'
import type { UsageSettings } from './settings'
import type { UsageStore } from './store'
import type { Verifier } from './verification'
import type {
  AccountDoc,
  Principal,
  QuotaNextStep,
  QuotaReason,
  UsageAction,
  UsagePool,
  UsageRoute,
  UsageSource,
} from './types'
import {
  counterKeys,
  dayKeyExpiry,
  daysLeftInUtcMonth,
  denialKeyExpiry,
  monthKeyExpiry,
  nextUtcDay,
  nextUtcMonth,
  utcDay,
  utcMonth,
} from './windows'

/**
 * The quota decision for one generation (docs/design-llm-usage-quotas.md
 * §5.3). `reserve()` runs on the in-flight leader after a cache miss, right
 * before the LLM call; the returned ticket is settled once, when the in-flight
 * entry is released, with the real token cost.
 *
 * Free generations hold an *estimated* cost against the budget while they
 * run, and settle replaces it with the actual cost, so concurrent generations
 * can't overshoot the budget by more than the estimates' error.
 */

export class MeterError extends Error {}

export class QuotaDeniedError extends MeterError {
  constructor(
    readonly reason: QuotaReason,
    readonly limit: number,
    readonly used: number,
    readonly resetAt: Date,
    readonly actions: QuotaNextStep[]
  ) {
    super(`quota exceeded: ${reason}`)
    this.name = 'QuotaDeniedError'
  }

  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil((this.resetAt.getTime() - Date.now()) / 1000))
  }

  toBody(): QuotaDeniedBody {
    return {
      error: 'quota_exceeded',
      reason: this.reason,
      limit: this.limit,
      used: this.used,
      resetAt: this.resetAt.toISOString(),
      actions: this.actions,
    }
  }
}

export interface QuotaDeniedBody {
  error: 'quota_exceeded'
  reason: QuotaReason
  limit: number
  used: number
  resetAt: string
  actions: QuotaNextStep[]
}

/** The admin blocked this account: it gets the IP blocklist's response. */
export class AccountBlockedError extends MeterError {
  constructor() {
    super('account blocked')
    this.name = 'AccountBlockedError'
  }
}

/** Metering storage is down while enforcement is on: fail closed (503). */
export class GenerationUnavailableError extends MeterError {
  constructor(cause?: unknown) {
    super('generation unavailable: usage metering is down')
    this.name = 'GenerationUnavailableError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/** Today's free budget in micro-USD (§4.3). Spend figures include open reservations. */
export function todayBudgetMicros(
  settings: Pick<UsageSettings, 'freeTierEnabled' | 'freeTierDailyUsd' | 'freeTierMonthlyUsd' | 'pacing'>,
  daySpentMicros: number,
  monthSpentMicros: number,
  now: Date
): number {
  if (!settings.freeTierEnabled) return 0
  const dailyCap = Math.round(settings.freeTierDailyUsd * 1e6)
  const monthlyCap = Math.round(settings.freeTierMonthlyUsd * 1e6)
  const spentBefore = Math.max(0, monthSpentMicros - daySpentMicros)
  const remaining = Math.max(0, monthlyCap - spentBefore)
  const available = settings.pacing === 'even' ? Math.floor(remaining / daysLeftInUtcMonth(now)) : remaining
  return Math.max(0, Math.min(dailyCap, available))
}

export interface AllowanceView {
  used: number
  limit: number
  pool: UsagePool
  resetAt: string
}

export interface SettleOutcome {
  /** The LLM answered, so the user is charged a unit. */
  charged: boolean
  /** Provider that served the route. */
  providerId?: string
}

export interface Ticket {
  readonly source: UsageSource
  readonly route: UsageRoute
  readonly pool?: UsagePool
  /** Shadow mode: why enforcement would have refused this generation. */
  readonly wouldDeny?: QuotaReason
  /** Collects every upstream call's token usage; pass it to the provider. */
  readonly usage: UsageSink
  /** The caller's free allowance after this generation (null when nothing is counted). */
  allowance(charged: boolean): AllowanceView | null
  /** Settles the real cost and writes the ledger. Runs once; never throws. */
  settle(outcome: SettleOutcome): Promise<void>
}

export interface ReserveInput {
  principal: Principal
  action: UsageAction
  channel: ActivityChannel
  word: string
  sourceLang: string
  targetLang: string
}

export interface BudgetAlertSink {
  /** Called after a free reservation with the month's spend including it. */
  monthSpend(month: string, spentMicros: number, capMicros: number): void
  /** Called when a free generation is refused because today's or the month's budget is used up. */
  budgetReached(day: string, monthExhausted: boolean): void
}

export interface MeterDeps {
  store: UsageStore | null
  settings: () => UsageSettings
  verifier: Verifier
  /** Provider currently serving the metered route, for the cost estimate. */
  meteredProviderId: () => string | undefined
  alerts?: BudgetAlertSink
  now?: () => Date
}

export interface Meter {
  reserve(input: ReserveInput): Promise<Ticket>
}

interface Reservation {
  allowanceKey: string
  allowanceUsed: number
  allowanceLimit: number
  /** Day counters holding the estimate (the budget, and the anonymous share for pool `ip`). */
  dayCostKeys: string[]
  monthKey: string
  dayExpiresAt: Date
  monthExpiresAt: Date
  resetAt: Date
}

const ESTIMATE_REFRESH_MS = 10 * 60_000
const ESTIMATE_MIN_SAMPLES = 20

/** 1.25 × the 7-day p95 cost per generation once there is enough data; the token-based guess before. */
function createEstimator(store: UsageStore | null, now: () => Date) {
  const cache = new Map<string, { micros: number; at: number }>()
  const pending = new Set<string>()
  return (providerId: string | undefined, action: UsageAction): number => {
    const cold = coldStartEstimateMicros(providerId, action)
    if (!providerId || !store) return cold
    const key = `${providerId} ${action}`
    const hit = cache.get(key)
    if ((!hit || now().getTime() - hit.at > ESTIMATE_REFRESH_MS) && !pending.has(key)) {
      pending.add(key)
      const since = new Date(now().getTime() - 7 * 86_400_000)
      void store
        .recentCosts(providerId, action, since, 200)
        .then((costs) => {
          const micros = costs.length >= ESTIMATE_MIN_SAMPLES ? Math.ceil(percentile(costs, 0.95) * 1.25) : 0
          cache.set(key, { micros, at: now().getTime() })
        })
        .catch(() => undefined)
        .finally(() => pending.delete(key))
    }
    return hit && hit.micros > 0 ? hit.micros : cold
  }
}

function nextSteps(reason: QuotaReason, principal: Principal): QuotaNextStep[] {
  if (reason === 'anon_daily' || (reason === 'anon_share' && principal.kind === 'anon')) return ['sign_in', 'wait']
  if (reason === 'unverified_daily' || reason === 'anon_share') return ['verify_email', 'wait']
  return ['wait']
}

export function createMeter(deps: MeterDeps): Meter {
  const now = deps.now ?? (() => new Date())
  const estimate = createEstimator(deps.store, now)

  function makeTicket(
    input: ReserveInput,
    fields: {
      source: UsageSource
      route: UsageRoute
      estMicros?: number
      pool?: UsagePool
      reservation?: Reservation
      wouldDeny?: QuotaReason
      emailVerified?: boolean
    }
  ): Ticket {
    const records: LlmUsageRecord[] = []
    let closed = false
    let settling = false
    const estMicros = fields.estMicros ?? 0
    const r = fields.reservation
    return {
      source: fields.source,
      route: fields.route,
      ...(fields.pool ? { pool: fields.pool } : {}),
      ...(fields.wouldDeny ? { wouldDeny: fields.wouldDeny } : {}),
      usage: {
        add(record) {
          if (!closed) records.push(record)
        },
      },
      allowance(charged) {
        if (!r || !fields.pool) return null
        return {
          used: charged ? r.allowanceUsed : Math.max(0, r.allowanceUsed - 1),
          limit: r.allowanceLimit,
          pool: fields.pool,
          resetAt: r.resetAt.toISOString(),
        }
      },
      async settle(outcome) {
        if (settling) return
        settling = true
        // A call aborted at the very end (e.g. extras after a typo answer)
        // reports from a rejection handler; let those run first.
        await new Promise<void>((resolve) => setImmediate(resolve))
        closed = true
        const cost = costOf(records)
        const store = deps.store
        if (store && fields.source === 'free' && r) {
          const delta = cost.costMicros - estMicros
          const n = outcome.charged ? 0 : -1
          try {
            await Promise.all([
              ...(outcome.charged ? [] : [store.add(r.allowanceKey, { n: -1 }, r.dayExpiresAt)]),
              ...r.dayCostKeys.map((key) => store.add(key, { costMicros: delta, n }, r.dayExpiresAt)),
              store.add(r.monthKey, { costMicros: delta, n }, r.monthExpiresAt),
            ])
          } catch (err) {
            console.warn('[usage] failed to settle usage counters (non-fatal):', err)
          }
        }
        if (!store) return
        const p = input.principal
        try {
          await store.insertLedger({
            ts: now(),
            principal: {
              kind: p.kind,
              ...(p.kind !== 'anon' ? { sub: p.sub } : {}),
              ip: p.ip,
              ...(fields.emailVerified !== undefined ? { emailVerified: fields.emailVerified } : {}),
            },
            action: input.action,
            source: fields.source,
            ...(fields.pool ? { pool: fields.pool } : {}),
            route: fields.route,
            ...(outcome.providerId ? { routeProviderId: outcome.providerId } : {}),
            charged: outcome.charged,
            word: input.word,
            sourceLang: input.sourceLang,
            targetLang: input.targetLang,
            estMicros,
            costMicros: cost.costMicros,
            estimated: cost.estimated,
            unpriced: cost.unpriced,
            calls: cost.calls,
            channel: input.channel,
            ...(fields.wouldDeny ? { wouldDeny: fields.wouldDeny } : {}),
          })
        } catch (err) {
          console.warn('[usage] failed to write the usage ledger (non-fatal):', err)
        }
      },
    }
  }

  async function loadAccount(sub: string): Promise<AccountDoc> {
    if (!deps.store) throw new Error('no usage store')
    return deps.store.ensureAccount(sub, now())
  }

  /** The free-allowance decision. Returns a reservation, or the reason it was refused. */
  async function decide(
    input: ReserveInput,
    settings: UsageSettings,
    account: AccountDoc | null,
    verified: boolean,
    estMicros: number
  ): Promise<{ ok: true; pool: UsagePool; reservation: Reservation } | { ok: false; error: QuotaDeniedError }> {
    const store = deps.store as UsageStore
    const t = now()
    const day = utcDay(t)
    const month = utcMonth(t)
    const dayExpiresAt = dayKeyExpiry(t)
    const monthExpiresAt = monthKeyExpiry(t)
    const resetAt = nextUtcDay(t)
    const p = input.principal

    const pool: UsagePool = account && verified ? 'account' : 'ip'
    const allowanceLimit =
      pool === 'account' ? (account?.dailyAllowance ?? settings.userDailyFree) : settings.anonDailyPerIp
    const allowanceKey =
      pool === 'account' ? counterKeys.user(day, (account as AccountDoc)._id) : counterKeys.ip(day, p.ipKey)
    const deny = (reason: QuotaReason, used: number, at: Date = resetAt) => ({
      ok: false as const,
      error: new QuotaDeniedError(reason, allowanceLimit, used, at, nextSteps(reason, p)),
    })

    if (!settings.freeTierEnabled) {
      const current = (await store.getCounters([allowanceKey])).get(allowanceKey)?.n ?? 0
      return deny('free_tier_paused', current)
    }

    const freeKey = counterKeys.free(day)
    const monthKey = counterKeys.monthFree(month)
    const spend = await store.getCounters([freeKey, monthKey])
    const daySpent = spend.get(freeKey)?.costMicros ?? 0
    const monthSpent = spend.get(monthKey)?.costMicros ?? 0
    const budget = todayBudgetMicros(settings, daySpent, monthSpent, t)
    const monthCap = Math.round(settings.freeTierMonthlyUsd * 1e6)
    const budgetDenial = (used: number) => {
      const monthExhausted = monthCap - (monthSpent - daySpent) <= estMicros
      deps.alerts?.budgetReached(day, monthExhausted)
      return deny('free_tier_budget', used, monthExhausted ? nextUtcMonth(t) : resetAt)
    }

    const used = await store.tryIncrement(allowanceKey, 1, allowanceLimit, dayExpiresAt)
    if (used === null) {
      return deny(pool === 'account' ? 'user_daily' : account ? 'unverified_daily' : 'anon_daily', allowanceLimit)
    }
    const undoAllowance = () => store.add(allowanceKey, { n: -1 }, dayExpiresAt)

    const dayCostKeys: string[] = []
    if (pool === 'ip') {
      const shareKey = counterKeys.freeAnon(day)
      const share = await store.tryReserveCost(shareKey, estMicros, Math.floor(budget * settings.anonShare), dayExpiresAt)
      if (share === null) {
        await undoAllowance()
        return deny('anon_share', used - 1)
      }
      dayCostKeys.push(shareKey)
    }
    const dayCost = await store.tryReserveCost(freeKey, estMicros, budget, dayExpiresAt)
    if (dayCost === null) {
      await Promise.all([
        undoAllowance(),
        ...dayCostKeys.map((key) => store.add(key, { costMicros: -estMicros, n: -1 }, dayExpiresAt)),
      ])
      return budgetDenial(used - 1)
    }
    dayCostKeys.push(freeKey)
    await store.add(monthKey, { costMicros: estMicros, n: 1 }, monthExpiresAt)
    deps.alerts?.monthSpend(month, monthSpent + estMicros, monthCap)

    return {
      ok: true,
      pool,
      reservation: { allowanceKey, allowanceUsed: used, allowanceLimit, dayCostKeys, monthKey, dayExpiresAt, monthExpiresAt, resetAt },
    }
  }

  return {
    async reserve(input) {
      const settings = deps.settings()
      const p = input.principal
      if (p.kind === 'owner') return makeTicket(input, { source: 'owner', route: 'full' })

      let account: AccountDoc | null = null
      if (p.kind === 'user' && deps.store) {
        try {
          account = await loadAccount(p.sub)
        } catch (err) {
          if (settings.enforcement === 'on') throw new GenerationUnavailableError(err)
          console.warn('[usage] failed to load an account (continuing unmetered):', err)
        }
      }
      if (account?.status === 'blocked') throw new AccountBlockedError()
      if (account?.plan === 'unlimited') return makeTicket(input, { source: 'exempt', route: 'full' })

      if (settings.enforcement === 'off') return makeTicket(input, { source: 'unmetered', route: 'metered' })
      if (!deps.store) {
        if (settings.enforcement === 'on') throw new GenerationUnavailableError()
        return makeTicket(input, { source: 'shadow', route: 'metered' })
      }

      const shadow = settings.enforcement === 'shadow'
      try {
        const verified = account ? await deps.verifier.isVerified(account) : false
        const estMicros = Math.max(1, estimate(deps.meteredProviderId(), input.action))
        const decision = await decide(input, settings, account, verified, estMicros)
        if (!decision.ok) {
          const t = now()
          void deps.store
            .add(counterKeys.denied(utcDay(t), decision.error.reason), { n: 1 }, denialKeyExpiry(t))
            .catch(() => undefined)
        }
        if (decision.ok) {
          return makeTicket(input, {
            source: 'free',
            route: 'metered',
            estMicros,
            pool: decision.pool,
            reservation: decision.reservation,
            ...(account ? { emailVerified: verified } : {}),
          })
        }
        if (shadow) {
          return makeTicket(input, {
            source: 'shadow',
            route: 'metered',
            wouldDeny: decision.error.reason,
            ...(account ? { emailVerified: verified } : {}),
          })
        }
        throw decision.error
      } catch (err) {
        if (err instanceof MeterError) throw err
        if (shadow) {
          console.warn('[usage] metering failed in shadow mode (generation allowed):', err)
          return makeTicket(input, { source: 'shadow', route: 'metered' })
        }
        throw new GenerationUnavailableError(err)
      }
    },
  }
}
