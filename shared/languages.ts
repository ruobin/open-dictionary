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
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
] as const

export const DEFAULT_SOURCE_LANG = 'en'
export const DEFAULT_TARGET_LANG = 'en'

const NAME_BY_CODE = new Map<string, string>(LANGUAGES.map((l) => [l.code, l.name]))

/** Returns the human-readable name for a BCP-47 code, falling back to the code. */
export function languageName(code: string): string {
  return NAME_BY_CODE.get(code) ?? code
}
