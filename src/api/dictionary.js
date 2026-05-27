const CACHE_PREFIX = 'dict:v1:'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

function readCache(word) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + word)
    if (!raw) return null
    const entry = JSON.parse(raw)
    if (Date.now() - entry.fetchedAt > TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + word)
      return null
    }
    return entry.data
  } catch {
    return null
  }
}

function writeCache(word, data) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + word,
      JSON.stringify({ data, fetchedAt: Date.now() })
    )
  } catch {
    // Quota or unavailable — ignore
  }
}

export async function lookupWord(rawWord) {
  const word = rawWord.trim().toLowerCase()
  if (!word) throw new Error('Empty word')

  const cached = readCache(word)
  if (cached) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res
  try {
    res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      { signal: controller.signal }
    )
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('timeout')
      e.code = 'timeout'
      throw e
    }
    const e = new Error('network')
    e.code = 'network'
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 404) {
    const err = new Error('not_found')
    err.code = 'not_found'
    throw err
  }
  if (!res.ok) {
    const err = new Error(`API error: ${res.status}`)
    err.code = 'api_error'
    throw err
  }

  const data = await res.json()
  writeCache(word, data)
  return data
}
