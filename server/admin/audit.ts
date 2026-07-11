import { ObjectId, type Db } from 'mongodb'
import { getMongoDb } from '../db'
import { MongoUnavailableError } from './providersRepo'

/**
 * Append-only admin change log (docs/design-admin-portal.md §4.5, §5.3).
 * Every admin mutation writes one doc here; nothing ever deletes or edits an
 * entry except the collection's own 365-day TTL (server/db.ts).
 */

function requireDb(): Db {
  const db = getMongoDb()
  if (!db) throw new MongoUnavailableError()
  return db
}

function auditCol(db: Db) {
  return db.collection<AdminAuditDoc>('admin_audit')
}

export type AdminAuditAction =
  | 'provider.create'
  | 'provider.update'
  | 'provider.delete'
  | 'active.switch'
  | 'benchmark.run'
  | 'env.import'

export interface AdminAuditTarget {
  providerId?: string
  name?: string
  /** Correlates a `benchmark.run` entry with its `llm_benchmarks` doc. */
  runId?: string
}

export interface AdminAuditDoc {
  _id: ObjectId
  ts: Date
  actor: string
  ip: string
  action: AdminAuditAction
  target?: { providerId?: ObjectId; name?: string; runId?: string }
  diff?: Record<string, unknown>
}

export interface AdminAuditView {
  id: string
  ts: string
  actor: string
  ip: string
  action: AdminAuditAction
  target?: AdminAuditTarget
  diff?: Record<string, unknown>
}

export interface AdminAuditEntry {
  actor: string
  ip: string
  action: AdminAuditAction
  target?: AdminAuditTarget
  diff?: Record<string, unknown>
}

// --- Redaction (§5.3) — pure, unit-tested without touching Mongo ---

const SENSITIVE_KEY_PATTERN = /api[_-]?key|secret|token|password/i
const ROTATED_NOTE_PATTERN = /^\(rotated, last4=.*\)$/

/** The one sanctioned way to describe a key change in a diff — never the key itself. */
export function rotatedKeyNote(last4: string): string {
  return `(rotated, last4=${last4})`
}

function isMaskedSecretShape(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && 'set' in (value as object) && 'last4' in (value as object)
}

/**
 * Defense-in-depth scrub applied to every diff before it is persisted. Even
 * if a caller accidentally passes a raw key string — or a `{before, after}`
 * pair of raw strings — under an apiKey-shaped field, this replaces it
 * rather than storing it. Once a key name looks sensitive, that verdict
 * propagates to everything nested beneath it (so `apiKey: {before, after}`
 * is caught, not just a flat `apiKey: "…"`). Callers should still prefer
 * {@link rotatedKeyNote} to produce the sanctioned "(rotated, last4=…)"
 * form, which this function recognizes and passes through as-is.
 */
export function redactDiff(diff: unknown): unknown {
  return redactValue(diff, false)
}

function redactValue(value: unknown, parentSensitive: boolean): unknown {
  if (value === null || typeof value !== 'object') {
    if (parentSensitive && typeof value === 'string') {
      return ROTATED_NOTE_PATTERN.test(value) ? value : '(redacted)'
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, parentSensitive))
  if (parentSensitive && isMaskedSecretShape(value)) return value // MaskedSecret — already safe.

  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(v, parentSensitive || SENSITIVE_KEY_PATTERN.test(key))
  }
  return out
}

// --- Query parsing (§8) — pure, unit-tested without touching Mongo ---

export interface ListAuditOptions {
  limit?: number
  before?: Date
}

const DEFAULT_AUDIT_LIMIT = 50
const MAX_AUDIT_LIMIT = 200

/** Parses `GET /api/admin/audit?limit&before` query params into safe, typed options. */
export function parseAuditQuery(query: Record<string, unknown>): ListAuditOptions {
  const options: ListAuditOptions = {}

  const rawLimit = query.limit
  if (typeof rawLimit === 'string' && rawLimit.trim()) {
    const n = Number(rawLimit)
    if (Number.isFinite(n) && n > 0) options.limit = Math.floor(n)
  }

  const rawBefore = query.before
  if (typeof rawBefore === 'string' && rawBefore.trim()) {
    const d = new Date(rawBefore)
    if (!Number.isNaN(d.getTime())) options.before = d
  }

  return options
}

function toView(doc: AdminAuditDoc): AdminAuditView {
  return {
    id: doc._id.toHexString(),
    ts: doc.ts.toISOString(),
    actor: doc.actor,
    ip: doc.ip,
    action: doc.action,
    target: doc.target
      ? { providerId: doc.target.providerId?.toHexString(), name: doc.target.name, runId: doc.target.runId }
      : undefined,
    diff: doc.diff,
  }
}

// --- Mongo I/O ---

/** Writes one audit entry. Never throws away a diff's key material — see {@link redactDiff}. */
export async function recordAudit(entry: AdminAuditEntry): Promise<void> {
  const db = requireDb()
  const providerId =
    entry.target?.providerId && ObjectId.isValid(entry.target.providerId)
      ? new ObjectId(entry.target.providerId)
      : undefined

  const doc: AdminAuditDoc = {
    _id: new ObjectId(),
    ts: new Date(),
    actor: entry.actor,
    ip: entry.ip,
    action: entry.action,
    target: entry.target ? { providerId, name: entry.target.name, runId: entry.target.runId } : undefined,
    diff: entry.diff ? (redactDiff(entry.diff) as Record<string, unknown>) : undefined,
  }
  await auditCol(db).insertOne(doc)
}

/** Newest-first page of audit entries, optionally before a given timestamp (cursor pagination). */
export async function listAudit(options: ListAuditOptions = {}): Promise<AdminAuditView[]> {
  const db = requireDb()
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT)
  const filter = options.before ? { ts: { $lt: options.before } } : {}
  const docs = await auditCol(db).find(filter).sort({ ts: -1 }).limit(limit).toArray()
  return docs.map(toView)
}
