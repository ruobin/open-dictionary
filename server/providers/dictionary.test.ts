import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanMwHeadword, createDictionaryProvider, MERRIAM_WEBSTER_SOURCE, parseEntry } from './dictionary'

describe('Merriam-Webster headword normalization', () => {
  it('strips syllable markers and the terminal homograph suffix', () => {
    expect(cleanMwHeadword('cull:1')).toBe('cull')
    expect(cleanMwHeadword('hel*lo')).toBe('hello')
    expect(cleanMwHeadword('cull*:2')).toBe('cull')
    expect(cleanMwHeadword('ice*cream')).toBe('icecream')
    expect(cleanMwHeadword(undefined)).toBe('')
  })

  it('only strips a terminal :digits (keeps interior colons)', () => {
    expect(cleanMwHeadword('a:1b')).toBe('a:1b')
    expect(cleanMwHeadword('cull:x')).toBe('cull:x')
  })

  it('prefers hwi.hw over meta.id', () => {
    const entry = parseEntry({ meta: { id: 'cull:1' }, hwi: { hw: 'cull' }, fl: 'verb', shortdef: ['to select'] })
    expect(entry?.word).toBe('cull')
    expect(parseEntry({ meta: { id: 'hello' }, hwi: { hw: 'hel*lo' } })?.word).toBe('hello')
  })

  it('falls back to the cleaned meta.id when hwi.hw is missing or empty', () => {
    expect(parseEntry({ meta: { id: 'cull:1' }, fl: 'verb' })?.word).toBe('cull')
    expect(parseEntry({ meta: { id: 'cull:2' }, hwi: { hw: '' } })?.word).toBe('cull')
  })

  it('skips entries with no usable headword', () => {
    expect(parseEntry({ fl: 'verb' })).toBeNull()
    expect(parseEntry({ meta: { id: '*:1' } })).toBeNull()
  })
})

describe('dictionary entry attribution metadata', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stamps Merriam-Webster as dictionarySource on parsed entries', () => {
    const entry = parseEntry({ meta: { id: 'cull:1' }, hwi: { hw: 'cull' }, shortdef: ['to select'] })
    expect(entry?.dictionarySource).toEqual({ name: 'Merriam-Webster', url: 'https://www.merriam-webster.com/' })
    expect(entry?.dictionarySource).not.toBe(MERRIAM_WEBSTER_SOURCE)
  })

  it('define() returns clean headwords with dictionarySource and no translation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { meta: { id: 'cull:1' }, hwi: { hw: 'cull' }, fl: 'verb', shortdef: ['to select from a group'] },
            { meta: { id: 'cull:2' }, hwi: { hw: 'cull' }, fl: 'noun', shortdef: ['something culled'] },
          ]),
          { status: 200 }
        )
      )
    )
    const entries = (await createDictionaryProvider({ apiKey: 'k' }).define({ text: 'cull', sourceLang: 'en' })) as Array<
      Record<string, unknown>
    >
    expect(entries.map((e) => e.word)).toEqual(['cull', 'cull'])
    for (const e of entries) {
      expect(e.dictionarySource).toEqual(MERRIAM_WEBSTER_SOURCE)
      expect(e).not.toHaveProperty('translation')
      expect(e).not.toHaveProperty('generatedBy')
    }
  })
})
