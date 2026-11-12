import { ObjectId } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmProvider, LlmRegistryResult } from '../providers/llm'
import { MongoUnavailableError, type LlmProviderDoc } from '../admin/providersRepo'
import type { EncryptedSecret } from '../admin/crypto'
import { createLlmService } from './service'

const KEY = Buffer.alloc(32, 5).toString('base64')

const FAKE_SECRET: EncryptedSecret = {
  v: 1,
  alg: 'aes-256-gcm',
  iv: 'iv',
  ct: 'ct',
  tag: 'tag',
  keyVersion: 1,
  last4: '1234',
}

const FAKE_ENV_PROVIDER: LlmProvider = {
  id: 'llm:deepseek:deepseek-chat',
  translate: async () => ({ content: {} }),
  moreExamples: async () => ({ examples: [] }),
}

const ENV_ACTIVE: LlmRegistryResult = { provider: FAKE_ENV_PROVIDER, status: 'active', message: 'env active' }
const ENV_DISABLED: LlmRegistryResult = { provider: null, status: 'disabled', message: 'env disabled' }

function providerDoc(overrides: Partial<LlmProviderDoc> = {}): LlmProviderDoc {
  return {
    _id: new ObjectId(),
    name: 'DB Provider',
    vendor: 'deepseek',
    apiKey: FAKE_SECRET,
    models: [{ id: 'deepseek-chat', isDefault: true }],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: 'auth0|admin',
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.CONFIG_ENCRYPTION_KEY
})

describe('llm/service: env baseline / no DB opinion', () => {
  it('keeps the env baseline when no settings doc exists', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => null,
      getProviderDoc: async () => null,
    })
    await service.reloadFromDb()
    expect(service.current()).toBe(FAKE_ENV_PROVIDER)
    expect(service.status()).toMatchObject({ source: 'env', status: 'active' })
  })

  it('keeps the env baseline when activeProviderId is absent (settings touched only via configVersion)', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', configVersion: 3 }),
      getProviderDoc: async () => null,
    })
    await service.reloadFromDb()
    expect(service.current()).toBe(FAKE_ENV_PROVIDER)
    expect(service.status().source).toBe('env')
  })

  it('returns null when the env baseline itself is disabled and the DB has no opinion', async () => {
    const service = createLlmService(ENV_DISABLED, {
      getSettings: async () => null,
      getProviderDoc: async () => null,
    })
    await service.reloadFromDb()
    expect(service.current()).toBeNull()
    expect(service.status()).toMatchObject({ source: 'env', status: 'disabled' })
  })
})

describe('llm/service: explicit DB off-switch', () => {
  it('goes to db-sourced disabled when activeProviderId is explicitly null (never falls back to env)', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: null, configVersion: 4 }),
      getProviderDoc: async () => null,
    })
    await service.reloadFromDb()
    expect(service.current()).toBeNull()
    expect(service.status()).toMatchObject({ source: 'db', status: 'disabled' })
  })
})

describe('llm/service: DB-configured provider (real encrypt/decrypt + build)', () => {
  it('builds and activates the db-configured provider', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY
    vi.resetModules()
    const { createLlmService: freshCreate } = await import('./service')
    const { encryptSecret } = await import('../admin/crypto')
    const id = new ObjectId()
    const doc = providerDoc({ _id: id, apiKey: encryptSecret('sk-live-123') })

    const service = freshCreate(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: id, configVersion: 5 }),
      getProviderDoc: async () => doc,
    })
    await service.reloadFromDb()
    expect(service.current()?.id).toContain('deepseek')
    expect(service.status()).toMatchObject({ source: 'db', status: 'active', providerName: 'DB Provider' })
  })

  it('honors an explicit activeModelId override', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY
    vi.resetModules()
    const { createLlmService: freshCreate } = await import('./service')
    const { encryptSecret } = await import('../admin/crypto')
    const id = new ObjectId()
    const doc = providerDoc({
      _id: id,
      apiKey: encryptSecret('sk-live-123'),
      models: [
        { id: 'deepseek-chat', isDefault: true },
        { id: 'deepseek-reasoner', isDefault: false },
      ],
    })

    const service = freshCreate(ENV_ACTIVE, {
      getSettings: async () => ({
        _id: 'llm',
        activeProviderId: id,
        activeModelId: 'deepseek-reasoner',
        configVersion: 10,
      }),
      getProviderDoc: async () => doc,
    })
    await service.reloadFromDb()
    expect(service.status().model).toBe('deepseek-reasoner')
  })

  it('falls back to env baseline when the provider fails to build (bad vendor)', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY
    vi.resetModules()
    const { createLlmService: freshCreate } = await import('./service')
    const { encryptSecret } = await import('../admin/crypto')
    const id = new ObjectId()
    const doc = providerDoc({ _id: id, vendor: 'not-a-real-vendor', apiKey: encryptSecret('sk-live-123') })

    const service = freshCreate(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: id, configVersion: 8 }),
      getProviderDoc: async () => doc,
    })
    await service.reloadFromDb()
    expect(service.current()).toBe(FAKE_ENV_PROVIDER)
    expect(service.status().status).toBe('misconfigured')
  })
})

describe('llm/service: dangling / disabled active provider', () => {
  it('falls back to env baseline when activeProviderId is dangling', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: new ObjectId(), configVersion: 6 }),
      getProviderDoc: async () => null,
    })
    await service.reloadFromDb()
    expect(service.current()).toBe(FAKE_ENV_PROVIDER)
    expect(service.status().status).toBe('misconfigured')
  })

  it('falls back to env baseline when the active provider doc is disabled', async () => {
    const id = new ObjectId()
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: id, configVersion: 7 }),
      getProviderDoc: async () => providerDoc({ _id: id, enabled: false }),
    })
    await service.reloadFromDb()
    expect(service.current()).toBe(FAKE_ENV_PROVIDER)
    expect(service.status().status).toBe('misconfigured')
  })
})

describe('llm/service: transient read failures keep the last applied provider', () => {
  it('keeps current state when Mongo is unavailable', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => {
        throw new MongoUnavailableError()
      },
      getProviderDoc: async () => null,
    })
    const before = service.status()
    await service.reloadFromDb()
    expect(service.status()).toEqual(before)
  })

  it('keeps current state when getSettings throws an unexpected error', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => {
        throw new Error('boom')
      },
      getProviderDoc: async () => null,
    })
    const before = service.status()
    await service.reloadFromDb()
    expect(service.status()).toEqual(before)
  })

  it('keeps current state when getProviderDoc throws an unexpected error', async () => {
    const service = createLlmService(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: new ObjectId(), configVersion: 9 }),
      getProviderDoc: async () => {
        throw new Error('timeout')
      },
    })
    const before = service.status()
    await service.reloadFromDb()
    expect(service.status()).toEqual(before)
  })
})

describe('llm/service: fusion (secondary provider)', () => {
  it('builds a FusionProvider when a secondary is configured', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY
    vi.resetModules()
    const { createLlmService: freshCreate } = await import('./service')
    const { encryptSecret } = await import('../admin/crypto')
    const primaryId = new ObjectId()
    const secondaryId = new ObjectId()
    const primaryDoc = providerDoc({ _id: primaryId, apiKey: encryptSecret('sk-p') })
    const secondaryDoc = providerDoc({
      _id: secondaryId,
      name: 'Secondary',
      vendor: 'glm',
      apiKey: encryptSecret('sk-s'),
      models: [{ id: 'glm-5.2', isDefault: true }],
    })

    const docs = new Map<string, LlmProviderDoc>([
      [primaryId.toHexString(), primaryDoc],
      [secondaryId.toHexString(), secondaryDoc],
    ])
    const service = freshCreate(ENV_ACTIVE, {
      getSettings: async () => ({
        _id: 'llm',
        activeProviderId: primaryId,
        secondaryProviderId: secondaryId,
        configVersion: 20,
      }),
      getProviderDoc: async (id: string) => docs.get(id) ?? null,
    })
    await service.reloadFromDb()
    const current = service.current()
    expect(current?.id).toMatch(/^llm:fusion:/)
    expect(service.status()).toMatchObject({
      source: 'db',
      status: 'active',
      providerName: 'DB Provider',
      secondaryProviderName: 'Secondary',
      secondaryModel: 'glm-5.2',
    })
  })

  it('falls back to the primary alone when the secondary is missing', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY
    vi.resetModules()
    const { createLlmService: freshCreate } = await import('./service')
    const { encryptSecret } = await import('../admin/crypto')
    const primaryId = new ObjectId()
    const primaryDoc = providerDoc({ _id: primaryId, apiKey: encryptSecret('sk-p') })

    const docs = new Map<string, LlmProviderDoc>([[primaryId.toHexString(), primaryDoc]])
    const service = freshCreate(ENV_ACTIVE, {
      getSettings: async () => ({
        _id: 'llm',
        activeProviderId: primaryId,
        secondaryProviderId: new ObjectId(), // dangling
        configVersion: 21,
      }),
      getProviderDoc: async (id: string) => docs.get(id) ?? null,
    })
    await service.reloadFromDb()
    // Primary stands alone — no fusion prefix.
    expect(service.current()?.id).toContain('deepseek')
    expect(service.status().secondaryProviderName).toBeUndefined()
  })
})

describe('llm/service: metered route (docs/design-llm-usage-quotas.md §5.4)', () => {
  async function fusionService(metered?: Record<string, unknown>, extraDocs: LlmProviderDoc[] = []) {
    process.env.CONFIG_ENCRYPTION_KEY = KEY
    vi.resetModules()
    const { createLlmService: freshCreate } = await import('./service')
    const { encryptSecret } = await import('../admin/crypto')
    const primaryId = new ObjectId()
    const secondaryId = new ObjectId()
    const docs = new Map<string, LlmProviderDoc>([
      [primaryId.toHexString(), providerDoc({ _id: primaryId, apiKey: encryptSecret('sk-p') })],
      [
        secondaryId.toHexString(),
        providerDoc({
          _id: secondaryId,
          name: 'Secondary',
          vendor: 'glm',
          apiKey: encryptSecret('sk-s'),
          models: [{ id: 'glm-5.2', isDefault: true }],
        }),
      ],
      ...extraDocs.map((d) => [d._id.toHexString(), { ...d, apiKey: encryptSecret('sk-x') }] as [string, LlmProviderDoc]),
    ])
    const service = freshCreate(ENV_ACTIVE, {
      getSettings: async () => ({
        _id: 'llm',
        activeProviderId: primaryId,
        secondaryProviderId: secondaryId,
        configVersion: 30,
        ...(metered ? { metered: metered as never } : {}),
      }),
      getProviderDoc: async (id: string) => docs.get(id) ?? null,
    })
    await service.reloadFromDb()
    return service
  }

  it('defaults to the primary on its own, never the fusion pair', async () => {
    const service = await fusionService()
    expect(service.current()?.id).toMatch(/^llm:fusion:/)
    expect(service.currentMetered()?.id).toBe('llm:deepseek:deepseek-chat')
    expect(service.status().metered).toMatchObject({ mode: 'primary', id: 'llm:deepseek:deepseek-chat' })
  })

  it('"same as owner" gives everyone the full setup', async () => {
    const service = await fusionService({ mode: 'same_as_owner' })
    expect(service.currentMetered()).toBe(service.current())
  })

  it('uses a chosen provider and model', async () => {
    const cheapId = new ObjectId()
    const cheap = providerDoc({ _id: cheapId, name: 'Cheap', vendor: 'openrouter', models: [{ id: 'cheap/model', isDefault: true }] })
    const service = await fusionService({ mode: 'provider', providerId: cheapId, modelId: 'cheap/model' }, [cheap])
    expect(service.currentMetered()?.id).toBe('llm:openrouter:cheap/model')
    expect(service.status().metered).toMatchObject({ mode: 'provider', providerName: 'Cheap', model: 'cheap/model' })
  })

  it('falls back to the primary alone (with a warning) when the chosen provider is gone or disabled', async () => {
    const gone = await fusionService({ mode: 'provider', providerId: new ObjectId() })
    expect(gone.currentMetered()?.id).toBe('llm:deepseek:deepseek-chat')
    expect(gone.status().metered?.warning).toMatch(/no longer exists/)

    const offId = new ObjectId()
    const off = await fusionService({ mode: 'provider', providerId: offId }, [providerDoc({ _id: offId, name: 'Off', enabled: false })])
    expect(off.currentMetered()?.id).toBe('llm:deepseek:deepseek-chat')
    expect(off.status().metered?.warning).toMatch(/disabled/)
  })

  it('is the env provider in env-baseline mode, and off when the LLM tier is off', async () => {
    const env = createLlmService(ENV_ACTIVE, { getSettings: async () => null, getProviderDoc: async () => null })
    await env.reloadFromDb()
    expect(env.currentMetered()).toBe(FAKE_ENV_PROVIDER)

    const off = createLlmService(ENV_ACTIVE, {
      getSettings: async () => ({ _id: 'llm', activeProviderId: null, configVersion: 1 }),
      getProviderDoc: async () => null,
    })
    await off.reloadFromDb()
    expect(off.currentMetered()).toBeNull()
  })
})
