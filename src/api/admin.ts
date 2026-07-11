export interface AdminAuth {
  getAccessToken: () => Promise<string>
}

export class AdminApiError extends Error {
  status: number
  code: string
  errors?: string[]
  constructor(status: number, code: string, errors?: string[]) {
    super(errors && errors.length > 0 ? errors.join('; ') : code)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
    this.errors = errors
  }
}

// --- status & metrics ---

export type LlmServiceSource = 'env' | 'db'
export type LlmServiceStatus = 'active' | 'disabled' | 'misconfigured'

export interface LlmServiceState {
  source: LlmServiceSource
  status: LlmServiceStatus
  message: string
  providerId?: string
  providerName?: string
  vendor?: string
  model?: string
  id?: string
  configVersion?: number
  appliedAt: string
}

export interface AdminLlmStatus extends LlmServiceState {
  uptimeSec: number
}

export interface LlmLatencyStats {
  p50: number
  p95: number
  p99: number
  count: number
  windowSize: number
}

export interface MetricsSnapshot {
  totalLookups: number
  outcomeByTier: Record<string, number>
  llmErrorsByVendorAndCode: Record<string, number>
  llmAvgLatencyMsByVendor: Record<string, number>
  llmLatencyByVendor: Record<string, LlmLatencyStats>
  dictFallbackUsed: number
  dictErrors: number
  fallbackRate: number
}

// --- providers ---

export interface MaskedSecret {
  set: true
  last4: string
}

export interface ProviderModel {
  id: string
  label?: string
  isDefault: boolean
  timeoutMs?: number
  temperature?: number
}

export interface ProviderView {
  id: string
  name: string
  vendor: string
  baseUrl?: string
  headers?: Record<string, string>
  apiKey: MaskedSecret
  models: ProviderModel[]
  enabled: boolean
  lastTest?: { at: string; ok: boolean; ms: number; errorCode?: string | null }
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export interface ProviderModelInput {
  id: string
  label?: string
  isDefault?: boolean
  timeoutMs?: number
  temperature?: number
}

export interface ProviderFormInput {
  name: string
  vendor: string
  baseUrl?: string
  headers?: Record<string, string>
  models: ProviderModelInput[]
  enabled?: boolean
}

export interface ProviderCreateInput extends ProviderFormInput {
  apiKey: string
}

/** `apiKey` absent or `null` keeps the stored key; a non-empty string replaces it. */
export interface ProviderUpdateInput extends ProviderFormInput {
  apiKey?: string | null
}

// --- connection test ---

export type TestConnectionRequest =
  | { providerId: string; modelId?: string }
  | { vendor: string; apiKey: string; model: string; baseUrl?: string }

export interface TestConnectionResult {
  ok: boolean
  ms: number
  errorCode?: string
  providerIdEcho?: string
}

// --- benchmark ---

export interface BenchmarkTargetRequest {
  providerId: string
  modelId?: string
}

export interface BenchmarkRequest {
  targets: BenchmarkTargetRequest[]
  samples?: number
  words?: string[]
  sourceLang?: string
  targetLang?: string
}

export interface StartBenchmarkResponse {
  runId: string
  total: number
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

export interface BenchmarkTargetResult {
  providerId: string
  providerName: string
  vendor: string
  model: string
  runs: BenchmarkRunRecord[]
  summary: BenchmarkTargetSummary
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

export interface BenchmarkParams {
  samples: number
  words: string[]
  sourceLang: string
  targetLang: string
}

export interface BenchmarkHistoryView {
  runId: string
  requestedBy: string
  startedAt: string
  finishedAt: string
  params: BenchmarkParams
  targets: BenchmarkTargetResult[]
}

export interface ListBenchmarkHistoryQuery {
  providerId?: string
  limit?: number
}

// --- active switch ---

export interface SetActiveRequest {
  providerId: string | null
  modelId?: string
  verify?: boolean
}

export interface SetActiveResponse {
  status: LlmServiceState
}

// --- env import ---

export interface ImportEnvResponse {
  imported: ProviderView[]
  skipped: string[]
}

// --- audit ---

export type AdminAuditAction =
  | 'provider.create'
  | 'provider.update'
  | 'provider.delete'
  | 'active.switch'
  | 'benchmark.run'
  | 'env.import'

export interface AuditTarget {
  providerId?: string
  name?: string
  runId?: string
}

export interface AuditEntry {
  id: string
  ts: string
  actor: string
  ip: string
  action: AdminAuditAction
  target?: AuditTarget
  diff?: Record<string, unknown>
}

export interface ListAuditQuery {
  limit?: number
  before?: string
}

async function adminFetch<T>(auth: AdminAuth, path: string, init?: RequestInit): Promise<T> {
  const token = await auth.getAccessToken()
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (res.status === 204) return undefined as T

  let body: unknown = undefined
  try {
    body = await res.json()
  } catch {
    // Non-JSON body (e.g. an upstream proxy error page) — fall through to the status-based error below.
  }

  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; errors?: string[] }
    throw new AdminApiError(res.status, b.error ?? `http_${res.status}`, b.errors)
  }

  return body as T
}

export function getStatus(auth: AdminAuth): Promise<AdminLlmStatus> {
  return adminFetch(auth, '/llm/status')
}

export function getMetrics(auth: AdminAuth): Promise<MetricsSnapshot> {
  return adminFetch(auth, '/metrics')
}

export async function listProviders(auth: AdminAuth): Promise<ProviderView[]> {
  const data = await adminFetch<{ providers: ProviderView[] }>(auth, '/llm/providers')
  return data.providers
}

export async function createProvider(auth: AdminAuth, input: ProviderCreateInput): Promise<ProviderView> {
  const data = await adminFetch<{ provider: ProviderView }>(auth, '/llm/providers', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.provider
}

export async function updateProvider(
  auth: AdminAuth,
  id: string,
  input: ProviderUpdateInput
): Promise<ProviderView> {
  const data = await adminFetch<{ provider: ProviderView }>(auth, `/llm/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return data.provider
}

export function deleteProvider(auth: AdminAuth, id: string): Promise<void> {
  return adminFetch(auth, `/llm/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testConnection(auth: AdminAuth, body: TestConnectionRequest): Promise<TestConnectionResult> {
  return adminFetch(auth, '/llm/test', { method: 'POST', body: JSON.stringify(body) })
}

export function startBenchmark(auth: AdminAuth, body: BenchmarkRequest): Promise<StartBenchmarkResponse> {
  return adminFetch(auth, '/llm/benchmark', { method: 'POST', body: JSON.stringify(body) })
}

/** Resolves `null` on a 404 (job finished/lost, e.g. after a server restart) instead of throwing — pollers treat that as a terminal state. */
export async function getBenchmarkJob(auth: AdminAuth, runId: string): Promise<BenchmarkJob | null> {
  try {
    return await adminFetch<BenchmarkJob>(auth, `/llm/benchmark/${encodeURIComponent(runId)}`)
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) return null
    throw err
  }
}

export async function listBenchmarkHistory(
  auth: AdminAuth,
  query: ListBenchmarkHistoryQuery = {}
): Promise<BenchmarkHistoryView[]> {
  const qs = new URLSearchParams()
  if (query.providerId) qs.set('providerId', query.providerId)
  if (query.limit) qs.set('limit', String(query.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const data = await adminFetch<{ benchmarks: BenchmarkHistoryView[] }>(auth, `/llm/benchmarks${suffix}`)
  return data.benchmarks
}

export function setActive(auth: AdminAuth, body: SetActiveRequest): Promise<SetActiveResponse> {
  return adminFetch(auth, '/llm/active', { method: 'PUT', body: JSON.stringify(body) })
}

export function importEnv(auth: AdminAuth): Promise<ImportEnvResponse> {
  return adminFetch(auth, '/llm/import-env', { method: 'POST' })
}

export async function listAudit(auth: AdminAuth, query: ListAuditQuery = {}): Promise<AuditEntry[]> {
  const qs = new URLSearchParams()
  if (query.limit) qs.set('limit', String(query.limit))
  if (query.before) qs.set('before', query.before)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const data = await adminFetch<{ entries: AuditEntry[] }>(auth, `/audit${suffix}`)
  return data.entries
}
