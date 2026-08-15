import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenRouterProvider } from './openrouter'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenRouter provider', () => {
  it('forwards per-model routing preferences', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"headword":"run"}' } }] }))
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = createOpenRouterProvider({
      apiKey: 'sk-test',
      model: 'openai/gpt-5.6-luna',
      provider: { order: ['openai', 'azure'], allow_fallbacks: true },
    })

    await provider.translate({ text: 'run', sourceLang: 'en', targetLang: 'en' })

    const request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(request.provider).toEqual({ order: ['openai', 'azure'], allow_fallbacks: true })
  })
})
