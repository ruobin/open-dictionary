import { describe, expect, it, vi } from 'vitest'
import type { Collection } from 'mongodb'
import { buildEntryCreator, uaForStorage } from './activityLog'
import { parseEntriesQuery, toEntrySummaries } from './admin/entries'
import { createTranslationCache, type TranslationDoc } from './cache/translationCache'

// "Added by" on the admin Entries page: who caused a cache entry to be generated.

const GPTBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)'

describe('buildEntryCreator', () => {
  it('records ip, truncated UA, parsed device and channel', () => {
    const at = new Date('2026-10-30T00:00:00Z')
    expect(buildEntryCreator({ ip: '74.7.227.41', userAgent: GPTBOT_UA }, at)).toEqual({
      ip: '74.7.227.41',
      ua: GPTBOT_UA,
      device: { type: 'bot' },
      channel: 'web',
      at,
    })
    const long = buildEntryCreator({ ip: '1.1.1.1', userAgent: 'crawler/' + 'x'.repeat(1000) })
    expect(long.ua).toHaveLength(300)
  })

  it('never stores a human browser UA (privacy.activityP1), only the parsed summary', () => {
    const c = buildEntryCreator({
      ip: '1.1.1.1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    })
    expect(c.ua).toBeUndefined()
    expect(c.device).toEqual({ type: 'desktop', browser: 'Chrome', os: 'macOS' })
  })

  it('omits ua when missing and tags extension traffic', () => {
    const c = buildEntryCreator({ ip: '1.1.1.1', origin: 'chrome-extension://abc' })
    expect(c.ua).toBeUndefined()
    expect(c.device).toEqual({ type: 'unknown' })
    expect(c.channel).toBe('extension')
  })
})

describe('parseEntriesQuery ip filter', () => {
  it('accepts IPv4/IPv6 and rejects anything else', () => {
    expect(parseEntriesQuery({ ip: ' 74.7.227.41 ' }).ip).toBe('74.7.227.41')
    expect(parseEntriesQuery({ ip: '2001:db8::1' }).ip).toBe('2001:db8::1')
    expect(parseEntriesQuery({ ip: '{"$ne":1}' }).ip).toBeUndefined()
    expect(parseEntriesQuery({ ip: ['1.1.1.1'] }).ip).toBeUndefined()
    expect(parseEntriesQuery({}).ip).toBeUndefined()
  })
})

describe('toEntrySummaries createdBy', () => {
  const doc = {
    _id: 'abc',
    word: 'hello',
    sourceLang: 'en',
    targetLang: 'en',
    source: 'llm',
    version: 'v3',
    fetchedAt: new Date('2026-10-30T00:00:00Z'),
    entries: [],
  }

  it('serialises createdBy, keeping the inferred marker', () => {
    const [s] = toEntrySummaries(
      [{ ...doc, createdBy: { ip: '1.2.3.4', device: { type: 'desktop' }, channel: 'web', at: new Date('2026-10-29T00:00:00Z'), inferred: true } }],
      new Map()
    )
    expect(s.createdBy).toEqual({ ip: '1.2.3.4', device: { type: 'desktop' }, channel: 'web', at: '2026-10-29T00:00:00.000Z', inferred: true })
  })

  it('leaves createdBy off for old entries', () => {
    const [s] = toEntrySummaries([doc], new Map())
    expect(s).not.toHaveProperty('createdBy')
  })
})

describe('translationCache.set createdBy', () => {
  it('writes createdBy only on insert, so rewrites keep the original creator', async () => {
    const updateOne = vi.fn().mockResolvedValue({})
    const cache = createTranslationCache({ updateOne } as unknown as Collection<TranslationDoc>)
    const creator = buildEntryCreator({ ip: '1.2.3.4' })
    await cache.set('hello', 'en', 'en', [], 'llm', 'v3', creator)
    const update = updateOne.mock.calls[0][1]
    expect(update.$setOnInsert.createdBy).toBe(creator)
    expect(update.$set).not.toHaveProperty('createdBy')

    await cache.set('hello', 'en', 'en', [], 'llm', 'v3')
    expect(updateOne.mock.calls[1][1].$setOnInsert).toEqual({ schemaVersion: 1 })
  })
})

describe('uaForStorage', () => {
  it('keeps the raw UA for bots only', () => {
    expect(uaForStorage(GPTBOT_UA, 'bot')).toBe(GPTBOT_UA)
    expect(uaForStorage('Mozilla/5.0 Chrome/156', 'desktop')).toBeUndefined()
    expect(uaForStorage(undefined, 'bot')).toBeUndefined()
  })
})
