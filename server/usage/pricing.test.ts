import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPriceMap,
  coldStartEstimateMicros,
  costOf,
  defaultPrice,
  percentile,
  setPricesForTests,
  tokensCostMicros,
} from './pricing'

afterEach(() => setPricesForTests(new Map()))

describe('pricing', () => {
  it('keys prices by provider id, keeping the higher price on duplicates', () => {
    const map = buildPriceMap([
      { vendor: 'deepseek', models: [{ id: 'v4-flash', pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 } }, { id: 'unpriced' }] },
      { vendor: 'deepseek', models: [{ id: 'v4-flash', pricing: { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1 } }] },
    ])
    expect(map.get('llm:deepseek:v4-flash')).toEqual({ inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.2 })
    expect(map.has('llm:deepseek:unpriced')).toBe(false)
  })

  it('a price per million tokens is micro-USD per token', () => {
    // 1,300 in / 1,200 out on a $0.30 / $1.20 model ≈ $0.00183 (design §5.5).
    expect(tokensCostMicros({ inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 }, 1_300, 1_200)).toBe(1_830)
  })

  it('costs every call, flags estimated usage and models without a price', () => {
    setPricesForTests(new Map([['llm:a:m', { inputUsdPerMTok: 1, outputUsdPerMTok: 2 }]]))
    const cost = costOf([
      { providerId: 'llm:a:m', kind: 'core', promptTokens: 1_000, completionTokens: 500, estimated: false },
      { providerId: 'llm:b:other', kind: 'extras', promptTokens: 100, completionTokens: 100, estimated: true },
    ])
    const d = defaultPrice()
    expect(cost.costMicros).toBe(2_000 + Math.ceil(100 * d.inputUsdPerMTok + 100 * d.outputUsdPerMTok))
    expect(cost.estimated).toBe(true)
    expect(cost.unpriced).toBe(true)
    expect(cost.calls[1]).toMatchObject({ providerId: 'llm:b:other', unpriced: true })
    expect(cost.calls[0]).not.toHaveProperty('unpriced')
  })

  it('estimates an unmeasured generation from the model price', () => {
    setPricesForTests(new Map([['llm:a:m', { inputUsdPerMTok: 1, outputUsdPerMTok: 1 }]]))
    expect(coldStartEstimateMicros('llm:a:m', 'lookup')).toBe(3_000)
    expect(coldStartEstimateMicros('llm:a:m', 'examples')).toBe(1_200)
  })

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 0.95)).toBe(0)
    expect(percentile([5, 1, 3], 0.5)).toBe(3)
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95)
  })
})
