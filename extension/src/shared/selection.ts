/**
 * Pure helpers for the "should we show the lookup icon for this selection"
 * decision (design doc §3.1: "ignores empty/huge selections"). Kept
 * DOM-free so they're trivially unit-testable (Phase 8) independent of a
 * real `Selection` object.
 */

/** Max selection length that triggers the floating lookup icon. Well under
 *  the server's own 256-char cap (`server/translate.ts`'s
 *  `MAX_TEXT_LENGTH`) — a fixed-position icon next to a multi-paragraph
 *  selection isn't a useful "look up a word/phrase" affordance anyway. */
export const MAX_SELECTION_LENGTH = 200

/** Normalizes raw `Selection.toString()` output for the trigger check —
 *  trim only. Case/whitespace-collapsing is the server's job
 *  (`normalizeText` in `server/translate.ts`), same division of labor the
 *  popup's manual search box already relies on. */
export function normalizeSelectionText(raw: string): string {
  return raw.trim()
}

/** Whether a normalized selection is worth showing the lookup icon for:
 *  non-empty, not absurdly long. */
export function isLookupableSelection(text: string): boolean {
  return text.length > 0 && text.length <= MAX_SELECTION_LENGTH
}
