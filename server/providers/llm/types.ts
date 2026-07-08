/**
 * Vendor-agnostic LLM provider contract. The cache layer (TranslateService)
 * talks to any implementation of this interface; the active vendor is chosen
 * by config (see ./index.ts), so swapping providers is a config change, not a
 * code change.
 *
 * NOTE on the cache key: each provider exposes a stable `id` (e.g.
 * "llm:glm:glm-5.2") that becomes the `provider` field of the Mongo cache key
 * (see design doc §5). The id is deliberately vendor+model specific so that
 * bumping the model refreshes answers instead of serving a different model's
 * year-old cached output.
 */

export interface LlmTranslationRequest {
  /** The word or expression to translate/define (raw; normalization happens upstream). */
  text: string
  /** BCP-47 source language, e.g. "en". */
  sourceLang: string
  /** BCP-47 target language, e.g. "en" (definition mode) or "es" (translation mode). */
  targetLang: string
}

export interface LlmDefinition {
  definition: string
  example?: string
}

/**
 * Structured payload returned by the LLM and cached verbatim under
 * `LlmTranslationResult.content`.
 */
export interface LlmTranslationSuggestion {
  /** The likely intended word. */
  suggestion: string
  /** Short human-readable note (rendered to the user, in targetLang). */
  explanation?: string
}

/**
 * When present, the input was judged to be an obvious typo. The LLM
 * intentionally omits translation/partOfSpeech/phonetic/meanings/examples in
 * this case — the entry is only a correction nudge.
 */
export interface LlmTranslationContent {
  /** The queried term, echoed back (the original input as typed, even if a typo). */
  headword: string
  /** Best short translation into targetLang (omitted in same-language definition mode). */
  translation?: string
  partOfSpeech?: string
  /** IPA transcription when known. */
  phonetic?: string
  meanings?: LlmDefinition[]
  /** Extra usage examples. */
  examples?: string[]
  /** Typo correction: present only when the input is an obvious typo. */
  typo?: LlmTranslationSuggestion
}

export interface LlmTranslationResult {
  /** Provider-specific payload. For GLM this is an {@link LlmTranslationContent}. */
  content: unknown
}

export type LlmErrorCode =
  | 'timeout'
  | 'network'
  | 'api_error'
  | 'bad_response'
  | 'not_configured'

/**
 * Thrown by providers on failure. The TranslateService catches this to fall
 * through to the dictionary tier (see design doc §5, §11).
 */
export class LlmProviderError extends Error {
  readonly code: LlmErrorCode
  readonly status?: number

  constructor(code: LlmErrorCode, message?: string, status?: number) {
    super(message ?? code)
    this.name = 'LlmProviderError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export interface LlmProvider {
  /** Stable cache-key id, e.g. "llm:glm:glm-5.2". */
  readonly id: string
  translate(req: LlmTranslationRequest): Promise<LlmTranslationResult>
}
