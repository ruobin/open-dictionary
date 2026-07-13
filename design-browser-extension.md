# Design Doc: Chrome Browser Extension for In-Page Word Lookup

**Status:** Draft (v1)
**Date:** 2026-07-13
**Scope:** A Manifest V3 Chrome extension that lets a user select/highlight a word or phrase on any webpage, or right-click it, to get an instant Open Dictionary lookup without switching tabs.

---

## Tech Stack

| Layer | Stack | Notes |
|---|---|---|
| Extension runtime | **Manifest V3**, `chrome.*` APIs (`contextMenus`, `storage`, `scripting`, `runtime`) | Chrome only for v1 — see §13.4 |
| UI | **React 18 + TypeScript**, same major versions already pinned in the repo root `package.json` | Popup/options pages and the in-page result card are all React trees; the content-script UI mounts inside a **Shadow DOM** root for style isolation from the host page |
| Build | **Vite** (multi-entry) + **`@crxjs/vite-plugin`** | Keeps the extension on the same bundler/toolchain as `src/` instead of introducing a second build system; emits a valid MV3 `dist/` (correct service-worker + content-script + HTML-entry output) |
| Language | TypeScript, strict mode (matches root `tsconfig.json` conventions) | `extension/` gets its own `tsconfig.json` extending the repo's, with `"types": ["chrome"]` added (`@types/chrome`) |
| Storage | `chrome.storage.local` (response cache) + `chrome.storage.sync` (user settings) | Replaces `localStorage`/`sessionStorage`, which aren't available to a service worker |
| Backend | **No new backend** — reuses the existing Express API (`server/`) and its public `GET /api/translate/:text` endpoint, unmodified except the CORS allowlist (§6) | |
| Testing | **Vitest**, matching the repo's existing `*.test.ts` convention (`server/*.test.ts`, `shared/*.test.ts`) | Pure-function unit tests only for v1; no extension-specific test runner needed |

---

## Source Code Locations

| Path | Status | Purpose |
|---|---|---|
| `extension/` | **New** | Self-contained extension subproject (manifest, build config, all extension source) — see §4.3 for the full tree |
| `extension/manifest.json` | New | MV3 manifest — permissions, entries, icons (§7.1) |
| `extension/vite.config.ts` | New | Multi-entry build: background / content / popup / options |
| `extension/src/background/` | New | Service worker: message router, lookup client + cache, settings store, context-menu registration |
| `extension/src/content/` | New | Selection listener + Shadow-DOM-mounted floating icon and result card |
| `extension/src/popup/`, `extension/src/options/` | New | Toolbar popup and options page React entries |
| `extension/src/shared/` | New | Message contract (`messages.ts`) and the compact entry renderer shared by popup/content |
| `extension/src/types.ts` | New | Extension-local `DictionaryEntry` shape (independent copy, same pattern as `src/api/dictionary.ts`) |
| `shared/languages.ts` | **Reused, unmodified** | Imported directly by the options page for the language pickers |
| `shared/favorites.ts` | **Reused, unmodified** | `FavoriteKey` shape, for Phase-2 favorites sync |
| `server/config.ts` | **Modified** | `ALLOWED_ORIGINS` gains the extension's `chrome-extension://<id>` origin (§6) |
| `server/.env` / `server/.env.example` | **Modified** | Document the new `ALLOWED_ORIGINS` entry |
| `server/translate.ts`, `server/app.ts` | **Unmodified** | Existing `/api/translate` route and CORS middleware consumed as-is |
| `server/favorites.ts`, `server/app.ts` (`/api/user-data`) | **Unmodified (Phase 2)** | Existing Auth0-gated routes consumed as-is once sign-in lands |
| `public/favicon.svg` | **Reused as source art** | Base asset for the extension's generated icon set (§13.3) |
| `docs/security.md` | **Amended** | Note the extension as an additional public-endpoint caller sharing the IP-based rate limiter (§6) |

---

## 1. Context & Current State

Open Dictionary today is a React SPA (`src/`) + Express API (`server/`) with:

- A **public, unauthenticated, rate-limited** lookup endpoint: `GET /api/translate/:text?from=&to=` (`server/translate.ts`), returning `DictionaryEntry[]` (JSON). This is the only endpoint the extension MVP needs.
- **Auth0-gated** endpoints for favorites (`/api/favorites`) and history (`/api/user-data`) — require a bearer JWT (`server/app.ts`, `server/favorites.ts`).
- A CORS allowlist (`ALLOWED_ORIGINS` in `server/config.ts`, enforced in `server/app.ts`) that currently only lists the web app's own origin(s).
- Shared, framework-free modules under `shared/` (`languages.ts`, `favorites.ts`) already written in plain TypeScript with no server/browser-only APIs — safe to reuse as-is inside an extension bundle.
- No existing extension code, build tooling, or manifest anywhere in the repo — this is net-new.

**Implication:** the backend already exposes everything the MVP extension needs. The work is almost entirely new client code plus one small backend change (CORS allowlist).

---

## 2. Goals & Non-Goals

**Goals**

1. Let a user **highlight text on any webpage** and see a small, unobtrusive lookup affordance (icon/button) appear near the selection.
2. Let a user **right-click a selection** and choose "Look up “word” in Open Dictionary" from the context menu.
3. Show the definition **inline, in a popup/tooltip anchored to the selection** — no tab switch required for the common case.
4. Provide a **toolbar popup** (browser action) with a manual search box, for lookups not tied to a page selection.
5. Provide an **options page** to configure source/target language (mirrors the web app's language pair) and lookup mode.
6. Reuse the existing public `/api/translate/:text` endpoint and shared types (`shared/languages.ts`) — **no duplicated LLM/dictionary logic in the extension.**
7. Keep the permission footprint and privacy story honest and minimal enough to pass Chrome Web Store review without friction.

**Non-Goals (v1)**

- Signing in / syncing favorites or history from the extension (Auth0 in a MV3 service worker is non-trivial — deferred to Phase 2, §9).
- Firefox/Edge/Safari ports (Manifest V3 + `chrome.*` APIs only for v1; WebExtensions polyfill is a Phase 3 concern).
- Audio playback / pronunciation in the extension popup (nice-to-have, not core to "look up a word").
- Full-page translation or bulk scanning of page content — this is a **word/phrase lookup** tool, not a translation-overlay product. Only the user's selected text is ever sent to the server.

---

## 3. UX Flows

### 3.1 Selection popup (primary flow)

```
User selects "serendipity" on any page
        │
        ▼
content script detects `selectionchange` (debounced) with a non-empty, non-huge selection
        │
        ▼
renders a small floating icon (Shadow DOM, positioned near selection.getRangeAt(0).getBoundingClientRect())
        │
        ▼ user clicks the icon
content script requests a lookup (via background service worker → API)
        │
        ▼
renders a compact result card (Shadow DOM) anchored to the selection: headword, phonetic, 1-2 senses per POS,
translation (if sourceLang !== targetLang), a "See full entry →" link to the web app's /word/:term page
        │
        ▼ click outside / Escape
card is removed; selection listener resumes
```

### 3.2 Right-click context menu (secondary flow)

- `chrome.contextMenus` item, `contexts: ['selection']`, title `Look up "%s" in Open Dictionary` (Chrome truncates/substitutes `%s` with the selection natively).
- Click → same compact result card as §3.1, anchored at the last known selection rect (or page center if the selection rect is unavailable, e.g. selection made in a PDF viewer or iframe with different privileges).
- Also useful as **the fallback path** if a site's CSP or an iframe boundary blocks the floating-icon content script (see §7.3) — the context menu is always available since it doesn't depend on a listener already running in that frame.

### 3.3 Toolbar popup (manual search)

- Clicking the extension icon opens a small popup (`popup.html`, ~360×480px) with:
  - a search input + submit,
  - the same compact result card renderer as §3.1/§3.2,
  - a "source → target" language pair, defaulting to the options-page setting,
  - a link to open the full entry on the web app.
- Independent of any page selection — this is the "I want to look something up right now" entry point, same job as the extension's icon click for most dictionary extensions (Google Dictionary, Reverso Context, etc.).

### 3.4 Options page

- Source language / target language pickers, built from `shared/languages.ts` (imported directly — no need to duplicate the list).
- Toggle: "Show icon on text selection" (on by default) vs. "Only look up via right-click" — lets privacy-conscious users disable the always-on content script behavior (see §7.3) without losing the feature entirely.
- API base URL — defaults to the production deployment; not exposed in the UI for v1 (hardcoded constant), but kept as a single constant to make self-hosting trivial later.
- Link to the web app and to `docs/security.md`/an extension-specific privacy note.

---

## 4. Architecture

### 4.1 Component diagram

```
Webpage (arbitrary origin)
   │
   ├── content-script.ts  ──(selectionchange / contextmenu selection)──►
   │        renders floating icon + result card via a React root inside a
   │        Shadow DOM (style isolation from the host page)
   │
   │        chrome.runtime.sendMessage({ type: 'LOOKUP', text, sourceLang, targetLang })
   │                          │
   ▼                          ▼
background/service-worker.ts (MV3 service worker; owns network + cache + context menu)
   │  ├── chrome.contextMenus.onClicked  → sends a LOOKUP message to the active tab's content script
   │  ├── chrome.storage.local           → response cache (mirrors src/api/dictionary.ts's localStorage cache)
   │  ├── chrome.storage.sync            → user settings (source/target lang, mode) — synced across the user's
   │  │                                     signed-in Chrome profiles, same idea as the web app's localStorage
   │  │                                     last-used-language-pair persistence
   │  └── fetch(`${API_BASE}/api/translate/${encodeURIComponent(text)}?from=&to=`)
   │
   ▼
Open Dictionary API (existing, unmodified endpoint; §6 covers the one CORS change needed)
   │
   ▼
popup.tsx (toolbar popup; talks to the background worker the same way as the content script)
options.tsx (options page; reads/writes chrome.storage.sync directly)
```

### 4.2 Why a service-worker-centric design (not fetch-from-content-script)

Content scripts run in the page's execution context but are **not** subject to the page's CSP for their *own* network requests in MV3 — however, routing all network calls through the background service worker instead is still preferred because:

- **One place owns the response cache** (`chrome.storage.local`), avoiding per-tab cache fragmentation.
- **One place owns rate-limiting/backoff** against the API (e.g. a simple client-side debounce so a user rapidly re-selecting text doesn't hammer the 20 req/min IP limit, §6).
- Content scripts are re-injected per page load; a long-lived cache/settings owner in the service worker is simpler to reason about.
- Matches the extension "3-layer" pattern (content script = DOM only, background = data/network, popup/options = settings UI) that keeps each file's permissions minimal and testable.

### 4.3 New repo layout

Proposed as a self-contained subproject at the repo root — mirrors how `server/` and `src/` are siblings today, keeping the extension's own `tsconfig`/build isolated from the web app's Vite config (different global (`chrome.*`) types, different manifest-driven output structure):

```
extension/
  manifest.json
  package.json              # own build script; can still `npm run build` from repo root via a
                             # root package.json script that shells into this dir, matching the
                             # `npm run dev:all`-style convenience scripts already in package.json
  vite.config.ts            # multi-entry build: background, content-script, popup, options
  src/
    background/
      index.ts              # service worker entry: context menu registration, message router
      lookupClient.ts        # fetch + chrome.storage.local cache (mirrors src/api/dictionary.ts)
      settings.ts            # chrome.storage.sync read/write + defaults
    content/
      index.ts               # selection listener, mounts/unmounts the Shadow DOM root
      SelectionIcon.tsx
      ResultCard.tsx          # shared with popup/options via src/shared/
    popup/
      popup.html
      Popup.tsx
    options/
      options.html
      Options.tsx
    shared/
      messages.ts             # typed message contract between content/background/popup (§5)
      renderEntry.tsx          # compact DictionaryEntry renderer, reused by ResultCard + Popup
    types.ts                  # re-exports/aligns with server/translate.ts's DictionaryEntry shape
  public/
    icons/                    # 16/32/48/128px action icons
docs/
  design-browser-extension.md-linked notes (optional; this doc stays at repo root per request)
```

`shared/languages.ts` and `shared/favorites.ts` (repo root) are imported **directly** by `extension/src/*` (relative import across the package boundary, same way `server/` already imports from repo-root `shared/`) — no copy, no duplication. `DictionaryEntry` is *not* imported from `server/translate.ts` (a server-only module with Express/Mongo deps) — instead `extension/src/types.ts` defines the same shape independently, matching the pattern already used by `src/api/dictionary.ts` (the web app also keeps its own `DictionaryEntry` copy rather than importing the server one, for the same reason: no cross-boundary dependency on server code from a client bundle).

### 4.4 Build tooling

- **`@crxjs/vite-plugin`** (or a hand-rolled multi-entry Vite config) to produce a valid MV3 bundle (correct service-worker output, content-script isolation, HTML entry rewriting) from TypeScript/React sources — keeps the extension on the same React + Vite + TypeScript stack as the rest of the repo instead of introducing a second framework.
- Dev loop: `vite build --watch` outputs to `extension/dist/`, loaded as an unpacked extension via `chrome://extensions` → "Load unpacked". No hot-reload-into-a-live-page magic is assumed for v1; rebuild + extension "reload" button is an acceptable dev loop.
- A root `package.json` script, e.g. `"ext:build": "npm --prefix extension run build"`, alongside the existing `dev:all`-style scripts, so `extension/` doesn't need a separate CI job entry.

---

## 5. Message Contract (content ↔ background ↔ popup)

All three surfaces talk to the background service worker via `chrome.runtime.sendMessage` with a small discriminated-union contract (`extension/src/shared/messages.ts`):

```ts
export type ExtensionMessage =
  | { type: 'LOOKUP'; text: string; sourceLang: string; targetLang: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: Partial<ExtensionSettings> }

export interface ExtensionSettings {
  sourceLang: string
  targetLang: string
  showSelectionIcon: boolean
}

export type ExtensionResponse =
  | { ok: true; entries: DictionaryEntry[] }
  | { ok: false; error: 'not_found' | 'timeout' | 'network' | 'api_error' | 'rate_limited' }
```

This mirrors `LookupErrorCode` already defined in `src/api/dictionary.ts` so error handling/UI copy can be kept consistent between the web app and the extension.

---

## 6. Backend Changes Required

**One change, additive and low-risk:** add the extension's origin to `ALLOWED_ORIGINS` (`server/config.ts`, checked in `server/app.ts`'s `corsOptions.origin`).

- A packaged, signed Chrome extension has a **stable ID** once first published to the Chrome Web Store (or pinned in dev via a `"key"` field in `manifest.json`), so its origin is a fixed string of the form `chrome-extension://<32-char-id>`.
- Background service worker `fetch()` calls send an `Origin: chrome-extension://<id>` header, which the current `cors()` middleware will reject unless it's in the allowlist (unlike a same-origin page load, which sends no `Origin` header and is already permitted by the "no origin → allow" branch in `corsOptions`).
- **Action:** append the extension origin to `ALLOWED_ORIGINS` in `server/.env` (comma-separated, same mechanism already used for multiple web origins), e.g.:
  ```
  ALLOWED_ORIGINS=https://open-dictionary.example.com,chrome-extension://<published-extension-id>
  ```
- No change needed to `/api/translate` itself: it is already public, unauthenticated, input-validated (`normalizeText`, language whitelist), and rate-limited (`TRANSLATE_RATE_LIMIT_RPM`, default 20/min per IP) — the extension is just another client of the same contract.
- **Rate-limit interaction to flag, not fix:** the limiter keys off IP (`express-rate-limit` default). Extension usage adds a new class of caller behind the same IP pool as regular web visitors (e.g. an office NAT running both the web app and many copies of the extension). This is an accepted trade-off for v1 — `docs/security.md` §"Operational hardening recommendations" already lists lowering/tuning `TRANSLATE_RATE_LIMIT_RPM` as a lever if adversarial/heavy traffic appears; no code change proposed here, just noting the extension increases the population hitting that limiter.
- **No auth changes for v1** — favorites/history stay web-app-only until Phase 2 (§9).

---

## 7. Manifest, Permissions & Security

### 7.1 `manifest.json` (MV3) sketch

```json
{
  "manifest_version": 3,
  "name": "Open Dictionary",
  "version": "0.1.0",
  "description": "Look up any word or phrase instantly — highlight or right-click.",
  "action": { "default_popup": "popup.html", "default_icon": "icons/32.png" },
  "background": { "service_worker": "background/index.js", "type": "module" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content/index.js"], "run_at": "document_idle" }
  ],
  "permissions": ["contextMenus", "storage"],
  "host_permissions": ["https://<api-domain>/*"],
  "options_page": "options.html",
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

Notable choices:

- **No `activeTab`, no broad `host_permissions` beyond the API domain.** The content script needs `<all_urls>` in `content_scripts.matches` to detect selections on any page, but it does **not** need `host_permissions` for arbitrary sites — it only ever calls `chrome.runtime.sendMessage` to the background worker, which is the only piece that needs network access, scoped to the API domain only.
- **`<all_urls>` content script is the one permission worth calling out explicitly** — it's what makes the "highlight anywhere → icon appears" UX possible, but it is also the permission Chrome Web Store reviewers and users scrutinize most (it reads page context, even though this extension only ever *acts* on an explicit user text selection, never reads or transmits arbitrary page content). See §7.3 for the mitigation already designed in: an options-page toggle to disable the always-on listener and fall back to right-click-only, which needs no listener running until invoked.
- **`object-src 'none'`-equivalent, no remote code** — MV3 already forbids remotely-hosted code; the CSP above is belt-and-suspenders, consistent with the strict CSP the web app already enforces at the edge (`nginx.conf`).

### 7.2 What data ever leaves the browser

- **Only the user's explicit text selection** (or manually-typed search-box text), plus the configured `sourceLang`/`targetLang` codes — sent to the existing public `/api/translate/:text` endpoint, identical payload shape to what the web app already sends today.
- **Nothing else about the page** (URL, DOM, cookies, other content) is read, stored, or transmitted. The content script's only job is: listen for a selection event, read `window.getSelection().toString()`, and relay that string (and the bounding rect for icon positioning, which never leaves the page) to the background worker.
- No PII, no page content, no browsing history is collected — this should be stated plainly in the Chrome Web Store privacy disclosure (§10) and mirrors the "no stored XSS / no scraping" posture already documented in `docs/security.md`.

### 7.3 Selection-icon vs. right-click-only trade-off (design decision, not deferred)

Two ways to satisfy "use the mouse with highlighting... to easily lookup a word":

| Approach | Permission cost | UX |
|---|---|---|
| **A. Always-on content script, `<all_urls>`** (chosen default) | Content script runs on every page; must be careful it never reads/transmits anything beyond the active selection | Icon appears automatically on any selection — matches Google Dictionary / Reverso Context UX, closest to "just highlight and go" |
| **B. Right-click-only, no persistent content script** | No `<all_urls>` needed for the icon path; content script is injected on-demand via `chrome.scripting.executeScript` only after a context-menu click, using the already-present `contextMenus` permission (no extra permission) | Still highlight-then-click, but via the OS-native right-click menu instead of a custom floating icon; no proactive listener anywhere |

**Decision:** ship **A as the default with the options-page toggle down to B** (§3.4) rather than choosing one exclusively. This gives the most natural "highlight to look up" experience out of the box while giving privacy-sensitive users (and, if needed, a faster Web Store review path) a one-click way to drop to the minimal-permission mode without losing functionality — the right-click path (§3.2) is implemented either way since it's needed as the fallback for frames/sites where the content script can't run (§3.2's last paragraph).

### 7.4 Output escaping

The compact result card renders LLM-produced text (definitions, examples, translations) inside a **Shadow DOM React root** — same escaping guarantee the main web app already relies on (`docs/security.md`: "no `dangerouslySetInnerHTML`; React escapes all LLM/dictionary output"). No `innerHTML`/manual string templating anywhere in `content/`, `popup/`, or `options/`.

---

## 8. Caching & Offline Behavior

- **`chrome.storage.local`** replaces `localStorage` as the client-side L1 cache (service workers have no `window`/`localStorage`). Same envelope shape and TTL policy as `src/api/dictionary.ts` (`{ data, fetchedAt }`, TTL — reuse 30 days), keyed the same way: `` `${sourceLang}:${targetLang}:${word}` ``.
- This is a **separate cache from the web app's `localStorage`** (different storage API, different browser profile scope) — no shared cache between the web app and the extension in v1. Acceptable: both ultimately hit the same server-side Mongo cache (§ design-translation-cache.md), so a cross-surface cache miss just costs one extra network round trip, not an LLM call, once the word is warm server-side.
- `chrome.storage.local` has a much smaller quota than `localStorage` (browser-dependent, typically several MB) — bound the cache with a simple LRU eviction or a max-entry count if this becomes an issue; not expected to be a problem for a single user's lookup volume.
- No offline mode for v1 — a failed `fetch` surfaces the same `LookupError`-style codes as the web app (`network`/`timeout`/`api_error`) in the result card, with a simple inline retry.

---

## 9. Phase 2 (deferred): Auth0 sign-in, favorites & history sync

Not in v1 scope, but designed for so v1 doesn't paint the project into a corner:

- MV3 service workers can't hold a long-lived popup-based OAuth session the way a SPA tab can. The standard pattern is `chrome.identity.launchWebAuthFlow` against Auth0's `/authorize` endpoint (Auth0 supports this as a "Chrome Extension" or generic SPA application type with the extension's redirect URI `https://<extension-id>.chromiumapp.org/`).
- Once a valid Auth0 access token is obtained, the extension can call the **existing, unmodified** `/api/favorites` and `/api/user-data` endpoints (`server/favorites.ts`, `server/app.ts`) — they already trust only the verified JWT `sub`, so no backend change is needed there either, only a new `ALLOWED_ORIGINS` entry (already added in §6) and a new Auth0 "Allowed Callback URL" entry for the `chromiumapp.org` redirect.
- Token storage: `chrome.storage.local` (not `localStorage`), with the same "anonymous → prompt to log in → pending-favorite in a short-lived buffer" UX the web app already uses (`README.md`'s "Anonymous users are prompted to log in before favoriting" flow) — reusable pattern, not a new design.
- Left out of v1 to keep the first shippable milestone small: the identity/token-exchange flow is the single highest-risk, highest-effort piece of an extension, and the core "look up a word" value is fully deliverable without it.

---

## 10. Chrome Web Store Submission Concerns

- **Privacy policy required** — the store requires a privacy policy URL for any extension requesting host permissions or handling user data, even minimal data like the one described in §7.2. A short, honest policy ("we only transmit the text you explicitly select or type, plus your chosen language pair, to our lookup API; we do not collect browsing history, page content, or PII") should live at a stable URL on the existing web app (e.g. `/privacy`), not embedded only in the store listing.
- **Permission justification** — the store review form asks for a plain-language justification per requested permission; §7.1/§7.3 above map directly to that form (`contextMenus` → right-click lookup; `storage` → settings + cache; content-script `<all_urls>` → detect text selection to show the lookup icon, with an explicit "no page content is read beyond the user's selection" note).
- **Single-purpose policy** — the extension must do one thing (dictionary lookup); avoid scope creep (e.g. don't bundle unrelated features) to stay compliant.
- No remotely-hosted or eval'd code (already satisfied — MV3 forbids it, and the design has no such need).

---

## 11. Testing Plan

- **Unit tests (vitest, matching the repo's existing `*.test.ts` convention):**
  - Selection-text extraction/normalization helpers (trim, length cap, empty-selection guard) — pure functions, easily tested without a DOM.
  - The message contract (`ExtensionMessage`/`ExtensionResponse` construction/parsing) — pure functions.
  - `lookupClient.ts`'s cache read/write logic against a mocked `chrome.storage.local` (a small in-memory fake is enough; `chrome.storage` has no official test double, but a `Map`-backed shim covering `get`/`set` is sufficient).
- **Manual QA (v1, no automated e2e):**
  - Load unpacked in Chrome; verify selection icon appears/disappears correctly across a few real sites (including at least one with a strict CSP, to confirm the Shadow-DOM-in-content-script approach isn't blocked, and to exercise the right-click fallback where it is).
  - Verify context-menu path, popup manual search, and the options-page language/mode toggles.
  - Verify the CORS change (§6) against a real deployment before publishing — a broken CORS entry fails silently as a network error in the extension, easy to miss without a manual check.
- **Automated e2e (explicitly deferred):** Puppeteer/Playwright extension-loading support exists and could drive the selection → icon → click → result flow end-to-end; not included in v1 given the size of the rest of this scope — flagged as a natural Phase 2/3 addition once the manual QA loop above becomes a bottleneck.

---

## 12. Rollout Plan

1. **Scaffold `extension/`** — manifest (with a pinned `"key"`, §13.1), Vite multi-entry build, icons (derived from `public/favicon.svg`, §13.3), empty background/content/popup/options entries that build and load unpacked with no functionality yet.
2. **Backend: add extension origin to `ALLOWED_ORIGINS`** (§6) — ship independently, zero behavior change for existing clients.
3. **Toolbar popup with manual search** (§3.3) — smallest end-to-end slice: popup → background → `/api/translate` → render. Validates the whole pipe before touching content scripts.
4. **Context menu lookup** (§3.2) — second-smallest slice; no persistent content script needed yet (`chrome.scripting.executeScript` on demand), reuses the popup's result-card renderer.
5. **Selection icon + inline result card** (§3.1) — the full "highlight to look up" experience; add the options-page toggle (§7.3) in the same pass since it's core to the permission story.
6. **Options page** (§3.4) — language pair + mode toggle, wired to `chrome.storage.sync`.
7. **Polish for store submission** — icons at all required sizes, privacy policy page, permission justifications, store listing copy; submit for review.
8. **Phase 2** (§9) — Auth0 sign-in + favorites/history sync, once v1 has real usage data justifying the added complexity.

Each phase after (2) is independently shippable as an unpacked/internal build; nothing here requires taking the web app or API offline.

---

## 13. Decisions (previously open questions)

1. **Extension ID pinning for dev vs. prod: pin a `"key"` early.** Generate a dedicated dev keypair (`chrome.exe --pack-extension` or the "Load unpacked" → note the auto-assigned ID → later replace with a pinned `"key"` field, whichever is simpler in practice) and add its resulting stable ID to `ALLOWED_ORIGINS` from day one (§6, §12 phase 2). Rationale: CORS is the one piece of this design that talks to a real deployment; discovering a mismatched ID at Web Store submission time — after the backend is already deployed — is a needless extra round trip. Pin early, re-key only if the Chrome Web Store assigns a different published ID than the pinned dev one (in which case both IDs can sit in `ALLOWED_ORIGINS` side by side during the transition).
2. **Self-hosted API base URL: build-time constant, not a v1 options-page field.** Keep `API_BASE` a single exported constant (`extension/src/shared/config.ts`) for v1 — simplest to implement and test, and the project has no other self-host-facing extension precedent yet. Revisit as a user-facing options-page field only if a self-hoster actually asks for it (matches the project's existing bias toward shipping the simple thing first, e.g. `PUBLIC_BASE_URL` in `server/config.ts` is also just an env constant, not a runtime-configurable UI field).
3. **Icon design: derive from `public/favicon.svg`, don't commission new art for v1.** `public/favicon.svg` is the project's only existing brand asset; render it to the four required raster sizes (16/32/48/128px) via a one-off script (e.g. `sharp`/`resvg` in a `scripts/` helper, or a manual export) rather than blocking the extension on new design work. Revisit with real branding once the extension has users.
4. **Firefox port: explicitly out of scope until Chrome has real usage.** MV3 background service workers and Firefox's WebExtensions background-page model diverge enough (and Firefox's MV3 support is still catching up) that porting now would mean designing for a moving target. Decision: ship Chrome-only, revisit Firefox (via `webextension-polyfill` + a second manifest target) only after usage data justifies the cross-browser maintenance cost — consistent with the Non-Goals in §2.
