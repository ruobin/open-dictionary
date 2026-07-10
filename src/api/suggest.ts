export async function fetchSuggestions(
  query: string,
  lang: string,
  signal?: AbortSignal
): Promise<string[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const qs = new URLSearchParams({ q, lang })
  try {
    const res = await fetch(`/api/suggest?${qs.toString()}`, { signal })
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? data.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}
