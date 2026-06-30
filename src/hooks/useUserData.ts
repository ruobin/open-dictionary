import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { loadUserData, saveUserData } from '../api/userData'

const MAX_HISTORY = 30
const SAVE_DEBOUNCE_MS = 500

export function useUserData() {
  const { isAuthenticated, isLoading, getAccessTokenSilently, user } = useAuth0()
  const [history, setHistory] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNextSave = useRef(true)

  const getAccessToken = useCallback(() => getAccessTokenSilently(), [getAccessTokenSilently])

  useEffect(() => {
    if (isLoading) return
    let cancelled = false
    skipNextSave.current = true
    setLoaded(false)
    loadUserData({ isAuthenticated, getAccessToken }).then((d) => {
      if (cancelled) return
      setHistory(d.history)
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
      void saveUserData({ history }, { isAuthenticated, getAccessToken })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [history, loaded, isAuthenticated, getAccessToken])

  const addToHistory = useCallback((word: string) => {
    const w = word.trim().toLowerCase()
    if (!w) return
    setHistory((prev) => [w, ...prev.filter((x) => x !== w)].slice(0, MAX_HISTORY))
  }, [])

  return { history, addToHistory }
}
