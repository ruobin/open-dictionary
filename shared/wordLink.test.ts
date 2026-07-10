import { describe, expect, it } from 'vitest'
import { cleanLinkTerm, wordHref } from './wordLink'

describe('cleanLinkTerm', () => {
  it('strips a trailing parenthetical annotation', () => {
    expect(cleanLinkTerm('runner (noun)')).toBe('runner')
    expect(cleanLinkTerm('rerun (verb, noun)')).toBe('rerun')
  })

  it('leaves a bare term unchanged', () => {
    expect(cleanLinkTerm('heavy rain')).toBe('heavy rain')
  })

  it('does not strip a parenthetical in the middle of the phrase', () => {
    expect(cleanLinkTerm('run out of (time, money) fast')).toBe('run out of (time, money) fast')
  })
})

describe('wordHref', () => {
  it('builds a /word/:term link, lowercased and percent-encoded', () => {
    expect(wordHref('Heavy Rain')).toBe('/word/heavy%20rain')
  })

  it('cleans a trailing annotation before building the href', () => {
    expect(wordHref('runner (noun)')).toBe('/word/runner')
  })
})
