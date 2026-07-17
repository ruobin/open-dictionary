import {
  type LlmCommonMistake,
  type LlmGradedExample,
  type LlmMeaningGroup,
  type LlmMoreExamplesRequest,
  type LlmMoreExamplesResult,
  type LlmProvider,
  type LlmSense,
  type LlmTranslationContent,
  type LlmTranslationRequest,
  type LlmTranslationResult,
  type LlmUsageMeta,
} from './types'

/**
 * LLM Fusion (design: call two providers/models in parallel and merge their
 * structured results into one superior dictionary entry).
 *
 * Fusion is implemented as an {@link LlmProvider} that wraps two underlying
 * providers. This keeps it transparent to the translate pipeline — caching,
 * metrics, audio-merge and dictionary fallback all work unchanged. The fusion
 * provider's own `id` becomes the Mongo cache key, so fused results are cached
 * distinctly from single-provider results (and swapping either model refreshes
 * them, since the id embeds both).
 *
 * Both sub-calls run concurrently via Promise.allSettled. If one fails, the
 * other's result is used as-is; if both fail, the (first) error is re-thrown
 * so the translate tier falls through to the dictionary fallback. So enabling
 * fusion never makes the system *less* available than a single provider — at
 * worst it costs one extra paid call per uncached lookup.
 */
export interface FusionProviderConfig {
  primary: LlmProvider
  secondary: LlmProvider
}

export function createFusionProvider(config: FusionProviderConfig): LlmProvider {
  const { primary, secondary } = config
  const id = `llm:fusion:${primary.id}+${secondary.id}`

  async function translate(req: LlmTranslationRequest): Promise<LlmTranslationResult> {
    const settled = await Promise.allSettled([primary.translate(req), secondary.translate(req)])
    const [a, b] = settled

    // Both failed — re-throw so the translate tier falls back to the dictionary.
    if (a.status === 'rejected' && b.status === 'rejected') {
      throw a.reason instanceof Error ? a.reason : new Error(String(a.reason))
    }

    const ra = a.status === 'fulfilled' ? a.value : null
    const rb = b.status === 'fulfilled' ? b.value : null

    // Graceful degradation: if only one responded, use it verbatim (no merge).
    if (ra && !rb) return ra
    if (rb && !ra) return rb

    // Both succeeded — fuse their structured content.
    const ca = (ra!.content as LlmTranslationContent) ?? { headword: '' }
    const cb = (rb!.content as LlmTranslationContent) ?? { headword: '' }
    const merged = mergeContents(ca, cb)
    const meta = mergeMeta(ra!.meta, rb!.meta)
    return meta ? { content: merged, meta } : { content: merged }
  }

  // moreExamples is a secondary follow-up feature; fusing it adds little value
  // and the primary is the canonical choice — delegate verbatim.
  async function moreExamples(req: LlmMoreExamplesRequest): Promise<LlmMoreExamplesResult> {
    return primary.moreExamples(req)
  }

  return { id, translate, moreExamples }
}

/** Sums per-provider token usage when both report it (otherwise passes through). */
function mergeMeta(a: LlmUsageMeta | undefined, b: LlmUsageMeta | undefined): LlmUsageMeta | undefined {
  if (!a && !b) return undefined
  const pt = (a?.promptTokens != null ? a.promptTokens : 0) + (b?.promptTokens != null ? b.promptTokens : 0)
  const ct = (a?.completionTokens != null ? a.completionTokens : 0) + (b?.completionTokens != null ? b.completionTokens : 0)
  return { promptTokens: pt, completionTokens: ct }
}

// ---------------------------------------------------------------------------
// Pure merge logic. Exported for unit testing. Deterministic: primary's values
// win ties, secondary only fills gaps or adds genuinely new material.
// ---------------------------------------------------------------------------

/**
 * Merges two structured translation payloads into one. Pure and deterministic:
 *  - headword/translation: primary wins; secondary fills an empty primary.
 *  - phonetic: longer (more detailed) IPA wins; ties go to primary.
 *  - typo: only kept if BOTH flag it — a full definition from one model must
 *    not be discarded just because the other misjudged the input as a typo.
 *  - meaningGroups: grouped by part-of-speech, senses de-duplicated by
 *    definition similarity, examples unioned, metadata filled from either side.
 *  - commonMistakes/collocations/wordFamily: unioned, case-insensitive dedupe.
 */
export function mergeContents(primary: LlmTranslationContent, secondary: LlmTranslationContent): LlmTranslationContent {
  const out: LlmTranslationContent = {
    headword: primary.headword || secondary.headword,
  }

  // translation
  if (primary.translation) out.translation = primary.translation
  else if (secondary.translation) out.translation = secondary.translation

  // phonetic — prefer the longer (more detailed) transcription.
  const phonetic = pickPhonetic(primary.phonetic, secondary.phonetic)
  if (phonetic) out.phonetic = phonetic

  // typo — only if both flag it. A real definition must survive one model's
  // false "typo" judgement.
  if (primary.typo && secondary.typo) {
    out.typo = primary.typo.explanation
      ? primary.typo
      : secondary.typo.explanation
        ? secondary.typo
        : primary.typo
  }

  const meaningGroups = mergeMeaningGroups(primary.meaningGroups, secondary.meaningGroups)
  if (meaningGroups.length > 0) out.meaningGroups = meaningGroups

  const commonMistakes = mergeCommonMistakes(primary.commonMistakes, secondary.commonMistakes)
  if (commonMistakes.length > 0) out.commonMistakes = commonMistakes

  const collocations = mergeStringLists(primary.collocations, secondary.collocations)
  if (collocations.length > 0) out.collocations = collocations

  const wordFamily = mergeStringLists(primary.wordFamily, secondary.wordFamily)
  if (wordFamily.length > 0) out.wordFamily = wordFamily

  return out
}

function pickPhonetic(a: string | undefined, b: string | undefined): string | undefined {
  if (a && b) return a.length >= b.length ? a : b
  return a ?? b
}

function mergeMeaningGroups(
  a: LlmMeaningGroup[] | undefined,
  b: LlmMeaningGroup[] | undefined
): LlmMeaningGroup[] {
  const groups = [...(a ?? []), ...(b ?? [])]
  if (groups.length === 0) return []

  // Bucket by part-of-speech (case-insensitive), preserving first-seen
  // original casing so primary's POS labels win. Senses accumulate in order.
  const buckets = new Map<string, { partOfSpeech: string; senses: LlmSense[] }>()
  for (const g of groups) {
    const key = g.partOfSpeech.trim().toLowerCase()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { partOfSpeech: g.partOfSpeech, senses: [] }
      buckets.set(key, bucket)
    }
    for (const s of g.senses) bucket.senses.push(s)
  }

  const out: LlmMeaningGroup[] = []
  for (const bucket of buckets.values()) {
    const merged: LlmSense[] = []
    for (const s of bucket.senses) {
      const existing = merged.find((m) => definitionsSimilar(m.definition, s.definition))
      if (existing) fillSense(existing, s)
      else merged.push({ ...s, examples: s.examples ? [...s.examples] : undefined })
    }
    out.push({ partOfSpeech: bucket.partOfSpeech, senses: merged })
  }
  return out
}

/** Fills missing metadata on `target` from `src` and unions their examples. */
function fillSense(target: LlmSense, src: LlmSense): void {
  if (!target.cefr && src.cefr) target.cefr = src.cefr
  if (!target.grammar && src.grammar) target.grammar = src.grammar
  if (!target.register && src.register) target.register = src.register
  target.examples = mergeExamples(target.examples ?? [], src.examples ?? [])
}

function mergeExamples(a: LlmGradedExample[], b: LlmGradedExample[]): LlmGradedExample[] {
  if (a.length === 0) return b
  const seen = new Set(a.map((e) => e.text.toLowerCase().trim()))
  const out = [...a]
  for (const e of b) {
    const key = e.text.toLowerCase().trim()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

function mergeCommonMistakes(
  a: LlmCommonMistake[] | undefined,
  b: LlmCommonMistake[] | undefined
): LlmCommonMistake[] {
  const list = [...(a ?? []), ...(b ?? [])]
  if (list.length === 0) return []
  const out: LlmCommonMistake[] = []
  const seen = new Set<string>()
  for (const m of list) {
    const key = m.wrong.toLowerCase().trim()
    if (seen.has(key)) {
      // Fill missing note on the existing entry.
      const existing = out.find((x) => x.wrong.toLowerCase().trim() === key)
      if (existing && !existing.note && m.note) existing.note = m.note
      continue
    }
    seen.add(key)
    out.push({ ...m })
  }
  return out
}

/** Union of two string lists, case-insensitive dedupe, preserving first-seen order. */
function mergeStringLists(a: string[] | undefined, b: string[] | undefined): string[] {
  const list = [...(a ?? []), ...(b ?? [])]
  if (list.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of list) {
    const t = s.trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** Lowercase, strip punctuation, collapse whitespace — for fuzzy comparison. */
function normalizeDefinition(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Two definitions are "similar" (and thus de-duplicated) when identical after
 * punctuation/case normalization, or when their token sets overlap by at least
 * 0.6 (Jaccard). Tuned to collapse paraphrases of the same sense without
 * merging genuinely distinct meanings.
 */
export function definitionsSimilar(a: string, b: string): boolean {
  const na = normalizeDefinition(a)
  const nb = normalizeDefinition(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = new Set(na.split(' '))
  const tb = new Set(nb.split(' '))
  let inter = 0
  for (const w of ta) if (tb.has(w)) inter++
  const union = ta.size + tb.size - inter
  return union > 0 && inter / union >= 0.6
}
