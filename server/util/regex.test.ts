import { describe, expect, it } from 'vitest'
import { escapeRegex } from './regex'

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
