import type { EntryCreatorView, EntrySummaryView } from '../../api/admin'

/** Short "who added it" cell: IP (click = filter the list by it) + device summary; full UA on hover. */
export function EntryCreatorCell({ creator, onFilterIp }: { creator?: EntryCreatorView; onFilterIp?: (ip: string) => void }) {
  if (!creator) return <span className="admin-hint">unknown</span>
  const device = [creator.device.type, creator.device.browser, creator.device.os].filter(Boolean).join(' · ')
  const title = [creator.ua, creator.inferred ? 'Inferred from the activity log' : '', creator.channel !== 'web' ? `channel: ${creator.channel}` : '']
    .filter(Boolean)
    .join('\n')
  return (
    <span title={title}>
      {!creator.ip ? (
        <span className="admin-hint">IP expired</span>
      ) : onFilterIp ? (
        <button type="button" className="admin-link-button" onClick={() => onFilterIp(creator.ip!)}>
          <code>{creator.ip}</code>
        </button>
      ) : (
        <code>{creator.ip}</code>
      )}
      {creator.device.type === 'bot' && <span className="admin-status-badge admin-status-misconfigured">bot</span>}
      <div className="admin-hint">
        {device}
        {creator.inferred ? ' (inferred)' : ''}
      </div>
    </span>
  )
}

interface EntryRowProps {
  entry: EntrySummaryView
  selected: boolean
  onToggleSelected: () => void
  onView: () => void
  onFilterIp?: (ip: string) => void
}

export default function EntryRow({ entry, selected, onToggleSelected, onView, onFilterIp }: EntryRowProps) {
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
      <td className="admin-entry-creator">
        <EntryCreatorCell creator={entry.createdBy} onFilterIp={onFilterIp} />
      </td>
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
