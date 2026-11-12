import type { DictionaryEntry } from './dictionary'

/**
 * LLM usage tiers and quotas, client side (docs/design-llm-usage-quotas.md
 * §5.7). Only new words cost anything: lookups of words already in the
 * dictionary stay free and unlimited.
 */

export type QuotaReason =
  | 'anon_daily'
  | 'unverified_daily'
  | 'anon_share'
  | 'user_daily'
  | 'free_tier_budget'
  | 'free_tier_paused'

export type QuotaNextStep = 'sign_in' | 'verify_email' | 'wait'

/** Body of a `429 quota_exceeded` response. */
export interface QuotaInfo {
  reason: QuotaReason
  limit: number
  used: number
  resetAt: string
  actions: QuotaNextStep[]
}

export interface AllowanceView {
  used: number
  limit: number
  pool: 'account' | 'ip'
  resetAt: string
}

/** `GET /api/usage/me`. */
export interface UsageView {
  tier: 'owner' | 'exempt' | 'user' | 'anon'
  authState: 'valid' | 'anonymous' | 'invalid'
  enforcement: 'off' | 'shadow' | 'on'
  emailVerified: boolean | null
  blocked?: true
  today: AllowanceView | null
  freeTier: 'open' | 'budget_reached' | 'paused'
  /** What a verified account gets per day (anonymous and unverified callers only). */
  verifiedLimit?: number
  /** Owner only: the models of the full setup. */
  fullModels?: string[]
}

/** Returns an access token when signed in, or null. Never throws. */
export type TokenGetter = () => Promise<string | null>

const REASONS = new Set<string>(['anon_daily', 'unverified_daily', 'anon_share', 'user_daily', 'free_tier_budget', 'free_tier_paused'])

export function parseQuota(body: unknown): QuotaInfo | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.error !== 'quota_exceeded' || typeof b.reason !== 'string' || !REASONS.has(b.reason)) return null
  return {
    reason: b.reason as QuotaReason,
    limit: typeof b.limit === 'number' ? b.limit : 0,
    used: typeof b.used === 'number' ? b.used : 0,
    resetAt: typeof b.resetAt === 'string' ? b.resetAt : new Date(Date.now() + 86_400_000).toISOString(),
    actions: Array.isArray(b.actions) ? (b.actions.filter((a) => typeof a === 'string') as QuotaNextStep[]) : ['wait'],
  }
}

/** Waits at most `ms` for a token, so a slow silent sign-in can't stall a lookup. */
export async function tokenWithin(getToken: TokenGetter | undefined, ms = 3_000): Promise<string | null> {
  if (!getToken) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      getToken().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function authHeaders(getToken: TokenGetter | undefined): Promise<Record<string, string>> {
  const token = await tokenWithin(getToken)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// --- change notifications (a generation was charged, verification changed) ---

const listeners = new Set<() => void>()

export function onUsageChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyUsageChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // a broken listener must not affect the others
    }
  }
}

// --- API calls ---

export async function fetchUsage(getToken?: TokenGetter): Promise<UsageView | null> {
  try {
    const res = await fetch('/api/usage/me', { headers: await authHeaders(getToken), cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as UsageView
  } catch {
    return null
  }
}

export type ResendResult = 'sent' | 'already_verified' | 'rate_limited' | 'unavailable'

export async function resendVerificationEmail(getToken: TokenGetter): Promise<ResendResult> {
  try {
    const res = await fetch('/api/usage/verify-email/resend', { method: 'POST', headers: await authHeaders(getToken) })
    const body = (await res.json().catch(() => ({}))) as { result?: ResendResult }
    return body.result ?? (res.status === 429 ? 'rate_limited' : 'unavailable')
  } catch {
    return 'unavailable'
  }
}

/** Asks the server to re-check verification with Auth0 now. Null when it couldn't. */
export async function recheckEmailVerification(getToken: TokenGetter): Promise<boolean | null> {
  try {
    const res = await fetch('/api/usage/verify-email/refresh', { method: 'POST', headers: await authHeaders(getToken) })
    if (!res.ok) return null
    const body = (await res.json()) as { emailVerified?: boolean }
    return body.emailVerified === true
  } catch {
    return null
  }
}

/** Owner only: replaces a word's cached entry with a fresh one from the full setup. */
export async function regenerateEntry(
  getToken: TokenGetter,
  word: string,
  sourceLang: string,
  targetLang: string
): Promise<DictionaryEntry[] | null> {
  try {
    const res = await fetch('/api/admin/entries/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders(getToken)) },
      body: JSON.stringify({ word, sourceLang, targetLang }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { entries?: DictionaryEntry[] }
    return Array.isArray(body.entries) ? body.entries : null
  } catch {
    return null
  }
}
