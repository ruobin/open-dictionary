import { getMongoDb } from '../db'
import { LLM_DEFAULT_PRICE_IN_PER_MTOK, LLM_DEFAULT_PRICE_OUT_PER_MTOK } from '../config'
import type { LlmUsageRecord } from '../providers/llm/types'
import type { LedgerCall, UsageAction } from './types'

/**
 * Token usage → money (docs/design-llm-usage-quotas.md §5.5). Prices are set
 * per model in the admin Provider form (`llm_providers.models[].pricing`) and
 * keyed here by provider id, `llm:<vendor>:<model>`. Money is integer
 * micro-USD: a price in USD per million tokens is exactly micro-USD per token.
 */

export interface ModelPrice {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

export function defaultPrice(): ModelPrice {
  return { inputUsdPerMTok: LLM_DEFAULT_PRICE_IN_PER_MTOK, outputUsdPerMTok: LLM_DEFAULT_PRICE_OUT_PER_MTOK }
}

let prices = new Map<string, ModelPrice>()
let loadedAt = 0
let refreshing: Promise<void> | null = null
const REFRESH_MS = 60_000

interface PricedProviderDoc {
  vendor: string
  models: Array<{ id: string; pricing?: ModelPrice }>
}

/** Builds the price map from provider docs. Two entries for the same vendor+model keep the higher price. */
export function buildPriceMap(docs: PricedProviderDoc[]): Map<string, ModelPrice> {
  const map = new Map<string, ModelPrice>()
  for (const doc of docs) {
    for (const model of doc.models ?? []) {
      if (!model.pricing) continue
      const id = `llm:${doc.vendor}:${model.id}`
      const prev = map.get(id)
      map.set(
        id,
        prev
          ? {
              inputUsdPerMTok: Math.max(prev.inputUsdPerMTok, model.pricing.inputUsdPerMTok),
              outputUsdPerMTok: Math.max(prev.outputUsdPerMTok, model.pricing.outputUsdPerMTok),
            }
          : model.pricing
      )
    }
  }
  return map
}

/** Re-reads prices from `llm_providers`. Never throws. */
export async function refreshPrices(): Promise<void> {
  const db = getMongoDb()
  try {
    if (db) {
      const docs = await db
        .collection<PricedProviderDoc>('llm_providers')
        .find({}, { projection: { vendor: 1, 'models.id': 1, 'models.pricing': 1 } })
        .toArray()
      prices = buildPriceMap(docs)
    }
  } catch (err) {
    console.warn('[usage] failed to read model prices — keeping the previous ones:', err)
  } finally {
    loadedAt = Date.now()
  }
}

function maybeRefresh(): void {
  if (Date.now() - loadedAt > REFRESH_MS && !refreshing) {
    refreshing = refreshPrices().finally(() => {
      refreshing = null
    })
  }
}

/** Test hook. */
export function setPricesForTests(map: Map<string, ModelPrice>): void {
  prices = map
  loadedAt = Date.now()
}

export function priceFor(providerId: string): { price: ModelPrice; priced: boolean } {
  maybeRefresh()
  const price = prices.get(providerId)
  return price ? { price, priced: true } : { price: defaultPrice(), priced: false }
}

export function tokensCostMicros(price: ModelPrice, promptTokens: number, completionTokens: number): number {
  return Math.ceil(promptTokens * price.inputUsdPerMTok + completionTokens * price.outputUsdPerMTok)
}

export interface UsageCost {
  costMicros: number
  estimated: boolean
  unpriced: boolean
  calls: LedgerCall[]
}

export function costOf(records: readonly LlmUsageRecord[]): UsageCost {
  let costMicros = 0
  let estimated = false
  let unpriced = false
  const calls: LedgerCall[] = records.map((r) => {
    const { price, priced } = priceFor(r.providerId)
    const cost = tokensCostMicros(price, r.promptTokens, r.completionTokens)
    costMicros += cost
    estimated ||= r.estimated
    unpriced ||= !priced
    return {
      providerId: r.providerId,
      kind: r.kind,
      in: r.promptTokens,
      out: r.completionTokens,
      costMicros: cost,
      estimated: r.estimated,
      ...(priced ? {} : { unpriced: true }),
    }
  })
  return { costMicros, estimated, unpriced, calls }
}

/** Conservative token counts for a generation nothing has been measured for yet. */
const COLD_START_TOKENS: Record<UsageAction, { in: number; out: number }> = {
  lookup: { in: 1_500, out: 1_500 },
  examples: { in: 600, out: 600 },
}

/** Cost of one generation before any has been measured: token guess × the model's price. */
export function coldStartEstimateMicros(providerId: string | undefined, action: UsageAction): number {
  const { price } = providerId ? priceFor(providerId) : { price: defaultPrice() }
  const t = COLD_START_TOKENS[action]
  return tokensCostMicros(price, t.in, t.out)
}

/** The p-th percentile (0–1) of a list of numbers, nearest-rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[rank]
}
