import { createRoot } from 'react-dom/client'
import type { LookupResponse } from '../shared/messages'
import { PENDING_RESULT_KEY } from '../shared/constants'
import { webAppWordUrl } from '../shared/config'
import { EntryView, ErrorView } from '../shared/renderEntry'
import { entryStyles } from './entryStyles'

/**
 * On-demand render script for the right-click lookup path (design doc §3.2,
 * "Phase 4"). Injected via `chrome.scripting.executeScript` only in
 * response to a context-menu click — no persistent listener, no
 * `<all_urls>` content-script match needed for this flow.
 *
 * The background worker has already fetched (or served from cache) the
 * lookup result and stashed it in `chrome.storage.local` under
 * `PENDING_RESULT_KEY` *before* triggering this injection, so there's no
 * message-passing race to handle here — just read, render, clean up.
 *
 * Exported as `onExecute` (the `@crxjs/vite-plugin` loader-script
 * convention — see `node_modules/@crxjs/vite-plugin/client.d.ts`) rather
 * than run as a top-level side effect: the loader dynamically `import()`s
 * this module by URL, and repeated `executeScript` calls against an
 * already-imported module would otherwise be no-ops (ES module evaluation
 * is cached per URL within a page), silently breaking every right-click
 * after the first one on the same page.
 */
export function onExecute(): void {
  void main()
}

async function main(): Promise<void> {
  const stored = await chrome.storage.local.get(PENDING_RESULT_KEY)
  const payload = stored[PENDING_RESULT_KEY] as { text: string; result: LookupResponse } | undefined
  await chrome.storage.local.remove(PENDING_RESULT_KEY)
  if (!payload) return

  mountCard(payload.text, payload.result)
}

function mountCard(text: string, result: LookupResponse): void {
  // Remove any previous card left over from an earlier right-click.
  document.getElementById('open-dictionary-context-card')?.remove()

  const host = document.createElement('div')
  host.id = 'open-dictionary-context-card'
  host.style.position = 'fixed'
  host.style.top = '16px'
  host.style.right = '16px'
  host.style.zIndex = '2147483647'
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = entryStyles
  shadow.appendChild(style)

  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)

  const root = createRoot(mountPoint)
  const close = () => {
    root.unmount()
    host.remove()
    document.removeEventListener('keydown', onKeyDown)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKeyDown)

  root.render(
    <div className="od-card">
      <button className="od-close" onClick={close} aria-label="Close">
        ×
      </button>
      {result.ok ? (
        result.entries.length > 0 ? (
          <EntryView entry={result.entries[0]} webAppUrl={webAppWordUrl(text)} />
        ) : (
          <ErrorView error="not_found" />
        )
      ) : (
        <ErrorView error={result.error} />
      )}
    </div>
  )
}
