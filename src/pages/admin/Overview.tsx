import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAdminOutletContext } from './AdminLayout'
import {
  getMetrics,
  listAudit,
  listProviders,
  getReportsSummary,
  type AuditEntry,
  type MetricsSnapshot,
  type ProviderView,
  type ReportsSummary,
} from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'
import ActiveSwitcher from '../../components/admin/ActiveSwitcher'

export default function Overview() {
  const { auth, status, refreshStatus } = useAdminOutletContext()
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [recentAudit, setRecentAudit] = useState<AuditEntry[]>([])
  const [reportsSummary, setReportsSummary] = useState<ReportsSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(() => {
    setLoading(true)
    Promise.all([getMetrics(auth), listProviders(auth), listAudit(auth, { limit: 8 }), getReportsSummary(auth)])
      .then(([m, p, a, r]) => {
        setMetrics(m)
        setProviders(p)
        setRecentAudit(a)
        setReportsSummary(r)
        setError(null)
      })
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoading(false))
  }, [auth])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  function handleRefresh(): void {
    refreshStatus()
    loadAll()
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Overview</h1>
        <button type="button" className="btn btn-ghost" onClick={handleRefresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="state-msg state-error">{error}</div>}

      <section className="admin-card">
        <h2>Active provider{status?.secondaryProviderId ? 's (fusion)' : ''}</h2>
        <ActiveSwitcher auth={auth} status={status} providers={providers} onChanged={handleRefresh} />
        {status?.secondaryProviderId && (
          <p className="admin-hint">
            Fusion mode: every uncached lookup calls the primary and secondary in parallel and merges their results.
            {status.secondaryProviderName && status.secondaryModel
              ? ` Secondary: ${status.secondaryProviderName} · ${status.secondaryModel}.`
              : ''}
          </p>
        )}
      </section>

      {reportsSummary && (
        <section className="admin-card">
          <div className="admin-card-header-row">
            <h2>Reports</h2>
            <Link to="/admin/reports">View all reports →</Link>
          </div>
          <div className="admin-stat-grid">
            <Stat label="Open reports" value={reportsSummary.total} />
            <Stat label="Distinct reported entries" value={reportsSummary.byWordCount.length} />
          </div>
        </section>
      )}

      {metrics && (
        <section className="admin-card">
          <h2>Traffic (since process start)</h2>
          <div className="admin-stat-grid">
            <Stat label="Total lookups" value={metrics.totalLookups} />
            <Stat label="Cache" value={metrics.outcomeByTier.cache ?? 0} />
            <Stat label="LLM" value={metrics.outcomeByTier.llm ?? 0} />
            <Stat label="Dictionary fallback" value={metrics.outcomeByTier.dictionary ?? 0} />
            <Stat label="Fallback rate" value={`${(metrics.fallbackRate * 100).toFixed(1)}%`} />
          </div>

          <h3>Per-vendor latency</h3>
          <table className="admin-table">
            <thead>
              <tr><th>Vendor</th><th>p50</th><th>p95</th><th>p99</th><th>Samples</th></tr>
            </thead>
            <tbody>
              {Object.entries(metrics.llmLatencyByVendor).map(([vendor, stats]) => (
                <tr key={vendor}>
                  <td>{vendor}</td>
                  <td>{stats.p50} ms</td>
                  <td>{stats.p95} ms</td>
                  <td>{stats.p99} ms</td>
                  <td>{stats.count}</td>
                </tr>
              ))}
              {Object.keys(metrics.llmLatencyByVendor).length === 0 && (
                <tr><td colSpan={5} className="admin-table-empty">No LLM calls yet</td></tr>
              )}
            </tbody>
          </table>

          {Object.keys(metrics.llmErrorsByVendorAndCode).length > 0 && (
            <>
              <h3>Errors by vendor/code</h3>
              <ul className="admin-error-list">
                {Object.entries(metrics.llmErrorsByVendorAndCode).map(([key, count]) => (
                  <li key={key}>{key} — {count}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="admin-card">
        <div className="admin-card-header-row">
          <h2>Recent activity</h2>
          <Link to="/admin/audit">View full log →</Link>
        </div>
        {recentAudit.length === 0 ? (
          <p className="admin-empty">No audit entries yet.</p>
        ) : (
          <ul className="admin-activity-list">
            {recentAudit.map((entry) => (
              <li key={entry.id}>
                <span className="admin-activity-action">{entry.action}</span>
                <span className="admin-activity-target">
                  {entry.target?.name ?? entry.target?.providerId ?? entry.target?.runId ?? ''}
                </span>
                <span className="admin-activity-actor">{entry.actor}</span>
                <time className="admin-activity-time">{new Date(entry.ts).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="admin-stat">
      <div className="admin-stat-value">{value}</div>
      <div className="admin-stat-label">{label}</div>
    </div>
  )
}
