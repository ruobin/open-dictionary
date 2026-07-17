import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  LANGUAGES,
} from '../../shared/languages'
import { MAX_LOOKUP_TEXT_LENGTH } from '../../shared/limits'
import { fetchSuggestions } from '../api/suggest'
import { useI18n } from '../i18n/I18nContext'

const LAST_LANGS_KEY = 'lang:last'
const SUGGEST_DEBOUNCE_MS = 150

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
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const navigate = useNavigate()
  const { t } = useI18n()
  // Only show suggestions in response to the user actually typing — not on
  // mount/route-navigation, which sets `value` programmatically via the
  // effect below and would otherwise pop the dropdown open on page load.
  const userTypedRef = useRef(false)

  useEffect(() => {
    // Clamp programmatic values (e.g. a long :term from a crafted deep link)
    // so the input never holds more than the lookup-text limit the server
    // enforces. onChange typing is already capped by the input's maxLength.
    setValue(initialValue.slice(0, MAX_LOOKUP_TEXT_LENGTH))
    if (initialSourceLang !== undefined) setSourceLang(initialSourceLang)
    if (initialTargetLang !== undefined) setTargetLang(initialTargetLang)
    userTypedRef.current = false
  }, [initialValue, initialSourceLang, initialTargetLang])

  useEffect(() => {
    if (!userTypedRef.current) return
    const q = value.trim()
    if (!q) {
      setSuggestions([])
      setOpen(false)
      setActiveIndex(-1)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchSuggestions(q, sourceLang, controller.signal).then((words) => {
        setSuggestions(words)
        setOpen(words.length > 0)
        setActiveIndex(-1)
      })
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value, sourceLang])

  function goToWord(word: string) {
    const w = word.trim()
    if (!w) return
    writeLastLangs(sourceLang, targetLang)
    setOpen(false)
    setActiveIndex(-1)

    const qs = new URLSearchParams()
    if (sourceLang !== DEFAULT_SOURCE_LANG) qs.set('from', sourceLang)
    if (targetLang !== DEFAULT_TARGET_LANG) qs.set('to', targetLang)
    const query = qs.toString()

    navigate(`/word/${encodeURIComponent(w.toLowerCase())}${query ? `?${query}` : ''}`)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (activeIndex >= 0 && suggestions[activeIndex]) {
      goToWord(suggestions[activeIndex])
      return
    }
    goToWord(value)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  return (
    <div className="search-box">
      <div className="lang-controls">
        <label className="lang-field">
          <span className="lang-label">{t('search.from')}</span>
          <select
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            aria-label={t('search.sourceLang')}
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
          <span className="lang-label">{t('search.to')}</span>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            aria-label={t('search.targetLang')}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <form className="search-bar-wrap" onSubmit={submit}>
        <div className="search-bar">
          <input
            type="text"
            placeholder={t('search.placeholder')}
            value={value}
            // Matches the server's lookup-text cap (shared/limits.ts) so a user
            // can't type/paste something the backend would silently truncate.
            maxLength={MAX_LOOKUP_TEXT_LENGTH}
            onChange={(e) => {
              userTypedRef.current = true
              setValue(e.target.value)
            }}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            onBlur={() => setOpen(false)}
            autoFocus
            role="combobox"
            aria-expanded={open}
            aria-controls="search-suggest-list"
            aria-autocomplete="list"
            autoComplete="off"
          />
          <button type="submit" aria-label={t('search.submit')}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>

        {open && suggestions.length > 0 && (
          <ul className="suggest-list" id="search-suggest-list" role="listbox">
            {suggestions.map((word, i) => (
              <li key={word} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  className={`suggest-item ${i === activeIndex ? 'is-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    goToWord(word)
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  {word}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  )
}
