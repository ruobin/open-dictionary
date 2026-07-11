import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { useAdminAuth } from '../../hooks/useAdminAuth'
import { getStatus, AdminApiError, type AdminAuth, type AdminLlmStatus } from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'

export interface AdminOutletContext {
  auth: AdminAuth
  status: AdminLlmStatus | null
  refreshStatus: () => void
}

export function useAdminOutletContext(): AdminOutletContext {
  return useOutletContext<AdminOutletContext>()
}

export default function AdminLayout() {
  const { user, getAccessToken } = useAdminAuth()
  const auth: AdminAuth = useMemo(() => ({ getAccessToken }), [getAccessToken])
  const [status, setStatus] = useState<AdminLlmStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)

  const refreshStatus = useCallback(() => {
    setLoading(true)
    getStatus(auth)
      .then((s) => {
        setStatus(s)
        setLoadError(null)
        setForbidden(false)
      })
      .catch((err) => {
        if (err instanceof AdminApiError && err.status === 403) {
          setForbidden(true)
        } else {
          setLoadError(describeApiError(err))
        }
      })
      .finally(() => setLoading(false))
  }, [auth])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const outletContext: AdminOutletContext = useMemo(
    () => ({ auth, status, refreshStatus }),
    [auth, status, refreshStatus]
  )

  if (forbidden) {
    return (
      <div className="admin-shell admin-shell-blocked">
        <div className="state-msg state-error">
          Signed in as {user?.email ?? 'this account'}, but it is not on the admin allowlist.
        </div>
      </div>
    )
  }

  if (loading && !status) {
    return <div className="admin-shell state-msg">Loading admin…</div>
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-topbar-title">
          <NavLink to="/admin">Admin</NavLink>
          <span className="admin-topbar-sep">/</span>
          <StatusBadge status={status} />
        </div>
        <nav className="admin-nav">
          <NavLink to="/admin" end>Overview</NavLink>
          <NavLink to="/admin/providers">Providers</NavLink>
          <NavLink to="/admin/latency">Latency lab</NavLink>
          <NavLink to="/admin/audit">Audit log</NavLink>
        </nav>
        <div className="admin-topbar-user">{user?.email}</div>
      </header>

      {loadError && <div className="state-msg state-error">{loadError}</div>}

      <main className="admin-main">
        <Outlet context={outletContext} />
      </main>
    </div>
  )
}

function StatusBadge({ status }: { status: AdminLlmStatus | null }) {
  if (!status) return null
  const label =
    status.status === 'active'
      ? `Active — ${status.providerName ?? status.vendor ?? 'unknown'} (${status.source})`
      : status.status === 'disabled'
        ? 'No provider active'
        : `Misconfigured — ${status.message}`
  return <span className={`admin-status-badge admin-status-${status.status}`}>{label}</span>
}
