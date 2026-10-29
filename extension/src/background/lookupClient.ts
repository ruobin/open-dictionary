import type { DictionaryEntry } from '../types'
import type { ExtensionErrorCode, LookupResponse } from '../shared/messages'
import { API_BASE } from '../shared/config'
import { readSse } from '../../../shared/sse'

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

/** Fire-and-forget client-cache hit beacon. Service workers prefer fetch+keepalive
 *  over sendBeacon (less reliably available on the extension SW global). */
function pingClientCacheHit(word: string, sourceLang: string, targetLang: string): void {
  const body = JSON.stringify({ word, sourceLang, targetLang })
  try {
    void fetch(`${API_BASE}/api/activity-ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // best-effort
    })
  } catch {
    // ignore
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
  if (cached) {
    pingClientCacheHit(word, src, tgt)
    return { ok: true, entries: cached }
  }

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

export interface StreamLookupOptions {
  /** Called with progressively more complete entries while the server is still
   *  writing the answer. */
  onPartial?: (entries: DictionaryEntry[]) => void
  /** Aborts the request (the card/popup that asked for it went away). */
  signal?: AbortSignal
}

/**
 * Like {@link lookupWord}, but reads `/api/translate-stream/:text` (Server-Sent
 * Events) so callers can show the translation and senses as the model writes
 * them. Mirrors `lookupWordStream` in the web app (`src/api/dictionary.ts`).
 *
 * Cache hits, and every failure of the streaming transport itself (an old
 * server without the route, a proxy that mangles event streams, a connection
 * cut before `done`), fall back to the plain endpoint — streaming is an
 * enhancement, never a new way to fail. Never throws.
 */
export async function lookupWordStream(
  rawWord: string,
  sourceLang: string,
  targetLang: string,
  options: StreamLookupOptions = {}
): Promise<LookupResponse> {
  const word = rawWord.trim().toLowerCase()
  if (!word) return { ok: false, error: 'not_found' }

  const src = sourceLang.toLowerCase()
  const tgt = targetLang.toLowerCase()
  const storageKey = `${src}:${tgt}:${word}`

  const cached = await readCache(storageKey)
  if (cached) {
    pingClientCacheHit(word, src, tgt)
    return { ok: true, entries: cached }
  }

  if (options.signal?.aborted) return { ok: false, error: 'network' }

  const controller = new AbortController()
  const onCallerAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, FETCH_TIMEOUT_MS)

  const qs = new URLSearchParams({ from: src, to: tgt })
  const abortedResult = (): LookupResponse => ({ ok: false, error: timedOut ? 'timeout' : 'network' })

  try {
    let res: Response
    try {
      res = await fetch(`${API_BASE}/api/translate-stream/${encodeURIComponent(word)}?${qs.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return abortedResult()
      return await lookupWord(rawWord, sourceLang, targetLang)
    }

    if (res.status === 429) return { ok: false, error: 'rate_limited' }
    const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    // A 404 here may just mean "this server has no stream route"; the plain
    // endpoint gives the authoritative answer (including a real not_found).
    if (!res.ok || !isSse || !res.body) return await lookupWord(rawWord, sourceLang, targetLang)

    let final: DictionaryEntry[] | null = null
    let failure: ExtensionErrorCode | null = null
    try {
      await readSse(res.body, ({ event, data }) => {
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          return
        }
        if (event === 'partial' && Array.isArray(payload)) {
          if (!options.signal?.aborted) options.onPartial?.(payload as DictionaryEntry[])
        } else if (event === 'done' && Array.isArray(payload)) {
          final = payload as DictionaryEntry[]
        } else if (event === 'error') {
          failure = (payload as { error?: string } | null)?.error === 'not_found' ? 'not_found' : 'api_error'
        }
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return abortedResult()
      // Connection dropped mid-stream: fall through to the plain endpoint below.
    }

    if (failure) return { ok: false, error: failure }
    if (final) {
      await writeCache(storageKey, final)
      return { ok: true, entries: final }
    }
    return await lookupWord(rawWord, sourceLang, targetLang)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}
