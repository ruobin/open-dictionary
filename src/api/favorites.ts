import type { FavoriteKey } from '../../shared/favorites'

function isFavoriteKey(x: unknown): x is FavoriteKey {
  if (!x || typeof x !== 'object') return false
  const f = x as Record<string, unknown>
  return typeof f.word === 'string' && typeof f.sourceLang === 'string' && typeof f.targetLang === 'string'
}

export async function listFavorites(userKey: string): Promise<FavoriteKey[]> {
  const res = await fetch('/api/favorites', { headers: { 'X-User-Key': userKey } })
  if (!res.ok) throw new Error(`Server ${res.status}`)
  const data = (await res.json()) as unknown
  return Array.isArray(data) ? data.filter(isFavoriteKey) : []
}

export async function addFavorite(userKey: string, fav: FavoriteKey): Promise<void> {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'X-User-Key': userKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(fav),
  })
  if (!res.ok) throw new Error(`Server ${res.status}`)
}

export async function removeFavorite(userKey: string, fav: FavoriteKey): Promise<void> {
  const qs = new URLSearchParams({ word: fav.word, from: fav.sourceLang, to: fav.targetLang })
  const res = await fetch(`/api/favorites?${qs.toString()}`, {
    method: 'DELETE',
    headers: { 'X-User-Key': userKey },
  })
  if (!res.ok) throw new Error(`Server ${res.status}`)
}
