import type { AuthState, AuthUser } from '../shared/messages'
import { AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_DOMAIN } from '../shared/config'

/**
 * Auth0 sign-in for the extension (design doc §9 / Phase 9). MV3 service
 * workers can't hold a long-lived popup-based OAuth session the way the web
 * app's SPA tab can, so this uses `chrome.identity.launchWebAuthFlow`
 * against Auth0's `/authorize` endpoint with the PKCE (Authorization Code +
 * PKCE) flow — no client secret is ever involved, matching the web app's
 * own public-client SPA setup.
 *
 * Token storage lives in `chrome.storage.local` (not `localStorage`, which
 * doesn't exist in a service worker — see design doc §8/§9).
 */

const STORAGE_KEY = 'auth'

interface StoredAuth {
  accessToken: string
  idToken: string
  /** Epoch ms; access tokens are short-lived, refreshed via a silent
   *  `prompt=none` re-run of the same flow rather than a refresh token
   *  (refresh tokens require the `offline_access` scope and a public
   *  client's stored refresh token is itself a sensitive artifact — a
   *  transparent-iframe replacement of `getAccessTokenSilently()` needs no
   *  such long-lived secret at rest). */
  expiresAt: number
  user: AuthUser
}

function redirectUri(): string {
  return chrome.identity.getRedirectURL()
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, length)
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length < 2) return {}
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function userFromIdToken(idToken: string): AuthUser {
  const claims = decodeJwtPayload(idToken)
  return {
    sub: typeof claims.sub === 'string' ? claims.sub : '',
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name: typeof claims.name === 'string' ? claims.name : undefined,
  }
}

async function readStoredAuth(): Promise<StoredAuth | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY] as StoredAuth | undefined
  return value ?? null
}

async function writeStoredAuth(auth: StoredAuth | null): Promise<void> {
  if (auth) {
    await chrome.storage.local.set({ [STORAGE_KEY]: auth })
  } else {
    await chrome.storage.local.remove(STORAGE_KEY)
  }
}

/**
 * Runs the interactive (or silent, via `interactive: false` + `prompt=none`)
 * Authorization Code + PKCE flow and stores the resulting tokens.
 */
async function runAuthFlow(interactive: boolean): Promise<StoredAuth | null> {
  const verifier = randomString(64)
  const challenge = await sha256Base64Url(verifier)
  const state = randomString(16)
  const redirect = redirectUri()

  const authorizeUrl = new URL(`https://${AUTH0_DOMAIN}/authorize`)
  authorizeUrl.searchParams.set('client_id', AUTH0_CLIENT_ID)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', redirect)
  authorizeUrl.searchParams.set('scope', 'openid profile email offline_access')
  authorizeUrl.searchParams.set('audience', AUTH0_AUDIENCE)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('state', state)
  if (!interactive) authorizeUrl.searchParams.set('prompt', 'none')

  let responseUrl: string | undefined
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl.toString(),
      interactive,
    })
  } catch {
    // Expected for the silent probe when the user has no existing Auth0
    // session (no SSO cookie) — not a real error in that case.
    return null
  }
  if (!responseUrl) return null

  const callback = new URL(responseUrl)
  if (callback.searchParams.get('state') !== state) return null
  const code = callback.searchParams.get('code')
  if (!code) return null

  const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: AUTH0_CLIENT_ID,
      code_verifier: verifier,
      code,
      redirect_uri: redirect,
    }),
  })
  if (!tokenRes.ok) return null

  const tokenData = (await tokenRes.json()) as {
    access_token?: string
    id_token?: string
    expires_in?: number
  }
  if (!tokenData.access_token || !tokenData.id_token) return null

  const auth: StoredAuth = {
    accessToken: tokenData.access_token,
    idToken: tokenData.id_token,
    expiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    user: userFromIdToken(tokenData.id_token),
  }
  await writeStoredAuth(auth)
  return auth
}

/** Interactive sign-in — opens the Auth0 login UI in a popup window. */
export async function login(): Promise<AuthState> {
  const auth = await runAuthFlow(true)
  if (!auth) return { isAuthenticated: false, user: null }
  return { isAuthenticated: true, user: auth.user }
}

export async function logout(): Promise<void> {
  await writeStoredAuth(null)
}

/** Current auth state, refreshing the access token silently (no visible
 *  popup) if it has expired but an Auth0 SSO session still exists. */
export async function getAuthState(): Promise<AuthState> {
  const auth = await getValidAuth()
  if (!auth) return { isAuthenticated: false, user: null }
  return { isAuthenticated: true, user: auth.user }
}

/** Returns a still-valid `StoredAuth`, transparently refreshing it via a
 *  silent re-run of the auth flow if the access token has expired. Used by
 *  the favorites/history clients to attach `Authorization: Bearer <token>`. */
export async function getValidAuth(): Promise<StoredAuth | null> {
  const stored = await readStoredAuth()
  if (!stored) return null
  if (Date.now() < stored.expiresAt - 60_000) return stored
  const refreshed = await runAuthFlow(false)
  return refreshed ?? null
}

export async function getAccessToken(): Promise<string | null> {
  const auth = await getValidAuth()
  return auth?.accessToken ?? null
}
