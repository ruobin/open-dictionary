import { useEffect, useRef, useState } from 'react'
import { getBenchmarkJob, type AdminAuth, type BenchmarkJob } from '../../api/admin'
import Sparkline from './Sparkline'

interface BenchmarkResultsProps {
  auth: AdminAuth
  runId: string
  onDone?: () => void
}

const POLL_MS = 1500

export default function BenchmarkResults({ auth, runId, onDone }: BenchmarkResultsProps) {
  const [job, setJob] = useState<BenchmarkJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll(): Promise<void> {
      try {
        const j = await getBenchmarkJob(auth, runId)
        if (cancelled) return
        if (!j) {
          setError('Benchmark run not found (it may have expired).')
          return
        }
        setJob(j)
        if (j.status === 'running') {
          timer = setTimeout(poll, POLL_MS)
        } else {
          onDoneRef.current?.()
        }
      } catch {
        if (!cancelled) setError('Lost connection to the benchmark run.')
      }
    }
    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [auth, runId])

  if (error) return <p className="admin-test-fail">{error}</p>
  if (!job) return <p className="admin-empty">Starting…</p>

  return (
    <div className="admin-card">
      <div className="admin-card-header-row">
        <h2>Run {job.runId.slice(0, 8)}</h2>
        <span className="admin-hint">
          {job.status === 'running' ? `${job.completed}/${job.total} complete` : job.status}
        </span>
      </div>
      {job.error && <p className="admin-test-fail">{job.error}</p>}
      <table className="admin-table">
        <thead>
          <tr><th>Target</th><th>p50</th><th>Mean</th><th>Min</th><th>Max</th><th>Success</th><th>Trend</th></tr>
        </thead>
        <tbody>
          {job.partial.map((t) => (
            <tr key={`${t.providerId}::${t.model}`}>
              <td>{t.providerName} · {t.model}</td>
              <td>{t.summary.p50} ms</td>
              <td>{t.summary.mean} ms</td>
              <td>{t.summary.min} ms</td>
              <td>{t.summary.max} ms</td>
              <td>{(t.summary.successRate * 100).toFixed(0)}%</td>
              <td><Sparkline values={t.runs.map((r) => r.ms)} /></td>
            </tr>
          ))}
          {job.partial.length === 0 && (
            <tr><td colSpan={7} className="admin-table-empty">Waiting for first results…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
