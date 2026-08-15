import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiResponsesProvider } from './responses'
import { LlmProviderError } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI Responses provider', () => {
  it('uses the Responses endpoint and parses output text', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"headword":"run"}' }] }],
          usage: { input_tokens: 12, output_tokens: 3 },
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = createOpenAiResponsesProvider({
      vendor: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-5.6-terra',
      baseUrl: 'https://gateway.example/v1/',
    })

    const result = await provider.translate({ text: 'run', sourceLang: 'en', targetLang: 'en' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    const request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(request.model).toBe('gpt-5.6-terra')
    expect(request.input).toHaveLength(2)
    expect(request.text.format.type).toBe('json_schema')
    expect(result).toEqual({ content: { headword: 'run' }, meta: { promptTokens: 12, completionTokens: 3 } })
  })

  it('surfaces gateway errors with their status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unsupported model', { status: 400 })))
    const provider = createOpenAiResponsesProvider({
      vendor: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-5.6-terra',
      baseUrl: 'https://gateway.example/v1',
    })

    await expect(provider.translate({ text: 'run', sourceLang: 'en', targetLang: 'en' })).rejects.toMatchObject({
      name: 'LlmProviderError',
      code: 'api_error',
      status: 400,
    } satisfies Partial<LlmProviderError>)
  })

  it('retries once when the model returns malformed JSON', async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: '{"headword":"run"' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: '{"headword":"run"}' })))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createOpenAiResponsesProvider({
      vendor: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-5.6-terra',
      baseUrl: 'https://gateway.example/v1',
    })

    await expect(provider.translate({ text: 'run', sourceLang: 'en', targetLang: 'en' })).resolves.toMatchObject({
      content: { headword: 'run' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
