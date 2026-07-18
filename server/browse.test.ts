import { describe, expect, it } from 'vitest'
import { getBrowsePage } from './browse'
import type { TranslationDoc } from './cache/translationCache'

function makeDoc(word: string, overrides: Partial<TranslationDoc['entries'][0]> = {}): Pick<TranslationDoc, 'entries'> {
  return {
    entries: [
      {
        word,
        phonetics: [],
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'x' }] }],
        ...overrides,
      },
    ],
  }
}

describe('getBrowsePage', () => {
  it('returns null for an invalid letter param', async () => {
    expect(await getBrowsePage([], '1', 1)).toBeNull()
    expect(await getBrowsePage([], 'ab', 1)).toBeNull()
    expect(await getBrowsePage([], '', 1)).toBeNull()
  })

  it('accepts single letters a-z and the "other" bucket', async () => {
    expect(await getBrowsePage([], 'h', 1)).not.toBeNull()
    expect(await getBrowsePage([], 'other', 1)).not.toBeNull()
  })

  it('buckets words by first letter and sorts them alphabetically', async () => {
    const docs = [makeDoc('zebra'), makeDoc('apple'), makeDoc('avocado')]
    const result = await getBrowsePage(docs, 'a', 1)
    expect(result?.words).toEqual(['apple', 'avocado'])
    expect(result?.letters).toEqual(['a', 'z'])
  })

  it('excludes typo-only entries and entries with no meanings', async () => {
    const docs = [
      makeDoc('hello'),
      makeDoc('helo', { typo: { suggestion: 'hello' }, meanings: [] }),
      makeDoc('hollow', { meanings: [] }),
    ]
    const result = await getBrowsePage(docs, 'h', 1)
    expect(result?.words).toEqual(['hello'])
  })

  it('excludes unsafe words (path-separator characters)', async () => {
    const docs = [makeDoc('hello'), makeDoc('he/llo')]
    const result = await getBrowsePage(docs, 'h', 1)
    expect(result?.words).toEqual(['hello'])
  })

  it('paginates and clamps an out-of-range page to the last page', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => makeDoc(`word${i}`))
    const result = await getBrowsePage(docs, 'w', 1)
    expect(result?.totalPages).toBe(1)

    const clamped = await getBrowsePage(docs, 'w', 99)
    expect(clamped?.page).toBe(1)
    expect(clamped?.words).toHaveLength(5)
  })

  it('clamps a page below 1 up to page 1', async () => {
    const docs = [makeDoc('hello')]
    const result = await getBrowsePage(docs, 'h', 0)
    expect(result?.page).toBe(1)
  })

  it('returns an empty word list with totalPages=1 for a letter with no words', async () => {
    const docs = [makeDoc('apple')]
    const result = await getBrowsePage(docs, 'z', 1)
    expect(result?.words).toEqual([])
    expect(result?.totalPages).toBe(1)
    expect(result?.letters).toEqual(['a'])
  })
})
