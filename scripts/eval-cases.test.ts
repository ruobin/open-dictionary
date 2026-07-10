import { describe, expect, it } from 'vitest'
import { EVAL_CASES, type EvalContext } from './eval-cases'
import type { DictionaryEntry } from '../server/translate'

function makeEntry(overrides: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return {
    word: 'run',
    phonetics: [],
    meanings: [
      { partOfSpeech: 'verb', definitions: [{ definition: 'to move fast', grammar: 'irregular: run, ran, run' }] },
      { partOfSpeech: 'noun', definitions: [{ definition: 'an act of running' }] },
    ],
    ...overrides,
  }
}

describe('EVAL_CASES', () => {
  it('is non-empty and every case has at least one check', () => {
    expect(EVAL_CASES.length).toBeGreaterThan(0)
    for (const c of EVAL_CASES) {
      expect(c.checks.length).toBeGreaterThan(0)
    }
  })

  it('"run" checks pass against a well-formed multi-POS irregular entry', () => {
    const runCase = EVAL_CASES.find((c) => c.word === 'run')
    expect(runCase).toBeDefined()
    const ctx: EvalContext = { entry: makeEntry(), isTypo: false }
    const failures = runCase!.checks.map((check) => check(ctx)).filter((f) => f !== null)
    expect(failures).toEqual([])
  })

  it('"run" checks fail when the entry is not split by part of speech', () => {
    const runCase = EVAL_CASES.find((c) => c.word === 'run')
    const ctx: EvalContext = {
      entry: makeEntry({ meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'to move fast' }] }] }),
      isTypo: false,
    }
    const failures = runCase!.checks.map((check) => check(ctx)).filter((f) => f !== null)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('typo cases fail against a non-typo response', () => {
    const tehCase = EVAL_CASES.find((c) => c.word === 'teh')
    expect(tehCase).toBeDefined()
    const ctx: EvalContext = { entry: makeEntry({ word: 'teh' }), isTypo: false }
    const failures = tehCase!.checks.map((check) => check(ctx)).filter((f) => f !== null)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('typo cases pass against a matching typo suggestion', () => {
    const tehCase = EVAL_CASES.find((c) => c.word === 'teh')
    const ctx: EvalContext = { entry: makeEntry({ word: 'teh', meanings: [] }), isTypo: true, typoSuggestion: 'the' }
    const failures = tehCase!.checks.map((check) => check(ctx)).filter((f) => f !== null)
    expect(failures).toEqual([])
  })
})
