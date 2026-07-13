/**
 * Floating icon shown near a text selection (design doc §3.1). Pure
 * presentational component — positioning is handled by the caller via
 * inline styles on the wrapping host element (`selectionListener.ts`).
 */
export function SelectionIcon({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="od-icon-btn"
      onClick={onClick}
      aria-label="Look up in Open Dictionary"
      title="Look up in Open Dictionary"
    >
      📖
    </button>
  )
}
