import { randomBytes } from 'crypto'
import { ObjectId, type Db } from 'mongodb'
import { getMongoDb } from '../db'
import { redactVendorErrorBody } from './crypto'
import { recordAudit as defaultRecordAudit } from './audit'
import { getProviderDoc as defaultGetProviderDoc, providerToLlmConfig, MongoUnavailableError, type LlmProviderDoc } from './providersRepo'
import { buildLlmProvider, LlmProviderError, type LlmProvider, type LlmProviderConfig } from '../providers/llm'

/**
 * On-demand benchmark job runner — the Latency Lab's main event (design doc
 * §9.3). Jobs run in-process (no queue infra): a single global in-memory job
 * record is polled by the UI; the final document lands in `llm_benchmarks`
 * on completion. A server restart loses the in-flight job — the poll then
 * 404s and the UI shows "run lost (server restarted)", an accepted
 * simplification for an admin tool (§9.3).
 *
 * Isolation (§9.5): targets are built with `buildLlmProvider` directly —
 * ephemeral instances never touch the translation cache, production
 * metrics, or `LlmService.current()`. A target may be a provider that's
 * `enabled: false` for production use; that's the point of a benchmark.
 */

// --- Cost guardrails (§9.7) ---
const MAX_SAMPLES = 10
const MAX_CUSTOM_WORDS = 10
const MAX_WORD_LEN = 64
// Not explicitly specified by the design doc — a defensive bound so a
// malformed/malicious request can't fan out into an unbounded number of
// concurrent vendor calls. Generous relative to every documented example
// (compare mode uses 2).
const MAX_TARGETS = 10
const TARGET_CALL_GAP_MS = 250

const CANONICAL_WORDS = ['run', 'serendipity', 'take off', 'bank', 'ephemeral']
const DEFAULT_SAMPLES = 5
// §17 Q3 confirmed: en→en is a representative-enough default; the word list
// (and, per the request shape, the language pair) remains configurable.
const DEFAULT_LANG = 'en'

function requireDb(): Db {
  const db = getMongoDb()
  if (!db) throw new MongoUnavailableError()
  return db
}

function benchmarksCol(db: Db) {
  return db.collection<BenchmarkDoc>('llm_benchmarks')
}

// --- Types ---

export interface BenchmarkTargetRequest {
  providerId: string
  modelId?: string
}

export interface ValidatedBenchmarkRequest {
  targets: BenchmarkTargetRequest[]
  samples: number
  words: string[]
  sourceLang: string
  targetLang: string
}

export interface BenchmarkRunRecord {
  word: string
  ms: number
  ok: boolean
  errorCode: string | null
  tokensOut?: number
}

export interface BenchmarkTargetSummary {
  p50: number
  mean: number
  min: number
  max: number
  successRate: number
}

/** `providerId` is a plain string here — used for both live job polling and the Mongo doc's embedded view. */
export interface BenchmarkTargetResult {
  providerId: string
  providerName: string
  vendor: string
  model: string
  runs: BenchmarkRunRecord[]
  summary: BenchmarkTargetSummary
}

export interface BenchmarkParams {
  samples: number
  words: string[]
  sourceLang: string
  targetLang: string
}

interface BenchmarkTargetResultDoc extends Omit<BenchmarkTargetResult, 'providerId'> {
  providerId: ObjectId
}

/** Persisted shape (§4.3). `targets.providerId` is a real ObjectId — matches the `llm_benchmarks_provider` index in server/db.ts. */
export interface BenchmarkDoc {
  _id: ObjectId
  runId: string
  requestedBy: string
  startedAt: Date
  finishedAt: Date
  params: BenchmarkParams
  targets: BenchmarkTargetResultDoc[]
}

export interface BenchmarkHistoryView {
  runId: string
  requestedBy: string
  startedAt: string
  finishedAt: string
  params: BenchmarkParams
  targets: BenchmarkTargetResult[]
}

export type BenchmarkJobStatus = 'running' | 'done' | 'error'

export interface BenchmarkJob {
  runId: string
  status: BenchmarkJobStatus
  total: number
  completed: number
  partial: BenchmarkTargetResult[]
  error?: string
}

// --- Validation (§9.3, §9.7) — pure, unit-tested without touching Mongo ---

export type ValidationResult =
  | { ok: true; value: ValidatedBenchmarkRequest }
  | { ok: false; errors: string[] }

export function validateBenchmarkRequest(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['body must be an object'] }
  const b = input as Record<string, unknown>

  const targets: BenchmarkTargetRequest[] = []
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

  let samples = DEFAULT_SAMPLES
  if (b.samples !== undefined) {
    const n = Number(b.samples)
    if (!Number.isInteger(n) || n < 1 || n > MAX_SAMPLES) {
      errors.push(`samples must be an integer from 1 to ${MAX_SAMPLES}`)
    } else {
      samples = n
    }
  }

  let words = CANONICAL_WORDS
  if (b.words !== undefined && b.words !== null) {
    if (!Array.isArray(b.words) || b.words.length === 0) {
      errors.push('words, if provided, must be a non-empty array')
    } else if (b.words.length > MAX_CUSTOM_WORDS) {
      errors.push(`words must have at most ${MAX_CUSTOM_WORDS} entries`)
    } else {
      const cleaned: string[] = []
      b.words.forEach((w, i) => {
        const s = typeof w === 'string' ? w.trim() : ''
        if (!s || s.length > MAX_WORD_LEN) {
          errors.push(`words[${i}] must be 1-${MAX_WORD_LEN} chars`)
          return
        }
        cleaned.push(s)
      })
      if (errors.length === 0) words = cleaned
    }
  }

  const sourceLang =
    typeof b.sourceLang === 'string' && b.sourceLang.trim() ? b.sourceLang.trim().toLowerCase() : DEFAULT_LANG
  const targetLang =
    typeof b.targetLang === 'string' && b.targetLang.trim() ? b.targetLang.trim().toLowerCase() : DEFAULT_LANG

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { targets, samples, words, sourceLang, targetLang } }
}

// --- Pure stats (unit-tested) ---

/**
 * p50/mean/min/max are computed over successful calls only — a timed-out
 * call's `ms` clusters at the target's timeoutMs and would badly distort
 * "how fast is this provider"; `successRate` is the correct signal for
 * reliability instead. If every call failed, all four are reported as 0
 * (not NaN) so the field stays a plain number.
 */
export function summarize(runs: BenchmarkRunRecord[]): BenchmarkTargetSummary {
  const okMs = runs
    .filter((r) => r.ok)
    .map((r) => r.ms)
    .sort((a, b) => a - b)
  const successRate = runs.length > 0 ? okMs.length / runs.length : 0
  if (okMs.length === 0) return { p50: 0, mean: 0, min: 0, max: 0, successRate }

  const mid = Math.floor(okMs.length / 2)
  const p50 = okMs.length % 2 === 0 ? Math.round((okMs[mid - 1] + okMs[mid]) / 2) : okMs[mid]
  const mean = Math.round(okMs.reduce((sum, ms) => sum + ms, 0) / okMs.length)
  return { p50, mean, min: okMs[0], max: okMs[okMs.length - 1], successRate }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveModelId(doc: LlmProviderDoc, modelId?: string): string {
  const match = modelId ? doc.models.find((m) => m.id === modelId) : undefined
  return match?.id ?? doc.models.find((m) => m.isDefault)?.id ?? doc.models[0]?.id ?? 'unknown'
}

// --- Job execution ---

export interface BenchmarkDeps {
  getProviderDoc: (id: string) => Promise<LlmProviderDoc | null>
  /** Defaults to `buildLlmProvider` directly — identical to what `LlmService.buildEphemeral()` delegates to. */
  buildEphemeral: (cfg: LlmProviderConfig) => LlmProvider
  saveBenchmark: (doc: BenchmarkDoc) => Promise<void>
  recordAudit: typeof defaultRecordAudit
  sleepMs: (ms: number) => Promise<void>
}

async function defaultSaveBenchmark(doc: BenchmarkDoc): Promise<void> {
  const db = requireDb()
  await benchmarksCol(db).insertOne(doc)
}

const defaultDeps: BenchmarkDeps = {
  getProviderDoc: defaultGetProviderDoc,
  buildEphemeral: buildLlmProvider,
  saveBenchmark: defaultSaveBenchmark,
  recordAudit: defaultRecordAudit,
  sleepMs: sleep,
}

export type StartBenchmarkResult =
  | { ok: true; runId: string; total: number }
  | { ok: false; error: 'in_progress' }
  | { ok: false; error: 'target_not_found'; providerId: string }
  | { ok: false; error: 'unknown_model'; providerId: string; modelId: string }

let currentJob: BenchmarkJob | null = null

/** Only ever one job in flight (global mutex, §9.3) — polling never needs more than the current/most recent run. */
export function getBenchmarkJob(runId: string): BenchmarkJob | undefined {
  return currentJob?.runId === runId ? currentJob : undefined
}

export async function startBenchmark(
  req: ValidatedBenchmarkRequest,
  actorSub: string,
  ip: string,
  deps: BenchmarkDeps = defaultDeps
): Promise<StartBenchmarkResult> {
  if (currentJob?.status === 'running') return { ok: false, error: 'in_progress' }

  const resolved: { doc: LlmProviderDoc; modelId?: string }[] = []
  for (const t of req.targets) {
    const doc = await deps.getProviderDoc(t.providerId)
    if (!doc) return { ok: false, error: 'target_not_found', providerId: t.providerId }
    if (t.modelId && !doc.models.some((m) => m.id === t.modelId)) {
      return { ok: false, error: 'unknown_model', providerId: t.providerId, modelId: t.modelId }
    }
    resolved.push({ doc, modelId: t.modelId })
  }

  const runId = `bm_${randomBytes(3).toString('hex')}`
  currentJob = { runId, status: 'running', total: resolved.length, completed: 0, partial: [] }
  const startedAt = new Date()

  void executeBenchmark(runId, resolved, req, actorSub, ip, startedAt, deps)

  return { ok: true, runId, total: resolved.length }
}

async function runOneTarget(
  doc: LlmProviderDoc,
  modelId: string | undefined,
  req: ValidatedBenchmarkRequest,
  deps: BenchmarkDeps
): Promise<BenchmarkTargetResult> {
  const resolvedModelId = resolveModelId(doc, modelId)

  let provider: LlmProvider
  try {
    const cfg = providerToLlmConfig(doc, modelId)
    provider = deps.buildEphemeral(cfg)
  } catch (err) {
    const detail = err instanceof LlmProviderError ? err.message : String(err)
    const errorCode = err instanceof LlmProviderError ? err.code : 'not_configured'
    console.error(`[benchmark] target "${doc.name}" failed to build: ${redactVendorErrorBody(detail)}`)
    // Every planned sample is recorded as a failure with this errorCode —
    // consistent with a real call failing every time (§9.3: "error rate is itself a result").
    const runs: BenchmarkRunRecord[] = Array.from({ length: req.samples }, (_, i) => ({
      word: req.words[i % req.words.length],
      ms: 0,
      ok: false,
      errorCode,
    }))
    return {
      providerId: doc._id.toHexString(),
      providerName: doc.name,
      vendor: doc.vendor,
      model: resolvedModelId,
      runs,
      summary: summarize(runs),
    }
  }

  const runs: BenchmarkRunRecord[] = []
  for (let i = 0; i < req.samples; i++) {
    const word = req.words[i % req.words.length]
    const callStart = Date.now()
    try {
      const result = await provider.translate({ text: word, sourceLang: req.sourceLang, targetLang: req.targetLang })
      runs.push({
        word,
        ms: Date.now() - callStart,
        ok: true,
        errorCode: null,
        tokensOut: result.meta?.completionTokens,
      })
    } catch (err) {
      const ms = Date.now() - callStart
      const errorCode = err instanceof LlmProviderError ? err.code : 'network'
      const detail = err instanceof LlmProviderError ? err.message : String(err)
      console.error(`[benchmark] "${doc.name}" call failed on "${word}": ${redactVendorErrorBody(detail)}`)
      runs.push({ word, ms, ok: false, errorCode })
    }
    if (i < req.samples - 1) await deps.sleepMs(TARGET_CALL_GAP_MS)
  }

  return {
    providerId: doc._id.toHexString(),
    providerName: doc.name,
    vendor: doc.vendor,
    model: resolvedModelId,
    runs,
    summary: summarize(runs),
  }
}

async function executeBenchmark(
  runId: string,
  resolved: { doc: LlmProviderDoc; modelId?: string }[],
  req: ValidatedBenchmarkRequest,
  actorSub: string,
  ip: string,
  startedAt: Date,
  deps: BenchmarkDeps
): Promise<void> {
  try {
    // Sequential-per-target (paced inside runOneTarget), parallel-across-targets (§9.3) —
    // different vendors don't share rate limits, so wall time ≈ the slowest target.
    const results = await Promise.all(
      resolved.map(async ({ doc, modelId }) => {
        const result = await runOneTarget(doc, modelId, req, deps)
        if (currentJob?.runId === runId) {
          currentJob.partial = [...currentJob.partial, result]
          currentJob.completed += 1
        }
        return result
      })
    )

    const finishedAt = new Date()
    const benchmarkDoc: BenchmarkDoc = {
      _id: new ObjectId(),
      runId,
      requestedBy: actorSub,
      startedAt,
      finishedAt,
      params: { samples: req.samples, words: req.words, sourceLang: req.sourceLang, targetLang: req.targetLang },
      targets: results.map((r) => ({ ...r, providerId: new ObjectId(r.providerId) })),
    }

    try {
      await deps.saveBenchmark(benchmarkDoc)
    } catch (err) {
      console.error(`[benchmark] failed to persist run ${runId}:`, err)
    }

    // The router pattern elsewhere (providersRepo mutations) leaves auditing
    // to the caller, but this job outlives the HTTP request that started it —
    // this is the only code still alive when the run actually finishes, so
    // it owns the `benchmark.run` audit entry itself.
    try {
      await deps.recordAudit({
        actor: actorSub,
        ip,
        action: 'benchmark.run',
        target: { runId },
        diff: {
          params: benchmarkDoc.params,
          targets: results.map((r) => ({ providerId: r.providerId, providerName: r.providerName, summary: r.summary })),
        },
      })
    } catch (err) {
      console.error(`[benchmark] failed to record audit for run ${runId}:`, err)
    }

    if (currentJob?.runId === runId) {
      currentJob.status = 'done'
      currentJob.partial = results
      currentJob.completed = results.length
    }
  } catch (err) {
    console.error(`[benchmark] run ${runId} failed:`, err)
    if (currentJob?.runId === runId) {
      currentJob.status = 'error'
      currentJob.error = err instanceof Error ? err.message : String(err)
    }
  }
}

// --- History (Mongo read) ---

export interface ListBenchmarkHistoryOptions {
  providerId?: string
  limit?: number
}

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100

function toHistoryView(doc: BenchmarkDoc): BenchmarkHistoryView {
  return {
    runId: doc.runId,
    requestedBy: doc.requestedBy,
    startedAt: doc.startedAt.toISOString(),
    finishedAt: doc.finishedAt.toISOString(),
    params: doc.params,
    targets: doc.targets.map((t) => ({ ...t, providerId: t.providerId.toHexString() })),
  }
}

/** Parses `GET /api/admin/llm/benchmarks?providerId&limit` query params — pure, unit-tested without Mongo. */
export function parseHistoryQuery(query: Record<string, unknown>): ListBenchmarkHistoryOptions {
  const options: ListBenchmarkHistoryOptions = {}
  if (typeof query.providerId === 'string' && ObjectId.isValid(query.providerId)) {
    options.providerId = query.providerId
  }
  if (typeof query.limit === 'string' && query.limit.trim()) {
    const n = Number(query.limit)
    if (Number.isFinite(n) && n > 0) options.limit = Math.floor(n)
  }
  return options
}

export async function listBenchmarkHistory(options: ListBenchmarkHistoryOptions = {}): Promise<BenchmarkHistoryView[]> {
  const db = requireDb()
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT)
  const filter: Record<string, unknown> = {}
  if (options.providerId) filter['targets.providerId'] = new ObjectId(options.providerId)
  const docs = await benchmarksCol(db).find(filter).sort({ finishedAt: -1 }).limit(limit).toArray()
  return docs.map(toHistoryView)
}
