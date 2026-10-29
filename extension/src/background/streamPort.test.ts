import { describe, expect, it, vi } from 'vitest'
import { handleLookupStreamPort } from './streamPort'
import { LOOKUP_STREAM_PORT, type LookupResponse, type LookupStreamEvent } from '../shared/messages'

/** A fake `chrome.runtime.Port` that records what the worker posts to it. */
function fakePort(name = LOOKUP_STREAM_PORT) {
  const messageListeners: Array<(m: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  const posted: LookupStreamEvent[] = []
  let disconnected = false
  const port = {
    name,
    postMessage: vi.fn((m: LookupStreamEvent) => {
      if (disconnected) throw new Error('Attempting to use a disconnected port object')
      posted.push(m)
    }),
    disconnect: vi.fn(() => {
      disconnected = true
    }),
    onMessage: { addListener: (l: (m: unknown) => void) => void messageListeners.push(l) },
    onDisconnect: { addListener: (l: () => void) => void disconnectListeners.push(l) },
  }
  return {
    port: port as unknown as chrome.runtime.Port,
    raw: port,
    posted,
    send: (m: unknown) => messageListeners.forEach((l) => l(m)),
    clientLeaves: () => {
      disconnected = true
      disconnectListeners.forEach((l) => l())
    },
  }
}

const REQUEST = { type: 'LOOKUP_STREAM', text: ' Hello ', sourceLang: 'en', targetLang: 'es' }
const ENTRIES = [{ word: 'hello' }]
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('handleLookupStreamPort', () => {
  it('relays partials then done, records history, and closes the port', async () => {
    const f = fakePort()
    const recordHistory = vi.fn(async () => ({ ok: true as const, history: [] }))
    const lookup = vi.fn(async (_t: string, _s: string, _g: string, o: { onPartial?: (e: unknown[]) => void }) => {
      o.onPartial?.([{ word: 'hel' }])
      o.onPartial?.([{ word: 'hello' }])
      return { ok: true, entries: ENTRIES } as LookupResponse
    })
    handleLookupStreamPort(f.port, lookup as never, recordHistory as never)

    f.send(REQUEST)
    await flush()

    expect(lookup).toHaveBeenCalledWith(' Hello ', 'en', 'es', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(f.posted).toEqual([
      { type: 'partial', entries: [{ word: 'hel' }] },
      { type: 'partial', entries: [{ word: 'hello' }] },
      { type: 'done', entries: ENTRIES },
    ])
    expect(recordHistory).toHaveBeenCalledWith({ word: 'hello', sourceLang: 'en', targetLang: 'es' })
    expect(f.raw.disconnect).toHaveBeenCalledTimes(1)
  })

  it('posts a single error event (and no history) when the lookup fails', async () => {
    const f = fakePort()
    const recordHistory = vi.fn()
    handleLookupStreamPort(f.port, (async () => ({ ok: false, error: 'rate_limited' })) as never, recordHistory as never)
    f.send(REQUEST)
    await flush()
    expect(f.posted).toEqual([{ type: 'error', error: 'rate_limited' }])
    expect(recordHistory).not.toHaveBeenCalled()
  })

  it('turns an unexpected throw into an api_error event instead of hanging the client', async () => {
    const f = fakePort()
    handleLookupStreamPort(
      f.port,
      (async () => {
        throw new Error('boom')
      }) as never,
      vi.fn() as never
    )
    f.send(REQUEST)
    await flush()
    expect(f.posted).toEqual([{ type: 'error', error: 'api_error' }])
  })

  it('aborts the in-flight lookup and posts nothing when the client goes away', async () => {
    const f = fakePort()
    let signal: AbortSignal | undefined
    let release: () => void = () => {}
    const lookup = vi.fn(async (_t: string, _s: string, _g: string, o: { signal?: AbortSignal; onPartial?: (e: unknown[]) => void }) => {
      signal = o.signal
      await new Promise<void>((r) => (release = r))
      o.onPartial?.([{ word: 'late' }])
      return { ok: true, entries: ENTRIES } as LookupResponse
    })
    const recordHistory = vi.fn(async () => ({ ok: true as const, history: [] }))
    handleLookupStreamPort(f.port, lookup as never, recordHistory as never)

    f.send(REQUEST)
    await flush()
    expect(signal?.aborted).toBe(false)
    f.clientLeaves()
    expect(signal?.aborted).toBe(true)
    release()
    await flush()

    expect(f.posted).toEqual([])
    expect(f.raw.disconnect).not.toHaveBeenCalled()
  })

  it('ignores ports with another name and ignores a second request on the same port', async () => {
    const other = fakePort('something-else')
    const lookup = vi.fn(async () => ({ ok: true, entries: ENTRIES }) as LookupResponse)
    handleLookupStreamPort(other.port, lookup as never, vi.fn() as never)
    other.send(REQUEST)
    await flush()
    expect(lookup).not.toHaveBeenCalled()

    const f = fakePort()
    handleLookupStreamPort(f.port, lookup as never, (async () => ({ ok: true, history: [] })) as never)
    f.send(REQUEST)
    f.send(REQUEST)
    await flush()
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated messages on the port', async () => {
    const f = fakePort()
    const lookup = vi.fn(async () => ({ ok: true, entries: ENTRIES }) as LookupResponse)
    handleLookupStreamPort(f.port, lookup as never, vi.fn() as never)
    f.send({ type: 'LOOKUP', text: 'x' })
    f.send(undefined)
    await flush()
    expect(lookup).not.toHaveBeenCalled()
  })
})
