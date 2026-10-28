import {
  LlmProviderError,
  type CefrLevel,
  type LlmCommonMistake,
  type LlmGradedExample,
  type LlmMeaningGroup,
  type LlmSense,
  type LlmTranslationContent,
} from './types'

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
  // A "mistake" identical to its correction is model noise, not a correction.
  if (wrong.toLowerCase() === right.toLowerCase()) return undefined
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
    ? obj.examples.map(parseGradedExample).filter((e): e is LlmGradedExample => Boolean(e))
    : []
}

/** The three "extras" the second, parallel call produces. */
export interface LlmExtras {
  commonMistakes?: LlmCommonMistake[]
  collocations?: string[]
  wordFamily?: string[]
}

function extrasFromObject(obj: Record<string, unknown>): LlmExtras {
  const commonMistakes = Array.isArray(obj.commonMistakes)
    ? obj.commonMistakes.map(parseCommonMistake).filter((m): m is LlmCommonMistake => Boolean(m))
    : undefined
  const collocations = nonEmptyStrings(obj.collocations)
  const wordFamily = nonEmptyStrings(obj.wordFamily)
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
    ? obj.meaningGroups.map(parseMeaningGroup).filter((g): g is LlmMeaningGroup => Boolean(g))
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
    phonetic: asString(obj.phonetic),
    ...(meaningGroups && meaningGroups.length > 0 ? { meaningGroups } : {}),
    ...extrasFromObject(obj),
    ...(typo ? { typo } : {}),
  }
}

/** Extracts the first JSON object from a model reply, tolerating fences/prose. */
export function parseContent(vendor: string, raw: string): LlmTranslationContent {
  return contentFromObject(extractJsonObject(vendor, raw))
}
