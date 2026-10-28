import { DEFAULT_TIMEOUT_MS } from './openaiCompat'
import {
  buildFuseMessages,
  buildMoreExamplesMessages,
} from './prompts'
import { parseContent, parseMoreExamplesContent } from './parse'
import { runTranslate, type Transport } from './translateFlow'
import { readSse } from '../../../shared/sse'
import { buildLadder, RESPONSES_RUNGS } from './requestVariants'
import {
  LlmProviderError,
  type LlmFuseRequest,
  type LlmFuseResult,
  type LlmMoreExamplesRequest,
  type LlmMoreExamplesResult,
  type LlmProvider,
  type LlmTranslateOptions,
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
  /** Admin-supplied extra top-level request fields (model option `requestBody`). */
  requestBody?: Record<string, unknown>
  /** Stream the core call upstream. Default true; falls back to a plain request if rejected. */
  stream?: boolean
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

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  response?: ResponsesBody
  error?: { message?: string }
  message?: string
}

interface ResponsesCall {
  label: string
  stream: boolean
  onText?: (accumulated: string) => void
  signal?: AbortSignal
}

type Message = { role: string; content: string }

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

function usageMeta(usage: ResponsesBody['usage']): LlmUsageMeta | undefined {
  return typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number'
    ? { promptTokens: usage?.input_tokens, completionTokens: usage?.output_tokens }
    : undefined
}

function isBadRequest(err: unknown): boolean {
  return (
    err instanceof LlmProviderError &&
    err.code === 'api_error' &&
    (err.status === 400 || err.status === 422)
  )
}

export function createOpenAiResponsesProvider(options: OpenAiResponsesOptions): LlmProvider {
  const { vendor, apiKey, model, headers } = options
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const id = `llm:${vendor}:${model}`

  if (!apiKey) throw new LlmProviderError('not_configured', `${vendor} API key is not set`)

  const ladder = buildLadder(RESPONSES_RUNGS, options.requestBody)
  let streamEnabled = options.stream ?? true

  async function callResponses(
    messages: Message[],
    call: ResponsesCall,
    extraBody: Record<string, unknown>
  ): Promise<{ content: string; meta?: LlmUsageMeta }> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onCallerAbort = (): void => controller.abort()
    if (call.signal) {
      if (call.signal.aborted) controller.abort()
      else call.signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    const started = Date.now()
    const url = `${baseUrl}/responses`
    const body: Record<string, unknown> = {
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
      ...extraBody,
    }
    if (call.stream) body.stream = true

    const abortError = (phase: string): LlmProviderError => {
      const elapsed = Date.now() - started
      return timedOut
        ? new LlmProviderError('timeout', `${vendor} request to ${url} timed out after ${elapsed}ms (limit ${timeoutMs}ms) — ${phase}`)
        : new LlmProviderError('network', `${vendor} request to ${url} was aborted`)
    }

    try {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(call.stream ? { Accept: 'text/event-stream' } : {}),
            ...(headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw abortError('no response received')
        throw new LlmProviderError('network', `Could not reach the ${vendor} API at ${url}: ${(err as Error)?.message ?? err}`)
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new LlmProviderError('api_error', `${vendor} API error: ${res.status} ${detail.slice(0, 200)}`.trimEnd(), res.status)
      }

      const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      if (call.stream && isSse && res.body) {
        let accumulated = ''
        let completed: ResponsesBody | undefined
        let streamError: string | undefined
        try {
          await readSse(res.body, (msg) => {
            if (msg.data === '[DONE]') return
            let event: ResponsesStreamEvent
            try {
              event = JSON.parse(msg.data) as ResponsesStreamEvent
            } catch {
              return
            }
            const type = event.type ?? msg.event
            if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
              accumulated += event.delta
              call.onText?.(accumulated)
            } else if (type === 'response.completed' && event.response) {
              completed = event.response
            } else if (type === 'response.failed' || type === 'error') {
              streamError = event.error?.message ?? event.response?.output_text ?? event.message ?? 'stream error'
            }
          })
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw abortError('response stream did not finish')
          throw err
        }
        const content = accumulated.trim() ? accumulated : completed ? responseText(completed) : undefined
        if (!content) {
          if (streamError) throw new LlmProviderError('api_error', `${vendor} stream error: ${streamError}`.slice(0, 240))
          throw new LlmProviderError('bad_response', `${vendor} response had no output text (${call.label})`)
        }
        const meta = usageMeta(completed?.usage)
        return meta ? { content, meta } : { content }
      }

      let responseBody: ResponsesBody
      try {
        responseBody = (await res.json()) as ResponsesBody
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw abortError('response body did not finish')
        throw err
      }
      const content = responseText(responseBody)
      if (!content) throw new LlmProviderError('bad_response', `${vendor} response had no output text (${call.label})`)
      if (call.stream) call.onText?.(content)
      const meta = usageMeta(responseBody.usage)
      return meta ? { content, meta } : { content }
    } finally {
      clearTimeout(timer)
      call.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  async function send(
    messages: Message[],
    call: Omit<ResponsesCall, 'stream'> & { wantStream?: boolean }
  ): Promise<{ content: string; meta?: LlmUsageMeta }> {
    const base = { label: call.label, onText: call.onText, signal: call.signal }
    if (call.wantStream && streamEnabled) {
      try {
        return await ladder.run((rung) => callResponses(messages, { ...base, stream: true }, rung))
      } catch (err) {
        if (!isBadRequest(err)) throw err
        const result = await ladder.run((rung) => callResponses(messages, { ...base, stream: false }, rung))
        streamEnabled = false
        console.warn(`[${vendor}] gateway rejected stream:true — streaming disabled for ${id}`)
        return result
      }
    }
    return ladder.run((rung) => callResponses(messages, { ...base, stream: false }, rung))
  }

  async function callAndParse<T>(
    messages: Message[],
    label: string,
    parse: (content: string) => T
  ): Promise<{ content: T; meta?: LlmUsageMeta }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await send(messages, { label })
        const content = parse(result.content)
        return result.meta ? { content, meta: result.meta } : { content }
      } catch (err) {
        if (!(err instanceof LlmProviderError) || err.code !== 'bad_response' || attempt === 1) throw err
      }
    }
    throw new LlmProviderError('bad_response', `${vendor} response could not be parsed`)
  }

  const transport: Transport = (messages, call) =>
    send(messages, {
      label: call.label,
      wantStream: Boolean(call.onText),
      onText: call.onText,
      signal: call.signal,
    })

  return {
    id,
    translate(req: LlmTranslationRequest, opts?: LlmTranslateOptions): Promise<LlmTranslationResult> {
      // NewAPI can return malformed JSON even after a successful request, so
      // the core call is retried once on bad_response (docs/llm-provider-operations.md).
      return runTranslate(vendor, transport, req, opts, { retryBadResponse: true })
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
