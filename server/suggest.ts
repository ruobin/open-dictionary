import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { LANGUAGES } from '../shared/languages'
import { isListableTerm } from '../shared/term'
import { SUGGEST_RATE_LIMIT_RPM } from './config'
import { escapeRegex } from './util/regex'
import type { TranslationDoc } from './cache/translationCache'

/**
 * Autocomplete/typeahead (to-do §6). Public, unauthenticated, no LLM call —
 * a prefix scan over words already sitting in the translation cache
 * (`server/db.ts` `translations_suggest` index). Cheap and instant, but only
 * as good as the cache: a word nobody has looked up yet won't suggest.
 *
 * The cache holds whatever anyone typed into the search box, so this route
 * would otherwise let a visitor enumerate other people's lookups by prefix.
 * Two filters decide what is suggested: the entry must be a real answer (not
 * a typo verdict or an empty result), and the term must look like a headword
 * or short phrase (`isListableTerm`).
 */
const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))
const MAX_QUERY_LENGTH = 64
const MAX_SUGGESTIONS = 8

export { escapeRegex }

/** Mongo filter for "the cached entry is a real answer": the same test
 *  browse.ts and scripts/render.ts apply to the first entry in code. */
const REAL_ENTRY = { 'entries.0.typo': { $exists: false }, 'entries.0.meanings.0': { $exists: true } }

/** The suggestions shown for a set of matching cached terms: listable ones
 *  only, shortest first, capped. */
export function pickSuggestions(words: string[]): string[] {
  return words
    .filter(isListableTerm)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_SUGGESTIONS)
}

const suggestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: SUGGEST_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function createSuggestRouter(): Router {
  const router = Router()

  router.get('/suggest', suggestLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const qRaw = typeof req.query.q === 'string' ? req.query.q : ''
      const q = qRaw.trim().toLowerCase().slice(0, MAX_QUERY_LENGTH)
      if (!q) {
        res.json([])
        return
      }

      const langRaw = typeof req.query.lang === 'string' ? req.query.lang.trim().toLowerCase() : 'en'
      const lang = LANGUAGE_CODES.has(langRaw) ? langRaw : 'en'

      const col = getMongoDb()?.collection<TranslationDoc>('translations')
      if (!col) {
        res.json([])
        return
      }

      const words = await col.distinct('word', {
        sourceLang: lang,
        word: { $regex: `^${escapeRegex(q)}` },
        ...REAL_ENTRY,
      })
      res.json(pickSuggestions(words))
    } catch (err) {
      next(err)
    }
  })

  return router
}
