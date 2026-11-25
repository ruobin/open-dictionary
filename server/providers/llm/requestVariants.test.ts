import { describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_RUNGS,
  GLM_RUNGS,
  OPENROUTER_RUNGS,
  RESPONSES_RUNGS,
  RUNAWAY_MAX_TOKENS,
  buildLadder,
  createOptionalOutputCap,
  createVariantLadder,
  hasOutputCap,
  hasReasoningOverride,
} from './requestVariants'
import { LlmProviderError } from './types'

const badRequest = (): LlmProviderError => new LlmProviderError('api_error', 'bad', 400)

describe('createVariantLadder', () => {
  it('uses the first rung when it works', async () => {
    const ladder = createVariantLadder([{ a: 1 }, {}])
    const fn = vi.fn(async (body: Record<string, unknown>) => body)
    expect(await ladder.run(fn)).toEqual({ a: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(ladder.current).toBe(0)
  })

  it('steps down on 400/422 and remembers the rung that worked', async () => {
    const ladder = createVariantLadder([{ a: 1 }, { b: 2 }, {}])
    const fn = vi.fn(async (body: Record<string, unknown>) => {
      if ('a' in body) throw badRequest()
      return body
    })
    expect(await ladder.run(fn)).toEqual({ b: 2 })
    expect(ladder.current).toBe(1)

    fn.mockClear()
    expect(await ladder.run(fn)).toEqual({ b: 2 })
    expect(fn).toHaveBeenCalledTimes(1) // no wasted retry of rung 0
  })

  it('does not downgrade permanently when every rung fails', async () => {
    const ladder = createVariantLadder([{ a: 1 }, {}])
    await expect(
      ladder.run(async () => {
        throw badRequest()
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(ladder.current).toBe(0)
  })

  it('does not step down on non-400 errors', async () => {
    const ladder = createVariantLadder([{ a: 1 }, {}])
    const fn = vi.fn(async () => {
      throw new LlmProviderError('api_error', 'rate limited', 429)
    })
    await expect(ladder.run(fn)).rejects.toMatchObject({ status: 429 })
    expect(fn).toHaveBeenCalledTimes(1)

    const timeout = vi.fn(async () => {
      throw new LlmProviderError('timeout', 'slow')
    })
    await expect(ladder.run(timeout)).rejects.toMatchObject({ code: 'timeout' })
    expect(timeout).toHaveBeenCalledTimes(1)
  })
})

describe('buildLadder', () => {
  it('layers admin requestBody on every rung', async () => {
    const ladder = buildLadder([{ thinking: { type: 'disabled' } }, {}], { max_tokens: 99 })
    const seen: Array<Record<string, unknown>> = []
    await ladder.run(async (b) => {
      seen.push(b)
      if (seen.length === 1) throw badRequest()
    })
    expect(seen).toEqual([{ thinking: { type: 'disabled' }, max_tokens: 99 }, { max_tokens: 99 }])
  })

  it('drops the built-in reasoning rungs when the admin controls reasoning', async () => {
    const ladder = buildLadder([{ thinking: { type: 'disabled' } }, {}], { thinking: { type: 'enabled' } })
    const fn = vi.fn(async (b: Record<string, unknown>) => b)
    expect(await ladder.run(fn)).toEqual({ thinking: { type: 'enabled' } })
    expect(hasReasoningOverride({ reasoning_effort: 'low' })).toBe(true)
    expect(hasReasoningOverride({ max_tokens: 5 })).toBe(false)
  })
})

describe('vendor reasoning-off rungs', () => {
  it('lead with the vendor-documented "off" switch', () => {
    expect(DEEPSEEK_RUNGS[0]).toEqual({ thinking: { type: 'disabled' } })
    expect(GLM_RUNGS[0]).toEqual({ thinking: { type: 'disabled' } })
    expect(OPENROUTER_RUNGS[0]).toEqual({ reasoning: { effort: 'none' } })
    expect(RESPONSES_RUNGS[0]).toEqual({ reasoning: { effort: 'none' } })
  })

  it('always end in a plain request so a model can never be locked out', () => {
    for (const rungs of [DEEPSEEK_RUNGS, GLM_RUNGS, OPENROUTER_RUNGS, RESPONSES_RUNGS]) {
      expect(rungs[rungs.length - 1]).toEqual({})
    }
  })
})

describe('createOptionalOutputCap', () => {
  const cap = () => createOptionalOutputCap('max_tokens', 1000, 'llm:test:model')

  it('sends the cap when the endpoint accepts it', async () => {
    const c = cap()
    const fn = vi.fn(async (body: Record<string, unknown>) => body)
    expect(await c.run(fn)).toEqual({ max_tokens: 1000 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(c.enabled).toBe(true)
  })

  it('retries without the cap on 400/422 and, once that works, stops sending it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const c = cap()
    const fn = vi.fn(async (body: Record<string, unknown>) => {
      if ('max_tokens' in body) throw badRequest()
      return body
    })
    expect(await c.run(fn)).toEqual({})
    expect(fn).toHaveBeenCalledTimes(2)
    expect(c.enabled).toBe(false)

    expect(await c.run(fn)).toEqual({})
    expect(fn).toHaveBeenCalledTimes(3) // no wasted round trip the second time
    vi.restoreAllMocks()
  })

  it('keeps the cap, and rethrows the original error, when the request fails without it too', async () => {
    const c = cap()
    const first = badRequest()
    const fn = vi.fn(async (body: Record<string, unknown>) => {
      if ('max_tokens' in body) throw first
      throw new LlmProviderError('api_error', 'still bad', 400)
    })
    await expect(c.run(fn)).rejects.toBe(first)
    expect(c.enabled).toBe(true)
  })

  it('does not retry errors that are not a refusal of the request', async () => {
    const c = cap()
    const fn = vi.fn(async () => {
      throw new LlmProviderError('timeout', 'slow')
    })
    await expect(c.run(fn)).rejects.toMatchObject({ code: 'timeout' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(c.enabled).toBe(true)
  })
})

describe('hasOutputCap', () => {
  it('recognises each output-cap field an admin may set', () => {
    expect(hasOutputCap({ max_tokens: 1 })).toBe(true)
    expect(hasOutputCap({ max_completion_tokens: 1 })).toBe(true)
    expect(hasOutputCap({ max_output_tokens: 1 })).toBe(true)
    expect(hasOutputCap({ temperature: 0 })).toBe(false)
    expect(hasOutputCap(undefined)).toBe(false)
  })

  it('the runaway cap is looser than the per-call caps, to leave room for reasoning tokens', () => {
    expect(RUNAWAY_MAX_TOKENS).toBeGreaterThan(4096)
  })
})
