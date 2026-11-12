import { describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return { ...actual, ADMIN_USER_IDS: new Set(['auth0|owner']) }
})

const { expandIpv6, ipKeyFor, rateLimitKey, resolveIdentity } = await import('./principal')

function fakeReq(opts: { ip?: string; sub?: string; authorization?: string }): Request {
  return {
    ip: opts.ip ?? '203.0.113.7',
    auth: opts.sub ? { payload: { sub: opts.sub } } : undefined,
    get: (name: string) => (name.toLowerCase() === 'authorization' ? opts.authorization : undefined),
  } as unknown as Request
}

describe('ipKeyFor', () => {
  it('keeps IPv4 as is', () => {
    expect(ipKeyFor('203.0.113.7')).toBe('203.0.113.7')
  })

  it('truncates IPv6 to its /64, however the address is written', () => {
    const key = '2001:db8:aa:bb::/64'
    expect(ipKeyFor('2001:db8:aa:bb::1')).toBe(key)
    expect(ipKeyFor('2001:0db8:00aa:00bb:1234:5678:9abc:def0')).toBe(key)
    expect(ipKeyFor('2001:DB8:AA:BB:ffff::')).toBe(key)
    expect(ipKeyFor('2001:db8:aa:bb::1%eth0')).toBe(key)
  })

  it('handles compressed prefixes and embedded IPv4', () => {
    expect(ipKeyFor('::1')).toBe('0:0:0:0::/64')
    expect(expandIpv6('64:ff9b::192.0.2.33')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x0221])
  })

  it('leaves unparseable input alone', () => {
    expect(ipKeyFor('unknown')).toBe('unknown')
    expect(expandIpv6('1::2::3')).toBeNull()
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeNull()
  })
})

describe('resolveIdentity', () => {
  it('recognises the owner by ADMIN_USER_IDS', () => {
    const id = resolveIdentity(fakeReq({ sub: 'auth0|owner', authorization: 'Bearer x' }))
    expect(id.principal.kind).toBe('owner')
    expect(id.authState).toBe('valid')
  })

  it('treats any other verified sub as a signed-in user', () => {
    const id = resolveIdentity(fakeReq({ sub: 'google-oauth2|42', authorization: 'Bearer x' }))
    expect(id.principal).toMatchObject({ kind: 'user', sub: 'google-oauth2|42', ip: '203.0.113.7' })
    expect(rateLimitKey(id)).toBe('u:google-oauth2|42')
  })

  it('is anonymous without a header, and flags a header whose token failed verification', () => {
    expect(resolveIdentity(fakeReq({})).authState).toBe('anonymous')
    const rejected = resolveIdentity(fakeReq({ authorization: 'Bearer expired' }))
    expect(rejected.principal.kind).toBe('anon')
    expect(rejected.authState).toBe('invalid')
  })

  it('keys anonymous rate limits by IP (/64)', () => {
    expect(rateLimitKey(resolveIdentity(fakeReq({ ip: '2001:db8:aa:bb::9' })))).toBe('ip:2001:db8:aa:bb::/64')
  })
})
