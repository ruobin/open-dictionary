import { describe, expect, it } from 'vitest'
import { normalizeFavorite } from './favorites'

describe('normalizeFavorite', () => {
  it('parses a valid favorite — trimming and lowercasing', () => {
    const result = normalizeFavorite({ word: ' Hello ', sourceLang: 'EN', targetLang: '  es ' })
    expect(result).toEqual({ word: 'hello', sourceLang: 'en', targetLang: 'es' })
  })

  it('returns null for non‑object input', () => {
    expect(normalizeFavorite(null)).toBeNull()
    expect(normalizeFavorite('string')).toBeNull()
    expect(normalizeFavorite(undefined)).toBeNull()
  })

  it('returns null when word is empty after trim', () => {
    expect(normalizeFavorite({ word: '   ', sourceLang: 'en', targetLang: 'es' })).toBeNull()
  })

  it('returns null when sourceLang is missing', () => {
    expect(normalizeFavorite({ word: 'hi', sourceLang: '', targetLang: 'es' })).toBeNull()
  })

  it('returns null when targetLang is missing', () => {
    expect(normalizeFavorite({ word: 'hi', sourceLang: 'en', targetLang: '' })).toBeNull()
  })

  it('returns null for words exceeding max length (256)', () => {
    const long = 'x'.repeat(257)
    expect(normalizeFavorite({ word: long, sourceLang: 'en', targetLang: 'es' })).toBeNull()
  })

  it('accepts a word of exactly 256 chars', () => {
    const ok = 'x'.repeat(256)
    expect(normalizeFavorite({ word: ok, sourceLang: 'en', targetLang: 'es' })).not.toBeNull()
  })
})
