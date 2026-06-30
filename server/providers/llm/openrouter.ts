import { type LlmProvider } from './types'
import { createOpenAiCompatibleProvider } from './openaiCompat'

/**
 * OpenRouter provider (OpenAI-compatible). Docs: https://openrouter.ai
 * Default model: MiniMax M3 (`minimax/minimax-m3`).
 */
export interface OpenRouterProviderConfig {
  apiKey: string
  /** Model id; defaults to MiniMax M3. */
  model?: string
  baseUrl?: string
  /** Optional attribution headers OpenRouter recommends. */
  referer?: string
  title?: string
  timeoutMs?: number
  temperature?: number
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_OPENROUTER_MODEL = 'minimax/minimax-m3'

export function createOpenRouterProvider(config: OpenRouterProviderConfig): LlmProvider {
  const headers: Record<string, string> = {}
  if (config.referer) headers['HTTP-Referer'] = config.referer
  if (config.title) headers['X-Title'] = config.title

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
