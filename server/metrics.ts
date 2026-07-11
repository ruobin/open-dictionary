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

/** Fixed-capacity circular buffer of the last RING_SIZE latency samples for
 *  one provider id (design doc §9.1) — cheap production tail-latency
 *  percentiles without pulling in a metrics library. Once `buf` reaches
 *  RING_SIZE, writes wrap and overwrite the oldest sample. */
interface LatencyRing {
  buf: number[]
  writeIndex: number
}

const RING_SIZE = 512

const outcomeByTier = new Map<string, number>()
const llmErrorsByVendorAndCode = new Map<string, number>()
const llmLatencyAccByVendor = new Map<string, LatencyAccumulator>()
const llmLatencyRingByVendor = new Map<string, LatencyRing>()
let dictFallbackUsed = 0
let dictErrors = 0

export function recordOutcome(tier: 'cache' | 'llm' | 'dictionary'): void {
  outcomeByTier.set(tier, (outcomeByTier.get(tier) ?? 0) + 1)
}

export function recordLlmLatency(vendor: string, ms: number): void {
  const acc = llmLatencyAccByVendor.get(vendor) ?? { sum: 0, count: 0 }
  acc.sum += ms
  acc.count += 1
  llmLatencyAccByVendor.set(vendor, acc)

  const ring = llmLatencyRingByVendor.get(vendor) ?? { buf: [], writeIndex: 0 }
  ring.buf[ring.writeIndex] = ms
  ring.writeIndex = (ring.writeIndex + 1) % RING_SIZE
  llmLatencyRingByVendor.set(vendor, ring)
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

/** Nearest-rank percentile over an ascending-sorted array (design doc §9.1:
 *  "sort of ≤512 numbers — trivial", so plain nearest-rank is enough —
 *  no need for interpolation). */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.min(Math.max(Math.ceil(p * sortedAsc.length) - 1, 0), sortedAsc.length - 1)
  return sortedAsc[rank]
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
      [...llmLatencyAccByVendor.entries()].map(([vendor, { sum, count }]) => [
        vendor,
        count > 0 ? Math.round(sum / count) : 0,
      ])
    ),
    // Windowed tail-latency percentiles from the last ≤512 samples (§9.1) —
    // `count` is the lifetime total (matches llmAvgLatencyMsByVendor's
    // denominator), `windowSize` is how many of the most recent samples the
    // percentiles were actually computed from (≤512, and < count once a
    // vendor's lifetime traffic exceeds the ring's capacity).
    llmLatencyByVendor: Object.fromEntries(
      [...llmLatencyRingByVendor.entries()].map(([vendor, ring]) => {
        const sorted = [...ring.buf].sort((a, b) => a - b)
        return [
          vendor,
          {
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            p99: percentile(sorted, 0.99),
            count: llmLatencyAccByVendor.get(vendor)?.count ?? sorted.length,
            windowSize: sorted.length,
          },
        ]
      })
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
