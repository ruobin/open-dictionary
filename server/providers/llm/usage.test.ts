import { describe, expect, it, vi } from 'vitest'
import { estimateTokens, trackCall } from './usage'
import { runTranslate, type Transport } from './translateFlow'
import { createFusionProvider } from './fusion'
import { LlmProviderError, type LlmProvider, type LlmUsageRecord, type UsageSink } from './types'

function sink(): UsageSink & { records: LlmUsageRecord[] } {
  const records: LlmUsageRecord[] = []
  return { records, add: (r) => records.push(r) }
}

const CORE = JSON.stringify({
  headword: 'run',
  meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move fast on foot' }] }],
})
const EXTRAS = JSON.stringify({ collocations: ['run fast'] })

describe('trackCall', () => {
  it('records vendor-reported usage as is', () => {
    const s = sink()
    trackCall(s, 'llm:a:m', 'core', [{ content: 'prompt' }]).ok('answer', { promptTokens: 10, completionTokens: 20 })
    expect(s.records).toEqual([{ providerId: 'llm:a:m', kind: 'core', promptTokens: 10, completionTokens: 20, estimated: false }])
  })

  it('estimates missing usage from text size (UTF-8 bytes / 3)', () => {
    const s = sink()
    trackCall(s, 'llm:a:m', 'extras', [{ content: 'abcdef' }, { content: 'ghi' }]).ok('日本', undefined)
    expect(s.records[0]).toMatchObject({ promptTokens: estimateTokens('abcdef\nghi'), completionTokens: 2, estimated: true })
  })

  it('skips calls the vendor refused with an HTTP error, estimates ones that may have been billed', () => {
    const s = sink()
    trackCall(s, 'llm:a:m', 'core', [{ content: 'prompt' }]).fail(new LlmProviderError('api_error', '400', 400))
    expect(s.records).toHaveLength(0)
    trackCall(s, 'llm:a:m', 'core', [{ content: 'prompt' }]).fail(new LlmProviderError('timeout'), 'partial text')
    expect(s.records[0]).toMatchObject({ estimated: true, completionTokens: estimateTokens('partial text') })
  })

  it('reports once and survives a throwing sink', () => {
    const tracked = trackCall({ add: () => { throw new Error('boom') } }, 'llm:a:m', 'core', [])
    expect(() => tracked.ok('x', undefined)).not.toThrow()
    const s = sink()
    const once = trackCall(s, 'llm:a:m', 'core', [])
    once.ok('x', { promptTokens: 1, completionTokens: 1 })
    once.fail(new Error('late'))
    expect(s.records).toHaveLength(1)
  })
})

describe('runTranslate usage', () => {
  it('records core and extras, plus a core attempt discarded as unparseable', async () => {
    let coreCalls = 0
    const transport: Transport = async (_messages, call) => {
      if (call.kind === 'extras') return { content: EXTRAS, meta: { promptTokens: 460, completionTokens: 90 } }
      coreCalls += 1
      return coreCalls === 1
        ? { content: 'not json', meta: { promptTokens: 800, completionTokens: 50 } }
        : { content: CORE, meta: { promptTokens: 800, completionTokens: 400 } }
    }
    const s = sink()
    const result = await runTranslate('test', transport, { text: 'run', sourceLang: 'en', targetLang: 'en' }, { usage: s }, {
      retryBadResponse: true,
      providerId: 'llm:test:m',
    })
    expect((result.content as { headword: string }).headword).toBe('run')
    expect(s.records.map((r) => [r.kind, r.promptTokens, r.completionTokens])).toEqual(
      expect.arrayContaining([
        ['core', 800, 50],
        ['core', 800, 400],
        ['extras', 460, 90],
      ])
    )
    expect(s.records).toHaveLength(3)
    expect(s.records.every((r) => r.providerId === 'llm:test:m')).toBe(true)
  })

  it('records a failed extras call that may have been billed', async () => {
    const transport: Transport = async (_messages, call) => {
      if (call.kind === 'extras') throw new LlmProviderError('timeout')
      return { content: CORE, meta: { promptTokens: 800, completionTokens: 400 } }
    }
    const s = sink()
    const result = await runTranslate('test', transport, { text: 'run', sourceLang: 'en', targetLang: 'en' }, { usage: s })
    expect(result.incomplete).toBe(true)
    expect(s.records.find((r) => r.kind === 'extras')).toMatchObject({ estimated: true })
  })
})

describe('fusion usage', () => {
  it('hands the sink to both providers and to the merge call', async () => {
    const content = { headword: 'run', meaningGroups: [] }
    const fake = (id: string): LlmProvider => ({
      id,
      translate: vi.fn(async (_req, opts) => {
        opts?.usage?.add({ providerId: id, kind: 'core', promptTokens: 1, completionTokens: 1, estimated: false })
        return { content }
      }),
      moreExamples: vi.fn(async () => ({ examples: [] })),
      fuse: vi.fn(async (_req, opts) => {
        opts?.usage?.add({ providerId: id, kind: 'fuse', promptTokens: 2, completionTokens: 2, estimated: false })
        return { content }
      }),
    })
    const primary = fake('llm:a:p')
    const secondary = fake('llm:b:s')
    const s = sink()
    const result = await createFusionProvider({ primary, secondary }).translate(
      { text: 'run', sourceLang: 'en', targetLang: 'en' },
      { usage: s }
    )
    await result.upgrade
    expect(s.records.map((r) => `${r.providerId}/${r.kind}`).sort()).toEqual(['llm:a:p/core', 'llm:a:p/fuse', 'llm:b:s/core'])
  })
})
