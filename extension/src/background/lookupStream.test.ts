import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeChromeStorage } from './testUtils'

/** Streamed lookups against the Map-backed `chrome.storage.local` fake. */
describe('lookupClient.lookupWordStream', () => {
  let fakeStorage: ReturnType<typeof installFakeChromeStorage>

  beforeEach(() => {
    vi.resetModules()
    fakeStorage = installFakeChromeStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const FULL = [{ word: 'hello', translation: 'hola', meanings: [{ partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting' }] }] }]
  const PARTIAL = [{ word: 'hello', translation: 'ho' }]

  function sse(events: Array<[string, unknown]>, chunkSize = 13): Response {
    const bytes = new TextEncoder().encode(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }

  const plain = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('relays partials in order, resolves with the final entries and caches them', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => sse([['partial', PARTIAL], ['partial', FULL], ['done', FULL]]))
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')
    const partials: unknown[] = []

    const result = await lookupWordStream('Hello', 'en', 'es', { onPartial: (p) => partials.push(p) })

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/translate-stream/hello?from=en&to=es')
    expect(partials).toEqual([PARTIAL, FULL])
    expect(result).toEqual({ ok: true, entries: FULL })
    const cached = await fakeStorage.local.get('dict:v1:en:es:hello')
    expect(cached['dict:v1:en:es:hello']).toMatchObject({ data: FULL })
  })

  it('serves a cache hit without streaming and beacons a client-cache ping', async () => {
    await fakeStorage.local.set({ 'dict:v1:en:en:hello': { data: FULL, fetchedAt: Date.now() } })
    const fetchSpy = vi.fn(async (_url: unknown) => plain({}))
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')
    const onPartial = vi.fn()

    expect(await lookupWordStream('hello', 'en', 'en', { onPartial })).toEqual({ ok: true, entries: FULL })
    expect(onPartial).not.toHaveBeenCalled()
    expect(fetchSpy.mock.calls.every(([url]) => String(url).includes('activity-ping'))).toBe(true)
  })

  it('returns not_found for an empty word without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')
    expect(await lookupWordStream('   ', 'en', 'en')).toEqual({ ok: false, error: 'not_found' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps stream error events: not_found stays not_found, anything else is api_error', async () => {
    const { lookupWordStream } = await import('./lookupClient')
    vi.stubGlobal('fetch', vi.fn(async () => sse([['error', { error: 'not_found' }]])))
    expect(await lookupWordStream('zzzz', 'en', 'en')).toEqual({ ok: false, error: 'not_found' })
    vi.stubGlobal('fetch', vi.fn(async () => sse([['partial', PARTIAL], ['error', { error: 'internal' }]])))
    expect(await lookupWordStream('hello', 'en', 'en')).toEqual({ ok: false, error: 'api_error' })
  })

  it('maps a 429 to rate_limited without retrying', async () => {
    const fetchSpy = vi.fn(async () => plain({ error: 'rate_limited' }, 429))
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')
    expect(await lookupWordStream('busy', 'en', 'en')).toEqual({ ok: false, error: 'rate_limited' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the plain endpoint when the server has no stream route (404)', async () => {
    const fetchSpy = vi.fn(async (url: unknown) =>
      String(url).includes('translate-stream') ? plain({ error: 'not_found' }, 404) : plain(FULL)
    )
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')

    expect(await lookupWordStream('hello', 'en', 'en')).toEqual({ ok: true, entries: FULL })
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/api/translate/hello')
  })

  it('falls back when a proxy answers with something that is not an event stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('translate-stream')
          ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
          : plain(FULL)
      )
    )
    const { lookupWordStream } = await import('./lookupClient')
    expect(await lookupWordStream('hello', 'en', 'en')).toEqual({ ok: true, entries: FULL })
  })

  it('falls back when the connection is cut before the done event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => (String(url).includes('translate-stream') ? sse([['partial', PARTIAL]]) : plain(FULL)))
    )
    const { lookupWordStream } = await import('./lookupClient')
    const partials: unknown[] = []
    expect(await lookupWordStream('hello', 'en', 'en', { onPartial: (p) => partials.push(p) })).toEqual({ ok: true, entries: FULL })
    expect(partials).toHaveLength(1)
  })

  it('falls back when the stream request itself cannot connect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('translate-stream')) throw new TypeError('network down')
        return plain(FULL)
      })
    )
    const { lookupWordStream } = await import('./lookupClient')
    expect(await lookupWordStream('hello', 'en', 'en')).toEqual({ ok: true, entries: FULL })
  })

  it('aborting the caller signal cancels the request without falling back', async () => {
    const controller = new AbortController()
    const fetchSpy = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    )
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')

    const pending = lookupWordStream('hello', 'en', 'en', { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: 'network' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('an already-aborted signal never touches the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupWordStream } = await import('./lookupClient')
    const controller = new AbortController()
    controller.abort()
    expect(await lookupWordStream('hello', 'en', 'en', { signal: controller.signal })).toEqual({ ok: false, error: 'network' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
