import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupWordStream, LookupError, type DictionaryEntry } from './dictionary'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const FULL: DictionaryEntry[] = [
  { word: 'hello', translation: 'hola', phonetics: [], meanings: [{ partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting' }] }] },
]
const PARTIAL: DictionaryEntry[] = [{ word: 'hello', translation: 'hola', phonetics: [], meanings: [] }]

function sse(events: Array<[string, unknown]>, chunkSize = 17): Response {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lookupWordStream', () => {
  it('delivers partials in order, resolves with the final entries, and caches them', async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      sse([
        ['partial', PARTIAL],
        ['partial', [{ ...PARTIAL[0], meanings: FULL[0].meanings }]],
        ['done', FULL],
      ])
    )
    vi.stubGlobal('fetch', fetchMock)
    const partials: DictionaryEntry[][] = []

    const result = await lookupWordStream('Hello', 'en', 'es', { onPartial: (p) => partials.push(p) })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/translate-stream/hello?from=en&to=es')
    expect(partials).toHaveLength(2)
    expect(partials[0][0].meanings).toEqual([])
    expect(partials[1][0].meanings).toHaveLength(1)
    expect(result).toEqual(FULL)
    expect(JSON.parse(store.get('dict:v1:en:es:hello')!).data).toEqual(FULL)
  })

  it('serves a client-cache hit without any network request', async () => {
    store.set('dict:v1:en:en:hello', JSON.stringify({ data: FULL, fetchedAt: Date.now() }))
    const fetchMock = vi.fn<FetchFn>(async () => {
      throw new Error('should not be called')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    expect(await lookupWordStream('hello', 'en', 'en')).toEqual(FULL)
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('activity-ping'))).toBe(true)
  })

  it('maps a not_found error event to LookupError(not_found)', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchFn>(async () => sse([['error', { error: 'not_found' }]])))
    await expect(lookupWordStream('zzzz')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('maps an internal error event to api_error', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchFn>(async () => sse([['partial', PARTIAL], ['error', { error: 'internal' }]])))
    await expect(lookupWordStream('hello')).rejects.toMatchObject({ code: 'api_error' })
  })

  it('falls back to the plain endpoint when the server has no stream route (404)', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url) =>
      String(url).includes('translate-stream') ? jsonResponse({ error: 'not_found' }, 404) : jsonResponse(FULL)
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await lookupWordStream('hello')).toEqual(FULL)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/translate/hello')
  })

  it('falls back when a proxy answers with something that is not an event stream', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url) =>
      String(url).includes('translate-stream') ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) : jsonResponse(FULL)
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupWordStream('hello')).toEqual(FULL)
  })

  it('falls back when the connection is cut before the done event', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url) =>
      String(url).includes('translate-stream') ? sse([['partial', PARTIAL]]) : jsonResponse(FULL)
    )
    vi.stubGlobal('fetch', fetchMock)
    const partials: unknown[] = []
    expect(await lookupWordStream('hello', 'en', 'en', { onPartial: (p) => partials.push(p) })).toEqual(FULL)
    expect(partials).toHaveLength(1)
  })

  it('falls back when the stream request itself fails to connect', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url) => {
      if (String(url).includes('translate-stream')) throw new TypeError('network down')
      return jsonResponse(FULL)
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupWordStream('hello')).toEqual(FULL)
  })

  it('does not retry on a rate limit — it surfaces as an error', async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse({ error: 'rate_limited' }, 429))
    vi.stubGlobal('fetch', fetchMock)
    await expect(lookupWordStream('hello')).rejects.toMatchObject({ code: 'api_error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborting the caller signal cancels the request without falling back', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const pending = lookupWordStream('hello', 'en', 'en', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(LookupError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty word', async () => {
    await expect(lookupWordStream('   ')).rejects.toMatchObject({ code: 'not_found' })
  })
})
