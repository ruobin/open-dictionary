import { useState } from 'react'
import { LANGUAGES } from '../../../shared/languages'
import { runPlayground, type AdminAuth, type ProviderView, type PlaygroundTargetResult } from '../../api/admin'
import { describeApiError } from './adminErrors'

interface PlaygroundFormProps {
  auth: AdminAuth
  providers: ProviderView[]
  sourceLang: string
  targetLang: string
  onLangsChange: (sourceLang: string, targetLang: string) => void
  onResults: (results: PlaygroundTargetResult[]) => void
}

interface TargetOption {
  providerId: string
  modelId: string
  label: string
}

const MAX_TARGETS = 6

export default function PlaygroundForm({
  auth,
  providers,
  sourceLang,
  targetLang,
  onLangsChange,
  onResults,
}: PlaygroundFormProps) {
  const options: TargetOption[] = providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ providerId: p.id, modelId: m.id, label: `${p.name} · ${m.label || m.id}` })))

  const [word, setWord] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
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
    if (!word.trim()) {
      setError('Enter a word to look up')
      return
    }
    if (selected.size === 0) {
      setError('Pick at least one provider/model to test')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const targets = Array.from(selected).map((key) => {
        const [providerId, modelId] = key.split('::')
        return { providerId, modelId }
      })
      const res = await runPlayground(auth, { targets, word: word.trim(), sourceLang, targetLang })
      onResults(res.results)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="admin-card">
      <h2>Look up a word</h2>
      {options.length === 0 ? (
        <p className="admin-empty">Add an enabled provider first.</p>
      ) : (
        <>
          <div className="admin-playground-inputs">
            <label className="admin-field admin-field-narrow">
              <span>Word</span>
              <input
                className="admin-input"
                placeholder="e.g. serendipity"
                value={word}
                onChange={(e) => setWord(e.target.value)}
              />
            </label>
            <label className="admin-field admin-field-narrow">
              <span>Source lang</span>
              <select className="admin-input" value={sourceLang} onChange={(e) => onLangsChange(e.target.value, targetLang)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </label>
            <label className="admin-field admin-field-narrow">
              <span>Target lang</span>
              <select className="admin-input" value={targetLang} onChange={(e) => onLangsChange(sourceLang, e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </label>
          </div>

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
          <p className="admin-hint">
            Calls each selected provider/model directly (up to {MAX_TARGETS}) — bypasses the translation cache, so
            every run costs a real LLM call.
          </p>
          {error && <p className="admin-test-fail">{error}</p>}
          <button type="button" className="btn btn-primary" onClick={handleRun} disabled={running}>
            {running ? 'Running…' : 'Run lookup'}
          </button>
        </>
      )}
    </div>
  )
}
