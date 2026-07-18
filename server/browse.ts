import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { CACHE_VERSION, type DictionaryEntry } from './translate'
import type { TranslationDoc } from './cache/translationCache'
import { bucketLetter, paginate, WORDS_PER_BROWSE_PAGE } from '../shared/browse'
import { BROWSE_RATE_LIMIT_RPM } from './config'

/**
 * Live "browse alphabetically" data. Backs the client-side `/browse/:letter`
 * route (src/pages/BrowsePage.tsx): once the JS bundle takes over from the
 * statically prerendered HTML (main.tsx uses `createRoot`, not `hydrateRoot`
 * — see scripts/render.ts's doc comment on `injectPage`), React Router needs
 * a real route + data source for that path or the page goes blank. No LLM
 * call — only words already sitting in the en→en cache are ever listed, same
 * "browse traffic never costs money" principle as scripts/prerender.ts and
 * server/wordOfDay.ts.
 */

const LETTER_PATTERN = /^([a-z]|other)$/

export interface BrowsePageResult {
  letter: string
  /** All letters with at least one eligible word, for the nav strip. */
  letters: string[]
  words: string[]
  page: number
  totalPages: number
}

/** Words with '/' (or similar) would be unsafe to link to /word/<word> or
 *  could escape an intended path; skip them defensively — real dictionary
 *  headwords essentially never contain these (mirrors
 *  scripts/prerender.ts's isSafeWord). */
function isSafeWord(word: string): boolean {
  return word.length > 0 && !/[/\\]|^\.\.?$/.test(word)
}

function eligibleWord(entry: DictionaryEntry | undefined): string | null {
  if (!entry || entry.typo || !entry.meanings.length || !isSafeWord(entry.word)) return null
  return entry.word
}

/** Reads the whole en→en cache (LLM + dictionary-fallback tiers) once and
 *  derives both the full nav-strip letter list and the requested letter's
 *  sorted/paginated word list.
 *  Returns null for a malformed `letter` param. */
export async function getBrowsePage(
  docs: Pick<TranslationDoc, 'entries'>[],
  letter: string,
  page: number
): Promise<BrowsePageResult | null> {
  if (!LETTER_PATTERN.test(letter)) return null

  const wordsByLetter = new Map<string, string[]>()
  for (const doc of docs) {
    const word = eligibleWord(doc.entries[0])
    if (!word) continue
    const bucket = bucketLetter(word)
    const list = wordsByLetter.get(bucket) ?? []
    list.push(word)
    wordsByLetter.set(bucket, list)
  }

  const letters = [...wordsByLetter.keys()].sort()
  const words = (wordsByLetter.get(letter) ?? []).sort((a, b) => a.localeCompare(b))
  const pages = paginate(words, WORDS_PER_BROWSE_PAGE)
  const totalPages = pages.length
  const clampedPage = Math.min(Math.max(page, 1), totalPages)

  return { letter, letters, words: pages[clampedPage - 1] ?? [], page: clampedPage, totalPages }
}

const browseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: BROWSE_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function createBrowseRouter(): Router {
  const router = Router()

  router.get('/browse/:letter', browseLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const letter = req.params.letter.toLowerCase()
      const pageRaw = parseInt(typeof req.query.page === 'string' ? req.query.page : '1', 10)
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1

      const db = getMongoDb()
      if (!db) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const docs = await db
        .collection<TranslationDoc>('translations')
        .find(
          { sourceLang: 'en', targetLang: 'en', source: { $in: ['llm', 'dict'] }, version: CACHE_VERSION },
          { projection: { entries: 1 } }
        )
        .toArray()

      const result = await getBrowsePage(docs, letter, page)
      if (!result) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  return router
}
