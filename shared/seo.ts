/**
 * Pure title/description builders shared between the client (per-page
 * <title>/<meta> updates, src/hooks/useDocumentMeta.ts) and the build-time
 * prerender script (scripts/render.ts), so a search result snippet and the
 * live browser tab title stay in sync.
 */
const MAX_DESCRIPTION_LENGTH = 160

export function buildWordTitle(word: string): string {
  return `${word.toUpperCase()} | definition, examples, pronunciation — Open Dictionary`
}

export function buildWordDescription(firstDefinition: string | undefined, word: string): string {
  const text = firstDefinition?.trim() || `Definitions, pronunciation, and examples for "${word}".`
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
    : text
}
