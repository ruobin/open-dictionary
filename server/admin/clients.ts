import { getMongoDb } from '../db'
import { budgetSnapshot, isBlocked } from '../abuseGuard'

/**
 * Admin "Clients" view: who is using the public lookup API and how much of it
 * is paid LLM traffic. Joins three sources:
 *  - `activity_log` aggregated by IP over the requested window (persistent;
 *    includes device type, sample User-Agent, and distinct words),
 *  - the in-memory rolling 24h LLM budget counters (live; reset on restart),
 *  - the blocklist.
 */

export interface ClientUsageView {
  ip: string
  total: number
  llm: number
  cache: number
  clientCache: number
  dictionary: number
  distinctWords: number
  firstSeen: string
  lastSeen: string
  perHour: number
  deviceTypes: string[]
  userAgent?: string
  /** Paid LLM calls in the live rolling 24h budget window. */
  budgetUsed: number
  blocked: boolean
  flags: ClientFlag[]
}

export type ClientFlag = 'bot-ua' | 'over-budget' | 'near-budget' | 'high-rate' | 'blocked'

export interface ClientUsageResult {
  windowHours: number
  budgetPerIp: number
  clients: ClientUsageView[]
}

const DEFAULT_HOURS = 24
const MAX_HOURS = 24 * 7
const MAX_CLIENTS = 50
/** Sustained lookups/hour above which a client is flagged. Assumes a person
 *  looks up at most a few words a minute and doesn't keep it up for hours. */
const HIGH_RATE_PER_HOUR = 60

export function parseClientsHours(query: Record<string, unknown>): number {
  if (typeof query.hours === 'string' && query.hours.trim()) {
    const n = Number(query.hours)
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), MAX_HOURS)
  }
  return DEFAULT_HOURS
}

interface AggRow {
  _id: string
  total: number
  llm: number
  cache: number
  clientCache: number
  dictionary: number
  words: number
  firstSeen: Date
  lastSeen: Date
  deviceTypes: string[]
  ua?: string | null
}

/** Pure: computes flags for one client. Exported for tests. */
export function flagsFor(
  row: { total: number; perHour: number; deviceTypes: string[]; budgetUsed: number; blocked: boolean },
  budgetPerIp: number
): ClientFlag[] {
  const flags: ClientFlag[] = []
  if (row.blocked) flags.push('blocked')
  if (row.deviceTypes.includes('bot')) flags.push('bot-ua')
  if (budgetPerIp > 0 && row.budgetUsed >= budgetPerIp) flags.push('over-budget')
  else if (budgetPerIp > 0 && row.budgetUsed >= budgetPerIp * 0.5) flags.push('near-budget')
  if (row.total >= 20 && row.perHour >= HIGH_RATE_PER_HOUR) flags.push('high-rate')
  return flags
}

export async function getClientUsage(hours: number, now: Date = new Date()): Promise<ClientUsageResult> {
  const budget = budgetSnapshot(500)
  const live = new Map(budget.top.map((r) => [r.ip, r.llmCalls]))
  const col = getMongoDb()?.collection('activity_log')
  const since = new Date(now.getTime() - hours * 3_600_000)

  const rows: AggRow[] = col
    ? ((await col
        .aggregate([
          { $match: { ts: { $gte: since } } },
          { $sort: { ts: -1 } },
          {
            $group: {
              _id: '$ip',
              total: { $sum: 1 },
              llm: { $sum: { $cond: [{ $eq: ['$tier', 'llm'] }, 1, 0] } },
              cache: { $sum: { $cond: [{ $eq: ['$tier', 'cache'] }, 1, 0] } },
              clientCache: { $sum: { $cond: [{ $eq: ['$tier', 'client-cache'] }, 1, 0] } },
              dictionary: { $sum: { $cond: [{ $eq: ['$tier', 'dictionary'] }, 1, 0] } },
              wordSet: { $addToSet: '$word' },
              firstSeen: { $min: '$ts' },
              lastSeen: { $max: '$ts' },
              deviceTypes: { $addToSet: '$device.type' },
              ua: { $first: '$ua' },
            },
          },
          { $sort: { llm: -1, total: -1 } },
          { $limit: MAX_CLIENTS },
          { $addFields: { words: { $size: '$wordSet' } } },
          { $project: { wordSet: 0 } },
        ])
        .toArray()) as AggRow[])
    : []

  const seen = new Set(rows.map((r) => r._id))
  const clients: ClientUsageView[] = rows.map((r) => {
    const spanHours = Math.max((now.getTime() - r.firstSeen.getTime()) / 3_600_000, 1)
    const perHour = Math.round((r.total / spanHours) * 10) / 10
    const budgetUsed = live.get(r._id) ?? 0
    const blocked = Boolean(isBlocked(r._id))
    const deviceTypes = (r.deviceTypes ?? []).filter(Boolean)
    return {
      ip: r._id,
      total: r.total,
      llm: r.llm,
      cache: r.cache,
      clientCache: r.clientCache,
      dictionary: r.dictionary,
      distinctWords: r.words,
      firstSeen: r.firstSeen.toISOString(),
      lastSeen: r.lastSeen.toISOString(),
      perHour,
      deviceTypes,
      ...(r.ua ? { userAgent: r.ua } : {}),
      budgetUsed,
      blocked,
      flags: flagsFor({ total: r.total, perHour, deviceTypes, budgetUsed, blocked }, budget.limit),
    }
  })

  // IPs that are spending LLM budget but are missing from the activity
  // aggregation (Mongo down, or outside the top-N) still need to be shown.
  for (const row of budget.top) {
    if (seen.has(row.ip) || clients.length >= MAX_CLIENTS * 2) continue
    const blocked = Boolean(isBlocked(row.ip))
    clients.push({
      ip: row.ip,
      total: row.llmCalls,
      llm: row.llmCalls,
      cache: 0,
      clientCache: 0,
      dictionary: 0,
      distinctWords: 0,
      firstSeen: row.lastSeen,
      lastSeen: row.lastSeen,
      perHour: 0,
      deviceTypes: [],
      budgetUsed: row.llmCalls,
      blocked,
      flags: flagsFor({ total: row.llmCalls, perHour: 0, deviceTypes: [], budgetUsed: row.llmCalls, blocked }, budget.limit),
    })
  }

  return { windowHours: hours, budgetPerIp: budget.limit, clients }
}
