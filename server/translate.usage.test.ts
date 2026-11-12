import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranslateRouter, translate } from './translate'
import type { LlmProvider, LlmTranslationContent } from './providers/llm'
import type { DictionaryProvider } from './providers/dictionary'
import type { TranslationCache } from './cache/translationCache'
import type { LlmService } from './llm/service'
import { createUsageService } from './usage'
import { QuotaDeniedError, type Ticket } from './usage/meter'
import { setPricesForTests } from './usage/pricing'
import { envUsageDefaults, type UsageSettings } from './usage/settings'
import { createMemoryUsageStore } from './usage/store'

const HELLO: LlmTranslationContent = {
  headword: 'hello',
  meaningGroups: [{ partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] }],
}

let seq = 0
const uniqueReq = () => ({ text: `usageword${(seq += 1)}`, sourceLang: 'en', targetLang: 'en' })

function provider(id: string, opts: { fail?: boolean; delayMs?: number } = {}): LlmProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    async translate(_req: unknown, o?: { usage?: { add: (r: never) => void } }) {
      p.calls += 1
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      o?.usage?.add({ providerId: id, kind: 'core', promptTokens: 800, completionTokens: 400, estimated: false } as never)
      if (opts.fail) throw new Error('model down')
      return { content: HELLO }
    },
    async moreExamples() {
      return { examples: [] }
    },
  }
  return p as LlmProvider & { calls: number }
}

const noDictionary = (): DictionaryProvider => ({ id: 'dict:test', define: vi.fn(async () => []) })

function fakeTicket(route: 'full' | 'metered', source: Ticket['source'] = 'free'): Ticket & { settle: ReturnType<typeof vi.fn> } {
  return {
    source,
    route,
    usage: { add: vi.fn() },
    allowance: () => ({ used: 1, limit: 5, pool: 'ip', resetAt: '2026-11-13T00:00:00.000Z' }),
    settle: vi.fn(async () => undefined),
  }
}

afterEach(() => setPricesForTests(new Map()))

describe('translate — metering', () => {
  it('meters only the leader: concurrent joiners pay nothing', async () => {
    const llm = provider('llm:test:full', { delayMs: 20 })
    const req = uniqueReq()
    const ticket = fakeTicket('metered')
    const leaderMeter = vi.fn(async () => ticket)
    const joinerMeter = vi.fn(async () => fakeTicket('metered'))
    const [a, b] = await Promise.all([
      translate(req, () => llm, noDictionary(), null, { meter: leaderMeter }),
      translate(req, () => llm, noDictionary(), null, { meter: joinerMeter }),
    ])
    expect(a.tier).toBe('llm')
    expect(b.tier).toBe('llm')
    expect(leaderMeter).toHaveBeenCalledTimes(1)
    expect(joinerMeter).not.toHaveBeenCalled()
    expect(llm.calls).toBe(1)
    await vi.waitFor(() => expect(ticket.settle).toHaveBeenCalledWith({ charged: true, providerId: 'llm:test:full' }))
  })

  it("a joiner refused only by its leader's quota retries under its own", async () => {
    const llm = provider('llm:test:full', { delayMs: 5 })
    const req = uniqueReq()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const deniedMeter = vi.fn(async () => {
      await gate
      throw new QuotaDeniedError('anon_daily', 5, 5, new Date('2026-11-13T00:00:00Z'), ['sign_in', 'wait'])
    })
    const ownerMeter = vi.fn(async () => fakeTicket('full', 'owner'))
    const leader = translate(req, () => llm, noDictionary(), null, { meter: deniedMeter })
    const joiner = translate(req, () => llm, noDictionary(), null, { meter: ownerMeter })
    release()
    await expect(leader).rejects.toBeInstanceOf(QuotaDeniedError)
    expect((await joiner).tier).toBe('llm')
    expect(ownerMeter).toHaveBeenCalledTimes(1)
    expect(llm.calls).toBe(1)
  })

  it('a refusal writes nothing to the cache and never falls back to the dictionary', async () => {
    const llm = provider('llm:test:full')
    const set = vi.fn(async () => undefined)
    const cache: TranslationCache = { get: async () => null, set }
    const dictionary = noDictionary()
    const meter = async (): Promise<Ticket> => {
      throw new QuotaDeniedError('user_daily', 20, 20, new Date(), ['wait'])
    }
    await expect(translate(uniqueReq(), () => llm, dictionary, cache, { meter })).rejects.toBeInstanceOf(QuotaDeniedError)
    expect(set).not.toHaveBeenCalled()
    expect(dictionary.define).not.toHaveBeenCalled()
    expect(llm.calls).toBe(0)
  })

  it('routes by ticket: the owner gets the full setup, everyone else the metered model', async () => {
    const full = provider('llm:fusion:a+b')
    const metered = provider('llm:test:cheap')
    const router = (route: 'full' | 'metered') => (route === 'full' ? full : metered)
    await translate(uniqueReq(), router, noDictionary(), null, { meter: async () => fakeTicket('metered') })
    expect([full.calls, metered.calls]).toEqual([0, 1])
    await translate(uniqueReq(), router, noDictionary(), null, { meter: async () => fakeTicket('full', 'owner') })
    expect([full.calls, metered.calls]).toEqual([1, 1])
  })

  it('settles an LLM failure as not charged (the dictionary answered)', async () => {
    const ticket = fakeTicket('metered')
    const dictionary: DictionaryProvider = {
      id: 'dict:test',
      define: vi.fn(async () => [{ word: 'hello', phonetics: [], meanings: [] }]),
    }
    const outcome = await translate(uniqueReq(), () => provider('llm:test:cheap', { fail: true }), dictionary, null, {
      meter: async () => ticket,
    })
    expect(outcome.tier).toBe('dictionary')
    await vi.waitFor(() => expect(ticket.settle).toHaveBeenCalledWith({ charged: false, providerId: 'llm:test:cheap' }))
  })

  it('settles after background work, so a fusion upgrade is part of the cost', async () => {
    const ticket = fakeTicket('full', 'owner')
    let finishUpgrade!: (v: LlmTranslationContent | null) => void
    const upgrade = new Promise<LlmTranslationContent | null>((r) => {
      finishUpgrade = r
    })
    const llm: LlmProvider = {
      id: 'llm:fusion:a+b',
      async translate() {
        return { content: HELLO, upgrade }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const cache: TranslationCache = { get: async () => null, set: async () => undefined }
    await translate(uniqueReq(), () => llm, noDictionary(), cache, { meter: async () => ticket })
    await new Promise((r) => setTimeout(r, 10))
    expect(ticket.settle).not.toHaveBeenCalled()
    finishUpgrade(null)
    await vi.waitFor(() => expect(ticket.settle).toHaveBeenCalledTimes(1))
  })
})

describe('translate routes — metering over HTTP', () => {
  let ipSeq = 0
  const get = (url: string): Promise<Response> => fetch(url, { headers: { 'x-forwarded-for': `10.9.0.${(ipSeq += 1)}` } })

  async function withServer<T>(settings: Partial<UsageSettings>, fn: (base: string, llm: ReturnType<typeof provider>) => Promise<T>): Promise<T> {
    setPricesForTests(new Map([['llm:test:cheap', { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 }]]))
    const llm = provider('llm:test:cheap')
    const app = express()
    app.set('trust proxy', true)
    app.locals.llmService = { current: () => llm, currentMetered: () => llm } as unknown as LlmService
    const usage = createUsageService({
      db: null,
      directory: null,
      store: createMemoryUsageStore(),
      meteredProviderId: () => llm.id,
      settings: () => ({
        ...envUsageDefaults(),
        enforcement: 'on',
        freeTierEnabled: true,
        pacing: 'even',
        anonDailyPerIp: 5,
        anonShare: 0.5,
        userDailyFree: 20,
        freeTierDailyUsd: 1,
        freeTierMonthlyUsd: 5,
        alertWebhookUrl: null,
        ...settings,
      }),
    })
    app.use('/api', createTranslateRouter(noDictionary(), null, { usage }))
    const server: Server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, llm)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('a stream refusal is a plain HTTP 429 with a JSON body, because no headers were sent yet', async () => {
    await withServer({ anonDailyPerIp: 0 }, async (base, llm) => {
      const res = await get(`${base}/api/translate-stream/${uniqueReq().text}`)
      expect(res.status).toBe(429)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(await res.json()).toMatchObject({ error: 'quota_exceeded', reason: 'anon_daily', actions: ['sign_in', 'wait'] })
      expect(llm.calls).toBe(0)
    })
  })

  it('/translate refuses the same way', async () => {
    await withServer({ freeTierEnabled: false }, async (base) => {
      const res = await get(`${base}/api/translate/${uniqueReq().text}`)
      expect(res.status).toBe(429)
      expect(await res.json()).toMatchObject({ reason: 'free_tier_paused' })
    })
  })

  it('tells the client about a charged generation: a usage event before done, an X-Generation header', async () => {
    await withServer({}, async (base) => {
      const stream = await get(`${base}/api/translate-stream/${uniqueReq().text}`)
      expect(stream.headers.get('content-type')).toContain('text/event-stream')
      const text = await stream.text()
      const usageAt = text.indexOf('event: usage')
      expect(usageAt).toBeGreaterThan(-1)
      expect(usageAt).toBeLessThan(text.indexOf('event: done'))
      expect(text).toContain('"pool":"ip"')

      const plain = await get(`${base}/api/translate/${uniqueReq().text}`)
      expect(plain.status).toBe(200)
      expect(plain.headers.get('x-generation')).toBe('charged')
    })
  })
})
