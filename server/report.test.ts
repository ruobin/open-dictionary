import { describe, expect, it } from 'vitest'
import { normalizeReport } from './report'

describe('normalizeReport', () => {
  it('parses a valid report with a reason', () => {
    const result = normalizeReport({
      word: ' Serendipity ',
      sourceLang: 'EN',
      targetLang: 'es',
      reason: '  Definition is wrong  ',
    })
    expect(result).toEqual({
      word: 'serendipity',
      sourceLang: 'en',
      targetLang: 'es',
      reason: 'Definition is wrong',
    })
  })

  it('parses a valid report without a reason', () => {
    const result = normalizeReport({ word: 'hello', sourceLang: 'en', targetLang: 'en' })
    expect(result).toEqual({ word: 'hello', sourceLang: 'en', targetLang: 'en' })
  })

  it('returns null for non-object input', () => {
    expect(normalizeReport(null)).toBeNull()
    expect(normalizeReport('string')).toBeNull()
    expect(normalizeReport(undefined)).toBeNull()
  })

  it('returns null when word is empty', () => {
    expect(normalizeReport({ word: '   ', sourceLang: 'en', targetLang: 'en' })).toBeNull()
  })

  it('returns null for words exceeding max length (256)', () => {
    const long = 'x'.repeat(257)
    expect(normalizeReport({ word: long, sourceLang: 'en', targetLang: 'en' })).toBeNull()
  })

  it('returns null for an unsupported language code', () => {
    expect(normalizeReport({ word: 'hi', sourceLang: 'xx', targetLang: 'en' })).toBeNull()
    expect(normalizeReport({ word: 'hi', sourceLang: 'en', targetLang: 'xx' })).toBeNull()
  })

  it('truncates an overly long reason to 500 chars', () => {
    const long = 'y'.repeat(600)
    const result = normalizeReport({ word: 'hi', sourceLang: 'en', targetLang: 'en', reason: long })
    expect(result?.reason).toHaveLength(500)
  })

  it('omits an empty/whitespace-only reason', () => {
    const result = normalizeReport({ word: 'hi', sourceLang: 'en', targetLang: 'en', reason: '   ' })
    expect(result?.reason).toBeUndefined()
  })
})
