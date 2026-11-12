import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { fetchUsage, onUsageChanged, type TokenGetter, type UsageView } from '../api/usage'
import { useAccessToken } from './useAccessToken'

/**
 * The caller's usage (`GET /api/usage/me`), shared by every component that
 * shows it. Refetched when sign-in state changes and whenever a lookup
 * reports that a new word was charged.
 */

interface UsageSnapshot {
  usage: UsageView | null
  loaded: boolean
}

let snapshot: UsageSnapshot = { usage: null, loaded: false }
const subscribers = new Set<() => void>()
let inflight: Promise<void> | null = null
let queued = false
let lastLoadedAt = 0

function publish(next: UsageSnapshot): void {
  snapshot = next
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

function refreshUsage(getToken: TokenGetter, force: boolean): Promise<void> {
  // Several components mounting at once shouldn't each fetch.
  if (!force && Date.now() - lastLoadedAt < 2_000) return Promise.resolve()
  if (inflight) {
    queued = force || queued
    return inflight
  }
  inflight = (async () => {
    do {
      queued = false
      const usage = await fetchUsage(getToken)
      lastLoadedAt = Date.now()
      publish({ usage, loaded: true })
    } while (queued)
  })().finally(() => {
    inflight = null
  })
  return inflight
}

export function useUsage(): UsageSnapshot & { refresh: () => Promise<void> } {
  const { getToken, authReady, isAuthenticated } = useAccessToken()
  const state = useSyncExternalStore(subscribe, () => snapshot)

  useEffect(() => {
    // Sign-in state changed: whatever we showed before belongs to someone else.
    if (authReady) void refreshUsage(getToken, true)
  }, [authReady, isAuthenticated, getToken])

  useEffect(
    () =>
      onUsageChanged(() => {
        void refreshUsage(getToken, true)
      }),
    [getToken]
  )

  const refresh = useCallback(() => refreshUsage(getToken, true), [getToken])
  return { ...state, refresh }
}
