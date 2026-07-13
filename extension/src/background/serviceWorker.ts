import type { ExtensionMessage, ExtensionResponse, LookupResponse } from '../shared/messages'
import { lookupWord } from './lookupClient'
import { getSettings, setSettings } from './settings'
import { PENDING_RESULT_KEY } from '../shared/constants'
import { getAuthState, login, logout } from './authClient'
import { addFavorite, listFavorites, removeFavorite } from './favoritesClient'
import { addHistory, getHistory } from './historyClient'
// `?script` is @crxjs/vite-plugin's convention for resolving the built
// filename of a script meant to be injected via the Scripting API (see
// node_modules/@crxjs/vite-plugin/client.d.ts) — it also takes care of
// registering the file as a `web_accessible_resources` entry automatically.
import contextMenuRenderScript from '../content/contextMenuRender?script'

/**
 * MV3 service worker entry — the single place that owns network calls, the
 * response cache, and settings, per the design doc's "3-layer" pattern
 * (design-browser-extension.md §4.2). Content scripts / popup / options all
 * talk to this file via `chrome.runtime.sendMessage`.
 */

const CONTEXT_MENU_ID = 'open-dictionary-lookup'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Look up "%s" in Open Dictionary',
    contexts: ['selection'],
  })
})

/**
 * Right-click lookup (design doc §3.2, "Phase 4"): no persistent content
 * script is matched into every page for this path. `info.selectionText` is
 * provided directly by the `contextMenus` API — no need to re-read the
 * selection from the page — so the lookup itself runs entirely here in the
 * background, reusing the exact same `lookupWord()` (and its cache) that
 * the popup uses. Only the *rendering* is injected on demand via
 * `chrome.scripting.executeScript`, scoped to the clicked tab via
 * `activeTab`.
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id || !info.selectionText) return
  void handleContextMenuLookup(info.selectionText, tab.id)
})

async function handleContextMenuLookup(text: string, tabId: number): Promise<void> {
  const settings = await getSettings()
  const result: LookupResponse = await lookupWord(text, settings.sourceLang, settings.targetLang)
  await chrome.storage.local.set({ [PENDING_RESULT_KEY]: { text, result } })
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [contextMenuRenderScript],
  })
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true // keep the message channel open for the async response
})

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'LOOKUP': {
      const result = await lookupWord(message.text, message.sourceLang, message.targetLang)
      if (result.ok) {
        void addHistory({
          word: message.text.trim().toLowerCase(),
          sourceLang: message.sourceLang,
          targetLang: message.targetLang,
        })
      }
      return result
    }
    case 'GET_SETTINGS': {
      const settings = await getSettings()
      return { ok: true, settings }
    }
    case 'SET_SETTINGS': {
      const settings = await setSettings(message.settings)
      return { ok: true, settings }
    }
    case 'GET_AUTH_STATE': {
      const auth = await getAuthState()
      return { ok: true, auth }
    }
    case 'LOGIN': {
      const auth = await login()
      return auth.isAuthenticated ? { ok: true, auth } : { ok: false, error: 'auth_failed' }
    }
    case 'LOGOUT': {
      await logout()
      return { ok: true, auth: { isAuthenticated: false, user: null } }
    }
    case 'LIST_FAVORITES': {
      return listFavorites()
    }
    case 'ADD_FAVORITE': {
      return addFavorite(message.favorite)
    }
    case 'REMOVE_FAVORITE': {
      return removeFavorite(message.favorite)
    }
    case 'GET_HISTORY': {
      return getHistory()
    }
    case 'ADD_HISTORY': {
      return addHistory(message.entry)
    }
  }
}
