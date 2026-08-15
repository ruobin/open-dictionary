import { createGlmProvider } from './glm'
import { createOpenRouterProvider, DEFAULT_OPENROUTER_MODEL } from './openrouter'
import { createDeepSeekProvider, DEFAULT_DEEPSEEK_MODEL } from './deepseek'
import { createOpenAiCompatibleProvider } from './openaiCompat'
import { createOpenAiResponsesProvider } from './responses'
import { LlmProviderError, type LlmProvider } from './types'

export type {
  CefrLevel,
  LlmCommonMistake,
  LlmErrorCode,
  LlmGradedExample,
  LlmMeaningGroup,
  LlmProvider,
  LlmSense,
  LlmTranslationContent,
  LlmTranslationRequest,
  LlmTranslationResult,
} from './types'
export { LlmProviderError } from './types'
export { createGlmProvider } from './glm'
export type { GlmProviderConfig } from './glm'
export { createOpenRouterProvider, DEFAULT_OPENROUTER_MODEL } from './openrouter'
export type { OpenRouterProviderConfig } from './openrouter'
export { createDeepSeekProvider, DEFAULT_DEEPSEEK_MODEL } from './deepseek'
export type { DeepSeekProviderConfig } from './deepseek'
export { createOpenAiCompatibleProvider, DEFAULT_TIMEOUT_MS } from './openaiCompat'
export type { OpenAiCompatOptions } from './openaiCompat'
export { createOpenAiResponsesProvider } from './responses'
export type { OpenAiResponsesOptions } from './responses'
export { createFusionProvider, mergeContents, definitionsSimilar } from './fusion'
export type { FusionProviderConfig } from './fusion'

export type LlmRegistryStatus = 'active' | 'disabled' | 'misconfigured'

export interface LlmRegistryResult {
  provider: LlmProvider | null
  status: LlmRegistryStatus
  message: string
}

const DEFAULT_VENDOR = 'deepseek'
const SUPPORTED_VENDORS = 'deepseek, openrouter, glm, openai-compat, openai-responses, none'

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function truthyString(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t ? t : undefined
}

export function createLlmProviderFromEnv(): LlmRegistryResult {
  const vendor = process.env.LLM_VENDOR?.trim().toLowerCase() || DEFAULT_VENDOR
  const timeoutMs = parsePositiveInt(process.env.LLM_REQUEST_TIMEOUT_MS)

  if (vendor === 'none' || vendor === 'disabled' || vendor === 'off') {
    return {
      provider: null,
      status: 'disabled',
      message: 'LLM_VENDOR=none — LLM tier disabled (dictionary fallback only)',
    }
  }

  switch (vendor) {
    case 'deepseek': {
      const apiKey = truthyString(process.env.DEEPSEEK_API_KEY)
      const model = truthyString(process.env.DEEPSEEK_MODEL) ?? DEFAULT_DEEPSEEK_MODEL
      if (!apiKey) {
        return {
          provider: null,
          status: 'misconfigured',
          message: `LLM_VENDOR=deepseek but DEEPSEEK_API_KEY is missing — set it to enable the DeepSeek (${model}) provider`,
        }
      }
      try {
        const provider = createDeepSeekProvider({
          apiKey,
          model,
          baseUrl: truthyString(process.env.DEEPSEEK_BASE_URL),
          timeoutMs,
        })
        return { provider, status: 'active', message: `DeepSeek provider active (${provider.id})` }
      } catch (err) {
        const detail = err instanceof LlmProviderError ? err.message : String(err)
        return { provider: null, status: 'misconfigured', message: `DeepSeek provider not built: ${detail}` }
      }
    }

    case 'openrouter': {
      const apiKey = truthyString(process.env.OPENROUTER_API_KEY)
      const model = truthyString(process.env.OPENROUTER_MODEL) ?? DEFAULT_OPENROUTER_MODEL
      if (!apiKey) {
        return {
          provider: null,
          status: 'misconfigured',
          message: `LLM_VENDOR=openrouter but OPENROUTER_API_KEY is missing — set it to enable the OpenRouter (${model}) provider`,
        }
      }
      try {
        const provider = createOpenRouterProvider({
          apiKey,
          model,
          baseUrl: truthyString(process.env.OPENROUTER_BASE_URL),
          referer: truthyString(process.env.OPENROUTER_REFERER),
          title: truthyString(process.env.OPENROUTER_TITLE),
          timeoutMs,
        })
        return { provider, status: 'active', message: `OpenRouter provider active (${provider.id})` }
      } catch (err) {
        const detail = err instanceof LlmProviderError ? err.message : String(err)
        return { provider: null, status: 'misconfigured', message: `OpenRouter provider not built: ${detail}` }
      }
    }

    case 'glm': {
      const apiKey = truthyString(process.env.ZAI_API_KEY)
      const model = truthyString(process.env.GLM_MODEL) ?? truthyString(process.env.LLM_MODEL) ?? 'glm-5.2'
      if (!apiKey) {
        return {
          provider: null,
          status: 'misconfigured',
          message: `LLM_VENDOR=glm but ZAI_API_KEY is missing — set it to enable the GLM (${model}) provider`,
        }
      }
      try {
        const provider = createGlmProvider({
          apiKey,
          model,
          baseUrl: truthyString(process.env.GLM_BASE_URL) ?? truthyString(process.env.LLM_BASE_URL),
          timeoutMs,
        })
        return { provider, status: 'active', message: `GLM provider active (${provider.id})` }
      } catch (err) {
        const detail = err instanceof LlmProviderError ? err.message : String(err)
        return { provider: null, status: 'misconfigured', message: `GLM provider not built: ${detail}` }
      }
    }

    default:
      return {
        provider: null,
        status: 'misconfigured',
        message: `Unknown LLM_VENDOR "${vendor}" — supported: ${SUPPORTED_VENDORS}`,
      }
  }
}

/**
 * Vendor-tagged config for building a provider outside the env-boot path —
 * from a decrypted `llm_providers` doc (admin panel) or a benchmark draft.
 * Admin portal (docs/design-admin-portal.md §4.1, §7.1).
 */
export interface LlmProviderConfig {
  /** "deepseek" | "openrouter" | "glm" | "openai-compat" | "openai-responses" */
  vendor: string
  apiKey: string
  model: string
  baseUrl?: string
  /** OpenRouter attribution (`referer`/`title`) for that vendor; passed through
   *  verbatim as request headers for the generic "openai-compat" vendor. */
  headers?: Record<string, string>
  timeoutMs?: number
  temperature?: number
  options?: { provider?: { order?: string[]; allow_fallbacks?: boolean } }
}

/**
 * Builds a provider from admin-portal config, reusing the same vendor
 * factories the env-boot path uses (design doc §7.1: "the portal changes
 * *where config comes from*, not how providers work").
 */
export function buildLlmProvider(cfg: LlmProviderConfig): LlmProvider {
  switch (cfg.vendor) {
    case 'deepseek':
      return createDeepSeekProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
        temperature: cfg.temperature,
      })

    case 'openrouter':
      return createOpenRouterProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        timeoutMs: cfg.timeoutMs,
        temperature: cfg.temperature,
        provider: cfg.options?.provider,
      })

    case 'glm':
      return createGlmProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
        temperature: cfg.temperature,
      })

    case 'openai-compat':
      if (!cfg.baseUrl) {
        throw new LlmProviderError('not_configured', '"openai-compat" providers require a baseUrl')
      }
      return createOpenAiCompatibleProvider({
        vendor: 'openai-compat',
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        timeoutMs: cfg.timeoutMs,
        temperature: cfg.temperature,
      })

    case 'openai-responses':
      if (!cfg.baseUrl) {
        throw new LlmProviderError('not_configured', '"openai-responses" providers require a baseUrl')
      }
      return createOpenAiResponsesProvider({
        vendor: 'openai-responses',
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        timeoutMs: cfg.timeoutMs,
      })

    default:
      throw new LlmProviderError('not_configured', `Unknown vendor "${cfg.vendor}" — supported: ${SUPPORTED_VENDORS}, openai-compat`)
  }
}
