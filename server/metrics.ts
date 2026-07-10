/**
 * In-memory counters + structured logs (to-do §9, design doc §12). No metrics
 * infra today, so this is deliberately the "plain structured logs + counters"
 * option the to-do calls "enough to start" — not a Prometheus/StatsD client.
 *
 * Adaptation from the design doc's aspirational per-tier cache hit/miss
 * counters: the implemented cache is a single unified slot (not a separate
 * llm-slot/dict-slot pair, see docs/design-translation-cache.md Appendix), so
 * there's one cache hit/miss count, not one per tier. `outcomeByTier` tracks
 * which tier ultimately served each request instead.
 */
interface LatencyAccumulator {
  sum: number
  count: number
}

const outcomeByTier = new Map<string, number>()
const llmErrorsByVendorAndCode = new Map<string, number>()
const llmLatencyByVendor = new Map<string, LatencyAccumulator>()
let dictFallbackUsed = 0
let dictErrors = 0

export function recordOutcome(tier: 'cache' | 'llm' | 'dictionary'): void {
  outcomeByTier.set(tier, (outcomeByTier.get(tier) ?? 0) + 1)
}

export function recordLlmLatency(vendor: string, ms: number): void {
  const acc = llmLatencyByVendor.get(vendor) ?? { sum: 0, count: 0 }
  acc.sum += ms
  acc.count += 1
  llmLatencyByVendor.set(vendor, acc)
}

export function recordLlmError(vendor: string, code: string): void {
  const key = `${vendor}:${code}`
  llmErrorsByVendorAndCode.set(key, (llmErrorsByVendorAndCode.get(key) ?? 0) + 1)
}

/** Only call when an LLM was actually attempted and failed — not when no LLM
 *  is configured at all, which is a config state, not a reliability signal. */
export function recordDictFallbackUsed(): void {
  dictFallbackUsed += 1
}

export function recordDictError(): void {
  dictErrors += 1
}

export function getMetricsSnapshot() {
  const totalLookups = [...outcomeByTier.values()].reduce((a, b) => a + b, 0)
  const llmErrorTotal = [...llmErrorsByVendorAndCode.values()].reduce((a, b) => a + b, 0)
  const llmAttempts = (outcomeByTier.get('llm') ?? 0) + llmErrorTotal
  return {
    totalLookups,
    outcomeByTier: Object.fromEntries(outcomeByTier),
    llmErrorsByVendorAndCode: Object.fromEntries(llmErrorsByVendorAndCode),
    llmAvgLatencyMsByVendor: Object.fromEntries(
      [...llmLatencyByVendor.entries()].map(([vendor, { sum, count }]) => [
        vendor,
        count > 0 ? Math.round(sum / count) : 0,
      ])
    ),
    dictFallbackUsed,
    dictErrors,
    // Share of LLM attempts that failed and fell through to the dictionary
    // tier — the reliability signal the to-do calls out.
    fallbackRate: llmAttempts > 0 ? Number((llmErrorTotal / llmAttempts).toFixed(3)) : 0,
  }
}

export function logMetricsSummary(): void {
  console.log('[metrics]', JSON.stringify(getMetricsSnapshot()))
}
