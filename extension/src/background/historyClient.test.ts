import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeChromeStorage } from './testUtils'

describe('historyClient', () => {
  beforeEach(() => {
    vi.resetModules()
    installFakeChromeStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('./authClient')
  })

  it('keeps history locally when signed out, most-recent-first', async () => {
    vi.doMock('./authClient', () => ({
      getAccessToken: vi.fn().mockResolvedValue(null),
      getValidAuth: vi.fn().mockResolvedValue(null),
    }))
    const { addHistory, getHistory } = await import('./historyClient')

    await addHistory({ word: 'hello', sourceLang: 'en', targetLang: 'en' })
    const second = await addHistory({ word: 'world', sourceLang: 'en', targetLang: 'en' })

    expect(second).toEqual({
      ok: true,
      history: [
        { word: 'world', sourceLang: 'en', targetLang: 'en' },
        { word: 'hello', sourceLang: 'en', targetLang: 'en' },
      ],
    })
    expect(await getHistory()).toEqual(second)
  })

  it('de-duplicates a repeated lookup by moving it to the front', async () => {
    vi.doMock('./authClient', () => ({
      getAccessToken: vi.fn().mockResolvedValue(null),
      getValidAuth: vi.fn().mockResolvedValue(null),
    }))
    const { addHistory } = await import('./historyClient')

    await addHistory({ word: 'hello', sourceLang: 'en', targetLang: 'en' })
    await addHistory({ word: 'world', sourceLang: 'en', targetLang: 'en' })
    const result = await addHistory({ word: 'hello', sourceLang: 'en', targetLang: 'en' })

    expect(result).toEqual({
      ok: true,
      history: [
        { word: 'hello', sourceLang: 'en', targetLang: 'en' },
        { word: 'world', sourceLang: 'en', targetLang: 'en' },
      ],
    })
  })

  it('caps history at 30 entries', async () => {
    vi.doMock('./authClient', () => ({
      getAccessToken: vi.fn().mockResolvedValue(null),
      getValidAuth: vi.fn().mockResolvedValue(null),
    }))
    const { addHistory } = await import('./historyClient')

    let result
    for (let i = 0; i < 35; i++) {
      result = await addHistory({ word: `word${i}`, sourceLang: 'en', targetLang: 'en' })
    }

    expect(result?.ok).toBe(true)
    expect(result?.ok && result.history).toHaveLength(30)
    expect(result?.ok && result.history[0]).toEqual({ word: 'word34', sourceLang: 'en', targetLang: 'en' })
  })

  it('syncs to /api/user-data when signed in', async () => {
    vi.doMock('./authClient', () => ({
      getAccessToken: vi.fn().mockResolvedValue('tok123'),
      getValidAuth: vi.fn().mockResolvedValue({ accessToken: 'tok123' }),
    }))
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ history: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchSpy)
    const { addHistory } = await import('./historyClient')

    const result = await addHistory({ word: 'hello', sourceLang: 'en', targetLang: 'en' })

    expect(result).toEqual({
      ok: true,
      history: [{ word: 'hello', sourceLang: 'en', targetLang: 'en' }],
    })
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('/api/user-data')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123')
  })
})
