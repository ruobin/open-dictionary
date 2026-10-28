import { describe, expect, it } from 'vitest'
import { extractPartialContent } from './streamJson'
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

describe('extractPartialContent', () => {
  it('returns null when nothing is complete yet', () => {
    expect(extractPartialContent('')).toBeNull()
    expect(extractPartialContent('Sure! Here is')).toBeNull()
    expect(extractPartialContent('{')).toBeNull()
    expect(extractPartialContent('{"headw')).toBeNull()
    expect(extractPartialContent('{"headword":"ru')).toBeNull()
  })

  it('emits scalar fields only once they are complete', () => {
    expect(extractPartialContent('{"headword":"run","translation":"跑')).toMatchObject({ headword: 'run' })
    expect(extractPartialContent('{"headword":"run","translation":"跑')?.translation).toBeUndefined()
    expect(extractPartialContent('{"headword":"run","translation":"跑步","phon')).toMatchObject({
      headword: 'run',
      translation: '跑步',
    })
  })

  it('emits each meaning group as soon as it closes, never a half-written one', () => {
    const cut = FULL.indexOf('{"partOfSpeech":"noun"')
    const midFirstGroup = FULL.slice(0, FULL.indexOf('"cefr"'))
    expect(extractPartialContent(midFirstGroup)?.meaningGroups).toBeUndefined()

    const afterFirst = extractPartialContent(FULL.slice(0, cut))
    expect(afterFirst?.meaningGroups).toHaveLength(1)
    expect(afterFirst?.meaningGroups?.[0].partOfSpeech).toBe('verb')

    const midSecond = extractPartialContent(FULL.slice(0, cut + 40))
    expect(midSecond?.meaningGroups).toHaveLength(1)

    expect(extractPartialContent(FULL)?.meaningGroups).toHaveLength(2)
  })

  it('is monotonic and converges on parseContent when fed one character at a time', () => {
    let lastGroups = 0
    let sawTranslation = false
    for (let i = 1; i <= FULL.length; i += 1) {
      const partial = extractPartialContent(FULL.slice(0, i))
      const groups = partial?.meaningGroups?.length ?? 0
      expect(groups).toBeGreaterThanOrEqual(lastGroups)
      lastGroups = groups
      if (partial?.translation) sawTranslation = true
      if (sawTranslation) expect(partial?.translation).toBe('跑步')
    }
    expect(extractPartialContent(FULL)).toEqual(parseContent('test', FULL))
  })

  it('handles braces, quotes and escapes inside strings', () => {
    const text = '{"headword":"a \\"quoted\\" {word}","meaningGroups":[{"partOfSpeech":"noun","senses":[{"definition":"x } ] y \\\\"}]}'
    const partial = extractPartialContent(text)
    expect(partial?.headword).toBe('a "quoted" {word}')
    // The `}` and `]` inside the definition string must not end the group early,
    // and the escaped backslash before the closing quote must not swallow it.
    expect(partial?.meaningGroups).toEqual([
      { partOfSpeech: 'noun', senses: [{ definition: 'x } ] y \\' }] },
    ])
  })

  it('tolerates a markdown fence and leading prose', () => {
    const partial = extractPartialContent('```json\n{"headword":"run",\n  "translation": "跑步",\n')
    expect(partial).toMatchObject({ headword: 'run', translation: '跑步' })
  })

  it('surfaces a typo object once complete', () => {
    const partial = extractPartialContent('{"headword":"helo","typo":{"suggestion":"hello","explanation":"Did you mean hello?"}}')
    expect(partial?.typo).toEqual({ suggestion: 'hello', explanation: 'Did you mean hello?' })
  })

  it('drops invalid sub-fields leniently, like the final parser', () => {
    const partial = extractPartialContent(
      '{"headword":"run","meaningGroups":[{"partOfSpeech":"verb","senses":[{"definition":"go","cefr":"Z9"}]}'
    )
    expect(partial?.meaningGroups?.[0].senses[0]).toEqual({ definition: 'go' })
  })

  it('does not treat an incomplete number as complete', () => {
    expect(extractPartialContent('{"headword":"run","x":12')).toMatchObject({ headword: 'run' })
  })
})
