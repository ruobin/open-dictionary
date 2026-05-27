# ai-dic

A small Cambridge-style English dictionary. React + Vite on the front, a tiny Express service on the back to sync per-user history and favorites through Auth0 `user_metadata`.

## Stack

- React 18 + Vite
- `react-router-dom` for shareable `/word/:term` URLs
- `@auth0/auth0-react` for Google and Facebook SSO
- Free Dictionary API (`api.dictionaryapi.dev`) with localStorage caching
- Express + `express-oauth2-jwt-bearer` + `auth0` Management SDK for cross-device sync
- `helmet` + per-route `express-rate-limit` + CORS allowlist on the API

## Local development

### 1. Install

```bash
npm install
```

### 2. Configure Auth0

In the Auth0 dashboard:

1. **Create a Single Page Application**
   - Allowed Callback URLs: `http://localhost:5173`
   - Allowed Logout URLs: `http://localhost:5173`
   - Allowed Web Origins: `http://localhost:5173`
   - Note the **Domain** and **Client ID**.

2. **Enable social connections**
   - Authentication → Social → enable **Google** and **Facebook**
   - Attach both to your SPA application.

3. **Create a custom API** (used as the JWT audience)
   - APIs → Create API
   - Name: `ai-dic-api`
   - Identifier: `https://ai-dic-api` (any URL-shaped string; just be consistent)
   - Signing Algorithm: `RS256`

4. **Create a Machine-to-Machine application** for the server
   - Applications → Create → Machine to Machine
   - Authorize it for the **Auth0 Management API**
   - Grant scopes: `read:users`, `update:users`
   - Note its **Client ID** and **Client Secret**.

### 3. Fill in env files

```bash
cp .env.example .env
cp server/.env.example server/.env
```

Edit both with values from above.

### 4. Run

```bash
npm run dev:all
```

- Frontend: http://localhost:5173
- API: http://localhost:3001 (proxied through Vite)

## How it works

- **Anonymous users** get history + favorites in `localStorage` under `userdata:anon`.
- **Logged-in users** sync to `user_metadata.history` and `user_metadata.favorites` via the Express service. Writes are debounced 500ms so a burst of searches doesn't hammer the Management API.
- Word lookups are cached locally for 30 days under `dict:v1:{word}`. Network calls time out after 8s.

## Project layout

```
src/
  api/         dictionary + userData clients
  components/  SearchBar, WordEntry, PosSection, AudioButton, Sidebar, Header, AuthButton, ErrorBoundary
  hooks/       useDictionary, useUserData
  styles/      app.css
public/        favicon.svg, robots.txt
server/
  index.js     /api/user-data GET + PUT, JWT-protected, rate-limited
.github/workflows/ci.yml   build + smoke test + audit on every push
Dockerfile     production image for the API server
```

## Production deployment

The app has two pieces that can be deployed independently:

### Frontend (static)

```bash
npm run build
```

`dist/` is a plain static bundle. Drop it on any static host: Vercel, Netlify, Cloudflare Pages, S3+CloudFront, nginx, etc.

The host must:
- rewrite unknown paths to `/index.html` (SPA routing for `/word/:term`)
- proxy `/api/*` to the API service (or set `VITE_API_BASE_URL`-style config if you split the domains; the current build assumes same-origin `/api/*`)

Required build-time env vars (loaded by Vite from `.env`):

| Var | Notes |
| --- | --- |
| `VITE_AUTH0_DOMAIN` | e.g. `your-tenant.us.auth0.com` |
| `VITE_AUTH0_CLIENT_ID` | the SPA client ID |
| `VITE_AUTH0_AUDIENCE` | matches the custom API identifier |

In the Auth0 dashboard, add your production URL to **Allowed Callback URLs**, **Logout URLs**, and **Web Origins**.

### API server

Build and run with Docker:

```bash
docker build -t ai-dic-api .
docker run --rm -p 3001:3001 --env-file server/.env ai-dic-api
```

Or run directly:

```bash
NODE_ENV=production npm start
```

Required runtime env vars (`server/.env.example` has the full list):

| Var | Notes |
| --- | --- |
| `AUTH0_DOMAIN` | same as frontend |
| `AUTH0_AUDIENCE` | the custom API identifier |
| `AUTH0_MGMT_CLIENT_ID` | M2M client ID |
| `AUTH0_MGMT_CLIENT_SECRET` | M2M client secret — **secret** |
| `ALLOWED_ORIGINS` | comma-separated list of allowed browser origins (e.g. `https://ai-dic.example.com`) |
| `NODE_ENV` | set to `production` |
| `TRUST_PROXY` | set to `1` (or higher) if behind a reverse proxy / LB |
| `PORT` | defaults to `3001` |

The API exposes `GET /health` for load-balancer health checks.

### Operational notes

- Per-IP rate limit is 60 req/min on `/api/user-data`.
- Request body limit is 64 KB.
- The server logs structured errors for 5xx responses; client never sees stack traces in production.
- The Auth0 Management API has its own rate limits — debounced 500ms client-side writes plus the per-IP limit above are designed to stay well under them.
