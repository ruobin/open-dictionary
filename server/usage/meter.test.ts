import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccountBlockedError,
  createMeter,
  GenerationUnavailableError,
  QuotaDeniedError,
  todayBudgetMicros,
  type BudgetAlertSink,
} from './meter'
import { setPricesForTests } from './pricing'
import { envUsageDefaults, type UsageSettings } from './settings'
import { createMemoryUsageStore, type UsageStore } from './store'
import type { Verifier } from './verification'
import type { Principal, UsageAction } from './types'
import { counterKeys } from './windows'

// 2026-11-12 is day 12 of a 30-day month: 19 days left, today included.
const NOW = new Date('2026-11-12T10:00:00Z')
const DAY = '2026-11-12'
const MONTH = '2026-11'
const MODEL = 'llm:test:cheap'
// Cold-start estimate on a $0.30 / $1.20 model: 1,500 × 0.3 + 1,500 × 1.2 micro-USD.
const EST = 2_250

afterEach(() => setPricesForTests(new Map()))

function settingsWith(overrides: Partial<UsageSettings> = {}): UsageSettings {
  return {
    ...envUsageDefaults(),
    enforcement: 'on',
    freeTierEnabled: true,
    pacing: 'even',
    anonDailyPerIp: 5,
    anonShare: 0.5,
    userDailyFree: 20,
    freeTierDailyUsd: 1,
    freeTierMonthlyUsd: 5,
    alertWebhookUrl: null,
    ...overrides,
  }
}

function setup(
  overrides: Partial<UsageSettings> = {},
  opts: { verified?: boolean; store?: UsageStore | null } = {}
) {
  setPricesForTests(new Map([[MODEL, { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 }]]))
  const store = createMemoryUsageStore()
  const settings = settingsWith(overrides)
  const verifier: Verifier = { isVerified: async () => opts.verified ?? true, resend: async () => 'sent' }
  const alerts: BudgetAlertSink = { monthSpend: vi.fn(), budgetReached: vi.fn() }
  const meter = createMeter({
    store: opts.store === undefined ? store : opts.store,
    settings: () => settings,
    verifier,
    meteredProviderId: () => MODEL,
    alerts,
    now: () => NOW,
  })
  return { store, meter, settings, alerts }
}

const anon = (ip = '203.0.113.7'): Principal => ({ kind: 'anon', ip, ipKey: ip })
const user = (sub = 'google-oauth2|1', ip = '203.0.113.7'): Principal => ({ kind: 'user', sub, ip, ipKey: ip })
const owner: Principal = { kind: 'owner', sub: 'auth0|owner', ip: '198.51.100.1', ipKey: '198.51.100.1' }
const input = (principal: Principal, action: UsageAction = 'lookup') => ({
  principal,
  action,
  channel: 'web' as const,
  word: 'serendipity',
  sourceLang: 'en',
  targetLang: 'en',
})

async function denial(p: Promise<unknown>): Promise<QuotaDeniedError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(QuotaDeniedError)
  return err as QuotaDeniedError
}

describe('todayBudgetMicros (pacing, design §4.3)', () => {
  const s = settingsWith()
  const at = (d: string) => new Date(`${d}T12:00:00Z`)
  it.each([
    ['day 1', '2026-11-01', 0, 0, 166_666],
    ['day 15, $2.00 spent before today', '2026-11-15', 0, 2_000_000, 187_500],
    ['day 21, nothing spent yet', '2026-11-21', 0, 0, 500_000],
    ['day 26, nothing spent: the daily cap binds', '2026-11-26', 0, 0, 1_000_000],
    ['day 30, $4.70 spent before today', '2026-11-30', 0, 4_700_000, 300_000],
    ["today's own spend doesn't shrink today's budget", '2026-11-15', 500_000, 2_500_000, 187_500],
  ])('%s', (_label, date, daySpent, monthSpent, expected) => {
    expect(todayBudgetMicros(s, daySpent, monthSpent, at(date))).toBe(expected)
  })

  it('pacing off is first come, first served', () => {
    expect(todayBudgetMicros({ ...s, pacing: 'off' }, 0, 0, at('2026-11-01'))).toBe(1_000_000)
    expect(todayBudgetMicros({ ...s, pacing: 'off' }, 0, 4_600_000, at('2026-11-05'))).toBe(400_000)
  })

  it('is zero with the kill switch on, or once the month is spent', () => {
    expect(todayBudgetMicros({ ...s, freeTierEnabled: false }, 0, 0, at('2026-11-01'))).toBe(0)
    expect(todayBudgetMicros(s, 0, 6_000_000, at('2026-11-20'))).toBe(0)
  })
})

describe('meter.reserve', () => {
  it('lets the owner through on the full route without counting anything', async () => {
    const { meter, store } = setup()
    const t = await meter.reserve(input(owner))
    expect(t).toMatchObject({ source: 'owner', route: 'full' })
    expect(t.allowance(true)).toBeNull()
    expect(store.counters.size).toBe(0)
  })

  it('treats an unlimited account like the owner, and refuses a blocked one', async () => {
    const { meter, store } = setup()
    await store.ensureAccount('google-oauth2|vip', NOW)
    await store.updateAccount('google-oauth2|vip', { plan: 'unlimited' })
    expect(await meter.reserve(input(user('google-oauth2|vip')))).toMatchObject({ source: 'exempt', route: 'full' })

    await store.ensureAccount('google-oauth2|bad', NOW)
    await store.updateAccount('google-oauth2|bad', { status: 'blocked' })
    await expect(meter.reserve(input(user('google-oauth2|bad')))).rejects.toBeInstanceOf(AccountBlockedError)
  })

  it('counts nothing with enforcement off, but still routes strangers to the metered model', async () => {
    const { meter, store } = setup({ enforcement: 'off' })
    for (let i = 0; i < 10; i += 1) expect(await meter.reserve(input(anon()))).toMatchObject({ source: 'unmetered', route: 'metered' })
    expect(store.counters.size).toBe(0)
  })

  it('gives anonymous visitors 5 a day per IP, then refuses with sign_in', async () => {
    const { meter } = setup()
    for (let i = 1; i <= 5; i += 1) {
      const t = await meter.reserve(input(anon()))
      expect(t).toMatchObject({ source: 'free', route: 'metered', pool: 'ip' })
      expect(t.allowance(true)).toMatchObject({ used: i, limit: 5, pool: 'ip' })
    }
    const err = await denial(meter.reserve(input(anon())))
    expect(err.toBody()).toEqual({
      error: 'quota_exceeded',
      reason: 'anon_daily',
      limit: 5,
      used: 5,
      resetAt: '2026-11-13T00:00:00.000Z',
      actions: ['sign_in', 'wait'],
    })
    // Another IP has its own allowance.
    expect(await meter.reserve(input(anon('198.51.100.9')))).toMatchObject({ source: 'free' })
  })

  it('makes an unverified account share its IP allowance, and asks it to verify', async () => {
    const { meter } = setup({}, { verified: false })
    for (let i = 0; i < 3; i += 1) await meter.reserve(input(anon()))
    await meter.reserve(input(user()))
    await meter.reserve(input(user('google-oauth2|2')))
    const err = await denial(meter.reserve(input(user())))
    expect(err.reason).toBe('unverified_daily')
    expect(err.actions).toEqual(['verify_email', 'wait'])
  })

  it('gives a verified account 20 a day of its own, or its admin override', async () => {
    const { meter, store } = setup()
    for (let i = 0; i < 20; i += 1) expect((await meter.reserve(input(user()))).pool).toBe('account')
    const err = await denial(meter.reserve(input(user())))
    expect(err).toMatchObject({ reason: 'user_daily', limit: 20, used: 20 })
    expect(err.actions).toEqual(['wait'])

    await store.ensureAccount('google-oauth2|friend', NOW)
    await store.updateAccount('google-oauth2|friend', { dailyAllowance: 2 })
    await meter.reserve(input(user('google-oauth2|friend')))
    await meter.reserve(input(user('google-oauth2|friend')))
    expect((await denial(meter.reserve(input(user('google-oauth2|friend'))))).limit).toBe(2)
  })

  it("caps the IP allowance's share of the budget so verified users keep theirs", async () => {
    // Today's budget = $0.361 ÷ 19 days left = 19,000 micro-USD; the anonymous share is half: 9,500 → 4 × EST.
    const { meter } = setup({ freeTierMonthlyUsd: 0.361 })
    for (let i = 0; i < 4; i += 1) await meter.reserve(input(anon(`10.0.0.${i}`)))
    const err = await denial(meter.reserve(input(anon('10.0.0.99'))))
    expect(err.reason).toBe('anon_share')
    expect(err.used).toBe(0) // the refused visitor's own allowance is untouched
    // Verified users can still use the rest of today's budget.
    expect(await meter.reserve(input(user()))).toMatchObject({ source: 'free', pool: 'account' })
  })

  it('refuses free generations once the budget is used, until midnight (or the 1st if the month is spent)', async () => {
    // 19,000 micro-USD today: 8 × EST fit, a 9th doesn't.
    const { meter, store, alerts } = setup({ freeTierMonthlyUsd: 0.361 })
    for (let i = 0; i < 8; i += 1) await meter.reserve(input(user(`google-oauth2|${i}`)))
    const err = await denial(meter.reserve(input(user('google-oauth2|late'))))
    expect(err.reason).toBe('free_tier_budget')
    expect(err.resetAt.toISOString()).toBe('2026-11-13T00:00:00.000Z')
    expect(alerts.budgetReached).toHaveBeenCalledWith(DAY, false)
    expect(store.counters.get(counterKeys.user(DAY, 'google-oauth2|late'))?.n).toBe(0)

    // Month already spent: retry on the 1st.
    const spent = setup({ freeTierMonthlyUsd: 0.01 })
    await spent.store.add(counterKeys.monthFree(MONTH), { costMicros: 10_000 }, NOW)
    const monthErr = await denial(spent.meter.reserve(input(user())))
    expect(monthErr.resetAt.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(spent.alerts.budgetReached).toHaveBeenCalledWith(DAY, true)
  })

  it('the kill switch pauses free generations for everyone but the owner', async () => {
    const { meter } = setup({ freeTierEnabled: false })
    expect((await denial(meter.reserve(input(anon())))).reason).toBe('free_tier_paused')
    expect((await denial(meter.reserve(input(user())))).reason).toBe('free_tier_paused')
    expect((await meter.reserve(input(owner))).source).toBe('owner')
  })

  it('shadow mode records a would-be refusal and lets the generation through', async () => {
    const { meter, store } = setup({ enforcement: 'shadow', anonDailyPerIp: 1 })
    expect((await meter.reserve(input(anon()))).source).toBe('free')
    const t = await meter.reserve(input(anon()))
    expect(t).toMatchObject({ source: 'shadow', route: 'metered', wouldDeny: 'anon_daily' })
    expect(store.counters.get(counterKeys.ip(DAY, '203.0.113.7'))?.n).toBe(1)
    expect(store.counters.get(counterKeys.denied(DAY, 'anon_daily'))?.n).toBe(1)
  })

  it('never overshoots a limit under concurrency', async () => {
    const { meter, store } = setup()
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => meter.reserve(input(anon()))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5)
    expect(store.counters.get(counterKeys.ip(DAY, '203.0.113.7'))?.n).toBe(5)
  })

  it('reports budget use to the alert sink', async () => {
    const { meter, alerts } = setup()
    await meter.reserve(input(anon()))
    expect(alerts.monthSpend).toHaveBeenCalledWith(MONTH, EST, 5_000_000)
  })

  it('fails closed when metering storage is down and enforcement is on, open in shadow mode', async () => {
    const broken = createMemoryUsageStore()
    broken.tryIncrement = async () => {
      throw new Error('mongo down')
    }
    const on = setup({}, { store: broken })
    await expect(on.meter.reserve(input(anon()))).rejects.toBeInstanceOf(GenerationUnavailableError)
    const shadow = setup({ enforcement: 'shadow' }, { store: broken })
    expect((await shadow.meter.reserve(input(anon()))).source).toBe('shadow')

    const none = setup({}, { store: null })
    await expect(none.meter.reserve(input(anon()))).rejects.toBeInstanceOf(GenerationUnavailableError)
    expect((await none.meter.reserve(input(owner))).source).toBe('owner')
  })
})

describe('ticket.settle', () => {
  it('replaces the estimate with the real cost and writes the ledger', async () => {
    const { meter, store } = setup()
    const t = await meter.reserve(input(user()))
    t.usage.add({ providerId: MODEL, kind: 'core', promptTokens: 800, completionTokens: 700, estimated: false })
    t.usage.add({ providerId: MODEL, kind: 'extras', promptTokens: 460, completionTokens: 400, estimated: false })
    await t.settle({ charged: true, providerId: MODEL })
    const actual = Math.ceil(800 * 0.3 + 700 * 1.2) + Math.ceil(460 * 0.3 + 400 * 1.2)
    expect(store.counters.get(counterKeys.free(DAY))).toMatchObject({ n: 1, costMicros: actual })
    expect(store.counters.get(counterKeys.monthFree(MONTH))).toMatchObject({ n: 1, costMicros: actual })
    expect(store.counters.get(counterKeys.user(DAY, 'google-oauth2|1'))?.n).toBe(1)
    expect(store.ledger).toHaveLength(1)
    expect(store.ledger[0]).toMatchObject({
      principal: { kind: 'user', sub: 'google-oauth2|1', emailVerified: true },
      action: 'lookup',
      source: 'free',
      pool: 'account',
      route: 'metered',
      routeProviderId: MODEL,
      charged: true,
      estMicros: EST,
      costMicros: actual,
      estimated: false,
      unpriced: false,
    })
    expect(store.ledger[0].calls).toHaveLength(2)
  })

  it('gives the unit back when the LLM failed, but keeps the dollars spent', async () => {
    const { meter, store } = setup()
    const t = await meter.reserve(input(anon()))
    t.usage.add({ providerId: MODEL, kind: 'core', promptTokens: 800, completionTokens: 0, estimated: true })
    await t.settle({ charged: false })
    expect(store.counters.get(counterKeys.ip(DAY, '203.0.113.7'))?.n).toBe(0)
    expect(store.counters.get(counterKeys.free(DAY))).toMatchObject({ n: 0, costMicros: 240 })
    expect(store.counters.get(counterKeys.freeAnon(DAY))).toMatchObject({ n: 0, costMicros: 240 })
    expect(t.allowance(false)).toMatchObject({ used: 0 })
    expect(store.ledger[0]).toMatchObject({ charged: false, estimated: true, costMicros: 240 })
  })

  it('settles once, and records an owner generation in the ledger only', async () => {
    const { meter, store } = setup()
    const t = await meter.reserve(input(owner))
    t.usage.add({ providerId: MODEL, kind: 'fuse', promptTokens: 1_000, completionTokens: 1_000, estimated: false })
    await Promise.all([t.settle({ charged: true }), t.settle({ charged: true })])
    expect(store.ledger).toHaveLength(1)
    expect(store.ledger[0]).toMatchObject({ source: 'owner', route: 'full', costMicros: 1_500 })
    expect(store.counters.size).toBe(0)
  })
})
