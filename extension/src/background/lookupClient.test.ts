import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeChromeStorage } from './testUtils'

/**
 * Cache read/write + fetch-error-mapping tests for `lookupWord()` (design
 * doc §11 / Phase 8), against the `Map`-backed `chrome.storage.local` fake
 * — no real extension runtime required.
 */
describe('lookupClient.lookupWord', () => {
  let fakeStorage: ReturnType<typeof installFakeChromeStorage>

  beforeEach(() => {
    vi.resetModules()
    fakeStorage = installFakeChromeStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns not_found for an empty/whitespace-only word without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWord } = await import('./lookupClient')

    const result = await lookupWord('   ', 'en', 'en')

    expect(result).toEqual({ ok: false, error: 'not_found' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches on a cache miss, then writes the response to the cache', async () => {
    const entries = [{ word: 'hello' }]
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => entries,
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWord } = await import('./lookupClient')

    const result = await lookupWord('Hello', 'en', 'en')

    expect(result).toEqual({ ok: true, entries })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('/api/translate/hello')
    expect(url).toContain('from=en')
    expect(url).toContain('to=en')

    // Cache write happened under the normalized (lowercased) key.
    const cached = await fakeStorage.local.get('dict:v1:en:en:hello')
    expect(cached['dict:v1:en:en:hello']).toMatchObject({ data: entries })
  })

  it('serves from cache on a second lookup without a second fetch', async () => {
    const entries = [{ word: 'hello' }]
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => entries,
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWord } = await import('./lookupClient')

    await lookupWord('hello', 'en', 'en')
    const second = await lookupWord('hello', 'en', 'en')

    expect(second).toEqual({ ok: true, entries })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('treats an expired cache entry as a miss and re-fetches', async () => {
    const staleEntries = [{ word: 'stale' }]
    await fakeStorage.local.set({
      'dict:v1:en:en:hello': {
        data: staleEntries,
        fetchedAt: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days ago > 30-day TTL
      },
    })
    const freshEntries = [{ word: 'fresh' }]
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => freshEntries,
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWord } = await import('./lookupClient')

    const result = await lookupWord('hello', 'en', 'en')

    expect(result).toEqual({ ok: true, entries: freshEntries })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('maps a 404 response to not_found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    const { lookupWord } = await import('./lookupClient')

    expect(await lookupWord('nope', 'en', 'en')).toEqual({ ok: false, error: 'not_found' })
  })

  it('maps a 429 response to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }))
    const { lookupWord } = await import('./lookupClient')

    expect(await lookupWord('busy', 'en', 'en')).toEqual({ ok: false, error: 'rate_limited' })
  })

  it('maps any other non-ok status to api_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { lookupWord } = await import('./lookupClient')

    expect(await lookupWord('broken', 'en', 'en')).toEqual({ ok: false, error: 'api_error' })
  })

  it('maps a network failure to network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const { lookupWord } = await import('./lookupClient')

    expect(await lookupWord('offline', 'en', 'en')).toEqual({ ok: false, error: 'network' })
  })

  it('maps an aborted (timed-out) fetch to timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )
    const { lookupWord } = await import('./lookupClient')

    expect(await lookupWord('slow', 'en', 'en')).toEqual({ ok: false, error: 'timeout' })
  })
})
