import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  LANGUAGES,
} from '../../shared/languages'

const LAST_LANGS_KEY = 'lang:last'

interface LastLangs {
  sourceLang: string
  targetLang: string
}

function readLastLangs(): LastLangs | null {
  try {
    const raw = localStorage.getItem(LAST_LANGS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as LastLangs).sourceLang === 'string' &&
      typeof (parsed as LastLangs).targetLang === 'string'
    ) {
      return parsed as LastLangs
    }
    return null
  } catch {
    return null
  }
}

function writeLastLangs(src: string, tgt: string): void {
  try {
    localStorage.setItem(LAST_LANGS_KEY, JSON.stringify({ sourceLang: src, targetLang: tgt }))
  } catch {
    // ignore
  }
}

function initialLang(prop: string | undefined, fallback: string): string {
  if (prop !== undefined) return prop
  return readLastLangs()?.sourceLang ?? fallback
}

function initialTarget(prop: string | undefined, fallback: string): string {
  if (prop !== undefined) return prop
  return readLastLangs()?.targetLang ?? fallback
}

interface SearchBarProps {
  initialValue?: string
  initialSourceLang?: string
  initialTargetLang?: string
}

export default function SearchBar({
  initialValue = '',
  initialSourceLang,
  initialTargetLang,
}: SearchBarProps) {
  const [value, setValue] = useState(initialValue)
  const [sourceLang, setSourceLang] = useState(() =>
    initialLang(initialSourceLang, DEFAULT_SOURCE_LANG)
  )
  const [targetLang, setTargetLang] = useState(() =>
    initialTarget(initialTargetLang, DEFAULT_TARGET_LANG)
  )
  const navigate = useNavigate()

  useEffect(() => {
    setValue(initialValue)
    if (initialSourceLang !== undefined) setSourceLang(initialSourceLang)
    if (initialTargetLang !== undefined) setTargetLang(initialTargetLang)
  }, [initialValue, initialSourceLang, initialTargetLang])

  function submit(e: FormEvent) {
    e.preventDefault()
    const w = value.trim()
    if (!w) return

    writeLastLangs(sourceLang, targetLang)

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
