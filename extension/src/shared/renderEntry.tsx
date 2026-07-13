import type { DictionaryEntry } from '../types'

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
 */
export function EntryView({
  entry,
  webAppUrl,
  isFavorite,
  onToggleFavorite,
}: {
  entry: DictionaryEntry
  webAppUrl: string
  isFavorite?: boolean
  onToggleFavorite?: () => void
}) {
  const meanings = entry.meanings ?? []
  return (
    <div className="od-entry">
      <div className="od-head">
        <span className="od-word">{entry.word}</span>
        {entry.phonetic && <span className="od-phonetic">{entry.phonetic}</span>}
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
      {entry.translation && <div className="od-translation">{entry.translation}</div>}
      {meanings.slice(0, 4).map((meaning, i) => (
        <div key={i} className="od-meaning">
          <div className="od-pos">{meaning.partOfSpeech}</div>
          {meaning.definitions.slice(0, 3).map((def, j) => (
            <div key={j} className="od-def">
              {def.cefr && <span className="od-cefr">{def.cefr}</span>} {def.definition}
            </div>
          ))}
        </div>
      ))}
      <a className="od-link" href={webAppUrl} target="_blank" rel="noopener noreferrer">
        See full entry →
      </a>
    </div>
  )
}

export function ErrorView({ error }: { error: string }) {
  return <div className="od-error">{ERROR_MESSAGES[error] ?? 'Something went wrong.'}</div>
}
