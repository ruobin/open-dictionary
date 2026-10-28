import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiResponsesProvider } from './responses'
import { LlmProviderError } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const CORE = '{"headword":"run","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"to move fast"}]}]}'
const EXTRAS = '{"collocations":["run away"],"wordFamily":["runner"]}'

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>
}

/** Which of the two parallel calls this request is, judged by its system prompt. */
function kindOf(init?: RequestInit): 'core' | 'extras' {
  const input = bodyOf(init).input as Array<{ content: Array<{ text: string }> }>
  return input[0].content[0].text.includes('translation engine') ? 'core' : 'extras'
}

function json(output_text: string, usage?: { input_tokens: number; output_tokens: number }): Response {
  return new Response(JSON.stringify({ output_text, ...(usage ? { usage } : {}) }))
}

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

function makeProvider(extra: Partial<Parameters<typeof createOpenAiResponsesProvider>[0]> = {}) {
  return createOpenAiResponsesProvider({
    vendor: 'openai-responses',
    apiKey: 'sk-test',
    model: 'gpt-5.6-terra',
    baseUrl: 'https://gateway.example/v1/',
    ...extra,
  })
}

const REQ = { text: 'run', sourceLang: 'en', targetLang: 'en' }

describe('OpenAI Responses provider', () => {
  it('uses the Responses endpoint, runs core + extras in parallel and merges them', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) =>
      kindOf(init) === 'core'
        ? json(CORE, { input_tokens: 12, output_tokens: 3 })
        : json(EXTRAS, { input_tokens: 5, output_tokens: 2 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeProvider().translate(REQ)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/v1/responses')
    const request = bodyOf(fetchMock.mock.calls[0][1])
    expect(request.model).toBe('gpt-5.6-terra')
    expect(request.input).toHaveLength(2)
    expect((request.text as { format: { type: string } }).format.type).toBe('json_schema')
    expect(request.reasoning).toEqual({ effort: 'none' })
    expect(result.content).toMatchObject({
      headword: 'run',
      meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move fast' }] }],
      collocations: ['run away'],
      wordFamily: ['runner'],
    })
    expect(result.meta).toEqual({ promptTokens: 17, completionTokens: 5 })
    expect(result.incomplete).toBeUndefined()
  })

  it('keeps every request-specific value out of the system prompt (prefix-cache friendly)', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => (kindOf(init) === 'core' ? json(CORE) : json(EXTRAS)))
    vi.stubGlobal('fetch', fetchMock)
    const provider = makeProvider()

    await provider.translate({ text: 'run', sourceLang: 'en', targetLang: 'fr' })
    await provider.translate({ text: 'walk', sourceLang: 'de', targetLang: 'ja' })

    const systems = fetchMock.mock.calls.map(([, init]) => {
      const input = bodyOf(init).input as Array<{ content: Array<{ text: string }> }>
      return `${kindOf(init)}:${input[0].content[0].text}`
    })
    expect(new Set(systems).size).toBe(2) // one core prompt + one extras prompt, byte-identical across lookups
  })

  it('surfaces gateway errors with their status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unsupported model', { status: 400 })))

    await expect(makeProvider().translate(REQ)).rejects.toMatchObject({
      name: 'LlmProviderError',
      code: 'api_error',
      status: 400,
    } satisfies Partial<LlmProviderError>)
  })

  it('retries the core call once when the model returns malformed JSON', async () => {
    let coreCalls = 0
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      if (kindOf(init) === 'extras') return json(EXTRAS)
      coreCalls += 1
      return coreCalls === 1 ? json('{"headword":"run"') : json('{"headword":"run"}')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(makeProvider().translate(REQ)).resolves.toMatchObject({ content: { headword: 'run' } })
    expect(coreCalls).toBe(2)
  })

  it('serves the core answer as incomplete when only the extras call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async (_url, init) => (kindOf(init) === 'core' ? json(CORE) : new Response('boom', { status: 500 })))
    )

    const result = await makeProvider().translate(REQ)
    expect(result.incomplete).toBe(true)
    expect(result.content).toMatchObject({ headword: 'run' })
  })

  it('steps down the reasoning variant when the model rejects it, and remembers what worked', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      const reasoning = bodyOf(init).reasoning as { effort?: string } | undefined
      if (reasoning?.effort === 'none') return new Response('unsupported value: none', { status: 400 })
      return kindOf(init) === 'core' ? json(CORE) : json(EXTRAS)
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = makeProvider()

    await provider.translate(REQ)
    const firstRunCalls = fetchMock.mock.calls.length
    await provider.translate(REQ)
    const secondRunCalls = fetchMock.mock.calls.length - firstRunCalls

    const efforts = fetchMock.mock.calls.map(([, init]) => (bodyOf(init).reasoning as { effort?: string })?.effort)
    expect(efforts).toContain('low')
    expect(secondRunCalls).toBe(2) // no wasted 'none' attempts once 'low' is known to work
    expect(efforts.slice(firstRunCalls)).toEqual(['low', 'low'])
  })

  it('lets an admin requestBody take over reasoning control', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => (kindOf(init) === 'core' ? json(CORE) : json(EXTRAS)))
    vi.stubGlobal('fetch', fetchMock)

    await makeProvider({ requestBody: { reasoning: { effort: 'minimal' }, service_tier: 'priority' } }).translate(REQ)

    for (const [, init] of fetchMock.mock.calls) {
      expect(bodyOf(init).reasoning).toEqual({ effort: 'minimal' })
      expect(bodyOf(init).service_tier).toBe('priority')
    }
  })

  it('streams the core call and reports partial answers as they complete', async () => {
    const chunks = ['{"headword":"run","translation":"跑",', '"meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"to move fast"}]}]}']
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      if (kindOf(init) === 'extras') return json(EXTRAS)
      expect(bodyOf(init).stream).toBe(true)
      return sse([
        ...chunks.map((delta) => ({ type: 'response.output_text.delta', delta })),
        { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 4 } } },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    const partials: unknown[] = []

    const result = await makeProvider().translate({ ...REQ, targetLang: 'zh' }, { onPartial: (p) => partials.push(p) })

    expect(partials.length).toBeGreaterThanOrEqual(2)
    expect(partials[0]).toMatchObject({ headword: 'run', translation: '跑' })
    expect(partials[partials.length - 1]).toMatchObject({ meaningGroups: [{ partOfSpeech: 'verb' }] })
    expect(result.content).toMatchObject({ headword: 'run', translation: '跑', collocations: ['run away'] })
    expect(result.meta).toEqual({ promptTokens: 9 + 0, completionTokens: 4 + 0 })
  })

  it('falls back to a plain request, and stops streaming, when the gateway rejects stream:true', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      if (bodyOf(init).stream) return new Response('stream not supported', { status: 400 })
      return kindOf(init) === 'core' ? json(CORE) : json(EXTRAS)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = makeProvider()

    const first = await provider.translate(REQ, { onPartial: () => {} })
    expect(first.content).toMatchObject({ headword: 'run' })

    fetchMock.mockClear()
    await provider.translate(REQ, { onPartial: () => {} })
    expect(fetchMock.mock.calls.every(([, init]) => !bodyOf(init).stream)).toBe(true)
  })
})
