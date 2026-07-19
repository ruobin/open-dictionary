import type { DictionaryEntry } from './dictionary'

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
  /** When fusion mode is active: the secondary provider/model. */
  secondaryProviderId?: string
  secondaryProviderName?: string
  secondaryModel?: string
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

// --- playground (ad-hoc direct LLM lookups, bypasses cache) ---

export interface PlaygroundTargetRequest {
  providerId: string
  modelId?: string
}

export interface PlaygroundRequest {
  targets: PlaygroundTargetRequest[]
  word: string
  sourceLang?: string
  targetLang?: string
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
  entries?: DictionaryEntry[]
  raw?: unknown
}

export interface PlaygroundResponse {
  results: PlaygroundTargetResult[]
}

export function runPlayground(auth: AdminAuth, body: PlaygroundRequest): Promise<PlaygroundResponse> {
  return adminFetch(auth, '/llm/playground', { method: 'POST', body: JSON.stringify(body) })
}

// --- active switch ---

/** `secondary` controls LLM fusion mode:
 *  - `undefined` (omitted): leave any existing secondary as-is.
 *  - `null`: explicitly disable fusion (single-provider mode).
 *  - `{ providerId, modelId? }`: enable fusion with this second provider. */
export interface SetActiveSecondary {
  providerId: string
  modelId?: string
}

export interface SetActiveRequest {
  providerId: string | null
  modelId?: string
  verify?: boolean
  secondary?: SetActiveSecondary | null
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
  | 'entry.delete'
  | 'entry.batch_delete'
  | 'report.dismiss'

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

// --- cache entries (docs/design-admin-cache-entries.md) ---

export type EntryTier = 'llm' | 'dict'
export type EntrySort = 'newest' | 'oldest' | 'mostReported'

export interface EntrySummaryView {
  id: string
  word: string
  sourceLang: string
  targetLang: string
  tier: string
  version: string
  fetchedAt: string
  reportCount: number
  headwordPreview?: string
}

export interface EntryReportView {
  id: string
  reason?: string
  createdAt: string
}

export interface EntryDetailView {
  id: string
  word: string
  sourceLang: string
  targetLang: string
  tier: string
  version: string
  fetchedAt: string
  entries: DictionaryEntry[]
  reports: EntryReportView[]
}

export interface ReportsSummaryEntry {
  word: string
  sourceLang: string
  targetLang: string
  count: number
  lastAt: string
}

export interface ReportsSummary {
  total: number
  byWordCount: ReportsSummaryEntry[]
}

export interface ListEntriesQuery {
  word?: string
  sourceLang?: string
  targetLang?: string
  tier?: EntryTier
  hasReports?: boolean
  sort?: EntrySort
  limit?: number
  before?: string
}

export interface ListEntriesResult {
  entries: EntrySummaryView[]
  hasMore: boolean
}

export interface DeleteEntryRequest {
  resolveReports?: boolean
  reason?: string
}

export interface DeleteEntryResult {
  deleted: boolean
  reportsResolved: number
}

export interface BatchDeleteEntriesRequest {
  ids: string[]
  resolveReports?: boolean
  reason?: string
}

export interface BatchDeleteEntriesResult {
  deletedIds: string[]
  notFoundIds: string[]
  reportsResolved: number
}

export async function listEntries(auth: AdminAuth, query: ListEntriesQuery = {}): Promise<ListEntriesResult> {
  const qs = new URLSearchParams()
  if (query.word) qs.set('word', query.word)
  if (query.sourceLang) qs.set('sourceLang', query.sourceLang)
  if (query.targetLang) qs.set('targetLang', query.targetLang)
  if (query.tier) qs.set('tier', query.tier)
  if (query.hasReports !== undefined) qs.set('hasReports', String(query.hasReports))
  if (query.sort) qs.set('sort', query.sort)
  if (query.limit) qs.set('limit', String(query.limit))
  if (query.before) qs.set('before', query.before)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return adminFetch<ListEntriesResult>(auth, `/entries${suffix}`)
}

/** Resolves `null` on a 404 (entry already deleted, e.g. in another tab) instead of throwing. */
export async function getEntry(auth: AdminAuth, id: string): Promise<EntryDetailView | null> {
  try {
    const data = await adminFetch<{ entry: EntryDetailView }>(auth, `/entries/${encodeURIComponent(id)}`)
    return data.entry
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) return null
    throw err
  }
}

export function deleteEntry(auth: AdminAuth, id: string, body: DeleteEntryRequest = {}): Promise<DeleteEntryResult> {
  return adminFetch(auth, `/entries/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body) })
}

export function batchDeleteEntries(
  auth: AdminAuth,
  body: BatchDeleteEntriesRequest
): Promise<BatchDeleteEntriesResult> {
  return adminFetch(auth, '/entries/batch-delete', { method: 'POST', body: JSON.stringify(body) })
}

export function getReportsSummary(auth: AdminAuth): Promise<ReportsSummary> {
  return adminFetch(auth, '/reports/summary')
}

export interface ReportListItemView {
  id: string
  word: string
  sourceLang: string
  targetLang: string
  version: string
  reason?: string
  createdAt: string
  entryId?: string
}

export interface ListReportsQuery {
  limit?: number
  before?: string
}

export interface ListReportsResult {
  reports: ReportListItemView[]
  hasMore: boolean
}

export async function listReports(auth: AdminAuth, query: ListReportsQuery = {}): Promise<ListReportsResult> {
  const qs = new URLSearchParams()
  if (query.limit) qs.set('limit', String(query.limit))
  if (query.before) qs.set('before', query.before)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return adminFetch<ListReportsResult>(auth, `/reports${suffix}`)
}

export function dismissReport(auth: AdminAuth, id: string): Promise<void> {
  return adminFetch(auth, `/reports/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// --- user activity log (docs/design-user-activity-log.md) ---

export type ActivityTier = 'cache' | 'llm' | 'dictionary' | 'client-cache'
export type ActivityChannel = 'web' | 'extension' | 'other'

export interface ActivityLogView {
  id: string
  ts: string
  word: string
  sourceLang: string
  targetLang: string
  tier: ActivityTier
  latencyMs: number
  ip: string
  channel: ActivityChannel
  device: { type: string; browser?: string; os?: string }
}

export interface ActivitySummary {
  windowDays: number
  totalLookups: number
  uniqueIps: number
  byTier: Record<string, number>
  byChannel: Record<string, number>
  byDeviceType: Record<string, number>
  topWords: { word: string; count: number }[]
  dailyCounts: { date: string; count: number }[]
}

export interface ListActivityQuery {
  word?: string
  tier?: ActivityTier
  channel?: ActivityChannel
  deviceType?: string
  limit?: number
  before?: string
}

export interface ListActivityResult {
  entries: ActivityLogView[]
  hasMore: boolean
}

export async function listActivity(auth: AdminAuth, query: ListActivityQuery = {}): Promise<ListActivityResult> {
  const qs = new URLSearchParams()
  if (query.word) qs.set('word', query.word)
  if (query.tier) qs.set('tier', query.tier)
  if (query.channel) qs.set('channel', query.channel)
  if (query.deviceType) qs.set('deviceType', query.deviceType)
  if (query.limit) qs.set('limit', String(query.limit))
  if (query.before) qs.set('before', query.before)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return adminFetch<ListActivityResult>(auth, `/activity${suffix}`)
}

export function getActivitySummary(auth: AdminAuth, days?: number): Promise<ActivitySummary> {
  const suffix = days ? `?days=${days}` : ''
  return adminFetch(auth, `/activity/summary${suffix}`)
}
