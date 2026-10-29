import { describe, expect, it, vi } from 'vitest'
import { normalizeText, adaptLlm, translate } from './translate'
import type { LlmProvider, LlmTranslationContent } from './providers/llm'
import type { DictionaryProvider } from './providers/dictionary'

describe('normalizeText', () => {
  it('trims, lowercases, and collapses consecutive whitespace', () => {
    expect(normalizeText('  Hello   WORLD  ')).toBe('hello world')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeText('   ')).toBe('')
  })

  it('NFC‑normalises', () => {
    // "café" is already NFC; the call is still side‑effect‑free.
    expect(normalizeText('café')).toBe('café')
  })

  it('truncates at 256 characters', () => {
    const long = 'a'.repeat(300)
    const result = normalizeText(long)
    expect(result.length).toBe(256)
    expect(result).toBe('a'.repeat(256))
  })
})

describe('adaptLlm', () => {
  it('maps headword, phonetics and phonetic', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      phonetic: '/həˈloʊ/',
    }
    const [entry] = adaptLlm(content)
    expect(entry.word).toBe('hello')
    expect(entry.phonetic).toBe('/həˈloʊ/')
    expect(entry.phonetics).toEqual([{ text: '/həˈloʊ/' }])
  })

  it('maps a meaning group → one Meaning per part of speech, with graded fields', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      meaningGroups: [
        {
          partOfSpeech: 'interjection',
          senses: [
            {
              definition: 'A greeting',
              cefr: 'A1',
              register: 'informal',
              examples: [
                { text: 'Hello there!', cefr: 'A1' },
                { text: 'A cheery hello rang out across the room.', cefr: 'B2' },
              ],
            },
            { definition: 'An exclamation of surprise' },
          ],
        },
      ],
    }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toHaveLength(1)
    const m = entry.meanings[0]
    expect(m.partOfSpeech).toBe('interjection')
    expect(m.definitions).toHaveLength(2)
    expect(m.definitions[0]).toEqual({
      definition: 'A greeting',
      cefr: 'A1',
      register: 'informal',
      examples: [
        { text: 'Hello there!', cefr: 'A1' },
        { text: 'A cheery hello rang out across the room.', cefr: 'B2' },
      ],
    })
    expect(m.definitions[1]).toEqual({ definition: 'An exclamation of surprise' })
  })

  it('keeps separate parts of speech as separate Meaning entries', () => {
    const content: LlmTranslationContent = {
      headword: 'run',
      meaningGroups: [
        { partOfSpeech: 'verb', senses: [{ definition: 'To move fast on foot' }] },
        { partOfSpeech: 'noun', senses: [{ definition: 'An act of running' }] },
      ],
    }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toHaveLength(2)
    expect(entry.meanings[0].partOfSpeech).toBe('verb')
    expect(entry.meanings[1].partOfSpeech).toBe('noun')
  })

  it('returns empty phonetics and meanings when none are provided', () => {
    const content: LlmTranslationContent = { headword: 'test' }
    const [entry] = adaptLlm(content)
    expect(entry.phonetics).toEqual([])
    expect(entry.meanings).toEqual([])
  })

  it('skips meanings when meaningGroups is empty', () => {
    const content: LlmTranslationContent = { headword: 'a', meaningGroups: [] }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toEqual([])
  })

  it('does not fail when content has unknown extra fields', () => {
    const content = { headword: 'b', extra: 123 } as unknown as LlmTranslationContent
    const [entry] = adaptLlm(content)
    expect(entry.word).toBe('b')
  })

  it('passes through a typo suggestion (with explanation)', () => {
    const content: LlmTranslationContent = {
      headword: 'helo',
      typo: { suggestion: 'hello', explanation: 'Did you mean “hello”?' },
    }
    const [entry] = adaptLlm(content)
    expect(entry.word).toBe('helo')
    expect(entry.typo).toEqual({ suggestion: 'hello', explanation: 'Did you mean “hello”?' })
    expect(entry.meanings).toEqual([])
    expect(entry.phonetics).toEqual([])
  })

  it('passes through a typo suggestion (without explanation)', () => {
    const content: LlmTranslationContent = {
      headword: 'teh',
      typo: { suggestion: 'the' },
    }
    const [entry] = adaptLlm(content)
    expect(entry.typo).toEqual({ suggestion: 'the' })
  })

  it('omits the typo field when not present', () => {
    const content: LlmTranslationContent = { headword: 'hello' }
    const [entry] = adaptLlm(content)
    expect(entry.typo).toBeUndefined()
  })

  it('maps translation, commonMistakes, collocations, and wordFamily through', () => {
    const content: LlmTranslationContent = {
      headword: 'photo',
      translation: 'foto',
      commonMistakes: [{ wrong: 'make a photo', right: 'take a photo', note: 'Use "take", not "make".' }],
      collocations: ['take a photo', 'photo album'],
      wordFamily: ['photography', 'photographer'],
    }
    const [entry] = adaptLlm(content)
    expect(entry.translation).toBe('foto')
    expect(entry.commonMistakes).toEqual([
      { wrong: 'make a photo', right: 'take a photo', note: 'Use "take", not "make".' },
    ])
    expect(entry.collocations).toEqual(['take a photo', 'photo album'])
    expect(entry.wordFamily).toEqual(['photography', 'photographer'])
  })

  it('omits translation/commonMistakes/collocations/wordFamily when absent or empty', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      commonMistakes: [],
      collocations: [],
      wordFamily: [],
    }
    const [entry] = adaptLlm(content)
    expect(entry.translation).toBeUndefined()
    expect(entry.commonMistakes).toBeUndefined()
    expect(entry.collocations).toBeUndefined()
    expect(entry.wordFamily).toBeUndefined()
  })
})

describe('translate — in-flight dedup', () => {
  it('shares one LLM call across concurrent lookups for the same word', async () => {
    let calls = 0
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate() {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { content: { headword: 'hello', meaningGroups: [{ partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] }] } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = { text: 'hello', sourceLang: 'en', targetLang: 'en' }

    const [a, b] = await Promise.all([
      translate(req, llm, dictionary, null),
      translate(req, llm, dictionary, null),
    ])

    expect(calls).toBe(1)
    expect(a.tier).toBe('llm')
    expect(b.tier).toBe('llm')
    expect(a.entries).toEqual(b.entries)
  })

  it('does not dedup sequential (non-overlapping) lookups', async () => {
    let calls = 0
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate() {
        calls += 1
        return { content: { headword: 'hello', meaningGroups: [{ partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] }] } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = { text: 'hello', sourceLang: 'en', targetLang: 'en' }

    await translate(req, llm, dictionary, null)
    await translate(req, llm, dictionary, null)

    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Orchestration: parallel audio, background cache writes, partials, upgrades
// ---------------------------------------------------------------------------

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createTranslateRouter } from './translate'
import type { TranslationCache } from './cache/translationCache'
import type { LlmService } from './llm/service'

const HELLO: LlmTranslationContent = {
  headword: 'hello',
  meaningGroups: [{ partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] }],
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function llmReturning(
  result: () => Promise<{ content: unknown; incomplete?: boolean; upgrade?: Promise<LlmTranslationContent | null> }>,
  onCall?: () => void
): LlmProvider {
  return {
    id: 'llm:test:test',
    async translate(_req, opts) {
      onCall?.()
      void opts
      return result()
    },
    async moreExamples() {
      return { examples: [] }
    },
  }
}

function memoryCache() {
  const store = new Map<string, DictionaryEntryLike[]>()
  type DictionaryEntryLike = { word: string; phonetics: Array<{ audio?: string }> }
  const sets: Array<{ word: string; entries: DictionaryEntryLike[] }> = []
  const gate = { current: Promise.resolve() as Promise<void> }
  const cache: TranslationCache = {
    async get(word, src, tgt) {
      const hit = store.get(`${src}|${tgt}|${word}`)
      return hit ? { entries: hit as never, source: 'llm' } : null
    },
    async set(word, src, tgt, entries) {
      await gate.current
      sets.push({ word, entries: entries as never })
      store.set(`${src}|${tgt}|${word}`, entries as never)
    },
  }
  return { cache, sets, gate }
}

let wordSeq = 0
const uniqueReq = () => ({ text: `word${(wordSeq += 1)}`, sourceLang: 'en', targetLang: 'en' })

describe('translate — orchestration', () => {
  it('starts the audio lookup in parallel with the LLM call, not after it', async () => {
    const llmGate = deferred()
    const events: string[] = []
    const llm = llmReturning(
      async () => {
        await llmGate.promise
        events.push('llm-done')
        return { content: HELLO }
      },
      () => events.push('llm-start')
    )
    const dictionary: DictionaryProvider = {
      id: 'dict:test',
      define: vi.fn(async () => {
        events.push('audio-start')
        return [{ phonetics: [{ audio: 'https://x/a.mp3' }] }]
      }),
    }
    const pending = translate(uniqueReq(), llm, dictionary, null)
    await new Promise((r) => setTimeout(r, 5))
    expect(events).toEqual(expect.arrayContaining(['llm-start', 'audio-start']))
    expect(events).not.toContain('llm-done')
    llmGate.resolve()
    const outcome = await pending
    expect(outcome.entries[0].phonetics).toEqual([{ audio: 'https://x/a.mp3' }])
  })

  it('answers without waiting for a slow audio lookup, and caches the audio once it arrives', async () => {
    const audioGate = deferred<unknown[]>()
    const { cache, sets } = memoryCache()
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(() => audioGate.promise) }
    const req = uniqueReq()

    vi.useFakeTimers()
    const pending = translate(req, llmReturning(async () => ({ content: HELLO })), dictionary, cache)
    await vi.advanceTimersByTimeAsync(2_000) // past the audio grace period
    vi.useRealTimers()
    const outcome = await pending

    expect(outcome.entries[0].phonetics).toEqual([]) // answered without audio
    await vi.waitFor(() => expect(sets).toHaveLength(1))
    expect(sets[0].entries[0].phonetics).toEqual([])

    audioGate.resolve([{ phonetics: [{ audio: 'https://x/late.mp3' }] }])
    await vi.waitFor(() => expect(sets).toHaveLength(2))
    expect(sets[1].entries[0].phonetics).toEqual([{ audio: 'https://x/late.mp3' }])
  })

  it('does not make the user wait for the cache write', async () => {
    const { cache, sets, gate } = memoryCache()
    const writeGate = deferred()
    gate.current = writeGate.promise
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }

    const outcome = await translate(uniqueReq(), llmReturning(async () => ({ content: HELLO })), dictionary, cache)

    expect(outcome.tier).toBe('llm')
    expect(sets).toHaveLength(0) // response is out; the write is still pending
    writeGate.resolve()
    await vi.waitFor(() => expect(sets).toHaveLength(1))
  })

  it('a request arriving after the response but before the cache write joins instead of paying for a second LLM call', async () => {
    const { cache, gate } = memoryCache()
    const writeGate = deferred()
    gate.current = writeGate.promise
    let calls = 0
    const llm = llmReturning(async () => ({ content: HELLO }), () => (calls += 1))
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = uniqueReq()

    await translate(req, llm, dictionary, cache)
    await translate(req, llm, dictionary, cache)
    expect(calls).toBe(1)

    writeGate.resolve()
    await new Promise((r) => setTimeout(r, 5))
    // Once the write has landed the entry is released and the cache serves it.
    expect((await translate(req, llm, dictionary, cache)).tier).toBe('cache')
    expect(calls).toBe(1)
  })

  it('serves but never caches an incomplete answer', async () => {
    const { cache, sets } = memoryCache()
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const outcome = await translate(
      uniqueReq(),
      llmReturning(async () => ({ content: HELLO, incomplete: true })),
      dictionary,
      cache
    )
    expect(outcome.tier).toBe('llm')
    await new Promise((r) => setTimeout(r, 10))
    expect(sets).toHaveLength(0)
  })

  it('fusion: caches the fast answer, then overwrites it with the merged upgrade', async () => {
    const { cache, sets } = memoryCache()
    const upgrade = deferred<LlmTranslationContent | null>()
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }

    const outcome = await translate(
      uniqueReq(),
      llmReturning(async () => ({ content: HELLO, upgrade: upgrade.promise })),
      dictionary,
      cache
    )
    expect(outcome.entries[0].meanings).toHaveLength(1)
    await vi.waitFor(() => expect(sets).toHaveLength(1))

    upgrade.resolve({
      headword: 'hello',
      meaningGroups: [
        { partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] },
        { partOfSpeech: 'noun', senses: [{ definition: 'A call of hello' }] },
      ],
    })
    await vi.waitFor(() => expect(sets).toHaveLength(2))
    expect(sets[1].entries).toHaveLength(1)
    expect((sets[1].entries[0] as unknown as { meanings: unknown[] }).meanings).toHaveLength(2)
  })

  it('fusion: a null or failed upgrade leaves the cached fast answer alone', async () => {
    const { cache, sets } = memoryCache()
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    await translate(uniqueReq(), llmReturning(async () => ({ content: HELLO, upgrade: Promise.resolve(null) })), dictionary, cache)
    await new Promise((r) => setTimeout(r, 10))
    expect(sets).toHaveLength(1)
  })

  it('streams partials to the first caller and to joiners (latest one immediately on join)', async () => {
    const gate = deferred()
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate(_req, opts) {
        opts?.onPartial?.({ headword: 'hello', translation: 'hola' })
        await gate.promise
        return { content: HELLO }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = uniqueReq()
    const first: string[] = []
    const joiner: string[] = []

    const a = translate(req, llm, dictionary, null, { onPartial: (e) => first.push(e[0].translation ?? '') })
    await new Promise((r) => setTimeout(r, 5))
    const b = translate(req, llm, dictionary, null, { onPartial: (e) => joiner.push(e[0].translation ?? '') })
    gate.resolve()
    await Promise.all([a, b])

    expect(first).toEqual(['hola'])
    expect(joiner).toEqual(['hola'])
  })

  it('does not replay a stale partial to a request that joins after the outcome is known', async () => {
    const { cache, gate } = memoryCache()
    const writeGate = deferred()
    gate.current = writeGate.promise // keeps the lookup registered while its cache write is pending
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate(_req, opts) {
        opts?.onPartial?.({ headword: 'hello', translation: 'hola' })
        return { content: HELLO }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = uniqueReq()
    await translate(req, llm, dictionary, cache)

    const late: string[] = []
    const outcome = await translate(req, llm, dictionary, cache, { onPartial: (e) => late.push(e[0].translation ?? '') })
    expect(outcome.tier).toBe('llm')
    expect(late).toEqual([])
    writeGate.resolve()
  })

  it('a throwing partial listener cannot break the lookup', async () => {
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate(_req, opts) {
        opts?.onPartial?.({ headword: 'hello', translation: 'hola' })
        return { content: HELLO }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const outcome = await translate(uniqueReq(), llm, dictionary, null, {
      onPartial: () => {
        throw new Error('socket closed')
      },
    })
    expect(outcome.tier).toBe('llm')
  })

  it('falls back to the dictionary when the LLM fails, and still serves a result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dictionary: DictionaryProvider = {
      id: 'dict:test',
      define: vi.fn(async () => [{ word: 'hello', phonetics: [], meanings: [] }]),
    }
    const outcome = await translate(
      uniqueReq(),
      llmReturning(async () => {
        throw new Error('boom')
      }),
      dictionary,
      null
    )
    expect(outcome.tier).toBe('dictionary')
  })
})

describe('GET /api/translate-stream/:text', () => {
  // The route sits behind the real per-IP translate limiter (5/min), so every
  // request in these tests presents a distinct client IP.
  let ipSeq = 0
  const get = (url: string): Promise<Response> =>
    fetch(url, { headers: { 'x-forwarded-for': `10.1.0.${(ipSeq += 1)}` } })

  async function withServer<T>(llm: LlmProvider | null, fn: (base: string) => Promise<T>): Promise<T> {
    const app = express()
    app.set('trust proxy', true)
    app.locals.llmService = { current: () => llm } as unknown as LlmService
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    app.use('/api', createTranslateRouter(dictionary, null))
    const server: Server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  function parseSse(text: string): Array<{ event: string; data: unknown }> {
    return text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? ''
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null') as unknown
        return { event, data }
      })
  }

  it('sends partial events as the LLM writes, then done, with unbuffered SSE headers', async () => {
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate(_req, opts) {
        opts?.onPartial?.({ headword: 'hello', translation: 'hola' })
        await new Promise((r) => setTimeout(r, 5))
        opts?.onPartial?.({ headword: 'hello', translation: 'hola', meaningGroups: HELLO.meaningGroups })
        return { content: { ...HELLO, translation: 'hola' } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    await withServer(llm, async (base) => {
      const res = await get(`${base}/api/translate-stream/streamword1?from=en&to=es`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('x-accel-buffering')).toBe('no')
      expect(res.headers.get('cache-control')).toContain('no-cache')

      const events = parseSse(await res.text())
      expect(events.map((e) => e.event)).toEqual(['partial', 'partial', 'done'])
      const [p1, p2, done] = events.map((e) => (e.data as Array<{ translation?: string; meanings: unknown[] }>)[0])
      expect(p1.translation).toBe('hola')
      expect(p1.meanings).toEqual([])
      expect(p2.meanings).toHaveLength(1)
      expect(done.translation).toBe('hola')
    })
  })

  it('the done payload matches what /translate returns', async () => {
    const llm = llmReturning(async () => ({ content: HELLO }))
    await withServer(llm, async (base) => {
      const streamed = parseSse(await (await get(`${base}/api/translate-stream/samebody?from=en&to=en`)).text())
      const plain = (await (await get(`${base}/api/translate/samebody?from=en&to=en`)).json()) as unknown
      expect(streamed[streamed.length - 1]).toEqual({ event: 'done', data: plain })
    })
  })

  it('validates input with ordinary JSON errors before any stream starts', async () => {
    await withServer(llmReturning(async () => ({ content: HELLO })), async (base) => {
      const bad = await get(`${base}/api/translate-stream/hello?from=xx&to=en`)
      expect(bad.status).toBe(400)
      expect(bad.headers.get('content-type')).toContain('application/json')
      expect(await bad.json()).toEqual({ error: 'invalid_language' })

      const empty = await get(`${base}/api/translate-stream/%20?from=en&to=en`)
      expect(empty.status).toBe(404)
    })
  })

  it('reports a total failure as an error event instead of hanging', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = express()
    app.set('trust proxy', true)
    app.locals.llmService = { current: () => null } as unknown as LlmService
    const dictionary: DictionaryProvider = {
      id: 'dict:test',
      define: vi.fn(async () => {
        throw new Error('dict down')
      }),
    }
    app.use('/api', createTranslateRouter(dictionary, null))
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const events = parseSse(await (await get(`${base}/api/translate-stream/brokenword?from=en&to=en`)).text())
      expect(events).toEqual([{ event: 'error', data: { error: 'internal' } }])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
