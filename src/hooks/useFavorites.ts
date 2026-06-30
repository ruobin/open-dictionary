import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import type { FavoriteKey } from '../../shared/favorites'
import { addFavorite, listFavorites, removeFavorite } from '../api/favorites'

const PENDING_FAVORITE_KEY = 'pendingFavorite'

function sameFavorite(a: FavoriteKey, b: FavoriteKey): boolean {
  return a.word === b.word && a.sourceLang === b.sourceLang && a.targetLang === b.targetLang
}

function normalize(fav: FavoriteKey): FavoriteKey {
  return {
    word: fav.word.trim().toLowerCase(),
    sourceLang: fav.sourceLang.trim().toLowerCase(),
    targetLang: fav.targetLang.trim().toLowerCase(),
  }
}

function parseStoredFavorite(raw: string): FavoriteKey | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const f = parsed as Record<string, unknown>
    if (
      typeof f.word !== 'string' ||
      typeof f.sourceLang !== 'string' ||
      typeof f.targetLang !== 'string'
    ) {
      return null
    }
    return normalize({ word: f.word, sourceLang: f.sourceLang, targetLang: f.targetLang })
  } catch {
    return null
  }
}

/**
 * Favorites (MongoDB-backed). Anonymous users cannot favorite: `toggle` while
 * logged out stashes the request in sessionStorage and redirects to login.
 * Once the user returns authenticated, the pending favorite is applied and the
 * list is (re)loaded.
 */
export function useFavorites() {
  const { user, isAuthenticated, isLoading, loginWithRedirect } = useAuth0()
  const [favorites, setFavorites] = useState<FavoriteKey[]>([])

  useEffect(() => {
    if (isLoading || !isAuthenticated || !user?.sub) return
    let cancelled = false
    const sub = user.sub

    let pending: FavoriteKey | null = null
    try {
      const raw = sessionStorage.getItem(PENDING_FAVORITE_KEY)
      if (raw) {
        sessionStorage.removeItem(PENDING_FAVORITE_KEY)
        pending = parseStoredFavorite(raw)
      }
    } catch {
      // sessionStorage unavailable — ignore
    }

    const load = (): void => {
      listFavorites(sub)
        .then((favs) => {
          if (!cancelled) setFavorites(favs)
        })
        .catch(() => {
          if (!cancelled) setFavorites([])
        })
    }

    if (pending) {
      addFavorite(sub, pending).finally(load)
    } else {
      load()
    }

    return () => {
      cancelled = true
    }
  }, [isAuthenticated, isLoading, user?.sub])

  const isFavorite = useCallback(
    (fav: FavoriteKey) => favorites.some((f) => sameFavorite(f, normalize(fav))),
    [favorites]
  )

  const toggle = useCallback(
    (fav: FavoriteKey) => {
      if (!isAuthenticated) {
        // Stash the request, then send to login; it's applied on return.
        try {
          sessionStorage.setItem(PENDING_FAVORITE_KEY, JSON.stringify(normalize(fav)))
        } catch {
          // ignore
        }
        void loginWithRedirect({
          appState: { returnTo: window.location.pathname + window.location.search },
        })
        return
      }
      if (!user?.sub) return
      const sub = user.sub
      const key = normalize(fav)
      setFavorites((prev) => {
        const exists = prev.some((f) => sameFavorite(f, key))
        if (exists) {
          void removeFavorite(sub, key).catch(() => {})
          return prev.filter((f) => !sameFavorite(f, key))
        }
        void addFavorite(sub, key).catch(() => {})
        return [...prev, key]
      })
    },
    [isAuthenticated, user?.sub, loginWithRedirect]
  )

  return { favorites, isFavorite, toggle }
}
