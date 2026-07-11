import { useCallback, useEffect, useState } from 'react'
import { useAdminOutletContext } from './AdminLayout'
import { listAudit, type AuditEntry } from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'
import AuditTable from '../../components/admin/AuditTable'

const PAGE_SIZE = 50

export default function Audit() {
  const { auth } = useAdminOutletContext()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)

  const load = useCallback(
    (before?: string) => {
      setLoading(true)
      listAudit(auth, { limit: PAGE_SIZE, before })
        .then((page) => {
          setEntries((prev) => (before ? [...prev, ...page] : page))
          setHasMore(page.length === PAGE_SIZE)
          setError(null)
        })
        .catch((err) => setError(describeApiError(err)))
        .finally(() => setLoading(false))
    },
    [auth]
  )

  useEffect(() => {
    load()
  }, [load])

  function loadMore(): void {
    const last = entries[entries.length - 1]
    if (last) load(last.ts)
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Audit log</h1>
      </div>
      <p className="admin-hint">Entries are kept for 365 days, then purged automatically.</p>
      {error && <div className="state-msg state-error">{error}</div>}
      <AuditTable entries={entries} />
      {hasMore && (
        <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
