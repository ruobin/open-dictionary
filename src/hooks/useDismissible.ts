import { useState } from 'react'

/**
 * Tracks whether a one-off dismissible UI element (e.g. a promo banner) has
 * been dismissed, persisting the choice in localStorage under `key` so it
 * stays dismissed across reloads/sessions. Mirrors the read/write-with-
 * try/catch idiom in useTheme.ts (localStorage may be unavailable — private
 * browsing, disabled storage, etc. — in which case the element just shows
 * every time rather than throwing).
 */
export function useDismissible(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })

  const dismiss = (): void => {
    setDismissed(true)
    try {
      localStorage.setItem(key, '1')
    } catch {
      // ignore write failure
    }
  }

  return [dismissed, dismiss]
}
