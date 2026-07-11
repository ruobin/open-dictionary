import { useEffect, type ReactNode } from 'react'
import { useAdminAuth } from '../../hooks/useAdminAuth'

interface RequireAdminProps {
  children: ReactNode
}

/**
 * Auth gate only (docs/design-admin-portal.md §10.1 — "cosmetic only, the API
 * enforces"). Under the allowlist-only authorization model there's no
 * `permissions` claim to check client-side, so this only gates on being
 * logged in at all; an authenticated-but-not-allowlisted user reaches
 * AdminLayout, whose first status call 403s and renders the "not authorized"
 * state there instead.
 */
export default function RequireAdmin({ children }: RequireAdminProps) {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAdminAuth()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void loginWithRedirect({ appState: { returnTo: '/admin' } })
    }
  }, [isLoading, isAuthenticated, loginWithRedirect])

  if (isLoading || !isAuthenticated) {
    return <div className="admin-shell state-msg">Loading…</div>
  }

  return <>{children}</>
}
