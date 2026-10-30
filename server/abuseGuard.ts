import { BlockList, isIP } from 'node:net'
import type { Request, Response, NextFunction } from 'express'
import { getMongoDb } from './db'
import { parseUserAgent } from './util/userAgent'
import { LLM_BLOCK_BOTS, LLM_DAILY_BUDGET_PER_IP } from './config'

/**
 * LLM abuse guard. Per-minute rate limits alone don't cap daily token spend:
 * on 2026-10-29/30 GPTBot rendered /word/* SPA pages at about 9 req/min,
 * stayed just under the 5 rpm translate limit, and each new word cost a paid
 * LLM call (thousands per day). Three layers:
 *
 *  1. Blocklist: admin-managed IPs/CIDRs in Mongo `blocked_clients`, held in
 *     memory and refreshed lazily. Blocked clients get 403 on every public
 *     /api route (admin routes are never blocked, so an admin can't lock
 *     themselves out).
 *  2. Crawlers: self-identified bots and scripts get 403 on LLM-backed routes.
 *  3. Daily budget: a rolling 24h count of paid LLM calls per IP. Once a
 *     client is over budget, it can still get cache hits, but cache misses
 *     get 429.
 *
 * Budget counters are in-process: they reset on API restart, and that is
 * acceptable for a single-container deployment.
 */

// ---------------------------------------------------------------------------
// IP helpers
// ---------------------------------------------------------------------------

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:1.2.3.4` and `1.2.3.4` match. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown'
  const trimmed = ip.trim()
  return trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed
}

export function clientIp(req: Request): string {
  return normalizeIp(req.ip)
}

export interface ParsedBlockTarget {
  /** Canonical form: `1.2.3.4`, `1.2.3.0/24`, `2001:db8::/32`. */
  target: string
  address: string
  prefix?: number
  family: 'ipv4' | 'ipv6'
}

/** Validates an admin-supplied IP or CIDR. Returns null when invalid. Rejects
 *  prefixes broader than /8 (v4) or /16 (v6) to avoid blocking half the internet. */
export function parseBlockTarget(raw: unknown): ParsedBlockTarget | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (!value || value.length > 64) return null
  const [addrRaw, prefixRaw, ...rest] = value.split('/')
  if (rest.length > 0) return null
  const address = normalizeIp(addrRaw)
  const version = isIP(address)
  if (version === 0) return null
  const family = version === 4 ? 'ipv4' : 'ipv6'
  if (prefixRaw === undefined) return { target: address, address, family }
  if (!/^\d{1,3}$/.test(prefixRaw)) return null
  const prefix = Number(prefixRaw)
  const [min, max] = family === 'ipv4' ? [8, 32] : [16, 128]
  if (prefix < min || prefix > max) return null
  if (prefix === max) return { target: address, address, family }
  return { target: `${address}/${prefix}`, address, prefix, family }
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

export interface BlockedClientDoc {
  _id: string // canonical target
  reason?: string
  createdAt: Date
  createdBy: string
  expiresAt?: Date
}

export interface BlockedClientView {
  target: string
  reason?: string
  createdAt: string
  createdBy: string
  expiresAt?: string
}

function blockedCol() {
  return getMongoDb()?.collection<BlockedClientDoc>('blocked_clients')
}

function toBlockedView(doc: BlockedClientDoc): BlockedClientView {
  return {
    target: doc._id,
    ...(doc.reason ? { reason: doc.reason } : {}),
    createdAt: doc.createdAt.toISOString(),
    createdBy: doc.createdBy,
    ...(doc.expiresAt ? { expiresAt: doc.expiresAt.toISOString() } : {}),
  }
}

/** In-memory blocklist matcher. Exported for tests. */
export class ClientBlocklist {
  private entries: BlockedClientDoc[] = []
  private list = new BlockList()

  set(entries: BlockedClientDoc[]): void {
    this.entries = entries
    const list = new BlockList()
    for (const entry of entries) {
      const parsed = parseBlockTarget(entry._id)
      if (!parsed) continue
      if (parsed.prefix !== undefined) list.addSubnet(parsed.address, parsed.prefix, parsed.family)
      else list.addAddress(parsed.address, parsed.family)
    }
    this.list = list
  }

  all(): BlockedClientDoc[] {
    return this.entries
  }

  /** Returns the matching entry (honoring expiry) or undefined. */
  match(ip: string, now: Date = new Date()): BlockedClientDoc | undefined {
    const addr = normalizeIp(ip)
    const version = isIP(addr)
    if (version === 0) return undefined
    const family = version === 4 ? 'ipv4' : 'ipv6'
    if (!this.list.check(addr, family)) return undefined
    return this.entries.find((e) => {
      if (e.expiresAt && e.expiresAt <= now) return false
      const parsed = parseBlockTarget(e._id)
      if (!parsed || parsed.family !== family) return false
      const single = new BlockList()
      if (parsed.prefix !== undefined) single.addSubnet(parsed.address, parsed.prefix, parsed.family)
      else single.addAddress(parsed.address, parsed.family)
      return single.check(addr, family)
    })
  }
}

const blocklist = new ClientBlocklist()
const BLOCKLIST_REFRESH_MS = 30_000
let blocklistLoadedAt = 0
let blocklistRefreshing: Promise<void> | null = null

/** Reloads the blocklist from Mongo. Never throws. */
export async function refreshBlocklist(): Promise<void> {
  const col = blockedCol()
  if (!col) return
  try {
    const docs = await col
      .find({ $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] })
      .toArray()
    blocklist.set(docs)
    blocklistLoadedAt = Date.now()
  } catch (err) {
    console.warn('[abuse-guard] blocklist refresh failed (non-fatal):', err)
  }
}

function maybeRefreshBlocklist(): void {
  if (blocklistRefreshing || Date.now() - blocklistLoadedAt < BLOCKLIST_REFRESH_MS) return
  blocklistRefreshing = refreshBlocklist().finally(() => {
    blocklistRefreshing = null
  })
}

export function isBlocked(ip: string): BlockedClientDoc | undefined {
  maybeRefreshBlocklist()
  return blocklist.match(ip)
}

export class BlocklistUnavailableError extends Error {
  constructor() {
    super('mongo_unavailable')
    this.name = 'BlocklistUnavailableError'
  }
}

export async function listBlocked(): Promise<BlockedClientView[]> {
  await refreshBlocklist()
  return blocklist
    .all()
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toBlockedView)
}

export async function addBlocked(input: {
  target: string
  reason?: string
  createdBy: string
  hours?: number
}): Promise<BlockedClientView> {
  const col = blockedCol()
  if (!col) throw new BlocklistUnavailableError()
  const doc: BlockedClientDoc = {
    _id: input.target,
    createdAt: new Date(),
    createdBy: input.createdBy,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.hours ? { expiresAt: new Date(Date.now() + input.hours * 3_600_000) } : {}),
  }
  await col.replaceOne({ _id: doc._id }, doc, { upsert: true })
  await refreshBlocklist()
  return toBlockedView(doc)
}

export async function removeBlocked(target: string): Promise<boolean> {
  const col = blockedCol()
  if (!col) throw new BlocklistUnavailableError()
  const result = await col.deleteOne({ _id: target })
  await refreshBlocklist()
  return result.deletedCount > 0
}

// ---------------------------------------------------------------------------
// Rolling 24h LLM budget
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000
const WINDOW_HOURS = 24
const SWEEP_EVERY = 500

/** Per-IP hourly buckets over a rolling 24h window. Exported for tests. */
export class LlmBudget {
  private buckets = new Map<string, Map<number, number>>()
  private lastSeen = new Map<string, number>()
  private writes = 0

  constructor(public readonly limit: number) {}

  private windowStart(now: number): number {
    return Math.floor(now / HOUR_MS) - (WINDOW_HOURS - 1)
  }

  record(ip: string, now: number = Date.now()): void {
    const hour = Math.floor(now / HOUR_MS)
    let perIp = this.buckets.get(ip)
    if (!perIp) {
      perIp = new Map()
      this.buckets.set(ip, perIp)
    }
    perIp.set(hour, (perIp.get(hour) ?? 0) + 1)
    this.lastSeen.set(ip, now)
    if (++this.writes % SWEEP_EVERY === 0) this.sweep(now)
  }

  count(ip: string, now: number = Date.now()): number {
    const perIp = this.buckets.get(ip)
    if (!perIp) return 0
    const start = this.windowStart(now)
    let total = 0
    for (const [hour, n] of perIp) if (hour >= start) total += n
    return total
  }

  exceeded(ip: string, now: number = Date.now()): boolean {
    return this.limit > 0 && this.count(ip, now) >= this.limit
  }

  /** Drops buckets outside the window and IPs with nothing left in it. */
  sweep(now: number = Date.now()): void {
    const start = this.windowStart(now)
    for (const [ip, perIp] of this.buckets) {
      for (const hour of perIp.keys()) if (hour < start) perIp.delete(hour)
      if (perIp.size === 0) {
        this.buckets.delete(ip)
        this.lastSeen.delete(ip)
      }
    }
  }

  /** Top IPs by paid LLM calls in the current window. */
  top(n: number, now: number = Date.now()): { ip: string; llmCalls: number; lastSeen: string }[] {
    const rows: { ip: string; llmCalls: number; lastSeen: string }[] = []
    for (const ip of this.buckets.keys()) {
      const llmCalls = this.count(ip, now)
      if (llmCalls > 0) rows.push({ ip, llmCalls, lastSeen: new Date(this.lastSeen.get(ip) ?? now).toISOString() })
    }
    rows.sort((a, b) => b.llmCalls - a.llmCalls)
    return rows.slice(0, n)
  }
}

export const llmBudget = new LlmBudget(LLM_DAILY_BUDGET_PER_IP)

/** Call once per paid LLM call (tier `llm`) served to `req`. */
export function recordLlmSpend(req: Request): void {
  llmBudget.record(clientIp(req))
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Mounted on `/api` before the public routers: refuses blocklisted clients.
 *  `/api/admin/*` is exempt so an admin can never lock themselves out. */
export function blocklistGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/admin')) return next()
  const hit = isBlocked(clientIp(req))
  if (hit) {
    res.status(403).json({ error: 'blocked' })
    return
  }
  next()
}

export function isCrawlerUserAgent(ua: string | undefined): boolean {
  return parseUserAgent(ua).type === 'bot'
}

/**
 * Put this in front of every route that can trigger a paid LLM call. It
 * refuses self-identified crawlers. It also sets `res.locals.llmBudgetExceeded`;
 * the handler then serves only cache hits for that client (see
 * {@link refuseOverBudget}).
 */
export function llmGuard(req: Request, res: Response, next: NextFunction): void {
  if (LLM_BLOCK_BOTS && isCrawlerUserAgent(req.get('user-agent'))) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  res.locals.llmBudgetExceeded = llmBudget.exceeded(clientIp(req))
  next()
}

/** Sends the over-budget 429 and returns true when this request would need a
 *  paid LLM call but the client has used up its daily budget. */
export function refuseOverBudget(res: Response, needsLlm: boolean): boolean {
  if (!needsLlm || !res.locals.llmBudgetExceeded) return false
  res.setHeader('Retry-After', '3600')
  res.status(429).json({ error: 'rate_limited', reason: 'daily_llm_budget' })
  return true
}

export function budgetSnapshot(n = 50): {
  limit: number
  windowHours: number
  top: { ip: string; llmCalls: number; lastSeen: string }[]
} {
  return { limit: llmBudget.limit, windowHours: WINDOW_HOURS, top: llmBudget.top(n) }
}
