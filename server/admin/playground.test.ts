import { ObjectId } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderDoc } from './providersRepo'
import type { PlaygroundDeps } from './playground'
import type { LlmProvider, LlmTranslationRequest, LlmTranslationResult } from '../providers/llm/types'

const KEY = Buffer.alloc(32, 5).toString('base64')

async function freshPlayground() {
  vi.resetModules()
  return import('./playground')
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

function makeDeps(overrides: Partial<PlaygroundDeps> = {}): PlaygroundDeps {
  return {
    getProviderDoc: vi.fn(async () => null),
    buildEphemeral: vi.fn(() => stubProvider(async () => ({ content: {} }))),
    ...overrides,
  }
}

describe('admin/playground: validatePlaygroundRequest', () => {
  it('rejects non-object input', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    expect(validatePlaygroundRequest(null).ok).toBe(false)
    expect(validatePlaygroundRequest('nope').ok).toBe(false)
  })

  it('rejects a missing or empty targets array', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    expect(validatePlaygroundRequest({ word: 'run' }).ok).toBe(false)
    expect(validatePlaygroundRequest({ targets: [], word: 'run' }).ok).toBe(false)
  })

  it('rejects more than 6 targets', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const targets = Array.from({ length: 7 }, (_, i) => ({ providerId: `p${i}` }))
    expect(validatePlaygroundRequest({ targets, word: 'run' }).ok).toBe(false)
  })

  it('rejects a target missing providerId', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    expect(validatePlaygroundRequest({ targets: [{}], word: 'run' }).ok).toBe(false)
  })

  it('accepts a target with only providerId, leaving modelId undefined', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const result = validatePlaygroundRequest({ targets: [{ providerId: 'abc123' }], word: 'run' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.targets).toEqual([{ providerId: 'abc123', modelId: undefined }])
  })

  it('rejects a missing, blank, or over-length word', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    expect(validatePlaygroundRequest({ targets: [{ providerId: 'p1' }] }).ok).toBe(false)
    expect(validatePlaygroundRequest({ targets: [{ providerId: 'p1' }], word: '   ' }).ok).toBe(false)
    expect(validatePlaygroundRequest({ targets: [{ providerId: 'p1' }], word: 'x'.repeat(129) }).ok).toBe(false)
  })

  it('trims the word', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const result = validatePlaygroundRequest({ targets: [{ providerId: 'p1' }], word: '  run  ' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.word).toBe('run')
  })

  it('defaults sourceLang/targetLang to en/en', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const result = validatePlaygroundRequest({ targets: [{ providerId: 'p1' }], word: 'run' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.sourceLang).toBe('en')
    expect(result.value.targetLang).toBe('en')
  })

  it('trims and lowercases a custom language pair', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const result = validatePlaygroundRequest({
      targets: [{ providerId: 'p1' }],
      word: 'run',
      sourceLang: ' EN ',
      targetLang: ' Es ',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.sourceLang).toBe('en')
    expect(result.value.targetLang).toBe('es')
  })

  it('rejects an unsupported language code', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const result = validatePlaygroundRequest({ targets: [{ providerId: 'p1' }], word: 'run', sourceLang: 'xx' })
    expect(result.ok).toBe(false)
  })

  it('accumulates errors from multiple invalid fields at once', async () => {
    const { validatePlaygroundRequest } = await freshPlayground()
    const result = validatePlaygroundRequest({ targets: [], word: '' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('admin/playground: runPlayground', () => {
  it('returns target_not_found when a providerId does not resolve', async () => {
    const { runPlayground } = await freshPlayground()
    const deps = makeDeps({ getProviderDoc: vi.fn(async () => null) })
    const result = await runPlayground(
      { targets: [{ providerId: 'deadbeefdeadbeefdeadbeef' }], word: 'run', sourceLang: 'en', targetLang: 'en' },
      deps
    )
    expect(result).toEqual({ ok: false, error: 'target_not_found', providerId: 'deadbeefdeadbeefdeadbeef' })
  })

  it('returns unknown_model when modelId does not match any of the provider doc models', async () => {
    const { runPlayground } = await freshPlayground()
    const doc = baseProviderDoc()
    const deps = makeDeps({ getProviderDoc: vi.fn(async () => doc) })
    const result = await runPlayground(
      {
        targets: [{ providerId: doc._id.toHexString(), modelId: 'nonexistent' }],
        word: 'run',
        sourceLang: 'en',
        targetLang: 'en',
      },
      deps
    )
    expect(result).toEqual({
      ok: false,
      error: 'unknown_model',
      providerId: doc._id.toHexString(),
      modelId: 'nonexistent',
    })
  })

  it('runs a successful lookup and adapts the LLM content into entries', async () => {
    const { runPlayground } = await freshPlayground()
    const { encryptSecret } = await import('./crypto')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123'), name: 'DeepSeek', vendor: 'deepseek' })
    const content = { headword: 'run', meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move fast' }] }] }
    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() => stubProvider(async () => ({ content, meta: { completionTokens: 42 } }))),
    })

    const result = await runPlayground(
      { targets: [{ providerId: doc._id.toHexString() }], word: 'run', sourceLang: 'en', targetLang: 'en' },
      deps
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.results).toHaveLength(1)
    const r = result.results[0]
    expect(r.providerName).toBe('DeepSeek')
    expect(r.vendor).toBe('deepseek')
    expect(r.model).toBe('model-a')
    expect(r.ok).toBe(true)
    expect(r.tokensOut).toBe(42)
    expect(r.raw).toEqual(content)
    expect(r.entries).toEqual([
      {
        word: 'run',
        phonetics: [],
        meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'to move fast' }] }],
      },
    ])
  })

  it('records a failed call without throwing, keeping the errorCode', async () => {
    const { runPlayground } = await freshPlayground()
    const { encryptSecret } = await import('./crypto')
    const { LlmProviderError } = await import('../providers/llm/types')
    const doc = baseProviderDoc({ apiKey: encryptSecret('sk-test-123') })
    const deps = makeDeps({
      getProviderDoc: vi.fn(async () => doc),
      buildEphemeral: vi.fn(() =>
        stubProvider(async () => {
          throw new LlmProviderError('timeout', 'boom')
        })
      ),
    })

    const result = await runPlayground(
      { targets: [{ providerId: doc._id.toHexString() }], word: 'run', sourceLang: 'en', targetLang: 'en' },
      deps
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.results[0].ok).toBe(false)
    expect(result.results[0].errorCode).toBe('timeout')
  })

  it('runs multiple targets in parallel and returns results for each', async () => {
    const { runPlayground } = await freshPlayground()
    const { encryptSecret } = await import('./crypto')
    const docA = baseProviderDoc({ apiKey: encryptSecret('sk-a'), name: 'Provider A' })
    const docB = baseProviderDoc({ apiKey: encryptSecret('sk-b'), name: 'Provider B' })
    const deps = makeDeps({
      getProviderDoc: vi.fn(async (id: string) => (id === docA._id.toHexString() ? docA : docB)),
      buildEphemeral: vi.fn(() => stubProvider(async () => ({ content: { headword: 'run' } }))),
    })

    const result = await runPlayground(
      {
        targets: [{ providerId: docA._id.toHexString() }, { providerId: docB._id.toHexString() }],
        word: 'run',
        sourceLang: 'en',
        targetLang: 'en',
      },
      deps
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.results).toHaveLength(2)
    expect(result.results.map((r) => r.providerName).sort()).toEqual(['Provider A', 'Provider B'])
  })

  it('returns not_configured errorCode when config building throws before any call', async () => {
    const { runPlayground } = await freshPlayground()
    const doc = baseProviderDoc({ models: [] })
    const deps = makeDeps({ getProviderDoc: vi.fn(async () => doc) })

    const result = await runPlayground(
      { targets: [{ providerId: doc._id.toHexString() }], word: 'run', sourceLang: 'en', targetLang: 'en' },
      deps
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.results[0].ok).toBe(false)
    expect(result.results[0].errorCode).toBe('not_configured')
  })
})
