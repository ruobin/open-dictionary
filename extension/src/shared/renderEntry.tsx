import { useEffect, useRef, useState } from 'react'
import type { DictionaryEntry, Phonetic } from '../types'
import type { ExtensionMessage, ExtensionResponse } from './messages'
import { LiveProvider, LiveText, StreamCaret, type LiveState } from './LiveText'

/** Human-readable copy for each `ExtensionErrorCode`. Shared so the popup
 *  and any future in-page surfaces show identical error copy. */
const ERROR_MESSAGES: Record<string, string> = {
  not_found: 'No entry found.',
  timeout: 'Lookup timed out. Try again.',
  network: 'Network error. Check your connection.',
  api_error: 'Something went wrong.',
  rate_limited: 'Too many lookups — try again in a minute.',
  unauthorized: 'Sign in to use this feature.',
  auth_failed: 'Sign-in didn\u2019t complete. Try again.',
}

type PhoneticWithAudio = Phonetic & { audio: string }

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
}

/** True on extension pages (popup, options), whose `<audio>` is governed only by
 *  the extension's own CSP. In a content script (the in-page card) `location`
 *  is the HOST PAGE's, and so is the CSP — see `playViaWorker`. */
export function isExtensionPage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'chrome-extension:'
}

/** Asks the background worker to play the clip in an offscreen document, which
 *  host-page CSPs (`media-src`) can't block. */
async function playViaWorker(src: string): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage({ type: 'PLAY_AUDIO', src } satisfies ExtensionMessage)
}

/**
 * Small "▶" icon button that plays a single pronunciation audio clip.
 * Same reset-to-start behavior as the main web app's `AudioButton`
 * (src/components/AudioButton.tsx), but failures are NOT swallowed: they are
 * logged (`[open-dictionary] audio ...`) and the button shows an
 * "unavailable" state. A later click retries.
 *
 * Playback path depends on where this renders:
 *  - extension page (popup): a local `<audio>` element.
 *  - in-page card (content script): no `<audio>` at all — a page-hosted element
 *    would be blocked by strict host-page CSPs, so the worker plays it.
 */
function AudioButton({ label, src }: { label: string; src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [failed, setFailed] = useState(false)
  const viaWorker = !isExtensionPage()

  // A new clip gets a fresh chance.
  useEffect(() => setFailed(false), [src])

  function fail(reason: string, detail?: unknown) {
    console.warn(`[open-dictionary] audio ${label} failed: ${reason}`, { src, detail })
    setFailed(true)
  }

  async function play() {
    setFailed(false)
    if (viaWorker) {
      try {
        const res = await playViaWorker(src)
        if (!res?.ok) fail('worker could not play the clip')
      } catch (err) {
        fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      }
      return
    }
    const el = audioRef.current
    if (!el) return
    try {
      // A media element stays in its error state until reloaded, so retry explicitly.
      if (el.error) el.load()
      el.currentTime = 0
      await el.play()
    } catch (err) {
      // AbortError = a newer load()/pause() superseded this play(); not a real failure.
      if (err instanceof DOMException && err.name === 'AbortError') return
      // A media-element error was already reported by `handleError`; don't double-log.
      if (audioRef.current?.error) return
      fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }

  function handleError() {
    const code = audioRef.current?.error?.code ?? 0
    fail(MEDIA_ERROR_NAMES[code] ?? 'unknown media error', audioRef.current?.error?.message)
  }

  return (
    <button
      type="button"
      className={failed ? 'od-audio-btn od-audio-btn--error' : 'od-audio-btn'}
      onClick={() => void play()}
      aria-label={failed ? `${label} pronunciation unavailable` : `Play ${label} pronunciation`}
      title={failed ? 'Audio unavailable — click to retry' : undefined}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
        {failed ? <path d="M12 2L1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z" /> : <path d="M8 5v14l11-7z" />}
      </svg>
      <span>{label}</span>
      {!viaWorker && (
        // keyed by src so a changed clip remounts instead of mutating a possibly-playing element.
        // preload="none": nothing is fetched until the user clicks.
        <audio key={src} ref={audioRef} src={src} preload="none" onError={handleError} />
      )}
    </button>
  )
}

/** Picks up to one UK clip, one US clip, and (only when neither is present)
 *  one generic fallback clip — same heuristic as the web app's
 *  `pickAudio` in `WordEntry.tsx`, kept in sync deliberately. */
function pickAudio(phonetics: Phonetic[]): {
  uk: PhoneticWithAudio | undefined
  us: PhoneticWithAudio | undefined
  fallback: PhoneticWithAudio | undefined
} {
  const withAudio = phonetics.filter((p): p is PhoneticWithAudio => Boolean(p.audio))
  const uk = withAudio.find((p) => /-uk\.|\/uk\//i.test(p.audio))
  const us = withAudio.find((p) => /-us\.|\/us\//i.test(p.audio))
  const fallback = !uk && !us ? withAudio[0] : undefined
  return { uk, us, fallback }
}

/**
 * Compact `DictionaryEntry` renderer — the "result card" shared by the
 * toolbar popup (Phase 3) and, later, the in-page result card (Phase 5).
 * Renders only via JSX/text nodes (React escapes everything) — no
 * `dangerouslySetInnerHTML`, matching the main web app's XSS-safety posture
 * (docs/security.md).
 *
 * `isFavorite`/`onToggleFavorite` are optional (Phase 9): when omitted, no
 * favorite star is shown at all — used by any caller that hasn't loaded
 * auth state yet, keeping this component usable before Phase 9 wiring
 * existed and in anonymous-signed-out contexts.
 *
 * `live` (streamed lookups): when `live.animate` is set the translation and
 * definitions are revealed progressively, and `live.streaming` shows a caret
 * while the answer is still being written. Omit it for a plain static render.
 * Pass the SAME element position/instance from partial through done (and a
 * `key` that changes with the word) so the reveal carries on instead of
 * restarting.
 */
export function EntryView({
  entry,
  webAppUrl,
  isFavorite,
  onToggleFavorite,
  live = { animate: false, streaming: false },
}: {
  entry: DictionaryEntry
  webAppUrl: string
  isFavorite?: boolean
  onToggleFavorite?: () => void
  live?: LiveState
}) {
  const meanings = entry.meanings ?? []
  const { uk, us, fallback } = pickAudio(entry.phonetics ?? [])
  return (
    <LiveProvider value={live}>
      <div className="od-entry">
        <div className="od-head">
          <span className="od-word">{entry.word}</span>
          {entry.phonetic && <span className="od-phonetic">{entry.phonetic}</span>}
          {(uk || us || fallback) && (
            <span className="od-audio-row">
              {uk && <AudioButton label="UK" src={uk.audio} />}
              {us && <AudioButton label="US" src={us.audio} />}
              {fallback && <AudioButton label="Play" src={fallback.audio} />}
            </span>
          )}
          {onToggleFavorite && (
            <button
              type="button"
              className="od-fav-btn"
              aria-label={isFavorite ? 'Remove favorite' : 'Add favorite'}
              aria-pressed={isFavorite}
              onClick={onToggleFavorite}
            >
              {isFavorite ? '★' : '☆'}
            </button>
          )}
        </div>
        {entry.translation && (
          <div className="od-translation">
            <LiveText text={entry.translation} />
          </div>
        )}
        {meanings.slice(0, 4).map((meaning, i) => (
          <div key={i} className="od-meaning">
            <div className="od-pos">{meaning.partOfSpeech}</div>
            {meaning.definitions.slice(0, 3).map((def, j) => (
              <div key={j} className="od-def">
                {def.cefr && <span className="od-cefr">{def.cefr}</span>} <LiveText text={def.definition} />
              </div>
            ))}
          </div>
        ))}
        {live.streaming && (
          <div className="od-pending">
            <StreamCaret />
          </div>
        )}
        <a className="od-link" href={webAppUrl} target="_blank" rel="noopener noreferrer">
          See full entry →
        </a>
      </div>
    </LiveProvider>
  )
}

export function ErrorView({ error }: { error: string }) {
  return <div className="od-error">{ERROR_MESSAGES[error] ?? 'Something went wrong.'}</div>
}
