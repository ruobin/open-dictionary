import { type LlmProvider } from './types'
import { createOpenAiCompatibleProvider } from './openaiCompat'
import { DEFAULT_OPENROUTER_TITLE } from '../../../shared/providerDefaults'

/**
 * OpenRouter provider (OpenAI-compatible). Docs: https://openrouter.ai
 * Default model: MiniMax M3 (`minimax/minimax-m3`).
 */
export interface OpenRouterProviderConfig {
  apiKey: string
  /** Model id; defaults to MiniMax M3. */
  model?: string
  baseUrl?: string
  /** Extra request headers. OpenRouter's two attribution headers
   *  (`HTTP-Referer`, `X-Title`) are accepted in any casing — the admin
   *  portal lets operators type them as `X-Title`/`HTTP-Referer` (canonical)
   *  or `title`/`referer` (short); both work. Any other header is
   *  forwarded verbatim, so admins can add custom headers from the UI. */
  headers?: Record<string, string>
  /** Explicit attribution overrides; win over any value in `headers`.
   *  Used by the env-boot path, which reads OPENROUTER_REFERER/OPENROUTER_TITLE. */
  referer?: string
  title?: string
  timeoutMs?: number
  temperature?: number
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_OPENROUTER_MODEL = 'minimax/minimax-m3'

/** Lowercased names of the two OpenRouter attribution headers; matched
 *  case-insensitively against `headers` so admin-portal input in any casing
 *  is honored. */
const REFERER_HEADER_NAMES = ['http-referer', 'referer']
const TITLE_HEADER_NAMES = ['x-title', 'title']

function lookupHeader(headers: Record<string, string> | undefined, names: readonly string[]): string | undefined {
  if (!headers) return undefined
  for (const [k, v] of Object.entries(headers)) {
    if (names.includes(k.toLowerCase())) return v
  }
  return undefined
}

export function createOpenRouterProvider(config: OpenRouterProviderConfig): LlmProvider {
  // Resolve attribution, in priority order:
  //   1. explicit override (env-boot path: OPENROUTER_REFERER/OPENROUTER_TITLE)
  //   2. headers object, any casing (admin-portal path)
  //   3. built-in default
  // OpenRouter's dashboard groups request logs by these two values, so a
  // sensible default lets operators distinguish "Open Dictionary" traffic
  // from other apps sharing the same API key without any configuration.
  const envReferer = process.env.PUBLIC_BASE_URL?.trim() || undefined
  const referer = config.referer ?? lookupHeader(config.headers, REFERER_HEADER_NAMES) ?? envReferer
  const title = config.title ?? lookupHeader(config.headers, TITLE_HEADER_NAMES) ?? DEFAULT_OPENROUTER_TITLE

  // Rebuild headers with canonical casing for the two attribution headers
  // and forward any other custom headers the admin added verbatim. Strips
  // any casing-variant duplicates of the attribution headers so we never
  // send conflicting values.
  const headers: Record<string, string> = {}
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      const lower = k.toLowerCase()
      if (REFERER_HEADER_NAMES.includes(lower) || TITLE_HEADER_NAMES.includes(lower)) continue
      headers[k] = v
    }
  }
  if (referer) headers['HTTP-Referer'] = referer
  headers['X-Title'] = title

  return createOpenAiCompatibleProvider({
    vendor: 'openrouter',
    apiKey: config.apiKey,
    model: config.model ?? DEFAULT_OPENROUTER_MODEL,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers,
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
  })
}
