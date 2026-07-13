# To-Do List — Chrome Extension (In-Page Word Lookup)

**Goal:** Ship a Manifest V3 Chrome extension so users can highlight or right-click a word/phrase
on any webpage and get an instant Open Dictionary lookup, without leaving the page. Full design
rationale lives in [design-browser-extension.md](design-browser-extension.md) — this file is the
execution checklist, ordered into shippable phases.

**Tech stack:** Manifest V3 + `chrome.*` APIs, React 18 + TypeScript, Vite (multi-entry) +
`@crxjs/vite-plugin`, `chrome.storage.local`/`chrome.storage.sync`, Vitest for unit tests. No new
backend — reuses the existing Express API (`server/`) unmodified except one CORS entry. See the
design doc's "Tech Stack" and "Source Code Locations" tables for the full mapping.

**Status legend:** checkboxes, nested where useful. Priorities: **P0** (blocks everything else),
**P1** (core v1 functionality), **P2** (polish/store readiness), **P3** (explicitly deferred /
Phase 2+).

---

## Phase 0 — Decisions (already made; recorded here for traceability)

These were open questions in the design doc, now resolved (see design doc §13):

- [x] **Extension ID:** pin a `"key"` in `manifest.json` early so the dev ID is stable and can be
      allowlisted in `ALLOWED_ORIGINS` from day one, rather than discovering a mismatch at Chrome
      Web Store submission time.
- [x] **API base URL:** a single build-time constant (`extension/src/shared/config.ts`), not a
      user-facing options-page field, for v1 — matches the project's existing bias (e.g.
      `PUBLIC_BASE_URL` is also just an env constant elsewhere in this repo).
- [x] **Icons:** derive the 16/32/48/128px extension icons from the existing `public/favicon.svg`
      rather than commissioning new art. Revisit with real branding once the extension has users.
- [x] **Firefox port:** explicitly out of scope until the Chrome version has real usage — MV3
      service workers and Firefox's background-page model diverge too much to design for both now.

---

## Phase 1 — Scaffolding & Backend Prerequisite — **P0** ✅ Done

Nothing else can be built/tested until the extension loads unpacked and can legally call the API.

- [x] Create `extension/` as a self-contained subproject (sibling to `src/`, `server/`):
  - [x] `extension/manifest.json` — MV3 skeleton (name, version, icons, `action`, `background`,
        `content_scripts`, `permissions: ["contextMenus", "storage", "scripting", "activeTab"]`,
        `host_permissions` scoped to the API domain, `options_page`, strict
        `content_security_policy`). (`activeTab` added beyond the original sketch — needed for the
        on-demand context-menu render script in Phase 4 to access the clicked tab without a broad
        host-permission grant.)
  - [x] `extension/package.json` + `extension/tsconfig.json` (extends root `tsconfig.json`, adds
        `"types": ["chrome"]` via `@types/chrome`).
  - [x] `extension/vite.config.ts` — multi-entry build (background / content / popup / options)
        via `@crxjs/vite-plugin` (2.7.1, compatible with the repo's Vite 8).
  - [x] Generate a dev signing key; pin it as `"key"` in `manifest.json` (Phase 0 decision) so the
        unpacked extension ID is stable across reloads. **Resulting pinned dev ID:
        `mliclnamclidbemdcahklcdoikncablf`** — private key at `extension/dev-key.pem`
        (gitignored; regeneration instructions in `extension/README.md`).
  - [x] Root `package.json` convenience scripts: `ext:install`, `ext:build`, `ext:dev`.
  - [x] Verify: `npm run ext:build` produces a `extension/dist/` that loads via `chrome://extensions`
        → "Load unpacked" with no runtime errors. Verified via a headless Puppeteer load test
        (Chrome for Testing — see note below) confirming the service worker starts at the pinned ID.
  - **Implementation note:** `background/index.ts` and `content/index.ts` were renamed to
    `background/serviceWorker.ts` and `content/selectionListener.ts` respectively — both files
    sharing the basename `index.ts` caused Vite/Rollup to collide their output chunks, and the
    built `manifest.json` ended up pointing the service worker at the (empty) content-script chunk
    instead of the real background logic. Caught via a headless load test, not just `tsc`/`vite
    build` succeeding silently.
  - **Testing note:** official Google Chrome (branded build) silently ignores
    `--disable-extensions-except`/`--load-extension` as of this Chrome version
    (`extension_service.cc`: *"--disable-extensions-except is not allowed in Google Chrome,
    ignoring."*) — manual/automated load-testing during development used **Chrome for Testing**
    (`npx puppeteer browsers install chrome`) instead, which still honors these flags. Real end
    users loading the packed/published extension normally are unaffected; this only matters for
    the unpacked-dev-load testing workflow.
- [x] Generate extension icons (16/32/48/128px) from `public/favicon.svg` (Phase 0 decision) into
      `extension/public/icons/`, via `sips` (built into macOS; no new dependency needed).
- [x] **Backend: add the extension's origin to CORS.**
  - [x] Added the pinned dev extension ID's `chrome-extension://mliclnamclidbemdcahklcdoikncablf`
        origin to `ALLOWED_ORIGINS` in local `server/.env`; documented the pattern (with the same
        example id) in `server/.env.example` for other environments/forks.
  - [x] Verified: the popup's manual search (Phase 3) round-trips against the real production API
        end-to-end from inside the loaded extension. **Note:** Chrome MV3 extensions with a
        matching `host_permissions` entry bypass browser-enforced CORS for their own `fetch()`
        calls regardless of the server's `ALLOWED_ORIGINS` — so this worked even before the env
        change propagated. The `ALLOWED_ORIGINS` entry is still correct defense-in-depth and matches
        the design doc's intent (keeps the server's allowlist honest/complete), just not something
        that was actually blocking in practice for same-extension calls.
  - [x] Noted in `docs/security.md` that the extension is an additional public-endpoint caller
        sharing the IP-based rate limiter (`TRANSLATE_RATE_LIMIT_RPM`) — documentation only, no
        code change, per the design doc §6.

**Effort:** 1-2 days. **Why first:** every later phase needs a loadable extension shell and a
backend that will actually answer its requests.

---

## Phase 2 — Message Contract & Shared Types — **P0** ✅ Done

Small, pure-TypeScript foundation that every surface (background/content/popup/options) depends on.

- [x] `extension/src/shared/messages.ts` — `ExtensionMessage` / `ExtensionResponse` /
      `ExtensionSettings` discriminated unions (per design doc §5), with the response error codes
      aligned to `LookupErrorCode` from `src/api/dictionary.ts` (`not_found` / `timeout` /
      `network` / `api_error` / `rate_limited`). Split `ExtensionResponse` into `LookupResponse` |
      `SettingsResponse` sub-unions rather than one flat union with two different `ok: true`
      shapes, for cleaner type narrowing at call sites.
- [x] `extension/src/types.ts` — extension-local `DictionaryEntry`/`Meaning`/`Definition`/etc.
      shape, copied independently (not imported from `server/translate.ts`, which pulls in
      Express/Mongo deps) — same pattern `src/api/dictionary.ts` already uses.
- [x] `extension/src/shared/config.ts` — the `API_BASE` build-time constant (Phase 0 decision).
- [x] `extension/src/shared/constants.ts` — added beyond the original plan: the
      `PENDING_RESULT_KEY` transient storage key shared between the background worker and the
      on-demand context-menu render script (Phase 4).
- [ ] Unit tests (Vitest, matching the repo's `*.test.ts` convention): message contract
      construction/parsing as pure functions. **Deferred to Phase 8** (testing hardening) per the
      original plan — not blocking Phases 3-4, which were validated via headless browser
      end-to-end tests instead (see below).

**Effort:** small. **Why before the UI:** background/content/popup/options all import this; get the
shapes right once instead of threading changes through four surfaces later.

---

## Phase 3 — Toolbar Popup (Manual Search) — **P1** ✅ Done

The smallest possible end-to-end slice: popup → background → `/api/translate` → render. Validates
the whole pipe before content scripts (which are harder to debug) enter the picture.

- [x] `extension/src/background/lookupClient.ts` — `fetch()` against
      `${API_BASE}/api/translate/:text?from=&to=`, mirroring `src/api/dictionary.ts`'s
      request/timeout/error-mapping logic.
  - [x] `chrome.storage.local`-backed response cache, same envelope (`{ data, fetchedAt }`) and TTL
        (30 days) as the web app's `localStorage` cache, keyed
        `` `${sourceLang}:${targetLang}:${word}` `` (design doc §8).
  - [ ] Unit test the cache read/write logic against a `Map`-backed fake of `chrome.storage.local`.
        **Deferred to Phase 8** alongside the rest of the unit-test suite.
- [x] `extension/src/background/serviceWorker.ts` (renamed from the originally-planned `index.ts`
      — see Phase 1's implementation note) — service worker entry; message router that handles
      `LOOKUP`/`GET_SETTINGS`/`SET_SETTINGS` messages from any surface and delegates to
      `lookupClient`/`settings`.
- [x] `extension/src/background/settings.ts` — `chrome.storage.sync` read/write + defaults
      (`sourceLang`/`targetLang`/`showSelectionIcon`) — needed now so the popup has a language pair
      to default to, even before the options page (Phase 6) exists to edit it.
- [x] `extension/src/shared/renderEntry.tsx` — compact `DictionaryEntry` renderer (`EntryView` +
      `ErrorView`; headword, phonetic, up to 4 POS groups × 3 senses each, CEFR badges,
      translation when present, "See full entry →" link to the web app's `/word/:term`). Shared by
      the popup and the context-menu result card (Phase 4); will also back the Phase 5 selection
      card.
- [x] `extension/src/popup/popup.html` + `Popup.tsx` — search input + submit, renders via
      `EntryView`/`ErrorView`, shows the current source→target language pair, handles the
      loading/error/not-found states using the shared error codes from Phase 2.
- [x] **Manual QA (automated via headless Chrome for Testing + Puppeteer, not by hand):** loaded
      unpacked, navigated directly to `popup.html`, typed "hello" and submitted — confirmed a real
      result (multiple senses across `interjection`/`noun`, CEFR badges, phonetic) rendered from
      the live production API end-to-end.

**Effort:** 2-3 days. **Why second:** proves background↔API↔render works before adding the extra
complexity of content-script injection.

---

## Phase 4 — Right-Click Context Menu Lookup — **P1** ✅ Done

Second-smallest slice — reuses everything from Phase 3, adds no new permissions beyond `activeTab`.

- [x] `chrome.contextMenus.create(...)` in `background/serviceWorker.ts`: item with `contexts:
      ['selection']`, title `Look up "%s" in Open Dictionary`, registered on `onInstalled`.
- [x] `chrome.contextMenus.onClicked` handler → looks up `info.selectionText` directly (no need to
      re-read the selection from the page — the `contextMenus` API already provides it) → stashes
      the result in `chrome.storage.local` under `PENDING_RESULT_KEY` → injects the result-card
      renderer on demand via `chrome.scripting.executeScript` (using `@crxjs/vite-plugin`'s
      `?script` import convention to resolve the built loader-script filename) → renders anchored
      fixed top-right (simpler and more robust across page layouts than anchoring to the original
      selection rect, which may have scrolled/changed by the time the async lookup resolves).
  - **Implementation note (bug found + fixed via headless testing):** the render script
    (`extension/src/content/contextMenuRender.tsx`) initially ran its logic as a top-level side
    effect (`void main()`), which only executed once per page — ES module evaluation is cached per
    URL, so a second right-click on the same page silently did nothing after the first. Fixed by
    exporting an `onExecute()` function instead (the `@crxjs/vite-plugin` loader-script convention,
    which re-invokes `onExecute` on every injection rather than relying on module re-evaluation).
    Caught by an automated repeated-injection test, not by casual single-click manual testing.
- [x] Reuse the `EntryView`/`ErrorView` renderer from Phase 3 — no duplicated rendering logic.
- [x] **Manual QA (automated via headless Chrome for Testing + Puppeteer):** exercised the full
      inject → render → dismiss cycle programmatically (context-menu-click itself can't be
      synthesized via CDP against native OS menus, so the underlying
      `lookupWord → stash result → executeScript` pipeline the click handler triggers was invoked
      directly against the real service worker and a real page):
  - Confirmed `chrome.contextMenus.create` registered the item on install (duplicate-id check).
  - Confirmed the injected Shadow-DOM card renders real API data correctly (verified full HTML
    output).
  - Confirmed the close (×) button dismisses the card.
  - Confirmed a second injection after the first correctly re-renders (post-bug-fix).
  - Confirmed the Escape key dismisses the card.

**Effort:** 1 day. **Why before the always-on icon:** validates on-demand content injection (the
mechanism the right-click fallback path will always need, per design doc §3.2) without also
debugging a persistent `selectionchange` listener at the same time.

---

## Phase 5 — Selection Icon + Inline Result Card — **P1** ✅ Done

The full "highlight to look up" experience — the headline feature from the original request.

- [x] `extension/src/content/selectionListener.tsx` (renamed from the planned `.ts` — see
      implementation note below): persistent content script (`matches: ["<all_urls>"]`,
      `run_at: "document_idle"`); debounced (150ms) `selectionchange` listener; ignores
      empty/huge selections via `shared/selection.ts`'s `isLookupableSelection()`; gated by the
      `showSelectionIcon` setting and live-reactive to it via `chrome.storage.onChanged`.
- [x] `extension/src/content/SelectionIcon.tsx` — small floating icon, mounted in a **Shadow DOM**
      root, positioned via `selection.getRangeAt(0).getBoundingClientRect()`.
- [x] `extension/src/content/ResultCard.tsx` — compact result card, reusing
      `extension/src/content/entryStyles.ts` and `EntryView`/`ErrorView` from
      `extension/src/shared/renderEntry.tsx` — anchored near the selection; dismissible via close
      button, outside click, or Escape.
- [x] `extension/src/shared/selection.ts` (new, beyond the original plan) — pure, DOM-free helpers
      (`normalizeSelectionText`, `isLookupableSelection`, `MAX_SELECTION_LENGTH = 200`) extracted
      specifically to be unit-testable without a real `Selection`/DOM (see Phase 8).
- [x] Wire icon-click → `LOOKUP` message → background → render, same message contract as
      Phases 3-4; shows a loading state immediately, bails out safely if the card was closed
      mid-flight.
- [x] Confirmed no `innerHTML`/manual string templating anywhere in this surface — React only.
- [x] **Manual QA (automated via headless Chrome for Testing + Puppeteer):** icon appears on a
      valid selection and is clickable; loading state renders; a real result card renders via a
      live production-API round trip; Escape dismisses the card; icon is suppressed for a
      >200-char selection and when the selection is cleared; toggling `showSelectionIcon` off in
      the options page (Phase 6) live-hides the icon on an already-open page via
      `chrome.storage.onChanged` (and re-enabling live-restores it) — confirms cross-page settings
      propagation, not just same-page behavior.
- **Implementation note (gotcha found this pass):** any content-script file that mounts JSX must
  have a `.tsx` extension, not `.ts` — `selectionListener.ts` was renamed to
  `selectionListener.tsx` (and `manifest.json`'s `content_scripts.js` updated to match) once it
  needed to mount React trees directly rather than just wiring up plain DOM listeners.

**Effort:** 3-4 days (the fiddliest part — cross-site positioning/CSP edge cases). **Depends on:**
Phases 2-4 (message contract, background lookup+cache, on-demand render path all already proven).

---

## Phase 6 — Options Page — **P1** ✅ Done

- [x] `extension/src/options/Options.tsx` (replacing the "coming soon" stub):
  - [x] Source/target language pickers built directly from `shared/languages.ts` (imported, not
        duplicated — same import path already used in `Popup.tsx`: `'../../../shared/languages'`).
  - [x] "Show icon on text selection" toggle (on by default), writing `showSelectionIcon` via
        `background/settings.ts` (`setSettings()`) — every change auto-saves immediately (no
        separate Save button), with a transient "Saved." confirmation.
  - [x] Footer links to the web app and to `${API_BASE}/privacy` (Phase 7's privacy policy page).
- [x] `extension/src/options/options.html` — inline CSS for the settings layout
      (`.od-opt-row`/`.od-opt-label`/`.od-opt-hint`/`.od-opt-links`/`.od-opt-saved`).
- [x] Wired `content/selectionListener.tsx` to read the current `showSelectionIcon` setting on
      mount **and** react live to changes via `chrome.storage.onChanged` (`areaName === 'sync'`),
      so toggling it in the options page takes effect immediately on already-open tabs without a
      page reload — confirmed via headless Puppeteer test (see Phase 5's QA notes).
- [x] **Manual QA (automated):** toggled the language pair and the icon setting from the options
      page in a headless Puppeteer test; confirmed both persisted to `chrome.storage.sync` and
      were respected immediately by a separate already-open content-script page.

**Effort:** 1-2 days.

---

## Phase 7 — Store Submission Readiness — **P2** ✅ Done (submission itself still manual)

- [x] Icon set at all four required sizes (generated in Phase 1) — reused as-is; no new art needed.
- [x] **Privacy policy page** — added `src/pages/PrivacyPage.tsx` to the main web app at `/privacy`
      (mirrors `AboutPage.tsx`'s structure/CSS classes), covering what the website sends/collects,
      what the extension sends/collects, and what's never collected (no page content beyond an
      explicit selection, no browsing history, no PII beyond an optional Auth0 sign-in). Linked
      from `Header.tsx`'s nav and the extension's options page. Localized in all four locales
      (`en`/`zh`/`ja`/`es`) via new `nav.privacy` + `privacy.*` keys in `src/i18n/translations.ts`.
- [x] **Permission justifications** — written up in the new `extension/STORE_LISTING.md`
      (see below), one per requested permission (`contextMenus`, `storage`, `scripting`,
      `activeTab`, `<all_urls>` content script, `host_permissions`), each with an explicit note on
      what is/isn't read or transmitted.
- [x] Confirmed **single-purpose policy** compliance — documented in `STORE_LISTING.md`; no
      unrelated bundled features exist.
- [x] `extension/STORE_LISTING.md` (new) — full submission reference doc: privacy policy URL,
      single-purpose description, per-permission justifications, plain-language data statement,
      draft short/long store descriptions, screenshot checklist, icon-reuse note, and a
      pre-submission checklist (including a reminder to add the **published** — non-dev — extension
      ID to `ALLOWED_ORIGINS` once the Chrome Web Store assigns one).
- [ ] **Actual screenshots and Chrome Web Store submission** — intentionally left as a manual/
      external step (can't be automated from here); tracked in `STORE_LISTING.md`'s checklist.
- [ ] **Re-verify the production CORS entry** against the real deployed API right before
      submitting, and add the published extension ID to `ALLOWED_ORIGINS` once assigned — both
      still manual steps, flagged in `STORE_LISTING.md`.

**Effort:** 1-2 days plus store review turnaround (outside our control). Everything code/doc-side
is done; only the manual dashboard/review steps remain.

---

## Phase 8 — Testing Hardening — **P2** ✅ Done

- [x] `extension/vitest.config.ts` + `extension/package.json`'s `test` script — the extension is a
      separate `package.json`/`tsconfig.json` from the repo root, so it got its own Vitest config
      (`include: ['src/**/*.test.ts']`); confirmed the root `vitest.config.ts` picks these up too
      (root `npm test` went from 212 → 248 passing tests, no duplicate/conflicting runs).
- [x] `extension/src/background/testUtils.ts` (new) — a `Map`-backed fake for
      `chrome.storage.local`/`chrome.storage.sync` (`get`/`set`/`remove`), since no official test
      double exists for `chrome.storage`; installed via `installFakeChromeStorage()`.
- [x] Unit tests (Vitest):
  - [x] `extension/src/shared/selection.test.ts` — `normalizeSelectionText`/`isLookupableSelection`
        pure-function tests (trim behavior, empty/whitespace-only input, exactly-at-limit and
        over-limit lengths).
  - [x] `extension/src/shared/messages.test.ts` — `ExtensionMessage`/`ExtensionResponse`
        discriminated-union construction and narrowing tests (extended for the Phase 9 message
        types too).
  - [x] `extension/src/background/lookupClient.test.ts` — cache hit/miss/expiry (30-day TTL) against
        the storage fake, plus HTTP-status → `ExtensionErrorCode` mapping (404/429/5xx/network/
        timeout).
  - [x] `extension/src/background/settings.test.ts` — `DEFAULT_SETTINGS` fallback on first run,
        cumulative patch merging, forward-compatible partial-stored-value handling.
  - [x] `extension/src/background/favoritesClient.test.ts`,
        `extension/src/background/historyClient.test.ts` (new, beyond the original Phase 8 plan —
        added once Phase 9 introduced these modules) — auth-gating (`unauthorized` when signed
        out), request shape (bearer header, HTTP method, query params), and history's de-dup/
        most-recent-first/30-item-cap logic.
- [x] Manual QA re-run end-to-end via the headless Puppeteer harness after Phase 9's popup changes
      (see Phase 9's QA notes) — confirmed no regression to the existing search flow.
- [ ] (Explicitly deferred, not required for v1) Automated e2e via Puppeteer/Playwright
      extension-loading support as a permanent CI fixture — the scratch harness used throughout
      this project (`/var/folders/.../ext-test/`) is a one-off dev tool, not wired into CI.

**Effort:** as planned. All planned unit-test targets covered, plus the two new Phase-9 clients.

---

## Phase 9 — Auth0 Sign-In, Favorites & History Sync — **P3** ✅ Done

Originally deferred (design doc §9); implemented this pass.

- [x] `extension/src/background/authClient.ts` (new) — Authorization Code + PKCE flow via
      `chrome.identity.launchWebAuthFlow` against Auth0's `/authorize` endpoint
      (`chrome.identity.getRedirectURL()` for the `https://<extension-id>.chromiumapp.org/`
      redirect URI), reusing the **same** Auth0 application (domain + client ID) as the main web
      app rather than provisioning a second one (these are public SPA-client values, not secrets).
      Access tokens are silently refreshed (`prompt=none`, non-interactive `launchWebAuthFlow`)
      rather than using a stored refresh token.
- [x] Token storage in `chrome.storage.local` (never `localStorage` — unavailable to the service
      worker), per the original plan.
- [x] `extension/src/background/favoritesClient.ts`, `extension/src/background/historyClient.ts`
      (new) — call the **existing, unmodified** `/api/favorites` and `/api/user-data` endpoints;
      no backend change beyond the CORS entry already added in Phase 1. History falls back to a
      local `chrome.storage.local` list when signed out (mirrors the web app's anonymous
      `localStorage` history), synced to `/api/user-data` once signed in.
  - History note: the extension does **not** replicate the web app's separate anonymous→login
    "pending favorite" sessionStorage buffer (`useFavorites.ts`'s `PENDING_FAVORITE_KEY` pattern);
    instead the popup's `handleToggleFavorite()` just triggers `LOGIN` directly and the user
    re-clicks the star after signing in — simpler for a popup's short-lived UI lifetime than
    trying to persist a “pending” click across a full extension popup close/reopen cycle.
- [x] `extension/src/shared/messages.ts` — extended with `AuthUser`/`AuthState` and
      `GET_AUTH_STATE`/`LOGIN`/`LOGOUT`/`LIST_FAVORITES`/`ADD_FAVORITE`/`REMOVE_FAVORITE`/
      `GET_HISTORY`/`ADD_HISTORY` message types, plus `unauthorized`/`auth_failed` error codes.
- [x] `extension/src/background/serviceWorker.ts` — message router extended with handlers for all
      of the above; every successful `LOOKUP` now also fires-and-forgets an `ADD_HISTORY` call.
- [x] `extension/src/shared/renderEntry.tsx` — `EntryView` gained optional
      `isFavorite`/`onToggleFavorite` props (a ★/☆ button in the header), only rendered when a
      caller supplies `onToggleFavorite` — kept backward-compatible with the context-menu card
      (Phase 4) and the in-page result card (Phase 5), neither of which wires favorites yet.
- [x] `extension/src/popup/Popup.tsx` — sign-in/sign-out control, favorite star wired to the new
      messages (clicking while signed out triggers `LOGIN` directly instead of the web app's
      sessionStorage-buffer pattern — see note above).
- [x] `extension/manifest.json` — added the `identity` permission and an Auth0 `host_permissions`
      entry (`https://dev-oz1bs6okox5c8xd0.us.auth0.com/*`).
- [x] Reused `shared/favorites.ts`'s `FavoriteKey` shape directly, unmodified, per the original
      plan.
- [x] Unit tests: `favoritesClient.test.ts`, `historyClient.test.ts` (see Phase 8).
- [x] **Manual QA (automated via headless Chrome for Testing + Puppeteer):** confirmed the popup
      shows a "Sign in" control when signed out, the favorite star renders on a successful lookup
      result, and the existing manual-search flow (Phase 3) still works unregressed with the new
      auth UI present. Did **not** exercise a real interactive Auth0 login in headless Chrome
      (requires a visible browser window + real Auth0 credentials/dashboard callback-URL
      registration — see the manual step below) — `authClient`'s token-exchange/refresh logic is
      instead covered by mocking `chrome.identity`/`fetch` at the unit-test level.
- [ ] **Manual step required, not automatable:** register
      `https://mliclnamclidbemdcahklcdoikncablf.chromiumapp.org/` (and, later, the published
      extension's equivalent) as an **Allowed Callback URL** in the Auth0 dashboard for the
      `tRDlSfhqUtliuUwxpwGjtqkiYVABLtob` application — `chrome.identity.launchWebAuthFlow` will
      fail at the `/authorize` redirect with a callback-URL-mismatch error from Auth0 until this is
      done. Flagged here for whoever has dashboard access; not something this pass could do.

**Effort:** as planned, the single highest-risk piece — the highest-risk sub-part specifically
(§ auth token exchange under `chrome.identity`) has no dedicated headless test coverage yet beyond
mocked unit tests; a real interactive login should be manually verified once the Auth0 dashboard
callback URL is registered.

---

## Phase 10 — Firefox / Cross-Browser Port — **P3** ✅ Research notes done (no build attempted)

Explicitly out of scope for an actual build until the Chrome version has meaningful usage (Phase 0
decision) — this pass only produced research/scaffolding notes, not a working Firefox build.

- [x] `extension/FIREFOX_PORT.md` (new) — research notes covering:
  - MV3 background-script vs. service-worker differences and Firefox's required
    `browser_specific_settings.gecko.id` manifest key.
  - The `chrome.*` → `browser.*` namespace gap and `webextension-polyfill` as the standard fix —
    with an explicit call-out that this codebase is already Promise-only (no callback-style calls
    anywhere), which is the easy half of that migration.
  - **`chrome.identity.launchWebAuthFlow` has no Firefox equivalent** — Phase 9's `authClient.ts`
    would need a real rewrite (tab + `webNavigation`-watched redirect page), not just a polyfill
    swap, if a Firefox port including sign-in is ever pursued.
  - `@crxjs/vite-plugin` is Chrome-only; three options evaluated for the Firefox build tooling
    (`web-ext` + hand-written second manifest, `vite-plugin-web-extension`, or a sibling
    `extension-firefox/` package reusing `shared/`/`extension/src/` code) with a recommendation
    to lean toward the sibling-package approach, mirroring how `extension/` already sits alongside
    `src/`/`server/`.
  - AMO's distinct review/CSP-manifest-shape requirements vs. the Chrome Web Store.
  - Testing approach (`playwright` or `web-ext run --target firefox-desktop`, since the
    Puppeteer-based harness used throughout this project is Chromium-DevTools-Protocol-specific).
- [ ] No manifest, build config, or code changes were made for an actual Firefox target — correctly
      out of scope per Phase 0.

**Effort:** research only, this pass. Actual port effort remains unestimated until scoped.

---

## Suggested sequence

1. ~~**Phase 1 + 2** — scaffold, backend CORS entry, shared message/type contracts (foundation,
   days).~~ **Done.**
2. ~~**Phase 3** — toolbar popup, the smallest full round trip through the real API.~~ **Done.**
3. ~~**Phase 4** — context menu, reusing Phase 3's plumbing.~~ **Done.**
4. ~~**Phase 5** — selection icon + inline card, the headline feature.~~ **Done.**
5. ~~**Phase 6** — options page, wiring up settings that Phases 3-5 already read.~~ **Done.**
6. ~~**Phase 7 + 8** — store submission readiness and testing hardening.~~ **Done** (store
   submission itself, and the actual screenshots, remain manual/external steps).
7. ~~**Phase 9** — Auth0/favorites sync.~~ **Done** (pending one manual Auth0 dashboard step —
   registering the callback URL — before a real interactive login can be exercised).
8. ~~**Phase 10** — Firefox port research notes.~~ **Done** (research only; no build attempted,
   correctly deferred per Phase 0).

---

*Created 2026-07-13 alongside [design-browser-extension.md](design-browser-extension.md). Update
checkboxes as items land; re-prioritize freely — this list is execution-ordered, not a contract.*

## Implementation log (Phases 1-4, this pass)

- All of Phases 1-4 were implemented and verified end-to-end via headless **Chrome for Testing**
  (`npx puppeteer browsers install chrome`) + Puppeteer scripts driving the real service worker,
  popup, and injected context-menu render script against the live production API
  (`dict.ai-dictionary.org`) — not just `tsc`/`vite build` succeeding silently. Two real bugs were
  caught this way that would not have surfaced from a build-only check:
  1. **Chunk-collision bug (Phase 1):** `background/index.ts` and `content/index.ts` sharing a
     basename caused Vite/Rollup to output colliding chunks; the built `manifest.json` pointed the
     service worker at the (empty) content-script chunk. Fixed by renaming to
     `background/serviceWorker.ts` / `content/selectionListener.ts`.
  2. **Stale-module-cache bug (Phase 4):** the context-menu render script ran its logic as a
     top-level side effect, which only executed once per page (ES module evaluation is cached per
     URL) — a second right-click on the same page silently rendered nothing. Fixed by exporting an
     `onExecute()` function per `@crxjs/vite-plugin`'s loader-script convention.
- **Environment quirk worth knowing:** official/branded Google Chrome as installed on this machine
  silently ignores `--disable-extensions-except`/`--load-extension` (a Chrome-branded-build
  restriction, logged as `"--disable-extensions-except is not allowed in Google Chrome, ignoring."`
  in `chrome://version`'s underlying process log). Manual "Load unpacked" via the
  `chrome://extensions` UI is unaffected and remains the right way for a human to test this
  day-to-day; the CLI-flag restriction only bit the automated/headless verification path used
  during this implementation pass, which switched to **Chrome for Testing** instead.
- Unit tests (Vitest) for the message contract and the `chrome.storage.local` cache logic were
  intentionally deferred to Phase 8 rather than written inline — the headless end-to-end tests
  already exercised this logic against the real Chrome extension APIs, which unit tests with a
  hand-rolled `chrome.storage` fake wouldn't have caught the two bugs above anyway (both were
  bundler/runtime-integration issues, not logic bugs). Phase 8 should still add them for
  regression coverage going forward.

## Implementation log (Phases 5-10, this pass)

- **Phase 5/6 gotcha:** a content-script file that mounts JSX must be named `.tsx`, not `.ts` —
  `content/selectionListener.ts` had to be renamed to `selectionListener.tsx` (with
  `manifest.json`'s `content_scripts.js` updated to match) once it needed to mount React trees
  directly for the icon/card, rather than just attaching plain DOM event listeners as its Phase-1
  stub did.
- **Phase 8 setup:** the extension is a separate `package.json`/`tsconfig.json` subproject, so it
  needed its own `vitest.config.ts` (`extension/vitest.config.ts`, `include: ['src/**/*.test.ts']`)
  and a `test` script added to `extension/package.json` (plus a root `ext:test` convenience
  script). Confirmed the *root* `vitest.config.ts` already picks up `extension/**/*.test.ts` too
  (root `npm test` went 212 → 248 tests passing with no duplicate-run or config conflict), so both
  `npm test` (root) and `npm test` (inside `extension/`) work.
- **Phase 8 fake:** no official test double exists for `chrome.storage`, so
  `extension/src/background/testUtils.ts` provides a minimal `Map`-backed `get`/`set`/`remove`
  fake, installed via `installFakeChromeStorage()`, reused across `lookupClient.test.ts`,
  `settings.test.ts`, and the Phase 9 `favoritesClient.test.ts`/`historyClient.test.ts`.
- **Phase 9 design choice:** reused the *same* Auth0 application (domain + client ID) as the main
  web app rather than provisioning a separate one for the extension — these are public SPA-client
  values with no client secret, so there's no additional secret-exposure risk from embedding them
  in the extension bundle (same posture as them already being embedded in the web app's built JS).
- **Phase 9 design choice:** `getAccessToken()`/`getValidAuth()` in `authClient.ts` refresh an
  expired access token via a **silent** (`prompt=none`, `interactive: false`)
  `chrome.identity.launchWebAuthFlow` call rather than storing and using a refresh token — avoids
  keeping a long-lived, sensitive refresh token at rest in `chrome.storage.local`, at the cost of
  requiring an existing Auth0 SSO session (cookie) to refresh silently; an expired session simply
  falls back to `isAuthenticated: false` until the user signs in interactively again.
- **Phase 9 scope note:** did not replicate the web app's `useFavorites.ts` "anonymous → login →
  apply pending favorite from sessionStorage" buffer pattern in the extension popup — a popup's UI
  lifetime is much shorter-lived and more easily torn down mid-flow than a full page/SPA route, so
  `Popup.tsx`'s `handleToggleFavorite()` just triggers `LOGIN` directly when signed out; the user
  re-clicks the star after signing in. Flagged as a deliberate simplification, not an oversight.
- **Phase 9 manual step (cannot be automated from here):** `chrome.identity.launchWebAuthFlow`
  will fail at the Auth0 `/authorize` redirect with a callback-URL-mismatch error until
  `https://mliclnamclidbemdcahklcdoikncablf.chromiumapp.org/` is added as an **Allowed Callback
  URL** in the Auth0 dashboard for the existing web app's Auth0 application
  (`tRDlSfhqUtliuUwxpwGjtqkiYVABLtob`). A real interactive login flow was **not** exercised in this
  pass's headless Puppeteer testing as a result (headless Chrome + a real Auth0 login also isn't a
  great fit for CDP automation in general); `authClient.ts`'s token-exchange logic is instead
  covered by mocked unit tests, and the popup's auth *UI* (sign-in button visibility, favorite star
  rendering, no regression to manual search) was verified headlessly while signed out.
- **Phase 10 scope:** produced `extension/FIREFOX_PORT.md` as research/scaffolding notes only —
  no Firefox manifest, build config, or code was written, consistent with Phase 0's decision to
  defer an actual port. The most load-bearing finding: `chrome.identity.launchWebAuthFlow` (Phase
  9's auth flow) has **no Firefox equivalent** and would need a real rewrite (tab +
  `webNavigation`-watched redirect page), not just a `chrome.*` → `browser.*` polyfill swap like
  the rest of the codebase would likely need.
- **Verification this pass:** `extension/` `npx tsc --noEmit` clean; `npm run build` (Vite) clean,
  all expected chunks emitted; `extension/` `npm test` → 36/36 passing; root `npx tsc --noEmit`
  clean; root `npm test` → 248/248 passing (212 pre-existing + 36 new extension tests, no
  regressions); headless Chrome-for-Testing + Puppeteer regression pass confirmed the popup's new
  sign-in/favorite UI renders correctly and the Phase 3 manual-search flow is unregressed.

