import type { DictionaryEntry } from '../types'
import type { ExtensionErrorCode, LookupResponse } from '../shared/messages'
import { API_BASE } from '../shared/config'

/**
 * Response cache + fetch client for `/api/translate/:text`. Mirrors
 * `src/api/dictionary.ts` in the main web app (same envelope shape, same
 * TTL, same cache key), but backed by `chrome.storage.local` instead of
 * `localStorage` — service workers have no `window`/`localStorage` (design
 * doc §8).
 */

const CACHE_PREFIX = 'dict:v1:'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30000

interface CacheEnvelope {
  data: DictionaryEntry[]
  fetchedAt: number
}

function cacheKey(storageKey: string): string {
  return CACHE_PREFIX + storageKey
}

async function readCache(storageKey: string): Promise<DictionaryEntry[] | null> {
  try {
    const key = cacheKey(storageKey)
    const stored = await chrome.storage.local.get(key)
    const entry = stored[key] as CacheEnvelope | undefined
    if (!entry) return null
    if (Date.now() - entry.fetchedAt > TTL_MS) {
      await chrome.storage.local.remove(key)
      return null
    }
    return entry.data
  } catch {
    return null
  }
}

async function writeCache(storageKey: string, data: DictionaryEntry[]): Promise<void> {
  try {
    const key = cacheKey(storageKey)
    const envelope: CacheEnvelope = { data, fetchedAt: Date.now() }
    await chrome.storage.local.set({ [key]: envelope })
  } catch {
    // Quota or unavailable — ignore, matches the web app's fire-and-forget cache write.
  }
}

/** Looks up `rawWord` via the read-through cache → `/api/translate/:text`.
 *  Never throws — always resolves to a `LookupResponse` discriminated union
 *  so callers (the background message router) can forward it as-is. */
export async function lookupWord(
  rawWord: string,
  sourceLang: string,
  targetLang: string
): Promise<LookupResponse> {
  const word = rawWord.trim().toLowerCase()
  if (!word) return { ok: false, error: 'not_found' }

  const src = sourceLang.toLowerCase()
  const tgt = targetLang.toLowerCase()
  const storageKey = `${src}:${tgt}:${word}`

  const cached = await readCache(storageKey)
  if (cached) return { ok: true, entries: cached }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const qs = new URLSearchParams({ from: src, to: tgt })

  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/translate/${encodeURIComponent(word)}?${qs.toString()}`, {
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const error: ExtensionErrorCode = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network'
    return { ok: false, error }
  }
  clearTimeout(timer)

  if (res.status === 404) return { ok: false, error: 'not_found' }
  if (res.status === 429) return { ok: false, error: 'rate_limited' }
  if (!res.ok) return { ok: false, error: 'api_error' }

  const data = (await res.json()) as DictionaryEntry[]
  await writeCache(storageKey, data)
  return { ok: true, entries: data }
}
