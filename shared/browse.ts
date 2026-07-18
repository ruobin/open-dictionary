/**
 * Pure alphabetical-bucketing/pagination helpers for the browse feature.
 * Shared between scripts/render.ts (static SEO prerender, scripts/prerender.ts)
 * and server/browse.ts (live JSON API backing the client-side /browse/:letter
 * route, src/pages/BrowsePage.tsx) so both surfaces bucket/paginate words
 * identically.
 */
export const WORDS_PER_BROWSE_PAGE = 200

/** First-letter bucket for the alphabetical browse pages: 'a'-'z', or
 *  'other' for anything not starting with a plain ASCII letter. */
export function bucketLetter(word: string): string {
  const c = word.trim().toLowerCase().charAt(0)
  return /[a-z]/.test(c) ? c : 'other'
}

/** Splits a sorted list into fixed-size pages (page 1 first). */
export function paginate<T>(items: T[], pageSize: number): T[][] {
  if (items.length === 0) return [[]]
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += pageSize) {
    pages.push(items.slice(i, i + pageSize))
  }
  return pages
}
