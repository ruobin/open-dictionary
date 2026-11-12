import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAdminOutletContext } from './AdminLayout'
import {
  getAccount,
  getUsageSettings,
  getUsageSummary,
  listAccounts,
  updateAccount,
  updateUsageSettings,
  type AccountView,
  type AdminAuth,
  type QuotaReasonCode,
  type UsageBudgetView,
  type UsageSettings,
  type UsageSettingsPatch,
  type UsageSettingsView,
  type UsageSource,
  type UsageSummary,
} from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'

/** Admin "Usage & budget" (docs/design-llm-usage-quotas.md §5.8). */

const usd = (n: number, digits = 2): string => `$${n.toFixed(digits)}`
const pct = (part: number, whole: number): number => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0)

const SOURCE_LABELS: Record<UsageSource, string> = {
  owner: 'You',
  exempt: 'Unlimited accounts',
  free: 'Free allowance',
  unmetered: 'Unmetered (enforcement off)',
  shadow: 'Shadow (would be refused)',
}

const REASON_LABELS: Record<QuotaReasonCode, string> = {
  anon_daily: 'Anonymous IP used its daily allowance',
  unverified_daily: 'Unverified account used its IP allowance',
  anon_share: "Visitors' share of today's budget used up",
  user_daily: 'Verified account used its daily allowance',
  free_tier_budget: "Today's (or the month's) free budget used up",
  free_tier_paused: 'Kill switch on',
}

function Gauge({ label, used, total, note }: { label: string; used: number; total: number; note?: string }) {
  const p = pct(used, total)
  return (
    <div className="admin-gauge">
      <div className="admin-gauge-head">
        <span>{label}</span>
        <span>
          {usd(used, 3)} of {usd(total, 2)} ({p}%)
        </span>
      </div>
      <div className="admin-daily-bar-track">
        <div className={`admin-daily-bar-fill ${p >= 100 ? 'admin-gauge-full' : ''}`} style={{ width: `${p}%` }} />
      </div>
      {note && <p className="admin-hint">{note}</p>}
    </div>
  )
}

function BudgetCard({ budget, enforcement }: { budget: UsageBudgetView; enforcement: UsageSummary['enforcement'] }) {
  return (
    <section className="admin-card">
      <h2>Free budget</h2>
      <p className="admin-hint">
        Enforcement: <strong>{enforcement}</strong>
        {enforcement === 'shadow' ? ' (everything is counted, nothing is refused)' : ''}
        {enforcement === 'off' ? ' (nothing is counted)' : ''} · Free new words:{' '}
        <strong>{budget.freeTierEnabled ? 'on' : 'paused (kill switch)'}</strong>
      </p>
      <Gauge
        label={`Today (${budget.day}, UTC)`}
        used={budget.todaySpentUsd}
        total={budget.todayBudgetUsd}
        note={
          budget.pacing === 'even'
            ? `Paced: ${usd(budget.monthRemainingBeforeTodayUsd)} left this month ÷ ${budget.daysLeft} day${budget.daysLeft === 1 ? '' : 's'}, capped at ${usd(budget.dailyCapUsd)}.`
            : `Pacing off: up to ${usd(budget.dailyCapUsd)} a day while the month lasts.`
        }
      />
      <Gauge label="Visitors' share of today (anonymous and unverified)" used={budget.anonSpentUsd} total={budget.anonShareUsd} />
      <Gauge label={`This month (${budget.month})`} used={budget.monthSpentUsd} total={budget.monthCapUsd} />
    </section>
  )
}

interface FieldSpec {
  key: keyof UsageSettings
  label: string
  kind: 'number' | 'percent' | 'usd' | 'select' | 'checkbox' | 'text'
  options?: string[]
  hint?: string
}

const FIELDS: FieldSpec[] = [
  { key: 'enforcement', label: 'Enforcement', kind: 'select', options: ['off', 'shadow', 'on'], hint: 'shadow counts everything and refuses nothing' },
  { key: 'freeTierEnabled', label: 'Free new words on (unchecked = kill switch)', kind: 'checkbox' },
  { key: 'freeTierDailyUsd', label: 'Daily free budget (USD)', kind: 'usd' },
  { key: 'freeTierMonthlyUsd', label: 'Monthly free budget (USD)', kind: 'usd' },
  { key: 'pacing', label: 'Pacing', kind: 'select', options: ['even', 'off'], hint: 'even spreads the month over the days left' },
  { key: 'anonDailyPerIp', label: 'Free new words per IP per day (anonymous and unverified)', kind: 'number', hint: '0 = sign in to generate' },
  { key: 'anonShare', label: "Visitors' share of the daily budget (%)", kind: 'percent' },
  { key: 'userDailyFree', label: 'Free new words per verified account per day', kind: 'number' },
  { key: 'alertWebhookUrl', label: 'Alert webhook URL (optional)', kind: 'text', hint: 'budget alerts are POSTed here as JSON' },
]

function display(spec: FieldSpec, value: UsageSettings[keyof UsageSettings]): string {
  if (value === null || value === undefined) return ''
  if (spec.kind === 'percent') return String(Math.round(Number(value) * 100))
  return String(value)
}

function SettingsForm({ auth, view, onSaved }: { auth: AdminAuth; view: UsageSettingsView; onSaved: (v: UsageSettingsView) => void }) {
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const valueOf = (spec: FieldSpec): string | boolean =>
    spec.key in draft ? draft[spec.key] : spec.kind === 'checkbox' ? Boolean(view.effective[spec.key]) : display(spec, view.effective[spec.key])

  async function submit(patch: UsageSettingsPatch): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const next = await updateUsageSettings(auth, patch)
      setDraft({})
      onSaved(next)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    const patch: Record<string, unknown> = {}
    for (const spec of FIELDS) {
      if (!(spec.key in draft)) continue
      const raw = draft[spec.key]
      if (spec.kind === 'checkbox') patch[spec.key] = Boolean(raw)
      else if (spec.kind === 'select' || spec.kind === 'text') patch[spec.key] = String(raw)
      else if (spec.kind === 'percent') patch[spec.key] = Number(raw) / 100
      else patch[spec.key] = Number(raw)
    }
    if (Object.keys(patch).length > 0) void submit(patch as UsageSettingsPatch)
  }

  return (
    <section className="admin-card">
      <h2>Settings</h2>
      <p className="admin-hint">
        Saved values override the server's env defaults at once (no deploy). "Reset" goes back to the default.
        {view.updatedAt ? ` Last saved ${new Date(view.updatedAt).toLocaleString()}.` : ''}
      </p>
      <form className="admin-usage-settings" onSubmit={handleSubmit}>
        {FIELDS.map((spec) => {
          const value = valueOf(spec)
          const overridden = view.overridden.includes(spec.key)
          const set = (v: string | boolean) => setDraft((d) => ({ ...d, [spec.key]: v }))
          return (
            <div key={spec.key} className={spec.kind === 'checkbox' ? 'admin-field-inline' : 'admin-field'}>
              {spec.kind === 'checkbox' ? (
                <label>
                  <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} /> {spec.label}
                </label>
              ) : (
                <label>
                  <span>{spec.label}</span>
                  {spec.kind === 'select' ? (
                    <select className="admin-input" value={String(value)} onChange={(e) => set(e.target.value)}>
                      {spec.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="admin-input"
                      type={spec.kind === 'text' ? 'url' : 'number'}
                      step={spec.kind === 'usd' ? '0.01' : '1'}
                      min={spec.kind === 'text' ? undefined : 0}
                      max={spec.kind === 'percent' ? 100 : undefined}
                      value={String(value)}
                      onChange={(e) => set(e.target.value)}
                    />
                  )}
                </label>
              )}
              <span className="admin-hint-inline">
                {spec.hint ? `${spec.hint}. ` : ''}Default: {display(spec, view.defaults[spec.key]) || '—'}
                {overridden && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="admin-link-button"
                      onClick={() => void submit({ [spec.key]: null } as UsageSettingsPatch)}
                      disabled={saving}
                    >
                      Reset
                    </button>
                  </>
                )}
              </span>
            </div>
          )
        })}
        <div className="admin-page-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || Object.keys(draft).length === 0}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
        {error && <p className="admin-test-fail">{error}</p>}
      </form>
    </section>
  )
}

function AccountRow({ auth, account, onChanged }: { auth: AdminAuth; account: AccountView; onChanged: (a: AccountView) => void }) {
  const [editing, setEditing] = useState(false)
  const [email, setEmail] = useState<string | null | undefined>(account.email)
  const [plan, setPlan] = useState(account.plan)
  const [status, setStatus] = useState(account.status)
  const [allowance, setAllowance] = useState(account.dailyAllowance === null ? '' : String(account.dailyAllowance))
  const [note, setNote] = useState(account.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing || email !== undefined) return
    getAccount(auth, account.sub)
      .then((a) => setEmail(a.email ?? null))
      .catch(() => setEmail(null))
  }, [editing, email, auth, account.sub])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateAccount(auth, account.sub, {
        plan,
        status,
        dailyAllowance: allowance.trim() === '' ? null : Number(allowance),
        note: note.trim() === '' ? null : note,
      })
      onChanged(updated)
      setEditing(false)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <tr>
        <td>
          <code>{account.sub}</code>
          {email && <div className="admin-hint">{email}</div>}
        </td>
        <td>{account.plan === 'unlimited' ? 'Unlimited' : 'Free'}</td>
        <td>{account.status === 'blocked' ? 'Blocked' : 'Active'}</td>
        <td>{account.emailVerified === null ? '?' : account.emailVerified ? 'Yes' : 'No'}</td>
        <td>
          {account.usedToday}
          {account.dailyAllowance !== null ? ` / ${account.dailyAllowance}` : ''}
        </td>
        <td>
          {account.generations7d} · {usd(account.costUsd7d, 3)}
        </td>
        <td>{account.lastSeenAt ? new Date(account.lastSeenAt).toLocaleString() : '—'}</td>
        <td>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={8}>
            <div className="admin-account-editor">
              <label className="admin-field">
                <span>Plan</span>
                <select className="admin-input" value={plan} onChange={(e) => setPlan(e.target.value as AccountView['plan'])}>
                  <option value="free">Free (daily allowance)</option>
                  <option value="unlimited">Unlimited (like you, full setup)</option>
                </select>
              </label>
              <label className="admin-field">
                <span>Status</span>
                <select className="admin-input" value={status} onChange={(e) => setStatus(e.target.value as AccountView['status'])}>
                  <option value="active">Active</option>
                  <option value="blocked">Blocked (no new words)</option>
                </select>
              </label>
              <label className="admin-field">
                <span>Daily allowance (blank = default)</span>
                <input className="admin-input" type="number" min={0} value={allowance} onChange={(e) => setAllowance(e.target.value)} />
              </label>
              <label className="admin-field">
                <span>Note</span>
                <input className="admin-input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {error && <p className="admin-test-fail">{error}</p>}
              <p className="admin-hint">The allowance override applies once the account's email is verified; unverified accounts share their IP's allowance.</p>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function AccountsSection({ auth }: { auth: AdminAuth }) {
  const [query, setQuery] = useState('')
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(
    (q: string) => {
      setError(null)
      listAccounts(auth, q)
        .then(setAccounts)
        .catch((err) => setError(describeApiError(err)))
    },
    [auth]
  )
  useEffect(() => search(''), [search])

  return (
    <section className="admin-card">
      <h2>Accounts</h2>
      <p className="admin-hint">
        Signed-in users who have looked up a new word. Give a friend more with a daily allowance, or make an account
        unlimited.
      </p>
      <form
        className="admin-blocklist-form"
        onSubmit={(e) => {
          e.preventDefault()
          search(query)
        }}
      >
        <input
          className="admin-input"
          placeholder="Search by email (exact) or account id prefix"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn btn-ghost">
          Search
        </button>
      </form>
      {error && <p className="admin-test-fail">{error}</p>}
      <table className="admin-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Verified</th>
            <th>Today</th>
            <th>7 days</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {accounts && accounts.length === 0 && (
            <tr>
              <td colSpan={8} className="admin-table-empty">
                No accounts yet.
              </td>
            </tr>
          )}
          {accounts?.map((a) => (
            <AccountRow
              key={a.sub}
              auth={auth}
              account={a}
              onChanged={(updated) => setAccounts((list) => list?.map((x) => (x.sub === updated.sub ? updated : x)) ?? null)}
            />
          ))}
        </tbody>
      </table>
    </section>
  )
}

export default function Usage() {
  const { auth } = useAdminOutletContext()
  const [days, setDays] = useState(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [settings, setSettings] = useState<UsageSettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getUsageSummary(auth, days), getUsageSettings(auth)])
      .then(([s, v]) => {
        setSummary(s)
        setSettings(v)
        setError(null)
      })
      .catch((err) => setError(describeApiError(err)))
      .finally(() => setLoading(false))
  }, [auth, days])

  useEffect(() => load(), [load])

  const sources: UsageSource[] = ['owner', 'exempt', 'free', 'shadow', 'unmetered']

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Usage &amp; budget</h1>
        <div className="admin-page-actions">
          <select className="admin-input admin-input-narrow" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <div className="state-msg state-error">{error}</div>}

      {summary && <BudgetCard budget={summary.budget} enforcement={summary.enforcement} />}
      {settings && <SettingsForm auth={auth} view={settings} onSaved={(v) => (setSettings(v), load())} />}

      {summary && (
        <section className="admin-card">
          <h2>Spend, last {summary.days} days</h2>
          <div className="admin-stat-grid">
            <div className="admin-stat">
              <div className="admin-stat-value">{summary.totals.generations}</div>
              <div className="admin-stat-label">Generations</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">{usd(summary.totals.costUsd)}</div>
              <div className="admin-stat-label">Total cost</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">{usd(summary.totals.ownerCostUsd)}</div>
              <div className="admin-stat-label">You and unlimited accounts</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-value">{usd(summary.totals.othersCostUsd)}</div>
              <div className="admin-stat-label">Everyone else</div>
            </div>
          </div>
          {summary.unpriced.length > 0 && (
            <p className="admin-test-fail">
              No price set for {summary.unpriced.map((u) => u.providerId.replace(/^llm:/, '')).join(', ')}: the default
              price is charged. Set prices in Providers → Edit.
            </p>
          )}
          {summary.estimatedShare > 0 && (
            <p className="admin-hint">
              {Math.round(summary.estimatedShare * 100)}% of recent calls reported no token usage and were estimated from
              text size.
            </p>
          )}
          <table className="admin-table">
            <thead>
              <tr>
                <th>Day</th>
                {sources.map((s) => (
                  <th key={s}>{SOURCE_LABELS[s]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.daily.length === 0 && (
                <tr>
                  <td colSpan={sources.length + 1} className="admin-table-empty">
                    No generations recorded yet.
                  </td>
                </tr>
              )}
              {[...summary.daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  {sources.map((s) => (
                    <td key={s}>{d.bySource[s] ? `${d.bySource[s]!.generations} · ${usd(d.bySource[s]!.costUsd, 3)}` : '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {summary && (
        <section className="admin-card">
          <h2>Cost per new word, last 7 days</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>For</th>
                <th>Route</th>
                <th>Count</th>
                <th>Average</th>
                <th>p50</th>
                <th>p95</th>
              </tr>
            </thead>
            <tbody>
              {summary.costPerGeneration.length === 0 && (
                <tr>
                  <td colSpan={7} className="admin-table-empty">
                    Nothing measured yet.
                  </td>
                </tr>
              )}
              {summary.costPerGeneration.map((c) => (
                <tr key={`${c.routeProviderId} ${c.action} ${c.route}`}>
                  <td>{c.routeProviderId.replace(/^llm:/, '')}</td>
                  <td>{c.action === 'lookup' ? 'New word' : 'More examples'}</td>
                  <td>{c.route === 'full' ? 'Your setup' : 'Everyone else'}</td>
                  <td>{c.count}</td>
                  <td>{usd(c.avgUsd, 4)}</td>
                  <td>{usd(c.p50Usd, 4)}</td>
                  <td>{usd(c.p95Usd, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {summary && (
        <section className="admin-card">
          <h2>Refusals, last 30 days</h2>
          <p className="admin-hint">
            {summary.enforcement === 'shadow'
              ? 'Shadow mode: these would have been refused; all of them were served.'
              : 'New words refused by a quota (cache hits are never refused).'}
          </p>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Reason</th>
                <th>Today</th>
                <th>30 days</th>
              </tr>
            </thead>
            <tbody>
              {summary.denials.length === 0 && (
                <tr>
                  <td colSpan={3} className="admin-table-empty">
                    None.
                  </td>
                </tr>
              )}
              {summary.denials.map((d) => (
                <tr key={d.reason}>
                  <td>{REASON_LABELS[d.reason] ?? d.reason}</td>
                  <td>{d.today}</td>
                  <td>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {summary && (
        <section className="admin-card">
          <h2>Top consumers, last 7 days</h2>
          <div className="admin-usage-columns">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Signed-in account</th>
                  <th>New words</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.topAccounts.length === 0 && (
                  <tr>
                    <td colSpan={3} className="admin-table-empty">
                      None.
                    </td>
                  </tr>
                )}
                {summary.topAccounts.map((a) => (
                  <tr key={a.sub}>
                    <td>
                      <code>{a.sub}</code>
                    </td>
                    <td>{a.generations}</td>
                    <td>{usd(a.costUsd, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Anonymous IP</th>
                  <th>New words</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.topIps.length === 0 && (
                  <tr>
                    <td colSpan={3} className="admin-table-empty">
                      None.
                    </td>
                  </tr>
                )}
                {summary.topIps.map((a) => (
                  <tr key={a.ip}>
                    <td>
                      <code>{a.ip}</code>
                    </td>
                    <td>{a.generations}</td>
                    <td>{usd(a.costUsd, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <AccountsSection auth={auth} />
    </div>
  )
}
