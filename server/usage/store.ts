import type { Collection, Db } from 'mongodb'
import type { AccountDoc, CounterDoc, LedgerDoc, UsageAction } from './types'

/**
 * Persistence for usage metering (docs/design-llm-usage-quotas.md §5.3, §5.6).
 * Mongo runs standalone (no transactions), so every limit is enforced by a
 * single-document conditional update: concurrent requests can never push a
 * counter past its limit.
 */
export interface UsageStore {
  /** n += by, only if n + by <= limit. Returns the new n, or null when that would exceed the limit. */
  tryIncrement(id: string, by: number, limit: number, expiresAt: Date): Promise<number | null>
  /** costMicros += micros and n += 1, only if costMicros + micros <= limitMicros. Returns the new costMicros, or null. */
  tryReserveCost(id: string, micros: number, limitMicros: number, expiresAt: Date): Promise<number | null>
  /** Unconditional increments; negative values undo a reservation. */
  add(id: string, inc: { n?: number; costMicros?: number }, expiresAt: Date): Promise<void>
  getCounters(ids: readonly string[]): Promise<Map<string, CounterDoc>>
  getAccount(sub: string): Promise<AccountDoc | null>
  /** Returns the account, creating a default one on first sight, and bumps `lastSeenAt`. */
  ensureAccount(sub: string, now: Date): Promise<AccountDoc>
  updateAccount(sub: string, set: Partial<Omit<AccountDoc, '_id'>>, unset?: Array<keyof AccountDoc>): Promise<AccountDoc | null>
  insertLedger(doc: LedgerDoc): Promise<void>
  /** Cost of the newest charged generations on one provider, for the reservation estimate. */
  recentCosts(routeProviderId: string, action: UsageAction, since: Date, limit: number): Promise<number[]>
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000
}

export function createMongoUsageStore(db: Db): UsageStore {
  const counters: Collection<CounterDoc> = db.collection<CounterDoc>('usage_counters')
  const accounts: Collection<AccountDoc> = db.collection<AccountDoc>('accounts')
  const ledger: Collection<LedgerDoc> = db.collection<LedgerDoc>('usage_ledger')

  /**
   * One conditional upsert. When the doc exists but fails the condition, the
   * upsert collides with it (E11000), which means "limit reached". Two first
   * requests of the day can also collide while creating the doc, so one retry
   * tells the two apart.
   */
  async function conditionalInc(
    id: string,
    condition: Record<string, unknown>,
    $inc: Record<string, number>,
    $setOnInsert: Record<string, unknown>
  ): Promise<CounterDoc | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await counters.findOneAndUpdate(
          { _id: id, ...condition },
          { $inc, $setOnInsert },
          { upsert: true, returnDocument: 'after' }
        )
      } catch (err) {
        if (!isDuplicateKey(err)) throw err
      }
    }
    return null
  }

  return {
    async tryIncrement(id, by, limit, expiresAt) {
      if (by > limit) return null
      const doc = await conditionalInc(id, { n: { $lte: limit - by } }, { n: by }, { costMicros: 0, expiresAt })
      return doc ? doc.n : null
    },

    async tryReserveCost(id, micros, limitMicros, expiresAt) {
      if (micros > limitMicros) return null
      const doc = await conditionalInc(id, { costMicros: { $lte: limitMicros - micros } }, { costMicros: micros, n: 1 }, { expiresAt })
      return doc ? doc.costMicros : null
    },

    async add(id, inc, expiresAt) {
      const $inc: Record<string, number> = {}
      const $setOnInsert: Record<string, unknown> = { expiresAt }
      if (inc.n) $inc.n = inc.n
      else $setOnInsert.n = 0
      if (inc.costMicros) $inc.costMicros = inc.costMicros
      else $setOnInsert.costMicros = 0
      if (Object.keys($inc).length === 0) return
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await counters.updateOne({ _id: id }, { $inc, $setOnInsert }, { upsert: true })
          return
        } catch (err) {
          if (!isDuplicateKey(err) || attempt === 1) throw err
        }
      }
    },

    async getCounters(ids) {
      const docs = await counters.find({ _id: { $in: [...ids] } }).toArray()
      return new Map(docs.map((d) => [d._id, d]))
    },

    getAccount(sub) {
      return accounts.findOne({ _id: sub })
    },

    async ensureAccount(sub, now) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const doc = await accounts.findOneAndUpdate(
            { _id: sub },
            {
              $set: { lastSeenAt: now },
              $setOnInsert: { plan: 'free', status: 'active', createdAt: now, updatedAt: now },
            },
            { upsert: true, returnDocument: 'after' }
          )
          if (doc) return doc
        } catch (err) {
          if (!isDuplicateKey(err)) throw err
        }
      }
      const doc = await accounts.findOne({ _id: sub })
      if (!doc) throw new Error(`account ${sub} could not be created`)
      return doc
    },

    async updateAccount(sub, set, unset = []) {
      const update: Record<string, unknown> = { $set: set }
      if (unset.length > 0) update.$unset = Object.fromEntries(unset.map((k) => [k, '']))
      return accounts.findOneAndUpdate({ _id: sub }, update, { returnDocument: 'after' })
    },

    async insertLedger(doc) {
      await ledger.insertOne(doc)
    },

    async recentCosts(routeProviderId, action, since, limit) {
      const docs = await ledger
        .find(
          { routeProviderId, action, charged: true, ts: { $gte: since } },
          { projection: { costMicros: 1 } }
        )
        .sort({ ts: -1 })
        .limit(limit)
        .toArray()
      return docs.map((d) => d.costMicros)
    },
  }
}

/** In-memory store with the same semantics, for tests and Mongo-less dev. */
export function createMemoryUsageStore(): UsageStore & {
  counters: Map<string, CounterDoc>
  accounts: Map<string, AccountDoc>
  ledger: LedgerDoc[]
} {
  const counters = new Map<string, CounterDoc>()
  const accounts = new Map<string, AccountDoc>()
  const ledger: LedgerDoc[] = []
  const counter = (id: string, expiresAt: Date): CounterDoc => {
    let doc = counters.get(id)
    if (!doc) {
      doc = { _id: id, n: 0, costMicros: 0, expiresAt }
      counters.set(id, doc)
    }
    return doc
  }
  return {
    counters,
    accounts,
    ledger,
    async tryIncrement(id, by, limit, expiresAt) {
      if (by > limit) return null
      const doc = counter(id, expiresAt)
      if (doc.n + by > limit) return null
      doc.n += by
      return doc.n
    },
    async tryReserveCost(id, micros, limitMicros, expiresAt) {
      if (micros > limitMicros) return null
      const doc = counter(id, expiresAt)
      if (doc.costMicros + micros > limitMicros) return null
      doc.costMicros += micros
      doc.n += 1
      return doc.costMicros
    },
    async add(id, inc, expiresAt) {
      const doc = counter(id, expiresAt)
      doc.n += inc.n ?? 0
      doc.costMicros += inc.costMicros ?? 0
    },
    async getCounters(ids) {
      const out = new Map<string, CounterDoc>()
      for (const id of ids) {
        const doc = counters.get(id)
        if (doc) out.set(id, { ...doc })
      }
      return out
    },
    async getAccount(sub) {
      const doc = accounts.get(sub)
      return doc ? { ...doc } : null
    },
    async ensureAccount(sub, now) {
      let doc = accounts.get(sub)
      if (!doc) {
        doc = { _id: sub, plan: 'free', status: 'active', createdAt: now, updatedAt: now }
        accounts.set(sub, doc)
      }
      doc.lastSeenAt = now
      return { ...doc }
    },
    async updateAccount(sub, set, unset = []) {
      const doc = accounts.get(sub)
      if (!doc) return null
      Object.assign(doc, set)
      for (const k of unset) delete (doc as unknown as Record<string, unknown>)[k]
      return { ...doc }
    },
    async insertLedger(doc) {
      ledger.push(doc)
    },
    async recentCosts(routeProviderId, action, since, limit) {
      return ledger
        .filter((d) => d.routeProviderId === routeProviderId && d.action === action && d.charged && d.ts >= since)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime())
        .slice(0, limit)
        .map((d) => d.costMicros)
    },
  }
}
