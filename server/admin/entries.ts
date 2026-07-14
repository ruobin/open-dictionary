import { ObjectId, type Db } from 'mongodb'
import { getMongoDb } from '../db'
import { MongoUnavailableError } from './providersRepo'
import { escapeRegex } from '../util/regex'
import { LANGUAGES } from '../../shared/languages'
import type { TranslationDoc } from '../cache/translationCache'
import type { DictionaryEntry } from '../translate'

/**
 * Backing module for the admin "Cache Entries" screen
 * (docs/design-admin-cache-entries.md). Read/delete only against the
 * existing `translations` + `reports` collections — no new collections, no
 * schema change. Follows the same shape as `server/admin/providersRepo.ts`:
 * pure/unit-testable validation & join functions, separate Mongo I/O
 * functions that throw {@link MongoUnavailableError} when Mongo is absent.
 */

function requireDb(): Db {
  const db = getMongoDb()
  if (!db) throw new MongoUnavailableError()
  return db
}

function translationsCol(db: Db) {
  return db.collection<TranslationDoc>('translations')
}

interface ReportDoc {
  _id: ObjectId
  word: string
  sourceLang: string
  targetLang: string
  version: string
  reason?: string
  createdAt: Date
}

function reportsCol(db: Db) {
  return db.collection<ReportDoc>('reports')
}

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))
const ID_PATTERN = /^[a-f0-9]{40}$/

// --- View shapes (mirrors src/api/admin.ts 1:1, per design doc §4.3) ---

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

// --- Query parsing (§5, §10) — pure, unit-tested without touching Mongo ---

export type EntriesSort = 'newest' | 'oldest' | 'mostReported'

export interface ListEntriesQuery {
  word?: string
  sourceLang?: string
  targetLang?: string
  tier?: 'llm' | 'dict'
  hasReports?: boolean
  sort: EntriesSort
  limit: number
  before?: Date
}

const DEFAULT_ENTRIES_LIMIT = 25
const MAX_ENTRIES_LIMIT = 100
const MAX_WORD_LENGTH = 256

/** Parses `GET /api/admin/entries` query params into safe, typed options. */
export function parseEntriesQuery(query: Record<string, unknown>): ListEntriesQuery {
  const word =
    typeof query.word === 'string' && query.word.trim()
      ? query.word.trim().toLowerCase().slice(0, MAX_WORD_LENGTH)
      : undefined

  const sourceLangRaw = typeof query.sourceLang === 'string' ? query.sourceLang.trim().toLowerCase() : ''
  const sourceLang = LANGUAGE_CODES.has(sourceLangRaw) ? sourceLangRaw : undefined

  const targetLangRaw = typeof query.targetLang === 'string' ? query.targetLang.trim().toLowerCase() : ''
  const targetLang = LANGUAGE_CODES.has(targetLangRaw) ? targetLangRaw : undefined

  const tierRaw = typeof query.tier === 'string' ? query.tier.trim().toLowerCase() : ''
  const tier = tierRaw === 'llm' || tierRaw === 'dict' ? tierRaw : undefined

  const hasReportsRaw = typeof query.hasReports === 'string' ? query.hasReports.trim().toLowerCase() : ''
  const hasReports = hasReportsRaw === 'true' ? true : hasReportsRaw === 'false' ? false : undefined

  const sortRaw = typeof query.sort === 'string' ? query.sort.trim() : ''
  const sort: EntriesSort =
    sortRaw === 'newest' || sortRaw === 'oldest' || sortRaw === 'mostReported'
      ? sortRaw
      : hasReports === true
        ? 'mostReported'
        : 'newest'

  let limit = DEFAULT_ENTRIES_LIMIT
  if (typeof query.limit === 'string' && query.limit.trim()) {
    const n = Number(query.limit)
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_ENTRIES_LIMIT)
  }

  let before: Date | undefined
  if (typeof query.before === 'string' && query.before.trim()) {
    const d = new Date(query.before)
    if (!Number.isNaN(d.getTime())) before = d
  }

  return { word, sourceLang, targetLang, tier, hasReports, sort, limit, before }
}

/** Validates an opaque `translations._id` (sha1 hex) path param. */
export function isValidEntryId(id: string): boolean {
  return ID_PATTERN.test(id)
}

// --- Report-count join (§5) — pure, unit-tested without touching Mongo ---

export interface ReportGroup {
  word: string
  sourceLang: string
  targetLang: string
  count: number
  lastAt: Date
}

function reportKey(word: string, sourceLang: string, targetLang: string): string {
  return `${sourceLang}|${targetLang}|${word}`
}

/** Groups raw `reports` docs by `(word, sourceLang, targetLang)`. */
export function groupReportsByEntry(reports: Pick<ReportDoc, 'word' | 'sourceLang' | 'targetLang' | 'createdAt'>[]): Map<string, ReportGroup> {
  const map = new Map<string, ReportGroup>()
  for (const r of reports) {
    const key = reportKey(r.word, r.sourceLang, r.targetLang)
    const existing = map.get(key)
    if (existing) {
      existing.count += 1
      if (r.createdAt > existing.lastAt) existing.lastAt = r.createdAt
    } else {
      map.set(key, { word: r.word, sourceLang: r.sourceLang, targetLang: r.targetLang, count: 1, lastAt: r.createdAt })
    }
  }
  return map
}

/** Merges `translations` docs with a report-count map into list-row views, per §4.2/§5. */
export function toEntrySummaries(
  docs: Pick<TranslationDoc, '_id' | 'word' | 'sourceLang' | 'targetLang' | 'source' | 'version' | 'fetchedAt' | 'entries'>[],
  reportCounts: Map<string, ReportGroup>
): EntrySummaryView[] {
  return docs.map((doc) => {
    const group = reportCounts.get(reportKey(doc.word, doc.sourceLang, doc.targetLang))
    return {
      id: doc._id,
      word: doc.word,
      sourceLang: doc.sourceLang,
      targetLang: doc.targetLang,
      tier: doc.source,
      version: doc.version,
      fetchedAt: doc.fetchedAt.toISOString(),
      reportCount: group?.count ?? 0,
      headwordPreview: doc.entries?.[0]?.meanings?.[0]?.definitions?.[0]?.definition,
    }
  })
}

/** Sorts entry summaries in place per §5's `sort` semantics. */
export function sortEntrySummaries(entries: EntrySummaryView[], sort: EntriesSort): EntrySummaryView[] {
  const sorted = [...entries]
  if (sort === 'mostReported') {
    sorted.sort(
      (a, b) => b.reportCount - a.reportCount || b.fetchedAt.localeCompare(a.fetchedAt)
    )
  } else if (sort === 'oldest') {
    sorted.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
  } else {
    sorted.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
  }
  return sorted
}

// --- Mongo I/O ---

/** Builds the Mongo filter for the plain (non-`hasReports`) list path. */
function buildTranslationsFilter(query: ListEntriesQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {}
  if (query.word) filter.word = { $regex: `^${escapeRegex(query.word)}` }
  if (query.sourceLang) filter.sourceLang = query.sourceLang
  if (query.targetLang) filter.targetLang = query.targetLang
  if (query.tier) filter.source = query.tier
  return filter
}

async function loadReportGroups(db: Db, query: ListEntriesQuery): Promise<Map<string, ReportGroup>> {
  const filter: Record<string, unknown> = {}
  if (query.word) filter.word = { $regex: `^${escapeRegex(query.word)}` }
  if (query.sourceLang) filter.sourceLang = query.sourceLang
  if (query.targetLang) filter.targetLang = query.targetLang
  const reports = await reportsCol(db).find(filter).toArray()
  return groupReportsByEntry(reports)
}

export interface ListEntriesResult {
  entries: EntrySummaryView[]
  hasMore: boolean
}

/**
 * Lists `translations` docs per §5's two-step approach: `hasReports=true`
 * queries `translations` by the exact `(word, sourceLang, targetLang)` keys
 * from a `reports` group-by (cheap at today's report volume); otherwise it's
 * a plain filtered/paginated scan with the report-count map merged in for
 * display and (optional) `mostReported` sort.
 */
export async function listEntries(query: ListEntriesQuery): Promise<ListEntriesResult> {
  const db = requireDb()
  const reportGroups = await loadReportGroups(db, query)

  if (query.hasReports === true) {
    // Start from the reports groups themselves — bounded by realistic report
    // volume (§5) — rather than scanning all of `translations`. Tier isn't
    // known from a report group, so it's applied as a `translations` filter
    // below instead of narrowing the group list here.
    const groups = [...reportGroups.values()]
    if (groups.length === 0) return { entries: [], hasMore: false }

    const or = groups.map((g) => ({ word: g.word, sourceLang: g.sourceLang, targetLang: g.targetLang }))
    const filter: Record<string, unknown> = { $or: or }
    if (query.tier) filter.source = query.tier
    if (query.before) filter.fetchedAt = { $lt: query.before }

    const docs = await translationsCol(db).find(filter).toArray()
    const summaries = toEntrySummaries(docs, reportGroups)
    const sorted = sortEntrySummaries(summaries, query.sort)
    const page = sorted.slice(0, query.limit)
    return { entries: page, hasMore: sorted.length > query.limit }
  }

  const filter = buildTranslationsFilter(query)
  if (query.before) filter.fetchedAt = { $lt: query.before }

  // Fetch one extra doc to compute `hasMore` without a second count query.
  // When `hasReports=false`, over-fetch further since some docs in the page
  // may get filtered out below (reported entries excluded) — bounded by
  // realistic report volume (§5), so this stays cheap.
  const overFetch = query.hasReports === false ? query.limit + reportGroups.size + 1 : query.limit + 1
  const sortSpec: Record<string, 1 | -1> = query.sort === 'oldest' ? { fetchedAt: 1 } : { fetchedAt: -1 }
  let docs = await translationsCol(db)
    .find(filter)
    .sort(sortSpec)
    .limit(overFetch)
    .toArray()

  if (query.hasReports === false) {
    docs = docs.filter((d) => !reportGroups.has(reportKey(d.word, d.sourceLang, d.targetLang)))
  }

  const hasMore = docs.length > query.limit
  const page = docs.slice(0, query.limit)
  let summaries = toEntrySummaries(page, reportGroups)
  if (query.sort === 'mostReported') summaries = sortEntrySummaries(summaries, 'mostReported')
  return { entries: summaries, hasMore }
}

/** Full detail for one entry: the `translations` doc + all matching `reports`. Returns `null` if the doc doesn't exist (404). */
export async function getEntry(id: string): Promise<EntryDetailView | null> {
  if (!isValidEntryId(id)) return null
  const db = requireDb()
  const doc = await translationsCol(db).findOne({ _id: id })
  if (!doc) return null

  const reports = await reportsCol(db)
    .find({ word: doc.word, sourceLang: doc.sourceLang, targetLang: doc.targetLang })
    .sort({ createdAt: -1 })
    .toArray()

  return {
    id: doc._id,
    word: doc.word,
    sourceLang: doc.sourceLang,
    targetLang: doc.targetLang,
    tier: doc.source,
    version: doc.version,
    fetchedAt: doc.fetchedAt.toISOString(),
    entries: doc.entries,
    reports: reports.map((r) => ({
      id: String(r._id),
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

/** `{ total, byWordCount }` for the Overview stat card / the reports page's summary header (§4.1, §8). */
export async function getReportsSummary(topN = 20): Promise<ReportsSummary> {
  const db = requireDb()
  const total = await reportsCol(db).estimatedDocumentCount()
  const reports = await reportsCol(db).find({}).toArray()
  const groups = groupReportsByEntry(reports)
  const byWordCount = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime())
    .slice(0, topN)
    .map((g) => ({
      word: g.word,
      sourceLang: g.sourceLang,
      targetLang: g.targetLang,
      count: g.count,
      lastAt: g.lastAt.toISOString(),
    }))
  return { total, byWordCount }
}

// --- Dedicated /admin/reports page (§15 Q4: built per explicit user request) ---

export interface ReportListItemView {
  id: string
  word: string
  sourceLang: string
  targetLang: string
  version: string
  reason?: string
  createdAt: string
  /** The matching `translations._id`, if that exact word/lang-pair still has a cached entry — lets the reports page deep-link straight into the entry detail drawer. */
  entryId?: string
}

const REPORT_ID_PATTERN = /^[a-f0-9]{24}$/

/** Validates an opaque `reports._id` (Mongo ObjectId hex) path param. */
export function isValidReportId(id: string): boolean {
  return REPORT_ID_PATTERN.test(id)
}

export interface ListReportsResult {
  reports: ReportListItemView[]
  hasMore: boolean
}

const DEFAULT_REPORTS_LIMIT = 50
const MAX_REPORTS_LIMIT = 200

export interface ListReportsQuery {
  limit: number
  before?: Date
}

/** Parses `GET /api/admin/reports` query params (mirrors `parseAuditQuery`'s cursor pagination). */
export function parseReportsQuery(query: Record<string, unknown>): ListReportsQuery {
  let limit = DEFAULT_REPORTS_LIMIT
  if (typeof query.limit === 'string' && query.limit.trim()) {
    const n = Number(query.limit)
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_REPORTS_LIMIT)
  }
  let before: Date | undefined
  if (typeof query.before === 'string' && query.before.trim()) {
    const d = new Date(query.before)
    if (!Number.isNaN(d.getTime())) before = d
  }
  return { limit, before }
}

/**
 * Newest-first page of individual `reports` docs, each annotated with the
 * `translations._id` it currently corresponds to (if any) so the UI can
 * deep-link into the entry detail view without a second round-trip per row.
 */
export async function listReports(query: ListReportsQuery): Promise<ListReportsResult> {
  const db = requireDb()
  const filter: Record<string, unknown> = query.before ? { createdAt: { $lt: query.before } } : {}
  const docs = await reportsCol(db)
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(query.limit + 1)
    .toArray()

  const hasMore = docs.length > query.limit
  const page = docs.slice(0, query.limit)

  // One batched lookup for the entry-id deep link, rather than N queries.
  const or = page.map((r) => ({ word: r.word, sourceLang: r.sourceLang, targetLang: r.targetLang }))
  const matches = or.length > 0
    ? await translationsCol(db)
        .find({ $or: or }, { projection: { word: 1, sourceLang: 1, targetLang: 1 } })
        .toArray()
    : []
  const entryIdByKey = new Map(matches.map((m) => [reportKey(m.word, m.sourceLang, m.targetLang), m._id]))

  const reports: ReportListItemView[] = page.map((r) => ({
    id: r._id.toHexString(),
    word: r.word,
    sourceLang: r.sourceLang,
    targetLang: r.targetLang,
    version: r.version,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    entryId: entryIdByKey.get(reportKey(r.word, r.sourceLang, r.targetLang)),
  }))

  return { reports, hasMore }
}

/**
 * Dismisses one report ("checked, entry is fine, no action needed") without
 * touching the cache entry — the independent-of-delete triage workflow
 * noted as future work in §13/§4.1, built now per explicit user request
 * (§15 Q4). Returns `false` if the report is already gone (404-worthy).
 */
export async function dismissReport(id: string): Promise<boolean> {
  if (!isValidReportId(id)) return false
  const db = requireDb()
  const result = await reportsCol(db).deleteOne({ _id: new ObjectId(id) })
  return (result.deletedCount ?? 0) > 0
}

export interface DeleteEntryResult {
  deleted: boolean
  reportsResolved: number
}

/**
 * Deletes one cached entry by `_id`; when `resolveReports` (default true),
 * also deletes every `reports` doc matching the same `(word, sourceLang,
 * targetLang)` (§4, §7). `deleted: false` (doc already gone) is not an
 * error — the router maps it to a 404 the UI treats as "already handled."
 */
export async function deleteEntry(
  id: string,
  opts: { resolveReports?: boolean } = {}
): Promise<DeleteEntryResult | null> {
  if (!isValidEntryId(id)) return null
  const db = requireDb()
  const doc = await translationsCol(db).findOne({ _id: id })
  if (!doc) return null

  await translationsCol(db).deleteOne({ _id: id })

  let reportsResolved = 0
  if (opts.resolveReports !== false) {
    const result = await reportsCol(db).deleteMany({
      word: doc.word,
      sourceLang: doc.sourceLang,
      targetLang: doc.targetLang,
    })
    reportsResolved = result.deletedCount ?? 0
  }

  return { deleted: true, reportsResolved }
}

export const MAX_BATCH_DELETE = 20

export type BatchDeleteError = { error: 'validation'; message: string }

export interface BatchDeleteResult {
  deletedIds: string[]
  notFoundIds: string[]
  reportsResolved: number
}

/** Validates `ids` (1–20, per §4/§9's batch cap) before looping `deleteEntry`. */
export function validateBatchIds(ids: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: 'ids must be a non-empty array' }
  }
  if (ids.length > MAX_BATCH_DELETE) {
    return { ok: false, error: `ids must have at most ${MAX_BATCH_DELETE} entries` }
  }
  if (!ids.every((id) => typeof id === 'string')) {
    return { ok: false, error: 'ids must be an array of strings' }
  }
  return { ok: true, value: ids as string[] }
}

/** Best-effort batch delete: an already-missing id doesn't fail the whole batch (§12). */
export async function batchDeleteEntries(
  ids: string[],
  opts: { resolveReports?: boolean } = {}
): Promise<BatchDeleteResult> {
  const deletedIds: string[] = []
  const notFoundIds: string[] = []
  let reportsResolved = 0
  for (const id of ids) {
    const result = await deleteEntry(id, opts)
    if (result) {
      deletedIds.push(id)
      reportsResolved += result.reportsResolved
    } else {
      notFoundIds.push(id)
    }
  }
  return { deletedIds, notFoundIds, reportsResolved }
}
