import type { EntrySummaryView } from '../../api/admin'

interface EntryRowProps {
  entry: EntrySummaryView
  selected: boolean
  onToggleSelected: () => void
  onView: () => void
}

export default function EntryRow({ entry, selected, onToggleSelected, onView }: EntryRowProps) {
  const fetchedDate = new Date(entry.fetchedAt)
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Select ${entry.word}`}
        />
      </td>
      <td>{entry.word}</td>
      <td>{entry.sourceLang}→{entry.targetLang}</td>
      <td>{entry.tier}</td>
      <td>{entry.version}</td>
      <td title={fetchedDate.toISOString()}>{fetchedDate.toLocaleDateString()}</td>
      <td>
        {entry.reportCount > 0 ? (
          <span className="admin-status-badge admin-status-misconfigured">⚠ {entry.reportCount}</span>
        ) : (
          <span className="admin-hint">0</span>
        )}
      </td>
      <td>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onView}>View</button>
      </td>
    </tr>
  )
}
