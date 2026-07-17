/**
 * Shared length limits, imported by both the server and the frontend so they
 * can never drift. The lookup-text cap is the contract between the SearchBar
 * input and {@link MAX_LOOKUP_TEXT_LENGTH} enforcement in
 * `server/translate.ts` — keep them identical.
 */

/**
 * Maximum number of characters accepted for a dictionary lookup
 * (the `/api/translate/:text` path param). The server truncates silently at
 * this length; the SearchBar mirrors it as the input's `maxLength` so a user
 * can't type/paste something the backend would then chop without feedback.
 *
 * 256 is generous for a dictionary headword or multi-word idiom (the longest
 * real idioms are ~60 chars) while bounding cache cardinality and LLM token
 * spend. Change in one place and both sides follow.
 */
export const MAX_LOOKUP_TEXT_LENGTH = 256
