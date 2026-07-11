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
      llmLatencyByVendor: {},
    })
  })

  describe('llmLatencyByVendor percentiles', () => {
    it('computes p50/p95/p99 from a known 1..100 distribution', async () => {
      const m = await import('./metrics')
      for (let ms = 1; ms <= 100; ms++) m.recordLlmLatency('llm:x', ms)
      const stats = m.getMetricsSnapshot().llmLatencyByVendor['llm:x']
      expect(stats).toEqual({ p50: 50, p95: 95, p99: 99, count: 100, windowSize: 100 })
    })

    it('is order-independent — same samples in reverse give the same percentiles', async () => {
      const m = await import('./metrics')
      for (let ms = 100; ms >= 1; ms--) m.recordLlmLatency('llm:x', ms)
      const stats = m.getMetricsSnapshot().llmLatencyByVendor['llm:x']
      expect(stats).toEqual({ p50: 50, p95: 95, p99: 99, count: 100, windowSize: 100 })
    })

    it('reports windowSize equal to count while under ring capacity', async () => {
      const m = await import('./metrics')
      m.recordLlmLatency('llm:x', 10)
      m.recordLlmLatency('llm:x', 20)
      m.recordLlmLatency('llm:x', 30)
      const stats = m.getMetricsSnapshot().llmLatencyByVendor['llm:x']
      expect(stats).toEqual({ p50: 20, p95: 30, p99: 30, count: 3, windowSize: 3 })
    })

    it('bounds windowSize at 512 while count keeps growing past it', async () => {
      const m = await import('./metrics')
      for (let i = 0; i < 600; i++) m.recordLlmLatency('llm:x', 100)
      const stats = m.getMetricsSnapshot().llmLatencyByVendor['llm:x']
      expect(stats.count).toBe(600)
      expect(stats.windowSize).toBe(512)
    })

    it('wraps circularly — a full second lap of samples fully replaces the first', async () => {
      const m = await import('./metrics')
      for (let i = 0; i < 512; i++) m.recordLlmLatency('llm:x', 1)
      for (let i = 0; i < 512; i++) m.recordLlmLatency('llm:x', 2)
      const stats = m.getMetricsSnapshot().llmLatencyByVendor['llm:x']
      expect(stats).toEqual({ p50: 2, p95: 2, p99: 2, count: 1024, windowSize: 512 })
    })

    it('keeps latency rings independent per vendor', async () => {
      const m = await import('./metrics')
      m.recordLlmLatency('llm:a', 100)
      m.recordLlmLatency('llm:b', 500)
      const snapshot = m.getMetricsSnapshot()
      expect(snapshot.llmLatencyByVendor['llm:a']).toEqual({ p50: 100, p95: 100, p99: 100, count: 1, windowSize: 1 })
      expect(snapshot.llmLatencyByVendor['llm:b']).toEqual({ p50: 500, p95: 500, p99: 500, count: 1, windowSize: 1 })
    })
  })
})
