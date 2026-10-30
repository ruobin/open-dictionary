import { LlmProviderError } from './types'

/**
 * Latency-oriented request tuning (reasoning off, output caps) that not every
 * model accepts. Each vendor supplies an ordered "ladder" of extra request-body
 * variants, most aggressive first, ending in `{}` (plain request). A variant the
 * model rejects with HTTP 400/422 steps down to the next one; the first variant
 * that succeeds is remembered so later requests start there instead of paying
 * for a rejected round trip every time.
 *
 * The index is only advanced after a lower step actually succeeds, so an
 * unrelated 400 (e.g. a content-filter rejection) cannot permanently downgrade
 * the provider.
 */
export interface VariantLadder {
  run<T>(fn: (extraBody: Record<string, unknown>) => Promise<T>): Promise<T>
  /** Index of the variant currently preferred (exposed for tests/diagnostics). */
  readonly current: number
}

const STEP_DOWN_STATUSES = new Set([400, 422])

export function createVariantLadder(variants: Array<Record<string, unknown>>): VariantLadder {
  const ladder = variants.length > 0 ? variants : [{}]
  let preferred = 0

  return {
    get current() {
      return preferred
    },
    async run<T>(fn: (extraBody: Record<string, unknown>) => Promise<T>): Promise<T> {
      let lastError: unknown
      for (let i = preferred; i < ladder.length; i += 1) {
        try {
          const result = await fn(ladder[i])
          if (i > preferred) preferred = i
          return result
        } catch (err) {
          lastError = err
          const canStepDown =
            err instanceof LlmProviderError &&
            err.code === 'api_error' &&
            err.status !== undefined &&
            STEP_DOWN_STATUSES.has(err.status) &&
            i < ladder.length - 1
          if (!canStepDown) throw err
        }
      }
      throw lastError
    },
  }
}

/** Keys an admin-supplied `requestBody` may never set — the adapter owns these. */
export const RESERVED_REQUEST_KEYS = new Set([
  'model',
  'messages',
  'system',
  'input',
  'stream',
  'tools',
  'tool_choice',
  'response_format',
  'text',
  'n',
])

/** Request fields that control reasoning; if an admin sets any, the built-in
 *  reasoning defaults are not applied on top. */
const REASONING_KEYS = ['thinking', 'reasoning', 'reasoning_effort', 'enable_thinking']

export function hasReasoningOverride(body: Record<string, unknown> | undefined): boolean {
  return !!body && REASONING_KEYS.some((k) => k in body)
}

/**
 * Builds the ladder for a provider: admin `requestBody` always wins and is sent
 * on every rung; the vendor's reasoning-off rungs are used only when the admin
 * has not taken control of reasoning themselves.
 */
export function buildLadder(
  vendorRungs: Array<Record<string, unknown>>,
  adminBody: Record<string, unknown> | undefined
): VariantLadder {
  const admin = adminBody ?? {}
  if (hasReasoningOverride(admin)) return createVariantLadder([{ ...admin }])
  return createVariantLadder(vendorRungs.map((rung) => ({ ...rung, ...admin })))
}

/** Generous runaway guard — reasoning tokens (if a model ignores "off") count
 *  against this on several vendors, so it must not be tight. */
export const CORE_MAX_TOKENS = 4096
export const EXTRAS_MAX_TOKENS = 2048

/** Reasoning-off rungs per vendor. Sources: DeepSeek/Z.AI `thinking` toggle,
 *  OpenRouter unified `reasoning`, OpenAI-style `reasoning.effort`. */
export const DEEPSEEK_RUNGS: Array<Record<string, unknown>> = [{ thinking: { type: 'disabled' } }, {}]
export const GLM_RUNGS: Array<Record<string, unknown>> = [{ thinking: { type: 'disabled' } }, {}]
export const OPENROUTER_RUNGS: Array<Record<string, unknown>> = [
  { reasoning: { effort: 'none' } },
  { reasoning: { effort: 'minimal' } },
  {},
]
export const RESPONSES_RUNGS: Array<Record<string, unknown>> = [
  { reasoning: { effort: 'none' } },
  { reasoning: { effort: 'low' } },
  {},
]
