import { ObjectId } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderDoc } from './providersRepo'
import type { BenchmarkDeps, BenchmarkJob } from './benchmark'
import type { LlmProvider, LlmTranslationRequest, LlmTranslationResult } from '../providers/llm/types'

const KEY = Buffer.alloc(32, 5).toString('base64')

async function freshBenchmark() {
  vi.resetModules()
  return import('./benchmark')
}

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = KEY
})

afterEach(() => {
  delete process.env.CONFIG_ENCRYPTION_KEY
})

function baseProviderDoc(overrides: Partial<LlmProviderDoc> = {}): LlmProviderDoc {
  return {
    _id: new ObjectId(),
    name: 'Test Provider',
    vendor: 'deepseek',
    apiKey: { v: 1, alg: 'aes-256-gcm', iv: 'iv', ct: 'ct', tag: 'tag', keyVersion: 1, last4: '6789' },
    models: [{ id: 'model-a', isDefault: true }],
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedBy: 'auth0|admin',
    ...overrides,
  }
}

function stubProvider(translateImpl: (req: LlmTranslationRequest) => Promise<LlmTranslationResult>): LlmProvider {
  return {
    id: 'llm:test:stub',
    translate: translateImpl,
    moreExamples: vi.fn(),
  }
}

function makeDeps(overrides: Partial<BenchmarkDeps> = {}): BenchmarkDeps {
  return {
    getProviderDoc: vi.fn(async () => null),
    buildEphemeral: vi.fn(() => stubProvider(async () => ({ content: {} }))),
    saveBenchmark: vi.fn(async () => {}),
    recordAudit: vi.fn(async () => {}),
    sleepMs: vi.fn(async () => {}),
    ...overrides,
  }
}

async function waitForJobDone(
  getBenchmarkJob: (runId: string) => BenchmarkJob | undefined,
  runId: string,
  timeoutMs = 2000
): Promise<BenchmarkJob> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const job = getBenchmarkJob(runId)
    if (job && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for benchmark job to finish')
}

describe('admin/benchmark: validateBenchmarkRequest', () => {
  it('rejects non-object input', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    expect(validateBenchmarkRequest(null).ok).toBe(false)
    expect(validateBenchmarkRequest('nope').ok).toBe(false)
  })

  it('rejects a missing or empty targets array', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    expect(validateBenchmarkRequest({}).ok).toBe(false)
    expect(validateBenchmarkRequest({ targets: [] }).ok).toBe(false)
  })

  it('rejects more than 10 targets', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const targets = Array.from({ length: 11 }, (_, i) => ({ providerId: `p${i}` }))
    expect(validateBenchmarkRequest({ targets }).ok).toBe(false)
  })

  it('rejects a target missing providerId', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [{}] })
    expect(result.ok).toBe(false)
  })

  it('accepts a target with only providerId, leaving modelId undefined', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [{ providerId: 'abc123' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.targets).toEqual([{ providerId: 'abc123', modelId: undefined }])
  })

  it('defaults samples to 5 when omitted', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [{ providerId: 'p1' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.samples).toBe(5)
  })

  it('accepts samples at the 1-10 boundary', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], samples: 1 }).ok).toBe(true)
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], samples: 10 }).ok).toBe(true)
  })

  it('rejects samples outside 1-10 or non-integer', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], samples: 0 }).ok).toBe(false)
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], samples: 11 }).ok).toBe(false)
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], samples: 2.5 }).ok).toBe(false)
  })

  it('defaults words to the canonical 5-word list when omitted or null', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const omitted = validateBenchmarkRequest({ targets: [{ providerId: 'p1' }] })
    const nulled = validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], words: null })
    expect(omitted.ok && omitted.value.words).toEqual(['run', 'serendipity', 'take off', 'bank', 'ephemeral'])
    expect(nulled.ok && nulled.value.words).toEqual(['run', 'serendipity', 'take off', 'bank', 'ephemeral'])
  })

  it('rejects an empty custom words array', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], words: [] }).ok).toBe(false)
  })

  it('rejects more than 10 custom words', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const words = Array.from({ length: 11 }, (_, i) => `w${i}`)
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], words }).ok).toBe(false)
  })

  it('rejects a word over 64 chars or blank', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], words: ['x'.repeat(65)] }).ok).toBe(false)
    expect(validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], words: ['   '] }).ok).toBe(false)
  })

  it('accepts and trims valid custom words', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], words: ['  hello  ', 'world'] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.words).toEqual(['hello', 'world'])
  })

  it('defaults sourceLang/targetLang to en/en', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [{ providerId: 'p1' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.sourceLang).toBe('en')
    expect(result.value.targetLang).toBe('en')
  })

  it('trims and lowercases a custom language pair', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [{ providerId: 'p1' }], sourceLang: ' EN ', targetLang: ' Es ' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.sourceLang).toBe('en')
    expect(result.value.targetLang).toBe('es')
  })

  it('accumulates errors from multiple invalid fields at once', async () => {
    const { validateBenchmarkRequest } = await freshBenchmark()
    const result = validateBenchmarkRequest({ targets: [], samples: 99 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('admin/benchmark: summarize', () => {
  it('computes p50/mean/min/max/successRate for an all-success odd-count run', async () => {
    const { summarize } = await freshBenchmark()
    const runs = [100, 200, 300].map((ms) => ({ word: 'w', ms, ok: true, errorCode: null }))
    expect(summarize(runs)).toEqual({ p50: 200, mean: 200, min: 100, max: 300, successRate: 1 })
  })

  it('averages the middle two for an even-count run', async () => {
    const { summarize } = await freshBenchmark()
    const runs = [100, 200, 300, 400].map((ms) => ({ word: 'w', ms, ok: true, errorCode: null }))
    expect(summarize(runs).p50).toBe(250)
  })

  it('excludes failed calls from timing stats but reflects them in successRate', async () => {
    const { summarize } = await freshBenchmark()
    const runs = [
      { word: 'a', ms: 100, ok: true, errorCode: null },
      { word: 'b', ms: 15000, ok: false, errorCode: 'timeout' },
      { word: 'c', ms: 300, ok: true, errorCode: null },
    ]
    const summary = summarize(runs)
    expect(summary.max).toBe(300)
    expect(summary.successRate).toBeCloseTo(2 / 3)
  })

  it('reports all zeros (not NaN) when every call failed', async () => {
    const { summarize } = await freshBenchmark()
    const runs = [
      { word: 'a', ms: 15000, ok: false, errorCode: 'timeout' },
      { word: 'b', ms: 15000, ok: false, errorCode: 'timeout' },
    ]
    expect(summarize(runs)).toEqual({ p50: 0, mean: 0, min: 0, max: 0, successRate: 0 })
  })

  it('handles an empty runs array', async () => {
    const { summarize } = await freshBenchmark()
    expect(summarize([])).toEqual({ p50: 0, mean: 0, min: 0, max: 0, successRate: 0 })
  })
})

describe('admin/benchmark: startBenchmark', () => {
  it('returns target_not_found when a providerId does not resolve', async () => {
    const { startBenchmark } = await freshBenchmark()
    const deps = makeDeps({ getProviderDoc: vi.fn(async () => null) })
    const result = await startBenchmark(
      { targets: [{ providerId: 'deadbeefdeadbeefdeadbeef' }], samples: 1, words: ['run'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    expect(result).toEqual({ ok: false, error: 'target_not_found', providerId: 'deadbeefdeadbeefdeadbeef' })
  })

  it('returns unknown_model when modelId does not match any of the provider doc models', async () => {
    const { startBenchmark } = await freshBenchmark()
    const doc = baseProviderDoc()
    const deps = makeDeps({ getProviderDoc: vi.fn(async () => doc) })
    const result = await startBenchmark(
      { targets: [{ providerId: doc._id.toHexString(), modelId: 'nonexistent' }], samples: 1, words: ['run'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    expect(result).toEqual({ ok: false, error: 'unknown_model', providerId: doc._id.toHexString(), modelId: 'nonexistent' })
  })

  it('returns ok:true with a bm_-prefixed runId and the right total', async () => {
    const { startBenchmark } = await freshBenchmark()
    const doc = baseProviderDoc()
    const deps = makeDeps({ getProviderDoc: vi.fn(async () => doc) })
    const result = await startBenchmark(
      { targets: [{ providerId: doc._id.toHexString() }], samples: 1, words: ['run'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.runId).toMatch(/^bm_[0-9a-f]{6}$/)
    expect(result.total).toBe(1)
  })

  it('returns in_progress when called again while a benchmark is already running', async () => {
    const { startBenchmark } = await freshBenchmark()
    const { encryptSecret } = await import('./crypto')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123') })

    let resolveTranslate: (() => void) | undefined
    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() =>
        stubProvider(
          () =>
            new Promise((resolve) => {
              resolveTranslate = () => resolve({ content: {} })
            })
        )
      ),
    })

    const req = { targets: [{ providerId: doc._id.toHexString() }], samples: 1, words: ['run'], sourceLang: 'en', targetLang: 'en' }
    const first = await startBenchmark(req, 'auth0|admin', '127.0.0.1', deps)
    expect(first.ok).toBe(true)

    const second = await startBenchmark(req, 'auth0|admin', '127.0.0.1', deps)
    expect(second).toEqual({ ok: false, error: 'in_progress' })

    resolveTranslate?.()
  })

  it('allows starting a new benchmark once the previous one has finished', async () => {
    const { startBenchmark, getBenchmarkJob } = await freshBenchmark()
    const { encryptSecret } = await import('./crypto')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123') })
    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() => stubProvider(async () => ({ content: {} }))),
    })

    const req = { targets: [{ providerId: doc._id.toHexString() }], samples: 1, words: ['run'], sourceLang: 'en', targetLang: 'en' }
    const first = await startBenchmark(req, 'auth0|admin', '127.0.0.1', deps)
    if (!first.ok) throw new Error('expected ok')
    await waitForJobDone(getBenchmarkJob, first.runId)

    const second = await startBenchmark(req, 'auth0|admin', '127.0.0.1', deps)
    expect(second.ok).toBe(true)
  })

  it('runs a full benchmark to completion and persists the expected shape', async () => {
    const { startBenchmark, getBenchmarkJob } = await freshBenchmark()
    const { encryptSecret } = await import('./crypto')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123'), name: 'DeepSeek', vendor: 'deepseek' })

    let callCount = 0
    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() =>
        stubProvider(async () => {
          callCount++
          return { content: {}, meta: { completionTokens: 42 } }
        })
      ),
    })

    const result = await startBenchmark(
      { targets: [{ providerId: doc._id.toHexString() }], samples: 3, words: ['run', 'bank'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')

    const job = await waitForJobDone(getBenchmarkJob, result.runId)
    expect(job.status).toBe('done')
    expect(job.completed).toBe(1)
    expect(job.partial).toHaveLength(1)
    expect(job.partial[0].providerName).toBe('DeepSeek')
    expect(job.partial[0].vendor).toBe('deepseek')
    expect(job.partial[0].runs).toHaveLength(3)
    expect(job.partial[0].runs.map((r) => r.tokensOut)).toEqual([42, 42, 42])
    expect(job.partial[0].summary.successRate).toBe(1)
    expect(callCount).toBe(3)

    expect(deps.saveBenchmark).toHaveBeenCalledOnce()
    const savedDoc = (deps.saveBenchmark as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(savedDoc.runId).toBe(result.runId)
    expect(savedDoc.targets[0].providerId).toBeInstanceOf(ObjectId)
    expect(savedDoc.params).toEqual({ samples: 3, words: ['run', 'bank'], sourceLang: 'en', targetLang: 'en' })

    expect(deps.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'benchmark.run', target: { runId: result.runId } })
    )
  })

  it('records a failed call without aborting the run', async () => {
    const { startBenchmark, getBenchmarkJob } = await freshBenchmark()
    const { encryptSecret } = await import('./crypto')
    const { LlmProviderError } = await import('../providers/llm/types')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123') })

    let call = 0
    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() =>
        stubProvider(async () => {
          call++
          if (call === 2) throw new LlmProviderError('timeout', 'boom')
          return { content: {} }
        })
      ),
    })

    const result = await startBenchmark(
      { targets: [{ providerId: doc._id.toHexString() }], samples: 3, words: ['run', 'bank', 'ephemeral'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    if (!result.ok) throw new Error('expected ok')
    const job = await waitForJobDone(getBenchmarkJob, result.runId)
    expect(job.status).toBe('done')
    const target = job.partial[0]
    expect(target.runs.map((r) => r.ok)).toEqual([true, false, true])
    expect(target.runs[1].errorCode).toBe('timeout')
    expect(target.summary.successRate).toBeCloseTo(2 / 3)
  })

  it('synthesizes all-failed runs for a target whose provider fails to build, without failing the job', async () => {
    const { startBenchmark, getBenchmarkJob } = await freshBenchmark()
    const { encryptSecret } = await import('./crypto')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123'), name: 'Broken' })

    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() => {
        throw new Error('boom: bad config')
      }),
    })

    const result = await startBenchmark(
      { targets: [{ providerId: doc._id.toHexString() }], samples: 2, words: ['run'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    if (!result.ok) throw new Error('expected ok')
    const job = await waitForJobDone(getBenchmarkJob, result.runId)
    expect(job.status).toBe('done')
    const target = job.partial[0]
    expect(target.providerName).toBe('Broken')
    expect(target.runs).toHaveLength(2)
    expect(target.runs.every((r) => r.ok === false)).toBe(true)
    expect(target.summary.successRate).toBe(0)
  })

  it('paces calls within a target with sleepMs, but not after the last sample', async () => {
    const { startBenchmark, getBenchmarkJob } = await freshBenchmark()
    const { encryptSecret } = await import('./crypto')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123') })

    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() => stubProvider(async () => ({ content: {} }))),
    })

    const result = await startBenchmark(
      { targets: [{ providerId: doc._id.toHexString() }], samples: 4, words: ['run'], sourceLang: 'en', targetLang: 'en' },
      'auth0|admin',
      '127.0.0.1',
      deps
    )
    if (!result.ok) throw new Error('expected ok')
    await waitForJobDone(getBenchmarkJob, result.runId)
    expect(deps.sleepMs).toHaveBeenCalledTimes(3)
  })
})

describe('admin/benchmark: getBenchmarkJob', () => {
  it('returns undefined for an unknown runId', async () => {
    const { getBenchmarkJob } = await freshBenchmark()
    expect(getBenchmarkJob('bm_doesnotexist')).toBeUndefined()
  })
})

describe('admin/benchmark: parseHistoryQuery', () => {
  it('returns empty options for an empty query', async () => {
    const { parseHistoryQuery } = await freshBenchmark()
    expect(parseHistoryQuery({})).toEqual({})
  })

  it('accepts a valid ObjectId-shaped providerId', async () => {
    const { parseHistoryQuery } = await freshBenchmark()
    const id = new ObjectId().toHexString()
    expect(parseHistoryQuery({ providerId: id })).toEqual({ providerId: id })
  })

  it('drops an invalid providerId', async () => {
    const { parseHistoryQuery } = await freshBenchmark()
    expect(parseHistoryQuery({ providerId: 'not-an-object-id' })).toEqual({})
  })

  it('parses a valid limit', async () => {
    const { parseHistoryQuery } = await freshBenchmark()
    expect(parseHistoryQuery({ limit: '5' })).toEqual({ limit: 5 })
  })

  it('ignores a non-numeric or non-positive limit', async () => {
    const { parseHistoryQuery } = await freshBenchmark()
    expect(parseHistoryQuery({ limit: 'abc' })).toEqual({})
    expect(parseHistoryQuery({ limit: '0' })).toEqual({})
    expect(parseHistoryQuery({ limit: '-5' })).toEqual({})
  })
})
