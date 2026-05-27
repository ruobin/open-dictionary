import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { loadUserData, saveUserData } from '../api/userData.js'

const MAX_HISTORY = 30
const SAVE_DEBOUNCE_MS = 500

export function useUserData() {
  const { isAuthenticated, isLoading, getAccessTokenSilently, user } = useAuth0()
  const [data, setData] = useState({ history: [], favorites: [] })
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef(null)
  const skipNextSave = useRef(true)

  const getAccessToken = useCallback(
    () => getAccessTokenSilently(),
    [getAccessTokenSilently]
  )

  useEffect(() => {
    if (isLoading) return
    let cancelled = false
    skipNextSave.current = true
    setLoaded(false)
    loadUserData({ isAuthenticated, getAccessToken }).then((d) => {
      if (cancelled) return
      setData(d)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [isLoading, isAuthenticated, user?.sub, getAccessToken])

  useEffect(() => {
    if (!loaded) return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveUserData(data, { isAuthenticated, getAccessToken })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [data, loaded, isAuthenticated, getAccessToken])

  const addToHistory = useCallback((word) => {
    const w = word.trim().toLowerCase()
    if (!w) return
    setData((prev) => ({
      ...prev,
      history: [w, ...prev.history.filter((x) => x !== w)].slice(0, MAX_HISTORY),
    }))
  }, [])

  const toggleFavorite = useCallback((word) => {
    const w = word.trim().toLowerCase()
    if (!w) return
    setData((prev) => {
      const has = prev.favorites.includes(w)
      return {
        ...prev,
        favorites: has
          ? prev.favorites.filter((x) => x !== w)
          : [w, ...prev.favorites],
      }
    })
  }, [])

  const isFavorite = useCallback(
    (word) => data.favorites.includes(word.trim().toLowerCase()),
    [data.favorites]
  )

  return {
    history: data.history,
    favorites: data.favorites,
    addToHistory,
    toggleFavorite,
    isFavorite,
  }
}
