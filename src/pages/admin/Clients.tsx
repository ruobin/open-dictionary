import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAdminOutletContext } from './AdminLayout'
import {
  getClientUsage,
  listBlocklist,
  blockClient,
  unblockClient,
  type BlockedClientView,
  type ClientFlag,
  type ClientUsageResult,
  type ClientUsageView,
} from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'

const WINDOW_OPTIONS: { hours: number; label: string }[] = [
  { hours: 1, label: 'Last hour' },
  { hours: 24, label: 'Last 24h' },
  { hours: 168, label: 'Last 7 days' },
]

const FLAG_LABELS: Record<ClientFlag, string> = {
  blocked: 'blocked',
  'bot-ua': 'bot UA',
  'over-budget': 'over LLM budget',
  'near-budget': 'near LLM budget',
  'high-rate': 'high rate',
}

function FlagBadges({ flags }: { flags: ClientFlag[] }) {
  if (flags.length === 0) return null
  return (
    <span className="admin-client-flags">
      {flags.map((f) => (
        <span
          key={f}
          className={`admin-status-badge ${f === 'over-budget' || f === 'bot-ua' || f === 'blocked' ? 'admin-status-misconfigured' : ''}`}
        >
          {FLAG_LABELS[f]}
        </span>
      ))}
    </span>
  )
}

function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export default function Clients() {
  const { auth } = useAdminOutletContext()
  const [hours, setHours] = useState(24)
  const [usage, setUsage] = useState<ClientUsageResult | null>(null)
  const [blocked, setBlocked] = useState<BlockedClientView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [blockHours, setBlockHours] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getClientUsage(auth, hours), listBlocklist(auth)])
      .then(([u, b]) => {
        setUsage(u)
        setBlocked(b.entries)
        setError(null)
      })
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoading(false))
  }, [auth, hours])

  useEffect(() => {
    load()
  }, [load])

  async function doBlock(body: { target: string; reason?: string; hours?: number }): Promise<void> {
    setBusy(body.target)
    setError(null)
    try {
      await blockClient(auth, body)
      load()
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleBlockClient(c: ClientUsageView): Promise<void> {
    const why = window.prompt(
      `Block ${c.ip} from the public API?\n\nOptional reason (shown in the blocklist):`,
      c.flags.includes('bot-ua') ? 'crawler hitting LLM routes' : 'LLM abuse'
    )
    if (why === null) return
    await doBlock({ target: c.ip, reason: why.trim() || undefined })
  }

  async function handleUnblock(t: string): Promise<void> {
    if (!window.confirm(`Unblock ${t}?`)) return
    setBusy(t)
    setError(null)
    try {
      await unblockClient(auth, t)
      load()
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleManualBlock(e: FormEvent): Promise<void> {
    e.preventDefault()
    const t = target.trim()
    if (!t) return
    const h = blockHours.trim() ? Number(blockHours) : undefined
    await doBlock({ target: t, reason: reason.trim() || undefined, hours: h })
    setTarget('')
    setReason('')
    setBlockHours('')
  }

  const clients = usage?.clients ?? []
  const suspicious = clients.filter((c) => c.flags.some((f) => f !== 'blocked' && f !== 'near-budget') && !c.blocked)

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>API clients</h1>
        <div className="admin-page-actions">
          <label className="admin-field-inline">
            Window
            <select className="admin-input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      <p className="admin-hint">
        Public lookup traffic by client IP, sorted by paid LLM calls. <b>LLM budget</b> is the live
        rolling-24h count of paid LLM calls against the per-IP cap
        {usage ? ` (${usage.budgetPerIp > 0 ? usage.budgetPerIp : 'disabled'})` : ''}. Over the cap, a
        client only gets cached entries. Blocked clients get 403 on every public API route.
      </p>

      {error && <div className="state-msg state-error">{error}</div>}

      {suspicious.length > 0 && (
        <div className="state-msg state-error">
          {suspicious.length} suspicious client{suspicious.length > 1 ? 's' : ''}:{' '}
          {suspicious.map((c) => c.ip).join(', ')}
        </div>
      )}

      <section className="admin-card">
        {loading && !usage ? (
          <p className="admin-empty">Loading…</p>
        ) : clients.length === 0 ? (
          <p className="admin-empty">No lookups in this window.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>IP</th>
                <th>Paid LLM</th>
                <th>Total</th>
                <th>Words</th>
                <th>/hour</th>
                <th>LLM budget</th>
                <th>Last seen</th>
                <th>Client</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.ip}>
                  <td>
                    <code>{c.ip}</code>
                    <div>
                      <FlagBadges flags={c.flags} />
                    </div>
                  </td>
                  <td>{c.llm}</td>
                  <td title={`cache ${c.cache} · client-cache ${c.clientCache} · dictionary ${c.dictionary}`}>{c.total}</td>
                  <td>{c.distinctWords}</td>
                  <td>{c.perHour}</td>
                  <td>
                    {c.budgetUsed}
                    {usage && usage.budgetPerIp > 0 ? ` / ${usage.budgetPerIp}` : ''}
                  </td>
                  <td title={c.lastSeen}>{relTime(c.lastSeen)}</td>
                  <td className="admin-client-ua" title={c.userAgent ?? ''}>
                    {c.deviceTypes.join(', ') || '—'}
                    {c.userAgent && <div className="admin-hint">{c.userAgent}</div>}
                  </td>
                  <td>
                    <div className="admin-page-actions">
                    <Link className="btn btn-ghost btn-sm" to={`/admin/entries?ip=${encodeURIComponent(c.ip)}`} title="Cache entries this client caused to be generated">
                      Entries
                    </Link>
                    {c.blocked ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy === c.ip} onClick={() => handleUnblock(c.ip)}>
                        Unblock
                      </button>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy === c.ip} onClick={() => handleBlockClient(c)}>
                        Block
                      </button>
                    )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="admin-card">
        <h2>Blocklist</h2>
        <form className="admin-page-actions admin-blocklist-form" onSubmit={handleManualBlock}>
          <input
            className="admin-input"
            placeholder="IP or CIDR, e.g. 74.7.227.0/24"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <input className="admin-input" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <input
            className="admin-input admin-input-narrow"
            placeholder="Hours"
            title="Leave empty for a permanent block"
            inputMode="numeric"
            value={blockHours}
            onChange={(e) => setBlockHours(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={!target.trim() || busy !== null}>
            Block
          </button>
        </form>
        {blocked.length === 0 ? (
          <p className="admin-empty">Nobody is blocked.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Target</th>
                <th>Reason</th>
                <th>Added</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {blocked.map((b) => (
                <tr key={b.target}>
                  <td>
                    <code>{b.target}</code>
                  </td>
                  <td>{b.reason ?? <span className="admin-hint">—</span>}</td>
                  <td title={b.createdAt}>{new Date(b.createdAt).toLocaleString()}</td>
                  <td>{b.expiresAt ? new Date(b.expiresAt).toLocaleString() : 'never'}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === b.target} onClick={() => handleUnblock(b.target)}>
                      Unblock
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
