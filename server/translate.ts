import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import type { LlmDefinition, LlmProvider, LlmTranslationContent } from './providers/llm'
import type { DictionaryProvider } from './providers/dictionary'
import type { TranslationCache } from './cache/translationCache'
import { TRANSLATE_RATE_LIMIT_RPM } from './config'

/**
 * HTTP response shape. Mirrors the frontend `DictionaryEntry`
 * (src/api/dictionary.ts) so the existing UI renders both tiers unchanged —
 * the client already casts the JSON to `DictionaryEntry[]`. The Mongo cache
 * stores this same shape under `entries`.
 */
interface Phonetic {
  text?: string
  audio?: string
}
interface Definition {
  definition: string
  example?: string
}
interface Meaning {
  partOfSpeech: string
  definitions: Definition[]
}
export interface DictionaryEntry {
  word: string
  phonetic?: string
  phonetics: Phonetic[]
  meanings: Meaning[]
  sourceUrls?: string[]
}

interface TranslateRequest {
  text: string
  sourceLang: string
  targetLang: string
}

export interface TranslateOutcome {
  entries: DictionaryEntry[]
  tier: 'cache' | 'llm' | 'dictionary'
}

const MAX_TEXT_LENGTH = 256

const LLM_DEBUG = /^(1|true|yes|on)$/i.test(process.env.LLM_DEBUG ?? '')

export const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: TRANSLATE_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function normalizeText(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFC').replace(/\s+/g, ' ').slice(0, MAX_TEXT_LENGTH)
}

/** Maps the LLM's structured content into the dictionary-entry render shape. */
export function adaptLlm(content: LlmTranslationContent): DictionaryEntry[] {
  const meanings: Meaning[] = []
  if (Array.isArray(content.meanings) && content.meanings.length > 0) {
    meanings.push({
      partOfSpeech: content.partOfSpeech || '',
      definitions: content.meanings.map((m: LlmDefinition) => ({
        definition: m.definition,
        ...(m.example ? { example: m.example } : {}),
      })),
    })
  }

  const phonetics: Phonetic[] = content.phonetic ? [{ text: content.phonetic }] : []

  const entry: DictionaryEntry = {
    word: content.headword || '',
    phonetics,
    meanings,
  }
  if (content.phonetic) entry.phonetic = content.phonetic

  // NOTE: content.translation and content.examples are produced by the LLM but
  // have no slot in the current dictionary UI; they'll be surfaced when the UI
  // is extended for translations (separate task).
  return [entry]
}

async function cacheSetSafe(
  cache: TranslationCache | null | undefined,
  req: TranslateRequest,
  entries: DictionaryEntry[],
  source: string
): Promise<void> {
  if (!cache) return
  try {
    await cache.set(req.text, req.sourceLang, req.targetLang, entries, source)
  } catch (err) {
    console.warn('[cache] write failed (non-fatal):', err)
  }
}

/** Best-effort: fetch audio URLs from the Free Dictionary API and merge into the
 *  LLM-produced entries. Only attempts for English source words (the dict API is
 *  English-only). Failures are silently ignored — the entry just has no audio.
 *  The merged result is cached so future lookups include the audio. */
async function mergeAudioFromDictionary(
  req: TranslateRequest,
  entries: DictionaryEntry[],
  dictionary: DictionaryProvider
): Promise<DictionaryEntry[]> {
  if (req.sourceLang.toLowerCase() !== 'en') return entries
  try {
    const raw = await dictionary.define({ text: req.text, sourceLang: req.sourceLang })
    if (!Array.isArray(raw) || raw.length === 0) return entries
    const dictPhonetics = (raw[0] as DictionaryEntry)?.phonetics ?? []
    const audioPhonetics = dictPhonetics.filter((p) => Boolean(p.audio))
    if (audioPhonetics.length === 0) return entries
    return entries.map((entry, i) =>
      i === 0
        ? { ...entry, phonetics: [...(entry.phonetics ?? []), ...audioPhonetics] }
        : entry
    )
  } catch {
    return entries
  }
}

/**
 * Read-through, tiered lookup: Mongo cache → LLM (primary) → dictionary
 * (fallback only on LLM failure/absence). Results are cached keyed by
 * (word, sourceLang, targetLang) (design doc §5, §6).
 */
export async function translate(
  req: TranslateRequest,
  llm: LlmProvider | null,
  dictionary: DictionaryProvider,
  cache?: TranslationCache | null
): Promise<TranslateOutcome> {
  // Tier 0 — cache
  if (cache) {
    try {
      const hit = await cache.get(req.text, req.sourceLang, req.targetLang)
      if (hit) return { entries: hit.entries, tier: 'cache' }
    } catch (err) {
      console.warn('[cache] read failed (continuing to providers):', err)
    }
  }

  // Tier 1 — LLM (primary)
  if (llm) {
    try {
      const result = await llm.translate(req)
      const content = result.content as LlmTranslationContent
      let entries = adaptLlm(content)
      if (entries.some((e) => e.word || e.meanings.length > 0)) {
        entries = await mergeAudioFromDictionary(req, entries, dictionary)
        await cacheSetSafe(cache, req, entries, 'llm')
        return { entries, tier: 'llm' }
      }
    } catch (err) {
      const e = err as Error & { code?: string; status?: number }
      console.warn(
        `[translate] LLM tier failed (${e?.name || 'Error'}${e?.code ? `/${e.code}` : ''}${
          e?.status ? ` ${e.status}` : ''
        }): ${e?.message || e}. Falling back to dictionary.`
      )
      if (LLM_DEBUG) console.warn('[translate] full error:', err)
    }
  }

  // Tier 2 — dictionary (fallback)
  const raw = await dictionary.define({ text: req.text, sourceLang: req.sourceLang })
  const entries = raw as DictionaryEntry[]
  await cacheSetSafe(cache, req, entries, 'dict')
  return { entries, tier: 'dictionary' }
}

/** Builds the /api router with GET /translate/:text mounted under /api. */
export function createTranslateRouter(
  dictionary: DictionaryProvider,
  cache?: TranslationCache | null
): Router {
  const router = Router()

  router.get(
    '/translate/:text',
    translateLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const text = normalizeText(req.params.text)
        if (!text) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        const sourceLang = typeof req.query.from === 'string' ? req.query.from.toLowerCase() : 'en'
        const targetLang = typeof req.query.to === 'string' ? req.query.to.toLowerCase() : 'en'

        const llm = (req.app.locals.llm as LlmProvider | null) ?? null
        const outcome = await translate({ text, sourceLang, targetLang }, llm, dictionary, cache)

        if (outcome.entries.length === 0) {
          res.status(404).json({ error: 'not_found' })
          return
        }

        console.log(`[translate] "${text}" (${sourceLang}->${targetLang}) via ${outcome.tier}`)
        res.json(outcome.entries)
      } catch (err) {
        if ((err as { code?: string })?.code === 'not_found') {
          res.status(404).json({ error: 'not_found' })
          return
        }
        next(err)
      }
    }
  )

  return router
}
