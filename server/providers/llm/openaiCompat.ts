import {
  LlmProviderError,
  type CefrLevel,
  type LlmCommonMistake,
  type LlmGradedExample,
  type LlmMeaningGroup,
  type LlmProvider,
  type LlmSense,
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
    ? `Define and explain the ${sourceName} word or expression "${text}" for a learner. ` +
      `Source and target language are both ${sourceName} here — this is a DEFINITION request, not translation. Omit the "translation" field entirely.`
    : `Translate the ${sourceName} word or expression "${text}" into ${targetName} and explain it for a learner.`

  const system = [
    'You are a precise multilingual dictionary and translation engine built for language learners.',
    'Respond with ONE value: a single JSON object (no markdown fences, no commentary) matching this shape:',
    '{',
    '  "headword": string,            // the queried term, as given',
    '  "translation"?: string,        // best short translation into the target language; omit when defining in the same language',
    '  "phonetic"?: string,           // IPA transcription when known',
    '  "meaningGroups"?: [',
    '    {',
    '      "partOfSpeech": string,    // e.g. "noun", "verb" — a SEPARATE group per part of speech',
    '                                 // ("run" as a verb and "run" as a noun are TWO groups, not one)',
    '      "senses": [',
    '        {',
    '          "definition": string,        // in targetLang',
    '          "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2",   // difficulty of this sense',
    '          "grammar"?: string,          // e.g. "countable", "transitive", "[+ that clause]", "irregular: go, went, gone"',
    '          "register"?: string,         // e.g. "formal", "informal", "slang", "dated", "UK", "US"',
    '          "examples"?: [{ "text": string, "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2" }]',
    '                                       // 2-3 example sentences in sourceLang, EACH AT A DIFFERENT CEFR level',
    '        }',
    '      ]                              // 1-3 senses per group, most common first',
    '    }',
    '  ],                                 // 1-3 groups, most common part of speech first',
    '  "commonMistakes"?: [{ "wrong": string, "right": string, "note"?: string }],',
    '                                     // learner-corpus-style corrections, e.g. { "wrong": "make a photo", "right": "take a photo" }',
    '                                     // note in targetLang; omit entirely if there is no well-known common mistake',
    '  "collocations"?: string[],         // fixed expressions this word commonly appears in, e.g. "heavy rain", "commit a crime"',
    '  "wordFamily"?: string[],           // related words, e.g. run -> "runner", "running", "rerun"',
    '  "typo"?: { "suggestion": string, "explanation"?: string }  // only present when the input is an obvious typo',
    '}',
    `Write "definition"/"note" text in ${targetName} and all example sentences in ${sourceName}. Keep it concise and accurate.`,
    'Each "collocations" and "wordFamily" entry MUST be ONLY the bare word/phrase itself — no parenthetical',
    'part-of-speech labels (write "runner", never "runner (noun)") and no slash-separated alternatives',
    '(write one concrete phrase like "run for president", never "run for president/mayor"). Each entry is',
    'rendered as a clickable link to that exact term\'s own page, so it must be a clean, independently',
    'look-up-able word or phrase.',
    'Only include "commonMistakes", "collocations", and "wordFamily" when you have a genuinely useful, well-known answer — omit them rather than inventing something generic.',
    '',
    'TYPO DETECTION: Before answering, check whether the input is an OBVIOUS typo of a real',
    `${sourceName} word — e.g. missing letters ("helo" → "hello"), transposed letters ("teh" → "the"),`,
    'or a single common misspelling. If it is, return ONLY:',
    `  { "headword": <the original input>, "typo": { "suggestion": <the corrected word>, "explanation": <a short note in ${targetName}, e.g. "Did you mean …?"> } }`,
    'Omit every other field in this case.',
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

const CEFR_LEVELS = new Set<string>(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])

function asCefr(value: unknown): CefrLevel | undefined {
  const s = asString(value)
  return s && CEFR_LEVELS.has(s) ? (s as CefrLevel) : undefined
}

function parseGradedExample(value: unknown): LlmGradedExample | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const text = asString(v.text)?.trim()
  if (!text) return undefined
  const cefr = asCefr(v.cefr)
  return cefr ? { text, cefr } : { text }
}

function parseSense(value: unknown): LlmSense | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const definition = asString(v.definition)?.trim()
  if (!definition) return undefined

  const sense: LlmSense = { definition }
  const cefr = asCefr(v.cefr)
  if (cefr) sense.cefr = cefr
  const grammar = asString(v.grammar)?.trim()
  if (grammar) sense.grammar = grammar
  const register = asString(v.register)?.trim()
  if (register) sense.register = register
  if (Array.isArray(v.examples)) {
    const examples = v.examples
      .map(parseGradedExample)
      .filter((e): e is LlmGradedExample => Boolean(e))
    if (examples.length > 0) sense.examples = examples
  }
  return sense
}

function parseMeaningGroup(value: unknown): LlmMeaningGroup | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const partOfSpeech = asString(v.partOfSpeech)?.trim()
  if (!partOfSpeech) return undefined
  const senses = Array.isArray(v.senses)
    ? v.senses.map(parseSense).filter((s): s is LlmSense => Boolean(s))
    : []
  if (senses.length === 0) return undefined
  return { partOfSpeech, senses }
}

function parseCommonMistake(value: unknown): LlmCommonMistake | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const wrong = asString(v.wrong)?.trim()
  const right = asString(v.right)?.trim()
  if (!wrong || !right) return undefined
  const note = asString(v.note)?.trim()
  return note ? { wrong, right, note } : { wrong, right }
}

function nonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return strings.length > 0 ? strings : undefined
}

/** Extracts the first JSON object from a model reply, tolerating fences/prose.
 *  Parsing is deliberately lenient/defensive field-by-field: a malformed or
 *  missing sub-field (e.g. a bad "cefr" value) is dropped rather than failing
 *  the whole response — a partially-rich entry beats no entry. */
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

  const meaningGroups = Array.isArray(obj.meaningGroups)
    ? obj.meaningGroups.map(parseMeaningGroup).filter((g): g is LlmMeaningGroup => Boolean(g))
    : undefined
  const commonMistakes = Array.isArray(obj.commonMistakes)
    ? obj.commonMistakes.map(parseCommonMistake).filter((m): m is LlmCommonMistake => Boolean(m))
    : undefined
  const collocations = nonEmptyStrings(obj.collocations)
  const wordFamily = nonEmptyStrings(obj.wordFamily)

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
    phonetic: asString(obj.phonetic),
    ...(meaningGroups && meaningGroups.length > 0 ? { meaningGroups } : {}),
    ...(commonMistakes && commonMistakes.length > 0 ? { commonMistakes } : {}),
    ...(collocations ? { collocations } : {}),
    ...(wordFamily ? { wordFamily } : {}),
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
      const parsed = parseContent(vendor, content)
      // Defensive: the model occasionally includes a "translation" even in
      // same-language define mode despite the prompt saying to omit it. The
      // UI shows this field whenever it's truthy, so a same-language
      // hallucination would visibly (and wrongly) render a translation.
      if (req.sourceLang.toLowerCase() === req.targetLang.toLowerCase()) {
        delete parsed.translation
      }
      return { content: parsed }
    },
  }
}
