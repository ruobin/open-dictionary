import { useCallback, useEffect, useState } from 'react'
import { useAdminOutletContext } from './AdminLayout'
import { listBenchmarkHistory, listProviders, type BenchmarkHistoryView, type ProviderView } from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'
import BenchmarkForm from '../../components/admin/BenchmarkForm'
import BenchmarkResults from '../../components/admin/BenchmarkResults'
import Sparkline from '../../components/admin/Sparkline'

export default function Latency() {
  const { auth } = useAdminOutletContext()
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [history, setHistory] = useState<BenchmarkHistoryView[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reloadHistory = useCallback(() => {
    listBenchmarkHistory(auth, { limit: 20 })
      .then(setHistory)
      .catch((err) => setError(describeApiError(err)))
  }, [auth])

  useEffect(() => {
    listProviders(auth).then(setProviders).catch((err) => setError(describeApiError(err)))
    reloadHistory()
  }, [auth, reloadHistory])

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Latency lab</h1>
      </div>
      {error && <div className="state-msg state-error">{error}</div>}

      <BenchmarkForm auth={auth} providers={providers} onStarted={setActiveRunId} />

      {activeRunId && <BenchmarkResults auth={auth} runId={activeRunId} onDone={reloadHistory} />}

      <section className="admin-card">
        <h2>History</h2>
        <p className="admin-hint">Scheduled probes are off by default — this history reflects on-demand runs only.</p>
        {history.length === 0 ? (
          <p className="admin-empty">No benchmark runs yet.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr><th>Run</th><th>When</th><th>Targets</th><th>Best p50</th><th>Trend</th></tr>
            </thead>
            <tbody>
              {history.map((run) => {
                const best = run.targets.reduce<number | null>(
                  (min, t) => (min === null || t.summary.p50 < min ? t.summary.p50 : min),
                  null
                )
                const allMs = run.targets.flatMap((t) => t.runs.map((r) => r.ms))
                return (
                  <tr key={run.runId}>
                    <td>{run.runId.slice(0, 8)}</td>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{run.targets.map((t) => `${t.providerName}/${t.model}`).join(', ')}</td>
                    <td>{best !== null ? `${best} ms` : '—'}</td>
                    <td><Sparkline values={allMs} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
