# open-dictionary

A bilingual dictionary + translation app. Look up a word or expression in a source language; definitions and translations come from a configurable LLM tier (DeepSeek by default, or OpenRouter / Z.AI GLM), with the Free Dictionary API as a fallback. Results are cached in MongoDB keyed by **(word, sourceLang, targetLang)** so identical lookups skip the LLM entirely. Per-user favorites (lanugage-scoped) live in MongoDB; history stays in browser localStorage (anonymous) or Auth0 `user_metadata` (authenticated).

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
   │                           │   [Free Dictionary] (fallback only on LLM failure)
   │                           │
   │←── normalized DictionaryEntry[] JSON ─── (cached for 1 year)
```

Favorites: `GET/POST/DELETE /api/favorites`, keyed by **(user, word, sourceLang, targetLang)**. Authenticated users use their Auth0 `sub`; anonymous users are prompted to log in before favoriting.

History: `GET/PUT /api/user-data` — stays word‑only in `user_metadata` (authed) or `localStorage` (anon).

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
| `FREE_DICTIONARY_API_BASE` | no | `https://api.dictionaryapi.dev` | Fallback dict API |
| `MONGODB_URI` | no | — | e.g. `mongodb://localhost:27017` |
| `MONGODB_DB` | no | `open-dictionary` | |
| `LLM_VENDOR` | no | `deepseek` | `deepseek` / `openrouter` / `glm` / `none` |
| `LLM_REQUEST_TIMEOUT_MS` | no | `15000` | Per‑request LLM timeout (ms) |
| `LLM_DEBUG` | no | off | `true` prints full prompts and response bodies |

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
  api/            dictionary.ts, userData.ts, favorites.ts
  components/     SearchBar, WordEntry, PosSection, AudioButton,
                  Sidebar, Header, AuthButton, ErrorBoundary
  hooks/          useDictionary, useUserData, useFavorites
  pages/          Home.tsx, WordPage.tsx
  styles/         app.css
  vite‑env.d.ts   Vite / import.meta.env typings
public/           favicon.svg, robots.txt
scripts/
  llm‑ping.ts     Smoke‑test the active LLM provider
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
    dictionary.ts       Free Dictionary API provider
    errors.ts           Shared ProviderError
docs/
  design‑translation‑cache.md   Full design rationale for cache + LLM tier
docker‑compose.yml      MongoDB (local dev only)
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
| `npm run typecheck` | `tsc --noEmit` only (no emit) |
| `npm run llm:ping` | Test the active LLM provider (via `scripts/llm‑ping.ts`) |
| `npm start` | Production server start |

## Production deployment

### Frontend (static)

```bash
npm run build
```

Drop `dist/` on any static host (Vercel, Netlify, S3+CloudFront, nginx…). The host must:

- rewrite unknown paths to `/index.html` (SPA routing)
- proxy `/api/*` to the API server

### API server

Build and run with Docker:

```bash
docker build -t open-dictionary-api .
docker run --rm -p 3001:3001 --env-file server/.env open-dictionary-api
```

The server connects to MongoDB via `MONGODB_URI`. For production, point it at a managed cluster (Atlas, etc.) or a self‑hosted instance reachable from the container.

### Operational notes

- Per‑IP rate limits: `/api/translate` 120 req/min, `/api/user-data` and `/api/favorites` 60 req/min.
- Request body limit is 64 KB.
- Stack traces are only served in `NODE_ENV=development`.
- Lookup results are cached in MongoDB for **1 year** (TTL index); subsequent lookups of the same (word, sourceLang, targetLang) skip the LLM entirely.
- Auth0 Management API writes are debounced 500 ms on the client to stay well under Auth0 rate limits.
