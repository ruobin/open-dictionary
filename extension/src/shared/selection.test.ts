import { describe, expect, it } from 'vitest'
import { isLookupableSelection, normalizeSelectionText, MAX_SELECTION_LENGTH } from './selection'

describe('normalizeSelectionText', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeSelectionText('  serendipity  ')).toBe('serendipity')
  })

  it('does not lowercase or collapse internal whitespace (server\u2019s job)', () => {
    expect(normalizeSelectionText('  Hello   World  ')).toBe('Hello   World')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeSelectionText('   \n\t  ')).toBe('')
  })
})

describe('isLookupableSelection', () => {
  it('rejects an empty selection', () => {
    expect(isLookupableSelection('')).toBe(false)
  })

  it('accepts a normal word/phrase selection', () => {
    expect(isLookupableSelection('serendipity')).toBe(true)
    expect(isLookupableSelection('a short phrase')).toBe(true)
  })

  it('accepts a selection exactly at the max length', () => {
    expect(isLookupableSelection('x'.repeat(MAX_SELECTION_LENGTH))).toBe(true)
  })

  it('rejects a selection over the max length', () => {
    expect(isLookupableSelection('x'.repeat(MAX_SELECTION_LENGTH + 1))).toBe(false)
  })
})
