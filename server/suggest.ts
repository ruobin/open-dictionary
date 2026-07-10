import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { LANGUAGES } from '../shared/languages'
import { SUGGEST_RATE_LIMIT_RPM } from './config'

/**
 * Autocomplete/typeahead (to-do §6). Public, unauthenticated, no LLM call —
 * a prefix scan over words already sitting in the translation cache
 * (`server/db.ts` `translations_suggest` index). Cheap and instant, but only
 * as good as the cache: a word nobody has looked up yet won't suggest.
 */
const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))
const MAX_QUERY_LENGTH = 64
const MAX_SUGGESTIONS = 8

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

      const col = getMongoDb()?.collection<{ word: string; sourceLang: string }>('translations')
      if (!col) {
        res.json([])
        return
      }

      const words = await col.distinct('word', {
        sourceLang: lang,
        word: { $regex: `^${escapeRegex(q)}` },
      })
      words.sort((a, b) => a.length - b.length || a.localeCompare(b))
      res.json(words.slice(0, MAX_SUGGESTIONS))
    } catch (err) {
      next(err)
    }
  })

  return router
}
