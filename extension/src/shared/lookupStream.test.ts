import { describe, expect, it, vi } from 'vitest'
import { startLookupStream } from './lookupStream'
import { LOOKUP_STREAM_PORT, type ExtensionMessage, type LookupResponse, type LookupStreamEvent } from './messages'

const PARAMS = { text: 'hello', sourceLang: 'en', targetLang: 'es' }
const ENTRIES = [{ word: 'hello' }]

function setup(opts: { connectThrows?: boolean; oneShot?: LookupResponse } = {}) {
  const msgListeners: Array<(e: LookupStreamEvent) => void> = []
  const discListeners: Array<() => void> = []
  const port = {
    name: LOOKUP_STREAM_PORT,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (l: (e: LookupStreamEvent) => void) => void msgListeners.push(l) },
    onDisconnect: { addListener: (l: () => void) => void discListeners.push(l) },
  }
  let clock = 1000
  const sendMessage = vi.fn(async (_m: ExtensionMessage) => opts.oneShot ?? ({ ok: true, entries: ENTRIES } as LookupResponse))
  const connect = vi.fn(() => {
    if (opts.connectThrows) throw new Error('Extension context invalidated.')
    return port as unknown as chrome.runtime.Port
  })
  const deps = { connect, sendMessage: sendMessage as never, now: () => clock }
  const handlers = { onPartial: vi.fn(), onDone: vi.fn() }
  return {
    deps,
    handlers,
    port,
    sendMessage,
    emit: (e: LookupStreamEvent) => msgListeners.forEach((l) => l(e)),
    disconnect: () => discListeners.forEach((l) => l()),
    advance: (ms: number) => {
      clock += ms
    },
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('startLookupStream', () => {
  it('posts the request, forwards partials, and finishes with animate=true after a streamed answer', () => {
    const t = setup()
    startLookupStream(PARAMS, t.handlers, t.deps)

    expect(t.deps.connect).toHaveBeenCalledWith({ name: LOOKUP_STREAM_PORT })
    expect(t.port.postMessage).toHaveBeenCalledWith({ type: 'LOOKUP_STREAM', ...PARAMS })
    t.emit({ type: 'partial', entries: [{ word: 'hel' }] })
    t.emit({ type: 'done', entries: ENTRIES })

    expect(t.handlers.onPartial).toHaveBeenCalledWith([{ word: 'hel' }])
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: true, entries: ENTRIES }, true)
  })

  it('does not animate an instant cache hit (done with no partials, no delay)', () => {
    const t = setup()
    startLookupStream(PARAMS, t.handlers, t.deps)
    t.emit({ type: 'done', entries: ENTRIES })
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: true, entries: ENTRIES }, false)
  })

  it('animates a slow lookup even if no partial arrived', () => {
    const t = setup()
    startLookupStream(PARAMS, t.handlers, t.deps)
    t.advance(900)
    t.emit({ type: 'done', entries: ENTRIES })
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: true, entries: ENTRIES }, true)
  })

  it('reports an error event as a failed result (never animated)', () => {
    const t = setup()
    startLookupStream(PARAMS, t.handlers, t.deps)
    t.emit({ type: 'partial', entries: [{ word: 'h' }] })
    t.emit({ type: 'error', error: 'rate_limited' })
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: false, error: 'rate_limited' }, false)
  })

  it('finishes exactly once and does not fall back when the worker closes the port after done', async () => {
    const t = setup()
    startLookupStream(PARAMS, t.handlers, t.deps)
    t.emit({ type: 'done', entries: ENTRIES })
    t.disconnect()
    await flush()
    expect(t.handlers.onDone).toHaveBeenCalledTimes(1)
    expect(t.sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to the one-shot LOOKUP message when the port drops before a result', async () => {
    const t = setup()
    startLookupStream(PARAMS, t.handlers, t.deps)
    t.emit({ type: 'partial', entries: [{ word: 'h' }] })
    t.disconnect()
    await flush()
    expect(t.sendMessage).toHaveBeenCalledWith({ type: 'LOOKUP', ...PARAMS })
    expect(t.handlers.onDone).toHaveBeenCalledTimes(1)
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: true, entries: ENTRIES }, true)
  })

  it('falls back to the one-shot message when the port cannot be opened', async () => {
    const t = setup({ connectThrows: true })
    startLookupStream(PARAMS, t.handlers, t.deps)
    await flush()
    expect(t.sendMessage).toHaveBeenCalledWith({ type: 'LOOKUP', ...PARAMS })
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: true, entries: ENTRIES }, false)
  })

  it('reports a network error if even the fallback message fails', async () => {
    const t = setup({ connectThrows: true })
    t.sendMessage.mockRejectedValueOnce(new Error('no receiver'))
    startLookupStream(PARAMS, t.handlers, t.deps)
    await flush()
    expect(t.handlers.onDone).toHaveBeenCalledWith({ ok: false, error: 'network' }, false)
  })

  it('cancel() disconnects the port and silences every later callback and fallback', async () => {
    const t = setup()
    const cancel = startLookupStream(PARAMS, t.handlers, t.deps)
    cancel()
    expect(t.port.disconnect).toHaveBeenCalled()
    t.emit({ type: 'partial', entries: [{ word: 'h' }] })
    t.emit({ type: 'done', entries: ENTRIES })
    t.disconnect()
    await flush()
    expect(t.handlers.onPartial).not.toHaveBeenCalled()
    expect(t.handlers.onDone).not.toHaveBeenCalled()
    expect(t.sendMessage).not.toHaveBeenCalled()
  })
})
