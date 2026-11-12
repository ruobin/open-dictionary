import { afterEach, describe, expect, it, vi } from 'vitest'
import { envUsageDefaults, mergeSettings, validateUsageSettingsPatch } from './settings'

const USAGE_ENV = [
  'USAGE_ENFORCEMENT',
  'USAGE_FREE_TIER_DAILY_USD',
  'USAGE_FREE_TIER_MONTHLY_USD',
  'USAGE_FREE_TIER_PACING',
  'USAGE_ANON_DAILY_PER_IP',
  'USAGE_ANON_SHARE',
  'USAGE_USER_DAILY_FREE',
  'USAGE_ALERT_WEBHOOK_URL',
]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('usage settings', () => {
  it('defaults to the decided budget and allowances when the env sets nothing', async () => {
    // Blank values win over server/.env (dotenv never overrides a defined key).
    for (const name of USAGE_ENV) vi.stubEnv(name, '')
    vi.resetModules()
    const fresh = await import('./settings')
    expect(fresh.envUsageDefaults()).toMatchObject({
      enforcement: 'shadow',
      freeTierEnabled: true,
      pacing: 'even',
      anonDailyPerIp: 5,
      anonShare: 0.5,
      userDailyFree: 20,
      freeTierDailyUsd: 1,
      freeTierMonthlyUsd: 5,
      alertWebhookUrl: null,
    })
  })

  it('accepts a valid patch and separates resets (null) from values', () => {
    const r = validateUsageSettingsPatch({ enforcement: 'on', anonShare: 0.25, userDailyFree: null, alertWebhookUrl: '' })
    expect(r).toEqual({ ok: true, set: { enforcement: 'on', anonShare: 0.25, alertWebhookUrl: null }, unset: ['userDailyFree'] })
  })

  it('rejects unknown keys and out-of-range values', () => {
    const r = validateUsageSettingsPatch({
      enforcement: 'strict',
      anonDailyPerIp: 2.5,
      anonShare: 1.5,
      freeTierMonthlyUsd: -1,
      freeTierEnabled: 'yes',
      bogus: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toHaveLength(6)
  })

  it('accepts only http(s) webhook URLs, https in production', () => {
    expect(validateUsageSettingsPatch({ alertWebhookUrl: 'https://ntfy.sh/topic' }, true).ok).toBe(true)
    expect(validateUsageSettingsPatch({ alertWebhookUrl: 'http://example.com/hook' }, true).ok).toBe(false)
    expect(validateUsageSettingsPatch({ alertWebhookUrl: 'http://localhost:9000/hook' }, false).ok).toBe(true)
    expect(validateUsageSettingsPatch({ alertWebhookUrl: 'javascript:alert(1)' }, false).ok).toBe(false)
  })

  it('lets overrides win over env defaults, including an explicit null', () => {
    const defaults = { ...envUsageDefaults(), freeTierDailyUsd: 1, alertWebhookUrl: 'https://example.com/hook' }
    const merged = mergeSettings(defaults, { freeTierMonthlyUsd: 8, alertWebhookUrl: null })
    expect(merged.freeTierMonthlyUsd).toBe(8)
    expect(merged.freeTierDailyUsd).toBe(1)
    expect(merged.alertWebhookUrl).toBeNull()
  })
})
