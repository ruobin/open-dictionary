import type { FavoriteKey } from '../../shared/favorites'

const ANON_KEY = 'userdata:anon'

export interface UserData {
  history: FavoriteKey[]
}

export interface UserDataAuth {
  isAuthenticated: boolean
  getAccessToken: () => Promise<string>
}

const empty = (): UserData => ({ history: [] })

/** Coerces server/local storage history. Accepts legacy bare strings (en→en
 *  default) and the current `{word, sourceLang, targetLang}` objects. */
function coerceHistory(parsed: unknown): FavoriteKey[] {
  if (!parsed || typeof parsed !== 'object') return []
  const raw = (parsed as Record<string, unknown>).history
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry): FavoriteKey | null => {
      if (typeof entry === 'string') {
        const w = entry.trim().toLowerCase()
        if (!w) return null
        return { word: w, sourceLang: 'en', targetLang: 'en' }
      }
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>
        const word = typeof e.word === 'string' ? e.word.trim().toLowerCase() : ''
        const sourceLang =
          typeof e.sourceLang === 'string' ? e.sourceLang.trim().toLowerCase() : ''
        const targetLang =
          typeof e.targetLang === 'string' ? e.targetLang.trim().toLowerCase() : ''
        if (!word || !sourceLang || !targetLang) return null
        return { word, sourceLang, targetLang }
      }
      return null
    })
    .filter((x): x is FavoriteKey => x !== null)
}

function readLocal(key: string): UserData {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return empty()
    return { history: coerceHistory(JSON.parse(raw)) }
  } catch {
    return empty()
  }
}

function writeLocal(key: string, data: UserData): void {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export async function loadUserData({
  isAuthenticated,
  getAccessToken,
}: UserDataAuth): Promise<UserData> {
  if (!isAuthenticated) return readLocal(ANON_KEY)

  try {
    const token = await getAccessToken()
    const res = await fetch('/api/user-data', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Server ${res.status}`)
    return { history: coerceHistory(await res.json()) }
  } catch (err) {
    console.warn('loadUserData failed, falling back to empty', err)
    return empty()
  }
}

export async function saveUserData(
  data: UserData,
  { isAuthenticated, getAccessToken }: UserDataAuth
): Promise<void> {
  if (!isAuthenticated) {
    writeLocal(ANON_KEY, data)
    return
  }

  try {
    const token = await getAccessToken()
    const res = await fetch('/api/user-data', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`Server ${res.status}`)
  } catch (err) {
    console.warn('saveUserData failed', err)
  }
}
