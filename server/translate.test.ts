import { describe, expect, it, vi } from 'vitest'
import { normalizeText, adaptLlm, translate } from './translate'
import type { LlmProvider, LlmTranslationContent } from './providers/llm'
import type { DictionaryProvider } from './providers/dictionary'

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

  it('passes through a typo suggestion (with explanation)', () => {
    const content: LlmTranslationContent = {
      headword: 'helo',
      typo: { suggestion: 'hello', explanation: 'Did you mean “hello”?' },
    }
    const [entry] = adaptLlm(content)
    expect(entry.word).toBe('helo')
    expect(entry.typo).toEqual({ suggestion: 'hello', explanation: 'Did you mean “hello”?' })
    expect(entry.meanings).toEqual([])
    expect(entry.phonetics).toEqual([])
  })

  it('passes through a typo suggestion (without explanation)', () => {
    const content: LlmTranslationContent = {
      headword: 'teh',
      typo: { suggestion: 'the' },
    }
    const [entry] = adaptLlm(content)
    expect(entry.typo).toEqual({ suggestion: 'the' })
  })

  it('omits the typo field when not present', () => {
    const content: LlmTranslationContent = { headword: 'hello' }
    const [entry] = adaptLlm(content)
    expect(entry.typo).toBeUndefined()
  })

  it('maps translation and examples through', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      translation: 'hola',
      examples: ['Hello, how are you?', 'She said hello.'],
    }
    const [entry] = adaptLlm(content)
    expect(entry.translation).toBe('hola')
    expect(entry.examples).toEqual(['Hello, how are you?', 'She said hello.'])
  })

  it('omits translation and examples when absent or empty', () => {
    const content: LlmTranslationContent = { headword: 'hello', examples: [] }
    const [entry] = adaptLlm(content)
    expect(entry.translation).toBeUndefined()
    expect(entry.examples).toBeUndefined()
  })
})

describe('translate — in-flight dedup', () => {
  it('shares one LLM call across concurrent lookups for the same word', async () => {
    let calls = 0
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate() {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { content: { headword: 'hello', meanings: [{ definition: 'A greeting' }] } }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = { text: 'hello', sourceLang: 'en', targetLang: 'en' }

    const [a, b] = await Promise.all([
      translate(req, llm, dictionary, null),
      translate(req, llm, dictionary, null),
    ])

    expect(calls).toBe(1)
    expect(a.tier).toBe('llm')
    expect(b.tier).toBe('llm')
    expect(a.entries).toEqual(b.entries)
  })

  it('does not dedup sequential (non-overlapping) lookups', async () => {
    let calls = 0
    const llm: LlmProvider = {
      id: 'llm:test:test',
      async translate() {
        calls += 1
        return { content: { headword: 'hello', meanings: [{ definition: 'A greeting' }] } }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = { text: 'hello', sourceLang: 'en', targetLang: 'en' }

    await translate(req, llm, dictionary, null)
    await translate(req, llm, dictionary, null)

    expect(calls).toBe(2)
  })
})
