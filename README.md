# open-dictionary

A bilingual dictionary + translation app. Look up a word or expression in a source language; definitions and translations come from a configurable LLM tier (DeepSeek by default, or OpenRouter / Z.AI GLM), with the Merriam-Webster Collegiate API as a fallback (English-only). Results are cached in MongoDB keyed by **(word, sourceLang, targetLang)** so identical lookups skip the LLM entirely. After the LLM produces an entry, pronunciation audio URLs are best-effort merged from Merriam-Webster (English source) and cached with the entry. Per-user favorites (**language**-scoped) live in MongoDB; history (now also language-scoped, `{word, sourceLang, targetLang}` shape) stays in browser localStorage (anonymous) or Auth0 `user_metadata` (authenticated). Anonymous users are prompted to log in before favoriting — a pending favorite is stashed in `sessionStorage` and applied on return. The last‑used source/target language pair is persisted in `localStorage` so the pickers survive refreshes.

## Stack

- **TypeScript** throughout (frontend + backend, strict mode)
- React 18 + Vite (+ `react-router-dom`)
- Express API (run directly with `tsx` — no compile step needed)
- MongoDB (translation cache + favorites)
- Auth0 (`@auth0/auth0-react` + Management SDK) for SSO and cross-device history sync
- LLM tier (vendor-agnostic): **DeepSeek** (default, `deepseek-v4-flash`), OpenRouter, or Z.AI GLM-5.2; all OpenAI‑compatible behind a shared adapter
- `helmet`, per‑route `express-rate-limit`, CORS allowlist

See [docs/design-translation-cache.md](docs/design-translation-cache.md) for the full caching and LLM‑provider design.

## Architecture (lookup flow)

```
browser  →  localStorage L1  →  GET /api/translate/:word?from=&to=
   │                                         │
   │                           ┌────────── [Mongo cache] ──── hit → return
   │                           │        miss ↓
   │                           │   [LLM tier] (primary)
   │                           │        error ↓
   │                           │   [Merriam-Webster] (English-only, fallback only on LLM failure)
   │                           │
   │←── normalized DictionaryEntry[] JSON ─── (cached for 1 year)
```

Favorites: `GET/POST/DELETE /api/favorites`, keyed by **(user, word, sourceLang, targetLang)**. **All favorites routes require a valid Auth0 access token**; the caller's identity is the verified JWT `sub` (never a client-supplied identity header, which would be spoofable). Anonymous users are prompted to log in before favoriting.

History: `GET/PUT /api/user-data` — entries carry **source and target language** (FavoriteKey shape: `{word, sourceLang, targetLang}`), persisted in `user_metadata` (authed) or `localStorage` (anon). Legacy bare strings are coerced (defaulted to en→en).

## Local development

### 1. Install

```bash
npm install
```

### 2. Start MongoDB

```bash
docker compose up -d      # MongoDB 7 on localhost:27017 (data in a named volume)
```

### 3. Configure Auth0

In the Auth0 dashboard:

1. **Create a Single Page Application**
   - Allowed Callback URLs: `http://localhost:5173`
   - Allowed Logout URLs: `http://localhost:5173`
   - Allowed Web Origins: `http://localhost:5173`
   - Note the **Domain** and **Client ID**.

2. **Enable social connections** (Google / Facebook) — optional.

3. **Create a custom API** (JWT audience)
   - APIs → Create API — Identifier e.g. `https://open-dictionary-api`. Signing: `RS256`.

4. **Create a Machine‑to‑Machine application** for the server
   - Applications → Create → Machine to Machine
   - Authorize it for the **Auth0 Management API**
   - Grant scopes: `read:users`, `update:users`
   - Note its **Client ID** and **Client Secret**.

### 4. Fill in env files

```bash
cp .env.example .env
cp server/.env.example server/.env
```

Edit both with the values above, plus an LLM API key and MongoDB URI (see tables below).

### 5. Run

```bash
npm run dev:all          # Vite web (:5173) + Express API (:3001), both with hot reload
```

- Web: http://localhost:5173
- API: http://localhost:3001 (proxied by Vite)
- Mongo: `localhost:27017`

Verify the cache: watch the API logs — the first lookup of a word says *via llm* (or *via dictionary* if the LLM is unavailable); the second says *via cache*.

## Environment variables

### Frontend (root `.env`, loaded by Vite — must be `VITE_`‑prefixed)

| Variable | Notes |
|---|---|
| `VITE_AUTH0_DOMAIN` | Your Auth0 tenant, e.g. `dev‑xxx.us.auth0.com` |
| `VITE_AUTH0_CLIENT_ID` | SPA client ID |
| `VITE_AUTH0_AUDIENCE` | Custom API identifier (e.g. `https://open‑dictionary‑api`) |

### Server (`server/.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AUTH0_DOMAIN` | yes | — | Same as frontend |
| `AUTH0_AUDIENCE` | yes | — | Custom API identifier |
| `AUTH0_MGMT_CLIENT_ID` | yes | — | M2M client ID |
| `AUTH0_MGMT_CLIENT_SECRET` | yes | — | M2M client secret |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173` | CORS origins (comma separated) |
| `NODE_ENV` | no | `development` | `production` hides stack traces |
| `TRUST_PROXY` | no | `0` | Number of reverse‑proxy hops |
| `PORT` | no | `3001` | |
| `MERRIAM_WEBSTER_API_KEY` | no (but audio/fallback need it) | — | Key from [dictionaryapi.com](https://www.dictionaryapi.com/) |
| `DICTIONARY_API_BASE` | no | `https://www.dictionaryapi.com/api/v3` | Merriam-Webster fallback API |
| `MONGODB_URI` | no | — | e.g. `mongodb://localhost:27017` |
| `MONGODB_DB` | no | `open-dictionary` | |
| `LLM_VENDOR` | no | `deepseek` | `deepseek` / `openrouter` / `glm` / `none` |
| `LLM_REQUEST_TIMEOUT_MS` | no | `15000` | Per‑request LLM timeout (ms) |
| `LLM_DEBUG` | no | off | `true` prints full prompts and response bodies |

#### Admin portal (`/admin` — see [docs/design-admin-portal.md](docs/design-admin-portal.md))

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ADMIN_USER_IDS` | to use `/admin` at all | — (empty ⇒ nobody can) | Comma-separated Auth0 `sub`s. This **is** the authorization model — allowlist-only, no Auth0 RBAC. |
| `CONFIG_ENCRYPTION_KEY` | to save provider API keys via `/admin` | — | AES-256-GCM master key, base64. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Without it, admin key-writes 503; everything else still works. |
| `CONFIG_ENCRYPTION_KEY_PREVIOUS` | no | — | Decrypt-only, set during key rotation |
| `ADMIN_RATE_LIMIT_RPM` | no | `30` | Rate limit for all `/api/admin/*` routes |
| `LLM_PROBE_INTERVAL_MIN` | no | `0` (off) | Reserved for scheduled latency probes — the config is read, but the prober itself isn't implemented yet, so any value is currently a no-op |

#### DeepSeek (default)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | if vendor=deepseek | — | Key from [deepseek.com](https://deepseek.com) |
| `DEEPSEEK_MODEL` | no | `deepseek‑v4‑flash` | |
| `DEEPSEEK_BASE_URL` | no | `https://api.deepseek.com` | |

#### OpenRouter (alternative)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | if vendor=openrouter | — | Key from [openrouter.ai](https://openrouter.ai) |
| `OPENROUTER_MODEL` | no | `minimax/minimax‑m3` | |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | |
| `OPENROUTER_REFERER` | no | — | Optional attribution |
| `OPENROUTER_TITLE` | no | — | Optional attribution |

#### GLM / Z.AI (alternative)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ZAI_API_KEY` | if vendor=glm | — | Key from [z.ai](https://z.ai) |
| `GLM_MODEL` | no | `glm‑5.2` | Falls back to `LLM_MODEL` |
| `GLM_BASE_URL` | no | `https://api.z.ai/api/paas/v4` | Falls back to `LLM_BASE_URL` |

Set `LLM_VENDOR=none` to run with only the dictionary fallback (no LLM calls).

## LLM providers

All three vendors expose an OpenAI‑compatible Chat Completions API and share a single adapter (`server/providers/llm/openaiCompat.ts`). Swapping or adding a vendor requires a small wrapper (~30 lines) and a new registry case — no changes to the cache, route, or UI.

- **DeepSeek** (default) — model `deepseek-v4-flash`. Endpoint `https://api.deepseek.com`.
- **OpenRouter** — access to many models through one API key. Default model MiniMax M3 (`minimax/minimax‑m3`).
- **GLM / Z.AI** — direct Z.AI API (general or coding‑plan endpoints). Default model `glm‑5.2`.

Set `LLM_DEBUG=true` to log every LLM request URL, the full prompt, response status/body, and elapsed time — useful for debugging timeouts or response quality.

## Project layout

```
src/
  api/            dictionary.ts, userData.ts, favorites.ts, admin.ts
  components/     SearchBar, WordEntry, PosSection, AudioButton,
                  Sidebar, Header, AuthButton, ErrorBoundary
                  admin/          admin-only components (provider cards, forms, tables)
  hooks/          useDictionary, useUserData, useFavorites, useAdminAuth
  pages/          Home.tsx, WordPage.tsx
                  admin/          Overview, Providers, Latency, Audit (lazy-loaded, §Admin portal)
  styles/         app.css, admin.css
  vite‑env.d.ts   Vite / import.meta.env typings
public/           favicon.svg, robots.txt
scripts/
  llm‑ping.ts     Smoke‑test the active LLM provider
  mongodb‑backup.sh          Weekly mongodump; keeps only the latest backup
  open‑dictionary‑backup.cron  Cron schedule (Monday 02:00 UTC = APAC Mon morning)
shared/
  languages.ts    Language list + code‑to‑name helper
  favorites.ts    FavoriteKey interface
server/
  index.ts        Boot: connect Mongo, create providers, listen + shutdown
  config.ts       Env reading + validation (loaded by both index and app)
  app.ts          Express app factory (middleware, routes, error handling)
  translate.ts    /api/translate handler + read‑through cache orchestrator
  favorites.ts    /api/favorites (Mongo‑backed)
  db.ts           Mongo connection + index provisioning
  cache/
    translationCache.ts   Cache for lookup results (TTL 1 year)
  providers/
    llm/
      types.ts          LlmProvider interface + error types
      openaiCompat.ts   Shared OpenAI‑compatible adapter
      deepseek.ts       DeepSeek wrapper
      openrouter.ts     OpenRouter wrapper
      glm.ts            Z.AI GLM wrapper
      index.ts          Registry + env‑driven factory
    dictionary.ts       Merriam-Webster Collegiate provider (English-only)
    errors.ts           Shared ProviderError
  llm/
    service.ts      LlmService — hot-swappable active provider (env ⇄ db), see admin portal design doc §7
  admin/
    router.ts        /api/admin/* routes (status, providers, test, benchmark, active, audit)
    auth.ts           requireAdmin middleware (allowlist-only)
    crypto.ts         AES-256-GCM encrypt/decrypt/redact helpers
    providersRepo.ts  llm_providers/llm_settings access + validation
    benchmark.ts      On-demand latency benchmark job runner
    audit.ts          Append-only admin_audit log
docs/
  design‑translation‑cache.md   Full design rationale for cache + LLM tier
  design‑admin‑portal.md        Admin portal design + §18 implementation notes
  ui‑i18n‑and‑themes.md         Dark/light theming + UI i18n design
  security.md                   Threat model, findings & mitigations, hardening
docker‑compose.yml      Production stack (mongo + api) — see Production deployment
Dockerfile              Production API image
.github/workflows/      CI (build + typecheck + smoke‑start)
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite web dev server |
| `npm run server` | API server with `tsx watch` (hot reload) |
| `npm run dev:all` | Web + API concurrently |
| `npm run build` | Typecheck then Vite production build |
| `npm run test` | Run unit tests (vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run llm:ping` | Test the active LLM provider (via `scripts/llm‑ping.ts`) |
| `npm start` | Production server start — for local/CI use only; **the live server runs via Docker** (`docker-compose.yml`), not this command. See [Production deployment](#production-deployment). |

Non-npm operational scripts (not run via npm):

| File | What it does |
|---|---|
| `scripts/mongodb-backup.sh` | Dump the DB to a gzip archive; keep only the latest backup |
| `scripts/open-dictionary-backup.cron` | Cron schedule — Monday 02:00 UTC (APAC Monday morning) |

## Production deployment

> **This app's production instance is deployed with Docker by default —
> not by running `npm start` on the host.** The API always runs as the
> `open-dictionary-api` container from `docker-compose.yml`; `npm start` /
> `npm run build && node ...` are for local dev/CI only and are **not** how
> the live server gets (re)deployed. If you're an AI agent asked to "deploy"
> or "redeploy" this app, that means:
> ```bash
> docker compose build api   # rebuild the API image from current source
> docker compose up -d api   # recreate the container with the new image
> npm run build                                                    # frontend
> rsync -a --delete dist/ /var/www/html/dict.ai-dictionary.org/    # publish SPA
> ```
> Do **not** `npm start` the API directly on the host, and do not assume the
> static host serving the SPA is anything other than that nginx web root —
> both are already fixed by the existing ops setup below.

### Frontend (static)

```bash
npm run build
```

Drop `dist/` on any static host (Vercel, Netlify, S3+CloudFront, nginx…). The host must:

- rewrite unknown paths to `/index.html` (SPA routing)
- proxy `/api/*` to the API server

In this deployment, that static host is nginx serving
`/var/www/html/dict.ai-dictionary.org/`, published via
`rsync -a --delete dist/ /var/www/html/dict.ai-dictionary.org/` — see the
callout above.

### API server

The actual production mechanism is `docker-compose.yml` (mongo + api, both
containerized; see the file's header comment for the topology) — **not**
`npm start`:

```bash
docker compose build api      # rebuild the image, does not touch the running container
docker compose up -d api      # graceful recreate — zero-downtime for mongo, brief blip for api
```

`docker compose up -d api` is also the correct way to pick up a new
`server/.env` value (e.g. after setting `ADMIN_USER_IDS` — see
[Admin portal](#admin-portal)) without rebuilding.

Equivalent without compose, for a bare-Docker host:

```bash
docker build -t open-dictionary-api .
docker run --rm -p 3001:3001 --env-file server/.env open-dictionary-api
```

The server connects to MongoDB via `MONGODB_URI`. For production, point it at a managed cluster (Atlas, etc.) or a self‑hosted instance reachable from the container.

### Operational notes

- Per‑IP rate limits (configurable via env): `/api/translate` 5 req/min, `/api/more-examples` 5 req/min, `/api/favorites` 60 req/min, `/api/user-data` 60 req/min. The two LLM endpoints are hard-capped at 5 req/min to bound token spend. Set `TRANSLATE_RATE_LIMIT_RPM`, `MORE_EXAMPLES_RATE_LIMIT_RPM`, `FAVORITES_RATE_LIMIT_RPM`, `USERDATA_RATE_LIMIT_RPM` in `server/.env`.
- Request body limit is 64 KB.
- Stack traces are only served in `NODE_ENV=development`.
- Lookup results are cached in MongoDB for **1 year** (TTL index); subsequent lookups of the same (word, sourceLang, targetLang) skip the LLM entirely.
- Auth0 Management API writes are debounced 500 ms on the client to stay well under Auth0 rate limits.

### Backups

`scripts/mongodb-backup.sh` dumps the `open-dictionary` database from the running `open-dictionary-mongo` container (`mongodump --archive --gzip`) and **keeps only the single most-recent successful backup** — every prior archive in the backup directory is deleted once the new dump completes.

- **Schedule:** `scripts/open-dictionary-backup.cron` runs it **every Monday 02:00 UTC** = Monday morning APAC (07:00 IST · 09:00 ICT · 10:00 SGT/HKT/CST · 11:00 JST/KST).
- **Install on the host:**
  ```bash
  sudo install -m 0755 scripts/mongodb-backup.sh          /usr/local/bin/open-dictionary-backup.sh
  sudo install -m 0644 scripts/open-dictionary-backup.cron /etc/cron.d/open-dictionary-backup
  sudo touch /var/log/open-dictionary-backup.log && sudo chmod 640 /var/log/open-dictionary-backup.log
  ```
- **Run by hand** (writes to `/var/backups/open-dictionary-mongodb/`): `sudo /usr/local/bin/open-dictionary-backup.sh`
- **Restore:**
  ```bash
  docker exec -i open-dictionary-mongo mongorestore --archive --gzip --drop \
    < /var/backups/open-dictionary-mongodb/open-dictionary-*.archive.gz
  ```
- **Tune** with env vars: `MONGO_CONTAINER`, `MONGO_DB`, `BACKUP_DIR`. Retention (one backup) is handled inside the script — change the `find … -delete` line to retain more if you ever need point-in-time history.

## Admin portal

`/admin` is an operator-only panel for managing LLM providers at runtime — no
redeploy to rotate a key or switch models — plus latency benchmarking and an
audit log of every change. Full design and implementation notes:
[docs/design-admin-portal.md](docs/design-admin-portal.md) (see **§18
Implementation notes** for exactly what shipped vs. what's deferred).

- **Auth is allowlist-only**, not Auth0 RBAC: a request needs a valid Auth0
  token **and** a `sub` listed in `ADMIN_USER_IDS`. Unset, `/admin` is
  unreachable for everyone — this is the fail-closed default, not a bug.
- **One-time setup:**
  1. Log in to the app once (any account) and get your Auth0 `sub` — easiest
     from the Auth0 dashboard's Users list, or decode your access token.
  2. Add it to `server/.env`: `ADMIN_USER_IDS=auth0|abc123` (comma-separated
     for more than one admin).
  3. Generate and set `CONFIG_ENCRYPTION_KEY` (see the Admin portal row group
     in [Environment variables](#environment-variables) above) — required
     before you can save a provider's API key through the panel.
  4. `docker compose up -d api` to pick up the new env values.
  5. Visit `/admin`.
- Pages: **Overview** (active provider, health, recent changes), **Providers**
  (CRUD, keys, models, connection test), **Latency** (on-demand benchmarks,
  compare providers, promote a winner), **Audit** (append-only change log,
  365-day retention).
- The admin bundle is lazy-loaded and never ships to non-admin users; the
  server-side allowlist check is the actual security boundary either way
  (see [Security](#security)).
- **Not yet implemented** (see the design doc's §18): scheduled background
  latency probes (on-demand benchmarking works today), and multi-instance
  config sync (fine for the current single-`api`-container deployment).

## Security

See [docs/security.md](docs/security.md) for the full threat model. Highlights:

- **Identity is always the verified Auth0 JWT `sub`** — favorites and user-data routes require a valid access token and operate only on the caller's own data. A client-supplied identity header is never trusted (would be an IDOR).
- **Translate input is constrained** — `from`/`to` are validated against the supported language list (bounds cache cardinality and prevents LLM-cost abuse); lookup text is length-capped and control chars are stripped.
- **Admin (`/admin`) is allowlist-only** — `ADMIN_USER_IDS` gates every `/api/admin/*` route server-side; unset, it's unreachable by anyone. Provider API keys are AES-256-GCM encrypted at rest and never returned by any API response (write-only). See [Admin portal](#admin-portal).
- **No stored XSS** — no `dangerouslySetInnerHTML`; React escapes all LLM/dictionary output.
- **Security headers + strict CSP** on the SPA at the edge nginx; `helmet` on every API response; HSTS with `includeSubDomains`.
- **Dependencies** — keep `npm audit` at 0 vulnerabilities.

Recommended operational hardening (rotate any keys handled during setup, enable MongoDB auth for shared hosts, source secrets from a secrets manager) is listed in [docs/security.md](docs/security.md#operational-hardening-recommendations).
