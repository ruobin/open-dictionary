import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAdminOutletContext } from './AdminLayout'
import {
  listReports,
  dismissReport,
  deleteEntry,
  type ReportListItemView,
} from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'

const PAGE_SIZE = 50

export default function Reports() {
  const { auth } = useAdminOutletContext()
  const [reports, setReports] = useState<ReportListItemView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(
    (before?: string) => {
      setLoading(true)
      listReports(auth, { limit: PAGE_SIZE, before })
        .then((page) => {
          setReports((prev) => (before ? [...prev, ...page.reports] : page.reports))
          setHasMore(page.hasMore)
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
    const last = reports[reports.length - 1]
    if (last) load(last.createdAt)
  }

  async function handleDismiss(report: ReportListItemView): Promise<void> {
    if (!window.confirm(`Dismiss this report for "${report.word}"? The cached entry is left untouched.`)) return
    setBusyId(report.id)
    setError(null)
    try {
      await dismissReport(auth, report.id)
      setReports((prev) => prev.filter((r) => r.id !== report.id))
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusyId(null)
    }
  }

  async function handleDeleteEntry(report: ReportListItemView): Promise<void> {
    if (!report.entryId) return
    if (!window.confirm(`Delete the cached entry for "${report.word}" (${report.sourceLang}→${report.targetLang})? This cannot be undone.`)) {
      return
    }
    setBusyId(report.id)
    setError(null)
    try {
      await deleteEntry(auth, report.entryId, { resolveReports: true })
      // Deleting the entry resolves every report against that (word, langs)
      // pair, not just this one — drop them all from the list locally.
      setReports((prev) =>
        prev.filter((r) => !(r.word === report.word && r.sourceLang === report.sourceLang && r.targetLang === report.targetLang))
      )
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Reports</h1>
      </div>
      <p className="admin-hint">
        Individual "Report this entry" submissions, newest first. Dismiss a report to clear it
        without touching the cache, or jump to the entry to inspect/delete it.
      </p>

      {error && <div className="state-msg state-error">{error}</div>}

      {loading && reports.length === 0 ? (
        <p className="admin-empty">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="admin-empty">No reports.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Word</th>
              <th>Langs</th>
              <th>Reason</th>
              <th>Reported</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id}>
                <td>{r.word}</td>
                <td>{r.sourceLang}→{r.targetLang}</td>
                <td>{r.reason || <span className="admin-hint">(no reason given)</span>}</td>
                <td title={r.createdAt}>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  <div className="admin-page-actions">
                    {r.entryId ? (
                      <Link
                        className="btn btn-ghost btn-sm"
                        to={`/admin/entries?word=${encodeURIComponent(r.word)}`}
                      >
                        View entry
                      </Link>
                    ) : (
                      <span className="admin-hint">entry gone</span>
                    )}
                    {r.entryId && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleDeleteEntry(r)}
                        disabled={busyId === r.id}
                      >
                        Delete entry
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDismiss(r)}
                      disabled={busyId === r.id}
                    >
                      Dismiss
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hasMore && (
        <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
