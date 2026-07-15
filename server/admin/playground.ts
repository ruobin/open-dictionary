import { LANGUAGES } from '../../shared/languages'
import {
  getProviderDoc as defaultGetProviderDoc,
  providerToLlmConfig,
  type LlmProviderDoc,
} from './providersRepo'
import {
  buildLlmProvider,
  DEFAULT_TIMEOUT_MS,
  LlmProviderError,
  type LlmProvider,
  type LlmProviderConfig,
  type LlmTranslationContent,
} from '../providers/llm'
import { adaptLlm, type DictionaryEntry } from '../translate'

/**
 * Admin "Playground" — a single ad-hoc, direct LLM call per selected
 * provider/model, bypassing the translation cache entirely (unlike the
 * normal /translate path) so an admin can compare raw model output
 * side-by-side before promoting one via `PUT /llm/active`.
 *
 * Isolation mirrors the Latency Lab benchmark (server/admin/benchmark.ts,
 * design doc §9.5): targets are built with `buildLlmProvider` directly (or
 * `LlmService.buildEphemeral()` from the router) — never `LlmService.current()` —
 * so a lookup here never touches the translation cache, production metrics,
 * or the active provider. Unlike benchmarks, results are not persisted to
 * Mongo (this is a one-shot comparison tool, not a history/trend feature)
 * and every target runs in parallel (a single call per target, not a
 * sample loop), so there's no need for the job-polling infrastructure the
 * Latency Lab uses.
 */

// --- Cost guardrails, same spirit as benchmark.ts §9.7 ---
const MAX_TARGETS = 6
const MAX_WORD_LEN = 128
const PLAYGROUND_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
const DEFAULT_LANG = 'en'

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))

// --- Types ---

export interface PlaygroundTargetRequest {
  providerId: string
  modelId?: string
}

export interface ValidatedPlaygroundRequest {
  targets: PlaygroundTargetRequest[]
  word: string
  sourceLang: string
  targetLang: string
}

export interface PlaygroundTargetResult {
  providerId: string
  providerName: string
  vendor: string
  model: string
  ok: boolean
  ms: number
  errorCode?: string
  tokensOut?: number
  /** Adapted into the same render shape the public /translate route returns — reuses <WordEntry> as-is. */
  entries?: DictionaryEntry[]
  /** The raw, unadapted LLM payload — shown as a "Raw JSON" toggle in the admin UI. */
  raw?: unknown
}

// --- Validation (pure, unit-tested without touching Mongo) ---

export type ValidationResult =
  | { ok: true; value: ValidatedPlaygroundRequest }
  | { ok: false; errors: string[] }

export function validatePlaygroundRequest(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['body must be an object'] }
  const b = input as Record<string, unknown>

  const targets: PlaygroundTargetRequest[] = []
  if (!Array.isArray(b.targets) || b.targets.length === 0) {
    errors.push('targets must be a non-empty array')
  } else if (b.targets.length > MAX_TARGETS) {
    errors.push(`targets must have at most ${MAX_TARGETS} entries`)
  } else {
    b.targets.forEach((t, i) => {
      if (!t || typeof t !== 'object') {
        errors.push(`targets[${i}] must be an object`)
        return
      }
      const to = t as Record<string, unknown>
      const providerId = typeof to.providerId === 'string' ? to.providerId.trim() : ''
      if (!providerId) {
        errors.push(`targets[${i}].providerId is required`)
        return
      }
      const modelId = typeof to.modelId === 'string' && to.modelId.trim() ? to.modelId.trim() : undefined
      targets.push({ providerId, modelId })
    })
  }

  const word = typeof b.word === 'string' ? b.word.trim() : ''
  if (!word || word.length > MAX_WORD_LEN) {
    errors.push(`word must be 1-${MAX_WORD_LEN} chars`)
  }

  const sourceLang =
    typeof b.sourceLang === 'string' && b.sourceLang.trim() ? b.sourceLang.trim().toLowerCase() : DEFAULT_LANG
  const targetLang =
    typeof b.targetLang === 'string' && b.targetLang.trim() ? b.targetLang.trim().toLowerCase() : DEFAULT_LANG
  if (!LANGUAGE_CODES.has(sourceLang)) errors.push(`sourceLang "${sourceLang}" is not a supported language code`)
  if (!LANGUAGE_CODES.has(targetLang)) errors.push(`targetLang "${targetLang}" is not a supported language code`)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { targets, word, sourceLang, targetLang } }
}

// --- Execution ---

export interface PlaygroundDeps {
  getProviderDoc: (id: string) => Promise<LlmProviderDoc | null>
  /** Defaults to `buildLlmProvider` directly — the router passes `LlmService.buildEphemeral()` instead. */
  buildEphemeral: (cfg: LlmProviderConfig) => LlmProvider
}

const defaultDeps: PlaygroundDeps = {
  getProviderDoc: defaultGetProviderDoc,
  buildEphemeral: buildLlmProvider,
}

export type RunPlaygroundResult =
  | { ok: true; results: PlaygroundTargetResult[] }
  | { ok: false; error: 'target_not_found'; providerId: string }
  | { ok: false; error: 'unknown_model'; providerId: string; modelId: string }

function resolveModelId(doc: LlmProviderDoc, modelId?: string): string {
  const match = modelId ? doc.models.find((m) => m.id === modelId) : undefined
  return match?.id ?? doc.models.find((m) => m.isDefault)?.id ?? doc.models[0]?.id ?? 'unknown'
}

async function runOneTarget(
  doc: LlmProviderDoc,
  modelId: string | undefined,
  req: ValidatedPlaygroundRequest,
  deps: PlaygroundDeps
): Promise<PlaygroundTargetResult> {
  const base = {
    providerId: doc._id.toHexString(),
    providerName: doc.name,
    vendor: doc.vendor,
    model: resolveModelId(doc, modelId),
  }

  let provider: LlmProvider
  try {
    const cfg = providerToLlmConfig(doc, modelId)
    const capped = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs ?? PLAYGROUND_TIMEOUT_MS, PLAYGROUND_TIMEOUT_MS) }
    provider = deps.buildEphemeral(capped)
  } catch (err) {
    const errorCode = err instanceof LlmProviderError ? err.code : 'not_configured'
    return { ...base, ok: false, ms: 0, errorCode }
  }

  const started = Date.now()
  try {
    const result = await provider.translate({ text: req.word, sourceLang: req.sourceLang, targetLang: req.targetLang })
    const ms = Date.now() - started
    const content = result.content as LlmTranslationContent
    return { ...base, ok: true, ms, entries: adaptLlm(content), raw: content, tokensOut: result.meta?.completionTokens }
  } catch (err) {
    const ms = Date.now() - started
    const errorCode = err instanceof LlmProviderError ? err.code : 'network'
    return { ...base, ok: false, ms, errorCode }
  }
}

/** Runs one direct LLM call per target, in parallel — no cache, no metrics, no persistence. */
export async function runPlayground(
  req: ValidatedPlaygroundRequest,
  deps: PlaygroundDeps = defaultDeps
): Promise<RunPlaygroundResult> {
  const resolved: { doc: LlmProviderDoc; modelId?: string }[] = []
  for (const t of req.targets) {
    const doc = await deps.getProviderDoc(t.providerId)
    if (!doc) return { ok: false, error: 'target_not_found', providerId: t.providerId }
    if (t.modelId && !doc.models.some((m) => m.id === t.modelId)) {
      return { ok: false, error: 'unknown_model', providerId: t.providerId, modelId: t.modelId }
    }
    resolved.push({ doc, modelId: t.modelId })
  }

  const results = await Promise.all(resolved.map(({ doc, modelId }) => runOneTarget(doc, modelId, req, deps)))
  return { ok: true, results }
}
