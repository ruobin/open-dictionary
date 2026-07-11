import { Fragment, useState } from 'react'
import type { AuditEntry } from '../../api/admin'

interface AuditTableProps {
  entries: AuditEntry[]
}

export default function AuditTable({ entries }: AuditTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (entries.length === 0) {
    return <p className="admin-empty">No audit entries.</p>
  }

  return (
    <table className="admin-table admin-audit-table">
      <thead>
        <tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th /></tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <Fragment key={entry.id}>
            <tr>
              <td>{new Date(entry.ts).toLocaleString()}</td>
              <td>{entry.actor}</td>
              <td>{entry.action}</td>
              <td>{entry.target?.name ?? entry.target?.providerId ?? entry.target?.runId ?? '—'}</td>
              <td>
                {entry.diff && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(entry.id)}>
                    {expanded.has(entry.id) ? 'Hide diff' : 'Show diff'}
                  </button>
                )}
              </td>
            </tr>
            {expanded.has(entry.id) && entry.diff && (
              <tr>
                <td colSpan={5}>
                  <pre className="admin-diff">{JSON.stringify(entry.diff, null, 2)}</pre>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
