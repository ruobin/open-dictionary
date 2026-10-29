import { contentFromObject, extrasFromObject, type LlmExtras } from './parse'
import type { LlmTranslationContent } from './types'

/**
 * Incremental extraction of an LLM's in-progress JSON answer.
 *
 * While a call streams, the accumulated text is e.g.
 *   {"headword":"run","translation":"跑","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"to mov
 * `parsePartialObject` closes whatever is still open (the half-written string,
 * the arrays and objects around it) and drops anything that cannot be valid yet
 * (a dangling key, a trailing comma, a half-typed literal), so the UI sees the
 * answer growing token by token — including inside a definition that is still
 * being written.
 *
 * It is a display hint only: it never throws, and the final answer always comes
 * from a full `parseContent` on the complete text. Re-scanning the whole buffer
 * is O(n) per call, and n is a few KB.
 */

const WS = /\s/

/** Returns the buffer made syntactically complete, or null if there is no object yet. */
function repair(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let s = raw.slice(start)

  const stack: string[] = []
  let inString = false
  let escaped = false
  let stringStart = -1
  let stringIsKey = false
  let lastSignificant = ''
  // Where the most recent *closed* string began, and whether it was an object key.
  let closedStringStart = -1
  let closedStringIsKey = false

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') {
        inString = false
        closedStringStart = stringStart
        closedStringIsKey = stringIsKey
        lastSignificant = '"'
      }
      continue
    }
    if (c === '"') {
      inString = true
      stringStart = i
      stringIsKey = stack[stack.length - 1] === '{' && (lastSignificant === '{' || lastSignificant === ',')
      continue
    }
    if (WS.test(c)) continue
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
    lastSignificant = c
  }

  if (stack.length === 0 && !inString) return s // already complete

  if (inString) {
    if (stringIsKey) {
      s = s.slice(0, stringStart)
    } else {
      // Don't end on a lone backslash or a half-typed \uXXXX escape.
      if (escaped) s = s.slice(0, -1)
      s = s.replace(/\\u[0-9a-fA-F]{0,3}$/, '')
      s += '"'
    }
  } else if (closedStringIsKey && lastSignificant === '"') {
    s = s.slice(0, closedStringStart) // a key whose colon has not arrived
  }

  for (;;) {
    const trimmed = s.replace(/\s+$/, '')
    if (trimmed.endsWith(',')) {
      s = trimmed.slice(0, -1)
    } else if (trimmed.endsWith(':')) {
      // Drop the colon and the key in front of it (keys are plain identifiers).
      const withoutColon = trimmed.slice(0, -1).replace(/\s+$/, '')
      const keyStart = withoutColon.lastIndexOf('"', withoutColon.length - 2)
      s = keyStart === -1 ? withoutColon : withoutColon.slice(0, keyStart)
    } else if (/(?:^|[\[,:{\s])[A-Za-z0-9.+-]+$/.test(trimmed) && !trimmed.endsWith('"')) {
      // A half-typed true/false/null/number.
      s = trimmed.replace(/[A-Za-z0-9.+-]+$/, '')
    } else {
      s = trimmed
      break
    }
  }

  // Recompute what is still open after the trimming above.
  const open: string[] = []
  let str = false
  let esc = false
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (str) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') str = false
      continue
    }
    if (c === '"') str = true
    else if (c === '{' || c === '[') open.push(c)
    else if (c === '}' || c === ']') open.pop()
  }
  for (let i = open.length - 1; i >= 0; i -= 1) s += open[i] === '{' ? '}' : ']'
  return s
}

export function parsePartialObject(raw: string): Record<string, unknown> | null {
  const repaired = repair(raw)
  if (repaired === null) return null
  try {
    const parsed: unknown = JSON.parse(repaired)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Best-effort snapshot of the "core" answer so far, or null while it has nothing to show. */
export function extractPartialContent(raw: string): LlmTranslationContent | null {
  const obj = parsePartialObject(raw)
  if (!obj) return null
  const content = contentFromObject(obj)
  const hasAnything =
    Boolean(content.headword) ||
    Boolean(content.translation) ||
    Boolean(content.phonetic) ||
    Boolean(content.meaningGroups?.length) ||
    Boolean(content.typo)
  return hasAnything ? content : null
}

/** Best-effort snapshot of the "extras" answer (mistakes, collocations, word family) so far. */
export function extractPartialExtras(raw: string): LlmExtras | null {
  const obj = parsePartialObject(raw)
  return obj ? extrasFromObject(obj) : null
}
