import { describe, expect, it } from 'vitest'
import { extractPartialContent, extractPartialExtras, parsePartialObject } from './streamJson'
import { parseContent } from './parse'

const FULL = JSON.stringify({
  headword: 'run',
  translation: '跑步',
  phonetic: '/rʌn/',
  meaningGroups: [
    {
      partOfSpeech: 'verb',
      senses: [
        {
          definition: 'to move quickly on foot',
          cefr: 'A1',
          examples: [{ text: 'I run every day. {not a brace}', cefr: 'A1' }],
        },
      ],
    },
    { partOfSpeech: 'noun', senses: [{ definition: 'an act of running, e.g. "a morning run"' }] },
  ],
})

describe('parsePartialObject', () => {
  it('returns null until an object starts', () => {
    expect(parsePartialObject('')).toBeNull()
    expect(parsePartialObject('Sure! Here is')).toBeNull()
  })

  it('never throws and, once it yields an object, always yields one for every prefix of a real answer', () => {
    let sawObject = false
    for (let i = 1; i <= FULL.length; i += 1) {
      const obj = parsePartialObject(FULL.slice(0, i))
      if (obj) sawObject = true
      else if (sawObject) throw new Error(`lost the object at prefix length ${i}: ${FULL.slice(0, i)}`)
    }
    expect(sawObject).toBe(true)
    expect(parsePartialObject(FULL)).toEqual(JSON.parse(FULL))
  })

  it('drops a dangling key, a dangling colon and a trailing comma', () => {
    expect(parsePartialObject('{"headword":"run","transl')).toEqual({ headword: 'run' })
    expect(parsePartialObject('{"headword":"run","translation"')).toEqual({ headword: 'run' })
    expect(parsePartialObject('{"headword":"run","translation":')).toEqual({ headword: 'run' })
    expect(parsePartialObject('{"headword":"run",')).toEqual({ headword: 'run' })
    expect(parsePartialObject('{"headword":"run" ,  ')).toEqual({ headword: 'run' })
  })

  it('drops a half-typed literal', () => {
    expect(parsePartialObject('{"headword":"run","ok":tr')).toEqual({ headword: 'run' })
    expect(parsePartialObject('{"headword":"run","n":12')).toEqual({ headword: 'run' })
  })

  it('keeps the half-written string value and closes everything around it', () => {
    expect(parsePartialObject('{"headword":"ru')).toEqual({ headword: 'ru' })
    expect(parsePartialObject('{"a":[{"b":[{"c":"deep val')).toEqual({ a: [{ b: [{ c: 'deep val' }] }] })
  })

  it('does not end on a lone backslash or a half-typed unicode escape', () => {
    expect(parsePartialObject('{"headword":"a\\')).toEqual({ headword: 'a' })
    expect(parsePartialObject('{"headword":"a\\u00')).toEqual({ headword: 'a' })
    expect(parsePartialObject('{"headword":"a\\u00e9')).toEqual({ headword: 'aé' })
    expect(parsePartialObject('{"headword":"a\\"b')).toEqual({ headword: 'a"b' })
  })

  it('handles braces, brackets and quotes inside strings', () => {
    const text = '{"headword":"a \\"quoted\\" {word}","x":["x } ] y \\\\'
    expect(parsePartialObject(text)).toEqual({ headword: 'a "quoted" {word}', x: ['x } ] y \\'] })
  })

  it('tolerates a markdown fence and leading prose', () => {
    expect(parsePartialObject('```json\n{"headword":"run",\n  "translation": "跑步",\n')).toEqual({
      headword: 'run',
      translation: '跑步',
    })
  })
})

describe('extractPartialContent', () => {
  it('returns null while there is nothing to show', () => {
    expect(extractPartialContent('')).toBeNull()
    expect(extractPartialContent('{')).toBeNull()
    expect(extractPartialContent('{"headw')).toBeNull()
  })

  it('grows the translation token by token', () => {
    expect(extractPartialContent('{"headword":"run","translation":"跑')).toMatchObject({ headword: 'run', translation: '跑' })
    expect(extractPartialContent('{"headword":"run","translation":"跑步","phon')).toMatchObject({ translation: '跑步' })
  })

  it('shows a sense as soon as its definition starts, growing inside the open group', () => {
    const head = '{"headword":"run","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"to move qui'
    const a = extractPartialContent(head)
    expect(a?.meaningGroups).toEqual([{ partOfSpeech: 'verb', senses: [{ definition: 'to move qui' }] }])
    const b = extractPartialContent(head + 'ckly","cefr":"A1","examples":[{"text":"I ru')
    expect(b?.meaningGroups?.[0].senses[0]).toEqual({
      definition: 'to move quickly',
      cefr: 'A1',
      examples: [{ text: 'I ru' }],
    })
  })

  it('does not show a group before it has a sense with text', () => {
    expect(extractPartialContent('{"headword":"run","meaningGroups":[{"partOfSpeech":"ver')?.meaningGroups).toBeUndefined()
    expect(
      extractPartialContent('{"headword":"run","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":""')?.meaningGroups
    ).toBeUndefined()
  })

  it('drops an invalid cefr until it is complete, like the final parser', () => {
    const base = '{"headword":"run","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"go","cefr":'
    expect(extractPartialContent(base + '"B')?.meaningGroups?.[0].senses[0]).toEqual({ definition: 'go' })
    expect(extractPartialContent(base + '"B1"')?.meaningGroups?.[0].senses[0]).toEqual({ definition: 'go', cefr: 'B1' })
  })

  it('is monotonic and converges on parseContent when fed one character at a time', () => {
    let lastTranslation = ''
    let lastGroups = 0
    let lastDefLen = 0
    for (let i = 1; i <= FULL.length; i += 1) {
      const partial = extractPartialContent(FULL.slice(0, i))
      if (!partial) continue
      const translation = partial.translation ?? ''
      expect('跑步'.startsWith(translation)).toBe(true)
      expect(translation.length).toBeGreaterThanOrEqual(lastTranslation.length)
      lastTranslation = translation
      const groups = partial.meaningGroups?.length ?? 0
      expect(groups).toBeGreaterThanOrEqual(lastGroups)
      lastGroups = groups
      const def = partial.meaningGroups?.[0]?.senses[0]?.definition ?? ''
      expect('to move quickly on foot'.startsWith(def)).toBe(true)
      expect(def.length).toBeGreaterThanOrEqual(lastDefLen)
      lastDefLen = def.length
    }
    expect(extractPartialContent(FULL)).toEqual(parseContent('test', FULL))
  })

  it('surfaces a typo object once it has a suggestion (the caller then suppresses the partial)', () => {
    const partial = extractPartialContent('{"headword":"helo","typo":{"suggestion":"hello","explanation":"Did you mean hello?"}}')
    expect(partial?.typo).toEqual({ suggestion: 'hello', explanation: 'Did you mean hello?' })
  })
})

describe('extractPartialExtras', () => {
  it('returns the lists as they fill in', () => {
    const text = '{"collocations":["run away","run for pres'
    expect(extractPartialExtras(text)).toEqual({ collocations: ['run away', 'run for pres'] })
    expect(extractPartialExtras(text + 'ident"],"wordFamily":["runn')).toEqual({
      collocations: ['run away', 'run for president'],
      wordFamily: ['runn'],
    })
  })

  it('holds a common mistake back until both sides are present and differ', () => {
    expect(extractPartialExtras('{"commonMistakes":[{"wrong":"make a photo"')).toEqual({})
    expect(extractPartialExtras('{"commonMistakes":[{"wrong":"make a photo","right":"take')).toEqual({
      commonMistakes: [{ wrong: 'make a photo', right: 'take' }],
    })
  })
})
