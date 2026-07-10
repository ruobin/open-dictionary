import { describe, expect, it } from 'vitest'
import { normalizeRequest } from './moreExamples'

describe('normalizeRequest', () => {
  it('parses a minimal valid request, defaulting langs to en', () => {
    expect(normalizeRequest({ word: 'Run', definition: 'to move fast' })).toEqual({
      word: 'run',
      sourceLang: 'en',
      targetLang: 'en',
      senseDefinition: 'to move fast',
    })
  })

  it('parses topic and a valid cefr level', () => {
    expect(
      normalizeRequest({ word: 'run', definition: 'to move fast', topic: 'football', cefr: 'b1' })
    ).toEqual({
      word: 'run',
      sourceLang: 'en',
      targetLang: 'en',
      senseDefinition: 'to move fast',
      topic: 'football',
      cefr: 'B1',
    })
  })

  it('drops an invalid cefr level rather than rejecting the whole request', () => {
    const result = normalizeRequest({ word: 'run', definition: 'to move fast', cefr: 'Z9' })
    expect(result?.cefr).toBeUndefined()
  })

  it('returns null when word is empty', () => {
    expect(normalizeRequest({ word: '   ', definition: 'x' })).toBeNull()
  })

  it('returns null when definition is missing', () => {
    expect(normalizeRequest({ word: 'run' })).toBeNull()
  })

  it('returns null for an unsupported language code', () => {
    expect(normalizeRequest({ word: 'run', definition: 'x', from: 'xx' })).toBeNull()
  })

  it('truncates an overly long definition and topic', () => {
    const longDef = 'x'.repeat(600)
    const longTopic = 'y'.repeat(200)
    const result = normalizeRequest({ word: 'run', definition: longDef, topic: longTopic })
    expect(result?.senseDefinition.length).toBe(500)
    expect(result?.topic?.length).toBe(100)
  })
})
