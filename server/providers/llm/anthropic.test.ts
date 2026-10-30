import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider, messageText, toAnthropicMessages, ANTHROPIC_VERSION } from './anthropic'
import { buildLlmProvider } from './index'
import { CORE_MAX_TOKENS, EXTRAS_MAX_TOKENS } from './requestVariants'
import { LlmProviderError, type LlmTranslationContent } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const CORE = '{"headword":"run","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"to move fast"}]}]}'
const EXTRAS = '{"collocations":["run away"],"wordFamily":["runner"]}'
const REQ = { text: 'run', sourceLang: 'en', targetLang: 'en' }

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>
}

function headersOf(init?: RequestInit): Record<string, string> {
  return init?.headers as Record<string, string>
}

/** Which of the two parallel calls this request is, judged by its system prompt. */
function kindOf(init?: RequestInit): 'core' | 'extras' {
  return String(bodyOf(init).system).includes('translation engine') ? 'core' : 'extras'
}

function json(text: string, usage?: { input_tokens: number; output_tokens: number }): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', ...(usage ? { usage } : {}) })
  )
}

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

/** A Messages API stream that emits `text` in two deltas. */
function textStream(text: string): Response {
  const mid = Math.floor(text.length / 2)
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(mid) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ])
}

function makeProvider(extra: Partial<Parameters<typeof createAnthropicProvider>[0]> = {}) {
  return createAnthropicProvider({ vendor: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-test', ...extra })
}

describe('toAnthropicMessages / messageText', () => {
  it('moves system prompts to the top-level system field', () => {
    expect(
      toAnthropicMessages([
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ])
    ).toEqual({ system: 'A\n\nB', messages: [{ role: 'user', content: 'hi' }] })
    expect(toAnthropicMessages([{ role: 'user', content: 'hi' }])).toEqual({ messages: [{ role: 'user', content: 'hi' }] })
  })

  it('joins text blocks and ignores thinking blocks', () => {
    expect(
      messageText({ content: [{ type: 'thinking' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] })
    ).toBe('{"a":1}')
    expect(messageText({ content: [{ type: 'thinking' }] })).toBeUndefined()
  })
})

describe('Anthropic provider', () => {
  it('calls {base}/messages with Anthropic auth, required max_tokens, and merges core + extras', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) =>
      kindOf(init) === 'core'
        ? json(CORE, { input_tokens: 12, output_tokens: 3 })
        : json(EXTRAS, { input_tokens: 5, output_tokens: 2 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeProvider({ baseUrl: 'https://new-api.example/v1/' }).translate(REQ)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://new-api.example/v1/messages')
    const headers = headersOf(fetchMock.mock.calls[0][1])
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(headers).not.toHaveProperty('Authorization')

    const calls = fetchMock.mock.calls.map((c) => bodyOf(c[1]))
    const core = calls.find((b) => String(b.system).includes('translation engine'))!
    const extras = calls.find((b) => b !== core)!
    expect(core.model).toBe('claude-test')
    expect(core.max_tokens).toBe(CORE_MAX_TOKENS)
    expect(extras.max_tokens).toBe(EXTRAS_MAX_TOKENS)
    expect((core.messages as Array<{ role: string }>).every((m) => m.role !== 'system')).toBe(true)
    expect(core).not.toHaveProperty('temperature')
    expect(core).not.toHaveProperty('stream')

    expect((result.content as LlmTranslationContent).headword).toBe('run')
    expect((result.content as LlmTranslationContent).collocations).toEqual(['run away'])
    expect(result.meta).toEqual({ promptTokens: 17, completionTokens: 5 })
    expect(result.incomplete).toBeUndefined()
  })

  it('defaults the base URL to api.anthropic.com and clamps temperature to 0..1', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => json(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)
    await makeProvider({ temperature: 1.5 }).translate(REQ)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    expect(bodyOf(fetchMock.mock.calls[0][1]).temperature).toBe(1)
  })

  it('treats a stored null temperature as unset (regression: null was sent as 0)', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => json(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)
    await makeProvider({ temperature: null }).translate(REQ)
    expect(bodyOf(fetchMock.mock.calls[0][1])).not.toHaveProperty('temperature')
  })

  it('drops temperature and remembers when the model rejects a non-default temperature', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      if ('temperature' in bodyOf(init)) {
        return new Response('{"error":{"message":"claude-haiku-5-5 does not support non-default temperature"}}', { status: 400 })
      }
      return json(kindOf(init) === 'core' ? CORE : EXTRAS)
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = makeProvider({ temperature: 0.2 })
    const result = await provider.translate(REQ)
    expect((result.content as LlmTranslationContent).headword).toBe('run')
    expect(result.incomplete).toBeUndefined()
    const before = fetchMock.mock.calls.length
    await provider.translate(REQ)
    // Second lookup starts on the temperature-free rung: exactly core + extras, no rejected round trip.
    expect(fetchMock.mock.calls.length - before).toBe(2)
  })

  it('streams text_delta events into partial answers and reads usage from message_start/message_delta', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => textStream(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)
    const partials: unknown[] = []

    const result = await makeProvider().translate(REQ, { onPartial: (p) => partials.push(p) })

    expect(bodyOf(fetchMock.mock.calls[0][1]).stream).toBe(true)
    expect((result.content as LlmTranslationContent).headword).toBe('run')
    expect(result.meta).toEqual({ promptTokens: 20, completionTokens: 14 })
    expect(partials.length).toBeGreaterThan(0)
  })

  it('surfaces a stream error event as api_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(async () => sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]))
    )
    await expect(makeProvider().translate(REQ, { onPartial: () => {} })).rejects.toMatchObject({
      code: 'api_error',
      message: expect.stringContaining('Overloaded'),
    })
  })

  it('falls back to a non-streaming request when the gateway rejects stream:true', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      const body = bodyOf(init)
      if (body.stream) return new Response('stream not supported', { status: 400 })
      return json(kindOf(init) === 'core' ? CORE : EXTRAS)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await makeProvider().translate(REQ, { onPartial: () => {} })
    expect((result.content as LlmTranslationContent).headword).toBe('run')
  })

  it('passes admin requestBody (e.g. thinking) through and lets it override max_tokens', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => json(kindOf(init) === 'core' ? CORE : EXTRAS))
    vi.stubGlobal('fetch', fetchMock)
    await makeProvider({ requestBody: { thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 8000 } }).translate(REQ)
    const body = bodyOf(fetchMock.mock.calls[0][1])
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(body.max_tokens).toBe(8000)
  })

  it('maps HTTP errors to api_error with the status', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchFn>(async () => new Response('{"type":"error"}', { status: 401 })))
    const err = await makeProvider().translate(REQ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmProviderError)
    expect(err).toMatchObject({ code: 'api_error', status: 401 })
  })

  it('requires an API key', () => {
    expect(() => makeProvider({ apiKey: '' })).toThrow(LlmProviderError)
  })

  it('is reachable through buildLlmProvider as vendor "anthropic"', () => {
    const provider = buildLlmProvider({ vendor: 'anthropic', apiKey: 'k', model: 'claude-test' })
    expect(provider.id).toBe('llm:anthropic:claude-test')
  })
})
