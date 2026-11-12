import type { ActivityChannel } from '../activityLog'
import type { LlmCallKind } from '../providers/llm/types'

/**
 * Shared types for LLM usage tiers and quotas (docs/design-llm-usage-quotas.md).
 * Payments and credits are not implemented: a signed-in user's only free
 * source is the daily allowance, and the admin raises it (or marks an account
 * unlimited) for anyone who needs more.
 */

export type EnforcementMode = 'off' | 'shadow' | 'on'
export type PacingMode = 'even' | 'off'
export type AuthState = 'valid' | 'anonymous' | 'invalid'
export type UsageAction = 'lookup' | 'examples'
/** `full` = the owner's configured setup (fusion when on); `metered` = one model. */
export type UsageRoute = 'full' | 'metered'
/**
 * Who a generation is attributed to: the owner, an unlimited account
 * (`exempt`), the free budget (`free`), nobody because enforcement is off
 * (`unmetered`), or a shadow-mode generation that enforcement would have
 * refused (`shadow`).
 */
export type UsageSource = 'owner' | 'exempt' | 'free' | 'unmetered' | 'shadow'
/** Which allowance a free generation came from: a verified account's, or an IP's. */
export type UsagePool = 'account' | 'ip'
export type QuotaReason =
  | 'anon_daily'
  | 'unverified_daily'
  | 'anon_share'
  | 'user_daily'
  | 'free_tier_budget'
  | 'free_tier_paused'
export type QuotaNextStep = 'sign_in' | 'verify_email' | 'wait'

export type Principal =
  | { kind: 'owner'; sub: string; ip: string; ipKey: string }
  | { kind: 'user'; sub: string; ip: string; ipKey: string }
  | { kind: 'anon'; ip: string; ipKey: string }

/** `accounts` collection: one doc per signed-in user who has generated or checked usage. */
export interface AccountDoc {
  /** Auth0 `sub`. */
  _id: string
  plan: 'free' | 'unlimited'
  status: 'active' | 'blocked'
  /** Overrides `userDailyFree` for this account (verified accounts only). */
  dailyAllowance?: number
  /** Cached Auth0 `email_verified` (server/usage/verification.ts). */
  emailVerified?: boolean
  emailVerifiedCheckedAt?: Date
  /** Recent verification-email resends, oldest first, for the resend limits. */
  verificationEmailsSentAt?: Date[]
  /** Free-text admin note. */
  note?: string
  createdAt: Date
  updatedAt: Date
  lastSeenAt?: Date
}

/** `usage_counters` collection. `n` counts units; `costMicros` counts reserved + settled micro-USD. */
export interface CounterDoc {
  _id: string
  n: number
  costMicros: number
  expiresAt: Date
}

export interface LedgerCall {
  providerId: string
  kind: LlmCallKind
  in: number
  out: number
  costMicros: number
  estimated: boolean
  /** No price was set for this model; the default price was used. */
  unpriced?: boolean
}

/** `usage_ledger` collection: one doc per settled generation. */
export interface LedgerDoc {
  ts: Date
  principal: { kind: Principal['kind']; sub?: string; ip?: string; emailVerified?: boolean }
  action: UsageAction
  source: UsageSource
  pool?: UsagePool
  route: UsageRoute
  /** The provider that served the route (a fusion id on the owner's route). */
  routeProviderId?: string
  /** The user was charged a unit (the LLM answered). */
  charged: boolean
  word: string
  sourceLang: string
  targetLang: string
  /** What `reserve()` held against the budget before the real cost was known. */
  estMicros: number
  costMicros: number
  /** Some call's usage was estimated from text size. */
  estimated: boolean
  /** Some call used the default price because its model has none. */
  unpriced: boolean
  calls: LedgerCall[]
  channel: ActivityChannel
  /** Shadow mode: the reason enforcement would have refused this generation. */
  wouldDeny?: QuotaReason
}
