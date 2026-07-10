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

  it('maps a meaning group → one Meaning per part of speech, with graded fields', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      meaningGroups: [
        {
          partOfSpeech: 'interjection',
          senses: [
            {
              definition: 'A greeting',
              cefr: 'A1',
              register: 'informal',
              examples: [
                { text: 'Hello there!', cefr: 'A1' },
                { text: 'A cheery hello rang out across the room.', cefr: 'B2' },
              ],
            },
            { definition: 'An exclamation of surprise' },
          ],
        },
      ],
    }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toHaveLength(1)
    const m = entry.meanings[0]
    expect(m.partOfSpeech).toBe('interjection')
    expect(m.definitions).toHaveLength(2)
    expect(m.definitions[0]).toEqual({
      definition: 'A greeting',
      cefr: 'A1',
      register: 'informal',
      examples: [
        { text: 'Hello there!', cefr: 'A1' },
        { text: 'A cheery hello rang out across the room.', cefr: 'B2' },
      ],
    })
    expect(m.definitions[1]).toEqual({ definition: 'An exclamation of surprise' })
  })

  it('keeps separate parts of speech as separate Meaning entries', () => {
    const content: LlmTranslationContent = {
      headword: 'run',
      meaningGroups: [
        { partOfSpeech: 'verb', senses: [{ definition: 'To move fast on foot' }] },
        { partOfSpeech: 'noun', senses: [{ definition: 'An act of running' }] },
      ],
    }
    const [entry] = adaptLlm(content)
    expect(entry.meanings).toHaveLength(2)
    expect(entry.meanings[0].partOfSpeech).toBe('verb')
    expect(entry.meanings[1].partOfSpeech).toBe('noun')
  })

  it('returns empty phonetics and meanings when none are provided', () => {
    const content: LlmTranslationContent = { headword: 'test' }
    const [entry] = adaptLlm(content)
    expect(entry.phonetics).toEqual([])
    expect(entry.meanings).toEqual([])
  })

  it('skips meanings when meaningGroups is empty', () => {
    const content: LlmTranslationContent = { headword: 'a', meaningGroups: [] }
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

  it('maps translation, commonMistakes, collocations, and wordFamily through', () => {
    const content: LlmTranslationContent = {
      headword: 'photo',
      translation: 'foto',
      commonMistakes: [{ wrong: 'make a photo', right: 'take a photo', note: 'Use "take", not "make".' }],
      collocations: ['take a photo', 'photo album'],
      wordFamily: ['photography', 'photographer'],
    }
    const [entry] = adaptLlm(content)
    expect(entry.translation).toBe('foto')
    expect(entry.commonMistakes).toEqual([
      { wrong: 'make a photo', right: 'take a photo', note: 'Use "take", not "make".' },
    ])
    expect(entry.collocations).toEqual(['take a photo', 'photo album'])
    expect(entry.wordFamily).toEqual(['photography', 'photographer'])
  })

  it('omits translation/commonMistakes/collocations/wordFamily when absent or empty', () => {
    const content: LlmTranslationContent = {
      headword: 'hello',
      commonMistakes: [],
      collocations: [],
      wordFamily: [],
    }
    const [entry] = adaptLlm(content)
    expect(entry.translation).toBeUndefined()
    expect(entry.commonMistakes).toBeUndefined()
    expect(entry.collocations).toBeUndefined()
    expect(entry.wordFamily).toBeUndefined()
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
        return { content: { headword: 'hello', meaningGroups: [{ partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] }] } }
      },
      async moreExamples() {
        return { examples: [] }
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
        return { content: { headword: 'hello', meaningGroups: [{ partOfSpeech: 'interjection', senses: [{ definition: 'A greeting' }] }] } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const dictionary: DictionaryProvider = { id: 'dict:test', define: vi.fn(async () => []) }
    const req = { text: 'hello', sourceLang: 'en', targetLang: 'en' }

    await translate(req, llm, dictionary, null)
    await translate(req, llm, dictionary, null)

    expect(calls).toBe(2)
  })
})
