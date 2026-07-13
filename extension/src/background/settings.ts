import type { ExtensionSettings } from '../shared/messages'

const STORAGE_KEY = 'settings'

export const DEFAULT_SETTINGS: ExtensionSettings = {
  sourceLang: 'en',
  targetLang: 'en',
  showSelectionIcon: true,
}

/** Reads the current settings from `chrome.storage.sync`, falling back to
 *  `DEFAULT_SETTINGS` for any missing field (handles first-run and
 *  forward-compatible additions to `ExtensionSettings`). */
export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY] as Partial<ExtensionSettings> | undefined
  return { ...DEFAULT_SETTINGS, ...value }
}

/** Merges `patch` into the current settings and persists the result. */
export async function setSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings()
  const next: ExtensionSettings = { ...current, ...patch }
  await chrome.storage.sync.set({ [STORAGE_KEY]: next })
  return next
}
