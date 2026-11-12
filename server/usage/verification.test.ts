import { describe, expect, it, vi } from 'vitest'
import { createMemoryUsageStore } from './store'
import { createVerifier, type Auth0Directory } from './verification'
import type { AccountDoc } from './types'

const MIN = 60_000

function setup(verified: boolean | Error = true) {
  let t = Date.UTC(2026, 10, 12, 10, 0)
  const store = createMemoryUsageStore()
  const directory: Auth0Directory = {
    getEmailVerified: vi.fn(async () => {
      if (verified instanceof Error) throw verified
      return verified
    }),
    sendVerificationEmail: vi.fn(async () => undefined),
    getEmail: vi.fn(async () => 'someone@example.com'),
    findByEmail: vi.fn(async () => []),
  }
  const verifier = createVerifier({ directory, store, now: () => t })
  return {
    store,
    directory,
    verifier,
    advance: (ms: number) => {
      t += ms
    },
    account: async (fields: Partial<AccountDoc> = {}): Promise<AccountDoc> => {
      const doc = await store.ensureAccount('google-oauth2|1', new Date(t))
      if (Object.keys(fields).length > 0) await store.updateAccount(doc._id, fields)
      return (await store.getAccount(doc._id)) as AccountDoc
    },
    now: () => new Date(t),
  }
}

describe('email verification', () => {
  it('asks Auth0 once and caches a verified answer for 7 days', async () => {
    const s = setup(true)
    expect(await s.verifier.isVerified(await s.account())).toBe(true)
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(1)
    s.advance(6 * 24 * 60 * MIN)
    expect(await s.verifier.isVerified(await s.account())).toBe(true)
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(1)
    s.advance(2 * 24 * 60 * MIN)
    await s.verifier.isVerified(await s.account())
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(2)
  })

  it('re-checks an unverified account after 10 minutes, or at once when forced (at most once a minute)', async () => {
    const s = setup(false)
    expect(await s.verifier.isVerified(await s.account())).toBe(false)
    s.advance(5 * MIN)
    expect(await s.verifier.isVerified(await s.account())).toBe(false)
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(1)
    await s.verifier.isVerified(await s.account(), { force: true })
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(2)
    s.advance(30_000)
    await s.verifier.isVerified(await s.account(), { force: true })
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(2)
    // The forced check at minute 5 restarted the 10-minute window.
    s.advance(6 * MIN)
    await s.verifier.isVerified(await s.account())
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(2)
    s.advance(4 * MIN)
    await s.verifier.isVerified(await s.account())
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(3)
  })

  it('treats an Auth0 error as unverified without caching it', async () => {
    const s = setup(new Error('rate limited'))
    expect(await s.verifier.isVerified(await s.account())).toBe(false)
    expect((await s.account()).emailVerifiedCheckedAt).toBeUndefined()
  })

  it('shares one Auth0 call between concurrent checks of the same account', async () => {
    const s = setup(true)
    const account = await s.account()
    await Promise.all([s.verifier.isVerified(account), s.verifier.isVerified(account), s.verifier.isVerified(account)])
    expect(s.directory.getEmailVerified).toHaveBeenCalledTimes(1)
  })

  it('limits resends to one per 10 minutes and five a day', async () => {
    const s = setup(false)
    expect(await s.verifier.resend(await s.account())).toBe('sent')
    expect(await s.verifier.resend(await s.account())).toBe('rate_limited')
    for (let i = 0; i < 4; i += 1) {
      s.advance(11 * MIN)
      expect(await s.verifier.resend(await s.account())).toBe('sent')
    }
    s.advance(11 * MIN)
    expect(await s.verifier.resend(await s.account())).toBe('rate_limited')
    expect(s.directory.sendVerificationEmail).toHaveBeenCalledTimes(5)
  })

  it('does not resend to an account that is already verified', async () => {
    const s = setup(true)
    expect(await s.verifier.resend(await s.account())).toBe('already_verified')
    expect(s.directory.sendVerificationEmail).not.toHaveBeenCalled()
  })
})
