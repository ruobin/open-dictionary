# Security model & hardening

This document records the threat model for the open-dictionary API and SPA, the
issues found during a security review, and the mitigations in place. It is a
living document — update it whenever the trust boundary changes.

## Trust boundary

```
Browser (SPA, Auth0-authenticated)
   │  HTTPS (TLS terminated at the edge nginx)
   ▼
Edge nginx  ──►  Express API (:3001, behind nginx)  ──►  MongoDB (private docker net)
   │                         │
   │                         ├──► LLM provider (DeepSeek / OpenRouter / Z.AI)
   │                         └──► Merriam-Webster dictionary API
   ▼
Static SPA assets (/var/www/…, content-hashed)
```

- **Identity** is an Auth0 access token (JWT, RS256, audience
  `AUTH0_AUDIENCE`). The server trusts **only** the verified token's `sub` —
  never a client-supplied identity header.
- **Translate** (`GET /api/translate/:text`) and **more-examples** (`GET /api/more-examples`) are public and rate-limited (5 req/min/IP, hard-capped — see below); neither touches user data. The Chrome extension (`extension/`) is an additional caller of the translate endpoint — see [design-browser-extension.md](../design-browser-extension.md) §6. Its `chrome-extension://<id>` origin is allowlisted in `ALLOWED_ORIGINS` alongside the web app's origin(s); no new trust boundary since the endpoint was already public/unauthenticated. Extension traffic does add a new class of caller behind the shared per-IP rate limiter (design doc §6) — a lever to revisit if adversarial/heavy extension traffic appears.
- **Favorites** (`/api/favorites`) and **user-data** (`/api/user-data`) require
  a valid access token and operate only on the caller's own data.
- **Admin** (`/api/admin/*`) requires a valid access token **and** an
  allowlisted `sub` (`ADMIN_USER_IDS`) — see [Admin plane](#admin-plane-added-2026-07-11)
  below.

## Findings & mitigations

| ID | Severity | Finding | Mitigation |
|----|----------|---------|------------|
| S1 | Critical | Favorites identity was taken from an unauthenticated, spoofable `X-User-Key` header — full IDOR (read/add/delete anyone's favorites). | All favorites routes require a verified Auth0 JWT (`checkJwt`); `userKey` is derived from `req.auth.payload.sub`. The client now sends `Authorization: Bearer <token>` (see `src/api/favorites.ts`). |
| S2 | High | `sourceLang`/`targetLang` were unvalidated and uncapped → unbounded cache cardinality + paid LLM calls per distinct tuple (cache flooding / economic DoS). | `from`/`to` are validated against `LANGUAGES` in `shared/languages.ts`; unknown codes return `400 invalid_language`. |
| S3 | Medium | `userKey` length was unbounded → storage abuse. | Capped to 128 chars (well above any real Auth0 `sub`). |
| S4 | Low | Control characters in lookup text (log-injection / cache-key integrity). | `normalizeText` strips C0/DEL control chars; whitespace is collapsed (newline injection already prevented). |
| S5 | Medium | `react-router` open-redirect CVE (GHSA-2j2x-hqr9-3h42); plus dev-only `shell-quote`/`vite` advisories. | `npm audit fix` applied — `npm audit` reports 0 vulnerabilities. |
| S6 | Low | SPA was served with only HSTS (the API has `helmet`; the static SPA did not). | Edge nginx now adds HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and a strict **CSP** (scripts same-origin only, no inline scripts). |

## Admin plane (added 2026-07-11)

`/api/admin/*` (LLM provider management, latency benchmarking, model-comparison
playground, cache-entry management, report triage, audit log — see
`docs/design-admin-portal.md` §19 for the full surface index) is a second,
higher-privilege trust boundary on the same Express app. Summary of its
controls, expanded from design doc §13:

| Concern | Control |
|---|---|
| AuthN | Same Auth0 JWT as the rest of the API (`checkJwt`) — no separate identity system. |
| AuthZ | **Allowlist-only**: `sub` must be in `ADMIN_USER_IDS` (comma-separated Auth0 subs, `server/.env`). No Auth0 RBAC/permission claims are checked — see design doc §6, §17. |
| Unauthenticated request | `401` (existing `checkJwt` behavior, unchanged). |
| Authenticated, not on allowlist | `403 {"error":"forbidden"}`. Not persisted to the audit log — logging denied requests to Mongo would itself be an unauthenticated write channel. |
| Frontend gate | Cosmetic only. `<RequireAdmin>` checks `isAuthenticated`, not the allowlist (no claim exists to check client-side); the real gate is the server 403 above, surfaced in the UI by the first failed API call. Never rely on the client for authorization. |
| Bundle exposure | The admin SPA (`src/pages/admin/*`) is `React.lazy`-loaded — its code never ships in the bundle served to non-admin users, so it isn't even inspectable without an admin session. |
| Secrets at rest | Provider API keys are **AES-256-GCM** encrypted with a server-only master key (`CONFIG_ENCRYPTION_KEY`), never stored or logged in plaintext. |
| Secrets in transit / API responses | **Write-only**: no response ever contains a decrypted key, only `{set: true, last4}`. There is no "reveal" endpoint. `PATCH` with `apiKey` omitted keeps the existing key. |
| Audit trail | Every mutation (`provider.create/update/delete`, `active.switch`, `benchmark.run`, `env.import`, `entry.delete`, `entry.batch_delete`, `report.dismiss`) is appended to `admin_audit` (365-day TTL) with actor, IP, and a diff — key material is redacted to `"(rotated, last4=…)"`, never the key itself. Ad-hoc diagnostics (`POST /llm/test`, `POST /llm/playground`) are deliberately not audited — they mutate nothing. |
| Rate limiting | Admin router is rate-limited separately (`ADMIN_RATE_LIMIT_RPM`, default 30/min/IP) — same `express-rate-limit` pattern as the rest of the API. |
| Economic abuse (paid LLM calls via test/benchmark/playground) | Admin-only; hard caps (benchmark ≤10 samples × ≤10 targets × ≤10 custom words; playground ≤6 targets × 1 call, word ≤128 chars, langs validated against the supported set; all vendor calls capped at the 15 s production timeout ceiling); one benchmark globally in flight at a time (in-memory mutex); every benchmark run audited. |
| SSRF via provider `baseUrl` | Accepted admin-trust tradeoff, not a vulnerability: `https://` required outside dev, and an admin could reach the same outcome by simply saving a malicious provider — there is no *unauthenticated* path to this. |
| CSRF | N/A — bearer tokens only, `credentials: false`, no cookies; unchanged from the rest of the API. |
| Injection | Provider ids are validated as Mongo `ObjectId`s before use; `translations._id` (`GET/DELETE /entries/:id`) is validated against `/^[a-f0-9]{40}$/`; the `word` filter is regex-escaped (`escapeRegex()`) and always an anchored prefix match; all writes bind typed scalars, per the existing convention. |
| Cache entries CRUD (`/api/admin/entries*`, `/api/admin/reports/summary`, docs/design-admin-cache-entries.md) | Same trust boundary as the rest of this table — no new auth model. Deletes are hard (no undo) but audited; batch delete is capped at 20 explicit ids per call, never a query-shaped bulk delete. Entry detail responses expose the same `DictionaryEntry` content already public via `/api/translate/:text` — no new data exposure. |
| User activity log (`/api/admin/activity*`, docs/design-user-activity-log.md) | Same trust boundary — read-only, admin-only. **New PII surface**: unlike every other collection here, `activity_log` persists the client IP and a parsed device/browser/OS summary (never the raw `User-Agent`) for every public, unauthenticated `/api/translate/:text` request, disclosed on `/privacy`. Shortest TTL in the app (180 days) given the volume/sensitivity tradeoff. |

**Operator setup required:** `ADMIN_USER_IDS` and `CONFIG_ENCRYPTION_KEY` are
unset by default. With both unset, `/api/admin/*` fail-closed (every request
403s) rather than failing open — there is no way to reach the admin plane
without deliberately configuring it.

## Verified safe (no change required)

- **No stored XSS** — no `dangerouslySetInnerHTML`/`innerHTML`; React escapes
  all LLM/dictionary output (definitions, examples, audio URLs).
- **No NoSQL injection** — every Mongo query binds typed scalars (strings from
  normalized input or the JWT `sub`); no object/operator injection from user
  input.
- **CORS** — `credentials: false` plus an explicit origin allowlist
  (`ALLOWED_ORIGINS`). Requests without an `Origin` header (server-to-server)
  are permitted; credentialed cross-origin access is not.
- **Secrets** — `.gitignore` excludes `.env`/`server/.env` and only
  `.env.example` files are tracked. Secrets live in local env files and are
  injected into the API container via `env_file`.
- **Error handling** — stack traces are only served when `NODE_ENV=development`;
  production returns generic `{error}` JSON.
- **Body size** — `express.json({ limit: '64kb' })` bounds request bodies.

## Defense in depth (controls always on)

- Per-IP, per-route rate limits: translate 5/min, more-examples 5/min,
  favorites 60/min, user-data 60/min (configurable via env). The two LLM
  endpoints are hard-capped at 5/min (`LLM_RATE_LIMIT_MAX_RPM` in
  `server/config.ts`) so a single client can't drive unbounded token spend.
  `TRUST_PROXY=1` keys off the real client IP behind nginx.
- `helmet` on every API response (CSP, no-sniff, frame guard, etc.).
- `Strict-Transport-Security` with `includeSubDomains` at the edge.
- MongoDB is internal to the docker network (not published to the host).
- The API container listens on `127.0.0.1:3002` only — reachable solely via the
  edge nginx, not the public internet.

## Operational hardening recommendations

These are **not** required for correctness but improve the security posture
further; pick what fits your environment:

1. **Rotate exposed credentials.** The DeepSeek, Z.AI, Merriam-Webster, and
   Auth0 M2M keys were handled during setup. Treat them as potentially exposed
   and rotate them in their respective consoles, keeping the new values solely
   in `server/.env` (never committed).
2. **MongoDB authentication.** The in-stack Mongo currently runs without auth
   (it is on a private network and not published). For multi-tenant or
   shared-host hardening, enable auth via `MONGO_INITDB_ROOT_USERNAME/PASSWORD`
   and a `mongodb://user:pass@mongo:27017` URI.
3. **Auth0 M2M rotation & least privilege.** Confirm the Management API M2M
   client holds only `read:users` + `update:users`.
4. **Stricter translate rate limiting / WAF.** The translate and more-examples
   routes are public and each cache miss costs an LLM call. Both are already
   hard-capped at 5 req/min/IP (`LLM_RATE_LIMIT_MAX_RPM`). For heavier
   adversarial traffic, lower `TRANSLATE_RATE_LIMIT_RPM` /
   `MORE_EXAMPLES_RATE_LIMIT_RPM` below the cap, or put a WAF/bot filter in
   front.
5. **Secrets manager.** For team deployments, source `server/.env` from a
   secrets manager (Vault, AWS SSM, Doppler, etc.) instead of a file on disk.
6. **Set the admin allowlist deliberately.** `ADMIN_USER_IDS` and
   `CONFIG_ENCRYPTION_KEY` ship unset — add your Auth0 `sub` and generate a
   key (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
   only when you're ready to use `/admin`, and keep the allowlist to as few
   subs as actually need provider/key management.

## Reproducing the review

```bash
npm audit                       # dependency vulnerabilities (expect 0)
npx tsc --noEmit                # type safety (strict mode)
npm test                        # unit tests
# Favorites auth (expect 401 without a valid token):
curl -i https://dict.ai-dictionary.org/api/favorites
# Language validation (expect 400 invalid_language):
curl -i 'https://dict.ai-dictionary.org/api/translate/hello?from=xxxxx&to=en'
# Admin auth (expect 401 without a valid token):
curl -i https://dict.ai-dictionary.org/api/admin/llm/status
# Admin authz (expect 403 with a valid token whose sub isn't in ADMIN_USER_IDS):
curl -i https://dict.ai-dictionary.org/api/admin/llm/status -H "Authorization: Bearer $TOKEN"
```
