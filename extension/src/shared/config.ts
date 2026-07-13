/**
 * Build-time constant for the API origin the extension talks to. Kept as a
 * single constant rather than a runtime/options-page setting for v1 (design
 * doc §13.2) — matches the project's existing pattern of env/build constants
 * (e.g. `PUBLIC_BASE_URL` in `server/config.ts`) over user-configurable UI.
 *
 * Swap this value (and rebuild) to point a self-hosted fork, or a local dev
 * server (`npm run server` in the repo root listens on :3001), at a
 * different deployment.
 */
export const API_BASE = 'https://dict.ai-dictionary.org'

/** Link back to the full web-app entry page for a given word. */
export function webAppWordUrl(word: string): string {
  return `${API_BASE}/word/${encodeURIComponent(word)}`
}

/**
 * Auth0 config for the sign-in flow (design doc §9, "Phase 9"). Reuses the
 * *same* Auth0 application (domain + client ID) as the main web app
 * (`.env`'s `VITE_AUTH0_DOMAIN`/`VITE_AUTH0_CLIENT_ID`) rather than
 * provisioning a second one — these are public-client values (no client
 * secret exists for a PKCE/SPA-type Auth0 application), so baking them
 * into the extension bundle is no different from them already being
 * embedded in the web app's built JS.
 *
 * **Manual one-time setup required** (not something code can do): add
 * `https://<extension-id>.chromiumapp.org/` to this Auth0 application's
 * "Allowed Callback URLs" in the Auth0 dashboard — for the pinned dev ID
 * that's `https://mliclnamclidbemdcahklcdoikncablf.chromiumapp.org/`. Also
 * add `https://<published-extension-id>.chromiumapp.org/` once published
 * to the Chrome Web Store (see `extension/README.md`/design doc §13.1 for
 * why the ID may differ). Without this, `chrome.identity.launchWebAuthFlow`
 * will fail at the `/authorize` redirect with a "callback URL mismatch"
 * error from Auth0.
 */
export const AUTH0_DOMAIN = 'dev-oz1bs6okox5c8xd0.us.auth0.com'
export const AUTH0_CLIENT_ID = 'tRDlSfhqUtliuUwxpwGjtqkiYVABLtob'
export const AUTH0_AUDIENCE = 'https://open-dictionary-api'
