import { useAuth0 } from '@auth0/auth0-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TokenGetter } from '../api/usage'

/** How long the first lookup on a fresh page load waits for Auth0 to finish loading. */
const AUTH_WAIT_MS = 1_000

/**
 * A stable access-token getter for public API calls that meter by account
 * (docs/design-llm-usage-quotas.md §5.2). `authReady` turns true once Auth0
 * has loaded, or after about a second: without the wait, a signed-in user's
 * first lookup after a page load would go out anonymous.
 */
export function useAccessToken(): { getToken: TokenGetter; authReady: boolean; isAuthenticated: boolean } {
  const { isAuthenticated, isLoading, getAccessTokenSilently } = useAuth0()
  const latest = useRef({ isAuthenticated, getAccessTokenSilently })
  useEffect(() => {
    latest.current = { isAuthenticated, getAccessTokenSilently }
  }, [isAuthenticated, getAccessTokenSilently])

  const [authReady, setAuthReady] = useState(!isLoading)
  useEffect(() => {
    if (!isLoading) {
      setAuthReady(true)
      return
    }
    const timer = setTimeout(() => setAuthReady(true), AUTH_WAIT_MS)
    return () => clearTimeout(timer)
  }, [isLoading])

  const getToken = useCallback<TokenGetter>(async () => {
    const { isAuthenticated: signedIn, getAccessTokenSilently: get } = latest.current
    if (!signedIn) return null
    try {
      return await get()
    } catch {
      return null
    }
  }, [])

  return { getToken, authReady, isAuthenticated }
}
