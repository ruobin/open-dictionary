import type { ManagementClient } from 'auth0'
import type { UsageStore } from './store'
import type { AccountDoc } from './types'

/**
 * Email verification for the signed-in free allowance
 * (docs/design-llm-usage-quotas.md §5.2). Access tokens don't carry
 * `email_verified`, and the web app renews tokens through iframe silent auth,
 * so a token claim would go stale. The server asks Auth0 instead, through the
 * Management API client the app already holds, and caches the answer on the
 * account.
 */

/** The slice of the Auth0 Management API this module needs. */
export interface Auth0Directory {
  getEmailVerified(sub: string): Promise<boolean>
  sendVerificationEmail(sub: string): Promise<void>
  /** Admin views only: the account's email address, never stored by us. */
  getEmail(sub: string): Promise<string | null>
  /** Admin views only: accounts whose email matches `email` exactly. */
  findByEmail(email: string): Promise<Array<{ sub: string; email: string }>>
}

export function createAuth0Directory(mgmt: ManagementClient): Auth0Directory {
  return {
    async getEmailVerified(sub) {
      const res = await mgmt.users.get({ id: sub })
      return res.data?.email_verified === true
    },
    async sendVerificationEmail(sub) {
      await mgmt.jobs.verifyEmail({ user_id: sub })
    },
    async getEmail(sub) {
      const res = await mgmt.users.get({ id: sub })
      return typeof res.data?.email === 'string' ? res.data.email : null
    },
    async findByEmail(email) {
      const res = await mgmt.usersByEmail.getByEmail({ email })
      return (res.data ?? [])
        .filter((u) => typeof u.user_id === 'string' && typeof u.email === 'string')
        .map((u) => ({ sub: u.user_id as string, email: u.email as string }))
    },
  }
}

const MINUTE = 60_000
const VERIFIED_TTL_MS = 7 * 24 * 60 * MINUTE
const UNVERIFIED_TTL_MS = 10 * MINUTE
const FORCED_RECHECK_MIN_MS = MINUTE
const RESEND_MIN_GAP_MS = 10 * MINUTE
const RESEND_MAX_PER_DAY = 5

export type ResendResult = 'sent' | 'already_verified' | 'rate_limited' | 'unavailable'

export interface Verifier {
  /** Cached `email_verified`, re-checked with Auth0 when stale (or when forced, at most once a minute). */
  isVerified(account: AccountDoc, opts?: { force?: boolean }): Promise<boolean>
  resend(account: AccountDoc): Promise<ResendResult>
}

export interface VerifierOptions {
  directory: Auth0Directory | null
  store: UsageStore | null
  now?: () => number
  timeoutMs?: number
  /** Process-wide cap on Management API calls, to stay well under Auth0's rate limits. */
  callsPerSecond?: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export function createVerifier(opts: VerifierOptions): Verifier {
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? 1_500
  const callsPerSecond = opts.callsPerSecond ?? 5
  const inFlight = new Map<string, Promise<boolean | null>>()
  let windowStart = 0
  let callsInWindow = 0

  function takeToken(): boolean {
    const t = now()
    if (t - windowStart >= 1_000) {
      windowStart = t
      callsInWindow = 0
    }
    if (callsInWindow >= callsPerSecond) return false
    callsInWindow += 1
    return true
  }

  /** Asks Auth0 and caches the answer. Null when Auth0 couldn't be asked; nothing is stored then. */
  function check(sub: string): Promise<boolean | null> {
    const existing = inFlight.get(sub)
    if (existing) return existing
    const run = (async (): Promise<boolean | null> => {
      if (!opts.directory || !takeToken()) return null
      try {
        const verified = await withTimeout(opts.directory.getEmailVerified(sub), timeoutMs)
        await opts.store
          ?.updateAccount(sub, { emailVerified: verified, emailVerifiedCheckedAt: new Date(now()) })
          .catch((err: unknown) => console.warn('[usage] failed to cache email verification (non-fatal):', err))
        return verified
      } catch (err) {
        console.warn(`[usage] email verification check failed for an account (treated as unverified): ${(err as Error)?.message ?? err}`)
        return null
      }
    })().finally(() => inFlight.delete(sub))
    inFlight.set(sub, run)
    return run
  }

  return {
    async isVerified(account, { force = false } = {}) {
      const age = now() - (account.emailVerifiedCheckedAt?.getTime() ?? 0)
      if (force) {
        if (account.emailVerifiedCheckedAt && age < FORCED_RECHECK_MIN_MS) return account.emailVerified === true
      } else {
        if (account.emailVerified === true && age < VERIFIED_TTL_MS) return true
        if (account.emailVerified === false && age < UNVERIFIED_TTL_MS) return false
      }
      // Fail toward the smaller (IP) allowance: an unanswered check is "not verified".
      return (await check(account._id)) === true
    },

    async resend(account) {
      if (!opts.directory || !opts.store) return 'unavailable'
      const t = now()
      const recent = (account.verificationEmailsSentAt ?? []).filter((d) => t - d.getTime() < 24 * 60 * MINUTE)
      const last = recent[recent.length - 1]
      if (recent.length >= RESEND_MAX_PER_DAY || (last && t - last.getTime() < RESEND_MIN_GAP_MS)) return 'rate_limited'
      if ((await check(account._id)) === true) return 'already_verified'
      try {
        await withTimeout(opts.directory.sendVerificationEmail(account._id), 5_000)
      } catch (err) {
        console.warn(`[usage] verification email could not be sent: ${(err as Error)?.message ?? err}`)
        return 'unavailable'
      }
      await opts.store
        .updateAccount(account._id, { verificationEmailsSentAt: [...recent, new Date(t)] })
        .catch((err: unknown) => console.warn('[usage] failed to record a verification resend (non-fatal):', err))
      return 'sent'
    },
  }
}
