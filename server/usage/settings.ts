import { getMongoDb } from '../db'
import {
  IS_PROD,
  USAGE_ALERT_WEBHOOK_URL,
  USAGE_ANON_DAILY_PER_IP,
  USAGE_ANON_SHARE,
  USAGE_ENFORCEMENT,
  USAGE_FREE_TIER_DAILY_USD,
  USAGE_FREE_TIER_MONTHLY_USD,
  USAGE_FREE_TIER_PACING,
  USAGE_USER_DAILY_FREE,
} from '../config'
import type { EnforcementMode, PacingMode } from './types'

/**
 * Usage settings (docs/design-llm-usage-quotas.md §4.3, §9): env defaults
 * plus admin overrides stored in the `usage_settings` singleton. Reads on the
 * lookup path are synchronous from an in-memory copy that refreshes in the
 * background every 30 s, the same pattern as the IP blocklist.
 */

export interface UsageSettings {
  enforcement: EnforcementMode
  /** Kill switch: false makes generation cache-only for everyone but the owner and unlimited accounts. */
  freeTierEnabled: boolean
  pacing: PacingMode
  anonDailyPerIp: number
  anonShare: number
  userDailyFree: number
  freeTierDailyUsd: number
  freeTierMonthlyUsd: number
  alertWebhookUrl: string | null
}

export type UsageSettingKey = keyof UsageSettings

export const USAGE_SETTING_KEYS: readonly UsageSettingKey[] = [
  'enforcement',
  'freeTierEnabled',
  'pacing',
  'anonDailyPerIp',
  'anonShare',
  'userDailyFree',
  'freeTierDailyUsd',
  'freeTierMonthlyUsd',
  'alertWebhookUrl',
]

export function envUsageDefaults(): UsageSettings {
  return {
    enforcement: USAGE_ENFORCEMENT,
    freeTierEnabled: true,
    pacing: USAGE_FREE_TIER_PACING,
    anonDailyPerIp: USAGE_ANON_DAILY_PER_IP,
    anonShare: USAGE_ANON_SHARE,
    userDailyFree: USAGE_USER_DAILY_FREE,
    freeTierDailyUsd: USAGE_FREE_TIER_DAILY_USD,
    freeTierMonthlyUsd: USAGE_FREE_TIER_MONTHLY_USD,
    alertWebhookUrl: USAGE_ALERT_WEBHOOK_URL ?? null,
  }
}

interface UsageSettingsDoc {
  _id: 'usage'
  overrides: Partial<UsageSettings>
  updatedAt: Date
  updatedBy: string
}

export interface UsageSettingsView {
  effective: UsageSettings
  defaults: UsageSettings
  /** Keys whose value comes from Admin → Usage rather than the env. */
  overridden: UsageSettingKey[]
  updatedAt?: string
  updatedBy?: string
}

// --- validation (pure) ---

function isHttpUrl(value: string, isProd: boolean): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (!isProd || ['localhost', '127.0.0.1'].includes(url.hostname))
  } catch {
    return false
  }
}

/**
 * Validates an admin settings patch. A key set to `null` removes the override
 * (back to the env default); `alertWebhookUrl: ""` stores "no webhook".
 */
export function validateUsageSettingsPatch(
  input: unknown,
  isProd: boolean = IS_PROD
): { ok: true; set: Partial<UsageSettings>; unset: UsageSettingKey[] } | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['body must be an object'] }
  const body = input as Record<string, unknown>
  const errors: string[] = []
  const set: Partial<UsageSettings> = {}
  const unset: UsageSettingKey[] = []

  for (const key of Object.keys(body)) {
    if (!(USAGE_SETTING_KEYS as readonly string[]).includes(key)) errors.push(`unknown setting: ${key}`)
  }

  const num = (key: UsageSettingKey, min: number, max: number, integer: boolean): void => {
    const v = body[key]
    if (v === undefined) return
    if (v === null) return void unset.push(key)
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      errors.push(`${key} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`)
      return
    }
    ;(set as Record<string, unknown>)[key] = v
  }
  const oneOf = (key: UsageSettingKey, allowed: readonly string[]): void => {
    const v = body[key]
    if (v === undefined) return
    if (v === null) return void unset.push(key)
    if (typeof v !== 'string' || !allowed.includes(v)) {
      errors.push(`${key} must be one of: ${allowed.join(', ')}`)
      return
    }
    ;(set as Record<string, unknown>)[key] = v
  }

  oneOf('enforcement', ['off', 'shadow', 'on'])
  oneOf('pacing', ['even', 'off'])
  if (body.freeTierEnabled !== undefined) {
    if (body.freeTierEnabled === null) unset.push('freeTierEnabled')
    else if (typeof body.freeTierEnabled !== 'boolean') errors.push('freeTierEnabled must be a boolean')
    else set.freeTierEnabled = body.freeTierEnabled
  }
  num('anonDailyPerIp', 0, 100_000, true)
  num('anonShare', 0, 1, false)
  num('userDailyFree', 0, 100_000, true)
  num('freeTierDailyUsd', 0, 10_000, false)
  num('freeTierMonthlyUsd', 0, 100_000, false)
  if (body.alertWebhookUrl !== undefined) {
    const v = body.alertWebhookUrl
    if (v === null) unset.push('alertWebhookUrl')
    else if (typeof v !== 'string') errors.push('alertWebhookUrl must be a string or null')
    else if (v.trim() === '') set.alertWebhookUrl = null
    else if (v.length > 500 || !isHttpUrl(v.trim(), isProd)) errors.push('alertWebhookUrl must be an https:// URL')
    else set.alertWebhookUrl = v.trim()
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, set, unset }
}

export function mergeSettings(defaults: UsageSettings, overrides: Partial<UsageSettings>): UsageSettings {
  const out = { ...defaults }
  for (const key of USAGE_SETTING_KEYS) {
    if (overrides[key] !== undefined) (out as Record<string, unknown>)[key] = overrides[key]
  }
  return out
}

// --- cached access ---

const REFRESH_MS = 30_000
let overrides: Partial<UsageSettings> = {}
let meta: { updatedAt?: Date; updatedBy?: string } = {}
let loadedAt = 0
let refreshing: Promise<void> | null = null

function settingsCol() {
  return getMongoDb()?.collection<UsageSettingsDoc>('usage_settings') ?? null
}

/** Re-reads the overrides. Never throws; keeps the previous copy on failure. */
export async function refreshUsageSettings(): Promise<void> {
  const col = settingsCol()
  if (!col) {
    loadedAt = Date.now()
    return
  }
  try {
    const doc = await col.findOne({ _id: 'usage' })
    overrides = doc?.overrides ?? {}
    meta = doc ? { updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } : {}
  } catch (err) {
    console.warn('[usage] failed to read usage_settings — keeping the previous copy:', err)
  } finally {
    loadedAt = Date.now()
  }
}

/** Effective settings, synchronously. Starts a background refresh when the copy is stale. */
export function getUsageSettings(): UsageSettings {
  if (Date.now() - loadedAt > REFRESH_MS && !refreshing) {
    refreshing = refreshUsageSettings().finally(() => {
      refreshing = null
    })
  }
  return mergeSettings(envUsageDefaults(), overrides)
}

export function usageSettingsView(): UsageSettingsView {
  const defaults = envUsageDefaults()
  return {
    effective: mergeSettings(defaults, overrides),
    defaults,
    overridden: USAGE_SETTING_KEYS.filter((k) => overrides[k] !== undefined),
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt.toISOString() } : {}),
    ...(meta.updatedBy ? { updatedBy: meta.updatedBy } : {}),
  }
}

export class UsageSettingsUnavailableError extends Error {
  constructor() {
    super('MongoDB is not connected — usage settings are read-only (env defaults)')
    this.name = 'UsageSettingsUnavailableError'
  }
}

/** Applies a validated patch and refreshes the in-memory copy at once. */
export async function saveUsageSettings(
  patch: { set: Partial<UsageSettings>; unset: UsageSettingKey[] },
  actor: string
): Promise<UsageSettingsView> {
  const col = settingsCol()
  if (!col) throw new UsageSettingsUnavailableError()
  const $set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: actor }
  for (const [k, v] of Object.entries(patch.set)) $set[`overrides.${k}`] = v
  const $unset: Record<string, ''> = {}
  for (const k of patch.unset) $unset[`overrides.${k}`] = ''
  await col.updateOne(
    { _id: 'usage' },
    { $set, ...(Object.keys($unset).length > 0 ? { $unset } : {}) },
    { upsert: true }
  )
  await refreshUsageSettings()
  return usageSettingsView()
}

/** Test hook: replace the overrides without Mongo. */
export function setUsageOverridesForTests(next: Partial<UsageSettings>): void {
  overrides = next
  meta = {}
  loadedAt = Date.now()
}
