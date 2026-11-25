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
 * Whether a term is safe to use as a path segment (`word/<term>/index.html`):
 * non-empty, no path separators, not `.`/`..`, and short enough to be a
 * directory name. This is only about the filesystem; whether the term should
 * be shown to other people is {@link isListableTerm}.
 */
export function isPublishableTerm(term: string): boolean {
  if (term.length === 0 || /[/\\]|^\.\.?$/.test(term)) return false
  return new TextEncoder().encode(term).length <= MAX_PATH_SEGMENT_BYTES
}

/** Limits on a term that is listed publicly. Chosen from the live corpus: the
 *  longest real collocation was 8 words / 47 characters. */
export const MAX_LISTED_TERM_LENGTH = 64
export const MAX_LISTED_TERM_WORDS = 8
/** "catch-22", "covid-19", "1984" pass; phone, card and account numbers do not. */
const MAX_LISTED_TERM_DIGITS = 4
/** Chinese, Japanese and Thai are written without spaces, so the word limit
 *  cannot tell a headword from a sentence there; cap the characters instead. */
const MAX_UNSPACED_TERM_LENGTH = 16

/** Letters and combining marks of any script, digits, spaces, hyphens/dashes,
 *  apostrophes, and the little punctuation real headwords use ("e.g.",
 *  "easy come, easy go", "r&d"). Leaves out `@ : / + < > # = ?` and the rest. */
const LISTED_CHARS = /^[\p{L}\p{M}\p{Nd} \p{Pd}'’.,&]+$/u
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u
/** A dot inside a word is an abbreviation ("u.s.", "ph.d") only when the pieces
 *  around it are short; "example.com" and "first.last" are not. */
const DOT_IN_LONG_WORD = /[\p{L}\p{Nd}]{3,}\.[\p{L}\p{Nd}]|[\p{L}\p{Nd}]\.[\p{L}\p{Nd}]{3,}/u

/**
 * Whether a looked-up term may be shown to people who did not look it up:
 * autocomplete, browse pages, prerendered word pages, the sitemap and word of
 * the day. Anyone can type anything into the search box and the result is
 * cached under that text, so without this check a pasted sentence, an email
 * address or a phone number would end up listed on the public site.
 *
 * It only asks "does this look like a dictionary headword or short phrase?".
 * It does not judge meaning, so a short phrase made of ordinary words still
 * passes. A term that fails is not blocked: its lookup and `/word/<term>` page
 * work as before, it just is not advertised.
 */
export function isListableTerm(term: string): boolean {
  if (!isPublishableTerm(term)) return false
  if (!LISTED_CHARS.test(term) || !/\p{L}/u.test(term)) return false
  const length = [...term].length
  if (length > MAX_LISTED_TERM_LENGTH) return false
  if (UNSPACED_SCRIPT.test(term) && length > MAX_UNSPACED_TERM_LENGTH) return false
  if (term.split(' ').length > MAX_LISTED_TERM_WORDS) return false
  if ((term.match(/\p{Nd}/gu) ?? []).length > MAX_LISTED_TERM_DIGITS) return false
  return !DOT_IN_LONG_WORD.test(term)
}
