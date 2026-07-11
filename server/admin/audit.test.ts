import { describe, expect, it } from 'vitest'
import { parseAuditQuery, redactDiff, rotatedKeyNote } from './audit'

describe('admin/audit: rotatedKeyNote', () => {
  it('formats the sanctioned rotation note', () => {
    expect(rotatedKeyNote('9f3a')).toBe('(rotated, last4=9f3a)')
  })
})

describe('admin/audit: redactDiff', () => {
  it('passes through non-sensitive fields untouched', () => {
    expect(redactDiff({ name: { before: 'A', after: 'B' }, enabled: { before: true, after: false } })).toEqual({
      name: { before: 'A', after: 'B' },
      enabled: { before: true, after: false },
    })
  })

  it('replaces a raw apiKey string with a generic redaction marker', () => {
    expect(redactDiff({ apiKey: 'sk-live-abcdef123456' })).toEqual({ apiKey: '(redacted)' })
  })

  it('leaves the sanctioned "(rotated, last4=…)" note untouched', () => {
    expect(redactDiff({ apiKey: '(rotated, last4=9f3a)' })).toEqual({ apiKey: '(rotated, last4=9f3a)' })
  })

  it('passes through an already-masked secret shape ({set, last4})', () => {
    expect(redactDiff({ apiKey: { set: true, last4: '9f3a' } })).toEqual({ apiKey: { set: true, last4: '9f3a' } })
  })

  it('redacts sensitive keys nested inside before/after pairs', () => {
    expect(redactDiff({ apiKey: { before: 'sk-old-999999', after: 'sk-new-888888' } })).toEqual({
      apiKey: { before: '(redacted)', after: '(redacted)' },
    })
  })

  it('redacts secret/token/password-named fields too, case-insensitively', () => {
    expect(redactDiff({ Secret: 'shh', authToken: 'tok_123', PASSWORD: 'hunter2' })).toEqual({
      Secret: '(redacted)',
      authToken: '(redacted)',
      PASSWORD: '(redacted)',
    })
  })

  it('recurses into arrays', () => {
    expect(redactDiff({ headers: [{ apiKey: 'leak-me' }, { other: 'kept' }] })).toEqual({
      headers: [{ apiKey: '(redacted)' }, { other: 'kept' }],
    })
  })

  it('passes through null and primitive diffs unchanged', () => {
    expect(redactDiff(null)).toBeNull()
    expect(redactDiff('plain string')).toBe('plain string')
    expect(redactDiff(42)).toBe(42)
  })
})

describe('admin/audit: parseAuditQuery', () => {
  it('returns an empty options object for an empty query', () => {
    expect(parseAuditQuery({})).toEqual({})
  })

  it('parses a valid limit', () => {
    expect(parseAuditQuery({ limit: '25' })).toEqual({ limit: 25 })
  })

  it('floors a fractional limit', () => {
    expect(parseAuditQuery({ limit: '25.9' })).toEqual({ limit: 25 })
  })

  it('ignores a non-numeric, zero, or negative limit', () => {
    expect(parseAuditQuery({ limit: 'abc' })).toEqual({})
    expect(parseAuditQuery({ limit: '0' })).toEqual({})
    expect(parseAuditQuery({ limit: '-5' })).toEqual({})
  })

  it('parses a valid ISO "before" timestamp', () => {
    const result = parseAuditQuery({ before: '2026-01-01T00:00:00.000Z' })
    expect(result.before).toBeInstanceOf(Date)
    expect(result.before?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('ignores an unparseable "before" value', () => {
    expect(parseAuditQuery({ before: 'not-a-date' })).toEqual({})
  })

  it('ignores non-string query values', () => {
    expect(parseAuditQuery({ limit: 25, before: new Date() })).toEqual({})
  })
})
