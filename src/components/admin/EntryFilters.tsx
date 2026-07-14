import type { FormEvent } from 'react'
import { LANGUAGES } from '../../../shared/languages'

export interface EntryFiltersState {
  word: string
  sourceLang: string
  targetLang: string
  tier: string
  hasReportsOnly: boolean
  sort: string
}

export const DEFAULT_ENTRY_FILTERS: EntryFiltersState = {
  word: '',
  sourceLang: '',
  targetLang: '',
  tier: '',
  hasReportsOnly: false,
  sort: 'newest',
}

interface EntryFiltersProps {
  value: EntryFiltersState
  onChange: (next: EntryFiltersState) => void
  onSubmit: () => void
}

export default function EntryFilters({ value, onChange, onSubmit }: EntryFiltersProps) {
  function set<K extends keyof EntryFiltersState>(key: K, v: EntryFiltersState[K]): void {
    onChange({ ...value, [key]: v })
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    onSubmit()
  }

  return (
    <form className="admin-entries-filters" onSubmit={handleSubmit}>
      <input
        className="admin-input"
        placeholder="Word prefix…"
        value={value.word}
        onChange={(e) => set('word', e.target.value)}
      />
      <select className="admin-input" value={value.sourceLang} onChange={(e) => set('sourceLang', e.target.value)}>
        <option value="">Any source lang</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.name}</option>
        ))}
      </select>
      <select className="admin-input" value={value.targetLang} onChange={(e) => set('targetLang', e.target.value)}>
        <option value="">Any target lang</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.name}</option>
        ))}
      </select>
      <select className="admin-input" value={value.tier} onChange={(e) => set('tier', e.target.value)}>
        <option value="">Any tier</option>
        <option value="llm">llm</option>
        <option value="dict">dict</option>
      </select>
      <label className="admin-field-inline">
        <input
          type="checkbox"
          checked={value.hasReportsOnly}
          onChange={(e) => set('hasReportsOnly', e.target.checked)}
        />
        <span>Has reports only</span>
      </label>
      <select className="admin-input" value={value.sort} onChange={(e) => set('sort', e.target.value)}>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="mostReported">Most reported</option>
      </select>
      <button type="submit" className="btn btn-primary btn-sm">Search</button>
    </form>
  )
}
