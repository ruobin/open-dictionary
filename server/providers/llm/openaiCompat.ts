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
import {
  buildFuseMessages,
  buildMoreExamplesMessages,
  type ChatMessage,
} from './prompts'
import { parseContent, parseMoreExamplesContent } from './parse'
import { runTranslate, type Transport } from './translateFlow'
import { readSse } from '../../../shared/sse'
import { buildLadder, CORE_MAX_TOKENS, EXTRAS_MAX_TOKENS } from './requestVariants'

/**
 * Shared adapter for any OpenAI-compatible Chat Completions API. Both the GLM
 * (Z.AI) and OpenRouter providers are thin wrappers over this so the app stays
 * vendor-agnostic — swapping/adding providers is config + a few lines.
 */
export interface OpenAiCompatOptions {
  /** Vendor slug used in the provider id, log prefix, and error messages. */
  vendor: string
  apiKey: string
  model: string
  /** Base URL up to and including the version segment, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string
  /** Extra request headers (e.g. OpenRouter HTTP-Referer / X-Title). */
  headers?: Record<string, string>
  timeoutMs?: number
  temperature?: number
  /** Include `response_format: { type: 'json_object' }`. Default true. */
  jsonMode?: boolean
  /** Provider-specific request fields, such as OpenRouter routing preferences. */
  extraBody?: Record<string, unknown>
  /** Vendor "reasoning off" request variants, most aggressive first, ending in
   *  `{}`. A variant the model rejects (400/422) steps down to the next; see
   *  requestVariants.ts. Default: none (plain request). */
  reasoningRungs?: Array<Record<string, unknown>>
  /** Admin-supplied extra top-level request fields (model option `requestBody`).
   *  Always sent; setting any reasoning field here disables the built-in rungs. */
  requestBody?: Record<string, unknown>
  /** Send `max_tokens` runaway caps. Default false — some gateways reject
   *  `max_tokens` for newer OpenAI models (they want `max_completion_tokens`). */
  capOutput?: boolean
  /** Stream the core call upstream so partial answers can be shown early.
   *  Default true; falls back to a plain request if the gateway rejects it. */
  stream?: boolean
}

export const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TEMPERATURE = 0.2

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
}
interface ChatResponseBody {
  choices?: Array<{ message?: { content?: string } }>
  usage?: ChatUsage
}
interface ChatStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: ChatUsage
  error?: { message?: string; code?: unknown }
}

interface ChatResult {
  content: string
  meta?: LlmUsageMeta
}

interface ChatCall {
  label: string
  maxTokens: number
  stream: boolean
  onText?: (accumulated: string) => void
  signal?: AbortSignal
}

function usageMeta(usage: ChatUsage | undefined): LlmUsageMeta | undefined {
  return typeof usage?.prompt_tokens === 'number' || typeof usage?.completion_tokens === 'number'
    ? { promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens }
    : undefined
}

function isBadRequest(err: unknown): boolean {
  return (
    err instanceof LlmProviderError &&
    err.code === 'api_error' &&
    (err.status === 400 || err.status === 422)
  )
}

function isDebugFromEnv(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.LLM_DEBUG ?? '')
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatOptions): LlmProvider {
  const { vendor, apiKey, model, headers } = options
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE
  const jsonMode = options.jsonMode ?? true
  const id = `llm:${vendor}:${model}`
  const debug = isDebugFromEnv()
  const dbg = (...args: unknown[]): void => {
    if (debug) console.log(`[${vendor}]`, ...args)
  }

  if (!apiKey) throw new LlmProviderError('not_configured', `${vendor} API key is not set`)

  const ladder = buildLadder(options.reasoningRungs ?? [{}], options.requestBody)
  let streamEnabled = options.stream ?? true

  /** One POST /chat/completions (streaming or not) with timeout/error handling.
   *  `extraBody` is the current rung of the reasoning-off ladder. */
  async function callChat(
    messages: ChatMessage[],
    call: ChatCall,
    extraBody: Record<string, unknown>
  ): Promise<ChatResult> {
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
    const url = `${baseUrl}/chat/completions`
    dbg(
      `→ POST ${url} model=${model} timeout=${timeoutMs}ms stream=${call.stream} ${call.label}\n` +
        messages.map((m) => `--- [${m.role}] ---\n${m.content}`).join('\n')
    )

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      temperature,
      ...(options.extraBody ?? {}),
      ...(options.capOutput ? { max_tokens: call.maxTokens } : {}),
      ...extraBody,
    }
    if (jsonMode) requestBody.response_format = { type: 'json_object' }
    if (call.stream) requestBody.stream = true

    const abortError = (elapsed: number, phase: string): LlmProviderError =>
      timedOut
        ? new LlmProviderError(
            'timeout',
            `${vendor} request to ${url} timed out after ${elapsed}ms (limit ${timeoutMs}ms) — ${phase}`
          )
        : new LlmProviderError('network', `${vendor} request to ${url} was aborted`)

    // The abort timer must stay armed for the *entire* request/response
    // lifecycle, not just until fetch() resolves with headers. A vendor can
    // send a 200 promptly and then stall (or never finish) streaming the
    // body — if the timer were cleared as soon as headers arrived, the
    // subsequent body read would have no timeout protection at all and could
    // hang indefinitely (observed in prod: a request stuck for 10+ minutes).
    // So the whole fetch + body-read is wrapped in one try/finally that only
    // clears the timer at the end.
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
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        })
      } catch (err) {
        const elapsed = Date.now() - started
        if (err instanceof Error && err.name === 'AbortError') {
          dbg(`← ABORT after ${elapsed}ms (timedOut=${timedOut})`)
          throw abortError(elapsed, 'no response received')
        }
        dbg(`← NETWORK ERROR after ${elapsed}ms:`, err)
        throw new LlmProviderError(
          'network',
          `Could not reach the ${vendor} API at ${url}: ${(err as Error)?.message ?? err}`
        )
      }

      dbg(`← ${res.status} in ${Date.now() - started}ms`)

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        dbg(`← error body: ${detail.slice(0, 500)}`)
        throw new LlmProviderError(
          'api_error',
          `${vendor} API error: ${res.status} ${detail.slice(0, 200)}`.trimEnd(),
          res.status
        )
      }

      const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      if (call.stream && isSse && res.body) {
        let accumulated = ''
        let usage: ChatUsage | undefined
        let streamError: string | undefined
        try {
          await readSse(res.body, (msg) => {
            if (msg.data === '[DONE]') return
            let chunk: ChatStreamChunk
            try {
              chunk = JSON.parse(msg.data) as ChatStreamChunk
            } catch {
              return
            }
            if (chunk.error) streamError = chunk.error.message ?? 'stream error'
            if (chunk.usage) usage = chunk.usage
            const delta = chunk.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
              accumulated += delta
              call.onText?.(accumulated)
            }
          })
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw abortError(Date.now() - started, 'response stream did not finish')
          }
          throw err
        }
        if (streamError && !accumulated.trim()) {
          throw new LlmProviderError('api_error', `${vendor} stream error: ${streamError}`.slice(0, 240))
        }
        if (!accumulated.trim()) {
          throw new LlmProviderError('bad_response', `${vendor} response had no message content`)
        }
        dbg(`← stream complete in ${Date.now() - started}ms (${accumulated.length} chars)`)
        const meta = usageMeta(usage)
        return meta ? { content: accumulated, meta } : { content: accumulated }
      }

      // Non-streaming — also the path taken when a gateway ignores `stream: true`
      // and replies with a plain JSON body.
      let responseBody: ChatResponseBody
      try {
        responseBody = (await res.json()) as ChatResponseBody
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw abortError(Date.now() - started, 'response body did not finish streaming')
        }
        throw err
      }
      const content = responseBody?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        dbg(`← no message content; body: ${JSON.stringify(responseBody).slice(0, 500)}`)
        throw new LlmProviderError('bad_response', `${vendor} response had no message content`)
      }
      if (call.stream) call.onText?.(content)
      const meta = usageMeta(responseBody?.usage)
      return meta ? { content, meta } : { content }
    } finally {
      clearTimeout(timer)
      call.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  /** callChat through the reasoning-off ladder, with a plain-request fallback
   *  if the gateway rejects streaming outright. */
  async function send(
    messages: ChatMessage[],
    call: Omit<ChatCall, 'stream'> & { wantStream?: boolean }
  ): Promise<ChatResult> {
    const base = { label: call.label, maxTokens: call.maxTokens, onText: call.onText, signal: call.signal }
    if (call.wantStream && streamEnabled) {
      try {
        return await ladder.run((rung) => callChat(messages, { ...base, stream: true }, rung))
      } catch (err) {
        if (!isBadRequest(err)) throw err
        const result = await ladder.run((rung) => callChat(messages, { ...base, stream: false }, rung))
        // Only blame streaming once the same request succeeds without it.
        streamEnabled = false
        console.warn(`[${vendor}] gateway rejected stream:true — streaming disabled for ${id}`)
        return result
      }
    }
    return ladder.run((rung) => callChat(messages, { ...base, stream: false }, rung))
  }

  const transport: Transport = (messages, call) =>
    send(messages, {
      label: call.label,
      maxTokens: call.kind === 'core' ? CORE_MAX_TOKENS : EXTRAS_MAX_TOKENS,
      wantStream: Boolean(call.onText),
      onText: call.onText,
      signal: call.signal,
    })

  return {
    id,
    translate(req: LlmTranslationRequest, opts?: LlmTranslateOptions): Promise<LlmTranslationResult> {
      return runTranslate(vendor, transport, req, opts)
    },
    async moreExamples(req: LlmMoreExamplesRequest): Promise<LlmMoreExamplesResult> {
      const { content } = await send(buildMoreExamplesMessages(req), {
        label: `moreExamples word="${req.word.slice(0, 60)}"`,
        maxTokens: EXTRAS_MAX_TOKENS,
      })
      return { examples: parseMoreExamplesContent(vendor, content) }
    },
    async fuse(req: LlmFuseRequest): Promise<LlmFuseResult> {
      const { content, meta } = await send(buildFuseMessages(req), {
        label: `fuse text="${req.request.text.slice(0, 60)}"`,
        maxTokens: CORE_MAX_TOKENS,
      })
      const parsed = parseContent(vendor, content)
      // Same defensive guard as translate(): in same-language define mode the
      // model occasionally re-introduces a translation field from the inputs.
      if (req.request.sourceLang.toLowerCase() === req.request.targetLang.toLowerCase()) {
        delete parsed.translation
      }
      return meta ? { content: parsed, meta } : { content: parsed }
    },
  }
}
