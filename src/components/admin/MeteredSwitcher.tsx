import { useEffect, useMemo, useState } from 'react'
import { setMeteredModel, type AdminAuth, type AdminLlmStatus, type ProviderView } from '../../api/admin'
import { describeApiError } from './adminErrors'

interface MeteredSwitcherProps {
  auth: AdminAuth
  status: AdminLlmStatus | null
  providers: ProviderView[]
  onChanged: () => void
}

const PRIMARY = 'primary'
const SAME_AS_OWNER = 'same_as_owner'

/**
 * Which model answers everyone except the owner
 * (docs/design-llm-usage-quotas.md §4.4). Default: the primary model on its
 * own, without fusion. The cache is shared, so whatever a stranger's model
 * writes is what you see for that word; the word page offers you Regenerate.
 */
export default function MeteredSwitcher({ auth, status, providers, onChanged }: MeteredSwitcherProps) {
  const options = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) =>
          p.models.map((m) => ({
            value: `${p.id}::${m.id}`,
            label: `${p.name} · ${m.label || m.id}${m.pricing ? '' : ' (no price set)'}`,
          }))
        ),
    [providers]
  )
  const metered = status?.metered
  const current =
    metered?.mode === 'provider' && metered.providerId && metered.model
      ? `${metered.providerId}::${metered.model}`
      : (metered?.mode ?? PRIMARY)

  const [value, setValue] = useState(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setValue(current), [current])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      if (value === PRIMARY || value === SAME_AS_OWNER) {
        await setMeteredModel(auth, { mode: value })
      } else {
        const [providerId, modelId] = value.split('::')
        await setMeteredModel(auth, { mode: 'provider', providerId, modelId })
      }
      onChanged()
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setSaving(false)
    }
  }

  const describe =
    metered?.mode === 'same_as_owner'
      ? 'everyone gets your full setup'
      : metered?.id
        ? `${metered.id.replace(/^llm:/, '')}${metered.mode === 'primary' ? ' (your primary, alone)' : ''}`
        : 'nothing (the LLM tier is off)'

  return (
    <div className="admin-active-switcher">
      <label className="admin-field">
        <span>
          Everyone else uses <span className="admin-hint-inline">(new words for anyone but you and unlimited accounts)</span>
        </span>
        <select className="admin-input" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value={PRIMARY}>Primary model only (no fusion) — default</option>
          <option value={SAME_AS_OWNER}>Same as me (full setup, fusion if on)</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={value === current || saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <p className="admin-hint">Now: {describe}.</p>
      {metered?.warning && <p className="admin-test-fail">{metered.warning}</p>}
      {error && <p className="admin-test-fail">{error}</p>}
    </div>
  )
}
