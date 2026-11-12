import type { Db } from 'mongodb'
import { getMongoDb } from '../db'
import type { LlmMeteredState } from '../llm/service'
import type { UsageService } from '../usage'
import { todayBudgetMicros } from '../usage/meter'
import { percentile } from '../usage/pricing'
import type {
  AccountDoc,
  EnforcementMode,
  LedgerDoc,
  PacingMode,
  QuotaReason,
  UsageAction,
  UsageRoute,
  UsageSource,
} from '../usage/types'
import { counterKeys, daysLeftInUtcMonth, utcDay, utcMonth } from '../usage/windows'

/**
 * Admin "Usage & budget" data (docs/design-llm-usage-quotas.md §5.7–5.8):
 * live budget gauges from the counters, history from the usage ledger.
 */

const QUOTA_REASONS: QuotaReason[] = [
  'anon_daily',
  'unverified_daily',
  'anon_share',
  'user_daily',
  'free_tier_budget',
  'free_tier_paused',
]

const usd = (micros: number): number => Math.round(micros) / 1e6

export interface UsageBudgetView {
  day: string
  month: string
  freeTierEnabled: boolean
  pacing: PacingMode
  dailyCapUsd: number
  monthCapUsd: number
  /** Today's paced budget (what free generations may cost today). */
  todayBudgetUsd: number
  todaySpentUsd: number
  /** The IP allowance's part of today's budget, and what it has used. */
  anonShareUsd: number
  anonSpentUsd: number
  monthSpentUsd: number
  /** What was left of the month at the start of today (the pacing input). */
  monthRemainingBeforeTodayUsd: number
  daysLeft: number
}

export interface UsageSourceTotals {
  generations: number
  charged: number
  costUsd: number
}

export interface UsageSummary {
  generatedAt: string
  days: number
  enforcement: EnforcementMode
  budget: UsageBudgetView
  metered?: LlmMeteredState
  totals: { generations: number; costUsd: number; ownerCostUsd: number; othersCostUsd: number }
  daily: Array<{ day: string; bySource: Partial<Record<UsageSource, UsageSourceTotals>> }>
  costPerGeneration: Array<{
    routeProviderId: string
    action: UsageAction
    route: UsageRoute
    count: number
    avgUsd: number
    p50Usd: number
    p95Usd: number
  }>
  /** Refusals per reason over the last 30 days; in shadow mode, would-be refusals. */
  denials: Array<{ reason: QuotaReason; count: number; today: number }>
  topAccounts: Array<{ sub: string; generations: number; costUsd: number; lastAt: string }>
  topIps: Array<{ ip: string; generations: number; costUsd: number; lastAt: string }>
  /** Models used recently with no price set (the default price was charged). */
  unpriced: Array<{ providerId: string; calls: number }>
  /** Share of recent calls whose token usage was estimated from text size. */
  estimatedShare: number
}

export async function getBudgetView(usage: UsageService, now: Date = new Date()): Promise<UsageBudgetView> {
  const settings = usage.settings()
  const day = utcDay(now)
  const month = utcMonth(now)
  const keys = [counterKeys.free(day), counterKeys.freeAnon(day), counterKeys.monthFree(month)]
  const counters = usage.store ? await usage.store.getCounters(keys) : new Map()
  const todaySpent = counters.get(keys[0])?.costMicros ?? 0
  const anonSpent = counters.get(keys[1])?.costMicros ?? 0
  const monthSpent = counters.get(keys[2])?.costMicros ?? 0
  const budget = todayBudgetMicros(settings, todaySpent, monthSpent, now)
  const monthCap = Math.round(settings.freeTierMonthlyUsd * 1e6)
  return {
    day,
    month,
    freeTierEnabled: settings.freeTierEnabled,
    pacing: settings.pacing,
    dailyCapUsd: settings.freeTierDailyUsd,
    monthCapUsd: settings.freeTierMonthlyUsd,
    todayBudgetUsd: usd(budget),
    todaySpentUsd: usd(todaySpent),
    anonShareUsd: usd(Math.floor(budget * settings.anonShare)),
    anonSpentUsd: usd(anonSpent),
    monthSpentUsd: usd(monthSpent),
    monthRemainingBeforeTodayUsd: usd(Math.max(0, monthCap - Math.max(0, monthSpent - todaySpent))),
    daysLeft: daysLeftInUtcMonth(now),
  }
}

function ledgerCol(db: Db) {
  return db.collection<LedgerDoc>('usage_ledger')
}

async function denialCounts(usage: UsageService, now: Date): Promise<UsageSummary['denials']> {
  if (!usage.store) return []
  const days: string[] = []
  for (let i = 0; i < 30; i += 1) days.push(utcDay(new Date(now.getTime() - i * 86_400_000)))
  const ids = days.flatMap((d) => QUOTA_REASONS.map((r) => counterKeys.denied(d, r)))
  const counters = await usage.store.getCounters(ids)
  return QUOTA_REASONS.map((reason) => ({
    reason,
    count: days.reduce((sum, d) => sum + (counters.get(counterKeys.denied(d, reason))?.n ?? 0), 0),
    today: counters.get(counterKeys.denied(days[0], reason))?.n ?? 0,
  })).filter((d) => d.count > 0)
}

export async function getUsageSummary(
  usage: UsageService,
  metered: LlmMeteredState | undefined,
  days: number,
  now: Date = new Date()
): Promise<UsageSummary> {
  const settings = usage.settings()
  const base = {
    generatedAt: now.toISOString(),
    days,
    enforcement: settings.enforcement,
    budget: await getBudgetView(usage, now),
    ...(metered ? { metered } : {}),
    denials: await denialCounts(usage, now),
  }
  const db = getMongoDb()
  if (!db) {
    return {
      ...base,
      totals: { generations: 0, costUsd: 0, ownerCostUsd: 0, othersCostUsd: 0 },
      daily: [],
      costPerGeneration: [],
      topAccounts: [],
      topIps: [],
      unpriced: [],
      estimatedShare: 0,
    }
  }

  const ledger = ledgerCol(db)
  const since = new Date(now.getTime() - days * 86_400_000)
  const recent = new Date(now.getTime() - 7 * 86_400_000)

  const [byDay, costRows, accounts, ips, unpriced, estimated] = await Promise.all([
    ledger
      .aggregate<{ _id: { day: string; source: UsageSource }; n: number; charged: number; cost: number }>([
        { $match: { ts: { $gte: since } } },
        {
          $group: {
            _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, source: '$source' },
            n: { $sum: 1 },
            charged: { $sum: { $cond: ['$charged', 1, 0] } },
            cost: { $sum: '$costMicros' },
          },
        },
      ])
      .toArray(),
    ledger
      .aggregate<{ _id: { p: string; action: UsageAction; route: UsageRoute }; costs: number[] }>([
        { $match: { ts: { $gte: recent }, charged: true, routeProviderId: { $exists: true } } },
        { $sort: { ts: -1 } },
        { $limit: 5_000 },
        { $group: { _id: { p: '$routeProviderId', action: '$action', route: '$route' }, costs: { $push: '$costMicros' } } },
      ])
      .toArray(),
    ledger
      .aggregate<{ _id: string; n: number; cost: number; last: Date }>([
        { $match: { ts: { $gte: recent }, 'principal.kind': 'user' } },
        { $group: { _id: '$principal.sub', n: { $sum: 1 }, cost: { $sum: '$costMicros' }, last: { $max: '$ts' } } },
        { $sort: { cost: -1 } },
        { $limit: 10 },
      ])
      .toArray(),
    ledger
      .aggregate<{ _id: string; n: number; cost: number; last: Date }>([
        { $match: { ts: { $gte: recent }, 'principal.kind': 'anon' } },
        { $group: { _id: '$principal.ip', n: { $sum: 1 }, cost: { $sum: '$costMicros' }, last: { $max: '$ts' } } },
        { $sort: { cost: -1 } },
        { $limit: 10 },
      ])
      .toArray(),
    ledger
      .aggregate<{ _id: string; n: number }>([
        { $match: { ts: { $gte: recent }, unpriced: true } },
        { $unwind: '$calls' },
        { $match: { 'calls.unpriced': true } },
        { $group: { _id: '$calls.providerId', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ])
      .toArray(),
    ledger
      .aggregate<{ _id: null; total: number; estimated: number }>([
        { $match: { ts: { $gte: recent } } },
        { $unwind: '$calls' },
        { $group: { _id: null, total: { $sum: 1 }, estimated: { $sum: { $cond: ['$calls.estimated', 1, 0] } } } },
      ])
      .toArray(),
  ])

  const dailyMap = new Map<string, Partial<Record<UsageSource, UsageSourceTotals>>>()
  let totalGenerations = 0
  let totalCost = 0
  let ownerCost = 0
  for (const row of byDay) {
    const entry = dailyMap.get(row._id.day) ?? {}
    entry[row._id.source] = { generations: row.n, charged: row.charged, costUsd: usd(row.cost) }
    dailyMap.set(row._id.day, entry)
    totalGenerations += row.n
    totalCost += row.cost
    if (row._id.source === 'owner' || row._id.source === 'exempt') ownerCost += row.cost
  }

  return {
    ...base,
    totals: {
      generations: totalGenerations,
      costUsd: usd(totalCost),
      ownerCostUsd: usd(ownerCost),
      othersCostUsd: usd(totalCost - ownerCost),
    },
    daily: [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, bySource]) => ({ day, bySource })),
    costPerGeneration: costRows
      .map((row) => ({
        routeProviderId: row._id.p,
        action: row._id.action,
        route: row._id.route,
        count: row.costs.length,
        avgUsd: usd(row.costs.reduce((a, b) => a + b, 0) / Math.max(1, row.costs.length)),
        p50Usd: usd(percentile(row.costs, 0.5)),
        p95Usd: usd(percentile(row.costs, 0.95)),
      }))
      .sort((a, b) => b.count - a.count),
    topAccounts: accounts.map((r) => ({ sub: r._id, generations: r.n, costUsd: usd(r.cost), lastAt: r.last.toISOString() })),
    topIps: ips.map((r) => ({ ip: r._id, generations: r.n, costUsd: usd(r.cost), lastAt: r.last.toISOString() })),
    unpriced: unpriced.map((r) => ({ providerId: r._id, calls: r.n })),
    estimatedShare: estimated[0] && estimated[0].total > 0 ? estimated[0].estimated / estimated[0].total : 0,
  }
}

// --- accounts ---

export interface AccountView {
  sub: string
  plan: AccountDoc['plan']
  status: AccountDoc['status']
  dailyAllowance: number | null
  emailVerified: boolean | null
  note: string | null
  createdAt: string
  lastSeenAt: string | null
  /** Free new words used today from the account's own allowance (verified accounts). */
  usedToday: number
  /** Generations over the last 7 days. */
  generations7d: number
  costUsd7d: number
  /** Only on the single-account view: looked up from Auth0, never stored. */
  email?: string | null
}

export interface AccountPatch {
  plan?: AccountDoc['plan']
  status?: AccountDoc['status']
  dailyAllowance?: number | null
  note?: string | null
}

export function validateAccountPatch(input: unknown): { ok: true; value: AccountPatch } | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['body must be an object'] }
  const b = input as Record<string, unknown>
  const errors: string[] = []
  const value: AccountPatch = {}
  for (const key of Object.keys(b)) {
    if (!['plan', 'status', 'dailyAllowance', 'note'].includes(key)) errors.push(`unknown field: ${key}`)
  }
  if (b.plan !== undefined) {
    if (b.plan === 'free' || b.plan === 'unlimited') value.plan = b.plan
    else errors.push('plan must be "free" or "unlimited"')
  }
  if (b.status !== undefined) {
    if (b.status === 'active' || b.status === 'blocked') value.status = b.status
    else errors.push('status must be "active" or "blocked"')
  }
  if (b.dailyAllowance !== undefined) {
    const v = b.dailyAllowance
    if (v === null) value.dailyAllowance = null
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000) value.dailyAllowance = v
    else errors.push('dailyAllowance must be null or an integer from 0 to 100000')
  }
  if (b.note !== undefined) {
    if (b.note === null || (typeof b.note === 'string' && b.note.trim() === '')) value.note = null
    else if (typeof b.note === 'string' && b.note.length <= 300) value.note = b.note.trim()
    else errors.push('note must be a string of at most 300 characters, or null')
  }
  if (Object.keys(value).length === 0 && errors.length === 0) errors.push('nothing to update')
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

async function withStats(db: Db | null, usage: UsageService, docs: AccountDoc[], now: Date): Promise<AccountView[]> {
  if (docs.length === 0) return []
  const day = utcDay(now)
  const counters = usage.store
    ? await usage.store.getCounters(docs.map((d) => counterKeys.user(day, d._id)))
    : new Map<string, { n: number }>()
  const stats = new Map<string, { n: number; cost: number }>()
  if (db) {
    const rows = await ledgerCol(db)
      .aggregate<{ _id: string; n: number; cost: number }>([
        { $match: { ts: { $gte: new Date(now.getTime() - 7 * 86_400_000) }, 'principal.sub': { $in: docs.map((d) => d._id) } } },
        { $group: { _id: '$principal.sub', n: { $sum: 1 }, cost: { $sum: '$costMicros' } } },
      ])
      .toArray()
    for (const r of rows) stats.set(r._id, { n: r.n, cost: r.cost })
  }
  return docs.map((d) => ({
    sub: d._id,
    plan: d.plan,
    status: d.status,
    dailyAllowance: d.dailyAllowance ?? null,
    emailVerified: d.emailVerified ?? null,
    note: d.note ?? null,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    usedToday: counters.get(counterKeys.user(day, d._id))?.n ?? 0,
    generations7d: stats.get(d._id)?.n ?? 0,
    costUsd7d: usd(stats.get(d._id)?.cost ?? 0),
  }))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Recent accounts, or a search: an email (looked up in Auth0) or a `sub` prefix. */
export async function listAccounts(usage: UsageService, q: string | undefined, limit: number, now: Date = new Date()): Promise<AccountView[]> {
  const db = getMongoDb()
  if (!db) return []
  const col = db.collection<AccountDoc>('accounts')
  let docs: AccountDoc[]
  const query = q?.trim()
  if (query && query.includes('@')) {
    const matches = usage.directory ? await usage.directory.findByEmail(query.toLowerCase()) : []
    const subs = matches.map((m) => m.sub)
    const found = await col.find({ _id: { $in: subs } }).toArray()
    const known = new Set(found.map((d) => d._id))
    // Accounts that exist in Auth0 but have never generated: show them so the admin can still set a plan.
    docs = [
      ...found,
      ...subs
        .filter((s) => !known.has(s))
        .map((s) => ({ _id: s, plan: 'free' as const, status: 'active' as const, createdAt: now, updatedAt: now })),
    ]
  } else if (query) {
    docs = await col.find({ _id: { $regex: `^${escapeRegex(query)}` } }).limit(limit).toArray()
  } else {
    docs = await col.find().sort({ lastSeenAt: -1 }).limit(limit).toArray()
  }
  return withStats(db, usage, docs, now)
}

export async function getAccountView(usage: UsageService, sub: string, now: Date = new Date()): Promise<AccountView | null> {
  const db = getMongoDb()
  const doc = usage.store ? await usage.store.getAccount(sub) : null
  const base: AccountDoc = doc ?? { _id: sub, plan: 'free', status: 'active', createdAt: now, updatedAt: now }
  const [view] = await withStats(db, usage, [base], now)
  let email: string | null = null
  if (usage.directory) {
    try {
      email = await usage.directory.getEmail(sub)
    } catch {
      email = null
    }
  }
  if (!doc && email === null) return null
  return { ...view, email }
}

/** Creates the account if needed, then applies the patch. */
export async function updateAccount(usage: UsageService, sub: string, patch: AccountPatch, now: Date = new Date()): Promise<AccountView | null> {
  const store = usage.store
  if (!store) return null
  await store.ensureAccount(sub, now)
  const set: Partial<AccountDoc> = { updatedAt: now }
  const unset: Array<keyof AccountDoc> = []
  if (patch.plan) set.plan = patch.plan
  if (patch.status) set.status = patch.status
  if (patch.dailyAllowance === null) unset.push('dailyAllowance')
  else if (patch.dailyAllowance !== undefined) set.dailyAllowance = patch.dailyAllowance
  if (patch.note === null) unset.push('note')
  else if (patch.note !== undefined) set.note = patch.note
  await store.updateAccount(sub, set, unset)
  return getAccountView(usage, sub, now)
}
