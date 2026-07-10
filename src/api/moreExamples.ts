import type { GradedExample } from './dictionary'

export async function fetchMoreExamples(params: {
  word: string
  sourceLang: string
  targetLang: string
  definition: string
  topic?: string
  cefr?: string
}): Promise<GradedExample[] | null> {
  const qs = new URLSearchParams({
    word: params.word,
    from: params.sourceLang,
    to: params.targetLang,
    definition: params.definition,
  })
  if (params.topic) qs.set('topic', params.topic)
  if (params.cefr) qs.set('cefr', params.cefr)

  try {
    const res = await fetch(`/api/more-examples?${qs.toString()}`)
    if (!res.ok) return null
    const data = (await res.json()) as { examples?: unknown }
    return Array.isArray(data.examples) ? (data.examples as GradedExample[]) : null
  } catch {
    return null
  }
}
