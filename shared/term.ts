import { MAX_LOOKUP_TEXT_LENGTH } from './limits'

/**
 * A lookup "term" is the text a user asked about, in the one canonical form
 * the rest of the system keys on: cache `_id`, `/word/<term>` URLs, prerender
 * paths, history and favorites. Kept in `shared/` so the server, the prerender
 * script and their tests agree on that form without importing server code.
 */

/** Canonical form of a looked-up term: trimmed, lowercased, NFC, single spaces,
 *  no control characters, at most {@link MAX_LOOKUP_TEXT_LENGTH} characters. */
export function normalizeTerm(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '') // strip non-whitespace control chars (log/cache integrity)
    .slice(0, MAX_LOOKUP_TEXT_LENGTH)
}

/**
 * True when `headword` is the looked-up `term` apart from case, spacing and
 * Unicode form ("Paris" for "paris"). An LLM echoes the term back as the
 * entry's headword; anything else it puts there must not be trusted as the
 * entry's identity (see `withQueryHeadword` in server/translate.ts).
 */
export function sameTerm(headword: string | undefined, term: string): boolean {
  return typeof headword === 'string' && normalizeTerm(headword) === term
}

/** A path segment on most filesystems is limited to 255 bytes; stay well under. */
const MAX_PATH_SEGMENT_BYTES = 200

/**
 * Whether a term may become a `/word/<term>` link or a prerendered
 * `word/<term>/index.html` file: non-empty, no path separators, not `.`/`..`,
 * and short enough to be a directory name. Real dictionary headwords
 * essentially always pass; this keeps one odd cache entry from producing an
 * unsafe path or failing the whole prerender run.
 */
export function isPublishableTerm(term: string): boolean {
  if (term.length === 0 || /[/\\]|^\.\.?$/.test(term)) return false
  return new TextEncoder().encode(term).length <= MAX_PATH_SEGMENT_BYTES
}
