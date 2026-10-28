import { type LlmProvider } from './types'
import { createOpenAiCompatibleProvider } from './openaiCompat'
import { DEEPSEEK_RUNGS } from './requestVariants'

/**
 * DeepSeek provider (OpenAI-compatible).
 * Docs: https://api.deepseek.com  ·  Base URL: https://api.deepseek.com
 */
export interface DeepSeekProviderConfig {
  apiKey: string
  /** Model id, e.g. "deepseek-v4-flash". */
  model?: string
  baseUrl?: string
  timeoutMs?: number
  temperature?: number
  /** Extra request-body fields (model option `requestBody`). */
  requestBody?: Record<string, unknown>
  stream?: boolean
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

export function createDeepSeekProvider(config: DeepSeekProviderConfig): LlmProvider {
  return createOpenAiCompatibleProvider({
    vendor: 'deepseek',
    apiKey: config.apiKey,
    model: config.model ?? DEFAULT_DEEPSEEK_MODEL,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
    reasoningRungs: DEEPSEEK_RUNGS,
    requestBody: config.requestBody,
    capOutput: true,
    stream: config.stream,
  })
}
