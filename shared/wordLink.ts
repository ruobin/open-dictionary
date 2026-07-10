/**
 * Builds the /word/:term link target for a collocation/word-family chip
 * (src/components/WordEntry.tsx, scripts/render.ts).
 *
 * The LLM is instructed to return bare, look-up-able terms (see
 * server/providers/llm/openaiCompat.ts buildMessages), but strips a trailing
 * parenthetical annotation defensively — e.g. "runner (noun)" -> "runner" —
 * since prompt compliance isn't guaranteed and a stray "(noun)" would
 * otherwise become part of the lookup query. The annotation is still shown
 * in the chip's display text; only the link target is cleaned.
 */
export function cleanLinkTerm(term: string): string {
  return term.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

export function wordHref(term: string): string {
  return `/word/${encodeURIComponent(cleanLinkTerm(term).toLowerCase())}`
}
