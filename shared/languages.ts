/**
 * Single source of truth for supported languages. Imported by both the
 * frontend (dropdown labels) and the server (human-readable LLM prompt text).
 *
 * The BCP-47 `code` remains the canonical value flowing through the URL,
 * query params, cache key, and the dictionary API path; `name` is used only
 * for human-facing display (UI + prompt).
 */
export interface Language {
  code: string
  name: string
}

export const LANGUAGES: readonly Language[] = [
  { code: 'ar', name: 'Arabic' },
  { code: 'bn', name: 'Bengali' },
  { code: 'de', name: 'German' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ms', name: 'Malay' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ta', name: 'Tamil' },
  { code: 'th', name: 'Thai' },
  { code: 'tl', name: 'Filipino' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ur', name: 'Urdu' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'zh', name: 'Chinese' },
] as const

export const DEFAULT_SOURCE_LANG = 'en'
export const DEFAULT_TARGET_LANG = 'en'

const NAME_BY_CODE = new Map<string, string>(LANGUAGES.map((l) => [l.code, l.name]))

/** Returns the human-readable name for a BCP-47 code (case-insensitive),
 *  falling back to the raw code when unknown. */
export function languageName(code: string): string {
  return NAME_BY_CODE.get(code.toLowerCase()) ?? code
}
