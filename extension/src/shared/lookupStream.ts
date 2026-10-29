import type { DictionaryEntry } from '../types'
import {
  LOOKUP_STREAM_PORT,
  type ExtensionMessage,
  type ExtensionResponse,
  type LookupResponse,
  type LookupStreamEvent,
  type LookupStreamRequest,
} from './messages'
import { shouldAnimate } from '../../../shared/liveReveal'

/**
 * Client side of streamed lookups, used by the in-page result card and the
 * popup. Opens a port to the background worker (see background/streamPort.ts)
 * and reports the answer as it is written:
 *
 *   onPartial(entries)         — 0..n times, each more complete than the last
 *   onDone(result, animate)    — exactly once; `animate` says whether the text
 *                                should be revealed progressively (a partial
 *                                arrived, or the lookup was slow) as opposed to
 *                                an instant cache hit that renders in full
 *
 * Streaming is an enhancement, never a new way to fail: if the port cannot be
 * opened, or drops before a final result (the worker restarted, an old build),
 * the lookup is repeated as the original one-shot `LOOKUP` message.
 *
 * The returned `cancel()` stops all callbacks and tells the worker to abort.
 */
export interface LookupStreamHandlers {
  onPartial: (entries: DictionaryEntry[]) => void
  onDone: (result: LookupResponse, animate: boolean) => void
}

export interface LookupStreamParams {
  text: string
  sourceLang: string
  targetLang: string
}

interface Deps {
  connect: (info: { name: string }) => chrome.runtime.Port
  sendMessage: (message: ExtensionMessage) => Promise<ExtensionResponse>
  now: () => number
}

const defaultDeps: Deps = {
  connect: (info) => chrome.runtime.connect(info),
  sendMessage: (message) => chrome.runtime.sendMessage(message),
  now: () => Date.now(),
}

export function startLookupStream(
  params: LookupStreamParams,
  handlers: LookupStreamHandlers,
  deps: Deps = defaultDeps
): () => void {
  const startedAt = deps.now()
  let cancelled = false
  let finished = false
  let sawPartial = false
  let port: chrome.runtime.Port | null = null

  const finish = (result: LookupResponse): void => {
    if (cancelled || finished) return
    finished = true
    handlers.onDone(result, result.ok && shouldAnimate(sawPartial, deps.now() - startedAt))
  }

  const fallback = (): void => {
    if (cancelled || finished) return
    deps
      .sendMessage({ type: 'LOOKUP', ...params })
      .then((res) => finish(res as LookupResponse))
      .catch(() => finish({ ok: false, error: 'network' }))
  }

  try {
    port = deps.connect({ name: LOOKUP_STREAM_PORT })
  } catch {
    fallback()
    return () => {
      cancelled = true
    }
  }

  port.onMessage.addListener((event: LookupStreamEvent) => {
    if (cancelled || finished) return
    if (event.type === 'partial') {
      sawPartial = true
      handlers.onPartial(event.entries)
    } else if (event.type === 'done') {
      finish({ ok: true, entries: event.entries })
    } else if (event.type === 'error') {
      finish({ ok: false, error: event.error })
    }
  })

  // The worker closes the port after its final event, so a disconnect with no
  // result means it went away mid-lookup: repeat the lookup the old way.
  port.onDisconnect.addListener(() => {
    // Reading lastError marks it handled and keeps Chrome from logging it.
    if (typeof chrome !== 'undefined') void chrome.runtime?.lastError
    if (!finished) fallback()
  })

  const request: LookupStreamRequest = { type: 'LOOKUP_STREAM', ...params }
  try {
    port.postMessage(request)
  } catch {
    fallback()
  }

  return () => {
    cancelled = true
    try {
      port?.disconnect()
    } catch {
      // already closed
    }
  }
}
