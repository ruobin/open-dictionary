import { readSse } from '../../shared/sse'
import { authHeaders, notifyUsageChanged, parseQuota, type QuotaInfo, type TokenGetter } from './usage'

const CACHE_PREFIX = 'dict:v1:'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30000
const DEFAULT_SOURCE_LANG = 'en'
const DEFAULT_TARGET_LANG = 'en'

export interface Phonetic {
  text?: string
  audio?: string
}

/** CEFR proficiency level (A1 easiest – C2 hardest). */
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'

export interface GradedExample {
  text: string
  /** Difficulty level of this specific example sentence. */
  cefr?: CefrLevel
}

export interface Definition {
  definition: string
  /** Difficulty level of this sense itself. */
  cefr?: CefrLevel
  /** e.g. "countable", "transitive", "[+ that clause]", "irregular: go, went, gone". */
  grammar?: string
  /** e.g. "formal", "informal", "slang", "dated", "UK", "US". */
  register?: string
  /** 1-3 example sentences at different CEFR levels — the core learner pitch. */
  examples?: GradedExample[]
  synonyms?: string[]
  antonyms?: string[]
}

export interface Meaning {
  partOfSpeech: string
  definitions: Definition[]
  synonyms?: string[]
  antonyms?: string[]
}

export interface CommonMistake {
  /** What learners often say/write incorrectly. */
  wrong: string
  /** The correct alternative. */
  right: string
  note?: string
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
  phonetics?: Phonetic[]
  origin?: string
  /** Grouped by part of speech — "run" (verb) and "run" (noun) are separate entries. */
  meanings?: Meaning[]
  sourceUrls?: string[]
  /** Best short translation into targetLang; only present when sourceLang !== targetLang. */
  translation?: string
  /** Learner-corpus-style corrections, e.g. "make a photo" → "take a photo". */
  commonMistakes?: CommonMistake[]
  /** Fixed expressions this word commonly appears in, e.g. "heavy rain". */
  collocations?: string[]
  /** Related words, e.g. run → runner, running, rerun. */
  wordFamily?: string[]
  /** Present only when the LLM judged the input to be an obvious typo. */
  typo?: TypoSuggestion
  /** Which LLM model(s) wrote this entry; absent for dictionary entries and older cache entries. */
  generatedBy?: GeneratedBy
  /** Online dictionary the entry came from (dictionary fallback tier); absent on LLM entries and older cache entries. */
  dictionarySource?: DictionarySource
}

export interface DictionarySource {
  name: string
  url: string
}

export interface GeneratedBy {
  models: string[]
  /** A fusion merge of several models' answers. */
  merged?: boolean
}

export type LookupErrorCode = 'not_found' | 'timeout' | 'network' | 'api_error' | 'quota_exceeded'

export class LookupError extends Error {
  readonly code: LookupErrorCode
  /** Set for `quota_exceeded`: why, and what the user can do (docs/design-llm-usage-quotas.md §4.6). */
  readonly quota?: QuotaInfo
  constructor(code: LookupErrorCode, message?: string, quota?: QuotaInfo) {
    super(message ?? code)
    this.name = 'LookupError'
    this.code = code
    if (quota) this.quota = quota
  }
}

export interface LookupOptions {
  /** Access token for signed-in users: the server meters new words per account. */
  getToken?: TokenGetter
}

/** A 429 is a quota refusal (with a reason) or the per-minute rate limit. */
async function refusalError(res: Response): Promise<LookupError> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // not JSON
  }
  const quota = parseQuota(body)
  return quota
    ? new LookupError('quota_exceeded', `Quota exceeded: ${quota.reason}`, quota)
    : new LookupError('api_error', `API error: ${res.status}`)
}

interface CacheEnvelope {
  data: DictionaryEntry[]
  fetchedAt: number
}

/** MW homograph suffix (`cull:1`) or syllable marker (`hel*lo`) left in a headword. */
const MW_HEADWORD_ARTIFACT = /\*|:\d+$/

/**
 * True for a dictionary-fallback (Merriam-Webster) entry cached before entries
 * carried `dictionarySource` (2026-11-12): no source metadata, no LLM
 * `generatedBy`, and the bare shape the dictionary tier produces (no translation,
 * no LLM extras, no CEFR/grammar/register/examples on any sense), or a headword
 * with MW artifacts. Such entries are dropped so they refetch with attribution
 * and a clean headword. LLM entries (even pre-`generatedBy` ones) are kept.
 */
export function isStaleDictionaryEntry(entry: DictionaryEntry): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (entry.dictionarySource || entry.generatedBy) return false
  if (typeof entry.word === 'string' && MW_HEADWORD_ARTIFACT.test(entry.word)) return true
  if (entry.translation || entry.typo) return false
  if (entry.commonMistakes?.length || entry.collocations?.length || entry.wordFamily?.length) return false
  const senses = (entry.meanings ?? []).flatMap((m) => m.definitions ?? [])
  return !senses.some((d) => d.cefr || d.grammar || d.register || d.examples?.length)
}

function readCache(storageKey: string): DictionaryEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + storageKey)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEnvelope
    if (Date.now() - entry.fetchedAt > TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + storageKey)
      return null
    }
    if (!Array.isArray(entry.data) || entry.data.some(isStaleDictionaryEntry)) {
      localStorage.removeItem(CACHE_PREFIX + storageKey)
      return null
    }
    return entry.data
  } catch {
    return null
  }
}

function writeCache(storageKey: string, data: DictionaryEntry[]): void {
  try {
    localStorage.setItem(
      CACHE_PREFIX + storageKey,
      JSON.stringify({ data, fetchedAt: Date.now() } satisfies CacheEnvelope)
    )
  } catch {
    // Quota or unavailable — ignore
  }
}

/** Fire-and-forget client-cache hit beacon (docs/design-user-activity-log.md §14).
 *  Prefer sendBeacon so the ping survives navigation; fall back to keepalive fetch. */
function pingClientCacheHit(word: string, sourceLang: string, targetLang: string): void {
  const body = JSON.stringify({ word, sourceLang, targetLang })
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/api/activity-ping', blob)) return
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch('/api/activity-ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // best-effort — never surface to the lookup caller
    })
  } catch {
    // ignore
  }
}

/** Removes a word from the browser cache, e.g. after the owner regenerated its entry. */
export function forgetCachedEntry(rawWord: string, sourceLang: string, targetLang: string): void {
  const word = rawWord.trim().toLowerCase()
  try {
    localStorage.removeItem(`${CACHE_PREFIX}${sourceLang.toLowerCase()}:${targetLang.toLowerCase()}:${word}`)
  } catch {
    // unavailable
  }
}

export async function lookupWord(
  rawWord: string,
  sourceLang: string = DEFAULT_SOURCE_LANG,
  targetLang: string = DEFAULT_TARGET_LANG,
  options: LookupOptions = {}
): Promise<DictionaryEntry[]> {
  const word = rawWord.trim().toLowerCase()
  if (!word) throw new LookupError('not_found', 'Empty word')

  const src = (sourceLang || DEFAULT_SOURCE_LANG).toLowerCase()
  const tgt = (targetLang || DEFAULT_TARGET_LANG).toLowerCase()
  const storageKey = `${src}:${tgt}:${word}`

  const cached = readCache(storageKey)
  if (cached) {
    pingClientCacheHit(word, src, tgt)
    return cached
  }

  // Before the timeout starts: a slow silent sign-in must not eat into it.
  const headers = await authHeaders(options.getToken)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const qs = new URLSearchParams({ from: src, to: tgt })

  let res: Response
  try {
    res = await fetch(`/api/translate/${encodeURIComponent(word)}?${qs.toString()}`, {
      signal: controller.signal,
      headers,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LookupError('timeout')
    }
    throw new LookupError('network')
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 404) throw new LookupError('not_found')
  if (res.status === 429) throw await refusalError(res)
  if (!res.ok) throw new LookupError('api_error', `API error: ${res.status}`)
  if (res.headers.get('x-generation') === 'charged') notifyUsageChanged()

  const data = (await res.json()) as DictionaryEntry[]
  writeCache(storageKey, data)
  return data
}

export interface StreamLookupOptions extends LookupOptions {
  /** Called with progressively more complete entries while the server is still
   *  writing the answer (translation first, then each part of speech). */
  onPartial?: (entries: DictionaryEntry[]) => void
  /** Aborts the request (e.g. the user navigated to another word). */
  signal?: AbortSignal
}

/**
 * Like {@link lookupWord}, but reads `/api/translate-stream/:text` (Server-Sent
 * Events) so the page can show the translation and first senses as soon as the
 * model has written them instead of waiting for the whole entry.
 *
 * Client-cache hits and every failure of the streaming transport itself (old
 * server without the route, a proxy that mangles event streams, a connection
 * cut before `done`) quietly fall back to the plain endpoint, which the server
 * answers from its cache or the in-flight lookup — streaming is an
 * enhancement, never a new way to fail.
 */
export async function lookupWordStream(
  rawWord: string,
  sourceLang: string = DEFAULT_SOURCE_LANG,
  targetLang: string = DEFAULT_TARGET_LANG,
  options: StreamLookupOptions = {}
): Promise<DictionaryEntry[]> {
  const word = rawWord.trim().toLowerCase()
  if (!word) throw new LookupError('not_found', 'Empty word')

  const src = (sourceLang || DEFAULT_SOURCE_LANG).toLowerCase()
  const tgt = (targetLang || DEFAULT_TARGET_LANG).toLowerCase()
  const storageKey = `${src}:${tgt}:${word}`

  const cached = readCache(storageKey)
  if (cached) {
    pingClientCacheHit(word, src, tgt)
    return cached
  }

  // Before the timeout starts: a slow silent sign-in must not eat into it.
  const auth = await authHeaders(options.getToken)
  const controller = new AbortController()
  const onCallerAbort = (): void => controller.abort()
  if (options.signal?.aborted) throw new LookupError('network')
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, FETCH_TIMEOUT_MS)

  const qs = new URLSearchParams({ from: src, to: tgt })
  const fallback = (): Promise<DictionaryEntry[]> =>
    lookupWord(rawWord, sourceLang, targetLang, options.getToken ? { getToken: options.getToken } : {})

  try {
    let res: Response
    try {
      res = await fetch(`/api/translate-stream/${encodeURIComponent(word)}?${qs.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream', ...auth },
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LookupError(timedOut ? 'timeout' : 'network')
      }
      return await fallback()
    }

    if (res.status === 429) throw await refusalError(res)
    const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    // 404 here may just mean "this server has no stream route"; the plain
    // endpoint gives the authoritative answer (including a real not_found).
    if (!res.ok || !isSse || !res.body) return await fallback()

    let final: DictionaryEntry[] | null = null
    let failure: LookupError | null = null
    try {
      await readSse(res.body, ({ event, data }) => {
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          return
        }
        if (event === 'partial' && Array.isArray(payload)) {
          if (!options.signal?.aborted) options.onPartial?.(payload as DictionaryEntry[])
        } else if (event === 'done' && Array.isArray(payload)) {
          final = payload as DictionaryEntry[]
        } else if (event === 'usage') {
          // A new word was charged to this user's free allowance.
          notifyUsageChanged()
        } else if (event === 'error') {
          const code = (payload as { error?: string } | null)?.error
          const quota = parseQuota(payload)
          failure = quota
            ? new LookupError('quota_exceeded', `Quota exceeded: ${quota.reason}`, quota)
            : code === 'not_found'
              ? new LookupError('not_found')
              : new LookupError('api_error', `Stream error: ${code ?? 'unknown'}`)
        }
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LookupError(timedOut ? 'timeout' : 'network')
      }
      // Connection dropped mid-stream: fall through to the plain endpoint below.
    }

    if (failure) throw failure
    if (final) {
      writeCache(storageKey, final)
      return final
    }
    return await fallback()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}
