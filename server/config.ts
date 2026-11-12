import 'dotenv/config'
import { config as loadEnvFile } from 'dotenv'

// Load server-only secrets from server/.env. Additive only —
// never overrides values already in the environment or the root .env.
loadEnvFile({ path: 'server/.env' })

/** Reads a required env var; exits with a clear message when missing. */
export function required(name: string): string {
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

export const AUTH0_DOMAIN = required('AUTH0_DOMAIN')
export const AUTH0_AUDIENCE = required('AUTH0_AUDIENCE')
export const AUTH0_MGMT_CLIENT_ID = required('AUTH0_MGMT_CLIENT_ID')
export const AUTH0_MGMT_CLIENT_SECRET = required('AUTH0_MGMT_CLIENT_SECRET')
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
export const TRUST_PROXY = process.env.TRUST_PROXY ?? '0'
export const NODE_ENV = process.env.NODE_ENV ?? 'development'
export const PORT = Number(process.env.PORT ?? 3001)
export const IS_PROD = NODE_ENV === 'production'
export const MONGODB_URI = process.env.MONGODB_URI?.trim()
export const MONGODB_DB = process.env.MONGODB_DB?.trim() || undefined
export const FREE_DICTIONARY_API_BASE = process.env.FREE_DICTIONARY_API_BASE?.trim() || undefined
export const DICTIONARY_API_BASE = process.env.DICTIONARY_API_BASE?.trim() || undefined
export const MERRIAM_WEBSTER_API_KEY = process.env.MERRIAM_WEBSTER_API_KEY?.trim() || undefined
// Absolute origin the site is deployed at (no trailing slash). Used only by
// scripts/prerender.ts to build canonical URLs, JSON-LD `url` fields, and the
// sitemap — not read by the Express server itself.
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:5173').replace(/\/$/, '')
// Hard ceiling on the per-IP request rate for endpoints that trigger paid
// LLM calls (/translate, /more-examples). Caps worst-case token spend from a
// single client regardless of env-var misconfiguration — the configured RPM
// is clamped to this value via Math.min() below.
export const LLM_RATE_LIMIT_MAX_RPM = 5
export const TRANSLATE_RATE_LIMIT_RPM = Math.min(parseInt(process.env.TRANSLATE_RATE_LIMIT_RPM ?? '5', 10) || 5, LLM_RATE_LIMIT_MAX_RPM)
export const FAVORITES_RATE_LIMIT_RPM = parseInt(process.env.FAVORITES_RATE_LIMIT_RPM ?? '120', 10) || 120
export const USERDATA_RATE_LIMIT_RPM = parseInt(process.env.USERDATA_RATE_LIMIT_RPM ?? '60', 10) || 60
export const SUGGEST_RATE_LIMIT_RPM = parseInt(process.env.SUGGEST_RATE_LIMIT_RPM ?? '60', 10) || 60
export const BROWSE_RATE_LIMIT_RPM = parseInt(process.env.BROWSE_RATE_LIMIT_RPM ?? '60', 10) || 60
export const REPORT_RATE_LIMIT_RPM = parseInt(process.env.REPORT_RATE_LIMIT_RPM ?? '10', 10) || 10
// Client-cache activity beacons (POST /api/activity-ping) — cheap Mongo write only,
// no LLM. Higher than translate so a session of repeated lookups isn't throttled away.
export const ACTIVITY_PING_RATE_LIMIT_RPM = parseInt(process.env.ACTIVITY_PING_RATE_LIMIT_RPM ?? '60', 10) || 60
export const WORD_OF_DAY_RATE_LIMIT_RPM = parseInt(process.env.WORD_OF_DAY_RATE_LIMIT_RPM ?? '30', 10) || 30
export const MORE_EXAMPLES_RATE_LIMIT_RPM = Math.min(parseInt(process.env.MORE_EXAMPLES_RATE_LIMIT_RPM ?? '5', 10) || 5, LLM_RATE_LIMIT_MAX_RPM)

// --- LLM abuse guard (server/abuseGuard.ts) ---
// The per-minute limits above don't bound daily spend: a crawler pacing itself
// under 5 rpm still triggers ~7k paid LLM calls/day. Rolling 24h cap on paid
// (cache-miss) LLM calls per IP; over it, cache hits are still served and
// misses get 429. 0 disables the cap.
const parsedLlmBudget = parseInt(process.env.LLM_DAILY_BUDGET_PER_IP ?? '300', 10)
export const LLM_DAILY_BUDGET_PER_IP = Number.isFinite(parsedLlmBudget) && parsedLlmBudget >= 0 ? parsedLlmBudget : 300
// Refuse self-identified crawlers/scripts (GPTBot, curl, python-requests, …)
// on LLM-backed routes. Set to 0/false to allow them.
export const LLM_BLOCK_BOTS = !/^(0|false|no|off)$/i.test(process.env.LLM_BLOCK_BOTS ?? '1')

// --- LLM usage tiers & quotas (docs/design-llm-usage-quotas.md §9) ---
// Env sets the defaults; values saved in Admin → Usage override them.
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}
function envNumber(name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    console.warn(`[config] ignoring invalid ${name}=${raw} (using ${fallback})`)
    return fallback
  }
  return n
}
/** `off`, `shadow` (count and record would-be denials, block nothing) or `on`. */
export const USAGE_ENFORCEMENT = envEnum('USAGE_ENFORCEMENT', ['off', 'shadow', 'on'] as const, 'shadow')
/** Free budget per UTC day / month, in USD, for all free generations combined. */
export const USAGE_FREE_TIER_DAILY_USD = envNumber('USAGE_FREE_TIER_DAILY_USD', 1, { max: 10_000 })
export const USAGE_FREE_TIER_MONTHLY_USD = envNumber('USAGE_FREE_TIER_MONTHLY_USD', 5, { max: 100_000 })
/** `even` spreads the monthly budget over the days left; `off` is first come, first served. */
export const USAGE_FREE_TIER_PACING = envEnum('USAGE_FREE_TIER_PACING', ['even', 'off'] as const, 'even')
/** Free new words per IP (IPv6 /64) per UTC day, for anonymous and unverified users. 0 = sign in to generate. */
export const USAGE_ANON_DAILY_PER_IP = envNumber('USAGE_ANON_DAILY_PER_IP', 5, { max: 100_000, integer: true })
/** Share of today's free budget that the IP allowance may use (0–1). */
export const USAGE_ANON_SHARE = envNumber('USAGE_ANON_SHARE', 0.5, { max: 1 })
/** Free new words per UTC day for an account with a verified email. */
export const USAGE_USER_DAILY_FREE = envNumber('USAGE_USER_DAILY_FREE', 20, { max: 100_000, integer: true })
/** Price (USD per million tokens) for models with no price set in the admin portal. Deliberately
 *  on the high side for budget models, so a forgotten price makes the budget stricter, not looser. */
export const LLM_DEFAULT_PRICE_IN_PER_MTOK = envNumber('LLM_DEFAULT_PRICE_IN_PER_MTOK', 1, { max: 10_000 })
export const LLM_DEFAULT_PRICE_OUT_PER_MTOK = envNumber('LLM_DEFAULT_PRICE_OUT_PER_MTOK', 4, { max: 10_000 })
/** Optional URL that budget alerts are POSTed to as JSON. */
export const USAGE_ALERT_WEBHOOK_URL = process.env.USAGE_ALERT_WEBHOOK_URL?.trim() || undefined

// --- Admin portal (docs/design-admin-portal.md) ---
// AES-256-GCM master key (base64, 32 bytes) for encrypting LLM provider API
// keys at rest. Admin writes that touch a key return 503 when unset; nothing
// else is affected. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
export const CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY?.trim() || undefined
// Decrypt-only fallback, honored during key rotation (§5.1 of the design doc).
export const CONFIG_ENCRYPTION_KEY_PREVIOUS = process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS?.trim() || undefined
// Comma-separated Auth0 `sub` values granted admin access (allowlist-only —
// no Auth0 RBAC dependency). e.g. "auth0|64f1a2b3c4d5e6f7a8b9c0d1"
export const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)
export const ADMIN_RATE_LIMIT_RPM = parseInt(process.env.ADMIN_RATE_LIMIT_RPM ?? '30', 10) || 30
// Scheduled latency probes (design doc §9.6): 0 = off (default — opt in per
// docs/design-admin-portal.md §17 Q2). One canonical call per enabled
// provider every N minutes.
export const LLM_PROBE_INTERVAL_MIN = parseInt(process.env.LLM_PROBE_INTERVAL_MIN ?? '0', 10) || 0
