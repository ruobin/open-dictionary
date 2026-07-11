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

/** CEFR proficiency level (A1 easiest – C2 hardest), per to-do §3. */
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'

export interface LlmGradedExample {
  text: string
  /** Difficulty level of this specific example sentence. */
  cefr?: CefrLevel
}

/** One sense (definition) within a part-of-speech group. */
export interface LlmSense {
  definition: string
  /** Difficulty level of this sense itself. */
  cefr?: CefrLevel
  /** e.g. "countable", "transitive", "[+ that clause]", "irregular: go, went, gone". */
  grammar?: string
  /** e.g. "formal", "informal", "slang", "dated", "UK", "US". */
  register?: string
  /** 1-3 example sentences at different CEFR levels — the core learner pitch. */
  examples?: LlmGradedExample[]
}

/** All senses sharing one part of speech, e.g. "run" (verb) vs "run" (noun)
 *  are separate groups rather than being collapsed together. */
export interface LlmMeaningGroup {
  partOfSpeech: string
  senses: LlmSense[]
}

export interface LlmCommonMistake {
  /** What learners often say/write incorrectly. */
  wrong: string
  /** The correct alternative. */
  right: string
  /** Short explanation, in targetLang. */
  note?: string
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
 * intentionally omits every other field in this case — the entry is only a
 * correction nudge.
 */
export interface LlmTranslationContent {
  /** The queried term, echoed back (the original input as typed, even if a typo). */
  headword: string
  /** Best short translation into targetLang (omitted in same-language definition mode). */
  translation?: string
  /** IPA transcription when known. */
  phonetic?: string
  /** Senses grouped by part of speech — "run" (verb) and "run" (noun) are separate groups. */
  meaningGroups?: LlmMeaningGroup[]
  /** Learner-corpus-style corrections, e.g. "make a photo" → "take a photo". */
  commonMistakes?: LlmCommonMistake[]
  /** Fixed expressions this word commonly appears in, e.g. "heavy rain", "commit a crime". */
  collocations?: string[]
  /** Related words, e.g. run → runner, running, rerun. */
  wordFamily?: string[]
  /** Typo correction: present only when the input is an obvious typo. */
  typo?: LlmTranslationSuggestion
}

/** Vendor-reported token usage, when the API surfaces it. Used by the Latency
 *  Lab benchmark to report `tokensOut` (design doc §9.3) — not persisted or
 *  shown anywhere in the normal translate path. */
export interface LlmUsageMeta {
  promptTokens?: number
  completionTokens?: number
}

export interface LlmTranslationResult {
  /** Provider-specific payload. For GLM this is an {@link LlmTranslationContent}. */
  content: unknown
  meta?: LlmUsageMeta
}

/**
 * "More examples like this" (to-do §3) — a follow-up call scoped to one
 * sense, optionally constrained by topic and/or level, rather than a full
 * translate() request.
 */
export interface LlmMoreExamplesRequest {
  word: string
  sourceLang: string
  targetLang: string
  /** The sense's own definition text, to disambiguate which sense (a word
   *  can have several) the new examples should illustrate. */
  senseDefinition: string
  /** e.g. "football", "business meetings". */
  topic?: string
  /** Constrain generated examples to roughly this level. */
  cefr?: CefrLevel
}

export interface LlmMoreExamplesResult {
  examples: LlmGradedExample[]
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
  moreExamples(req: LlmMoreExamplesRequest): Promise<LlmMoreExamplesResult>
}
