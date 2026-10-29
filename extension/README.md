# Open Dictionary — Chrome Extension

Look up any word or phrase instantly: highlight it on a page, right-click it,
or type it into the toolbar popup. Built with React + Vite + TypeScript,
packaged as a Manifest V3 extension via `@crxjs/vite-plugin`.

---

## Build & develop

```bash
npm install
npm run dev          # watch build for local development
npm run build        # one-off dev build (with sourcemaps + localhost perm)
npm run build:prod   # Web Store build (strips key + localhost perm, no sourcemaps)
npm test             # vitest unit tests
```

### Load it locally (development)

1. `npm run dev` (or `npm run build`)
2. Open `chrome://extensions/` → enable **Developer mode**
3. **Load unpacked** → select this directory's `dist/` folder
4. The extension loads with the stable dev ID
   `mliclnamclidbemdcahklcdoikncablf` (pinned via `manifest.json`'s `"key"` —
   see "Dev Signing Key" below).

### Cut a production release

See [`RELEASE.md`](./RELEASE.md) for the full operator runbook — build steps,
pre-submission checklist (CORS, Auth0 callbacks, privacy policy, screenshots),
and the Web Store submission flow.

---

## Audio playback (why there is an offscreen document)

The pronunciation buttons (UK / US) behave differently depending on where the
result card renders:

| Surface | How the clip plays |
|---|---|
| Toolbar popup (an extension page) | A local `<audio>` element — only the extension's own CSP applies. |
| In-page card (selection icon / right-click; a content script) | `PLAY_AUDIO` message → service worker → **offscreen document** (`src/offscreen/`) plays it. |

**Why:** the in-page card lives inside the host page, so a `<audio>` there is
subject to the *page's* CSP `media-src`. Pages with a strict CSP (e.g. job
boards) block `media.merriam-webster.com`; the console shows
`Loading media … violates … media-src` / `Media load rejected by URL safety
check`, and the button used to do nothing ("works on some sites, not others").
An offscreen document is an extension page, so host-page CSPs can't block it.

Pieces: `src/shared/renderEntry.tsx` (`AudioButton`, `isExtensionPage`),
`src/background/audioPlayer.ts` (https-only validation, creates the offscreen
document on demand, forwards the clip), `src/offscreen/offscreen.{html,ts}`
(plays it). Requires the `offscreen` permission (see `STORE_LISTING.md`), and
`offscreen.html` is an extra Vite entry in `vite.config.ts` because nothing in
the manifest references it. A failed play is logged as
`[open-dictionary] audio … failed` and the button turns red; click to retry.

---

## Documentation index

| Doc | Purpose |
|---|---|
| [`README.md`](./README.md) | This file — overview, build/dev commands, doc index. |
| [`RELEASE.md`](./RELEASE.md) | **Production release runbook.** How to cut a Web Store build, pre-submission checklist, submission steps. |
| [`STORE_LISTING.md`](./STORE_LISTING.md) | **Web Store submission copy.** Privacy policy URL, single-purpose statement, per-permission justifications, short/long descriptions, screenshot checklist. |
| [`design-browser-extension.md`](./design-browser-extension.md) | **Design doc.** Architecture, the 3-layer pattern (content/background/popup), permission rationale, security model, rollout phases. Read this first for "why". |
| [`Chrome-extension-to-do-list.md`](./Chrome-extension-to-do-list.md) | **Phase tracking.** Implementation progress across the 10 phases (scaffold → popup → context menu → selection icon → options → store submission → auth → …). |
| [`FIREFOX_PORT.md`](./FIREFOX_PORT.md) | Research/scaffolding notes for a Firefox port (not yet a working build). |

---

## Chrome Extension — Dev Signing Key

`dev-key.pem` (this directory) is the **private** half of the RSA keypair
whose public half is pinned in `manifest.json`'s `"key"` field. It is
**gitignored** (`.gitignore`: `extension/*.pem`) and must never be committed —
see design-browser-extension.md §13.1 for why the key is pinned at all
(stable extension ID across reloads, so `ALLOWED_ORIGINS` doesn't need to
change every time the extension is reloaded unpacked during development).

**You do not need this file to build or load the extension.** Chrome derives
the extension's ID from the `"key"` field already embedded in
`manifest.json`, not from `dev-key.pem` itself — the `.pem` only exists so
the key can be regenerated/rotated if ever needed. Nothing in the build or
runtime reads this file.

> **Web Store note:** the `"key"` field is **stripped** by `npm run build:prod`
> because the Web Store rejects an explicit key and assigns its own published
> ID (which differs from the dev ID above). See `RELEASE.md` §1 and §4 for
> the CORS/Auth0 consequences of that new ID.

## Regenerating the key pair (only if rotating)

```bash
openssl genrsa -out dev-key.pem 2048
openssl rsa -in dev-key.pem -pubout -outform DER -out /tmp/key.pub.der
base64 -i /tmp/key.pub.der | tr -d '\n'
```

Paste the resulting base64 string into `manifest.json`'s `"key"` field. The
extension's new ID (which must then be re-added to `ALLOWED_ORIGINS` in
`server/.env`) can be computed as:

```bash
python3 -c "
import hashlib
with open('/tmp/key.pub.der', 'rb') as f:
    der = f.read()
h = hashlib.sha256(der).hexdigest()[:32]
print(h.translate(str.maketrans('0123456789abcdef', 'abcdefghijklmnop')))
"
```

Current pinned dev extension ID: `mliclnamclidbemdcahklcdoikncablf`
