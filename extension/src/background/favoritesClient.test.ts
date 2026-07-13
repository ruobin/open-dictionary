import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeChromeStorage } from './testUtils'

/**
 * Favorites-sync client tests (Phase 9), against the same `Map`-backed
 * `chrome.storage.local` fake used for `lookupClient`/`settings` — the
 * access token itself comes from `authClient.getAccessToken()`, which is
 * mocked directly here rather than driving the full `chrome.identity`
 * flow (that API has no meaningful Node/jsdom fake and is exercised
 * end-to-end instead via the Puppeteer/Chrome-for-Testing harness).
 */
describe('favoritesClient', () => {
  beforeEach(() => {
    vi.resetModules()
    installFakeChromeStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('./authClient')
  })

  it('returns unauthorized without fetching when signed out', async () => {
    vi.doMock('./authClient', () => ({ getAccessToken: vi.fn().mockResolvedValue(null) }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { listFavorites } = await import('./favoritesClient')

    expect(await listFavorites()).toEqual({ ok: false, error: 'unauthorized' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lists favorites with a bearer token when signed in', async () => {
    vi.doMock('./authClient', () => ({ getAccessToken: vi.fn().mockResolvedValue('tok123') }))
    const favorites = [{ word: 'hello', sourceLang: 'en', targetLang: 'en' }]
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => favorites })
    vi.stubGlobal('fetch', fetchSpy)
    const { listFavorites } = await import('./favoritesClient')

    expect(await listFavorites()).toEqual({ ok: true, favorites })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/favorites')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123')
  })

  it('maps a 401 from the server to unauthorized', async () => {
    vi.doMock('./authClient', () => ({ getAccessToken: vi.fn().mockResolvedValue('tok123') }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const { listFavorites } = await import('./favoritesClient')

    expect(await listFavorites()).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('addFavorite POSTs then re-lists on success', async () => {
    vi.doMock('./authClient', () => ({ getAccessToken: vi.fn().mockResolvedValue('tok123') }))
    const favorites = [{ word: 'hi', sourceLang: 'en', targetLang: 'en' }]
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => favorites })
    vi.stubGlobal('fetch', fetchSpy)
    const { addFavorite } = await import('./favoritesClient')

    const result = await addFavorite({ word: 'hi', sourceLang: 'en', targetLang: 'en' })

    expect(result).toEqual({ ok: true, favorites })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [, postInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(postInit.method).toBe('POST')
  })

  it('removeFavorite DELETEs then re-lists on success', async () => {
    vi.doMock('./authClient', () => ({ getAccessToken: vi.fn().mockResolvedValue('tok123') }))
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
    vi.stubGlobal('fetch', fetchSpy)
    const { removeFavorite } = await import('./favoritesClient')

    const result = await removeFavorite({ word: 'hi', sourceLang: 'en', targetLang: 'en' })

    expect(result).toEqual({ ok: true, favorites: [] })
    const [deleteUrl, deleteInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(deleteInit.method).toBe('DELETE')
    expect(deleteUrl).toContain('word=hi')
  })
})
