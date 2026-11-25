import {
  LlmProviderError,
  type CefrLevel,
  type LlmCommonMistake,
  type LlmGradedExample,
  type LlmMeaningGroup,
  type LlmSense,
  type LlmTranslationContent,
} from './types'
import { MAX_LOOKUP_TEXT_LENGTH } from '../../../shared/limits'

/**
 * Hard bounds on one model answer. The prompts ask for far less (1-3 groups
 * of 1-3 senses, at most 5 collocations, …); these are the ceiling for what
 * is stored for a year and served to every later reader, whatever a model was
 * talked into writing. They are loose enough for a fusion merge, which unions
 * two answers. Counts: extra items are dropped. Lengths (in UTF-16 units):
 * prose is cut with an ellipsis; a chip (collocation / word-family entry, each
 * a link to its own page) that is too long is not a term and is dropped.
 */
export const OUTPUT_LIMITS = {
  meaningGroups: 8,
  sensesPerGroup: 8,
  examplesPerSense: 6,
  commonMistakes: 6,
  collocations: 12,
  wordFamily: 12,
  moreExamples: 5,
  headword: MAX_LOOKUP_TEXT_LENGTH,
  translation: 600,
  phonetic: 200,
  partOfSpeech: 60,
  definition: 600,
  grammar: 200,
  register: 80,
  example: 400,
  mistake: 200,
  note: 400,
  chip: 100,
  typoSuggestion: MAX_LOOKUP_TEXT_LENGTH,
  typoExplanation: 300,
} as const

/** `text` cut to at most `max` UTF-16 units, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** Prose cut to `max`, with an ellipsis marking that something was removed. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${cut(text, max - 1).trimEnd()}…`
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A string field clipped to `max` but otherwise untouched (no trimming), or undefined. */
function clipped(value: unknown, max: number): string | undefined {
  const text = asString(value)
  return text === undefined ? undefined : clip(text, max)
}

/** A trimmed, non-empty prose field clipped to `max`, or undefined. */
function prose(value: unknown, max: number): string | undefined {
  const text = asString(value)?.trim()
  return text ? clip(text, max) : undefined
}

const CEFR_LEVELS = new Set<string>(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])

function asCefr(value: unknown): CefrLevel | undefined {
  const s = asString(value)
  return s && CEFR_LEVELS.has(s) ? (s as CefrLevel) : undefined
}

function parseGradedExample(value: unknown): LlmGradedExample | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const text = prose(v.text, OUTPUT_LIMITS.example)
  if (!text) return undefined
  const cefr = asCefr(v.cefr)
  return cefr ? { text, cefr } : { text }
}

function parseSense(value: unknown): LlmSense | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const definition = prose(v.definition, OUTPUT_LIMITS.definition)
  if (!definition) return undefined

  const sense: LlmSense = { definition }
  const cefr = asCefr(v.cefr)
  if (cefr) sense.cefr = cefr
  const grammar = prose(v.grammar, OUTPUT_LIMITS.grammar)
  if (grammar) sense.grammar = grammar
  const register = prose(v.register, OUTPUT_LIMITS.register)
  if (register) sense.register = register
  if (Array.isArray(v.examples)) {
    const examples = v.examples
      .map(parseGradedExample)
      .filter((e): e is LlmGradedExample => Boolean(e))
      .slice(0, OUTPUT_LIMITS.examplesPerSense)
    if (examples.length > 0) sense.examples = examples
  }
  return sense
}

function parseMeaningGroup(value: unknown): LlmMeaningGroup | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const partOfSpeech = prose(v.partOfSpeech, OUTPUT_LIMITS.partOfSpeech)
  if (!partOfSpeech) return undefined
  const senses = Array.isArray(v.senses)
    ? v.senses
        .map(parseSense)
        .filter((s): s is LlmSense => Boolean(s))
        .slice(0, OUTPUT_LIMITS.sensesPerGroup)
    : []
  if (senses.length === 0) return undefined
  return { partOfSpeech, senses }
}

function parseCommonMistake(value: unknown): LlmCommonMistake | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const wrong = prose(v.wrong, OUTPUT_LIMITS.mistake)
  const right = prose(v.right, OUTPUT_LIMITS.mistake)
  if (!wrong || !right) return undefined
  // A "mistake" identical to its correction is model noise, not a correction.
  if (wrong.toLowerCase() === right.toLowerCase()) return undefined
  const note = prose(v.note, OUTPUT_LIMITS.note)
  return note ? { wrong, right, note } : { wrong, right }
}

/** Chips: non-empty strings no longer than a term can be, at most `maxItems` of them. */
function chips(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= OUTPUT_LIMITS.chip)
    .slice(0, maxItems)
  return strings.length > 0 ? strings : undefined
}

/** Pulls the first JSON object out of a model reply, tolerating code fences
 *  and surrounding prose. Throws `bad_response` when none can be parsed. */
export function extractJsonObject(vendor: string, raw: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>
}

export function parseMoreExamplesContent(vendor: string, raw: string): LlmGradedExample[] {
  const obj = extractJsonObject(vendor, raw)
  return Array.isArray(obj.examples)
    ? obj.examples
        .map(parseGradedExample)
        .filter((e): e is LlmGradedExample => Boolean(e))
        .slice(0, OUTPUT_LIMITS.moreExamples)
    : []
}

/** The three "extras" the second, parallel call produces. */
export interface LlmExtras {
  commonMistakes?: LlmCommonMistake[]
  collocations?: string[]
  wordFamily?: string[]
}

export function extrasFromObject(obj: Record<string, unknown>): LlmExtras {
  const commonMistakes = Array.isArray(obj.commonMistakes)
    ? obj.commonMistakes
        .map(parseCommonMistake)
        .filter((m): m is LlmCommonMistake => Boolean(m))
        .slice(0, OUTPUT_LIMITS.commonMistakes)
    : undefined
  const collocations = chips(obj.collocations, OUTPUT_LIMITS.collocations)
  const wordFamily = chips(obj.wordFamily, OUTPUT_LIMITS.wordFamily)
  return {
    ...(commonMistakes && commonMistakes.length > 0 ? { commonMistakes } : {}),
    ...(collocations ? { collocations } : {}),
    ...(wordFamily ? { wordFamily } : {}),
  }
}

export function parseExtrasContent(vendor: string, raw: string): LlmExtras {
  return extrasFromObject(extractJsonObject(vendor, raw))
}

/** Field-by-field lenient normalisation of an already-parsed content object.
 *  A malformed or missing sub-field (e.g. a bad "cefr" value) is dropped
 *  rather than failing the whole response — a partially-rich entry beats no
 *  entry. Shared by the final parse and the streaming partial snapshots. */
export function contentFromObject(obj: Record<string, unknown>): LlmTranslationContent {
  const meaningGroups = Array.isArray(obj.meaningGroups)
    ? obj.meaningGroups
        .map(parseMeaningGroup)
        .filter((g): g is LlmMeaningGroup => Boolean(g))
        .slice(0, OUTPUT_LIMITS.meaningGroups)
    : undefined

  let typo: LlmTranslationContent['typo']
  if (obj.typo && typeof obj.typo === 'object') {
    const t = obj.typo as Record<string, unknown>
    const trimmed = asString(t.suggestion)?.trim()
    // A suggestion is itself a term (it links to that word's page).
    const suggestion = trimmed ? cut(trimmed, OUTPUT_LIMITS.typoSuggestion) : undefined
    if (suggestion) {
      const explanation = prose(t.explanation, OUTPUT_LIMITS.typoExplanation)
      typo = explanation ? { suggestion, explanation } : { suggestion }
    }
  }

  return {
    headword: cut(asString(obj.headword) ?? '', OUTPUT_LIMITS.headword),
    translation: clipped(obj.translation, OUTPUT_LIMITS.translation),
    phonetic: clipped(obj.phonetic, OUTPUT_LIMITS.phonetic),
    ...(meaningGroups && meaningGroups.length > 0 ? { meaningGroups } : {}),
    ...extrasFromObject(obj),
    ...(typo ? { typo } : {}),
  }
}

/** Extracts the first JSON object from a model reply, tolerating fences/prose. */
export function parseContent(vendor: string, raw: string): LlmTranslationContent {
  return contentFromObject(extractJsonObject(vendor, raw))
}
