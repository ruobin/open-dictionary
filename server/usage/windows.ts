/**
 * Calendar UTC windows and counter keys (docs/design-llm-usage-quotas.md §4.2,
 * §5.6). Keys use `:` and `/` as separators, never `|`, because Auth0 subs
 * contain `|`.
 */

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` (UTC). */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** `YYYY-MM` (UTC). */
export function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function nextUtcDay(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + DAY_MS)
}

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

export function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
}

/** Days left in the month, today included (1 on the last day). */
export function daysLeftInUtcMonth(now: Date): number {
  return daysInUtcMonth(now) - now.getUTCDate() + 1
}

/** Day counters live 2 days past the end of their day. */
export function dayKeyExpiry(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + 3 * DAY_MS)
}

/** Month counters live 40 days past the start of their month. */
export function monthKeyExpiry(now: Date): Date {
  return new Date(startOfUtcMonth(now).getTime() + 40 * DAY_MS)
}

/** Denial counters are kept 35 days for the admin Usage page (no IP or account in the key). */
export function denialKeyExpiry(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + 35 * DAY_MS)
}

export const counterKeys = {
  /** IP allowance: anonymous and unverified users on one IP (IPv6 by /64). */
  ip: (day: string, ipKey: string) => `d:${day}/ip:${ipKey}`,
  /** A verified account's allowance. */
  user: (day: string, sub: string) => `d:${day}/u:${sub}`,
  /** Every free generation today (`costMicros` is the budget). */
  free: (day: string) => `d:${day}/free`,
  /** Free generations from the IP allowance today (the anonymous share). */
  freeAnon: (day: string) => `d:${day}/free-anon`,
  /** Every free generation this month. */
  monthFree: (month: string) => `m:${month}/free`,
  /** Refusals (or, in shadow mode, would-be refusals) per reason per day. */
  denied: (day: string, reason: string) => `d:${day}/denied:${reason}`,
}
