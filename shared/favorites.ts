/** Identity of a favorited lookup. A favorite is scoped to a word AND its
 *  language pair (not just a bare word), per the cache-keying requirement. */
export interface FavoriteKey {
  word: string
  sourceLang: string
  targetLang: string
}
