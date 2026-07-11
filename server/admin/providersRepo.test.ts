import { ObjectId } from 'mongodb'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { EncryptedSecret } from './crypto'
import type { LlmProviderDoc } from './providersRepo'

const KEY = Buffer.alloc(32, 3).toString('base64')

async function freshRepo() {
  vi.resetModules()
  return import('./providersRepo')
}

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = KEY
})

afterEach(() => {
  delete process.env.CONFIG_ENCRYPTION_KEY
})

const FAKE_SECRET: EncryptedSecret = {
  v: 1,
  alg: 'aes-256-gcm',
  iv: 'iv',
  ct: 'ct',
  tag: 'tag',
  keyVersion: 1,
  last4: '6789',
}

function baseDoc(overrides: Partial<LlmProviderDoc> = {}): LlmProviderDoc {
  return {
    _id: new ObjectId(),
    name: 'Test Provider',
    vendor: 'deepseek',
    apiKey: FAKE_SECRET,
    models: [{ id: 'model-a', isDefault: true }],
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedBy: 'auth0|admin',
    ...overrides,
  }
}

describe('admin/providersRepo: validateProviderFields', () => {
  it('accepts a minimal valid provider and auto-defaults the sole model', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'DeepSeek Prod', vendor: 'deepseek', models: [{ id: 'deepseek-chat' }] },
      true
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.name).toBe('DeepSeek Prod')
    expect(result.value.models).toEqual([{ id: 'deepseek-chat', label: undefined, isDefault: true, timeoutMs: undefined, temperature: undefined }])
  })

  it('rejects an empty name', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields({ name: '  ', vendor: 'deepseek', models: [{ id: 'x' }] }, true)
    expect(result.ok).toBe(false)
  })

  it('rejects a name over 64 chars', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields({ name: 'x'.repeat(65), vendor: 'deepseek', models: [{ id: 'x' }] }, true)
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown vendor', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields({ name: 'X', vendor: 'anthropic', models: [{ id: 'x' }] }, true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.some((e) => e.includes('vendor'))).toBe(true)
  })

  it('requires baseUrl for openai-compat', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields({ name: 'X', vendor: 'openai-compat', models: [{ id: 'x' }] }, true)
    expect(result.ok).toBe(false)
  })

  it('accepts openai-compat with an https baseUrl', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'openai-compat', baseUrl: 'https://proxy.example.com/v1', models: [{ id: 'x' }] },
      true
    )
    expect(result.ok).toBe(true)
  })

  it('rejects an http baseUrl in prod for a public host', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'openai-compat', baseUrl: 'http://proxy.example.com/v1', models: [{ id: 'x' }] },
      true
    )
    expect(result.ok).toBe(false)
  })

  it('allows an http baseUrl in prod for localhost (dev exception)', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'openai-compat', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'x' }] },
      true
    )
    expect(result.ok).toBe(true)
  })

  it('allows an http baseUrl for a public host outside prod', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'openai-compat', baseUrl: 'http://proxy.example.com/v1', models: [{ id: 'x' }] },
      false
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a malformed baseUrl', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'openai-compat', baseUrl: 'not a url', models: [{ id: 'x' }] },
      true
    )
    expect(result.ok).toBe(false)
  })

  it('rejects headers that are not an object', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'deepseek', headers: ['a', 'b'], models: [{ id: 'x' }] },
      true
    )
    expect(result.ok).toBe(false)
  })

  it('drops non-string header values but keeps string ones', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'deepseek', headers: { referer: 'https://x.com', bogus: 5 }, models: [{ id: 'x' }] },
      true
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.headers).toEqual({ referer: 'https://x.com' })
  })

  it('rejects an empty models array', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields({ name: 'X', vendor: 'deepseek', models: [] }, true)
    expect(result.ok).toBe(false)
  })

  it('rejects more than 20 models', async () => {
    const { validateProviderFields } = await freshRepo()
    const models = Array.from({ length: 21 }, (_, i) => ({ id: `m${i}` }))
    const result = validateProviderFields({ name: 'X', vendor: 'deepseek', models }, true)
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate model ids', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'deepseek', models: [{ id: 'dup' }, { id: 'dup' }] },
      true
    )
    expect(result.ok).toBe(false)
  })

  it('rejects more than one isDefault: true', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      {
        name: 'X',
        vendor: 'deepseek',
        models: [
          { id: 'a', isDefault: true },
          { id: 'b', isDefault: true },
        ],
      },
      true
    )
    expect(result.ok).toBe(false)
  })

  it('auto-picks the first model as default when none is flagged', async () => {
    const { validateProviderFields } = await freshRepo()
    const result = validateProviderFields(
      { name: 'X', vendor: 'deepseek', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      true
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.models.map((m) => m.isDefault)).toEqual([true, false, false])
  })

  it('defaults enabled to true when omitted, honors explicit false', async () => {
    const { validateProviderFields } = await freshRepo()
    const omitted = validateProviderFields({ name: 'X', vendor: 'deepseek', models: [{ id: 'a' }] }, true)
    const disabled = validateProviderFields(
      { name: 'X', vendor: 'deepseek', models: [{ id: 'a' }], enabled: false },
      true
    )
    expect(omitted.ok && omitted.value.enabled).toBe(true)
    expect(disabled.ok && disabled.value.enabled).toBe(false)
  })
})

describe('admin/providersRepo: resolveApiKeyForUpdate', () => {
  it('keeps the existing key when apiKey is undefined', async () => {
    const { resolveApiKeyForUpdate } = await freshRepo()
    expect(resolveApiKeyForUpdate(undefined)).toEqual({ keep: true })
  })

  it('keeps the existing key when apiKey is null', async () => {
    const { resolveApiKeyForUpdate } = await freshRepo()
    expect(resolveApiKeyForUpdate(null)).toEqual({ keep: true })
  })

  it('replaces the key when a non-empty string is given', async () => {
    const { resolveApiKeyForUpdate } = await freshRepo()
    expect(resolveApiKeyForUpdate('  sk-new-key  ')).toEqual({ keep: false, plaintext: 'sk-new-key' })
  })

  it('errors on a whitespace-only string', async () => {
    const { resolveApiKeyForUpdate } = await freshRepo()
    const result = resolveApiKeyForUpdate('   ')
    expect('error' in result).toBe(true)
  })
})

describe('admin/providersRepo: resolveModel', () => {
  it('returns the model matching an explicit modelId', async () => {
    const { resolveModel } = await freshRepo()
    const models = [
      { id: 'a', isDefault: true },
      { id: 'b', isDefault: false },
    ]
    expect(resolveModel({ models }, 'b')?.id).toBe('b')
  })

  it('falls back to the default when modelId does not match', async () => {
    const { resolveModel } = await freshRepo()
    const models = [
      { id: 'a', isDefault: true },
      { id: 'b', isDefault: false },
    ]
    expect(resolveModel({ models }, 'nonexistent')?.id).toBe('a')
  })

  it('returns the default when no modelId is given', async () => {
    const { resolveModel } = await freshRepo()
    const models = [
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: true },
    ]
    expect(resolveModel({ models })?.id).toBe('b')
  })

  it('falls back to the first model when none is flagged default', async () => {
    const { resolveModel } = await freshRepo()
    const models = [
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: false },
    ]
    expect(resolveModel({ models })?.id).toBe('a')
  })

  it('returns null for an empty models array', async () => {
    const { resolveModel } = await freshRepo()
    expect(resolveModel({ models: [] })).toBeNull()
  })
})

describe('admin/providersRepo: maskProvider', () => {
  it('masks the secret and stringifies dates without leaking key material', async () => {
    const { maskProvider } = await freshRepo()
    const doc = baseDoc({ lastTest: { at: new Date('2026-01-03T00:00:00.000Z'), ok: true, ms: 120 } })
    const view = maskProvider(doc)
    expect(view.apiKey).toEqual({ set: true, last4: '6789' })
    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(view.lastTest).toEqual({ at: '2026-01-03T00:00:00.000Z', ok: true, ms: 120, errorCode: undefined })
    expect(JSON.stringify(view)).not.toContain(FAKE_SECRET.ct)
  })
})

describe('admin/providersRepo: providerToLlmConfig', () => {
  it('decrypts the key and resolves the default model', async () => {
    const repo = await freshRepo()
    const { encryptSecret } = await import('./crypto')
    const doc = baseDoc({
      apiKey: encryptSecret('sk-abc-999'),
      models: [
        { id: 'a', isDefault: false },
        { id: 'b', isDefault: true },
      ],
    })
    const cfg = repo.providerToLlmConfig(doc)
    expect(cfg.apiKey).toBe('sk-abc-999')
    expect(cfg.model).toBe('b')
    expect(cfg.vendor).toBe('deepseek')
  })

  it('honors an explicit modelId override', async () => {
    const repo = await freshRepo()
    const { encryptSecret } = await import('./crypto')
    const doc = baseDoc({
      apiKey: encryptSecret('sk-abc-999'),
      models: [
        { id: 'a', isDefault: true },
        { id: 'b', isDefault: false },
      ],
    })
    const cfg = repo.providerToLlmConfig(doc, 'b')
    expect(cfg.model).toBe('b')
  })

  it('throws when the provider has no models', async () => {
    const repo = await freshRepo()
    const { encryptSecret } = await import('./crypto')
    const doc = baseDoc({ apiKey: encryptSecret('sk-abc-999'), models: [] })
    expect(() => repo.providerToLlmConfig(doc)).toThrow()
  })
})
