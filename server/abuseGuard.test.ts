import { describe, expect, it } from 'vitest'
import { ClientBlocklist, LlmBudget, isCrawlerUserAgent, normalizeIp, parseBlockTarget } from './abuseGuard'
import { flagsFor } from './admin/clients'

const HOUR = 3_600_000

describe('parseBlockTarget', () => {
  it('accepts plain IPv4/IPv6 and canonicalises', () => {
    expect(parseBlockTarget(' 74.7.227.41 ')).toMatchObject({ target: '74.7.227.41', family: 'ipv4' })
    expect(parseBlockTarget('::ffff:74.7.227.41')).toMatchObject({ target: '74.7.227.41' })
    expect(parseBlockTarget('2001:DB8::1')).toMatchObject({ target: '2001:db8::1', family: 'ipv6' })
  })

  it('accepts CIDRs within bounds; a full-length prefix collapses to the address', () => {
    expect(parseBlockTarget('74.7.227.0/24')).toMatchObject({ target: '74.7.227.0/24', prefix: 24 })
    expect(parseBlockTarget('1.2.3.4/32')).toEqual({ target: '1.2.3.4', address: '1.2.3.4', family: 'ipv4' })
    expect(parseBlockTarget('2001:db8::/32')).toMatchObject({ prefix: 32, family: 'ipv6' })
  })

  it('rejects garbage and overly broad ranges', () => {
    for (const bad of ['', 'abc', '1.2.3', '1.2.3.4/7', '0.0.0.0/0', '1.2.3.4/x', '1.2.3.4/24/1', '::/8', 42, null]) {
      expect(parseBlockTarget(bad)).toBeNull()
    }
  })
})

describe('ClientBlocklist', () => {
  const doc = (id: string, expiresAt?: Date) => ({ _id: id, createdAt: new Date(), createdBy: 'admin', expiresAt })

  it('matches exact IPs and subnets, including IPv4-mapped forms', () => {
    const list = new ClientBlocklist()
    list.set([doc('74.7.227.0/24'), doc('9.9.9.9')])
    expect(list.match('74.7.227.41')?._id).toBe('74.7.227.0/24')
    expect(list.match('::ffff:74.7.227.41')?._id).toBe('74.7.227.0/24')
    expect(list.match('9.9.9.9')?._id).toBe('9.9.9.9')
    expect(list.match('74.7.228.1')).toBeUndefined()
    expect(list.match('unknown')).toBeUndefined()
  })

  it('ignores expired entries', () => {
    const list = new ClientBlocklist()
    const now = new Date('2026-10-30T00:00:00Z')
    list.set([doc('1.1.1.1', new Date(now.getTime() - 1))])
    expect(list.match('1.1.1.1', now)).toBeUndefined()
  })
})

describe('LlmBudget', () => {
  it('counts over a rolling 24h window and trips at the limit', () => {
    const b = new LlmBudget(3)
    const t0 = Date.UTC(2026, 9, 30, 0, 0)
    b.record('a', t0)
    b.record('a', t0 + HOUR)
    expect(b.exceeded('a', t0 + HOUR)).toBe(false)
    b.record('a', t0 + 2 * HOUR)
    expect(b.count('a', t0 + 2 * HOUR)).toBe(3)
    expect(b.exceeded('a', t0 + 2 * HOUR)).toBe(true)
    expect(b.exceeded('b', t0 + 2 * HOUR)).toBe(false)
    // 24h after the first call, its bucket falls out of the window.
    expect(b.count('a', t0 + 24 * HOUR)).toBe(2)
    expect(b.exceeded('a', t0 + 24 * HOUR)).toBe(false)
  })

  it('limit 0 disables the cap', () => {
    const b = new LlmBudget(0)
    for (let i = 0; i < 10; i++) b.record('a')
    expect(b.exceeded('a')).toBe(false)
  })

  it('sweep drops idle IPs and top() ranks by usage', () => {
    const b = new LlmBudget(100)
    const t0 = Date.UTC(2026, 9, 30)
    b.record('old', t0)
    b.record('x', t0 + 30 * HOUR)
    b.record('y', t0 + 30 * HOUR)
    b.record('y', t0 + 30 * HOUR)
    b.sweep(t0 + 30 * HOUR)
    expect(b.top(10, t0 + 30 * HOUR).map((r) => r.ip)).toEqual(['y', 'x'])
  })
})

describe('isCrawlerUserAgent', () => {
  it('flags the GPTBot UA from the 2026-10-30 incident and common scripts', () => {
    expect(
      isCrawlerUserAgent('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)')
    ).toBe(true)
    expect(isCrawlerUserAgent('curl/8.5.0')).toBe(true)
    expect(isCrawlerUserAgent('python-requests/2.31')).toBe(true)
  })

  it('lets real browsers and missing UAs through', () => {
    expect(
      isCrawlerUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')
    ).toBe(false)
    expect(isCrawlerUserAgent(undefined)).toBe(false)
  })
})

describe('normalizeIp', () => {
  it('strips the v4-mapped prefix only for real v4 addresses', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(normalizeIp('::1')).toBe('::1')
    expect(normalizeIp(undefined)).toBe('unknown')
  })
})

describe('flagsFor', () => {
  const base = { total: 10, perHour: 1, deviceTypes: ['desktop'], budgetUsed: 0, blocked: false }
  it('flags bots, budget, and rate', () => {
    expect(flagsFor(base, 300)).toEqual([])
    expect(flagsFor({ ...base, deviceTypes: ['bot'] }, 300)).toEqual(['bot-ua'])
    expect(flagsFor({ ...base, budgetUsed: 300 }, 300)).toEqual(['over-budget'])
    expect(flagsFor({ ...base, budgetUsed: 150 }, 300)).toEqual(['near-budget'])
    expect(flagsFor({ ...base, total: 500, perHour: 80 }, 300)).toEqual(['high-rate'])
    expect(flagsFor({ ...base, blocked: true, budgetUsed: 999 }, 0)).toEqual(['blocked'])
  })
})
