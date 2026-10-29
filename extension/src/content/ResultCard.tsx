import type { LookupResponse } from '../shared/messages'
import { EntryView, ErrorView } from '../shared/renderEntry'
import { webAppWordUrl } from '../shared/config'
import type { LiveState } from '../shared/LiveText'

/**
 * Compact result card for the selection-icon flow (design doc §3.1).
 * Presentational only — mounting/positioning/dismiss-wiring lives in
 * `selectionListener.ts`. Reuses the same `EntryView`/`ErrorView` renderer
 * as the popup (Phase 3) and the context-menu card (Phase 4), so all three
 * surfaces render identical markup for the same `LookupResponse`.
 */
export function ResultCard({
  text,
  result,
  loading,
  live,
  onClose,
}: {
  text: string
  result: LookupResponse | null
  loading: boolean
  /** Streamed-lookup state: reveal animation + caret while the answer is written. */
  live?: LiveState
  onClose: () => void
}) {
  return (
    <div className="od-card">
      <button className="od-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {loading || !result ? (
        <div className="od-loading">Looking up “{text}”…</div>
      ) : result.ok ? (
        result.entries.length > 0 ? (
          <EntryView key={text} entry={result.entries[0]} webAppUrl={webAppWordUrl(text)} live={live} />
        ) : (
          <ErrorView error="not_found" />
        )
      ) : (
        <ErrorView error={result.error} />
      )}
    </div>
  )
}
