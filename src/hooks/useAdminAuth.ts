import { useCallback } from 'react'
import { useAuth0 } from '@auth0/auth0-react'

/** Same shape as `src/api/favorites.ts`'s auth param — satisfies `AdminAuth` structurally. */
export function useAdminAuth() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, getAccessTokenSilently } = useAuth0()
  const getAccessToken = useCallback(() => getAccessTokenSilently(), [getAccessTokenSilently])
  return { isAuthenticated, isLoading, user, loginWithRedirect, getAccessToken }
}
