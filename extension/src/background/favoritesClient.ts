import type { FavoriteKey } from '../../../shared/favorites'
import { API_BASE } from '../shared/config'
import type { ExtensionErrorCode, FavoritesResponse } from '../shared/messages'
import { getAccessToken } from './authClient'

/**
 * Favorites sync (Phase 9). Mirrors `src/api/favorites.ts` in the main web
 * app — same `/api/favorites` endpoints, same envelope — just against
 * `API_BASE` instead of a same-origin relative URL, and using the
 * extension's own `chrome.identity`-based access token instead of
 * `useAuth0()`'s `getAccessTokenSilently()`.
 */

function isFavoriteKey(x: unknown): x is FavoriteKey {
  if (!x || typeof x !== 'object') return false
  const f = x as Record<string, unknown>
  return typeof f.word === 'string' && typeof f.sourceLang === 'string' && typeof f.targetLang === 'string'
}

function mapStatus(status: number): ExtensionErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  return 'api_error'
}

export async function listFavorites(): Promise<FavoritesResponse> {
  const token = await getAccessToken()
  if (!token) return { ok: false, error: 'unauthorized' }
  try {
    const res = await fetch(`${API_BASE}/api/favorites`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { ok: false, error: mapStatus(res.status) }
    const data = (await res.json()) as unknown
    return { ok: true, favorites: Array.isArray(data) ? data.filter(isFavoriteKey) : [] }
  } catch {
    return { ok: false, error: 'network' }
  }
}

export async function addFavorite(favorite: FavoriteKey): Promise<FavoritesResponse> {
  const token = await getAccessToken()
  if (!token) return { ok: false, error: 'unauthorized' }
  try {
    const res = await fetch(`${API_BASE}/api/favorites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(favorite),
    })
    if (!res.ok) return { ok: false, error: mapStatus(res.status) }
    return listFavorites()
  } catch {
    return { ok: false, error: 'network' }
  }
}

export async function removeFavorite(favorite: FavoriteKey): Promise<FavoritesResponse> {
  const token = await getAccessToken()
  if (!token) return { ok: false, error: 'unauthorized' }
  try {
    const qs = new URLSearchParams({
      word: favorite.word,
      from: favorite.sourceLang,
      to: favorite.targetLang,
    })
    const res = await fetch(`${API_BASE}/api/favorites?${qs.toString()}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { ok: false, error: mapStatus(res.status) }
    return listFavorites()
  } catch {
    return { ok: false, error: 'network' }
  }
}
