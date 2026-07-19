import { getMongoDb } from './db'
import { parseUserAgent } from './util/userAgent'

/**
 * User activity log (docs/design-user-activity-log.md) — one document per
 * public dictionary lookup: word, langs, tier, latency, client IP, and a
 * parsed device/browser/OS summary. Backs the admin-only `/admin/activity`
 * page (analytics/growth signal). Fire-and-forget on the write side — a
 * logging failure must never affect a user-facing lookup response, same
 * failure-isolation posture as `cacheSetSafe()` in `server/translate.ts`.
 */

/** `client-cache` = browser/extension localStorage hit reported via POST /api/activity-ping. */
export type ActivityTier = 'cache' | 'llm' | 'dictionary' | 'client-cache'
export type ActivityChannel = 'web' | 'extension' | 'other'

export interface ActivityLogDoc {
  ts: Date
  word: string
  sourceLang: string
  targetLang: string
  tier: ActivityTier
  latencyMs: number
  ip: string
  channel: ActivityChannel
  device: { type: string; browser?: string; os?: string }
}

function activityCol() {
  return getMongoDb()?.collection<ActivityLogDoc>('activity_log')
}

/** The only cross-origin caller of the public `/api/translate/:text` endpoint
 *  is the Chrome extension (`chrome-extension://<id>` origin, per
 *  docs/design-browser-extension.md §6); everything else is bucketed as
 *  `web` — a directional signal, not precise attribution (design doc §5.2). */
export function classifyChannel(origin: string | undefined): ActivityChannel {
  if (origin && origin.startsWith('chrome-extension://')) return 'extension'
  return 'web'
}

export interface RecordActivityInput {
  word: string
  sourceLang: string
  targetLang: string
  tier: ActivityTier
  latencyMs: number
  ip: string
  userAgent?: string
  origin?: string
}

/** Fire-and-forget: never throws, never awaited by the caller. */
export function recordActivity(input: RecordActivityInput): void {
  const col = activityCol()
  if (!col) return

  const doc: ActivityLogDoc = {
    ts: new Date(),
    word: input.word,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    tier: input.tier,
    latencyMs: input.latencyMs,
    ip: input.ip,
    channel: classifyChannel(input.origin),
    device: parseUserAgent(input.userAgent),
  }

  col.insertOne(doc).catch((err) => {
    console.warn('[activity-log] write failed (non-fatal):', err)
  })
}

// --- Admin view shapes (mirrors src/api/admin.ts 1:1, per existing convention) ---

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

// --- Query parsing (§6) — pure, unit-tested without touching Mongo ---

const TIERS = new Set<ActivityTier>(['cache', 'llm', 'dictionary', 'client-cache'])
const CHANNELS = new Set<ActivityChannel>(['web', 'extension', 'other'])
const DEVICE_TYPES = new Set(['desktop', 'mobile', 'tablet', 'bot', 'unknown'])

export interface ListActivityQuery {
  word?: string
  tier?: ActivityTier
  channel?: ActivityChannel
  deviceType?: string
  limit: number
  before?: Date
}

const DEFAULT_ACTIVITY_LIMIT = 50
const MAX_ACTIVITY_LIMIT = 200
const MAX_WORD_LENGTH = 256

/** Parses `GET /api/admin/activity` query params into safe, typed options. */
export function parseActivityQuery(query: Record<string, unknown>): ListActivityQuery {
  const word =
    typeof query.word === 'string' && query.word.trim()
      ? query.word.trim().toLowerCase().slice(0, MAX_WORD_LENGTH)
      : undefined

  const tierRaw = typeof query.tier === 'string' ? query.tier.trim() : ''
  const tier = TIERS.has(tierRaw as ActivityTier) ? (tierRaw as ActivityTier) : undefined

  const channelRaw = typeof query.channel === 'string' ? query.channel.trim() : ''
  const channel = CHANNELS.has(channelRaw as ActivityChannel) ? (channelRaw as ActivityChannel) : undefined

  const deviceTypeRaw = typeof query.deviceType === 'string' ? query.deviceType.trim() : ''
  const deviceType = DEVICE_TYPES.has(deviceTypeRaw) ? deviceTypeRaw : undefined

  let limit = DEFAULT_ACTIVITY_LIMIT
  if (typeof query.limit === 'string' && query.limit.trim()) {
    const n = Number(query.limit)
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_ACTIVITY_LIMIT)
  }

  let before: Date | undefined
  if (typeof query.before === 'string' && query.before.trim()) {
    const d = new Date(query.before)
    if (!Number.isNaN(d.getTime())) before = d
  }

  return { word, tier, channel, deviceType, limit, before }
}

const DEFAULT_SUMMARY_DAYS = 7
const MAX_SUMMARY_DAYS = 90

/** Parses `GET /api/admin/activity/summary`'s `?days` query param. */
export function parseSummaryDays(query: Record<string, unknown>): number {
  if (typeof query.days === 'string' && query.days.trim()) {
    const n = Number(query.days)
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), MAX_SUMMARY_DAYS)
  }
  return DEFAULT_SUMMARY_DAYS
}

/** Zero-fills `dailyCounts` for every UTC date in `[cutoff, now]` so the
 *  frontend never has to handle silent gaps for low-traffic days. */
export function zeroFillDailyCounts(
  counts: { date: string; count: number }[],
  windowDays: number,
  now: Date = new Date()
): { date: string; count: number }[] {
  const byDate = new Map(counts.map((c) => [c.date, c.count]))
  const out: { date: string; count: number }[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    const dateKey = d.toISOString().slice(0, 10)
    out.push({ date: dateKey, count: byDate.get(dateKey) ?? 0 })
  }
  return out
}

// --- Mongo I/O ---

function toView(doc: ActivityLogDoc & { _id: unknown }): ActivityLogView {
  return {
    id: String(doc._id),
    ts: doc.ts.toISOString(),
    word: doc.word,
    sourceLang: doc.sourceLang,
    targetLang: doc.targetLang,
    tier: doc.tier,
    latencyMs: doc.latencyMs,
    ip: doc.ip,
    channel: doc.channel,
    device: doc.device,
  }
}

export interface ListActivityResult {
  entries: ActivityLogView[]
  hasMore: boolean
}

/** Newest-first page of raw activity log entries — same cursor pattern as `listAudit()`. */
export async function listActivity(query: ListActivityQuery): Promise<ListActivityResult> {
  const col = activityCol()
  if (!col) return { entries: [], hasMore: false }

  const filter: Record<string, unknown> = {}
  if (query.word) filter.word = query.word
  if (query.tier) filter.tier = query.tier
  if (query.channel) filter.channel = query.channel
  if (query.deviceType) filter['device.type'] = query.deviceType
  if (query.before) filter.ts = { $lt: query.before }

  const docs = await col
    .find(filter)
    .sort({ ts: -1 })
    .limit(query.limit + 1)
    .toArray()

  const hasMore = docs.length > query.limit
  const page = docs.slice(0, query.limit)
  return { entries: page.map((d) => toView(d as ActivityLogDoc & { _id: unknown })), hasMore }
}

interface FacetCountRow {
  _id: string | null
  n: number
}

interface SummaryFacetResult {
  total: { n: number }[]
  byTier: FacetCountRow[]
  byChannel: FacetCountRow[]
  byDeviceType: FacetCountRow[]
  topWords: FacetCountRow[]
  dailyCounts: FacetCountRow[]
  uniqueIps: { n: number }[]
}

function facetToRecord(rows: FacetCountRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) out[row._id ?? 'unknown'] = row.n
  return out
}

/** Aggregated stats over a trailing `days`-day window — one Mongo round trip via `$facet`. */
export async function getActivitySummary(days: number): Promise<ActivitySummary> {
  const col = activityCol()
  if (!col) {
    return {
      windowDays: days,
      totalLookups: 0,
      uniqueIps: 0,
      byTier: {},
      byChannel: {},
      byDeviceType: {},
      topWords: [],
      dailyCounts: zeroFillDailyCounts([], days),
    }
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const [result] = await col
    .aggregate<SummaryFacetResult>([
      { $match: { ts: { $gte: cutoff } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          byTier: [{ $group: { _id: '$tier', n: { $sum: 1 } } }],
          byChannel: [{ $group: { _id: '$channel', n: { $sum: 1 } } }],
          byDeviceType: [{ $group: { _id: '$device.type', n: { $sum: 1 } } }],
          topWords: [
            { $group: { _id: '$word', n: { $sum: 1 } } },
            { $sort: { n: -1 } },
            { $limit: 20 },
          ],
          dailyCounts: [
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, n: { $sum: 1 } } },
          ],
          uniqueIps: [{ $group: { _id: '$ip' } }, { $count: 'n' }],
        },
      },
    ])
    .toArray()

  const totalLookups = result?.total?.[0]?.n ?? 0
  const uniqueIps = result?.uniqueIps?.[0]?.n ?? 0
  const dailyCounts = (result?.dailyCounts ?? []).map((r) => ({ date: r._id ?? '', count: r.n }))
  const topWords = (result?.topWords ?? []).map((r) => ({ word: r._id ?? '', count: r.n }))

  return {
    windowDays: days,
    totalLookups,
    uniqueIps,
    byTier: facetToRecord(result?.byTier ?? []),
    byChannel: facetToRecord(result?.byChannel ?? []),
    byDeviceType: facetToRecord(result?.byDeviceType ?? []),
    topWords,
    dailyCounts: zeroFillDailyCounts(dailyCounts, days),
  }
}
