import { createHash } from 'crypto'
import { type Collection } from 'mongodb'
import type { DictionaryEntry } from '../translate'

/**
 * Read-through cache for dictionary/translation results, keyed by
 * (word, sourceLang, targetLang, version) — a single slot per language pair
 * *and* cache version, so any future request for the same term+langs is
 * served from Mongo without calling the LLM/dictionary again (design doc §6).
 *
 * `version` (translate.ts `CACHE_VERSION`) is a cache-key component, not just
 * metadata: bumping it changes the `_id`, so old entries become unreachable
 * cache misses instead of being silently overwritten. This is what lets a
 * prompt/schema change actually take effect instead of serving a frozen
 * pre-change entry for up to the 1-year TTL (to-do §2). Old-version docs are
 * left to TTL-expire rather than eagerly purged (cheap, no ops step needed).
 */
export interface TranslationDoc {
  _id: string
  word: string
  sourceLang: string
  targetLang: string
  entries: DictionaryEntry[]
  /** Which tier produced the cached result: 'llm' | 'dict'. */
  source: string
  /** Cache-key version component; see translate.ts `CACHE_VERSION`. */
  version: string
  fetchedAt: Date
  schemaVersion: number
}

export interface CachedTranslation {
  entries: DictionaryEntry[]
  source: string
}

export interface TranslationCache {
  get(word: string, sourceLang: string, targetLang: string, version: string): Promise<CachedTranslation | null>
  set(
    word: string,
    sourceLang: string,
    targetLang: string,
    entries: DictionaryEntry[],
    source: string,
    version: string
  ): Promise<void>
}

function docId(word: string, sourceLang: string, targetLang: string, version: string): string {
  return createHash('sha1').update(`${sourceLang}|${targetLang}|${word}|${version}`).digest('hex')
}

export function createTranslationCache(collection: Collection<TranslationDoc>): TranslationCache {
  return {
    async get(word, sourceLang, targetLang, version) {
      const doc = await collection.findOne({ _id: docId(word, sourceLang, targetLang, version) })
      if (!doc) return null
      return { entries: doc.entries, source: doc.source }
    },
    async set(word, sourceLang, targetLang, entries, source, version) {
      await collection.updateOne(
        { _id: docId(word, sourceLang, targetLang, version) },
        {
          $set: { word, sourceLang, targetLang, entries, source, version, fetchedAt: new Date() },
          $setOnInsert: { schemaVersion: 1 },
        },
        { upsert: true }
      )
    },
  }
}
