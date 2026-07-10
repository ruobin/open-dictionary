import type { DictionaryEntry } from '../server/translate'

/**
 * Fixed set of tricky words with structural checks against the adapted
 * entry, for scripts/eval-harness.ts (to-do §4). Checks are intentionally
 * structural (field presence, counts, substring matches) rather than deep
 * semantic correctness — an LLM's exact phrasing varies run to run, but
 * "does 'run' get split into verb/noun groups" or "is 'teh' flagged as a
 * typo" are checkable without a human in the loop.
 */
export interface EvalContext {
  entry: DictionaryEntry
  isTypo: boolean
  typoSuggestion?: string
}

export interface EvalCase {
  word: string
  sourceLang?: string
  targetLang?: string
  /** Why this word is in the set — what it's meant to catch. */
  note: string
  /** Each check returns a failure message, or null if it passed. */
  checks: Array<(ctx: EvalContext) => string | null>
}

function hasPartOfSpeech(entry: DictionaryEntry, pos: string): boolean {
  return entry.meanings.some((m) => m.partOfSpeech.toLowerCase().includes(pos.toLowerCase()))
}

function anyGrammarIncludes(entry: DictionaryEntry, substr: string): boolean {
  return entry.meanings.some((m) =>
    m.definitions.some((d) => d.grammar?.toLowerCase().includes(substr.toLowerCase()))
  )
}

function anyRegisterIncludes(entry: DictionaryEntry, substr: string): boolean {
  return entry.meanings.some((m) =>
    m.definitions.some((d) => d.register?.toLowerCase().includes(substr.toLowerCase()))
  )
}

function minPosGroups(n: number) {
  return (ctx: EvalContext): string | null => {
    if (ctx.isTypo) return `expected ${n}+ part-of-speech groups, got a typo response`
    const count = ctx.entry.meanings.length
    return count >= n ? null : `expected ${n}+ part-of-speech groups, got ${count}`
  }
}

function includesPos(...pos: string[]) {
  return (ctx: EvalContext): string | null => {
    if (ctx.isTypo) return `expected part of speech among [${pos.join(', ')}], got a typo response`
    const found = pos.some((p) => hasPartOfSpeech(ctx.entry, p))
    return found ? null : `expected part of speech among [${pos.join(', ')}], got none`
  }
}

function grammarContains(substr: string) {
  return (ctx: EvalContext): string | null => {
    if (ctx.isTypo) return `expected a grammar label containing "${substr}", got a typo response`
    return anyGrammarIncludes(ctx.entry, substr)
      ? null
      : `expected some sense's grammar label to contain "${substr}"`
  }
}

function registerContainsAny(...substrs: string[]) {
  return (ctx: EvalContext): string | null => {
    if (ctx.isTypo) return `expected a register label among [${substrs.join(', ')}], got a typo response`
    const found = substrs.some((s) => anyRegisterIncludes(ctx.entry, s))
    return found ? null : `expected some sense's register label to contain one of [${substrs.join(', ')}]`
  }
}

function isTypoWithSuggestion(expected: string) {
  return (ctx: EvalContext): string | null => {
    if (!ctx.isTypo) return 'expected a typo response, got a real definition'
    const got = ctx.typoSuggestion?.toLowerCase()
    return got === expected.toLowerCase() ? null : `expected typo suggestion "${expected}", got "${got}"`
  }
}

function isNotTypo(ctx: EvalContext): string | null {
  return ctx.isTypo ? `expected a real definition, got a typo response (suggested "${ctx.typoSuggestion}")` : null
}

function hasAnyDefinition(ctx: EvalContext): string | null {
  if (ctx.isTypo) return 'expected a real definition, got a typo response'
  return ctx.entry.meanings.some((m) => m.definitions.length > 0) ? null : 'expected at least one definition'
}

export const EVAL_CASES: EvalCase[] = [
  {
    word: 'run',
    note: 'polyseme + irregular verb — should split verb/noun and flag the irregular form',
    checks: [minPosGroups(2), includesPos('verb', 'noun'), grammarContains('irregular'), isNotTypo],
  },
  {
    word: 'bank',
    note: 'classic polyseme (financial institution vs riverbank vs verb)',
    checks: [minPosGroups(2), includesPos('verb', 'noun'), isNotTypo],
  },
  {
    word: 'go',
    note: 'extremely common, highly irregular verb (go, went, gone)',
    checks: [grammarContains('irregular'), isNotTypo, hasAnyDefinition],
  },
  {
    word: 'children',
    note: 'irregular plural form',
    checks: [isNotTypo, hasAnyDefinition],
  },
  {
    word: 'lit',
    note: 'slang usage — should carry an informal/slang register label',
    checks: [isNotTypo, hasAnyDefinition, registerContainsAny('slang', 'informal')],
  },
  {
    word: 'photo',
    note: 'well-known learner mistake ("make a photo" vs "take a photo")',
    checks: [isNotTypo, hasAnyDefinition],
  },
  {
    word: 'serendipity',
    note: 'sophisticated/rare word — sanity check on a harder case',
    checks: [isNotTypo, hasAnyDefinition],
  },
  {
    word: 'cat',
    note: 'trivial A1 word — sanity check the basic case still works',
    checks: [isNotTypo, hasAnyDefinition],
  },
  {
    word: 'teh',
    note: 'obvious typo (transposed letters) — should be caught, not defined',
    checks: [isTypoWithSuggestion('the')],
  },
  {
    word: 'helo',
    note: 'obvious typo (missing letter) — should be caught, not defined',
    checks: [isTypoWithSuggestion('hello')],
  },
  {
    word: 'colour',
    note: 'dialectal variant, NOT a typo — the prompt explicitly says not to flag these',
    checks: [isNotTypo, hasAnyDefinition],
  },
]
