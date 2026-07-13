import type { FavoriteKey } from '../../../shared/favorites'
import { API_BASE } from '../shared/config'
import type { HistoryResponse } from '../shared/messages'
import { getAccessToken, getValidAuth } from './authClient'

/**
 * Lookup history (Phase 9). Mirrors `src/api/userData.ts` + `useUserData.ts`
 * in the main web app: anonymous history is kept locally (`localStorage`
 * there, `chrome.storage.local` here — service workers have no
 * `localStorage`), and once signed in it's synced to the same
 * `/api/user-data` endpoint the web app uses, keyed by the same verified
 * JWT `sub` server-side (`server/app.ts`) — no backend change needed.
 */

const ANON_HISTORY_KEY = 'history:anon'
const MAX_HISTORY = 30

function coerceHistory(parsed: unknown): FavoriteKey[] {
  if (!parsed || typeof parsed !== 'object') return []
  const raw = (parsed as Record<string, unknown>).history
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry): FavoriteKey | null => {
      if (!entry || typeof entry !== 'object') return null
      const e = entry as Record<string, unknown>
      const word = typeof e.word === 'string' ? e.word.trim().toLowerCase() : ''
      const sourceLang = typeof e.sourceLang === 'string' ? e.sourceLang.trim().toLowerCase() : ''
      const targetLang = typeof e.targetLang === 'string' ? e.targetLang.trim().toLowerCase() : ''
      if (!word || !sourceLang || !targetLang) return null
      return { word, sourceLang, targetLang }
    })
    .filter((x): x is FavoriteKey => x !== null)
}

async function readAnonHistory(): Promise<FavoriteKey[]> {
  const stored = await chrome.storage.local.get(ANON_HISTORY_KEY)
  return coerceHistory({ history: stored[ANON_HISTORY_KEY] })
}

async function writeAnonHistory(history: FavoriteKey[]): Promise<void> {
  await chrome.storage.local.set({ [ANON_HISTORY_KEY]: history })
}

function withEntry(history: FavoriteKey[], entry: FavoriteKey): FavoriteKey[] {
  const w = entry.word.trim().toLowerCase()
  const s = entry.sourceLang.trim().toLowerCase()
  const t = entry.targetLang.trim().toLowerCase()
  if (!w) return history
  const filtered = history.filter((x) => !(x.word === w && x.sourceLang === s && x.targetLang === t))
  return [{ word: w, sourceLang: s, targetLang: t }, ...filtered].slice(0, MAX_HISTORY)
}

export async function getHistory(): Promise<HistoryResponse> {
  const auth = await getValidAuth()
  if (!auth) return { ok: true, history: await readAnonHistory() }

  try {
    const res = await fetch(`${API_BASE}/api/user-data`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })
    if (!res.ok) return { ok: false, error: res.status === 401 ? 'unauthorized' : 'api_error' }
    return { ok: true, history: coerceHistory(await res.json()) }
  } catch {
    return { ok: false, error: 'network' }
  }
}

/** Appends `entry` to history (most-recent-first, de-duped, capped at
 *  `MAX_HISTORY`) and persists it — locally if signed out, to
 *  `/api/user-data` if signed in. */
export async function addHistory(entry: FavoriteKey): Promise<HistoryResponse> {
  const token = await getAccessToken()
  if (!token) {
    const next = withEntry(await readAnonHistory(), entry)
    await writeAnonHistory(next)
    return { ok: true, history: next }
  }

  try {
    const current = await getHistory()
    const currentHistory = current.ok ? current.history : []
    const next = withEntry(currentHistory, entry)
    const res = await fetch(`${API_BASE}/api/user-data`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: next }),
    })
    if (!res.ok) return { ok: false, error: res.status === 401 ? 'unauthorized' : 'api_error' }
    return { ok: true, history: next }
  } catch {
    return { ok: false, error: 'network' }
  }
}
