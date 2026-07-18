import { useRef, useState } from 'react'
import {
  createProvider,
  updateProvider,
  testConnection,
  AdminApiError,
  type AdminAuth,
  type ProviderView,
  type ProviderModelInput,
} from '../../api/admin'
import { defaultHeadersForVendor } from '../../../shared/providerDefaults'
import { describeApiError } from './adminErrors'
import ApiKeyField from './ApiKeyField'

interface ProviderFormProps {
  auth: AdminAuth
  mode: 'create' | 'edit'
  initial?: ProviderView
  onSaved: (provider: ProviderView) => void
  onCancel: () => void
}

const VENDOR_OPTIONS: { value: string; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'glm', label: 'GLM (Z.AI)' },
  { value: 'openai-compat', label: 'Custom (OpenAI-compatible)' },
]

interface ModelRow {
  key: string
  id: string
  label: string
  isDefault: boolean
  timeoutMs: string
  temperature: string
}

let modelRowSeq = 0
function newModelRow(m?: ProviderModelInput): ModelRow {
  modelRowSeq += 1
  return {
    key: `m${modelRowSeq}`,
    id: m?.id ?? '',
    label: m?.label ?? '',
    isDefault: m?.isDefault ?? false,
    timeoutMs: m?.timeoutMs ? String(m.timeoutMs) : '',
    temperature: m?.temperature !== undefined ? String(m.temperature) : '',
  }
}

interface HeaderRow {
  key: string
  name: string
  value: string
}

let headerRowSeq = 0
function newHeaderRow(name = '', value = ''): HeaderRow {
  headerRowSeq += 1
  return { key: `h${headerRowSeq}`, name, value }
}

/** Stable signature of a header-row set by (name, value), ignoring the React
 *  `key` and row order — used to detect whether the user has customized the
 *  rows since the defaults were applied. Empty string = no rows. */
function headerRowsSig(rows: { name: string; value: string }[]): string {
  return rows
    .map((r) => `${r.name.trim()}=${r.value.trim()}`)
    .filter((s) => s.length > 1) // drop "name=" with empty value
    .sort()
    .join('|')
}

/** The deployment's public origin — matches the server's PUBLIC_BASE_URL in
 *  production (the server uses the same constant via shared/providerDefaults). */
const APP_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

/** Builds HeaderRow[] for a vendor's defaults (with stable React keys). */
function defaultHeaderRows(vendor: string): HeaderRow[] {
  return defaultHeadersForVendor(vendor, APP_ORIGIN).map((h) => newHeaderRow(h.name, h.value))
}

/** Editor for both create and edit. PATCH requires the full field set (the
 *  server reuses the same validator for create and update — see
 *  server/admin/providersRepo.ts's validateProviderFields), so this always
 *  submits every field, not a partial diff. */
export default function ProviderForm({ auth, mode, initial, onSaved, onCancel }: ProviderFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [vendor, setVendor] = useState(initial?.vendor ?? 'deepseek')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [models, setModels] = useState<ModelRow[]>(
    initial && initial.models.length > 0 ? initial.models.map(newModelRow) : [newModelRow()]
  )
  // Headers: db-saved values win when editing; otherwise pre-fill the
  // vendor's default headers (e.g. OpenRouter's X-Title/HTTP-Referer) rather
  // than leaving the section empty — makes the server's fallback defaults
  // (server/providers/llm/openrouter.ts) visible and explicit instead of
  // implicit. `lastDefaultsSig` tracks whether the current rows still match
  // "the defaults we applied" so a later vendor change only swaps them when
  // the operator hasn't customized anything (see handleVendorChange).
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    initial?.headers && Object.keys(initial.headers).length > 0
      ? Object.entries(initial.headers).map(([k, v]) => newHeaderRow(k, v))
      : defaultHeaderRows(initial?.vendor ?? 'deepseek')
  )
  const lastDefaultsSig = useRef(headerRowsSig(defaultHeaderRows(initial?.vendor ?? 'deepseek')))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; ms?: number; errorCode?: string } | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  function handleVendorChange(newVendor: string): void {
    setVendor(newVendor)
    setHeaders((prev) => {
      const currentSig = headerRowsSig(prev)
      // Swap to the new vendor's defaults only if the header rows are empty
      // or still match the defaults we last applied — an operator's
      // hand-edited or custom headers are never overwritten.
      if (currentSig !== '' && currentSig !== lastDefaultsSig.current) return prev
      const next = defaultHeaderRows(newVendor)
      lastDefaultsSig.current = headerRowsSig(next)
      return next
    })
  }

  function updateModel(key: string, patch: Partial<ModelRow>): void {
    setModels((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)))
  }
  function setDefaultModel(key: string): void {
    setModels((prev) => prev.map((m) => ({ ...m, isDefault: m.key === key })))
  }
  function removeModel(key: string): void {
    setModels((prev) => prev.filter((m) => m.key !== key))
  }
  function addModel(): void {
    setModels((prev) => [...prev, newModelRow()])
  }

  function updateHeader(key: string, patch: Partial<HeaderRow>): void {
    setHeaders((prev) => prev.map((h) => (h.key === key ? { ...h, ...patch } : h)))
  }
  function removeHeader(key: string): void {
    setHeaders((prev) => prev.filter((h) => h.key !== key))
  }
  function addHeader(): void {
    setHeaders((prev) => [...prev, newHeaderRow()])
  }

  function buildModelsPayload(): ProviderModelInput[] {
    return models
      .filter((m) => m.id.trim())
      .map((m) => ({
        id: m.id.trim(),
        label: m.label.trim() || undefined,
        isDefault: m.isDefault,
        timeoutMs: m.timeoutMs.trim() ? Number(m.timeoutMs) : undefined,
        temperature: m.temperature.trim() ? Number(m.temperature) : undefined,
      }))
  }

  function buildHeadersPayload(): Record<string, string> | undefined {
    const entries = headers
      .map((h): [string, string] => [h.name.trim(), h.value.trim()])
      .filter(([k, v]) => k && v)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  function localValidate(): string[] {
    const errs: string[] = []
    if (!name.trim()) errs.push('Name is required')
    if (!vendor) errs.push('Vendor is required')
    if (vendor === 'openai-compat' && !baseUrl.trim()) {
      errs.push('Base URL is required for a custom OpenAI-compatible provider')
    }
    if (buildModelsPayload().length === 0) errs.push('At least one model is required')
    if (mode === 'create' && !apiKey.trim()) errs.push('API key is required')
    return errs
  }

  function defaultModelId(): string | undefined {
    const payload = buildModelsPayload()
    return payload.find((m) => m.isDefault)?.id ?? payload[0]?.id
  }

  async function handleTest(): Promise<void> {
    setTestResult(null)
    const modelId = defaultModelId()
    if (!modelId) {
      setErrors(['Add at least one model before testing'])
      return
    }
    setTesting(true)
    setErrors([])
    try {
      const useDraft = mode === 'create' || apiKey.trim().length > 0
      const result = useDraft
        ? await testConnection(auth, {
            vendor,
            apiKey: apiKey.trim(),
            model: modelId,
            baseUrl: baseUrl.trim() || undefined,
          })
        : await testConnection(auth, { providerId: initial!.id, modelId })
      setTestResult(result)
    } catch (err) {
      setErrors([describeApiError(err)])
    } finally {
      setTesting(false)
    }
  }

  async function handleSave(): Promise<void> {
    const localErrors = localValidate()
    if (localErrors.length > 0) {
      setErrors(localErrors)
      return
    }
    setSaving(true)
    setErrors([])
    try {
      const fields = {
        name: name.trim(),
        vendor,
        baseUrl: baseUrl.trim() || undefined,
        headers: buildHeadersPayload(),
        models: buildModelsPayload(),
        enabled,
      }
      const provider =
        mode === 'create'
          ? await createProvider(auth, { ...fields, apiKey: apiKey.trim() })
          : await updateProvider(auth, initial!.id, { ...fields, apiKey: apiKey.trim() || null })
      onSaved(provider)
    } catch (err) {
      if (err instanceof AdminApiError && err.errors && err.errors.length > 0) {
        setErrors(err.errors)
      } else {
        setErrors([describeApiError(err)])
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-drawer">
      <div className="admin-drawer-header">
        <h2>{mode === 'create' ? 'Add provider' : `Edit ${initial?.name}`}</h2>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Close</button>
      </div>

      {errors.length > 0 && (
        <ul className="admin-form-errors">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      <label className="admin-field">
        <span>Name</span>
        <input className="admin-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DeepSeek (prod key)" />
      </label>

      <label className="admin-field">
        <span>Vendor</span>
        <select className="admin-input" value={vendor} onChange={(e) => handleVendorChange(e.target.value)}>
          {VENDOR_OPTIONS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
      </label>

      <label className="admin-field">
        <span>Base URL {vendor === 'openai-compat' ? '(required)' : '(optional override)'}</span>
        <input className="admin-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </label>

      <label className="admin-field">
        <span>API key</span>
        <ApiKeyField value={apiKey} onChange={setApiKey} last4={initial?.apiKey.last4} />
      </label>

      <div className="admin-field">
        <span>Models</span>
        <table className="admin-table admin-models-table">
          <thead>
            <tr>
              <th>Default</th><th>Model ID</th><th>Label</th><th>Timeout (ms)</th><th>Temp</th><th />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.key}>
                <td>
                  <input
                    type="radio"
                    name="default-model"
                    checked={m.isDefault}
                    onChange={() => setDefaultModel(m.key)}
                    aria-label={`Make ${m.id || 'this model'} the default`}
                  />
                </td>
                <td><input className="admin-input" value={m.id} onChange={(e) => updateModel(m.key, { id: e.target.value })} placeholder="deepseek-v4-flash" /></td>
                <td><input className="admin-input" value={m.label} onChange={(e) => updateModel(m.key, { label: e.target.value })} placeholder="optional" /></td>
                <td><input className="admin-input admin-input-narrow" value={m.timeoutMs} onChange={(e) => updateModel(m.key, { timeoutMs: e.target.value })} placeholder="10000" /></td>
                <td><input className="admin-input admin-input-narrow" value={m.temperature} onChange={(e) => updateModel(m.key, { temperature: e.target.value })} placeholder="0.7" /></td>
                <td>
                  {models.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeModel(m.key)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn btn-ghost btn-sm" onClick={addModel}>+ model</button>
      </div>

      <div className="admin-field">
        <span>Extra headers</span>
        {vendor === 'openrouter' && (
          <p className="admin-hint">
            Pre-filled with OpenRouter's recommended attribution headers so this app's traffic is
            distinguishable in the OpenRouter dashboard. Edit or remove as needed.
          </p>
        )}
        {headers.map((h) => (
          <div className="admin-header-row" key={h.key}>
            <input className="admin-input" value={h.name} onChange={(e) => updateHeader(h.key, { name: e.target.value })} placeholder="HTTP-Referer" />
            <input className="admin-input" value={h.value} onChange={(e) => updateHeader(h.key, { value: e.target.value })} placeholder="https://dict.ai-dictionary.org" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeHeader(h.key)}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={addHeader}>+ header</button>
      </div>

      <label className="admin-field admin-field-inline">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Enabled</span>
      </label>

      {testResult && (
        <p className={testResult.ok ? 'admin-test-ok' : 'admin-test-fail'}>
          {testResult.ok ? `Test succeeded — ${testResult.ms} ms` : `Test failed${testResult.errorCode ? ` (${testResult.errorCode})` : ''}`}
        </p>
      )}

      <div className="admin-drawer-footer">
        <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing || saving}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || testing}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
