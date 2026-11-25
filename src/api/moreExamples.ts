import { forgetCachedEntry, type GradedExample } from './dictionary'
import { authHeaders, notifyUsageChanged, parseQuota, type QuotaInfo, type TokenGetter } from './usage'

export type MoreExamplesResult =
  | { ok: true; examples: GradedExample[] }
  /** A new batch counts as a new word against the free allowance (docs/design-llm-usage-quotas.md §4.1). */
  | { ok: false; quota: QuotaInfo }
  | { ok: false; quota?: undefined }

export async function fetchMoreExamples(
  params: {
    word: string
    sourceLang: string
    targetLang: string
    definition: string
    topic?: string
    cefr?: string
  },
  getToken?: TokenGetter
): Promise<MoreExamplesResult> {
  const qs = new URLSearchParams({
    word: params.word,
    from: params.sourceLang,
    to: params.targetLang,
    definition: params.definition,
  })
  if (params.topic) qs.set('topic', params.topic)
  if (params.cefr) qs.set('cefr', params.cefr)

  try {
    const res = await fetch(`/api/more-examples?${qs.toString()}`, { headers: await authHeaders(getToken) })
    if (res.status === 429) {
      const quota = parseQuota(await res.json().catch(() => null))
      return quota ? { ok: false, quota } : { ok: false }
    }
    if (res.status === 400) {
      // `unknown_sense`: the server's entry for this word no longer has this
      // sense (regenerated, or merged by fusion since this copy was cached).
      // Drop the stale browser copy so the next visit loads the current entry.
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (body?.error === 'unknown_sense') forgetCachedEntry(params.word, params.sourceLang, params.targetLang)
      return { ok: false }
    }
    if (!res.ok) return { ok: false }
    if (res.headers.get('x-generation') === 'charged') notifyUsageChanged()
    const data = (await res.json()) as { examples?: unknown }
    return Array.isArray(data.examples) && data.examples.length > 0
      ? { ok: true, examples: data.examples as GradedExample[] }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}
