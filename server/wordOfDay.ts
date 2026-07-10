import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { CACHE_VERSION, type DictionaryEntry } from './translate'
import type { TranslationDoc } from './cache/translationCache'
import { WORD_OF_DAY_RATE_LIMIT_RPM } from './config'

/**
 * Word of the day (to-do §8): a random already-cached en→en word, persisted
 * per UTC date so every visitor sees the same word all day and repeat
 * requests don't reshuffle it. No LLM call — picked only from words already
 * sitting in the cache, same "never cost more just because someone looked"
 * principle as the SEO prerender (scripts/prerender.ts).
 */
interface WordOfDayDoc {
  _id: string
  word: string
  computedAt: Date
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function isEligible(doc: TranslationDoc): boolean {
  const entry: DictionaryEntry | undefined = doc.entries[0]
  return Boolean(entry && !entry.typo && entry.meanings.length > 0)
}

/** Exported for the eval harness / manual testing; not otherwise called directly. */
export async function pickWordOfDay(): Promise<string | null> {
  const db = getMongoDb()
  if (!db) return null

  const dateKey = todayKey()
  const col = db.collection<WordOfDayDoc>('word_of_day')
  const existing = await col.findOne({ _id: dateKey })
  if (existing) return existing.word

  const docs = await db
    .collection<TranslationDoc>('translations')
    .find({ sourceLang: 'en', targetLang: 'en', source: 'llm', version: CACHE_VERSION })
    .toArray()
  const eligible = docs.filter(isEligible).map((d) => d.word)
  if (eligible.length === 0) return null

  const candidate = eligible[Math.floor(Math.random() * eligible.length)]
  // $setOnInsert + re-read: if two requests race on the first lookup of the
  // day, only the first write sticks, and both requests return that value.
  await col.updateOne(
    { _id: dateKey },
    { $setOnInsert: { word: candidate, computedAt: new Date() } },
    { upsert: true }
  )
  const final = await col.findOne({ _id: dateKey })
  return final?.word ?? candidate
}

const wordOfDayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: WORD_OF_DAY_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function createWordOfDayRouter(): Router {
  const router = Router()

  router.get('/word-of-day', wordOfDayLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const word = await pickWordOfDay()
      if (!word) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.json({ word })
    } catch (err) {
      next(err)
    }
  })

  return router
}
