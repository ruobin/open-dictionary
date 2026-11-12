import type { Db } from 'mongodb'
import type { BudgetAlertSink } from './meter'

/**
 * Budget alerts (docs/design-llm-usage-quotas.md §4.3): 50 / 80 / 100 % of the
 * monthly free budget, and the first refusal once a day's (or the month's)
 * budget is used up. Each alert fires once, even across restarts: the
 * `usage_alerts` insert with a deterministic id is the dedupe. Delivered as a
 * log line and, when configured, a JSON POST to the alert webhook.
 */

interface AlertDoc {
  _id: string
  type: string
  message: string
  at: Date
  expiresAt: Date
}

export interface AlertPayload {
  type: string
  message: string
  at: string
}

const THRESHOLDS = [0.5, 0.8, 1] as const
const ALERT_TTL_MS = 60 * 86_400_000

function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`
}

export interface BudgetAlertOptions {
  db: () => Db | null
  webhookUrl: () => string | null
  now?: () => Date
  /** Delivery hook, replaceable in tests. */
  post?: (url: string, payload: AlertPayload) => Promise<void>
}

async function postJson(url: string, payload: AlertPayload): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, text: payload.message }),
      signal: controller.signal,
    })
    if (!res.ok) console.warn(`[usage-alert] webhook answered ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

export function createBudgetAlerts(opts: BudgetAlertOptions): BudgetAlertSink {
  const now = opts.now ?? (() => new Date())
  const post = opts.post ?? postJson
  const fired = new Set<string>()

  function fire(id: string, type: string, message: string): void {
    if (fired.has(id)) return
    fired.add(id)
    void (async () => {
      const db = opts.db()
      const at = now()
      if (db) {
        try {
          await db
            .collection<AlertDoc>('usage_alerts')
            .insertOne({ _id: id, type, message, at, expiresAt: new Date(at.getTime() + ALERT_TTL_MS) })
        } catch (err) {
          if ((err as { code?: number })?.code === 11000) return // already sent, e.g. before a restart
          console.warn('[usage-alert] could not record an alert (sending anyway):', err)
        }
      }
      console.warn(`[usage-alert] ${message}`)
      const url = opts.webhookUrl()
      if (url) {
        await post(url, { type, message, at: at.toISOString() }).catch((err: unknown) =>
          console.warn(`[usage-alert] webhook failed: ${(err as Error)?.message ?? err}`)
        )
      }
    })()
  }

  return {
    monthSpend(month, spentMicros, capMicros) {
      if (capMicros <= 0) return
      for (const t of THRESHOLDS) {
        if (spentMicros >= t * capMicros) {
          const pct = Math.round(t * 100)
          fire(`m:${month}:${pct}`, `month_${pct}`, `Free LLM budget: ${pct}% of the ${usd(capMicros)} monthly budget used (${month}, ${usd(spentMicros)} so far).`)
        }
      }
    },
    budgetReached(day, monthExhausted) {
      if (monthExhausted) {
        fire(`m:${day.slice(0, 7)}:exhausted`, 'month_exhausted', `Free LLM budget for ${day.slice(0, 7)} is used up. Free new words are paused until the 1st (00:00 UTC).`)
      } else {
        fire(`d:${day}:exhausted`, 'day_exhausted', `Today's free LLM budget (${day}) is used up. Free new words are paused until 00:00 UTC.`)
      }
    },
  }
}
