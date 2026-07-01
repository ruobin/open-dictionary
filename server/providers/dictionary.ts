import { ProviderError } from './errors'

/**
 * Fallback tier: Merriam-Webster Collegiate API, called server-side. Invoked by
 * the translate route only when the LLM tier is unavailable or fails
 * (design doc §5), and best-effort by the audio-merge step after LLM success
 * (to attach pronunciation audio URLs to LLM-produced entries).
 *
 * Collegiate is English-only.
 *   Docs: https://www.dictionaryapi.com/
 *   Example: GET /api/v3/references/collegiate/json/{word}?key={apiKey}
 */
export interface DictionaryProviderConfig {
  /** Override the API base; defaults to https://www.dictionaryapi.com/api/v3 */
  baseUrl?: string
  /** Merriam-Webster API key. Required to call the API. */
  apiKey?: string
  /** Per-request timeout in ms. */
  timeoutMs?: number
}

export interface DefineRequest {
  text: string
  sourceLang: string
}

export interface DictionaryProvider {
  /** Stable cache-key id. */
  readonly id: string
  /** Returns parsed entries in the shared DictionaryEntry shape. */
  define(req: DefineRequest): Promise<unknown[]>
}

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
interface DictionaryEntry {
  word: string
  phonetic?: string
  phonetics: Phonetic[]
  meanings: Meaning[]
  sourceUrls?: string[]
}

const DEFAULT_BASE_URL = 'https://www.dictionaryapi.com/api/v3'
const DEFAULT_TIMEOUT_MS = 8_000
const AUDIO_BASE_URL = 'https://media.merriam-webster.com/audio/prons/en/us/mp3'

/** Merriam-Webster's audio-file subdirectory rule based on the filename prefix.
 *  - starts with "bix" → "bix"
 *  - starts with "gg"  → "gg"
 *  - starts with a number or punctuation → "number"
 *  - otherwise → first letter of the filename */
function mwAudioSubdirectory(filename: string): string {
  const f = filename.toLowerCase()
  if (f.startsWith('bix')) return 'bix'
  if (f.startsWith('gg')) return 'gg'
  if (!/^[a-z]/.test(f)) return 'number'
  return f[0]
}

function buildMwAudioUrl(audio: string): string {
  const subdir = mwAudioSubdirectory(audio)
  return `${AUDIO_BASE_URL}/${subdir}/${audio}.mp3`
}

interface MwSound {
  audio?: string
  ref?: string
  stat?: string
}
interface MwPrs {
  mw?: string
  sound?: MwSound
}
interface MwHwi {
  hw?: string
  prs?: MwPrs[]
}
interface MwMeta {
  id?: string
  src?: string
}
interface MwEntry {
  meta?: MwMeta
  hwi?: MwHwi
  fl?: string
  shortdef?: string[]
}

function parseEntry(raw: MwEntry): DictionaryEntry | null {
  const word = raw.meta?.id
  if (!word) return null

  const phonetics: Phonetic[] = []
  for (const p of raw.hwi?.prs ?? []) {
    if (p.mw) {
      const ph: Phonetic = { text: p.mw }
      if (p.sound?.audio) {
        ph.audio = buildMwAudioUrl(p.sound.audio)
      }
      phonetics.push(ph)
    }
  }

  const shortdef = raw.shortdef ?? []
  const meaning: Meaning = {
    partOfSpeech: raw.fl ?? '',
    definitions: shortdef.map((text) => ({ definition: text })),
  }

  const entry: DictionaryEntry = {
    word,
    phonetics,
    meanings: shortdef.length > 0 ? [meaning] : [],
  }
  return entry
}

export function createDictionaryProvider(config: DictionaryProviderConfig = {}): DictionaryProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const apiKey = config.apiKey?.trim() || undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const id = 'dict:merriam-webster:collegiate'

  return {
    id,
    async define({ text, sourceLang }: DefineRequest): Promise<unknown[]> {
      if (!apiKey) {
        throw new ProviderError('api_error', 'MERRIAM_WEBSTER_API_KEY is not set')
      }
      if (sourceLang.toLowerCase() !== 'en') {
        throw new ProviderError(
          'not_found',
          `Merriam-Webster Collegiate only supports English (sourceLang=${sourceLang})`
        )
      }

      const url = `${baseUrl}/references/collegiate/json/${encodeURIComponent(text)}?key=${encodeURIComponent(apiKey)}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let res: Response
      try {
        res = await fetch(url, { signal: controller.signal })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderError('timeout', `Merriam-Webster request timed out after ${timeoutMs}ms`)
        }
        throw new ProviderError(
          'network',
          `Could not reach the Merriam-Webster API: ${(err as Error)?.message ?? err}`
        )
      } finally {
        clearTimeout(timer)
      }

      if (res.status === 404) {
        throw new ProviderError('not_found', `No Merriam-Webster entry for "${text}"`)
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new ProviderError(
          'api_error',
          `Merriam-Webster API error: ${res.status} ${detail.slice(0, 200)}`.trimEnd(),
          res.status
        )
      }

      const data = (await res.json()) as unknown
      if (!Array.isArray(data) || data.length === 0) {
        throw new ProviderError('not_found', `No Merriam-Webster entry for "${text}"`)
      }
      // MW returns a plain-text "No Definitions Found" body with status 200 for
      // some lookups. It comes through as a string instead of an array.
      if (typeof data === 'string') {
        throw new ProviderError('not_found', `No Merriam-Webster entry for "${text}"`)
      }
      // No exact match — MW returns an array of suggestion strings.
      if (typeof data[0] === 'string') {
        throw new ProviderError(
          'not_found',
          `No Merriam-Webster entry for "${text}" (suggestions: ${(data as string[]).slice(0, 5).join(', ')})`
        )
      }

      const entries: DictionaryEntry[] = []
      for (const raw of data as MwEntry[]) {
        const entry = parseEntry(raw)
        if (entry) entries.push(entry)
      }
      if (entries.length === 0) {
        throw new ProviderError('not_found', `Could not parse Merriam-Webster response for "${text}"`)
      }
      return entries
    },
  }
}
