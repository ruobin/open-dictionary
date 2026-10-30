import { DEFAULT_TIMEOUT_MS } from './openaiCompat'
import { buildFuseMessages, buildMoreExamplesMessages, type ChatMessage } from './prompts'
import { parseContent, parseMoreExamplesContent } from './parse'
import { runTranslate, type Transport } from './translateFlow'
import { readSse } from '../../../shared/sse'
import { buildLadder, CORE_MAX_TOKENS, EXTRAS_MAX_TOKENS } from './requestVariants'
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

/**
 * Anthropic Messages API adapter (`POST {baseUrl}/messages`). Works against
 * api.anthropic.com and against gateways that relay the native Claude format,
 * e.g. NewAPI (`https://new-api.ai-dictionary.org/v1`).
 *
 * Differences from the OpenAI-shaped adapters, all handled here so the shared
 * translate flow (translateFlow.ts) is unchanged:
 *  - auth is `x-api-key` + `anthropic-version`, not `Authorization: Bearer`;
 *  - system prompts go in the top-level `system` field, not in `messages`;
 *  - `max_tokens` is REQUIRED, so the core/extras caps are always sent;
 *  - there is no JSON mode. The prompts already demand a bare JSON object, and
 *    parse.ts / streamJson.ts tolerate fences and stray prose;
 *  - streaming events are `content_block_delta` / `message_delta` / `error`.
 *
 * Extended thinking is off unless the admin sets `thinking` in the model's
 * `requestBody`, so no reasoning-off ladder is needed. The ladder still
 * carries the admin `requestBody` on every request.
 */

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
export const ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicOptions {
  vendor: string
  apiKey: string
  model: string
  /** Defaults to {@link DEFAULT_ANTHROPIC_BASE_URL}. Must include the version path, e.g. `.../v1`. */
  baseUrl?: string
  headers?: Record<string, string>
  timeoutMs?: number
  /** Anthropic accepts 0..1 (clamped). Unset/null = model default. Dropped automatically if the model rejects it. */
  temperature?: number | null
  /** Admin-supplied extra top-level request fields (model option `requestBody`). */
  requestBody?: Record<string, unknown>
  /** Stream upstream when the caller wants partials. Default true; falls back to a plain request if rejected. */
  stream?: boolean
}

interface ContentBlock {
  type?: string
  text?: string
}

interface MessagesBody {
  content?: ContentBlock[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface StreamEvent {
  type?: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  message?: MessagesBody
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

interface MessagesCall {
  label: string
  stream: boolean
  maxTokens: number
  onText?: (accumulated: string) => void
  signal?: AbortSignal
}

/** Splits OpenAI-style chat messages into Anthropic's `system` + `messages`. Exported for tests. */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return system ? { system, messages: rest } : { messages: rest }
}

/** Concatenated text of all `text` blocks; thinking/tool blocks are ignored. Exported for tests. */
export function messageText(body: MessagesBody): string | undefined {
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  return text.trim() ? text : undefined
}

function usageMeta(input: number | undefined, output: number | undefined): LlmUsageMeta | undefined {
  return typeof input === 'number' || typeof output === 'number'
    ? { promptTokens: input, completionTokens: output }
    : undefined
}

/** The shared admin form allows 0..2 (OpenAI range); Anthropic accepts 0..1. */
function clampTemperature(t: number): number {
  return Math.min(Math.max(t, 0), 1)
}

function isBadRequest(err: unknown): boolean {
  return err instanceof LlmProviderError && err.code === 'api_error' && (err.status === 400 || err.status === 422)
}

export function createAnthropicProvider(options: AnthropicOptions): LlmProvider {
  const { vendor, apiKey, model, headers } = options
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const id = `llm:${vendor}:${model}`

  if (!apiKey) throw new LlmProviderError('not_configured', `${vendor} API key is not set`)

  // Temperature rides on the ladder rather than the base body. Newer Claude
  // models reject any non-default temperature with 400, so the ladder steps
  // down to a request without it (and remembers). An admin `thinking` override
  // also drops it (buildLadder keeps only the admin body), which is correct:
  // Anthropic doesn't allow a custom temperature with extended thinking.
  // Stored configs use null for "unset", so check the type, not just undefined.
  const temperature = typeof options.temperature === 'number' ? clampTemperature(options.temperature) : undefined
  const ladder = buildLadder(temperature !== undefined ? [{ temperature }, {}] : [{}], options.requestBody)
  let streamEnabled = options.stream ?? true

  async function callMessages(
    messages: ChatMessage[],
    call: MessagesCall,
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
    const url = `${baseUrl}/messages`
    const split = toAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model,
      max_tokens: call.maxTokens,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
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
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
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
        let inputTokens: number | undefined
        let outputTokens: number | undefined
        let streamError: string | undefined
        try {
          await readSse(res.body, (msg) => {
            if (msg.data === '[DONE]') return
            let event: StreamEvent
            try {
              event = JSON.parse(msg.data) as StreamEvent
            } catch {
              return
            }
            const type = event.type ?? msg.event
            if (type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
              accumulated += event.delta.text
              call.onText?.(accumulated)
            } else if (type === 'message_start') {
              inputTokens = event.message?.usage?.input_tokens ?? inputTokens
            } else if (type === 'message_delta') {
              outputTokens = event.usage?.output_tokens ?? outputTokens
            } else if (type === 'error') {
              streamError = event.error?.message ?? 'stream error'
            }
          })
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw abortError('response stream did not finish')
          throw err
        }
        if (!accumulated.trim()) {
          if (streamError) throw new LlmProviderError('api_error', `${vendor} stream error: ${streamError}`.slice(0, 240))
          throw new LlmProviderError('bad_response', `${vendor} response had no text (${call.label})`)
        }
        const meta = usageMeta(inputTokens, outputTokens)
        return meta ? { content: accumulated, meta } : { content: accumulated }
      }

      let responseBody: MessagesBody
      try {
        responseBody = (await res.json()) as MessagesBody
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw abortError('response body did not finish')
        throw err
      }
      const content = messageText(responseBody)
      if (!content) throw new LlmProviderError('bad_response', `${vendor} response had no text (${call.label})`)
      if (call.stream) call.onText?.(content)
      const meta = usageMeta(responseBody.usage?.input_tokens, responseBody.usage?.output_tokens)
      return meta ? { content, meta } : { content }
    } finally {
      clearTimeout(timer)
      call.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  async function send(
    messages: ChatMessage[],
    call: Omit<MessagesCall, 'stream'> & { wantStream?: boolean }
  ): Promise<{ content: string; meta?: LlmUsageMeta }> {
    const base = { label: call.label, maxTokens: call.maxTokens, onText: call.onText, signal: call.signal }
    if (call.wantStream && streamEnabled) {
      try {
        return await ladder.run((rung) => callMessages(messages, { ...base, stream: true }, rung))
      } catch (err) {
        if (!isBadRequest(err)) throw err
        const result = await ladder.run((rung) => callMessages(messages, { ...base, stream: false }, rung))
        streamEnabled = false
        console.warn(`[${vendor}] gateway rejected stream:true — streaming disabled for ${id}`)
        return result
      }
    }
    return ladder.run((rung) => callMessages(messages, { ...base, stream: false }, rung))
  }

  async function callAndParse<T>(
    messages: ChatMessage[],
    label: string,
    maxTokens: number,
    parse: (content: string) => T
  ): Promise<{ content: T; meta?: LlmUsageMeta }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await send(messages, { label, maxTokens })
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
      maxTokens: call.kind === 'core' ? CORE_MAX_TOKENS : EXTRAS_MAX_TOKENS,
      wantStream: Boolean(call.onText),
      onText: call.onText,
      signal: call.signal,
    })

  return {
    id,
    translate(req: LlmTranslationRequest, opts?: LlmTranslateOptions): Promise<LlmTranslationResult> {
      // No JSON mode on this API: retry the core call once on unparseable output.
      return runTranslate(vendor, transport, req, opts, { retryBadResponse: true })
    },
    async moreExamples(req: LlmMoreExamplesRequest): Promise<LlmMoreExamplesResult> {
      const { content: examples } = await callAndParse(
        buildMoreExamplesMessages(req),
        `moreExamples word="${req.word.slice(0, 60)}"`,
        EXTRAS_MAX_TOKENS,
        (content) => parseMoreExamplesContent(vendor, content)
      )
      return { examples }
    },
    async fuse(req: LlmFuseRequest): Promise<LlmFuseResult> {
      const { content: parsed, meta } = await callAndParse(
        buildFuseMessages(req),
        `fuse text="${req.request.text.slice(0, 60)}"`,
        CORE_MAX_TOKENS,
        (content) => parseContent(vendor, content)
      )
      if (req.request.sourceLang.toLowerCase() === req.request.targetLang.toLowerCase()) delete parsed.translation
      return meta ? { content: parsed, meta } : { content: parsed }
    },
  }
}
