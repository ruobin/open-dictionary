import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ExtensionMessage, ExtensionResponse, ExtensionSettings } from '../shared/messages'
import { LANGUAGES } from '../../../shared/languages'
import { API_BASE } from '../shared/config'

/** Same thin `chrome.runtime.sendMessage` wrapper used by `Popup.tsx` — not
 *  extracted to `shared/` since it's a two-line, extension-page-only
 *  concern (content scripts talk to the background worker directly too,
 *  but with a different call pattern around debouncing/live settings). */
function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(message)
}

/**
 * Options page (design doc §3.4/§7.3, "Phase 6"): source/target language
 * pickers built directly from `shared/languages.ts`, and the "show icon on
 * text selection" toggle that gates the always-on content-script listener
 * down to right-click-only mode. Every change is written immediately via
 * `SET_SETTINGS` (no separate "Save" button) — `chrome.storage.sync` writes
 * are cheap and this matches how most extension options pages behave.
 */
function Options() {
  const [settings, setSettingsState] = useState<ExtensionSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void sendMessage({ type: 'GET_SETTINGS' }).then((res) => {
      if (res.ok && 'settings' in res) setSettingsState(res.settings)
    })
  }, [])

  function showSaved(): void {
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  async function updateSettings(patch: Partial<ExtensionSettings>): Promise<void> {
    const res = await sendMessage({ type: 'SET_SETTINGS', settings: patch })
    if (res.ok && 'settings' in res) {
      setSettingsState(res.settings)
      showSaved()
    }
  }

  if (!settings) return <div>Loading…</div>

  return (
    <div>
      <h2>Open Dictionary — Settings</h2>

      <div className="od-opt-row">
        <label className="od-opt-label" htmlFor="od-source-lang">
          Source language
        </label>
        <select
          id="od-source-lang"
          value={settings.sourceLang}
          onChange={(e) => void updateSettings({ sourceLang: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="od-opt-row">
        <label className="od-opt-label" htmlFor="od-target-lang">
          Target language
        </label>
        <select
          id="od-target-lang"
          value={settings.targetLang}
          onChange={(e) => void updateSettings({ targetLang: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <p className="od-opt-hint">
        Used as the default pair for the toolbar popup and in-page lookups. Set source and target
        to the same language to see definitions only, with no translation line.
      </p>

      <div className="od-opt-row">
        <label className="od-opt-label" htmlFor="od-show-icon">
          Show icon on text selection
        </label>
        <input
          id="od-show-icon"
          type="checkbox"
          checked={settings.showSelectionIcon}
          onChange={(e) => void updateSettings({ showSelectionIcon: e.target.checked })}
        />
      </div>
      <p className="od-opt-hint">
        When off, highlighting text on a page won&apos;t show a lookup icon — use right-click
        &rarr; &ldquo;Look up in Open Dictionary&rdquo; instead. Nothing about a page is read or
        sent anywhere until you explicitly select text and click the icon (or right-click), either
        way.
      </p>

      {saved && <div className="od-opt-saved">Saved.</div>}

      <div className="od-opt-links">
        <a href={API_BASE} target="_blank" rel="noopener noreferrer">
          Open Dictionary
        </a>
        {' · '}
        <a href={`${API_BASE}/privacy`} target="_blank" rel="noopener noreferrer">
          Privacy policy
        </a>
      </div>
    </div>
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(
  <StrictMode>
    <Options />
  </StrictMode>
)
