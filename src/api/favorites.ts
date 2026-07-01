import type { FavoriteKey } from '../../shared/favorites'

export interface FavoritesAuth {
  getAccessToken: () => Promise<string>
}

function isFavoriteKey(x: unknown): x is FavoriteKey {
  if (!x || typeof x !== 'object') return false
  const f = x as Record<string, unknown>
  return typeof f.word === 'string' && typeof f.sourceLang === 'string' && typeof f.targetLang === 'string'
}

// Identity is derived server-side from the verified Auth0 JWT, so the client
// only needs to attach the access token (never sends a user id itself).
export async function listFavorites(auth: FavoritesAuth): Promise<FavoriteKey[]> {
  const token = await auth.getAccessToken()
  const res = await fetch('/api/favorites', { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Server ${res.status}`)
  const data = (await res.json()) as unknown
  return Array.isArray(data) ? data.filter(isFavoriteKey) : []
}

export async function addFavorite(auth: FavoritesAuth, fav: FavoriteKey): Promise<void> {
  const token = await auth.getAccessToken()
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fav),
  })
  if (!res.ok) throw new Error(`Server ${res.status}`)
}

export async function removeFavorite(auth: FavoritesAuth, fav: FavoriteKey): Promise<void> {
  const token = await auth.getAccessToken()
  const qs = new URLSearchParams({ word: fav.word, from: fav.sourceLang, to: fav.targetLang })
  const res = await fetch(`/api/favorites?${qs.toString()}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Server ${res.status}`)
}
