import { describe, expect, it } from 'vitest'
import {
  parseEntriesQuery,
  isValidEntryId,
  groupReportsByEntry,
  toEntrySummaries,
  sortEntrySummaries,
  validateBatchIds,
  MAX_BATCH_DELETE,
  isValidReportId,
  parseReportsQuery,
  type EntrySummaryView,
} from './entries'

describe('admin/entries: parseEntriesQuery', () => {
  it('returns sensible defaults for an empty query', () => {
    expect(parseEntriesQuery({})).toEqual({
      word: undefined,
      sourceLang: undefined,
      targetLang: undefined,
      tier: undefined,
      hasReports: undefined,
      sort: 'newest',
      limit: 25,
      before: undefined,
    })
  })

  it('trims and lowercases word, truncating to 256 chars', () => {
    const result = parseEntriesQuery({ word: '  Hello  ' })
    expect(result.word).toBe('hello')
  })

  it('ignores an empty/whitespace-only word', () => {
    expect(parseEntriesQuery({ word: '   ' }).word).toBeUndefined()
  })

  it('accepts a known sourceLang/targetLang, ignoring unknown codes', () => {
    expect(parseEntriesQuery({ sourceLang: 'EN', targetLang: 'es' })).toMatchObject({
      sourceLang: 'en',
      targetLang: 'es',
    })
    expect(parseEntriesQuery({ sourceLang: 'xx' }).sourceLang).toBeUndefined()
  })

  it('accepts tier "llm" or "dict", ignoring anything else', () => {
    expect(parseEntriesQuery({ tier: 'llm' }).tier).toBe('llm')
    expect(parseEntriesQuery({ tier: 'dict' }).tier).toBe('dict')
    expect(parseEntriesQuery({ tier: 'bogus' }).tier).toBeUndefined()
  })

  it('parses hasReports as a strict boolean string', () => {
    expect(parseEntriesQuery({ hasReports: 'true' }).hasReports).toBe(true)
    expect(parseEntriesQuery({ hasReports: 'false' }).hasReports).toBe(false)
    expect(parseEntriesQuery({ hasReports: 'yes' }).hasReports).toBeUndefined()
  })

  it('defaults sort to mostReported when hasReports=true and no explicit sort given', () => {
    expect(parseEntriesQuery({ hasReports: 'true' }).sort).toBe('mostReported')
  })

  it('defaults sort to newest when hasReports is false or absent', () => {
    expect(parseEntriesQuery({ hasReports: 'false' }).sort).toBe('newest')
    expect(parseEntriesQuery({}).sort).toBe('newest')
  })

  it('honors an explicit sort regardless of hasReports', () => {
    expect(parseEntriesQuery({ hasReports: 'true', sort: 'oldest' }).sort).toBe('oldest')
    expect(parseEntriesQuery({ sort: 'mostReported' }).sort).toBe('mostReported')
  })

  it('ignores an invalid sort value', () => {
    expect(parseEntriesQuery({ sort: 'bogus' }).sort).toBe('newest')
  })

  it('clamps limit to the 1-100 range, flooring fractional values', () => {
    expect(parseEntriesQuery({ limit: '10' }).limit).toBe(10)
    expect(parseEntriesQuery({ limit: '10.9' }).limit).toBe(10)
    expect(parseEntriesQuery({ limit: '500' }).limit).toBe(100)
  })

  it('ignores a non-numeric, zero, or negative limit, falling back to the default', () => {
    expect(parseEntriesQuery({ limit: 'abc' }).limit).toBe(25)
    expect(parseEntriesQuery({ limit: '0' }).limit).toBe(25)
    expect(parseEntriesQuery({ limit: '-5' }).limit).toBe(25)
  })

  it('parses a valid ISO "before" timestamp, ignoring an unparseable one', () => {
    const result = parseEntriesQuery({ before: '2026-01-01T00:00:00.000Z' })
    expect(result.before?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseEntriesQuery({ before: 'not-a-date' }).before).toBeUndefined()
  })

  it('ignores non-string query values entirely', () => {
    expect(parseEntriesQuery({ limit: 25, hasReports: true, before: new Date() })).toMatchObject({
      limit: 25,
      hasReports: undefined,
      before: undefined,
    })
  })
})

describe('admin/entries: isValidEntryId', () => {
  it('accepts a 40-char lowercase hex sha1 digest', () => {
    expect(isValidEntryId('e949e4d586c2b95445b231abaac0e49273d53669'.padStart(40, '0'))).toBe(true)
    expect(isValidEntryId('a'.repeat(40))).toBe(true)
  })

  it('rejects the wrong length', () => {
    expect(isValidEntryId('abc')).toBe(false)
    expect(isValidEntryId('a'.repeat(41))).toBe(false)
  })

  it('rejects uppercase or non-hex characters', () => {
    expect(isValidEntryId('A'.repeat(40))).toBe(false)
    expect(isValidEntryId('g'.repeat(40))).toBe(false)
  })

  it('rejects a Mongo ObjectId-shaped value (wrong collection`s id shape)', () => {
    expect(isValidEntryId('507f1f77bcf86cd799439011')).toBe(false)
  })

  it('rejects an injection attempt disguised as an id', () => {
    expect(isValidEntryId('{"$ne": null}')).toBe(false)
  })
})

describe('admin/entries: groupReportsByEntry', () => {
  it('groups reports by (sourceLang, targetLang, word), counting and taking the latest createdAt', () => {
    const groups = groupReportsByEntry([
      { word: 'model', sourceLang: 'en', targetLang: 'en', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { word: 'model', sourceLang: 'en', targetLang: 'en', createdAt: new Date('2026-01-05T00:00:00.000Z') },
      { word: 'affordance', sourceLang: 'en', targetLang: 'tr', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    ])
    expect(groups.size).toBe(2)
    const model = groups.get('en|en|model')
    expect(model?.count).toBe(2)
    expect(model?.lastAt.toISOString()).toBe('2026-01-05T00:00:00.000Z')
    const affordance = groups.get('en|tr|affordance')
    expect(affordance?.count).toBe(1)
  })

  it('keeps identical words in different language pairs distinct', () => {
    const groups = groupReportsByEntry([
      { word: 'run', sourceLang: 'en', targetLang: 'en', createdAt: new Date() },
      { word: 'run', sourceLang: 'en', targetLang: 'es', createdAt: new Date() },
    ])
    expect(groups.size).toBe(2)
  })

  it('returns an empty map for no reports', () => {
    expect(groupReportsByEntry([]).size).toBe(0)
  })
})

describe('admin/entries: toEntrySummaries', () => {
  const baseDoc = {
    _id: 'abc123',
    word: 'hello',
    sourceLang: 'en',
    targetLang: 'en',
    source: 'llm',
    version: 'v3',
    fetchedAt: new Date('2026-07-01T00:00:00.000Z'),
    entries: [
      {
        word: 'hello',
        phonetics: [],
        meanings: [{ partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting' }] }],
      },
    ],
  }

  it('maps a translations doc to a summary view with reportCount 0 when unreported', () => {
    const [summary] = toEntrySummaries([baseDoc], new Map())
    expect(summary).toEqual({
      id: 'abc123',
      word: 'hello',
      sourceLang: 'en',
      targetLang: 'en',
      tier: 'llm',
      version: 'v3',
      fetchedAt: '2026-07-01T00:00:00.000Z',
      reportCount: 0,
      headwordPreview: 'A greeting',
    })
  })

  it('pulls reportCount from the matching report group', () => {
    const groups = groupReportsByEntry([
      { word: 'hello', sourceLang: 'en', targetLang: 'en', createdAt: new Date() },
      { word: 'hello', sourceLang: 'en', targetLang: 'en', createdAt: new Date() },
    ])
    const [summary] = toEntrySummaries([baseDoc], groups)
    expect(summary.reportCount).toBe(2)
  })

  it('omits headwordPreview when the doc has no meanings/definitions', () => {
    const doc = { ...baseDoc, entries: [{ word: 'hello', phonetics: [], meanings: [] }] }
    const [summary] = toEntrySummaries([doc], new Map())
    expect(summary.headwordPreview).toBeUndefined()
  })

  it('omits headwordPreview when entries is empty', () => {
    const doc = { ...baseDoc, entries: [] }
    const [summary] = toEntrySummaries([doc], new Map())
    expect(summary.headwordPreview).toBeUndefined()
  })
})

describe('admin/entries: sortEntrySummaries', () => {
  function summary(overrides: Partial<EntrySummaryView>): EntrySummaryView {
    return {
      id: overrides.id ?? 'x',
      word: overrides.word ?? 'x',
      sourceLang: 'en',
      targetLang: 'en',
      tier: 'llm',
      version: 'v3',
      fetchedAt: overrides.fetchedAt ?? '2026-01-01T00:00:00.000Z',
      reportCount: overrides.reportCount ?? 0,
      ...overrides,
    }
  }

  it('sorts newest-first by fetchedAt', () => {
    const entries = [
      summary({ id: 'a', fetchedAt: '2026-01-01T00:00:00.000Z' }),
      summary({ id: 'b', fetchedAt: '2026-01-03T00:00:00.000Z' }),
      summary({ id: 'c', fetchedAt: '2026-01-02T00:00:00.000Z' }),
    ]
    expect(sortEntrySummaries(entries, 'newest').map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts oldest-first by fetchedAt', () => {
    const entries = [
      summary({ id: 'a', fetchedAt: '2026-01-01T00:00:00.000Z' }),
      summary({ id: 'b', fetchedAt: '2026-01-03T00:00:00.000Z' }),
    ]
    expect(sortEntrySummaries(entries, 'oldest').map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('sorts mostReported-first by reportCount, breaking ties by newest fetchedAt', () => {
    const entries = [
      summary({ id: 'a', reportCount: 1, fetchedAt: '2026-01-01T00:00:00.000Z' }),
      summary({ id: 'b', reportCount: 3, fetchedAt: '2026-01-02T00:00:00.000Z' }),
      summary({ id: 'c', reportCount: 1, fetchedAt: '2026-01-05T00:00:00.000Z' }),
    ]
    expect(sortEntrySummaries(entries, 'mostReported').map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('does not mutate the input array', () => {
    const entries = [summary({ id: 'a', fetchedAt: '2026-01-01T00:00:00.000Z' }), summary({ id: 'b', fetchedAt: '2026-01-02T00:00:00.000Z' })]
    const copy = [...entries]
    sortEntrySummaries(entries, 'newest')
    expect(entries).toEqual(copy)
  })
})

describe('admin/entries: validateBatchIds', () => {
  it('accepts a valid array of string ids', () => {
    const result = validateBatchIds(['a', 'b', 'c'])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(['a', 'b', 'c'])
  })

  it('rejects a non-array', () => {
    expect(validateBatchIds('nope').ok).toBe(false)
    expect(validateBatchIds(null).ok).toBe(false)
  })

  it('rejects an empty array', () => {
    expect(validateBatchIds([]).ok).toBe(false)
  })

  it(`accepts exactly ${MAX_BATCH_DELETE} ids`, () => {
    const ids = Array.from({ length: MAX_BATCH_DELETE }, (_, i) => `id${i}`)
    expect(validateBatchIds(ids).ok).toBe(true)
  })

  it(`rejects more than ${MAX_BATCH_DELETE} ids`, () => {
    const ids = Array.from({ length: MAX_BATCH_DELETE + 1 }, (_, i) => `id${i}`)
    expect(validateBatchIds(ids).ok).toBe(false)
  })

  it('rejects an array containing a non-string element', () => {
    expect(validateBatchIds(['a', 5, 'c']).ok).toBe(false)
  })
})

describe('admin/entries: isValidReportId', () => {
  it('accepts a 24-char lowercase hex ObjectId', () => {
    expect(isValidReportId('6a5157bcf60a4c221235711a')).toBe(true)
  })

  it('rejects the wrong length', () => {
    expect(isValidReportId('abc')).toBe(false)
    expect(isValidReportId('a'.repeat(40))).toBe(false)
  })

  it('rejects uppercase or non-hex characters', () => {
    expect(isValidReportId('A'.repeat(24))).toBe(false)
    expect(isValidReportId('g'.repeat(24))).toBe(false)
  })
})

describe('admin/entries: parseReportsQuery', () => {
  it('defaults limit to 50 with no before cursor', () => {
    expect(parseReportsQuery({})).toEqual({ limit: 50, before: undefined })
  })

  it('clamps limit to the max of 200', () => {
    expect(parseReportsQuery({ limit: '500' }).limit).toBe(200)
  })

  it('ignores an invalid limit, falling back to the default', () => {
    expect(parseReportsQuery({ limit: 'abc' }).limit).toBe(50)
  })

  it('parses a valid ISO "before" timestamp, ignoring an unparseable one', () => {
    const result = parseReportsQuery({ before: '2026-01-01T00:00:00.000Z' })
    expect(result.before?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseReportsQuery({ before: 'not-a-date' }).before).toBeUndefined()
  })
})
