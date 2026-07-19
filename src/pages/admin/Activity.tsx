import { useCallback, useEffect, useState } from 'react'
import { useAdminOutletContext } from './AdminLayout'
import {
  listActivity,
  getActivitySummary,
  type ActivityLogView,
  type ActivitySummary,
} from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'

const PAGE_SIZE = 50
const WINDOW_OPTIONS = [7, 30, 90]

export default function Activity() {
  const { auth } = useAdminOutletContext()
  const [windowDays, setWindowDays] = useState(7)
  const [summary, setSummary] = useState<ActivitySummary | null>(null)
  const [entries, setEntries] = useState<ActivityLogView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)

  const loadEntries = useCallback(
    (before?: string) => {
      listActivity(auth, { limit: PAGE_SIZE, before })
        .then((page) => {
          setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries))
          setHasMore(page.hasMore)
        })
        .catch((err) => setError(describeApiError(err)))
    },
    [auth]
  )

  const loadAll = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([getActivitySummary(auth, windowDays), listActivity(auth, { limit: PAGE_SIZE })])
      .then(([s, page]) => {
        setSummary(s)
        setEntries(page.entries)
        setHasMore(page.hasMore)
      })
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoading(false))
  }, [auth, windowDays])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  function loadMore(): void {
    const last = entries[entries.length - 1]
    if (last) loadEntries(last.ts)
  }

  const maxDaily = summary ? Math.max(1, ...summary.dailyCounts.map((d) => d.count)) : 1

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Activity</h1>
        <div className="admin-page-actions">
          <label className="admin-field-inline">
            <span>Window:</span>
            <select
              className="admin-input"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
            >
              {WINDOW_OPTIONS.map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" onClick={loadAll} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <p className="admin-hint">
        Per-lookup activity log (word, IP, device) backing user-behavior and growth analytics.
        Entries are kept for 180 days, then purged automatically. See
        docs/design-user-activity-log.md.
      </p>

      {error && <div className="state-msg state-error">{error}</div>}

      {summary && (
        <>
          <section className="admin-card">
            <h2>Traffic (last {summary.windowDays} days)</h2>
            <div className="admin-stat-grid">
              <Stat label="Total lookups" value={summary.totalLookups} />
              <Stat label="Unique IPs" value={summary.uniqueIps} />
              {Object.entries(summary.byTier).map(([tier, count]) => (
                <Stat key={tier} label={tier} value={count} />
              ))}
            </div>
          </section>

          <div className="admin-activity-grid">
            <section className="admin-card">
              <h2>Top words</h2>
              {summary.topWords.length === 0 ? (
                <p className="admin-empty">No lookups in this window.</p>
              ) : (
                <table className="admin-table">
                  <thead><tr><th>Word</th><th>Count</th></tr></thead>
                  <tbody>
                    {summary.topWords.map((w) => (
                      <tr key={w.word}><td>{w.word}</td><td>{w.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="admin-card">
              <h2>By channel</h2>
              <table className="admin-table">
                <tbody>
                  {Object.entries(summary.byChannel).map(([channel, count]) => (
                    <tr key={channel}><td>{channel}</td><td>{count}</td></tr>
                  ))}
                  {Object.keys(summary.byChannel).length === 0 && (
                    <tr><td colSpan={2} className="admin-table-empty">No data</td></tr>
                  )}
                </tbody>
              </table>
            </section>

            <section className="admin-card">
              <h2>By device</h2>
              <table className="admin-table">
                <tbody>
                  {Object.entries(summary.byDeviceType).map(([type, count]) => (
                    <tr key={type}><td>{type}</td><td>{count}</td></tr>
                  ))}
                  {Object.keys(summary.byDeviceType).length === 0 && (
                    <tr><td colSpan={2} className="admin-table-empty">No data</td></tr>
                  )}
                </tbody>
              </table>
            </section>
          </div>

          <section className="admin-card">
            <h2>Daily lookups</h2>
            <ul className="admin-daily-bars">
              {summary.dailyCounts.map((d) => (
                <li key={d.date}>
                  <span className="admin-daily-bar-date">{d.date}</span>
                  <span className="admin-daily-bar-track">
                    <span
                      className="admin-daily-bar-fill"
                      style={{ width: `${(d.count / maxDaily) * 100}%` }}
                    />
                  </span>
                  <span className="admin-daily-bar-count">{d.count}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section className="admin-card">
        <h2>Recent lookups</h2>
        {entries.length === 0 ? (
          <p className="admin-empty">No activity yet.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Time</th><th>Word</th><th>Langs</th><th>Tier</th>
                <th>Latency</th><th>Device</th><th>Channel</th><th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td title={e.ts}>{new Date(e.ts).toLocaleString()}</td>
                  <td>{e.word}</td>
                  <td>{e.sourceLang}→{e.targetLang}</td>
                  <td>{e.tier}</td>
                  <td>{e.latencyMs} ms</td>
                  <td>{e.device.type}{e.device.browser ? ` / ${e.device.browser}` : ''}</td>
                  <td>{e.channel}</td>
                  <td>{e.ip}</td>
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
