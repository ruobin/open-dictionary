import { useCallback, useEffect, useState } from 'react'
import { useAdminOutletContext } from './AdminLayout'
import { deleteProvider, importEnv, listProviders, type ProviderView } from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'
import ProviderCard from '../../components/admin/ProviderCard'
import ProviderForm from '../../components/admin/ProviderForm'

export default function Providers() {
  const { auth, status, refreshStatus } = useAdminOutletContext()
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    listProviders(auth)
      .then((list) => {
        setProviders(list)
        setError(null)
      })
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoading(false))
  }, [auth])

  useEffect(() => {
    reload()
  }, [reload])

  async function handleDelete(provider: ProviderView): Promise<void> {
    if (!window.confirm(`Delete provider "${provider.name}"? This cannot be undone.`)) return
    try {
      await deleteProvider(auth, provider.id)
      reload()
    } catch (err) {
      setError(describeApiError(err))
    }
  }

  async function handleImportEnv(): Promise<void> {
    setImporting(true)
    setImportNote(null)
    try {
      const res = await importEnv(auth)
      const parts: string[] = []
      if (res.imported.length > 0) parts.push(`Imported: ${res.imported.map((p) => p.name).join(', ')}`)
      if (res.skipped.length > 0) parts.push(`Skipped (already present): ${res.skipped.join(', ')}`)
      setImportNote(parts.length > 0 ? parts.join(' — ') : 'Nothing to import — no env-configured provider found.')
      reload()
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setImporting(false)
    }
  }

  function handleSaved(): void {
    setEditing(null)
    reload()
    refreshStatus()
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Providers</h1>
        <div className="admin-page-actions">
          <button type="button" className="btn btn-ghost" onClick={handleImportEnv} disabled={importing}>
            {importing ? 'Importing…' : 'Import from env'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>+ Add provider</button>
        </div>
      </div>

      {error && <div className="state-msg state-error">{error}</div>}
      {importNote && <div className="state-msg">{importNote}</div>}

      {loading ? (
        <p className="admin-empty">Loading…</p>
      ) : providers.length === 0 ? (
        <p className="admin-empty">No providers configured yet.</p>
      ) : (
        <div className="admin-provider-grid">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              isActive={status?.providerId === p.id}
              onEdit={() => setEditing(p)}
              onDelete={() => handleDelete(p)}
            />
          ))}
        </div>
      )}

      {editing && (
        <ProviderForm
          auth={auth}
          mode={editing === 'new' ? 'create' : 'edit'}
          initial={editing === 'new' ? undefined : editing}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
