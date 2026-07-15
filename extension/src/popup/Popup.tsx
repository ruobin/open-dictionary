import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { AuthState, ExtensionMessage, ExtensionResponse, ExtensionSettings } from '../shared/messages'
import type { FavoriteKey } from '../../../shared/favorites'
import { LANGUAGES } from '../../../shared/languages'
import { EntryView, ErrorView } from '../shared/renderEntry'
import { webAppWordUrl, API_BASE } from '../shared/config'
import type { DictionaryEntry } from '../types'
// Popup renders in a regular (non-shadow-DOM) page, unlike the
// content-script surfaces, so it needs its own `<style>` injection of the
// same `.od-*` rules those surfaces put in their shadow roots — otherwise
// `EntryView`'s markup (word/phonetic/audio buttons/favorite star) is
// unstyled here.
import { entryStyles } from '../content/entryStyles'

/** Thin typed wrapper over `chrome.runtime.sendMessage` shared by every
 *  extension-page surface (popup, options). Content-script injections talk
 *  to the background worker the same way but live in `content/`. */
function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(message)
}

function sameFavorite(a: FavoriteKey, b: FavoriteKey): boolean {
  return a.word === b.word && a.sourceLang === b.sourceLang && a.targetLang === b.targetLang
}

type LookupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; entries: DictionaryEntry[]; word: string }
  | { status: 'error'; error: string }

function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<LookupState>({ status: 'idle' })
  const [auth, setAuth] = useState<AuthState>({ isAuthenticated: false, user: null })
  const [favorites, setFavorites] = useState<FavoriteKey[]>([])

  useEffect(() => {
    void sendMessage({ type: 'GET_SETTINGS' }).then((res) => {
      if (res.ok && 'settings' in res) setSettings(res.settings)
    })
    void sendMessage({ type: 'GET_AUTH_STATE' }).then((res) => {
      if (res.ok && 'auth' in res) {
        setAuth(res.auth)
        if (res.auth.isAuthenticated) refreshFavorites()
      }
    })
  }, [])

  function refreshFavorites() {
    void sendMessage({ type: 'LIST_FAVORITES' }).then((res) => {
      if (res.ok && 'favorites' in res) setFavorites(res.favorites)
    })
  }

  async function handleLogin() {
    const res = await sendMessage({ type: 'LOGIN' })
    if (res.ok && 'auth' in res) {
      setAuth(res.auth)
      if (res.auth.isAuthenticated) refreshFavorites()
    }
  }

  async function handleLogout() {
    await sendMessage({ type: 'LOGOUT' })
    setAuth({ isAuthenticated: false, user: null })
    setFavorites([])
  }

  async function handleToggleFavorite() {
    if (state.status !== 'success' || !settings) return
    if (!auth.isAuthenticated) {
      void handleLogin()
      return
    }
    const key: FavoriteKey = {
      word: state.word,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
    }
    const isFav = favorites.some((f) => sameFavorite(f, key))
    const res = await sendMessage(
      isFav ? { type: 'REMOVE_FAVORITE', favorite: key } : { type: 'ADD_FAVORITE', favorite: key }
    )
    if (res.ok && 'favorites' in res) setFavorites(res.favorites)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const word = query.trim()
    if (!word || !settings) return
    setState({ status: 'loading' })
    const res = await sendMessage({
      type: 'LOOKUP',
      text: word,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
    })
    if (res.ok && 'entries' in res) {
      setState({ status: 'success', entries: res.entries, word })
    } else if (!res.ok) {
      setState({ status: 'error', error: res.error })
    }
  }

  return (
    <div>
      <style>{entryStyles}</style>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6, fontSize: 12 }}>
        {auth.isAuthenticated ? (
          <button
            type="button"
            onClick={() => void handleLogout()}
            style={{ background: 'none', border: 'none', color: '#777', cursor: 'pointer', padding: 0 }}
          >
            Sign out{auth.user?.email ? ` (${auth.user.email})` : ''}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleLogin()}
            style={{ background: 'none', border: 'none', color: '#b81b21', cursor: 'pointer', padding: 0 }}
          >
            Sign in
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Look up a word…"
          autoFocus
          style={{
            flex: 1,
            padding: '6px 8px',
            border: '1px solid #ccc',
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={!settings || state.status === 'loading'}
          style={{
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            background: '#b81b21',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Go
        </button>
      </form>

      {settings && (
        <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>
          {langName(settings.sourceLang)} → {langName(settings.targetLang)}
        </div>
      )}

      {state.status === 'loading' && <div>Looking up…</div>}
      {state.status === 'error' && <ErrorView error={state.error} />}
      {state.status === 'success' &&
        (state.entries.length > 0 ? (
          <EntryView
            entry={state.entries[0]}
            webAppUrl={webAppWordUrl(state.word)}
            isFavorite={
              settings
                ? favorites.some((f) =>
                    sameFavorite(f, {
                      word: state.word,
                      sourceLang: settings.sourceLang,
                      targetLang: settings.targetLang,
                    })
                  )
                : false
            }
            onToggleFavorite={() => void handleToggleFavorite()}
          />
        ) : (
          <ErrorView error="not_found" />
        ))}

      <div style={{ marginTop: 12, fontSize: 11, color: '#aaa', textAlign: 'right' }}>
        <a href={API_BASE} target="_blank" rel="noopener noreferrer" style={{ color: '#aaa' }}>
          Open Dictionary
        </a>
      </div>
    </div>
  )
}

function langName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(
  <StrictMode>
    <Popup />
  </StrictMode>
)
