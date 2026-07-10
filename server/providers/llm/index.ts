import { createGlmProvider } from './glm'
import { createOpenRouterProvider, DEFAULT_OPENROUTER_MODEL } from './openrouter'
import { createDeepSeekProvider, DEFAULT_DEEPSEEK_MODEL } from './deepseek'
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

export type LlmRegistryStatus = 'active' | 'disabled' | 'misconfigured'

export interface LlmRegistryResult {
  provider: LlmProvider | null
  status: LlmRegistryStatus
  message: string
}

const DEFAULT_VENDOR = 'deepseek'
const SUPPORTED_VENDORS = 'deepseek, openrouter, glm, none'

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
