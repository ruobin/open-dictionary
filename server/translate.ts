import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import type { LlmDefinition, LlmProvider, LlmTranslationContent } from './providers/llm'
import type { DictionaryProvider } from './providers/dictionary'
import type { TranslationCache } from './cache/translationCache'
import { TRANSLATE_RATE_LIMIT_RPM } from './config'
import { LANGUAGES } from '../shared/languages'

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
export interface TypoSuggestion {
  /** The likely intended word. */
  suggestion: string
  /** Short human-readable note for the user. */
  explanation?: string
}
export interface DictionaryEntry {
  word: string
  phonetic?: string
  phonetics: Phonetic[]
  meanings: Meaning[]
  sourceUrls?: string[]
  /** Best short translation into targetLang; only present when sourceLang !== targetLang. */
  translation?: string
  /** Extra usage examples beyond the one per-definition example. */
  examples?: string[]
  /** Present only when the LLM judged the input to be an obvious typo. */
  typo?: TypoSuggestion
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

// Whitelist of accepted language codes. Rejecting unknown `from`/`to` values
// bounds the cache cardinality and prevents LLM-cost abuse (every distinct
// (word, sourceLang, targetLang) tuple would otherwise create a cache doc +
// trigger a paid LLM call).
const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))

const LLM_DEBUG = /^(1|true|yes|on)$/i.test(process.env.LLM_DEBUG ?? '')

/**
 * Cache-key version component (to-do §2). Bump whenever `adaptLlm()`'s output
 * shape changes, or the LLM prompt/schema in
 * `server/providers/llm/openaiCompat.ts` (`buildMessages`/`parseContent`)
 * changes in a way that would produce a different cached result for the same
 * input — otherwise the change is invisible for up to the 1-year cache TTL.
 * Old-version cache docs are left to TTL-expire rather than eagerly purged
 * (see docs/design-translation-cache.md §2).
 */
export const CACHE_VERSION = 'v2'

export const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: TRANSLATE_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function normalizeText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '') // strip non-whitespace control chars (log/cache integrity)
    .slice(0, MAX_TEXT_LENGTH)
}

/** Returns the validated lowercase language code, or `null` if not in the
 *  supported set. An undefined value resolves to `fallback` (a known code). */
function normalizeLang(value: string | undefined, fallback: string): string | null {
  if (value === undefined || value.trim() === '') return fallback
  const code = value.trim().toLowerCase()
  return LANGUAGE_CODES.has(code) ? code : null
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
  if (content.translation) entry.translation = content.translation
  if (Array.isArray(content.examples) && content.examples.length > 0) {
    entry.examples = content.examples
  }
  if (content.typo) {
    entry.typo = content.typo.explanation
      ? { suggestion: content.typo.suggestion, explanation: content.typo.explanation }
      : { suggestion: content.typo.suggestion }
  }

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
    await cache.set(req.text, req.sourceLang, req.targetLang, entries, source, CACHE_VERSION)
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
    if (!Array.isArray(raw) || raw.length === 0) {
      if (LLM_DEBUG) {
        console.log(`[dict-audio] no entries from dictionary for "${req.text}" (sourceLang=${req.sourceLang})`)
      }
      return entries
    }
    const dictPhonetics = (raw[0] as DictionaryEntry)?.phonetics ?? []
    if (dictPhonetics.length === 0) {
      if (LLM_DEBUG) {
        console.log(`[dict-audio] dictionary entry for "${req.text}" has no phonetics field`)
      }
      return entries
    }
    const audioPhonetics = dictPhonetics.filter((p) => Boolean(p.audio))
    if (audioPhonetics.length === 0) {
      if (LLM_DEBUG) {
        console.log(`[dict-audio] dictionary returned ${dictPhonetics.length} phonetics for "${req.text}" but none have audio URLs`)
      }
      return entries
    }
    if (LLM_DEBUG) {
      console.log(`[dict-audio] merged ${audioPhonetics.length} audio URL(s) into "${req.text}"`)
    }
    return entries.map((entry, i) =>
      i === 0
        ? { ...entry, phonetics: [...(entry.phonetics ?? []), ...audioPhonetics] }
        : entry
    )
  } catch (err) {
    if (LLM_DEBUG) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`[dict-audio] dictionary call failed for "${req.text}": ${message}`)
    }
    return entries
  }
}

/**
 * In-flight request dedup (to-do §9): concurrent lookups for the same
 * (text, sourceLang, targetLang) share one underlying `doTranslate()` call
 * instead of each fanning out to the cache/LLM/dictionary — protects a
 * popular uncached word from a stampede of simultaneous LLM calls.
 */
const inFlight = new Map<string, Promise<TranslateOutcome>>()

function inFlightKey(req: TranslateRequest): string {
  return `${req.sourceLang}|${req.targetLang}|${req.text}`
}

/**
 * Read-through, tiered lookup: Mongo cache → LLM (primary) → dictionary
 * (fallback only on LLM failure/absence). Results are cached keyed by
 * (word, sourceLang, targetLang, version) (design doc §5, §6; to-do §2).
 */
export function translate(
  req: TranslateRequest,
  llm: LlmProvider | null,
  dictionary: DictionaryProvider,
  cache?: TranslationCache | null
): Promise<TranslateOutcome> {
  const key = inFlightKey(req)
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = doTranslate(req, llm, dictionary, cache).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

async function doTranslate(
  req: TranslateRequest,
  llm: LlmProvider | null,
  dictionary: DictionaryProvider,
  cache?: TranslationCache | null
): Promise<TranslateOutcome> {
  // Tier 0 — cache
  if (cache) {
    try {
      const hit = await cache.get(req.text, req.sourceLang, req.targetLang, CACHE_VERSION)
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
      const isTypoResponse = entries.some((e) => Boolean(e.typo?.suggestion))
      if (entries.some((e) => e.word || e.meanings.length > 0)) {
        if (!isTypoResponse) {
          entries = await mergeAudioFromDictionary(req, entries, dictionary)
        }
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
        const sourceLang = normalizeLang(
          typeof req.query.from === 'string' ? req.query.from : undefined,
          'en'
        )
        const targetLang = normalizeLang(
          typeof req.query.to === 'string' ? req.query.to : undefined,
          'en'
        )
        if (sourceLang === null || targetLang === null) {
          res.status(400).json({ error: 'invalid_language' })
          return
        }

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
