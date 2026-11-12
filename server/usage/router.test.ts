import { afterEach, describe, expect, it } from 'vitest'
import { createUsageService } from './index'
import { describeUsage } from './router'
import { setPricesForTests } from './pricing'
import { envUsageDefaults, type UsageSettings } from './settings'
import { createMemoryUsageStore } from './store'
import type { Principal } from './types'
import { counterKeys } from './windows'

const NOW = new Date('2026-11-12T10:00:00Z')

afterEach(() => setPricesForTests(new Map()))

function service(settings: Partial<UsageSettings> = {}) {
  const store = createMemoryUsageStore()
  const usage = createUsageService({
    db: null,
    directory: null,
    store,
    meteredProviderId: () => 'llm:test:cheap',
    settings: () => ({
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
      ...settings,
    }),
  })
  return { usage, store }
}

const anon: Principal = { kind: 'anon', ip: '203.0.113.7', ipKey: '203.0.113.7' }
const user: Principal = { kind: 'user', sub: 'google-oauth2|1', ip: '203.0.113.7', ipKey: '203.0.113.7' }
const owner: Principal = { kind: 'owner', sub: 'auth0|owner', ip: '198.51.100.1', ipKey: '198.51.100.1' }

describe('GET /api/usage/me view', () => {
  it("shows an anonymous visitor their IP's allowance", async () => {
    const { usage, store } = service()
    await store.add(counterKeys.ip('2026-11-12', '203.0.113.7'), { n: 2 }, NOW)
    const view = await describeUsage(usage, { principal: anon, authState: 'anonymous' }, () => [], NOW)
    expect(view).toEqual({
      tier: 'anon',
      authState: 'anonymous',
      enforcement: 'on',
      emailVerified: null,
      today: { used: 2, limit: 5, pool: 'ip', resetAt: '2026-11-13T00:00:00.000Z' },
      freeTier: 'open',
      verifiedLimit: 20,
    })
  })

  it('shows an unverified account the IP allowance and says it is unverified (no Auth0 here)', async () => {
    const { usage } = service()
    const view = await describeUsage(usage, { principal: user, authState: 'valid' }, () => [], NOW)
    expect(view).toMatchObject({ tier: 'user', emailVerified: false, today: { pool: 'ip', limit: 5 } })
  })

  it('shows a verified account its own allowance', async () => {
    const { usage, store } = service()
    await store.ensureAccount(user.kind === 'user' ? user.sub : '', NOW)
    await store.updateAccount('google-oauth2|1', { emailVerified: true, emailVerifiedCheckedAt: new Date() })
    const view = await describeUsage(usage, { principal: user, authState: 'valid' }, () => [], NOW)
    expect(view).toMatchObject({ tier: 'user', emailVerified: true, today: { used: 0, limit: 20, pool: 'account' } })
  })

  it('gives the owner no allowance but the full-setup models; reports a paused free tier', async () => {
    const { usage } = service({ freeTierEnabled: false })
    const view = await describeUsage(usage, { principal: owner, authState: 'valid' }, () => ['a', 'b'], NOW)
    expect(view).toMatchObject({ tier: 'owner', today: null, fullModels: ['a', 'b'], freeTier: 'paused' })
  })

  it('reports budget_reached once one more generation would not fit', async () => {
    setPricesForTests(new Map([['llm:test:cheap', { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 }]]))
    const { usage, store } = service()
    // Today's budget is $5 ÷ 19 days left ≈ $0.263; spend almost all of it.
    await store.add(counterKeys.free('2026-11-12'), { costMicros: 262_000 }, NOW)
    await store.add(counterKeys.monthFree('2026-11'), { costMicros: 262_000 }, NOW)
    const view = await describeUsage(usage, { principal: anon, authState: 'anonymous' }, () => [], NOW)
    expect(view.freeTier).toBe('budget_reached')
  })
})
