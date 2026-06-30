import { createHash } from 'crypto'
import { type Collection } from 'mongodb'
import type { DictionaryEntry } from '../translate'

/**
 * Read-through cache for dictionary/translation results, keyed by
 * (word, sourceLang, targetLang) — a single slot per language pair, so any
 * future request for the same term+langs is served from Mongo without calling
 * the LLM/dictionary again (design doc §6).
 */
export interface TranslationDoc {
  _id: string
  word: string
  sourceLang: string
  targetLang: string
  entries: DictionaryEntry[]
  /** Which tier produced the cached result: 'llm' | 'dict'. */
  source: string
  fetchedAt: Date
  schemaVersion: number
}

export interface CachedTranslation {
  entries: DictionaryEntry[]
  source: string
}

export interface TranslationCache {
  get(word: string, sourceLang: string, targetLang: string): Promise<CachedTranslation | null>
  set(word: string, sourceLang: string, targetLang: string, entries: DictionaryEntry[], source: string): Promise<void>
}

function docId(word: string, sourceLang: string, targetLang: string): string {
  return createHash('sha1').update(`${sourceLang}|${targetLang}|${word}`).digest('hex')
}

export function createTranslationCache(collection: Collection<TranslationDoc>): TranslationCache {
  return {
    async get(word, sourceLang, targetLang) {
      const doc = await collection.findOne({ word, sourceLang, targetLang })
      if (!doc) return null
      return { entries: doc.entries, source: doc.source }
    },
    async set(word, sourceLang, targetLang, entries, source) {
      await collection.updateOne(
        { _id: docId(word, sourceLang, targetLang) },
        {
          $set: { word, sourceLang, targetLang, entries, source, fetchedAt: new Date() },
          $setOnInsert: { schemaVersion: 1 },
        },
        { upsert: true }
      )
    },
  }
}
