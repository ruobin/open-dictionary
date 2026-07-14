import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdminOutletContext } from './AdminLayout'
import {
  listEntries,
  getEntry,
  batchDeleteEntries,
  type EntrySummaryView,
  type EntryDetailView,
  type ListEntriesQuery,
} from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'
import EntryFilters, { DEFAULT_ENTRY_FILTERS, type EntryFiltersState } from '../../components/admin/EntryFilters'
import EntryRow from '../../components/admin/EntryRow'
import EntryDetailDrawer from '../../components/admin/EntryDetailDrawer'

const PAGE_SIZE = 25

function toQuery(filters: EntryFiltersState): ListEntriesQuery {
  return {
    word: filters.word.trim() || undefined,
    sourceLang: filters.sourceLang || undefined,
    targetLang: filters.targetLang || undefined,
    tier: filters.tier ? (filters.tier as 'llm' | 'dict') : undefined,
    hasReports: filters.hasReportsOnly ? true : undefined,
    sort: filters.sort as ListEntriesQuery['sort'],
    limit: PAGE_SIZE,
  }
}

export default function Entries() {
  const { auth } = useAdminOutletContext()
  const [searchParams] = useSearchParams()

  const [filters, setFilters] = useState<EntryFiltersState>(() => ({
    ...DEFAULT_ENTRY_FILTERS,
    word: searchParams.get('word') ?? '',
    hasReportsOnly: searchParams.get('hasReports') === 'true',
    sort: searchParams.get('hasReports') === 'true' ? 'mostReported' : DEFAULT_ENTRY_FILTERS.sort,
  }))
  const [entries, setEntries] = useState<EntrySummaryView[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<EntryDetailView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const load = useCallback(
    (activeFilters: EntryFiltersState, before?: string) => {
      setLoading(true)
      listEntries(auth, { ...toQuery(activeFilters), before })
        .then((result) => {
          setEntries((prev) => (before ? [...prev, ...result.entries] : result.entries))
          setHasMore(result.hasMore)
          setError(null)
        })
        .catch((err) => setError(describeApiError(err)))
        .finally(() => setLoading(false))
    },
    [auth]
  )

  useEffect(() => {
    load(filters)
    // Only re-run on mount / explicit search submit — see handleSearch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSearch(): void {
    setSelected(new Set())
    load(filters)
  }

  function loadMore(): void {
    const last = entries[entries.length - 1]
    if (last) load(filters, last.fetchedAt)
  }

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function openDetail(id: string): Promise<void> {
    setDetailLoading(true)
    try {
      const entry = await getEntry(auth, id)
      if (!entry) {
        setError('That entry no longer exists — refreshing the list.')
        load(filters)
        return
      }
      setDetail(entry)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setDetailLoading(false)
    }
  }

  function closeDetail(): void {
    setDetail(null)
  }

  function handleEntryDeleted(): void {
    setDetail(null)
    load(filters)
  }

  async function handleDeleteSelected(): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!window.confirm(`Delete ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}? This cannot be undone.`)) {
      return
    }
    setBatchDeleting(true)
    setError(null)
    try {
      await batchDeleteEntries(auth, { ids, resolveReports: true })
      setSelected(new Set())
      load(filters)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBatchDeleting(false)
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Cache entries</h1>
      </div>
      <p className="admin-hint">
        Browse cached dictionary/translation entries. Deleting an entry lets the next lookup for that
        word regenerate it fresh.
      </p>

      <EntryFilters value={filters} onChange={setFilters} onSubmit={handleSearch} />

      {error && <div className="state-msg state-error">{error}</div>}

      {loading && entries.length === 0 ? (
        <p className="admin-empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="admin-empty">No entries match these filters.</p>
      ) : (
        <table className="admin-table admin-entries-table">
          <thead>
            <tr>
              <th />
              <th>Word</th>
              <th>Langs</th>
              <th>Tier</th>
              <th>Version</th>
              <th>Cached</th>
              <th>Reports</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                selected={selected.has(entry.id)}
                onToggleSelected={() => toggleSelected(entry.id)}
                onView={() => openDetail(entry.id)}
              />
            ))}
          </tbody>
        </table>
      )}

      <div className="admin-card-header-row">
        <span className="admin-hint">
          {selected.size > 0 ? `${selected.size} selected` : ''}
        </span>
        <div className="admin-page-actions">
          {selected.size > 0 && (
            <button type="button" className="btn btn-ghost" onClick={handleDeleteSelected} disabled={batchDeleting}>
              {batchDeleting ? 'Deleting…' : 'Delete selected…'}
            </button>
          )}
          {hasMore && (
            <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>

      {detailLoading && <p className="admin-empty">Loading entry…</p>}
      {detail && (
        <EntryDetailDrawer auth={auth} entry={detail} onClose={closeDetail} onDeleted={handleEntryDeleted} />
      )}
    </div>
  )
}
