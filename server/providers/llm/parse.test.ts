import { describe, expect, it } from 'vitest'
import { OUTPUT_LIMITS, parseContent, parseExtrasContent, parseMoreExamplesContent } from './parse'
import { extractPartialContent } from './streamJson'

const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i))
const core = (obj: unknown) => parseContent('test', JSON.stringify(obj))

describe('parseContent — an ordinary answer passes through unchanged', () => {
  it('keeps every field of a well-formed entry', () => {
    const answer = {
      headword: 'run',
      translation: 'correr',
      phonetic: '/rʌn/',
      meaningGroups: [
        {
          partOfSpeech: 'verb',
          senses: [
            {
              definition: 'To move quickly on foot.',
              cefr: 'A1',
              grammar: 'irregular: run, ran, run',
              register: 'neutral',
              examples: [{ text: 'I run every day.', cefr: 'A1' }],
            },
          ],
        },
      ],
      commonMistakes: [{ wrong: 'runned', right: 'ran', note: 'Irregular past tense.' }],
      collocations: ['run a business'],
      wordFamily: ['runner'],
    }
    expect(core(answer)).toEqual(answer)
  })
})

describe('parseContent — counts are bounded', () => {
  it('drops meaning groups, senses and examples past the limits', () => {
    const content = core({
      headword: 'x',
      meaningGroups: many(50, (g) => ({
        partOfSpeech: `pos${g}`,
        senses: many(50, (s) => ({ definition: `sense ${s}`, examples: many(50, (e) => ({ text: `example ${e}` })) })),
      })),
    })
    expect(content.meaningGroups).toHaveLength(OUTPUT_LIMITS.meaningGroups)
    expect(content.meaningGroups?.[0].senses).toHaveLength(OUTPUT_LIMITS.sensesPerGroup)
    expect(content.meaningGroups?.[0].senses[0].examples).toHaveLength(OUTPUT_LIMITS.examplesPerSense)
    // The first items are the ones kept (the prompt asks for most common first).
    expect(content.meaningGroups?.[0].partOfSpeech).toBe('pos0')
  })

  it('drops extras past the limits', () => {
    const extras = parseExtrasContent(
      'test',
      JSON.stringify({
        commonMistakes: many(50, (i) => ({ wrong: `w${i}`, right: `r${i}` })),
        collocations: many(50, (i) => `collocation ${i}`),
        wordFamily: many(50, (i) => `word${i}`),
      })
    )
    expect(extras.commonMistakes).toHaveLength(OUTPUT_LIMITS.commonMistakes)
    expect(extras.collocations).toHaveLength(OUTPUT_LIMITS.collocations)
    expect(extras.wordFamily).toHaveLength(OUTPUT_LIMITS.wordFamily)
  })

  it('bounds a "more examples" batch', () => {
    const examples = parseMoreExamplesContent('test', JSON.stringify({ examples: many(50, (i) => ({ text: `e${i}` })) }))
    expect(examples).toHaveLength(OUTPUT_LIMITS.moreExamples)
  })
})

describe('parseContent — lengths are bounded', () => {
  const huge = 'word '.repeat(5000) // 25,000 characters

  it('cuts over-long prose and marks the cut with an ellipsis', () => {
    const content = core({
      headword: 'x',
      translation: huge,
      phonetic: huge,
      meaningGroups: [
        {
          partOfSpeech: huge,
          senses: [{ definition: huge, grammar: huge, register: huge, examples: [{ text: huge }] }],
        },
      ],
      commonMistakes: [{ wrong: `a ${huge}`, right: `b ${huge}`, note: huge }],
    })
    const sense = content.meaningGroups![0].senses[0]
    const checks: Array<[string | undefined, number]> = [
      [content.translation, OUTPUT_LIMITS.translation],
      [content.phonetic, OUTPUT_LIMITS.phonetic],
      [content.meaningGroups![0].partOfSpeech, OUTPUT_LIMITS.partOfSpeech],
      [sense.definition, OUTPUT_LIMITS.definition],
      [sense.grammar, OUTPUT_LIMITS.grammar],
      [sense.register, OUTPUT_LIMITS.register],
      [sense.examples![0].text, OUTPUT_LIMITS.example],
      [content.commonMistakes![0].wrong, OUTPUT_LIMITS.mistake],
      [content.commonMistakes![0].right, OUTPUT_LIMITS.mistake],
      [content.commonMistakes![0].note, OUTPUT_LIMITS.note],
    ]
    for (const [value, max] of checks) {
      expect(value!.length).toBeLessThanOrEqual(max)
      expect(value!.endsWith('…')).toBe(true)
    }
  })

  it('leaves text exactly at a limit alone', () => {
    const definition = 'd'.repeat(OUTPUT_LIMITS.definition)
    const content = core({ headword: 'x', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition }] }] })
    expect(content.meaningGroups![0].senses[0].definition).toBe(definition)
  })

  it('drops a collocation or word-family entry too long to be a term, rather than cutting it', () => {
    const extras = parseExtrasContent(
      'test',
      JSON.stringify({ collocations: ['heavy rain', huge], wordFamily: [huge, 'runner'] })
    )
    expect(extras.collocations).toEqual(['heavy rain'])
    expect(extras.wordFamily).toEqual(['runner'])
  })

  it('bounds the headword and a typo suggestion to the length of a lookup', () => {
    const content = core({ headword: 'h'.repeat(5000), typo: { suggestion: 's'.repeat(5000), explanation: huge } })
    expect(content.headword).toHaveLength(OUTPUT_LIMITS.headword)
    expect(content.typo!.suggestion).toHaveLength(OUTPUT_LIMITS.typoSuggestion)
    expect(content.typo!.explanation!.length).toBeLessThanOrEqual(OUTPUT_LIMITS.typoExplanation)
  })

  it('never cuts through a surrogate pair', () => {
    const definition = `${'d'.repeat(OUTPUT_LIMITS.definition - 2)}😀😀😀`
    const content = core({ headword: 'x', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition }] }] })
    const out = content.meaningGroups![0].senses[0].definition
    expect(out.length).toBeLessThanOrEqual(OUTPUT_LIMITS.definition)
    expect(() => encodeURIComponent(out)).not.toThrow() // throws on a lone surrogate
  })
})

describe('streamed partial snapshots get the same bounds', () => {
  it('bounds a half-written, runaway answer', () => {
    const raw = `{"headword":"x","meaningGroups":[{"partOfSpeech":"noun","senses":[{"definition":"${'d'.repeat(5000)}`
    const partial = extractPartialContent(raw)
    expect(partial!.meaningGroups![0].senses[0].definition.length).toBeLessThanOrEqual(OUTPUT_LIMITS.definition)
  })
})
