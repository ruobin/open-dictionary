import { describe, expect, it } from 'vitest'
import { classifyChannel, parseActivityQuery, parseSummaryDays, zeroFillDailyCounts } from './activityLog'

describe('activityLog: classifyChannel', () => {
  it('classifies a chrome-extension:// origin as extension', () => {
    expect(classifyChannel('chrome-extension://abcdefghijklmnop')).toBe('extension')
  })

  it('classifies a normal web origin as web', () => {
    expect(classifyChannel('https://dict.ai-dictionary.org')).toBe('web')
  })

  it('classifies a missing origin as web', () => {
    expect(classifyChannel(undefined)).toBe('web')
  })

  it('classifies an arbitrary third-party origin as web (directional signal only)', () => {
    expect(classifyChannel('https://example.com')).toBe('web')
  })
})

describe('activityLog: parseActivityQuery', () => {
  it('returns sensible defaults for an empty query', () => {
    expect(parseActivityQuery({})).toEqual({
      word: undefined,
      tier: undefined,
      channel: undefined,
      deviceType: undefined,
      limit: 50,
      before: undefined,
    })
  })

  it('trims and lowercases word, truncating to 256 chars', () => {
    expect(parseActivityQuery({ word: '  Hello  ' }).word).toBe('hello')
    expect(parseActivityQuery({ word: '   ' }).word).toBeUndefined()
  })

  it('accepts a known tier, ignoring anything else', () => {
    expect(parseActivityQuery({ tier: 'cache' }).tier).toBe('cache')
    expect(parseActivityQuery({ tier: 'llm' }).tier).toBe('llm')
    expect(parseActivityQuery({ tier: 'dictionary' }).tier).toBe('dictionary')
    expect(parseActivityQuery({ tier: 'bogus' }).tier).toBeUndefined()
  })

  it('accepts a known channel, ignoring anything else', () => {
    expect(parseActivityQuery({ channel: 'web' }).channel).toBe('web')
    expect(parseActivityQuery({ channel: 'extension' }).channel).toBe('extension')
    expect(parseActivityQuery({ channel: 'bogus' }).channel).toBeUndefined()
  })

  it('accepts a known deviceType, ignoring anything else', () => {
    expect(parseActivityQuery({ deviceType: 'mobile' }).deviceType).toBe('mobile')
    expect(parseActivityQuery({ deviceType: 'bogus' }).deviceType).toBeUndefined()
  })

  it('clamps limit to the max and floors fractional values', () => {
    expect(parseActivityQuery({ limit: '500' }).limit).toBe(200)
    expect(parseActivityQuery({ limit: '10.9' }).limit).toBe(10)
  })

  it('ignores a non-numeric, zero, or negative limit', () => {
    expect(parseActivityQuery({ limit: 'abc' }).limit).toBe(50)
    expect(parseActivityQuery({ limit: '0' }).limit).toBe(50)
    expect(parseActivityQuery({ limit: '-5' }).limit).toBe(50)
  })

  it('parses a valid ISO "before" timestamp', () => {
    const result = parseActivityQuery({ before: '2026-01-01T00:00:00.000Z' })
    expect(result.before).toBeInstanceOf(Date)
    expect(result.before?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('ignores an unparseable "before" value', () => {
    expect(parseActivityQuery({ before: 'not-a-date' }).before).toBeUndefined()
  })
})

describe('activityLog: parseSummaryDays', () => {
  it('defaults to 7 when absent', () => {
    expect(parseSummaryDays({})).toBe(7)
  })

  it('parses a valid days value', () => {
    expect(parseSummaryDays({ days: '30' })).toBe(30)
  })

  it('clamps to the 90-day max', () => {
    expect(parseSummaryDays({ days: '365' })).toBe(90)
  })

  it('floors a fractional value', () => {
    expect(parseSummaryDays({ days: '14.7' })).toBe(14)
  })

  it('falls back to the default for non-numeric, zero, or negative values', () => {
    expect(parseSummaryDays({ days: 'abc' })).toBe(7)
    expect(parseSummaryDays({ days: '0' })).toBe(7)
    expect(parseSummaryDays({ days: '-5' })).toBe(7)
  })
})

describe('activityLog: zeroFillDailyCounts', () => {
  it('zero-fills every day in the window when no counts are given', () => {
    const now = new Date('2026-07-19T12:00:00.000Z')
    const result = zeroFillDailyCounts([], 3, now)
    expect(result).toEqual([
      { date: '2026-07-17', count: 0 },
      { date: '2026-07-18', count: 0 },
      { date: '2026-07-19', count: 0 },
    ])
  })

  it('fills in real counts where present, zero elsewhere', () => {
    const now = new Date('2026-07-19T12:00:00.000Z')
    const result = zeroFillDailyCounts([{ date: '2026-07-18', count: 5 }], 3, now)
    expect(result).toEqual([
      { date: '2026-07-17', count: 0 },
      { date: '2026-07-18', count: 5 },
      { date: '2026-07-19', count: 0 },
    ])
  })

  it('ignores counts for dates outside the window', () => {
    const now = new Date('2026-07-19T12:00:00.000Z')
    const result = zeroFillDailyCounts([{ date: '2026-01-01', count: 99 }], 2, now)
    expect(result).toEqual([
      { date: '2026-07-18', count: 0 },
      { date: '2026-07-19', count: 0 },
    ])
  })
})
