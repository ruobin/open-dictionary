import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  LANGUAGES,
} from '../../shared/languages'

interface SearchBarProps {
  initialValue?: string
  initialSourceLang?: string
  initialTargetLang?: string
}

export default function SearchBar({
  initialValue = '',
  initialSourceLang = DEFAULT_SOURCE_LANG,
  initialTargetLang = DEFAULT_TARGET_LANG,
}: SearchBarProps) {
  const [value, setValue] = useState(initialValue)
  const [sourceLang, setSourceLang] = useState(initialSourceLang)
  const [targetLang, setTargetLang] = useState(initialTargetLang)
  const navigate = useNavigate()

  useEffect(() => {
    setValue(initialValue)
    setSourceLang(initialSourceLang)
    setTargetLang(initialTargetLang)
  }, [initialValue, initialSourceLang, initialTargetLang])

  function submit(e: FormEvent) {
    e.preventDefault()
    const w = value.trim()
    if (!w) return

    // Only add query params when they differ from the defaults, so a plain
    // English lookup keeps a clean URL (e.g. /word/serendipity).
    const qs = new URLSearchParams()
    if (sourceLang !== DEFAULT_SOURCE_LANG) qs.set('from', sourceLang)
    if (targetLang !== DEFAULT_TARGET_LANG) qs.set('to', targetLang)
    const query = qs.toString()

    navigate(`/word/${encodeURIComponent(w.toLowerCase())}${query ? `?${query}` : ''}`)
  }

  return (
    <div className="search-box">
      <div className="lang-controls">
        <label className="lang-field">
          <span className="lang-label">From</span>
          <select
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            aria-label="Source language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <span className="lang-arrow" aria-hidden="true">→</span>
        <label className="lang-field">
          <span className="lang-label">To</span>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            aria-label="Target language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <form className="search-bar" onSubmit={submit}>
        <input
          type="text"
          placeholder="Search a word"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button type="submit" aria-label="Search">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </form>
    </div>
  )
}
