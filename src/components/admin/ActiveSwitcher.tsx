import { useMemo, useState } from 'react'
import { setActive, type AdminAuth, type AdminLlmStatus, type ProviderView } from '../../api/admin'
import { describeApiError } from './adminErrors'

interface ActiveSwitcherProps {
  auth: AdminAuth
  status: AdminLlmStatus | null
  providers: ProviderView[]
  onChanged: () => void
}

export default function ActiveSwitcher({ auth, status, providers, onChanged }: ActiveSwitcherProps) {
  const options = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.map((m) => ({ providerId: p.id, modelId: m.id, label: `${p.name} · ${m.label || m.id}` }))),
    [providers]
  )
  const currentValue = status?.providerId && status.model ? `${status.providerId}::${status.model}` : ''
  const [selected, setSelected] = useState(currentValue)
  const [verify, setVerify] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSwitch(): Promise<void> {
    setError(null)
    setSwitching(true)
    try {
      if (!selected) {
        await setActive(auth, { providerId: null })
      } else {
        const [providerId, modelId] = selected.split('::')
        await setActive(auth, { providerId, modelId, verify })
      }
      onChanged()
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="admin-active-switcher">
      <select className="admin-input" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">— none (disable LLM tier) —</option>
        {options.map((o) => (
          <option key={`${o.providerId}::${o.modelId}`} value={`${o.providerId}::${o.modelId}`}>
            {o.label}
          </option>
        ))}
      </select>
      <label className="admin-field-inline admin-verify-toggle">
        <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} disabled={!selected} />
        <span>Verify with a live call before switching</span>
      </label>
      <button type="button" className="btn btn-primary" onClick={handleSwitch} disabled={switching || selected === currentValue}>
        {switching ? 'Switching…' : 'Switch'}
      </button>
      {status?.source === 'env' && (
        <p className="admin-hint">Currently running the environment-configured provider — switching writes a DB override.</p>
      )}
      {error && <p className="admin-test-fail">{error}</p>}
    </div>
  )
}
