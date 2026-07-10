import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as metrics from './metrics'

describe('metrics', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('tracks lookup outcomes by tier', async () => {
    const m = await import('./metrics')
    m.recordOutcome('cache')
    m.recordOutcome('llm')
    m.recordOutcome('llm')
    const snapshot = m.getMetricsSnapshot()
    expect(snapshot.outcomeByTier).toEqual({ cache: 1, llm: 2 })
    expect(snapshot.totalLookups).toBe(3)
  })

  it('averages LLM latency per vendor', async () => {
    const m = await import('./metrics')
    m.recordLlmLatency('llm:deepseek:x', 100)
    m.recordLlmLatency('llm:deepseek:x', 300)
    const snapshot = m.getMetricsSnapshot()
    expect(snapshot.llmAvgLatencyMsByVendor['llm:deepseek:x']).toBe(200)
  })

  it('tracks LLM errors by vendor and code, and computes the fallback rate', async () => {
    const m = await import('./metrics')
    m.recordOutcome('llm')
    m.recordLlmError('llm:deepseek:x', 'timeout')
    m.recordLlmError('llm:deepseek:x', 'timeout')
    m.recordDictFallbackUsed()
    m.recordDictFallbackUsed()
    const snapshot = m.getMetricsSnapshot()
    expect(snapshot.llmErrorsByVendorAndCode['llm:deepseek:x:timeout']).toBe(2)
    expect(snapshot.dictFallbackUsed).toBe(2)
    // 2 errors out of (1 success + 2 errors) = 3 attempts
    expect(snapshot.fallbackRate).toBeCloseTo(2 / 3, 3)
  })

  it('tracks dictionary errors', async () => {
    const m = await import('./metrics')
    m.recordDictError()
    expect(m.getMetricsSnapshot().dictErrors).toBe(1)
  })

  it('returns zero rates/counts with nothing recorded', () => {
    expect(metrics.getMetricsSnapshot()).toMatchObject({
      totalLookups: 0,
      dictFallbackUsed: 0,
      dictErrors: 0,
      fallbackRate: 0,
    })
  })
})
