import { type LlmProvider } from './types'
import { createOpenAiCompatibleProvider } from './openaiCompat'

/**
 * Z.AI GLM provider (OpenAI-compatible). Docs: https://z.ai
 * Base URL: https://api.z.ai/api/paas/v4
 */
export interface GlmProviderConfig {
  /** Z.AI API key (from the Z.AI console). */
  apiKey: string
  /** Model id, e.g. "glm-5.2". */
  model: string
  /** Override the API base; defaults to the Z.AI paas v4 endpoint. */
  baseUrl?: string
  /** Per-request timeout in ms. */
  timeoutMs?: number
  /** Sampling temperature. */
  temperature?: number
}

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4'

export function createGlmProvider(config: GlmProviderConfig): LlmProvider {
  return createOpenAiCompatibleProvider({
    vendor: 'glm',
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
  })
}
