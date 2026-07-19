import { describe, expect, it } from 'vitest'
import { normalizeActivityPing } from './activityPing'

describe('normalizeActivityPing', () => {
  it('parses a valid ping body', () => {
    expect(normalizeActivityPing({ word: '  Hello  ', sourceLang: 'EN', targetLang: 'es' })).toEqual({
      word: 'hello',
      sourceLang: 'en',
      targetLang: 'es',
    })
  })

  it('returns null for non-object input', () => {
    expect(normalizeActivityPing(null)).toBeNull()
    expect(normalizeActivityPing('x')).toBeNull()
    expect(normalizeActivityPing(undefined)).toBeNull()
  })

  it('returns null when word is empty/whitespace', () => {
    expect(normalizeActivityPing({ word: '   ', sourceLang: 'en', targetLang: 'en' })).toBeNull()
  })

  it('returns null for unsupported language codes', () => {
    expect(normalizeActivityPing({ word: 'hi', sourceLang: 'xx', targetLang: 'en' })).toBeNull()
    expect(normalizeActivityPing({ word: 'hi', sourceLang: 'en', targetLang: 'xx' })).toBeNull()
  })

  it('returns null when langs are missing', () => {
    expect(normalizeActivityPing({ word: 'hi' })).toBeNull()
  })
})
