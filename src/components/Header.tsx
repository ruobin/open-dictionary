import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import AuthButton from './AuthButton'
import { useI18n } from '../i18n/I18nContext'
import { LOCALES, LOCALE_NAMES, type Locale } from '../i18n/translations'
import { useTheme } from '../hooks/useTheme'

function ThemeToggle() {
  const { choice, cycle } = useTheme()
  const { t } = useI18n()
  const label =
    choice === 'light'
      ? t('theme.lightLabel')
      : choice === 'dark'
        ? t('theme.darkLabel')
        : t('theme.systemLabel')
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={cycle}
      aria-label={label}
      title={label}
    >
      {choice === 'light' ? (
        // sun
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : choice === 'dark' ? (
        // moon
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        // system (half circle)
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none" />
        </svg>
      )}
    </button>
  )
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n()
  return (
    <select
      className="lang-select"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={t('lang.aria')}
      title={t('lang.aria')}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  )
}

export default function Header() {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  // Click-outside handler — close the mobile dropdown when the user taps
  // anywhere outside of it. Kept tiny rather than reaching for a library.
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on route change so tapping a link in the menu dismisses it.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [menuOpen])

  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">open</span>
        <span className="brand-name">·dictionary</span>
      </Link>

      {/* Desktop / wide-screen nav: inline links + controls. */}
      <nav className="header-nav">
        <Link to="/about" className="header-nav-link">{t('nav.about')}</Link>
        <Link to="/privacy" className="header-nav-link">{t('nav.privacy')}</Link>
        <LanguageSwitcher />
        <ThemeToggle />
        <AuthButton />
      </nav>

      {/* Mobile nav: theme toggle stays out for one-tap access; everything
          else collapses behind a hamburger dropdown. */}
      <div className="header-mobile" ref={menuRef}>
        <ThemeToggle />
        <button
          type="button"
          className={`icon-btn header-menu-btn ${menuOpen ? 'is-open' : ''}`}
          aria-label={t('nav.menu')}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {menuOpen ? (
              <>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </>
            ) : (
              <>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </>
            )}
          </svg>
        </button>
        {menuOpen && (
          <div className="header-menu" id="mobile-menu" role="menu">
            <Link to="/about" className="header-menu-link" role="menuitem">
              {t('nav.about')}
            </Link>
            <Link to="/privacy" className="header-menu-link" role="menuitem">
              {t('nav.privacy')}
            </Link>
            <div className="header-menu-row">
              <span className="header-menu-label">{t('nav.interfaceLanguage')}</span>
              <LanguageSwitcher />
            </div>
            <div className="header-menu-auth">
              <AuthButton />
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
