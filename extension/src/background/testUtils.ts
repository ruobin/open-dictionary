/**
 * Minimal `chrome.storage.local`/`chrome.storage.sync` fakes for unit
 * tests — no official test double exists for `chrome.storage`, so a
 * `Map`-backed shim covering `get`/`set`/`remove` is enough for the pure
 * read-through-cache and settings-merge logic under test (design doc §11 /
 * `Chrome-extension-to-do-list.md` Phase 8).
 */
export function createFakeStorageArea() {
  const store = new Map<string, unknown>()
  return {
    async get(keyOrKeys?: string | string[] | Record<string, unknown>) {
      if (keyOrKeys === undefined) {
        return Object.fromEntries(store)
      }
      const keys = typeof keyOrKeys === 'string' ? [keyOrKeys] : Array.isArray(keyOrKeys) ? keyOrKeys : Object.keys(keyOrKeys)
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        if (store.has(key)) result[key] = store.get(key)
      }
      return result
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    },
    async remove(keyOrKeys: string | string[]) {
      const keys = typeof keyOrKeys === 'string' ? [keyOrKeys] : keyOrKeys
      for (const key of keys) store.delete(key)
    },
    _store: store,
  }
}

export function installFakeChromeStorage() {
  const local = createFakeStorageArea()
  const sync = createFakeStorageArea()
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: { local, sync },
  }
  return { local, sync }
}
