import { describe, expect, it } from 'vitest'
import { isEligible, isWordOfDayTerm, wordOfDayCandidates } from './wordOfDay'
import type { TranslationDoc } from './cache/translationCache'

function makeDoc(overrides: Partial<TranslationDoc['entries'][0]> = {}, word = 'hello'): TranslationDoc {
  return {
    _id: 'x',
    word,
    sourceLang: 'en',
    targetLang: 'en',
    source: 'llm',
    version: 'v3',
    fetchedAt: new Date(),
    schemaVersion: 1,
    entries: [
      {
        word,
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

describe('isWordOfDayTerm — the home page only features a single word', () => {
  it('accepts single words, including hyphenated, apostrophised and accented ones', () => {
    for (const term of ['serendipity', 'well-being', "o'clock", 'café', 'naïve']) expect(isWordOfDayTerm(term), term).toBe(true)
  })

  it('rejects phrases, digits, abbreviations and other scripts', () => {
    for (const term of ['heavy rain', 'catch-22', 'e.g.', 'r&d', '一石二鳥', 'привет', '-ness', ''])
      expect(isWordOfDayTerm(term), term).toBe(false)
  })

  it('is part of eligibility: the cache term decides, not the headword', () => {
    expect(isEligible(makeDoc({}, 'a herd of plains zebras'))).toBe(false)
    expect(isEligible(makeDoc({ word: 'hello' }, 'some pasted sentence'))).toBe(false)
  })
})

describe('wordOfDayCandidates', () => {
  it('keeps eligible words and drops any with an open report', () => {
    const docs = [makeDoc({}, 'serendipity'), makeDoc({}, 'ephemeral'), makeDoc({}, 'heavy rain'), makeDoc({ meanings: [] }, 'hollow')]
    expect(wordOfDayCandidates(docs, [])).toEqual(['serendipity', 'ephemeral'])
    expect(wordOfDayCandidates(docs, ['ephemeral'])).toEqual(['serendipity'])
  })
})
