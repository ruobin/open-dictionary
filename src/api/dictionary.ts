const CACHE_PREFIX = 'dict:v1:'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30000
const DEFAULT_SOURCE_LANG = 'en'
const DEFAULT_TARGET_LANG = 'en'

export interface Phonetic {
  text?: string
  audio?: string
}

export interface Definition {
  definition: string
  example?: string
  synonyms?: string[]
  antonyms?: string[]
}

export interface Meaning {
  partOfSpeech: string
  definitions: Definition[]
  synonyms?: string[]
  antonyms?: string[]
}

export interface DictionaryEntry {
  word: string
  phonetic?: string
  phonetics?: Phonetic[]
  origin?: string
  meanings?: Meaning[]
  sourceUrls?: string[]
}

export type LookupErrorCode = 'not_found' | 'timeout' | 'network' | 'api_error'

export class LookupError extends Error {
  readonly code: LookupErrorCode
  constructor(code: LookupErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'LookupError'
    this.code = code
  }
}

interface CacheEnvelope {
  data: DictionaryEntry[]
  fetchedAt: number
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

export async function lookupWord(
  rawWord: string,
  sourceLang: string = DEFAULT_SOURCE_LANG,
  targetLang: string = DEFAULT_TARGET_LANG
): Promise<DictionaryEntry[]> {
  const word = rawWord.trim().toLowerCase()
  if (!word) throw new LookupError('not_found', 'Empty word')

  const src = (sourceLang || DEFAULT_SOURCE_LANG).toLowerCase()
  const tgt = (targetLang || DEFAULT_TARGET_LANG).toLowerCase()
  const storageKey = `${src}:${tgt}:${word}`

  const cached = readCache(storageKey)
  if (cached) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const qs = new URLSearchParams({ from: src, to: tgt })

  let res: Response
  try {
    res = await fetch(`/api/translate/${encodeURIComponent(word)}?${qs.toString()}`, {
      signal: controller.signal,
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
  if (!res.ok) throw new LookupError('api_error', `API error: ${res.status}`)

  const data = (await res.json()) as DictionaryEntry[]
  writeCache(storageKey, data)
  return data
}
