/**
 * Extension-local `DictionaryEntry` shape. Intentionally NOT imported from
 * `server/translate.ts` (a server-only module with Express/Mongo
 * dependencies) — this is an independent copy, matching the pattern already
 * used by `src/api/dictionary.ts` in the main web app.
 */

/** CEFR proficiency level (A1 easiest – C2 hardest). */
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'

export interface Phonetic {
  text?: string
  audio?: string
}

export interface GradedExample {
  text: string
  cefr?: CefrLevel
}

export interface Definition {
  definition: string
  cefr?: CefrLevel
  grammar?: string
  register?: string
  examples?: GradedExample[]
}

export interface Meaning {
  partOfSpeech: string
  definitions: Definition[]
}

export interface CommonMistake {
  wrong: string
  right: string
  note?: string
}

export interface TypoSuggestion {
  suggestion: string
  explanation?: string
}

export interface DictionaryEntry {
  word: string
  phonetic?: string
  phonetics?: Phonetic[]
  meanings?: Meaning[]
  sourceUrls?: string[]
  translation?: string
  commonMistakes?: CommonMistake[]
  collocations?: string[]
  wordFamily?: string[]
  typo?: TypoSuggestion
}
