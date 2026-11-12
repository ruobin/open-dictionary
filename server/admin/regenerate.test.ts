import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import type { TranslationCache } from '../cache/translationCache'
import type { LlmService } from '../llm/service'
import type { LlmProvider } from '../providers/llm'
import type { DictionaryProvider } from '../providers/dictionary'

// The audit log and the entry delete need Mongo; record the calls instead.
const audit = vi.hoisted(() => ({ calls: [] as unknown[] }))
const deleted = vi.hoisted(() => ({ ids: [] as string[], store: null as Map<string, unknown> | null }))
vi.mock('./audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit')>()
  return { ...actual, recordAudit: vi.fn(async (entry: unknown) => void audit.calls.push(entry)) }
})
vi.mock('./entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entries')>()
  return {
    ...actual,
    deleteEntry: vi.fn(async (id: string) => {
      deleted.ids.push(id)
      deleted.store?.delete(id)
      return { reportsResolved: 0 }
    }),
  }
})

const { createAdminRouter } = await import('./router')
const { translationDocId } = await import('../cache/translationCache')
const { CACHE_VERSION } = await import('../translate')

/** Keyed like the real `translations` collection, so the mocked delete hits it. */
function memoryCache(seed?: { word: string; entries: unknown[] }) {
  const store = new Map<string, { entries: unknown[]; source: string }>()
  deleted.store = store
  if (seed) store.set(translationDocId(seed.word, 'en', 'en', CACHE_VERSION), { entries: seed.entries, source: 'llm' })
  const cache: TranslationCache = {
    async get(word, src, tgt, version) {
      const hit = store.get(translationDocId(word, src, tgt, version))
      return hit ? { entries: hit.entries as never, source: hit.source } : null
    },
    async set(word, src, tgt, entries, source, version) {
      store.set(translationDocId(word, src, tgt, version), { entries, source })
    },
  }
  const entriesOf = (word: string) => store.get(translationDocId(word, 'en', 'en', CACHE_VERSION))?.entries
  return { cache, store, entriesOf }
}

async function withAdmin<T>(llm: LlmProvider, cache: TranslationCache, fn: (base: string) => Promise<T>): Promise<T> {
  const app = express()
  app.use(express.json())
  const llmService = { current: () => llm, status: () => ({}) } as unknown as LlmService
  const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => [{ word: 'x', phonetics: [], meanings: [] }]) }
  app.use('/api/admin', createAdminRouter(llmService, { dictionary, cache }))
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /api/admin/entries/regenerate (owner Regenerate)', () => {
  it('replaces a single-model entry with a fresh one from the full setup', async () => {
    const fusion: LlmProvider = {
      id: 'llm:fusion:a+b',
      translate: async () => ({
        content: { headword: 'regenword', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition: 'fresh' }] }] },
      }),
      moreExamples: async () => ({ examples: [] }),
    }
    const { cache, entriesOf } = memoryCache({ word: 'regenword', entries: [{ word: 'regenword', phonetics: [], meanings: [] }] })
    await withAdmin(fusion, cache, async (base) => {
      const res = await post(`${base}/api/admin/entries/regenerate`, { word: 'RegenWord', sourceLang: 'en', targetLang: 'en' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { entries: Array<{ meanings: Array<{ definitions: Array<{ definition: string }> }> }> }
      expect(body.entries[0].meanings[0].definitions[0].definition).toBe('fresh')
    })
    expect(deleted.ids).toHaveLength(1)
    await vi.waitFor(() => expect((entriesOf('regenword')?.[0] as { meanings: unknown[] }).meanings).toHaveLength(1))
    expect(audit.calls.at(-1)).toMatchObject({ action: 'entry.regenerate', diff: { tier: 'llm', replaced: true } })
  })

  it('puts the previous entry back when the fresh generation fails', async () => {
    const broken: LlmProvider = {
      id: 'llm:fusion:a+b',
      translate: async () => {
        throw new Error('model down')
      },
      moreExamples: async () => ({ examples: [] }),
    }
    const previous = [{ word: 'keepword', phonetics: [], meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'old' }] }] }]
    const { cache, entriesOf } = memoryCache({ word: 'keepword', entries: previous })
    await withAdmin(broken, cache, async (base) => {
      const res = await post(`${base}/api/admin/entries/regenerate`, { word: 'keepword' })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'regenerate_failed', restored: true })
    })
    await vi.waitFor(() => expect(entriesOf('keepword')).toEqual(previous))
  })

  it('validates the request', async () => {
    const { cache } = memoryCache()
    const llm: LlmProvider = { id: 'x', translate: async () => ({ content: {} }), moreExamples: async () => ({ examples: [] }) }
    await withAdmin(llm, cache, async (base) => {
      expect((await post(`${base}/api/admin/entries/regenerate`, { word: '' })).status).toBe(400)
      expect((await post(`${base}/api/admin/entries/regenerate`, { word: 'x', sourceLang: 'zz' })).status).toBe(400)
    })
  })
})
