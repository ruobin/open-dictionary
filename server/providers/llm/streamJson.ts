import { contentFromObject } from './parse'
import type { LlmTranslationContent } from './types'

/**
 * Incremental extraction of an LLM's in-progress JSON answer.
 *
 * While the core call streams, the accumulated text is e.g.
 *   {"headword":"run","translation":"跑","phonetic":"/rʌn/","meaningGroups":[{"partOfSpeech":"verb",...},{"partOf
 * `extractPartialContent` returns whatever is already COMPLETE — finished
 * top-level values, and each finished element of `meaningGroups` — so the UI
 * can render the headword/translation immediately and add senses one by one.
 *
 * It is a display hint only: it never throws, never guesses at incomplete
 * values, and the final answer always comes from a full `parseContent`.
 * Re-scanning the whole buffer on each chunk is O(n²) but n is a few KB.
 */

const WS = /\s/

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i])) i += 1
  return i
}

/** Index just past the string literal starting at s[i] === '"', or -1 if unterminated. */
function endOfString(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j += 1) {
    const c = s[j]
    if (c === '\\') {
      j += 1
      continue
    }
    if (c === '"') return j + 1
  }
  return -1
}

/** Index just past the object/array starting at s[i], or -1 if it is not closed yet. */
function endOfContainer(s: string, i: number): number {
  let depth = 0
  for (let j = i; j < s.length; j += 1) {
    const c = s[j]
    if (c === '"') {
      const end = endOfString(s, j)
      if (end === -1) return -1
      j = end - 1
    } else if (c === '{' || c === '[') {
      depth += 1
    } else if (c === '}' || c === ']') {
      depth -= 1
      if (depth === 0) return j + 1
    }
  }
  return -1
}

export function extractPartialContent(raw: string): LlmTranslationContent | null {
  const start = raw.indexOf('{')
  if (start === -1) return null

  const fields: Record<string, unknown> = {}
  const groups: unknown[] = []
  let i = start + 1

  for (;;) {
    i = skipWs(raw, i)
    while (raw[i] === ',') i = skipWs(raw, i + 1)
    if (i >= raw.length || raw[i] !== '"') break

    const keyEnd = endOfString(raw, i)
    if (keyEnd === -1) break
    let key: string
    try {
      key = JSON.parse(raw.slice(i, keyEnd)) as string
    } catch {
      break
    }
    i = skipWs(raw, keyEnd)
    if (raw[i] !== ':') break
    i = skipWs(raw, i + 1)
    if (i >= raw.length) break

    const first = raw[i]

    if (key === 'meaningGroups' && first === '[') {
      let j = i + 1
      for (;;) {
        j = skipWs(raw, j)
        while (raw[j] === ',') j = skipWs(raw, j + 1)
        if (j >= raw.length || raw[j] !== '{') break
        const elementEnd = endOfContainer(raw, j)
        if (elementEnd === -1) break
        try {
          groups.push(JSON.parse(raw.slice(j, elementEnd)))
        } catch {
          // skip an unparseable element, keep scanning
        }
        j = elementEnd
      }
      if (raw[j] === ']') {
        i = j + 1
        continue
      }
      break
    }

    let valueEnd: number
    if (first === '"') {
      valueEnd = endOfString(raw, i)
    } else if (first === '{' || first === '[') {
      valueEnd = endOfContainer(raw, i)
    } else {
      // number / boolean / null: only complete once a delimiter follows
      let j = i
      while (j < raw.length && !/[,}\]\s]/.test(raw[j])) j += 1
      valueEnd = j < raw.length ? j : -1
    }
    if (valueEnd === -1) break
    try {
      fields[key] = JSON.parse(raw.slice(i, valueEnd))
    } catch {
      // ignore, keep scanning
    }
    i = valueEnd
  }

  if (groups.length > 0) fields.meaningGroups = groups
  const content = contentFromObject(fields)
  const hasAnything =
    Boolean(content.headword) ||
    Boolean(content.translation) ||
    Boolean(content.phonetic) ||
    Boolean(content.meaningGroups?.length) ||
    Boolean(content.typo)
  return hasAnything ? content : null
}
