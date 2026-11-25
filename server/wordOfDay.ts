import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { CACHE_VERSION, type DictionaryEntry } from './translate'
import type { TranslationDoc } from './cache/translationCache'
import { isListableTerm } from '../shared/term'
import { WORD_OF_DAY_RATE_LIMIT_RPM } from './config'

/**
 * Word of the day (to-do §8): a random already-cached en→en word, persisted
 * per UTC date so every visitor sees the same word all day and repeat
 * requests don't reshuffle it. No LLM call — picked only from words already
 * sitting in the cache, same "never cost more just because someone looked"
 * principle as the SEO prerender (scripts/prerender.ts).
 *
 * This is the one place a cached term is pushed to every visitor's home page
 * without them asking, so the bar is higher than for browse pages: a single
 * word in Latin letters (`isWordOfDayTerm`), with no open report against it.
 */
interface WordOfDayDoc {
  _id: string
  word: string
  computedAt: Date
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** One word: Latin letters, optionally joined by hyphens or apostrophes
 *  ("well-being", "o'clock"). No phrases, digits or other scripts. */
const SINGLE_LATIN_WORD = /^\p{Script=Latin}+(?:[-'’]\p{Script=Latin}+)*$/u

export function isWordOfDayTerm(term: string): boolean {
  return isListableTerm(term) && SINGLE_LATIN_WORD.test(term)
}

export function isEligible(doc: Pick<TranslationDoc, 'word' | 'entries'>): boolean {
  const entry: DictionaryEntry | undefined = doc.entries[0]
  return Boolean(entry && !entry.typo && entry.meanings.length > 0) && isWordOfDayTerm(doc.word)
}

/** The words today's pick is drawn from: eligible entries, minus any word a
 *  visitor has reported and the admin has not yet reviewed. */
export function wordOfDayCandidates(
  docs: Pick<TranslationDoc, 'word' | 'entries'>[],
  reportedWords: Iterable<string>
): string[] {
  const reported = new Set(reportedWords)
  return docs.filter(isEligible).map((d) => d.word).filter((word) => !reported.has(word))
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
  // A report stays in `reports` until the admin dismisses it or deletes the entry.
  const reportedWords = await db
    .collection<{ word: string }>('reports')
    .distinct('word', { sourceLang: 'en', targetLang: 'en' })
  const eligible = wordOfDayCandidates(docs, reportedWords)
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
