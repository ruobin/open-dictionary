import { describe, expect, it } from 'vitest'
import { languageName } from './languages'

describe('languageName', () => {
  it('returns the full name for a known code', () => {
    expect(languageName('en')).toBe('English')
    expect(languageName('es')).toBe('Spanish')
    expect(languageName('zh')).toBe('Chinese')
  })

  it('is case-insensitive', () => {
    expect(languageName('EN')).toBe('English')
    expect(languageName('Es')).toBe('Spanish')
  })

  it('falls back to the raw code for an unknown language', () => {
    expect(languageName('zz')).toBe('zz')
  })

  it('returns empty for an empty string', () => {
    expect(languageName('')).toBe('')
  })
})
