import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionMessage, ExtensionResponse, LookupResponse } from '../shared/messages'
import { isLookupableSelection, normalizeSelectionText } from '../shared/selection'
import { entryStyles } from './entryStyles'
import { SelectionIcon } from './SelectionIcon'
import { ResultCard } from './ResultCard'

/**
 * Persistent content script — the "highlight to look up" flow (design doc
 * §3.1, "Phase 5"). Matched on `<all_urls>` (manifest `content_scripts`);
 * only ever reads `window.getSelection()` and relays the resulting string
 * (plus its bounding rect, which never leaves the page) to the background
 * worker — no other page content is read or transmitted (design doc §7.2).
 *
 * Gated by the `showSelectionIcon` setting (design doc §7.3/§3.4): when the
 * user has switched to "right-click only" mode in the options page, this
 * listener still runs (a single content script per manifest is simplest)
 * but never mounts the icon. The right-click fallback (Phase 4) is
 * implemented entirely in the background worker + an on-demand injected
 * script, so it's unaffected either way.
 */

const DEBOUNCE_MS = 150
const ICON_GAP_PX = 4
const CARD_GAP_PX = 8

let showSelectionIcon = true
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// --- Icon host (persistent Shadow-DOM root, shown/hidden via React render) ---

let iconHost: HTMLDivElement | null = null
let iconRoot: Root | null = null
let currentSelection: { text: string; rect: DOMRect } | null = null

function ensureIconHost(): Root {
  if (iconRoot) return iconRoot
  iconHost = document.createElement('div')
  iconHost.id = 'open-dictionary-selection-icon'
  Object.assign(iconHost.style, {
    position: 'fixed',
    zIndex: '2147483647',
    display: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  document.documentElement.appendChild(iconHost)

  const shadow = iconHost.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = entryStyles
  shadow.appendChild(style)
  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)

  iconRoot = createRoot(mountPoint)
  return iconRoot
}

function showIcon(rect: DOMRect): void {
  const root = ensureIconHost()
  if (!iconHost) return
  const top = Math.min(rect.bottom + ICON_GAP_PX, window.innerHeight - 32)
  const left = Math.min(Math.max(rect.left, 0), window.innerWidth - 32)
  iconHost.style.top = `${top}px`
  iconHost.style.left = `${left}px`
  iconHost.style.display = 'block'
  root.render(<SelectionIcon onClick={handleIconClick} />)
}

function hideIcon(): void {
  if (iconHost) iconHost.style.display = 'none'
}

// --- Card host (persistent Shadow-DOM root, shown/hidden via React render) ---

let cardHost: HTMLDivElement | null = null
let cardRoot: Root | null = null
let cardOpen = false

function ensureCardHost(): Root {
  if (cardRoot) return cardRoot
  cardHost = document.createElement('div')
  cardHost.id = 'open-dictionary-selection-card'
  Object.assign(cardHost.style, {
    position: 'fixed',
    zIndex: '2147483647',
    display: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  document.documentElement.appendChild(cardHost)

  const shadow = cardHost.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = entryStyles
  shadow.appendChild(style)
  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)

  cardRoot = createRoot(mountPoint)
  return cardRoot
}

function positionCard(rect: DOMRect): void {
  if (!cardHost) return
  const cardWidth = 320
  const top = Math.min(rect.bottom + CARD_GAP_PX, window.innerHeight - 40)
  const left = Math.min(Math.max(rect.left, 0), window.innerWidth - cardWidth - 8)
  cardHost.style.top = `${top}px`
  cardHost.style.left = `${left}px`
}

function renderCard(text: string, result: LookupResponse | null, loading: boolean): void {
  const root = ensureCardHost()
  root.render(<ResultCard text={text} result={result} loading={loading} onClose={closeCard} />)
}

function openCard(text: string, rect: DOMRect): void {
  cardOpen = true
  hideIcon()
  const root = ensureCardHost()
  if (!cardHost) return
  positionCard(rect)
  cardHost.style.display = 'block'
  root.render(<ResultCard text={text} result={null} loading onClose={closeCard} />)
  document.addEventListener('mousedown', handleOutsideClick, true)
  document.addEventListener('keydown', handleKeyDown, true)
}

function closeCard(): void {
  cardOpen = false
  if (cardHost) cardHost.style.display = 'none'
  document.removeEventListener('mousedown', handleOutsideClick, true)
  document.removeEventListener('keydown', handleKeyDown, true)
}

function handleOutsideClick(e: MouseEvent): void {
  if (cardHost && e.composedPath().includes(cardHost)) return
  closeCard()
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCard()
}

// --- Selection detection ---

function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(message)
}

function handleIconClick(): void {
  if (!currentSelection) return
  const { text, rect } = currentSelection
  openCard(text, rect)
  void lookupAndRender(text)
}

async function lookupAndRender(text: string): Promise<void> {
  const settingsRes = await sendMessage({ type: 'GET_SETTINGS' })
  const sourceLang = settingsRes.ok && 'settings' in settingsRes ? settingsRes.settings.sourceLang : 'en'
  const targetLang = settingsRes.ok && 'settings' in settingsRes ? settingsRes.settings.targetLang : 'en'
  const result = await sendMessage({ type: 'LOOKUP', text, sourceLang, targetLang })
  if (!cardOpen) return // dismissed while the lookup was in flight
  renderCard(text, result as LookupResponse, false)
}

function checkSelection(): void {
  if (cardOpen || !showSelectionIcon) return

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    currentSelection = null
    hideIcon()
    return
  }

  const text = normalizeSelectionText(selection.toString())
  if (!isLookupableSelection(text)) {
    currentSelection = null
    hideIcon()
    return
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    currentSelection = null
    hideIcon()
    return
  }

  currentSelection = { text, rect }
  showIcon(rect)
}

function onSelectionChange(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(checkSelection, DEBOUNCE_MS)
}

// --- Settings (live-updated so the options-page toggle takes effect
// without reloading the page/extension, per design doc §6/Phase 6) ---

async function loadSettings(): Promise<void> {
  const res = await sendMessage({ type: 'GET_SETTINGS' })
  if (res.ok && 'settings' in res) {
    showSelectionIcon = res.settings.showSelectionIcon
    if (!showSelectionIcon) hideIcon()
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !('settings' in changes)) return
  void loadSettings()
})

document.addEventListener('selectionchange', onSelectionChange)
void loadSettings()
