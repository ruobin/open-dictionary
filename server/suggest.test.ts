import { describe, expect, it } from 'vitest'
import { escapeRegex, pickSuggestions } from './suggest'

describe('escapeRegex', () => {
  it('escapes regex metacharacters so user input cannot break out of the prefix pattern', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c')
    expect(escapeRegex('(x|y)')).toBe('\\(x\\|y\\)')
    expect(escapeRegex('[abc]$')).toBe('\\[abc\\]\\$')
  })

  it('leaves plain alphanumeric input unchanged', () => {
    expect(escapeRegex('hello')).toBe('hello')
  })
})

describe('pickSuggestions', () => {
  it('orders shortest first, then alphabetically, and caps at 8', () => {
    const words = ['serendipity', 'serve', 'sera', 'serum', 'serf', 'serial', 'series', 'serious', 'sermon', 'serpent']
    expect(pickSuggestions(words)).toEqual(['sera', 'serf', 'serum', 'serve', 'serial', 'series', 'sermon', 'serious'])
  })

  it('never suggests text that is not a headword or short phrase', () => {
    // Everything anyone looked up is in the cache; a prefix search must not
    // hand one visitor's pasted text to the next.
    const words = [
      'sam',
      'sam.lee@example.com',
      'sam lives at 1200 example street apartment 4',
      'same time tomorrow at the usual place and bring the documents with you',
      'same',
    ]
    expect(pickSuggestions(words)).toEqual(['sam', 'same'])
  })
})
