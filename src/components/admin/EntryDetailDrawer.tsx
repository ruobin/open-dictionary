import { useState } from 'react'
import type { AdminAuth, EntryDetailView } from '../../api/admin'
import { deleteEntry } from '../../api/admin'
import { describeApiError } from './adminErrors'
import WordEntry from '../WordEntry'

interface EntryDetailDrawerProps {
  auth: AdminAuth
  entry: EntryDetailView
  onClose: () => void
  onDeleted: () => void
  /** Read-only mode (Phase 1): hides the delete button entirely. */
  readOnly?: boolean
}

export default function EntryDetailDrawer({ auth, entry, onClose, onDeleted, readOnly }: EntryDetailDrawerProps) {
  const [view, setView] = useState<'rendered' | 'json'>('rendered')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete(): Promise<void> {
    const reportNote = entry.reports.length > 0 ? ` This will also resolve its ${entry.reports.length} report(s).` : ''
    if (!window.confirm(`Delete "${entry.word}" (${entry.sourceLang}→${entry.targetLang})? This cannot be undone.${reportNote}`)) {
      return
    }
    setDeleting(true)
    setError(null)
    try {
      await deleteEntry(auth, entry.id, { resolveReports: true })
      onDeleted()
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="admin-drawer">
      <div className="admin-drawer-header">
        <h2>{entry.word} · {entry.sourceLang} → {entry.targetLang}</h2>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>

      <dl className="admin-kv">
        <dt>Tier</dt>
        <dd>{entry.tier}</dd>
        <dt>Version</dt>
        <dd>{entry.version}</dd>
        <dt>Cached</dt>
        <dd>{new Date(entry.fetchedAt).toLocaleString()}</dd>
        <dt>Id</dt>
        <dd>{entry.id}</dd>
      </dl>

      {error && <div className="state-msg state-error">{error}</div>}

      <h3>Reports ({entry.reports.length})</h3>
      {entry.reports.length === 0 ? (
        <p className="admin-empty">No reports for this entry.</p>
      ) : (
        <ul className="admin-activity-list">
          {entry.reports.map((r) => (
            <li key={r.id}>
              <span className="admin-activity-target">{r.reason || '(no reason given)'}</span>
              <time className="admin-activity-time">{new Date(r.createdAt).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}

      <div className="admin-card-header-row">
        <h3>Entry</h3>
        <div className="admin-page-actions">
          <button
            type="button"
            className={`btn btn-sm ${view === 'rendered' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setView('rendered')}
          >
            Rendered preview
          </button>
          <button
            type="button"
            className={`btn btn-sm ${view === 'json' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setView('json')}
          >
            Raw JSON
          </button>
        </div>
      </div>

      {view === 'rendered' ? (
        <div className="admin-entry-preview">
          {entry.entries.map((e, i) => (
            <WordEntry
              key={i}
              entry={e}
              sourceLang={entry.sourceLang}
              targetLang={entry.targetLang}
              isFavorite={false}
              onToggleFavorite={() => {}}
            />
          ))}
        </div>
      ) : (
        <pre className="admin-diff">{JSON.stringify(entry.entries, null, 2)}</pre>
      )}

      {!readOnly && (
        <div className="admin-drawer-footer">
          <button type="button" className="btn btn-ghost" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete this entry…'}
          </button>
        </div>
      )}
    </div>
  )
}
