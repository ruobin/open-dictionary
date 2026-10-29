import type { LookupResponse, LookupStreamEvent, LookupStreamRequest } from '../shared/messages'
import { LOOKUP_STREAM_PORT } from '../shared/messages'
import { lookupWordStream, type StreamLookupOptions } from './lookupClient'
import { addHistory } from './historyClient'

/**
 * Background side of streamed lookups. A content script or the popup opens a
 * `chrome.runtime.connect({ name: 'lookup-stream' })` port and posts one
 * `LOOKUP_STREAM` request; this relays the lookup's partial snapshots and its
 * final result back over the port. Unlike a one-shot `sendMessage`, a port can
 * carry many messages — that is what lets the page show the answer while it is
 * still being written.
 *
 * If the client goes away (card dismissed, popup closed) the port disconnects
 * and the in-flight fetch is aborted.
 */
export function handleLookupStreamPort(
  port: chrome.runtime.Port,
  lookup: (
    text: string,
    sourceLang: string,
    targetLang: string,
    options: StreamLookupOptions
  ) => Promise<LookupResponse> = lookupWordStream,
  recordHistory: typeof addHistory = addHistory
): void {
  if (port.name !== LOOKUP_STREAM_PORT) return

  const controller = new AbortController()
  let open = true
  port.onDisconnect.addListener(() => {
    open = false
    controller.abort()
  })

  const send = (event: LookupStreamEvent): void => {
    if (!open) return
    try {
      port.postMessage(event)
    } catch {
      open = false // the other end vanished between the check and the post
      controller.abort()
    }
  }

  let started = false
  port.onMessage.addListener((message: LookupStreamRequest) => {
    if (started || message?.type !== 'LOOKUP_STREAM') return
    started = true
    const { text, sourceLang, targetLang } = message

    void lookup(text, sourceLang, targetLang, {
      signal: controller.signal,
      onPartial: (entries) => send({ type: 'partial', entries }),
    })
      .then((result) => {
        if (result.ok) {
          void recordHistory({ word: text.trim().toLowerCase(), sourceLang, targetLang })
          send({ type: 'done', entries: result.entries })
        } else {
          send({ type: 'error', error: result.error })
        }
      })
      .catch(() => send({ type: 'error', error: 'api_error' }))
      .finally(() => {
        if (open) {
          open = false
          try {
            port.disconnect()
          } catch {
            // already gone
          }
        }
      })
  })
}
