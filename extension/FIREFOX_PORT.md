# Firefox Port — Research Notes (Phase 10, deferred)

Not implemented. This is a research/scaffolding doc only, per design doc §13 / Phase 0's
decision to ship Chrome-only for v1 and defer a Firefox build until the Chrome version has
meaningful usage. Nothing here has been built or tested — it's a starting point for whoever
picks this up.

## 1. Manifest V3 support gap

Firefox does support Manifest V3, but with two load-bearing differences from Chrome's MV3 that
directly affect this codebase:

- **Background scripts, not just service workers.** Firefox's MV3 still allows (and, in practice,
  many extensions use) a persistent-enough `"background": {"scripts": [...]}` in addition to
  `"service_worker"`. Firefox's service-worker-based background is less battle-tested than
  Chrome's — as of this writing, Mozilla's own guidance leans toward `background.scripts` for
  reliability on Firefox. This repo's `extension/src/background/serviceWorker.ts` currently
  assumes Chrome's service-worker lifecycle (module-scope listeners registered once, no
  persistent global state relied upon across restarts) — that pattern is *compatible* with
  Firefox's background-script model too (it doesn't rely on anything service-worker-specific
  like `self.skipWaiting()`), so this file likely ports with only a manifest-key change, not a
  logic rewrite. Re-verify this assumption before porting; don't assume without testing.
- **`browser_specific_settings.gecko.id` is required.** Unlike Chrome's `"key"`-derived ID (see
  `extension/README.md`), Firefox extensions need an explicit
  `browser_specific_settings.gecko.id` (e.g. `open-dictionary@ai-dictionary.org`) in the
  manifest to get a stable ID across installs — this is the Firefox equivalent of the pinned dev
  signing key, and would need its own `ALLOWED_ORIGINS` entry server-side
  (`moz-extension://<gecko-id>` is *not* how Firefox's origin header works for extension pages,
  though — verify the actual `Origin`/`moz-extension://<generated-uuid>` behavior for cross-origin
  fetches before assuming the same CORS approach as Chrome's `chrome-extension://<id>` applies
  unchanged; Firefox randomizes the internal UUID per-profile by default unless
  `gecko.id` pins it).

## 2. `chrome.*` vs `browser.*` API namespace

Firefox implements the WebExtensions API under `browser.*`, returning **Promises** natively
(no callback style), while Chrome implements the same APIs under `chrome.*` with callback style
in MV2 and Promise-returning in MV3 for most (not all) methods. This codebase already exclusively
uses the **Promise-returning `chrome.*` form** (see `getSettings()`/`lookupWord()` in
`extension/src/background/`, `chrome.runtime.sendMessage(...)` in `Popup.tsx`/`Options.tsx`) —
no callback-style calls anywhere, which is the easy half of cross-browser compatibility.

The standard fix is Mozilla's own **`webextension-polyfill`**
(https://github.com/mozilla/webextension-polyfill): it defines a global `browser` object in
Chrome that mirrors `chrome.*` as Promises, OR (more relevant for a Firefox port of a
Chrome-first codebase) can be used the other way — import it and use `browser.*` everywhere,
and it no-ops on Firefox where `browser.*` already exists natively. Practically, for this
codebase the smallest diff is:

1. `npm install webextension-polyfill` (+ `@types/webextension-polyfill`) in `extension/`.
2. Add `<script src="browser-polyfill.js">`-equivalent import (or the ESM import form) at the
   top of each entry point (`serviceWorker.ts`, `selectionListener.tsx`, `Popup.tsx`,
   `Options.tsx`, `contextMenuRender.tsx`).
3. Rename every `chrome.*` call to `browser.*` (a global find/replace across
   `extension/src/**/*.ts(x)` — mechanical, no logic changes expected since the codebase is
   already Promise-only).
4. Chrome-only APIs used here that need checking for Firefox parity:
   - `chrome.identity.launchWebAuthFlow` — Firefox does **not** implement `identity.launchWebAuthFlow`
     the same way (no `chromiumapp.org`-style reserved redirect domain). Firefox's equivalent
     pattern for OAuth in an extension is opening a normal tab to the Auth0 `/authorize` URL with
     a `redirect_uri` pointing at an extension page (`moz-extension://<id>/oauth-callback.html`)
     that the extension's `webNavigation`/`tabs` listener watches for, then closes. This is a
     **non-trivial rewrite** of `extension/src/background/authClient.ts`'s `runAuthFlow()` — not
     a polyfill-covered API. Budget real time for this specifically if Phase 9's Auth0 flow needs
     to survive a Firefox port.
   - `chrome.scripting.executeScript` — Firefox supports the `scripting` API since Firefox 102;
     should be a drop-in replacement, but re-verify the `?script`/`onExecute()` convention
     (`@crxjs/vite-plugin`-specific, see `contextMenuRender.tsx`'s doc comment) still applies —
     that convention is a **build-tool** concept (crxjs), not a browser API, so it depends on
     whether the Firefox build uses the same crxjs plugin or a different bundler (see §3).
   - `chrome.storage.sync` — supported in Firefox, but backed by Firefox Sync account
     infrastructure rather than a Google account; functionally equivalent for this codebase's
     usage (`ExtensionSettings`), no code change expected.

## 3. Build tooling: `@crxjs/vite-plugin` is Chrome-only

`@crxjs/vite-plugin` (this project's current bundler plugin, `extension/vite.config.ts`) is
**Chrome/Chromium-MV3-specific** — it doesn't support Firefox's manifest quirks
(`browser_specific_settings`, potentially `background.scripts` instead of `service_worker`).
Options for a real Firefox build, roughly in order of effort:

1. **`web-ext` (Mozilla's own CLI) + a hand-maintained second manifest.** Keep Vite for the
   React/TS bundling (popup, options, content scripts) but drop crxjs for the Firefox target,
   writing a `manifest.firefox.json` by hand and using `web-ext build`/`web-ext run` for
   packaging/dev-reload. Most control, most manual manifest-sync burden between the two targets.
2. **`vite-plugin-web-extension`** (community plugin, supports both Chrome and Firefox manifest
   conventions from one config) — would likely replace `@crxjs/vite-plugin` entirely, for both
   targets, rather than adding a second parallel config. Re-evaluate its MV3/Firefox support
   status at port time since this ecosystem moves fast.
3. Given the existing Vite config is Chrome-shaped already (`extension/vite.config.ts`'s crxjs
   plugin, `manifest.json` at the project root read directly by crxjs), the pragmatic path is
   probably a **separate `extension-firefox/` sibling package** that imports/re-exports the same
   `src/` React components and `shared/` logic (no code duplication) but has its own
   `package.json`, bundler config, and manifest — mirroring how `extension/` itself already sits
   alongside `src/`/`server/` as an independent buildable unit reusing root `shared/`.

## 4. CSP / permissions review differences

- Firefox's AMO (addons.mozilla.org) review process has its own **Add-on Policies**
  (distinct from Chrome Web Store's) — re-read those at port time rather than assuming Chrome's
  single-purpose/permission-justification rules (§`STORE_LISTING.md`) map 1:1. Notably AMO
  requires **full source submission** for review if the build isn't trivially reproducible from
  the packaged output (a bundled/minified Vite build likely qualifies) — budget time to prepare a
  clean source zip + build instructions alongside the packaged `.xpi`.
- The `content_security_policy` string in `extension/manifest.json` (`"script-src 'self';
  object-src 'self'"`) is the MV3 object form Chrome expects
  (`content_security_policy.extension_pages`); Firefox's accepted CSP manifest shape has
  historically been a plain string under `content_security_policy` (not nested under
  `extension_pages`) even in MV3 — re-verify current Firefox MV3 manifest schema before reusing
  as-is.

## 5. Testing

The Chrome-for-Testing + Puppeteer headless verification harness used for Phases 5-9
(`/var/folders/.../ext-test/test.js`, `regress.js` — see `Chrome-extension-to-do-list.md`'s
implementation notes) is Chrome-specific (`puppeteer-core` drives Chromium's DevTools Protocol).
A Firefox equivalent would use **`playwright`** (which has first-class Firefox support) or
Mozilla's own `web-ext run --target firefox-desktop` for manual QA — no automated headless
Firefox extension test harness exists in this repo yet.

## 6. Suggested sequence, if/when this is picked up

1. Confirm real usage numbers justify the effort (Phase 0's original gate for this whole phase).
2. Spike the Auth0 OAuth rewrite first (§2's `identity.launchWebAuthFlow` gap) — it's the
   highest-risk unknown, same as Chrome's own Phase 9 was flagged as the highest-risk piece of
   the whole project.
3. Stand up a parallel `extension-firefox/` package (§3, option 3) reusing `shared/` and as much
   of `extension/src/` as compiles unchanged after the `chrome.*` → `browser.*` polyfill swap
   (§2).
4. Re-run the full Phase 8 unit test suite unchanged (it's pure-function/`chrome.storage`-fake
   based, not Chrome-runtime-dependent — see `extension/src/background/testUtils.ts`) against the
   polyfilled code to catch behavioral regressions from the API swap.
5. Manual QA via `web-ext run`, then AMO submission once stable.
