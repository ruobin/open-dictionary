import { useState } from 'react'
import { startBenchmark, type AdminAuth, type ProviderView } from '../../api/admin'
import { describeApiError } from './adminErrors'

interface BenchmarkFormProps {
  auth: AdminAuth
  providers: ProviderView[]
  onStarted: (runId: string) => void
}

interface TargetOption {
  providerId: string
  modelId: string
  label: string
}

const MAX_TARGETS = 10
const MAX_SAMPLES = 10

export default function BenchmarkForm({ auth, providers, onStarted }: BenchmarkFormProps) {
  const options: TargetOption[] = providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ providerId: p.id, modelId: m.id, label: `${p.name} · ${m.label || m.id}` })))

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [samples, setSamples] = useState(5)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else if (next.size < MAX_TARGETS) next.add(key)
      return next
    })
  }

  async function handleRun(): Promise<void> {
    if (selected.size === 0) {
      setError('Pick at least one provider/model to benchmark')
      return
    }
    setStarting(true)
    setError(null)
    try {
      const targets = Array.from(selected).map((key) => {
        const [providerId, modelId] = key.split('::')
        return { providerId, modelId }
      })
      const res = await startBenchmark(auth, { targets, samples })
      onStarted(res.runId)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="admin-card">
      <h2>Run a benchmark</h2>
      {options.length === 0 ? (
        <p className="admin-empty">Add an enabled provider first.</p>
      ) : (
        <>
          <div className="admin-target-grid">
            {options.map((o) => {
              const key = `${o.providerId}::${o.modelId}`
              return (
                <label key={key} className="admin-field-inline">
                  <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                  <span>{o.label}</span>
                </label>
              )
            })}
          </div>
          <label className="admin-field admin-field-narrow">
            <span>Samples per target (1–{MAX_SAMPLES})</span>
            <input
              type="number"
              className="admin-input admin-input-narrow"
              min={1}
              max={MAX_SAMPLES}
              value={samples}
              onChange={(e) => setSamples(Math.min(MAX_SAMPLES, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
          <p className="admin-hint">Uses the canonical word set (en→en): run, serendipity, take off, bank, ephemeral.</p>
          {error && <p className="admin-test-fail">{error}</p>}
          <button type="button" className="btn btn-primary" onClick={handleRun} disabled={starting}>
            {starting ? 'Starting…' : 'Run benchmark'}
          </button>
        </>
      )}
    </div>
  )
}
