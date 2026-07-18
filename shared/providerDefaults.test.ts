import { describe, expect, it } from 'vitest'
import { DEFAULT_OPENROUTER_TITLE, defaultHeadersForVendor } from './providerDefaults'

describe('defaultHeadersForVendor', () => {
  it('returns X-Title + HTTP-Referer for openrouter when an origin is given', () => {
    expect(defaultHeadersForVendor('openrouter', 'https://dict.ai-dictionary.org')).toEqual([
      { name: 'X-Title', value: DEFAULT_OPENROUTER_TITLE },
      { name: 'HTTP-Referer', value: 'https://dict.ai-dictionary.org' },
    ])
  })

  it('omits HTTP-Referer for openrouter when no origin is given', () => {
    expect(defaultHeadersForVendor('openrouter', '')).toEqual([
      { name: 'X-Title', value: DEFAULT_OPENROUTER_TITLE },
    ])
  })

  it('returns no defaults for vendors without recommended attribution headers', () => {
    expect(defaultHeadersForVendor('deepseek', 'https://dict.ai-dictionary.org')).toEqual([])
    expect(defaultHeadersForVendor('glm', 'https://dict.ai-dictionary.org')).toEqual([])
    expect(defaultHeadersForVendor('openai-compat', 'https://dict.ai-dictionary.org')).toEqual([])
  })

  it('is case-sensitive on the vendor slug (only exact "openrouter" matches)', () => {
    expect(defaultHeadersForVendor('OpenRouter', 'https://x.com')).toEqual([])
  })
})
