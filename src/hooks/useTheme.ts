import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'theme'

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // localStorage unavailable — fall through to system default
  }
  return 'system'
}

/**
 * Resolve the effective theme ('light' | 'dark') for a choice. 'system'
 * defers to prefers-color-scheme. Returns a media-query listener hook so
 * system changes re-render.
 */
function useResolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  const prefersDark = usePrefersDark()
  if (choice === 'light') return 'light'
  if (choice === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readStored)
  const resolved = useResolvedTheme(choice)

  useEffect(() => {
    const root = document.documentElement
    // Only set an explicit attribute when the user has chosen — leaving it
    // unset lets the CSS media query drive the default (no FOUC on first
    // paint, and it tracks OS theme changes live).
    if (choice === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', choice)
    }
    try {
      localStorage.setItem(STORAGE_KEY, choice)
    } catch {
      // ignore write failure
    }
  }, [choice])

  // Cycle explicit themes only — skip system when it would be a visual no-op.
  // From system, go straight to the opposite visual state. From explicit
  // light/dark, toggle directly (never transition through system silently).
  const cycle = useCallback(() => {
    setChoice((c) => {
      if (c === 'system') return resolved === 'dark' ? 'light' : 'dark'
      return c === 'light' ? 'dark' : 'light'
    })
  }, [resolved])

  return { choice, resolved, setChoice, cycle }
}
