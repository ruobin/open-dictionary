import type { ProviderView } from '../../api/admin'

interface ProviderCardProps {
  provider: ProviderView
  isActive: boolean
  onEdit: () => void
  onDelete: () => void
}

export default function ProviderCard({ provider, isActive, onEdit, onDelete }: ProviderCardProps) {
  const defaultModel = provider.models.find((m) => m.isDefault) ?? provider.models[0]
  return (
    <div className={`admin-card admin-provider-card${isActive ? ' admin-provider-card-active' : ''}`}>
      <div className="admin-card-header-row">
        <h3>{provider.name}</h3>
        {isActive && <span className="admin-status-badge admin-status-active">Active</span>}
        {!provider.enabled && <span className="admin-status-badge admin-status-disabled">Disabled</span>}
      </div>
      <dl className="admin-kv">
        <dt>Vendor</dt>
        <dd>{provider.vendor}</dd>
        <dt>Default model</dt>
        <dd>{defaultModel ? defaultModel.label || defaultModel.id : '—'}</dd>
        <dt>API key</dt>
        <dd>····{provider.apiKey.last4}</dd>
        {provider.lastTest && (
          <>
            <dt>Last test</dt>
            <dd>
              {provider.lastTest.ok ? `OK — ${provider.lastTest.ms} ms` : `Failed (${provider.lastTest.errorCode ?? 'error'})`}
              {' · '}
              {new Date(provider.lastTest.at).toLocaleString()}
            </dd>
          </>
        )}
      </dl>
      <div className="admin-card-footer">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} disabled={isActive} title={isActive ? 'Switch away from this provider first' : undefined}>
          Delete
        </button>
      </div>
    </div>
  )
}
