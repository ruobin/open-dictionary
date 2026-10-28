import { describe, expect, it, vi } from 'vitest'
import type {
  LlmFuseRequest,
  LlmFuseResult,
  LlmMoreExamplesRequest,
  LlmMoreExamplesResult,
  LlmProvider,
  LlmTranslationContent,
  LlmTranslationRequest,
} from './types'
import { createFusionProvider, definitionsSimilar, mergeContents } from './fusion'

/** Minimal fake provider returning fixed content (or throwing). No `fuse`
 *  method → the FusionProvider falls back to the deterministic code merge. */
function fakeProvider(
  id: string,
  content: LlmTranslationContent | null,
  meta?: { promptTokens?: number; completionTokens?: number }
): LlmProvider {
  return {
    id,
    async translate(_req: LlmTranslationRequest) {
      if (content === null) throw new Error(`${id} failed`)
      return meta ? { content, meta } : { content }
    },
    async moreExamples(_req: LlmMoreExamplesRequest): Promise<LlmMoreExamplesResult> {
      return { examples: [] }
    },
  }
}

/** Fake provider with a controllable `fuse()` for testing the LLM-merge path.
 *  `fuseImpl` receives the request; returns its result, or throws if it's null. */
function fakeFusingProvider(
  id: string,
  content: LlmTranslationContent,
  fuseImpl: ((req: LlmFuseRequest) => LlmFuseResult | Promise<LlmFuseResult>) | null
): LlmProvider {
  return {
    id,
    async translate() {
      return { content }
    },
    async moreExamples() {
      return { examples: [] }
    },
    async fuse(req: LlmFuseRequest): Promise<LlmFuseResult> {
      if (fuseImpl === null) throw new Error(`${id}.fuse failed`)
      return fuseImpl(req)
    },
  }
}

describe('definitionsSimilar', () => {
  it('matches identical text after punctuation/case normalization', () => {
    expect(definitionsSimilar('A greeting.', 'a greeting')).toBe(true)
  })
  it('matches paraphrases above the Jaccard threshold', () => {
    expect(definitionsSimilar('to move quickly on foot', 'to move fast on foot')).toBe(true)
  })
  it('does not match genuinely distinct definitions', () => {
    expect(definitionsSimilar('a greeting', 'an act of running')).toBe(false)
  })
  it('returns false for empty input', () => {
    expect(definitionsSimilar('', 'something')).toBe(false)
  })
})

describe('mergeContents', () => {
  it('headword: primary wins, secondary fills an empty primary', () => {
    expect(mergeContents({ headword: 'a' }, { headword: 'b' }).headword).toBe('a')
    expect(mergeContents({ headword: '' }, { headword: 'b' }).headword).toBe('b')
  })

  it('translation: primary wins, secondary fills an empty primary', () => {
    expect(mergeContents({ headword: 'x', translation: 'uno' }, { headword: 'x', translation: 'eins' }).translation).toBe('uno')
    expect(mergeContents({ headword: 'x' }, { headword: 'x', translation: 'eins' }).translation).toBe('eins')
  })

  it('phonetic: longer (more detailed) transcription wins', () => {
    expect(mergeContents({ headword: 'x', phonetic: '/x/' }, { headword: 'x', phonetic: '/ks/ longer' }).phonetic).toBe('/ks/ longer')
    expect(mergeContents({ headword: 'x', phonetic: '/abc/' }, { headword: 'x' }).phonetic).toBe('/abc/')
  })

  it('typo: only kept when BOTH flag it', () => {
    const both = mergeContents(
      { headword: 'teh', typo: { suggestion: 'the' } },
      { headword: 'teh', typo: { suggestion: 'the', explanation: 'Did you mean the?' } }
    )
    expect(both.typo).toEqual({ suggestion: 'the', explanation: 'Did you mean the?' })

    const oneSide = mergeContents(
      { headword: 'helo', typo: { suggestion: 'hello' } },
      { headword: 'helo', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition: 'a real word' }] }] }
    )
    expect(oneSide.typo).toBeUndefined()
    expect(oneSide.meaningGroups).toHaveLength(1)
  })

  it('meaningGroups: dedupes senses with similar definitions, fills metadata, unions examples', () => {
    const merged = mergeContents(
      {
        headword: 'run',
        meaningGroups: [
          {
            partOfSpeech: 'verb',
            senses: [
              { definition: 'To move quickly on foot', cefr: 'A2', examples: [{ text: 'I run daily.' }] },
            ],
          },
        ],
      },
      {
        headword: 'run',
        meaningGroups: [
          {
            partOfSpeech: 'Verb', // case-insensitive bucket merge
            senses: [
              {
                definition: 'to move fast on foot', // similar → merged
                grammar: 'intransitive',
                examples: [{ text: 'She runs fast.' }, { text: 'I run daily.' }], // one dup
              },
              { definition: 'to operate a machine' }, // distinct → added
            ],
          },
        ],
      }
    )
    expect(merged.meaningGroups).toHaveLength(1)
    const g = merged.meaningGroups![0]
    expect(g.partOfSpeech).toBe('verb')
    expect(g.senses).toHaveLength(2)
    expect(g.senses[0]).toMatchObject({ definition: 'To move quickly on foot', cefr: 'A2', grammar: 'intransitive' })
    expect(g.senses[0].examples).toEqual([
      { text: 'I run daily.' },
      { text: 'She runs fast.' },
    ])
    expect(g.senses[1].definition).toBe('to operate a machine')
  })

  it('meaningGroups: keeps separate parts of speech as separate groups', () => {
    const merged = mergeContents(
      { headword: 'run', meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move' }] }] },
      { headword: 'run', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition: 'an act of running' }] }] }
    )
    expect(merged.meaningGroups!.map((g) => g.partOfSpeech)).toEqual(['verb', 'noun'])
  })

  it('commonMistakes: unions and dedupes by `wrong`, filling missing note', () => {
    const merged = mergeContents(
      { headword: 'photo', commonMistakes: [{ wrong: 'make a photo', right: 'take a photo' }] },
      { headword: 'photo', commonMistakes: [{ wrong: 'Make a Photo', right: 'take a photo', note: 'Use take.' }, { wrong: 'do a photo', right: 'take a photo' }] }
    )
    expect(merged.commonMistakes).toHaveLength(2)
    expect(merged.commonMistakes!.find((m) => m.wrong.toLowerCase() === 'make a photo')!.note).toBe('Use take.')
  })

  it('collocations and wordFamily: union, case-insensitive dedupe, preserve order', () => {
    const merged = mergeContents(
      { headword: 'rain', collocations: ['heavy rain', 'light rain'], wordFamily: ['rainy'] },
      { headword: 'rain', collocations: ['Heavy Rain', 'torrential rain'], wordFamily: ['Rainy', 'rainless'] }
    )
    expect(merged.collocations).toEqual(['heavy rain', 'light rain', 'torrential rain'])
    expect(merged.wordFamily).toEqual(['rainy', 'rainless'])
  })

  it('omits empty arrays', () => {
    const merged = mergeContents({ headword: 'x', collocations: [], wordFamily: [] }, { headword: 'x' })
    expect(merged.collocations).toBeUndefined()
    expect(merged.wordFamily).toBeUndefined()
    expect(merged.meaningGroups).toBeUndefined()
  })
})

describe('createFusionProvider', () => {
  function req(): LlmTranslationRequest {
    return { text: 'hello', sourceLang: 'en', targetLang: 'en' }
  }

  it('id embeds both sub-provider ids', () => {
    const f = createFusionProvider({
      primary: fakeProvider('llm:a:1', { headword: 'x' }),
      secondary: fakeProvider('llm:b:2', { headword: 'x' }),
    })
    expect(f.id).toBe('llm:fusion:llm:a:1+llm:b:2')
  })

  it('returns the first answer immediately and merges both via the code merge in the background when primary has no fuse()', async () => {
    const f = createFusionProvider({
      primary: fakeProvider('llm:a:1', { headword: 'run', meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move' }] }] }),
      secondary: fakeProvider('llm:b:2', { headword: 'run', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition: 'an act' }] }] }),
    })
    const result = await f.translate(req())
    // The immediate answer is a single model's, not the union.
    expect((result.content as LlmTranslationContent).meaningGroups).toHaveLength(1)
    // The union arrives as the upgrade.
    const upgraded = await result.upgrade
    expect(upgraded!.meaningGroups).toHaveLength(2)
  })

  it('does not wait for the slower provider before answering', async () => {
    let releaseSlow: () => void = () => {}
    const slow: LlmProvider = {
      id: 'llm:slow:1',
      async translate() {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve
        })
        return { content: { headword: 'run', translation: 'slow' } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const f = createFusionProvider({
      primary: slow,
      secondary: fakeProvider('llm:fast:2', { headword: 'run', translation: 'fast' }),
    })
    const result = await f.translate(req())
    expect((result.content as LlmTranslationContent).translation).toBe('fast')
    releaseSlow()
    const upgraded = await result.upgrade
    expect(upgraded).not.toBeNull()
  })

  it('forwards only the primary\'s partial answers to onPartial', async () => {
    const onPartial = vi.fn()
    const primary: LlmProvider = {
      id: 'llm:a:1',
      async translate(_req, opts) {
        opts?.onPartial?.({ headword: 'run', translation: 'primary-partial' })
        return { content: { headword: 'run' } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    const secondary: LlmProvider = {
      id: 'llm:b:2',
      async translate(_req, opts) {
        opts?.onPartial?.({ headword: 'run', translation: 'secondary-partial' })
        return { content: { headword: 'run' } }
      },
      async moreExamples() {
        return { examples: [] }
      },
    }
    await createFusionProvider({ primary, secondary }).translate(req(), { onPartial })
    expect(onPartial).toHaveBeenCalledTimes(1)
    expect(onPartial).toHaveBeenCalledWith({ headword: 'run', translation: 'primary-partial' })
  })

  it('upgrade uses primary.fuse() when present', async () => {
    const fuseImpl = vi.fn(async (fusedReq: LlmFuseRequest): Promise<LlmFuseResult> => {
      // The fuse call receives both structured responses + the original request.
      expect(fusedReq.request.text).toBe('hello')
      expect(fusedReq.primary.headword).toBe('run')
      expect(fusedReq.secondary.headword).toBe('run')
      return {
        content: { headword: 'run', meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'merged sense' }] }] },
        meta: { promptTokens: 50, completionTokens: 30 },
      }
    })
    const f = createFusionProvider({
      primary: fakeFusingProvider('llm:a:1', { headword: 'run', meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move' }] }] }, fuseImpl),
      secondary: fakeProvider('llm:b:2', { headword: 'run', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition: 'an act' }] }] }),
    })
    const result = await f.translate(req())
    const upgraded = await result.upgrade
    expect(fuseImpl).toHaveBeenCalledTimes(1)
    // The fuse result wins — not the code-merge union.
    expect(upgraded!.meaningGroups).toEqual([{ partOfSpeech: 'verb', senses: [{ definition: 'merged sense' }] }])
  })

  it('upgrade falls back to the code merge when primary.fuse() throws', async () => {
    const fuseImpl = vi.fn(async (): Promise<LlmFuseResult> => {
      throw new Error('model overloaded')
    })
    const f = createFusionProvider({
      primary: fakeFusingProvider('llm:a:1', { headword: 'run', meaningGroups: [{ partOfSpeech: 'verb', senses: [{ definition: 'to move' }] }] }, fuseImpl),
      secondary: fakeProvider('llm:b:2', { headword: 'run', meaningGroups: [{ partOfSpeech: 'noun', senses: [{ definition: 'an act' }] }] }),
    })
    const result = await f.translate(req())
    const upgraded = await result.upgrade
    // Fuse threw → deterministic code merge ran → union of both POS groups.
    expect(upgraded!.meaningGroups).toHaveLength(2)
    expect(fuseImpl).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when the secondary fails — uses primary verbatim', async () => {
    const f = createFusionProvider({
      primary: fakeProvider('llm:a:1', { headword: 'run', translation: 'correr' }),
      secondary: fakeProvider('llm:b:2', null),
    })
    const result = await f.translate(req())
    expect((result.content as LlmTranslationContent).translation).toBe('correr')
    expect(await result.upgrade).toBeNull()
  })

  it('degrades gracefully when the primary fails — uses secondary verbatim', async () => {
    const f = createFusionProvider({
      primary: fakeProvider('llm:a:1', null),
      secondary: fakeProvider('llm:b:2', { headword: 'run', translation: 'correr' }),
    })
    const result = await f.translate(req())
    expect((result.content as LlmTranslationContent).translation).toBe('correr')
  })

  it('re-throws when both fail', async () => {
    const f = createFusionProvider({
      primary: fakeProvider('llm:a:1', null),
      secondary: fakeProvider('llm:b:2', null),
    })
    await expect(f.translate(req())).rejects.toThrow('llm:a:1 failed')
  })

  it('moreExamples delegates to the primary', async () => {
    let called = ''
    const primary: LlmProvider = {
      id: 'llm:a:1',
      async translate() {
        return { content: { headword: 'x' } }
      },
      async moreExamples() {
        called = 'primary'
        return { examples: [{ text: 'e1' }] }
      },
    }
    const secondary: LlmProvider = {
      id: 'llm:b:2',
      async translate() {
        return { content: { headword: 'x' } }
      },
      async moreExamples() {
        called = 'secondary'
        return { examples: [] }
      },
    }
    const f = createFusionProvider({ primary, secondary })
    const res = await f.moreExamples({ word: 'run', sourceLang: 'en', targetLang: 'en', senseDefinition: 'to move' })
    expect(called).toBe('primary')
    expect(res.examples).toEqual([{ text: 'e1' }])
  })
})
