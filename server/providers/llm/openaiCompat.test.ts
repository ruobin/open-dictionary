import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiCompatibleProvider } from './openaiCompat'
import { createDeepSeekProvider } from './deepseek'
import { createGlmProvider } from './glm'
import { createOpenRouterProvider } from './openrouter'
import { buildCoreMessages, buildExtrasMessages, buildFuseMessages, buildMoreExamplesMessages } from './prompts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const CORE = '{"headword":"run","translation":"跑","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"to move fast"}]}]}'
const EXTRAS = '{"collocations":["run away"],"wordFamily":["runner"],"commonMistakes":[{"wrong":"make a run","right":"go for a run"}]}'

interface ChatBody {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  max_tokens?: number
  thinking?: unknown
  reasoning?: unknown
  response_format?: unknown
  [k: string]: unknown
}

const bodyOf = (init?: RequestInit): ChatBody => JSON.parse(init?.body as string) as ChatBody
const kindOf = (init?: RequestInit): 'core' | 'extras' =>
  bodyOf(init).messages[0].content.includes('translation engine') ? 'core' : 'extras'

function completion(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), {
    headers: { 'content-type': 'application/json' },
  })
}

function chatSse(deltas: string[], usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
  lines.push('data: [DONE]\n\n')
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } })
}

const REQ = { text: 'run', sourceLang: 'en', targetLang: 'zh' }

describe('chat adapter — request shape', () => {
  it('DeepSeek: thinking disabled + max_tokens cap, JSON mode, core and extras are separate calls', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate(REQ)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.deepseek.com/chat/completions')
      const body = bodyOf(init)
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(typeof body.max_tokens).toBe('number')
      expect(body.response_format).toEqual({ type: 'json_object' })
      expect(body.stream).toBeUndefined() // not streaming without an onPartial listener
    }
    expect(result.content).toMatchObject({
      headword: 'run',
      translation: '跑',
      collocations: ['run away'],
      wordFamily: ['runner'],
      commonMistakes: [{ wrong: 'make a run', right: 'go for a run' }],
    })
    expect(result.incomplete).toBeUndefined()
  })

  it('GLM and OpenRouter get their own reasoning-off switch', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)

    await createGlmProvider({ apiKey: 'k', model: 'glm-5.2' }).translate(REQ)
    expect(bodyOf(fetchMock.mock.calls[0][1]).thinking).toEqual({ type: 'disabled' })

    fetchMock.mockClear()
    await createOpenRouterProvider({ apiKey: 'k', model: 'x/y', provider: { order: ['a'] } }).translate(REQ)
    const body = bodyOf(fetchMock.mock.calls[0][1])
    expect(body.reasoning).toEqual({ effort: 'none' })
    expect(body.provider).toEqual({ order: ['a'] }) // routing prefs still forwarded
  })

  it('generic openai-compat gateways get no vendor-specific fields (unknown model families)', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)

    await createOpenAiCompatibleProvider({
      vendor: 'openai-compat',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://gw.example/v1',
    }).translate(REQ)

    const body = bodyOf(fetchMock.mock.calls[0][1])
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
  })

  it('steps down when a model rejects the reasoning switch, without losing the answer', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => {
      if (bodyOf(init).thinking) return new Response('unknown field thinking', { status: 400 })
      return completion(kindOf(init) === 'core' ? CORE : EXTRAS)
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createDeepSeekProvider({ apiKey: 'k' })

    const result = await provider.translate(REQ)
    expect(result.content).toMatchObject({ headword: 'run', collocations: ['run away'] })

    fetchMock.mockClear()
    await provider.translate(REQ)
    expect(fetchMock).toHaveBeenCalledTimes(2) // remembered: no more rejected attempts
  })

  it('admin requestBody wins, and overriding thinking disables the built-in default', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)

    await createDeepSeekProvider({
      apiKey: 'k',
      requestBody: { thinking: { type: 'enabled' }, max_tokens: 777 },
    }).translate(REQ)

    for (const [, init] of fetchMock.mock.calls) {
      expect(bodyOf(init).thinking).toEqual({ type: 'enabled' })
      expect(bodyOf(init).max_tokens).toBe(777)
    }
  })
})

describe('chat adapter — result handling', () => {
  it('sums token usage across both calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async (_u, init) =>
        kindOf(init) === 'core'
          ? completion(CORE, { prompt_tokens: 1000, completion_tokens: 200 })
          : completion(EXTRAS, { prompt_tokens: 300, completion_tokens: 60 })
      )
    )
    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate(REQ)
    expect(result.meta).toEqual({ promptTokens: 1300, completionTokens: 260 })
  })

  it('drops a "common mistake" whose wrong and right forms are identical', async () => {
    const extras = '{"commonMistakes":[{"wrong":"run a business","right":"Run a business"},{"wrong":"run to home","right":"run home"}]}'
    vi.stubGlobal('fetch', vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : extras)))
    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate(REQ)
    expect((result.content as { commonMistakes?: unknown[] }).commonMistakes).toEqual([{ wrong: 'run to home', right: 'run home' }])
  })

  it('same-language lookups never carry a translation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS))
    )
    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate({ text: 'run', sourceLang: 'en', targetLang: 'en' })
    expect((result.content as { translation?: string }).translation).toBeUndefined()
  })

  it('a failing extras call yields an answer flagged incomplete (so it is not cached)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async (_u, init) => (kindOf(init) === 'core' ? completion(CORE) : new Response('x', { status: 500 })))
    )
    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate(REQ)
    expect(result.incomplete).toBe(true)
    expect(result.content).toMatchObject({ headword: 'run' })
  })

  it('a failing core call rejects, so the translate tier can fall back to the dictionary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async (_u, init) => (kindOf(init) === 'core' ? new Response('x', { status: 500 }) : completion(EXTRAS)))
    )
    await expect(createDeepSeekProvider({ apiKey: 'k' }).translate(REQ)).rejects.toMatchObject({ code: 'api_error', status: 500 })
  })

  it('a typo answer returns immediately and cancels the extras call', async () => {
    let extrasSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>((_u, init) => {
        if (kindOf(init) === 'core') {
          return Promise.resolve(completion('{"headword":"helo","typo":{"suggestion":"hello"}}'))
        }
        extrasSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      })
    )
    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate({ text: 'helo', sourceLang: 'en', targetLang: 'en' })
    expect(result.content).toMatchObject({ typo: { suggestion: 'hello' } })
    expect(result.incomplete).toBeUndefined()
    expect(extrasSignal?.aborted).toBe(true)
  })

  it('times out a stalled request with a timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(
        (_u, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          })
      )
    )
    await expect(createDeepSeekProvider({ apiKey: 'k', timeoutMs: 30 }).translate(REQ)).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('chat adapter — streaming', () => {
  const split = (text: string, n: number): string[] => {
    const size = Math.ceil(text.length / n)
    return Array.from({ length: n }, (_, i) => text.slice(i * size, (i + 1) * size))
  }

  it('streams only the core call, and only when a listener is attached', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => {
      if (kindOf(init) === 'extras') {
        expect(bodyOf(init).stream).toBeUndefined()
        return completion(EXTRAS)
      }
      expect(bodyOf(init).stream).toBe(true)
      return chatSse(split(CORE, 7))
    })
    vi.stubGlobal('fetch', fetchMock)
    const partials: Array<{ headword: string; translation?: string; meaningGroups?: unknown[] }> = []

    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate(REQ, { onPartial: (p) => partials.push(p) })

    expect(result.content).toMatchObject({ headword: 'run', translation: '跑', collocations: ['run away'] })
    expect(partials.length).toBeGreaterThanOrEqual(2)
    // Snapshots only ever grow, and the translation shows up before the senses.
    const firstWithTranslation = partials.findIndex((p) => p.translation)
    const firstWithGroups = partials.findIndex((p) => p.meaningGroups?.length)
    expect(firstWithTranslation).toBeGreaterThanOrEqual(0)
    expect(firstWithTranslation).toBeLessThan(firstWithGroups)
    expect(new Set(partials.map((p) => JSON.stringify(p))).size).toBe(partials.length) // no duplicate snapshots
  })

  it('accepts a gateway that ignores stream:true and answers with plain JSON', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS)))
    const partials: unknown[] = []
    const result = await createDeepSeekProvider({ apiKey: 'k' }).translate(REQ, { onPartial: (p) => partials.push(p) })
    expect(result.content).toMatchObject({ headword: 'run' })
    expect(partials.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to a plain request and stops streaming when the gateway rejects stream:true', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => {
      if (bodyOf(init).stream) return new Response('stream unsupported', { status: 400 })
      return completion(kindOf(init) === 'core' ? CORE : EXTRAS)
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createDeepSeekProvider({ apiKey: 'k' })

    expect((await provider.translate(REQ, { onPartial: () => {} })).content).toMatchObject({ headword: 'run' })
    fetchMock.mockClear()
    await provider.translate(REQ, { onPartial: () => {} })
    expect(fetchMock.mock.calls.every(([, init]) => !bodyOf(init).stream)).toBe(true)
  })

  it('options.stream=false disables upstream streaming', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_u, init) => completion(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)
    await createDeepSeekProvider({ apiKey: 'k', stream: false }).translate(REQ, { onPartial: () => {} })
    expect(fetchMock.mock.calls.every(([, init]) => !bodyOf(init).stream)).toBe(true)
  })

  it('an SSE stream that dies mid-answer surfaces as an error, not a half entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async (_u, init) =>
        kindOf(init) === 'core' ? chatSse(['{"headword":"run","meaningGroups":[{"partOfSp']) : completion(EXTRAS)
      )
    )
    await expect(createDeepSeekProvider({ apiKey: 'k' }).translate(REQ, { onPartial: () => {} })).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})

describe('prompts — static system prefix', () => {
  const a = { text: 'run', sourceLang: 'en', targetLang: 'fr' }
  const b = { text: 'Haus', sourceLang: 'de', targetLang: 'ja' }

  it('system prompts are byte-identical across languages and terms; request data lives in the user message', () => {
    for (const build of [buildCoreMessages, buildExtrasMessages]) {
      const [sysA, userA] = build(a)
      const [sysB, userB] = build(b)
      expect(sysA.role).toBe('system')
      expect(sysA.content).toBe(sysB.content)
      expect(userA.content).toContain('French')
      expect(userA.content).toContain('run')
      expect(userB.content).toContain('Japanese')
      expect(userB.content).toContain('Haus')
      expect(sysA.content).not.toMatch(/French|Japanese|German|English/)
    }
  })

  it('fuse and more-examples system prompts are static too', () => {
    const fuse = (req: typeof a) =>
      buildFuseMessages({ request: req, primary: { headword: req.text }, secondary: { headword: req.text } })[0].content
    expect(fuse(a)).toBe(fuse(b))
    const more = (req: typeof a) =>
      buildMoreExamplesMessages({ word: req.text, sourceLang: req.sourceLang, targetLang: req.targetLang, senseDefinition: 'x' })[0].content
    expect(more(a)).toBe(more(b))
  })

  it('core prompt asks for the display-critical keys first and keeps extras out', () => {
    const system = buildCoreMessages(a)[0].content
    expect(system.indexOf('headword, translation, phonetic, meaningGroups')).toBeGreaterThan(-1)
    expect(system).toContain('Do not include any other keys')
    expect(buildExtrasMessages(a)[0].content).toContain('"collocations"')
  })

  it('same-language lookups are marked as definition requests with no translation', () => {
    const user = buildCoreMessages({ text: 'run', sourceLang: 'en', targetLang: 'en' })[1].content
    expect(user).toContain('DEFINITION request')
  })
})
