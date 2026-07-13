import type { DictionaryEntry } from '../types'
import type { FavoriteKey } from '../../../shared/favorites'

/** Mirrors `LookupErrorCode` in `src/api/dictionary.ts` so error handling
 *  and UI copy stay consistent between the web app and the extension.
 *  `unauthorized` (Phase 9): favorites/history calls made while signed out.
 *  `auth_failed`: the Auth0 sign-in flow itself didn't complete. */
export type ExtensionErrorCode =
  | 'not_found'
  | 'timeout'
  | 'network'
  | 'api_error'
  | 'rate_limited'
  | 'unauthorized'
  | 'auth_failed'

export interface ExtensionSettings {
  sourceLang: string
  targetLang: string
  /** "Show icon on text selection" toggle (design doc §3.4/§7.3). */
  showSelectionIcon: boolean
}

/** The subset of the Auth0 ID token claims the UI needs to display who's
 *  signed in — never used for authorization (the server independently
 *  verifies the access token JWT on every request; see `server/favorites.ts`). */
export interface AuthUser {
  sub: string
  email?: string
  name?: string
}

export interface AuthState {
  isAuthenticated: boolean
  user: AuthUser | null
}

export type ExtensionMessage =
  | { type: 'LOOKUP'; text: string; sourceLang: string; targetLang: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: Partial<ExtensionSettings> }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'LOGIN' }
  | { type: 'LOGOUT' }
  | { type: 'LIST_FAVORITES' }
  | { type: 'ADD_FAVORITE'; favorite: FavoriteKey }
  | { type: 'REMOVE_FAVORITE'; favorite: FavoriteKey }
  | { type: 'GET_HISTORY' }
  | { type: 'ADD_HISTORY'; entry: FavoriteKey }

export type LookupResponse =
  | { ok: true; entries: DictionaryEntry[] }
  | { ok: false; error: ExtensionErrorCode }

export type SettingsResponse = { ok: true; settings: ExtensionSettings }

export type AuthResponse = { ok: true; auth: AuthState } | { ok: false; error: ExtensionErrorCode }

export type FavoritesResponse =
  | { ok: true; favorites: FavoriteKey[] }
  | { ok: false; error: ExtensionErrorCode }

export type HistoryResponse =
  | { ok: true; history: FavoriteKey[] }
  | { ok: false; error: ExtensionErrorCode }

/** Union of every response shape a background message handler can return.
 *  Callers narrow on the message `type` they sent, then on `ok`. */
export type ExtensionResponse =
  | LookupResponse
  | SettingsResponse
  | AuthResponse
  | FavoritesResponse
  | HistoryResponse
