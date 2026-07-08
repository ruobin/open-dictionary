import {
  LlmProviderError,
  type LlmDefinition,
  type LlmProvider,
  type LlmTranslationContent,
  type LlmTranslationRequest,
  type LlmTranslationResult,
} from './types'
import { languageName } from '../../../shared/languages'

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
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_TEMPERATURE = 0.2

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function buildMessages(req: LlmTranslationRequest): ChatMessage[] {
  const { text, sourceLang, targetLang } = req
  const sameLang = sourceLang.toLowerCase() === targetLang.toLowerCase()
  const sourceName = languageName(sourceLang)
  const targetName = languageName(targetLang)

  const task = sameLang
    ? `Define and explain the ${sourceName} word or expression "${text}" for a learner.`
    : `Translate the ${sourceName} word or expression "${text}" into ${targetName} and explain it for a learner.`

  const system = [
    'You are a precise multilingual dictionary and translation engine.',
    'Respond with ONE value: a single JSON object (no markdown fences, no commentary) matching this shape:',
    '{',
    '  "headword": string,            // the queried term, as given',
    '  "translation"?: string,        // best short translation into the target language; omit when defining in the same language',
    '  "partOfSpeech"?: string,       // e.g. "noun", "verb"',
    '  "phonetic"?: string,           // IPA transcription when known',
    '  "meanings"?: [{ "definition": string, "example"?: string }],  // 1-3 concise senses; definition in targetLang, example in sourceLang',
    '  "examples"?: string[],         // extra usage examples',
    '  "typo"?: { "suggestion": string, "explanation"?: string }  // only present when the input is an obvious typo',
    '}',
    `Write "definition" text in ${targetName} and "example" sentences in ${sourceName}. Keep it concise and accurate.`,
    '',
    'TYPO DETECTION: Before answering, check whether the input is an OBVIOUS typo of a real',
    `${sourceName} word — e.g. missing letters ("helo" → "hello"), transposed letters ("teh" → "the"),`,
    'or a single common misspelling. If it is, return ONLY:',
    `  { "headword": <the original input>, "typo": { "suggestion": <the corrected word>, "explanation": <a short note in ${targetName}, e.g. "Did you mean …?"> } }`,
    'Omit translation, partOfSpeech, phonetic, meanings, and examples in this case.',
    `Do NOT flag dialectal variants (e.g. "colour" vs "color"), proper nouns, brand names, abbreviations,`,
    `rare or technical terms, slang, code identifiers, or words from a language other than ${sourceName} as typos.`,
    'When in doubt, translate normally.',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ]
}

interface ChatChoice {
  message?: { content?: string }
}
interface ChatResponseBody {
  choices?: ChatChoice[]
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Extracts the first JSON object from a model reply, tolerating fences/prose. */
function parseContent(vendor: string, raw: string): LlmTranslationContent {
  const stripped = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new LlmProviderError('bad_response', `${vendor} response did not contain a JSON object`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    throw new LlmProviderError('bad_response', `${vendor} response was not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new LlmProviderError('bad_response', `${vendor} response JSON was not an object`)
  }

  const obj = parsed as Record<string, unknown>
  const meanings = Array.isArray(obj.meanings)
    ? obj.meanings.filter(
        (m): m is LlmDefinition =>
          !!m && typeof m === 'object' && typeof asString((m as Record<string, unknown>).definition) === 'string'
      )
    : undefined
  const examples = Array.isArray(obj.examples)
    ? obj.examples.filter((e): e is string => typeof e === 'string')
    : undefined

  let typo: LlmTranslationContent['typo']
  if (obj.typo && typeof obj.typo === 'object') {
    const t = obj.typo as Record<string, unknown>
    const suggestion = asString(t.suggestion)?.trim()
    if (suggestion) {
      const explanation = asString(t.explanation)?.trim()
      typo = explanation ? { suggestion, explanation } : { suggestion }
    }
  }

  return {
    headword: asString(obj.headword) ?? '',
    translation: asString(obj.translation),
    partOfSpeech: asString(obj.partOfSpeech),
    phonetic: asString(obj.phonetic),
    meanings,
    examples,
    ...(typo ? { typo } : {}),
  }
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

  return {
    id,
    async translate(req: LlmTranslationRequest): Promise<LlmTranslationResult> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const started = Date.now()
      const url = `${baseUrl}/chat/completions`
      const messages = buildMessages(req)
      dbg(
        `→ POST ${url} model=${model} timeout=${timeoutMs}ms text="${req.text.slice(0, 60)}"\n` +
          messages.map((m) => `--- [${m.role}] ---\n${m.content}`).join('\n')
      )

      const requestBody: Record<string, unknown> = { model, messages, temperature }
      if (jsonMode) requestBody.response_format = { type: 'json_object' }

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(headers ?? {}),
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        })
      } catch (err) {
        const elapsed = Date.now() - started
        if (err instanceof Error && err.name === 'AbortError') {
          dbg(`← TIMEOUT after ${elapsed}ms — no response received from ${url}`)
          throw new LlmProviderError(
            'timeout',
            `${vendor} request to ${url} timed out after ${elapsed}ms (limit ${timeoutMs}ms) — no response received`
          )
        }
        dbg(`← NETWORK ERROR after ${elapsed}ms:`, err)
        throw new LlmProviderError(
          'network',
          `Could not reach the ${vendor} API at ${url}: ${(err as Error)?.message ?? err}`
        )
      } finally {
        clearTimeout(timer)
      }

      const elapsed = Date.now() - started
      dbg(`← ${res.status} in ${elapsed}ms`)

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        dbg(`← error body: ${detail.slice(0, 500)}`)
        throw new LlmProviderError(
          'api_error',
          `${vendor} API error: ${res.status} ${detail.slice(0, 200)}`.trimEnd(),
          res.status
        )
      }

      const responseBody = (await res.json()) as ChatResponseBody
      const content = responseBody?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        dbg(`← no message content; body: ${JSON.stringify(responseBody).slice(0, 500)}`)
        throw new LlmProviderError('bad_response', `${vendor} response had no message content`)
      }
      return { content: parseContent(vendor, content) }
    },
  }
}
