import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AuthState,
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
  QuotaDetail,
  UsageInfo,
} from '../shared/messages'
import type { FavoriteKey } from '../../../shared/favorites'
import { LANGUAGES } from '../../../shared/languages'
import { EntryView, ErrorView } from '../shared/renderEntry'
import { webAppWordUrl, API_BASE } from '../shared/config'
import type { DictionaryEntry } from '../types'
import { startLookupStream } from '../shared/lookupStream'
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
  // `partial` holds the best-so-far entry while the answer is still being written.
  | { status: 'loading'; word: string; partial?: DictionaryEntry[] }
  | { status: 'success'; entries: DictionaryEntry[]; word: string; animate: boolean }
  | { status: 'error'; error: string; quota?: QuotaDetail; word?: string }

/** "3 of 5 free new words left today" (docs/design-llm-usage-quotas.md §4.6). */
function UsageLine({ usage, onSignIn }: { usage: UsageInfo | null; onSignIn: () => void }) {
  if (!usage || usage.enforcement !== 'on') return null
  const linkStyle = { background: 'none', border: 'none', color: '#b81b21', cursor: 'pointer', padding: 0, fontSize: 12 }
  if (usage.authState === 'invalid') {
    return (
      <div style={{ fontSize: 12, marginBottom: 10 }}>
        <button type="button" onClick={onSignIn} style={linkStyle}>
          Signed out. Sign in again
        </button>
      </div>
    )
  }
  if (usage.tier === 'owner' || usage.tier === 'exempt' || !usage.today) return null
  const { used, limit, pool } = usage.today
  const text =
    usage.freeTier !== 'open'
      ? 'New words are paused for today.'
      : pool === 'account'
        ? `${used}/${limit} free new words today`
        : `${Math.max(0, limit - used)} of ${limit} free new words left today`
  return (
    <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }} title="Words already in the dictionary are always free.">
      {text}
      {pool === 'ip' && usage.verifiedLimit && usage.tier === 'anon' && (
        <>
          {' · '}
          <button type="button" onClick={onSignIn} style={linkStyle}>
            Sign in for {usage.verifiedLimit} a day
          </button>
        </>
      )}
      {pool === 'ip' && usage.verifiedLimit && usage.tier === 'user' && (
        <>
          {' · '}
          <a href={`${API_BASE}/`} target="_blank" rel="noopener noreferrer" style={{ color: '#b81b21' }}>
            Verify your email for {usage.verifiedLimit} a day
          </a>
        </>
      )}
    </div>
  )
}

function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<LookupState>({ status: 'idle' })
  const [auth, setAuth] = useState<AuthState>({ isAuthenticated: false, user: null })
  const [favorites, setFavorites] = useState<FavoriteKey[]>([])
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const cancelLookup = useRef<(() => void) | null>(null)

  function refreshUsage() {
    void sendMessage({ type: 'GET_USAGE' }).then((res) => {
      setUsage(res.ok && 'usage' in res ? res.usage : null)
    })
  }

  useEffect(() => {
    void sendMessage({ type: 'GET_SETTINGS' }).then((res) => {
      if (res.ok && 'settings' in res) setSettings(res.settings)
    })
    void sendMessage({ type: 'GET_AUTH_STATE' }).then((res) => {
      if (res.ok && 'auth' in res) {
        setAuth(res.auth)
        if (res.auth.isAuthenticated) refreshFavorites()
      }
      refreshUsage()
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
    refreshUsage()
  }

  async function handleLogout() {
    await sendMessage({ type: 'LOGOUT' })
    setAuth({ isAuthenticated: false, user: null })
    setFavorites([])
    refreshUsage()
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

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const word = query.trim()
    if (!word || !settings) return
    cancelLookup.current?.()
    setState({ status: 'loading', word })
    cancelLookup.current = startLookupStream(
      { text: word, sourceLang: settings.sourceLang, targetLang: settings.targetLang },
      {
        onPartial: (partial) => setState({ status: 'loading', word, partial }),
        onDone: (res, animate) => {
          cancelLookup.current = null
          if (res.ok) setState({ status: 'success', entries: res.entries, word, animate })
          else setState({ status: 'error', error: res.error, quota: res.quota, word })
          // A new word may have used one of today's free new words.
          refreshUsage()
        },
      }
    )
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

      {state.status === 'loading' && !state.partial?.length && <div>Looking up…</div>}
      <UsageLine usage={usage} onSignIn={() => void handleLogin()} />

      {state.status === 'error' && (
        <ErrorView
          error={state.error}
          quota={state.quota}
          webAppUrl={state.word ? webAppWordUrl(state.word) : undefined}
          onSignIn={() => void handleLogin()}
        />
      )}
      {(() => {
        // One EntryView for the whole lookup (partial -> done), keyed by word,
        // so the reveal animation carries on through completion.
        const streaming = state.status === 'loading'
        const entries = state.status === 'success' ? state.entries : state.status === 'loading' ? state.partial : undefined
        if (state.status !== 'success' && !streaming) return null
        if (!entries) return null
        if (entries.length === 0) return <ErrorView error="not_found" />
        const word = state.status === 'success' || state.status === 'loading' ? state.word : ''
        const animate = streaming || (state.status === 'success' && state.animate)
        return (
          <EntryView
            key={word}
            entry={entries[0]}
            webAppUrl={webAppWordUrl(word)}
            live={{ animate, streaming }}
            isFavorite={
              settings
                ? favorites.some((f) =>
                    sameFavorite(f, { word, sourceLang: settings.sourceLang, targetLang: settings.targetLang })
                  )
                : false
            }
            onToggleFavorite={() => void handleToggleFavorite()}
          />
        )
      })()}

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
