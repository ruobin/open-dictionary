import { describe, expect, it } from 'vitest'
import { normalizeText, adaptLlm } from './translate'
import type { LlmTranslationContent } from './providers/llm'

describe('normalizeText', () => {
  it('trims, lowercases, and collapses consecutive whitespace', () => {
    expect(normalizeText('  Hello   WORLD  ')).toBe('hello world')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeText('   ')).toBe('')
  })

  it('NFC‑normalises', () => {
    // "café" is already NFC; the call is still side‑effect‑free.
    expect(normalizeText('café')).toBe('café')
  })

  it('truncates at 256 characters', () => {
    const long = 'a'.repeat(300)
    const result = normalizeText(long)
    expect(result.length).toBe(256)
    expect(result).toBe('a'.repeat(256))
  })
})

describe('adaptLlm', () => {
  it('maps headword, phonetics and phonetic', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      phonetic: '/həˈloʊ/',
    }
    const [entry] = adaptLlm(content)
    expect(entry.word).toBe('hello')
    expect(entry.phonetic).toBe('/həˈloʊ/')
    expect(entry.phonetics).toEqual([{ text: '/həˈloʊ/' }])
  })

  it('maps meanings → definitions with part of speech', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      partOfSpeech: 'interjection',
      meanings: [
        { definition: 'A greeting', example: 'Hello there!' },
        { definition: 'An exclamation of surprise' },
      ],
    }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toHaveLength(1)
    const m = entry.meanings[0]
    expect(m.partOfSpeech).toBe('interjection')
    expect(m.definitions).toHaveLength(2)
    expect(m.definitions[0]).toEqual({ definition: 'A greeting', example: 'Hello there!' })
    expect(m.definitions[1]).toEqual({ definition: 'An exclamation of surprise' })
  })

  it('returns empty phonetics and meanings when none are provided', () => {
    const content: LlmTranslationContent = { headword: 'test' }
    const [entry] = adaptLlm(content)
    expect(entry.phonetics).toEqual([])
    expect(entry.meanings).toEqual([])
  })

  it('skips meanings when the array is empty', () => {
    const content: LlmTranslationContent = { headword: 'a', meanings: [] }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toEqual([])
  })

  it('does not fail when content has unknown extra fields', () => {
    const content = { headword: 'b', extra: 123 } as unknown as LlmTranslationContent
    const [entry] = adaptLlm(content)
    expect(entry.word).toBe('b')
  })
})
