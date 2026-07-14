# Production Release Runbook — Open Dictionary Chrome Extension

Step-by-step operator guide for cutting a Chrome Web Store release. Source of
truth for *how* to ship; `STORE_LISTING.md` holds the *copy* to paste into the
dashboard.

---

## 1. What a production build does

`npm run build:prod` (→ `vite build --mode prod`) differs from the dev build
(`npm run build`) in two ways, both enforced in `vite.config.ts`:

| Aspect | Dev (`build`) | Prod (`build:prod`) |
|---|---|---|
| `host_permissions` | includes `http://localhost:3001/*` | **stripped** (only `dict.ai-dictionary.org` + Auth0 remain) |
| Source maps | enabled (`.map` files emitted) | **disabled** (no TS/React source in the bundle) |

The `"key"` field is **kept** in both builds — it pins a stable extension ID
(`mliclnamclidbemdcahklcdoikncablf`) so CORS/Auth0 callback URLs don't have to
change between dev and prod. See `README.md` §"Dev Signing Key".

---

## 2. Build the upload artifact

```bash
cd extension
npm install              # if node_modules is missing/stale
npm run build:prod
```

Then package `dist/` into a zip with `manifest.json` at the root:

```bash
cd dist
zip -r ../open-dictionary-extension-v$(node -p "require('../package.json').version").zip .
```

> Source maps are already excluded by the prod build, so there's nothing extra
> to filter out of the zip.

The resulting `open-dictionary-extension-v0.1.0.zip` is the file to upload to
the Chrome Web Store dashboard.

---

## 3. Verify before uploading

Load `dist/` unpacked in Chrome (`chrome://extensions` → Developer mode →
Load unpacked) and confirm against the **production** API:

- [ ] Popup manual search round-trips to `https://dict.ai-dictionary.org`.
- [ ] Highlight a word on a real page → selection icon appears → result card renders.
- [ ] Right-click → "Look up … in Open Dictionary" → result renders.
- [ ] Options page: language pickers + "Show icon on text selection" toggle persist.
- [ ] (If auth is in scope) Sign-in flow completes via Auth0.

A broken CORS entry fails *silently* as a network error in the extension —
this manual check is the only way to catch it.

---

## 4. Pre-submission checklist (external / manual)

These cannot be done from code — track them here so nothing is missed.

### 4.1 Backend — CORS allowlist
- [ ] `server/.env` `ALLOWED_ORIGINS` includes
      `chrome-extension://mliclnamclidbemdcahklcdoikncablf` (the pinned ID).
      Add the **published** ID too once the Web Store assigns one (it may
      differ — see `README.md` and design doc §13.1). Keep both during the
      transition, drop the dev ID once fully cut over.
- [ ] Redeploy the server and verify the CORS header is live (curl with
      `Origin: chrome-extension://mliclnamclidbemdcahklcdoikncablf`).

### 4.2 Auth0 — callback URLs
- [ ] In the Auth0 dashboard (tenant `dev-oz1bs6okox5c8xd0.us.auth0.com`),
      the application's **Allowed Callback URLs** includes
      `https://mliclnamclidbemdcahklcdoikncablf.chromiumapp.org/`.
      Without this, `chrome.identity.launchWebAuthFlow` fails with
      "callback URL mismatch".
- [ ] Add the published ID's callback URL once assigned.

### 4.3 Privacy policy
- [ ] `https://dict.ai-dictionary.org/privacy` is live and matches
      `STORE_LISTING.md` (source: `src/pages/PrivacyPage.tsx`).

### 4.4 Store listing assets
- [ ] 128×128 store icon — reuse `public/icons/128.png`.
- [ ] 1 Small promo tile (440×280) — optional but recommended.
- [ ] 1 Marquee promo (1400×560) — optional.
- [ ] 3–5 screenshots (1280×800 or 640×400) — see `STORE_LISTING.md`'s
      screenshot checklist.

---

## 5. Submit to the Chrome Web Store

1. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/).
2. **Package** → upload the zip from §2.
3. Fill **Store listing** from `STORE_LISTING.md` (short/long description, category,
   language, screenshots, icons).
4. **Privacy practices** → paste the privacy policy URL and the per-permission
   justifications from `STORE_LISTING.md`.
5. Submit for review.

Review typically takes hours to a few days.

---

## 6. After publishing

- [ ] Note the **published extension ID** assigned by the Web Store.
- [ ] If it differs from the pinned dev ID, add it to `ALLOWED_ORIGINS`
      (server) and Auth0 Allowed Callback URLs, then drop the dev ID.
- [ ] Tag the release in git: `git tag -a v0.1.0 -m "Web Store v0.1.0" && git push --tags`.
