import { describe, expect, it } from 'vitest'
import { isEligible } from './wordOfDay'
import type { TranslationDoc } from './cache/translationCache'

function makeDoc(overrides: Partial<TranslationDoc['entries'][0]> = {}): TranslationDoc {
  return {
    _id: 'x',
    word: 'hello',
    sourceLang: 'en',
    targetLang: 'en',
    source: 'llm',
    version: 'v3',
    fetchedAt: new Date(),
    schemaVersion: 1,
    entries: [
      {
        word: 'hello',
        phonetics: [],
        meanings: [{ partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting' }] }],
        ...overrides,
      },
    ],
  }
}

describe('isEligible', () => {
  it('accepts a normal entry with meanings', () => {
    expect(isEligible(makeDoc())).toBe(true)
  })

  it('rejects a typo-only entry', () => {
    expect(isEligible(makeDoc({ typo: { suggestion: 'hello' }, meanings: [] }))).toBe(false)
  })

  it('rejects an entry with no meanings', () => {
    expect(isEligible(makeDoc({ meanings: [] }))).toBe(false)
  })

  it('rejects a doc with no entries at all', () => {
    const doc = makeDoc()
    doc.entries = []
    expect(isEligible(doc)).toBe(false)
  })
})
