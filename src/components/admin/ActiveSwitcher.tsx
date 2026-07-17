import { useMemo, useState } from 'react'
import { setActive, type AdminAuth, type AdminLlmStatus, type ProviderView } from '../../api/admin'
import { describeApiError } from './adminErrors'

interface ActiveSwitcherProps {
  auth: AdminAuth
  status: AdminLlmStatus | null
  providers: ProviderView[]
  onChanged: () => void
}

interface TargetOption {
  providerId: string
  modelId: string
  label: string
}

/** Sentinel for the "no secondary (single-provider mode)" dropdown option. */
const SECONDARY_NONE = '__none__'

function optionKey(o: { providerId: string; modelId: string }): string {
  return `${o.providerId}::${o.modelId}`
}

export default function ActiveSwitcher({ auth, status, providers, onChanged }: ActiveSwitcherProps) {
  const options = useMemo<TargetOption[]>(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) =>
          p.models.map((m) => ({ providerId: p.id, modelId: m.id, label: `${p.name} · ${m.label || m.id}` }))
        ),
    [providers]
  )

  const primaryCurrent = status?.providerId && status.model ? optionKey({ providerId: status.providerId, modelId: status.model }) : ''
  const secondaryCurrent =
    status?.secondaryProviderId && status.secondaryModel
      ? optionKey({ providerId: status.secondaryProviderId, modelId: status.secondaryModel })
      : SECONDARY_NONE

  const [primary, setPrimary] = useState(primaryCurrent)
  const [secondary, setSecondary] = useState(secondaryCurrent)
  const [verify, setVerify] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Dirty tracking: only send `secondary` when the operator actually changed
  // it, so a primary-only switch doesn't wipe a configured fusion pair.
  const primaryDirty = primary !== primaryCurrent
  const secondaryDirty = secondary !== secondaryCurrent
  const canSwitch = (primaryDirty || secondaryDirty) && !switching

  async function handleSwitch(): Promise<void> {
    setError(null)
    setSwitching(true)
    try {
      if (!primary) {
        await setActive(auth, { providerId: null })
      } else {
        const [providerId, modelId] = primary.split('::')
        const payload: Parameters<typeof setActive>[1] = { providerId, modelId, verify }
        // Only express a secondary opinion when its dropdown moved, so a
        // primary-only switch preserves an existing fusion config.
        if (secondaryDirty) {
          payload.secondary = secondary === SECONDARY_NONE ? null : (() => {
            const [secProviderId, secModelId] = secondary.split('::')
            return { providerId: secProviderId, modelId: secModelId }
          })()
        }
        await setActive(auth, payload)
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
      <label className="admin-field">
        <span>Primary</span>
        <select className="admin-input" value={primary} onChange={(e) => setPrimary(e.target.value)}>
          <option value="">— none (disable LLM tier) —</option>
          {options.map((o) => (
            <option key={optionKey(o)} value={optionKey(o)}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="admin-field">
        <span>
          Secondary <span className="admin-hint-inline">(fusion — merge two models)</span>
        </span>
        <select
          className="admin-input"
          value={secondary}
          onChange={(e) => setSecondary(e.target.value)}
          disabled={!primary}
        >
          <option value={SECONDARY_NONE}>— none (single-provider mode) —</option>
          {options.map((o) => (
            <option key={optionKey(o)} value={optionKey(o)} disabled={optionKey(o) === primary}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="admin-field-inline admin-verify-toggle">
        <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} disabled={!primary} />
        <span>Verify with a live call before switching</span>
      </label>
      <button type="button" className="btn btn-primary" onClick={handleSwitch} disabled={!canSwitch}>
        {switching ? 'Switching…' : 'Switch'}
      </button>
      {status?.source === 'env' && (
        <p className="admin-hint">Currently running the environment-configured provider — switching writes a DB override.</p>
      )}
      {primary && secondary !== SECONDARY_NONE && primary === secondary && (
        <p className="admin-hint">Pick a different model for the secondary — fusing a model with itself is wasteful.</p>
      )}
      {error && <p className="admin-test-fail">{error}</p>}
    </div>
  )
}
