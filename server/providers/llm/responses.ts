import {
  DEFAULT_TIMEOUT_MS,
  buildFuseMessages,
  buildMessages,
  buildMoreExamplesMessages,
  parseContent,
  parseMoreExamplesContent,
} from './openaiCompat'
import {
  LlmProviderError,
  type LlmFuseRequest,
  type LlmFuseResult,
  type LlmMoreExamplesRequest,
  type LlmMoreExamplesResult,
  type LlmProvider,
  type LlmTranslationRequest,
  type LlmTranslationResult,
  type LlmUsageMeta,
} from './types'

export interface OpenAiResponsesOptions {
  vendor: string
  apiKey: string
  model: string
  baseUrl: string
  headers?: Record<string, string>
  timeoutMs?: number
}

interface ResponseOutputItem {
  type?: string
  content?: Array<{ type?: string; text?: string }>
}

interface ResponsesBody {
  output_text?: string
  output?: ResponseOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

function responseText(body: ResponsesBody): string | undefined {
  if (typeof body.output_text === 'string' && body.output_text.trim()) return body.output_text
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        return content.text
      }
    }
  }
  return undefined
}

export function createOpenAiResponsesProvider(options: OpenAiResponsesOptions): LlmProvider {
  const { vendor, apiKey, model, headers } = options
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const id = `llm:${vendor}:${model}`

  if (!apiKey) throw new LlmProviderError('not_configured', `${vendor} API key is not set`)

  async function callResponses(
    messages: Array<{ role: string; content: string }>,
    logLabel: string
  ): Promise<{ content: string; meta?: LlmUsageMeta }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    const url = `${baseUrl}/responses`
    const body = {
      model,
      input: messages.map(({ role, content }) => ({ role, content: [{ type: 'input_text', text: content }] })),
      text: {
        format: {
          type: 'json_schema',
          name: 'dictionary_response',
          strict: false,
          schema: { type: 'object', additionalProperties: true },
        },
      },
    }

    try {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(headers ?? {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (err) {
        const elapsed = Date.now() - started
        if (err instanceof Error && err.name === 'AbortError') {
          throw new LlmProviderError('timeout', `${vendor} request to ${url} timed out after ${elapsed}ms (limit ${timeoutMs}ms)`)
        }
        throw new LlmProviderError('network', `Could not reach the ${vendor} API at ${url}: ${(err as Error)?.message ?? err}`)
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new LlmProviderError('api_error', `${vendor} API error: ${res.status} ${detail.slice(0, 200)}`.trimEnd(), res.status)
      }

      let responseBody: ResponsesBody
      try {
        responseBody = (await res.json()) as ResponsesBody
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          const elapsed = Date.now() - started
          throw new LlmProviderError('timeout', `${vendor} request to ${url} timed out after ${elapsed}ms (limit ${timeoutMs}ms)`)
        }
        throw err
      }
      const content = responseText(responseBody)
      if (!content) throw new LlmProviderError('bad_response', `${vendor} response had no output text (${logLabel})`)
      const usage = responseBody.usage
      const meta: LlmUsageMeta | undefined =
        typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number'
          ? { promptTokens: usage?.input_tokens, completionTokens: usage?.output_tokens }
          : undefined
      return meta ? { content, meta } : { content }
    } finally {
      clearTimeout(timer)
    }
  }

  async function callAndParse<T>(
    messages: Array<{ role: string; content: string }>,
    logLabel: string,
    parse: (content: string) => T
  ): Promise<{ content: T; meta?: LlmUsageMeta }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await callResponses(messages, logLabel)
        const content = parse(result.content)
        return result.meta ? { content, meta: result.meta } : { content }
      } catch (err) {
        if (!(err instanceof LlmProviderError) || err.code !== 'bad_response' || attempt === 1) throw err
      }
    }
    throw new LlmProviderError('bad_response', `${vendor} response could not be parsed`)
  }

  return {
    id,
    async translate(req: LlmTranslationRequest): Promise<LlmTranslationResult> {
      const { content: parsed, meta } = await callAndParse(buildMessages(req), `text="${req.text.slice(0, 60)}"`, (content) =>
        parseContent(vendor, content)
      )
      if (req.sourceLang.toLowerCase() === req.targetLang.toLowerCase()) delete parsed.translation
      return meta ? { content: parsed, meta } : { content: parsed }
    },
    async moreExamples(req: LlmMoreExamplesRequest): Promise<LlmMoreExamplesResult> {
      const { content: examples } = await callAndParse(
        buildMoreExamplesMessages(req),
        `moreExamples word="${req.word.slice(0, 60)}"`,
        (content) => parseMoreExamplesContent(vendor, content)
      )
      return { examples }
    },
    async fuse(req: LlmFuseRequest): Promise<LlmFuseResult> {
      const { content: parsed, meta } = await callAndParse(buildFuseMessages(req), `fuse text="${req.request.text.slice(0, 60)}"`, (content) =>
        parseContent(vendor, content)
      )
      if (req.request.sourceLang.toLowerCase() === req.request.targetLang.toLowerCase()) delete parsed.translation
      return meta ? { content: parsed, meta } : { content: parsed }
    },
  }
}
