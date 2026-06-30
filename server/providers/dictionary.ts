import { ProviderError } from './errors'

/**
 * Fallback tier: the Free Dictionary API, now called server-side (it used to
 * be called directly from the browser — see src/api/dictionary.ts). Invoked by
 * the translate route only when the LLM tier is unavailable or fails
 * (design doc §5).
 */
export interface DictionaryProviderConfig {
  /** Override the API base; defaults to https://api.dictionaryapi.dev */
  baseUrl?: string
  /** Per-request timeout in ms. */
  timeoutMs?: number
}

export interface DefineRequest {
  text: string
  sourceLang: string
}

export interface DictionaryProvider {
  /** Stable cache-key id (matches design doc §5 fallback key). */
  readonly id: string
  /** Returns the raw Free Dictionary API entries array (unknown[]). */
  define(req: DefineRequest): Promise<unknown[]>
}

const DEFAULT_BASE_URL = 'https://api.dictionaryapi.dev'
const DEFAULT_TIMEOUT_MS = 8_000

export function createDictionaryProvider(config: DictionaryProviderConfig = {}): DictionaryProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const id = 'dict:free-dictionary-api:v2'

  return {
    id,
    async define({ text, sourceLang }: DefineRequest): Promise<unknown[]> {
      const lang = (sourceLang || 'en').toLowerCase()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let res: Response
      try {
        res = await fetch(
          `${baseUrl}/api/v2/entries/${encodeURIComponent(lang)}/${encodeURIComponent(text)}`,
          { signal: controller.signal }
        )
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderError('timeout', `Dictionary API timed out after ${timeoutMs}ms`)
        }
        throw new ProviderError('network', 'Could not reach the dictionary API')
      } finally {
        clearTimeout(timer)
      }

      if (res.status === 404) {
        throw new ProviderError('not_found', `No dictionary entry for "${text}"`)
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new ProviderError(
          'api_error',
          `Dictionary API error: ${res.status} ${detail.slice(0, 200)}`.trimEnd(),
          res.status
        )
      }

      const data = (await res.json()) as unknown
      return Array.isArray(data) ? data : []
    },
  }
}
