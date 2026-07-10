export async function reportEntry(
  word: string,
  sourceLang: string,
  targetLang: string,
  reason?: string
): Promise<boolean> {
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, sourceLang, targetLang, ...(reason ? { reason } : {}) }),
    })
    return res.ok
  } catch {
    return false
  }
}
