export async function fetchWordOfDay(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/word-of-day', { signal })
    if (!res.ok) return null
    const data = (await res.json()) as { word?: unknown }
    return typeof data.word === 'string' ? data.word : null
  } catch {
    return null
  }
}
