const ANON_KEY = 'userdata:anon'

const empty = () => ({ history: [], favorites: [] })

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return empty()
    const parsed = JSON.parse(raw)
    return {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    }
  } catch {
    return empty()
  }
}

function writeLocal(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export async function loadUserData({ isAuthenticated, getAccessToken }) {
  if (!isAuthenticated) return readLocal(ANON_KEY)

  try {
    const token = await getAccessToken()
    const res = await fetch('/api/user-data', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Server ${res.status}`)
    const data = await res.json()
    return {
      history: Array.isArray(data.history) ? data.history : [],
      favorites: Array.isArray(data.favorites) ? data.favorites : [],
    }
  } catch (err) {
    console.warn('loadUserData failed, falling back to empty', err)
    return empty()
  }
}

export async function saveUserData(data, { isAuthenticated, getAccessToken }) {
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
