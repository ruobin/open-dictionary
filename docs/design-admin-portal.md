# Design: LLM Admin Portal (vendors, API keys, models, latency)

**Status:** implemented & deployed · **Proposed:** 2026-07-11 · **Shipped:** 2026-07-11
**Scope:** runtime management of LLM providers (vendor, API key, base URL, models),
switching the active provider/model without redeploy, and first-class **LLM API
latency testing** — on-demand benchmarks, provider comparison, and production
latency percentiles.

Phases 0–3 (§15) shipped in full. Phase 4 (scheduled-probe scheduler, multi-instance
config polling, vendor `/models` proxy, cache stats/purge card, admin i18n) was
deferred — see **§18 Implementation notes** for the complete list of decisions and
deviations from this doc as originally proposed.

---

## 1. Why

Today the LLM tier — the primary source of dictionary entries — is configured
entirely through environment variables read **once at boot**
(`server/providers/llm/index.ts` → `createLlmProviderFromEnv()`), and the
resulting provider is frozen into `app.locals.llm` (`server/app.ts:116`).
Changing vendor, key, or model means editing `server/.env` and restarting the
API container.

That is workable for a solo dev, but it blocks the things that matter for a
dictionary product:

- **Latency is the product.** An uncached lookup is served by the LLM tier;
  its wall-clock time *is* the user's wait. Choosing between DeepSeek,
  OpenRouter models, and GLM should be driven by measured p50/p95 latency and
  error rate — today there is no way to measure a candidate provider without
  reconfiguring production or running `npm run llm:ping` by hand on the box.
- **Key rotation** requires shell access and a restart (a visible outage
  window, since docker restarts the container).
- **Model experiments** (e.g. trying a new DeepSeek release) are all-or-nothing
  config edits with no side-by-side comparison and no history of what was
  tried.

### Goals

1. CRUD for LLM provider connections (vendor, name, base URL, API key, models)
   from a web admin panel, persisted in MongoDB, applied at runtime — **no
   restart, no redeploy**.
2. Switch the **active provider + model** with one click; support "none"
   (dictionary-only mode).
3. **Latency testing** as a first-class feature:
   - one-click connection test for any configured (or draft, pre-save) provider;
   - repeated-sample **benchmarks** with p50/mean/min/max and success rate;
   - **compare mode** across several providers on the identical word set;
   - production (passive) latency **percentiles** per provider, not just the
     current average;
   - optional low-frequency **scheduled probes** for a latency history chart.
4. Secrets handled properly: API keys encrypted at rest, never returned by any
   API, masked in the UI, redacted from logs and audit entries.
5. Admin-only access enforced **server-side** via the existing Auth0 setup.
6. Auditability: who changed what, when.

### Non-goals

- User management, billing/spend tracking (we show rough token estimates for
  benchmark cost, nothing more).
- Prompt editing. The prompt lives in code
  (`server/providers/llm/openaiCompat.ts`) because it is coupled to
  `CACHE_VERSION` (`server/translate.ts:108`) — editing it at runtime would
  silently desynchronize the cache key. Out of scope.
- Multi-tenant or delegated administration.
- External secret managers (Vault etc.) — see Alternatives (§16).
- Alerting/paging on latency regressions (metrics stay observable via logs and
  the panel; alerting infra is out of scope).

---

## 2. Current state (what the design builds on)

| Piece | Where | Relevance |
|---|---|---|
| Provider contract `LlmProvider { id, translate(), moreExamples() }` | `server/providers/llm/types.ts` | Unchanged. The portal manages *which implementation* is live. |
| Vendor factories (all wrap one OpenAI-compatible adapter) | `deepseek.ts`, `openrouter.ts`, `glm.ts` → `openaiCompat.ts` | Reused verbatim to build providers from DB config. Also enables a generic "custom OpenAI-compatible" vendor for free. |
| Env-only registry, read at boot | `server/providers/llm/index.ts` | Becomes the **fallback/seed** layer; DB config wins when present. |
| Provider consumed via `app.locals.llm` | `server/translate.ts:371`, `server/moreExamples.ts:101` | Replaced by a hot-swappable `LlmService` (§7). |
| In-memory metrics incl. avg LLM latency by vendor | `server/metrics.ts` | Extended with bounded latency samples → percentiles; exposed over an admin endpoint. |
| CLI smoke test | `scripts/llm-ping.ts` | Its logic becomes the server-side "test connection" primitive. |
| Auth0 JWT auth (RS256, audience) + Management API client | `server/app.ts` | Reused; admin routes add a role/permission check. |
| MongoDB (translations cache, favorites) + nightly backups | `server/db.ts`, `scripts/mongodb-backup.sh` | New collections live here. Backups are why keys must be encrypted at rest. |
| Single API container behind host nginx | `docker-compose.yml` | Single-instance today; design still handles multi-instance via config polling (§7). |

---

## 3. Architecture overview

```
Browser (SPA /admin route, Auth0 token with admin permission)
   │ HTTPS
   ▼
Edge nginx ──► Express API
                 │
                 ├─ /api/…            public + user routes (unchanged)
                 │      └─ reads LlmService.current()   ◄─┐ hot swap
                 │                                        │
                 ├─ /api/admin/… (checkJwt + requireAdmin + rate limit)
                 │      ├─ providers CRUD ────────► Mongo llm_providers
                 │      ├─ active switch ─────────► Mongo llm_settings ──► LlmService.apply()
                 │      ├─ test / benchmark ──────► vendor APIs (bypasses cache & prod metrics)
                 │      ├─ metrics snapshot ──────► server/metrics.ts
                 │      └─ audit log ─────────────► Mongo admin_audit
                 │
                 └─ boot: env config (fallback) ─► LlmService  ◄─ Mongo config (wins if present)
```

Key decisions, argued in the sections that follow:

1. **Config lives in MongoDB, env remains fallback + seed** (§4, §7). Editing
   env files inside containers is not a thing; Mongo is already a hard
   dependency for the cache, and gives us multi-instance consistency and audit
   for free. If Mongo is down at boot, the system behaves exactly as today
   (env-configured provider or dictionary-only).
2. **API keys are AES-256-GCM-encrypted at rest** with a master key that lives
   only in the server env (§5). A Mongo dump (or the nightly backup tarball)
   alone must not leak keys.
3. **Hot swap via a small mutable `LlmService`** instead of the boot-time
   constant (§7). Provider instances are cheap closures; in-flight requests
   safely finish on the old instance.
4. **Benchmarks run as in-process async jobs** polled by the UI (§9.3) — a
   10-sample run can take >60 s, which would trip the edge nginx proxy
   timeout if done in one request/response.
5. **Probe traffic never touches the translation cache or production
   counters** (§9.5) — otherwise benchmarking would pollute the very numbers
   used to judge providers, and write junk cache entries.

---

## 4. Data model (MongoDB)

### 4.1 `llm_providers` — one doc per configured connection

```jsonc
{
  "_id": ObjectId,
  "name": "DeepSeek (prod key)",          // unique, human label
  "vendor": "deepseek",                    // "deepseek" | "openrouter" | "glm" | "openai-compat"
  "baseUrl": "https://api.deepseek.com",  // optional for known vendors (factory default), required for "openai-compat"
  "headers": {                             // optional vendor extras (OpenRouter attribution)
    "referer": "https://dict.ai-dictionary.org",
    "title": "open-dictionary"
  },
  "apiKey": {                              // encrypted blob — see §5
    "v": 1, "alg": "aes-256-gcm",
    "iv": "<b64>", "ct": "<b64>", "tag": "<b64>",
    "keyVersion": 1,
    "last4": "9f3a"                        // for masked display only
  },
  "models": [
    { "id": "deepseek-v4-flash", "label": "V4 Flash", "isDefault": true,
      "timeoutMs": 15000, "temperature": 0.2 },
    { "id": "deepseek-v4",       "isDefault": false }
  ],
  "enabled": true,
  "lastTest": { "at": ISODate, "ok": true, "ms": 1840, "errorCode": null },
  "createdAt": ISODate, "updatedAt": ISODate,
  "updatedBy": "auth0|64f…"                // JWT sub of the admin
}
```

- `vendor: "openai-compat"` is the generic escape hatch: since every existing
  vendor already goes through `createOpenAiCompatibleProvider()`, any
  OpenAI-compatible endpoint (Together, Groq, a self-hosted vLLM…) can be added
  from the panel with `name + baseUrl + apiKey + model` and zero code changes.
- `models[]` is managed manually (free-text model id with suggestions for
  known vendors). A P2 enhancement proxies the vendor's `GET /models` where it
  exists (DeepSeek, OpenRouter) to offer a picker — manual entry stays the
  baseline because GLM-style vendors don't all expose it.
- Validation: `name` 1–64 chars unique; `vendor` in the enum; `baseUrl` must
  be `https://` in production (`http://` allowed only for
  localhost/private-net dev targets); at most 20 models; exactly one
  `isDefault` per provider.

### 4.2 `llm_settings` — singleton pointing at the active choice

```jsonc
{
  "_id": "llm",
  "activeProviderId": ObjectId | null,     // null = LLM tier off ("none")
  "activeModelId": "deepseek-v4-flash",
  "configVersion": 42,                     // monotonic; bumped on ANY provider/settings write
  "updatedAt": ISODate, "updatedBy": "auth0|…"
}
```

`configVersion` is the cheap cross-instance invalidation signal (§7.3).

### 4.3 `llm_benchmarks` — persisted benchmark results (Latency Lab history)

```jsonc
{
  "_id": ObjectId,
  "runId": "bm_a1b2c3",
  "requestedBy": "auth0|…",
  "startedAt": ISODate, "finishedAt": ISODate,
  "params": { "samples": 5, "words": ["run","serendipity","take off","bank","ephemeral"],
              "sourceLang": "en", "targetLang": "en" },
  "targets": [ {
    "providerId": ObjectId, "providerName": "DeepSeek (prod key)",
    "vendor": "deepseek", "model": "deepseek-v4-flash",
    "runs": [ { "word": "run", "ms": 2130, "ok": true, "errorCode": null, "tokensOut": 412 }, … ],
    "summary": { "p50": 2130, "mean": 2320, "min": 1720, "max": 3910,
                 "successRate": 1.0 }
  } ]
}
```

TTL index on `finishedAt` (90 days) keeps the collection bounded.

### 4.4 `llm_latency_probes` — scheduled probe samples (P2, §9.6)

```jsonc
{ "providerId": ObjectId, "model": "…", "ts": ISODate, "ms": 2210, "ok": true, "errorCode": null }
```

Compound index `{ providerId: 1, ts: -1 }`; TTL 30 days.

### 4.5 `admin_audit` — append-only change log

```jsonc
{
  "ts": ISODate, "actor": "auth0|…", "ip": "…",
  "action": "provider.update" | "provider.create" | "provider.delete"
          | "active.switch" | "benchmark.run" | "env.import",
  "target": { "providerId": ObjectId, "name": "DeepSeek (prod key)" },
  "diff": { "models": { "before": […], "after": […] },
            "apiKey": "(rotated, last4=9f3a)" }   // NEVER key material — see §5.3
}
```

TTL 365 days.

---

## 5. Secrets: encryption, masking, redaction

### 5.1 Encryption at rest

- Algorithm: **AES-256-GCM**, per-secret random 12-byte IV, auth tag stored
  alongside. Node's built-in `crypto` — no new dependency.
- Master key: new env var **`CONFIG_ENCRYPTION_KEY`** (32 bytes, base64) in
  `server/.env`, generated once with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- Why bother: `scripts/mongodb-backup.sh` ships full dumps on a cron. With
  plaintext keys, every backup location becomes a key-leak surface. With GCM,
  a dump (or Mongo access) alone is useless without the env-held master key —
  an attacker needs both boxes, which is the same bar as today's env-only
  secrets.
- Key rotation: blobs carry `keyVersion`. A second env var
  `CONFIG_ENCRYPTION_KEY_PREVIOUS` is honored for **decrypt only**, so
  rotation is: set new key + move old to `_PREVIOUS` → restart → run a small
  re-encrypt script (or lazily re-encrypt on next save) → drop `_PREVIOUS`.
- If `CONFIG_ENCRYPTION_KEY` is unset: admin **write** endpoints that involve
  keys return `503 config_encryption_unavailable` with a clear message;
  everything else (status, metrics, env-configured LLM) works. If the master
  key is *lost*, stored keys are unrecoverable by design — admins re-enter
  them; document this in the runbook.

### 5.2 Write-only semantics

- No API response ever contains a decrypted key. List/detail responses return
  `apiKey: { set: true, last4: "9f3a" }`.
- `PATCH` with `apiKey` **absent or null** ⇒ keep the existing key. Supplying
  a string ⇒ replace. There is deliberately no "reveal" endpoint.

### 5.3 Redaction rules (enforced in one helper, unit-tested)

- Audit diffs replace key material with `"(rotated, last4=…)"`.
- Admin router logging must never log request bodies; the existing `LLM_DEBUG`
  path logs errors/latency only, never `Authorization` headers — keep it that
  way and add a test that the benchmark/test handlers don't echo the key in
  error messages (vendor 401 bodies sometimes quote the bad key — truncate
  vendor error bodies to a safe prefix before storing/logging).

---

## 6. AuthN / AuthZ

Reuse the existing Auth0 setup end to end; the admin plane adds an
**authorization** layer on top of the current authentication.

**Shipped as allowlist-only (§17 Q1) — Auth0 RBAC was not implemented.** The
design below is kept for reference / a future path if a second admin joins;
`requireAdmin` today checks *only* the env allowlist, not a permission claim.

- **Server middleware `requireAdmin`** = existing `checkJwt` **and** `sub` ∈
  **`ADMIN_USER_IDS`** (comma-separated Auth0 subs in `server/.env`). No Auth0
  dashboard RBAC setup (permission/role) is required or checked.
- 401 for missing/invalid token (existing behavior via `checkJwt`, upstream),
  **403 `{ error: "forbidden" }`** for a valid token whose `sub` is not on the
  allowlist.
- **Rate limit** the whole admin router (new `ADMIN_RATE_LIMIT_RPM`, default
  30/min/IP) — same `express-rate-limit` pattern as every other router.
- **Frontend guard is cosmetic only:** `<RequireAdmin>` checks only
  `isAuthenticated` (no permission claim to check under allowlist-only) and
  redirects to Auth0 login if not. The real "is this account allowed" signal
  is server-side: `AdminLayout`'s first `GET /llm/status` call 403ing renders
  a distinct "not on the admin allowlist" state. The server is always the
  enforcement point either way (§10.1).
- No CORS/CSRF changes: same SPA origin, bearer tokens, `credentials: false`
  stays.

*Original RBAC proposal (not built):* define permission `manage:llm-config`
on the existing API, create an `admin` role holding it, assign it to a user,
enable "Add Permissions in the Access Token" — `requireAdmin` would then check
`permissions.includes('manage:llm-config') || sub ∈ ADMIN_USER_IDS`. Revisit
if/when a second admin needs access without sharing the allowlist env var.

---

## 7. Runtime provider service (hot reload)

### 7.1 `LlmService` replaces the boot-time constant

New `server/llm/service.ts`:

```ts
interface LlmRuntimeStatus {
  source: 'db' | 'env'
  status: 'active' | 'disabled' | 'misconfigured'
  providerId?: string            // Mongo _id when source = 'db'
  vendor?: string
  model?: string
  id?: string                    // e.g. "llm:deepseek:deepseek-v4-flash"
  message: string
  appliedAt: string
  configVersion?: number
}

interface LlmService {
  current(): LlmProvider | null      // O(1) read, called per request
  status(): LlmRuntimeStatus
  reloadFromDb(): Promise<void>      // read settings+provider, decrypt, build, atomically swap
  buildEphemeral(cfg): LlmProvider   // for tests/benchmarks — never becomes current()
}
```

**As shipped** (§18): `source` is two-valued, not three — there is no `'none'`.
The "nothing configured / off" signal lives in `status` (`'disabled'` /
`'misconfigured'`) instead of a third source, since "no LLM configured" is
still either sourced from env (absent) or db (absent), not a sourceless state.
`appliedAt` is a `string` (`.toISOString()`), not a `Date` — it crosses the
wire as JSON, so callers never had a `Date` to work with anyway.

- Construction reuses the existing factories
  (`createDeepSeekProvider` / `createOpenRouterProvider` / `createGlmProvider`
  / `createOpenAiCompatibleProvider`) — the portal changes *where config comes
  from*, not how providers work.
- Swap is a single reference assignment; provider instances are stateless
  closures over `fetch`, so there is nothing to tear down. **In-flight
  requests** already captured the old reference and finish safely on it.
- `server/translate.ts:371` and `server/moreExamples.ts:101` switch from
  `req.app.locals.llm` to `req.app.locals.llmService.current()` — a two-line
  change each. The provider `id` keeps flowing into metrics exactly as now.

### 7.2 Boot order & precedence

1. Build the env-based result exactly as today (`createLlmProviderFromEnv()`)
   → this is the **fallback** and the zero-Mongo behavior.
2. If Mongo connects and `llm_settings.activeProviderId` resolves to an
   enabled provider doc that decrypts cleanly → build from DB and swap; log
   `[llm] ACTIVE (db) — …` next to the existing boot log line.
3. Any DB-config failure (missing doc, decrypt error, unknown vendor) logs
   loudly and **falls back to the env provider** — never to a broken state.
   `status().source` tells the panel which layer is live, and the UI shows an
   "configured via environment — import to manage here" banner when
   `source = 'env'`.

### 7.3 Multi-instance convergence — **deferred (Phase 4, not shipped)**

Deployment is a single container today (`docker-compose.yml`), and the
instance that handles an admin write applies it to itself immediately. For
future replicas, each instance polls `llm_settings.configVersion` (a
`findOne` projection) every **`LLM_CONFIG_POLL_SEC`** (default 30 s, 0 = off)
and calls `reloadFromDb()` on change — ~15 lines, and it also self-heals an
instance that restarted against a stale env while others moved on. No pub/sub
infra needed at this scale.

`LLM_CONFIG_POLL_SEC` does not exist in `server/config.ts` today — this
section describes a future extension, not shipped behavior. It's needed only
when a second `api` replica is added to `docker-compose.yml`; single-instance
deploys (today's reality) don't need it, since the writing instance already
applies its own change immediately.

### 7.4 Interaction with the "misconfigured" state

The existing three-state registry semantics (`active | disabled |
misconfigured`) are preserved in `status()` so the panel can show precisely
what the boot log shows today, plus *why* (message string).

---

## 8. Admin API

All routes under `/api/admin`, behind `requireAdmin` + admin rate limit.
Follows the codebase's router-factory pattern (`createAdminRouter(deps)`),
JSON errors in the existing `{ error: "…" }` style.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET  /api/admin/llm/status` | Live runtime status | `LlmRuntimeStatus` + uptime; drives the Overview header. |
| `GET  /api/admin/llm/providers` | List providers | Keys masked (`{set, last4}`); includes `lastTest`. |
| `POST /api/admin/llm/providers` | Create | Validates per §4.1; encrypts key; audits. |
| `PATCH /api/admin/llm/providers/:id` | Update | `apiKey` absent ⇒ keep (§5.2); bumps `configVersion`; if `:id` is active, hot-reloads. |
| `DELETE /api/admin/llm/providers/:id` | Delete | **409 `provider_active`** if it is the active provider — switch first. |
| `POST /api/admin/llm/test` | One-shot connection test | Body: `{ providerId, modelId? }` **or** a full draft `{ vendor, baseUrl?, apiKey, model }` so a key can be validated *before* saving. Runs a single canonical `translate()` (the `llm-ping` logic, "serendipity" en→en) capped at `DEFAULT_TIMEOUT_MS` (15 s, aligned with production — see §18); returns `{ ok, ms, errorCode?, providerIdEcho }`; updates `lastTest` when `providerId` given. Synchronous — one call fits in a normal request. |
| `POST /api/admin/llm/benchmark` | Start a benchmark job | §9.3. Returns `202 { runId }` or **409 `benchmark_in_progress`**. |
| `GET  /api/admin/llm/benchmark/:runId` | Poll job | `{ status: running\|done\|error, completed, total, partial/summary }`. |
| `GET  /api/admin/llm/benchmarks?providerId&limit` | Benchmark history | From `llm_benchmarks`, newest first. |
| `GET  /api/admin/llm/probes?providerId&sinceHours` | Probe series (P2) | **Not implemented** — the scheduled prober that would populate `llm_latency_probes` is deferred (§9.6, §18); the route, collection, and 30 d TTL index exist and are ready for it. |
| `PUT  /api/admin/llm/active` | Switch active provider/model | Body `{ providerId: string \| null, modelId?: string }` (`null` ⇒ LLM off, dictionary-only). Optional `"verify": true` runs a connection test first and refuses the switch on failure (default **true** — see §12). Applies via `LlmService`, audits, returns new status. |
| `POST /api/admin/llm/import-env` | Seed DB from current env | One-click migration: builds a provider doc from the live env config (the key is already server-side; it is encrypted and stored, never echoed). Idempotent by vendor name. |
| `GET  /api/admin/metrics` | Production metrics snapshot | `getMetricsSnapshot()` + new latency percentiles (§9.2). |
| `GET  /api/admin/audit?limit&before` | Audit page | Read-only. |

Example — create provider:

```http
POST /api/admin/llm/providers
{ "name": "OpenRouter (m3)", "vendor": "openrouter",
  "apiKey": "sk-or-…", "models": [{ "id": "minimax/minimax-m3", "isDefault": true }],
  "headers": { "referer": "https://dict.ai-dictionary.org", "title": "open-dictionary" },
  "enabled": true }
→ 201 { "id": "665f…", "apiKey": { "set": true, "last4": "d41c" }, … }
```

---

## 9. Latency testing (the Latency Lab)

The core product question the panel must answer: **"which provider/model gives
my users the fastest correct entries, and is the one I'm running degrading?"**
Four complementary mechanisms, cheapest first:

### 9.1 Passive: production latency percentiles (always on, zero cost)

`server/metrics.ts` currently keeps only `sum/count` per provider id → an
average, which hides tail latency (the thing users feel). Change:

- Keep a **bounded ring buffer of the last 512 latency samples per provider
  id** alongside the existing accumulator (≈4 KB/provider — negligible).
- `getMetricsSnapshot()` additionally reports
  `llmLatencyByVendor: { p50, p95, p99, count, windowSize }` computed from the
  ring at snapshot time (sort of ≤512 numbers — trivial).
- Existing counters, the 5-minute `[metrics]` log line, and error/fallback
  tracking are unchanged; the admin metrics endpoint (§8) simply exposes the
  richer snapshot.

This is the *truth* — real prompts, real words, real network conditions — but
it only covers the **active** provider. Everything below exists to measure
**candidates**.

### 9.2 One-shot connection test (seconds, ~1 call)

`POST /api/admin/llm/test` (§8): a single canonical translate call, reporting
`ok + ms + errorCode`. Used for:
- the **Test** button on each provider card,
- **pre-save validation** in the provider form (draft mode — catches a bad key
  before it is ever stored),
- the **verify-before-switch** step of `PUT /active`.

The call is capped at `DEFAULT_TIMEOUT_MS` (15 s) via
`Math.min(cfg.timeoutMs ?? cap, cap)` — a **ceiling, not a floor**: the test
never waits longer than the cap even when the provider's own per-model
`timeoutMs` is higher. This keeps the admin UI synchronous/responsive, but
means a genuinely slow provider can succeed in production (cache-miss lookups
use the provider's own `timeoutMs` directly, via `providerToLlmConfig`) yet
still report `errorCode: "timeout"` here. See §18 for the fix history and a
worked example.

### 9.3 On-demand benchmark (the main event)

**Request** (`POST /api/admin/llm/benchmark`):

```jsonc
{
  "targets": [ { "providerId": "665f…", "modelId": "deepseek-v4-flash" },
               { "providerId": "6660…", "modelId": "minimax/minimax-m3" } ],
  "samples": 5,                        // 1–10, hard cap
  "words": null,                       // null ⇒ default canonical set
  "sourceLang": "en", "targetLang": "en"
}
```

**Canonical word set** (default): `["run", "serendipity", "take off", "bank",
"ephemeral"]` — deliberately fixed and mixed (high-polysemy words produce long
outputs, rare words short ones) so results are comparable **across runs and
across providers**. Custom word lists are allowed (≤10 words, validated by
`normalizeText`) for language-specific testing. `samples` cycles through the
word list.

**Execution model — async job, polled:**

- A 2-provider × 5-sample run at ~2–8 s/call plus pacing can exceed 60 s —
  past the edge nginx proxy timeout — so the POST returns `202 { runId }`
  immediately and the UI polls `GET /benchmark/:runId` every ~2 s.
- Jobs run **in-process** (no queue infra): an in-memory job record
  `{ runId, status, completed, total, partial }`; the final document is
  written to `llm_benchmarks` on completion. If the server restarts mid-run,
  the poll 404s and the UI shows "run lost (server restarted)" — an accepted
  simplification for an admin tool.
- **One benchmark at a time globally** (in-memory mutex) → `409` otherwise.
  Prevents both accidental cost multiplication and self-inflicted vendor rate
  limiting.
- Per target: calls run **sequentially with a 250 ms gap** (vendor rate-limit
  hygiene, and avoids self-queueing skew where parallel calls inflate each
  other's latency). **Across targets: parallel** — different vendors don't
  share limits, so a compare run's wall time ≈ the slowest provider, not the
  sum.
- Each call uses the target's configured `timeoutMs` (default 15 000, as
  production does); a failed/timed-out call records `{ ok: false, errorCode }`
  (the existing `LlmErrorCode` taxonomy) and the run continues — error rate is
  itself a result.

**Measurement details:**

- `ms` is wall-clock around `provider.translate()` — exactly what
  `recordLlmLatency` measures in production, so numbers are apples-to-apples
  with §9.1. (Calls are non-streaming JSON-mode completions, so total time is
  the user-relevant number; TTFB only becomes interesting if streaming is ever
  adopted — noted as future work.)
- Small adapter change: `openaiCompat.ts` surfaces the vendor-reported
  `usage` (token counts) on the result as optional
  `meta?: { promptTokens, completionTokens }` — backward-compatible, lets the
  benchmark report `tokensOut` so you can spot "model X is slower because it
  writes 2× more".
- Summary per target: `p50, mean, min, max, successRate` (with n ≤ 10, a p95
  would be noise — the UI shows the raw run list on expand instead).

**Benchmark targets are built with `LlmService.buildEphemeral()`** — the
active production provider is never disturbed, and a target can be a provider
that is disabled for production use.

### 9.4 Compare mode & "promote the winner"

Compare is not a separate mechanism — it's a benchmark with multiple
`targets`. The UI renders a side-by-side table sorted by p50 and offers a
one-click **"Make X active"** which calls `PUT /active` (with verify). The
benchmark run id is recorded in the audit entry for the switch, so the history
answers "why did we move to model Y" later.

### 9.5 Isolation guarantees (why probes don't lie to you)

Benchmark/test traffic must not contaminate the system being measured:

1. **Never reads or writes the translation cache** — probe calls go straight
   to `provider.translate()`, not through `doTranslate()`'s tiering. (A cached
   "serendipity" would report 3 ms and measure nothing; writing probe results
   would poison real entries.)
2. **Never increments production metrics** — `recordLlmLatency` /
   `recordLlmError` are not called; probe results live only in the
   run/probe collections. The §9.1 percentiles remain pure production truth.
3. **Never becomes the active provider** — ephemeral instances are discarded
   after the run.

### 9.6 Scheduled probes (P2 — trend lines) — **deferred (Phase 4, not shipped)**

On-demand benchmarks answer "which is faster *now*". Vendors degrade at
specific times of day; a lightweight background probe gives the trend:

- Interval env/admin setting **`LLM_PROBE_INTERVAL_MIN`** (default 0 = off;
  recommended 60). Each tick sends **one** canonical call per *enabled*
  provider and appends `{ providerId, model, ts, ms, ok, errorCode }` to
  `llm_latency_probes` (TTL 30 d).
- Runs off the same `setInterval(...).unref()` pattern as
  `logMetricsSummary` (`server/index.ts:50`); skipped when Mongo is down.
- Cost honesty: hourly × 3 providers × ~1k tokens ≈ 72k tokens/day — fractions
  of a cent on flash-class models, but it is nonzero and it is why the default
  is **off** and per-provider probing follows the `enabled` flag.
- UI: 24 h / 7 d sparkline + p50/p95 per provider on the Latency page; the
  same data answers "did last night's vendor incident hit us?".

### 9.7 Cost guardrails (summary)

| Guardrail | Value |
|---|---|
| Samples per target | hard cap 10 |
| Words per custom set | ≤ 10, each ≤ 64 chars |
| Concurrent benchmarks | 1 (global mutex) |
| Admin route rate limit | 30 rpm/IP (env-tunable) |
| Scheduled probes | opt-in, ≥ 15 min interval floor, enabled providers only |
| UI cost hint | est. tokens ≈ samples × targets × ~1.3k, shown before Run |
| Audit | every run recorded with actor + params |

---

## 10. Frontend admin UI

### 10.1 Routing & access

- New lazy-loaded route **`/admin`** (`React.lazy` + `Suspense`) so the admin
  bundle never ships to regular users; nested routes via the existing
  react-router setup in `src/App.tsx`.
- `<RequireAdmin>` wrapper: uses `useAuth0()`; if unauthenticated →
  `loginWithRedirect(returnTo=/admin)`; if the access token lacks
  `manage:llm-config` → a "not authorized" page. Cosmetic only — the API
  enforces (§6).
- Not linked from the public header; reachable by URL (and optionally a link
  rendered only when the claim is present).
- **Language & theme:** reuses the existing CSS custom properties/theme toggle
  (`docs/ui-i18n-and-themes.md`) so dark/light "just works". Admin copy is
  **English-only initially** — it is operator-facing; keys can be added to
  `src/i18n/translations.ts` later without rework.

### 10.2 Pages

```
/admin            Overview   — status, prod latency, recent changes
/admin/providers  Providers  — CRUD, keys, models, test
/admin/latency    Latency Lab — benchmarks, compare, history, probes
/admin/audit      Audit      — change log
```

**Overview**

```
┌─────────────────────────────────────────────────────────────────────┐
│ Admin · Overview                          source: db · env: prod    │
├─────────────────────────────────────────────────────────────────────┤
│ ACTIVE PROVIDER                       HEALTH                        │
│ ┌───────────────────────────────┐    ┌───────────────────────────┐  │
│ │ DeepSeek (prod key)           │    │ ● active                  │  │
│ │ deepseek-v4-flash             │    │ last test: ok · 1.8 s     │  │
│ │ llm:deepseek:deepseek-v4-flash│    │ fallback rate: 1.2 %      │  │
│ │ [Switch… ▾]  [Test now]       │    │ llm errors (by code): …   │  │
│ └───────────────────────────────┘    └───────────────────────────┘  │
│                                                                     │
│ LOOKUPS BY TIER                PROD LLM LATENCY (last 512 reqs)     │
│ cache 78% · llm 19% · dict 3%  p50 2.1 s · p95 4.8 s · p99 7.4 s    │
│                                                                     │
│ RECENT CHANGES                                                      │
│ 07-11 09:12  auth0|rob…  active.switch  → deepseek-v4-flash         │
│ 07-10 22:41  auth0|rob…  provider.update OpenRouter (key rotated)   │
└─────────────────────────────────────────────────────────────────────┘
```

**Providers** — card list + editor drawer

```
┌ Providers ─────────────────────────────────────── [+ Add provider] ┐
│ ● DeepSeek (prod key)   deepseek-v4-flash (default)   ACTIVE       │
│   key ····9f3a · last test ok 1.8 s                                │
│   [Edit] [Test] [Benchmark] [Make active ▾]                        │
│ ○ OpenRouter (m3)       minimax/minimax-m3            enabled      │
│ ○ Z.AI GLM              glm-5.2                       disabled     │
└────────────────────────────────────────────────────────────────────┘

Editor drawer:  Name ▸ Vendor (select: DeepSeek / OpenRouter / GLM /
  Custom OpenAI-compatible) ▸ Base URL (prefilled per vendor, editable,
  required for Custom) ▸ API key (password input; placeholder
  "····9f3a — leave blank to keep") ▸ Models table (id, label, default
  radio, timeout, temperature; [+ model]) ▸ Extra headers (OpenRouter
  referer/title) ▸ Enabled toggle
  Footer: [Test connection]  (runs §9.2 with the DRAFT values)  [Save]
```

**Latency Lab**

```
┌ Latency Lab ───────────────────────────────────────────────────────┐
│ Targets: [x] DeepSeek/deepseek-v4-flash  [x] OpenRouter/minimax-m3 │
│          [ ] GLM/glm-5.2                                           │
│ Samples: (5 ▾)   Words: default set ▾   en → en ▾                  │
│ est. ~13k tokens                                  [▶ Run benchmark]│
├────────────────────────────────────────────────────────────────────┤
│ RUN bm_a1b2 · 2026-07-11 10:02 · done            [view raw runs ▸] │
│ target                     p50     mean    min–max     ok          │
│ deepseek-v4-flash          2.1 s   2.3 s   1.7–3.9 s   5/5  ★      │
│ openrouter/minimax-m3      3.4 s   3.6 s   2.9–4.8 s   5/5         │
│                                   [Make deepseek-v4-flash active]  │
├────────────────────────────────────────────────────────────────────┤
│ HISTORY (p50 per run)     PROBES (7d, hourly — P2)                 │
│ deepseek   ▂▃▂▂▅▃▂        deepseek   ▂▂▃▂▂▅▂▂▃▂                    │
│ openrouter ▄▅▄▆▅▆▅        openrouter ▄▄▅▄▆▅▄▅▄▅                    │
└────────────────────────────────────────────────────────────────────┘
```

While a run is in progress the results table fills row by row from the poll
(`completed/total` drives a progress bar).

**Audit** — plain paginated table (ts, actor, action, target, diff summary).

### 10.3 Implementation notes

- Data layer mirrors the existing `src/api/*` fetch modules
  (`src/api/admin.ts`), attaching the bearer token via
  `getAccessTokenSilently()` exactly like `src/api/favorites.ts` does.
- Charts are **dependency-free**: sparklines as small inline SVG polylines,
  latency tables as plain markup — consistent with the project's zero
  chart-lib frontend.
- New components: `AdminLayout`, `RequireAdmin`, `ProviderCard`,
  `ProviderForm`, `ApiKeyField` (write-only semantics baked in),
  `ActiveSwitcher` (with verify + confirm dialog), `BenchmarkForm`,
  `BenchmarkResults`, `Sparkline`, `AuditTable`.
- Confirm dialogs on: switching active provider/model, deleting a provider,
  disabling the active provider's vendor (§12), turning the LLM tier off.

---

## 11. Interaction with the translation cache

Two facts an admin **must** see in the UI (and this doc records why):

1. **Switching models does not refresh cached entries.** The cache key is
   `(word, sourceLang, targetLang, CACHE_VERSION)` — the provider id was
   deliberately dropped from the key (see
   `docs/design-translation-cache.md` appendix and `server/translate.ts:100`).
   A model switch therefore only affects **cache misses**; existing entries
   keep serving the old model's output for up to the 1-year TTL. The switch
   dialog states this plainly.
2. **`CACHE_VERSION` stays a code constant.** It is coupled to the prompt and
   adapter shape, which live in code; making it runtime-editable would invite
   silent cache/prompt drift. If a model change is significant enough to
   warrant regenerating entries, that is a code-reviewed `CACHE_VERSION` bump
   — same as a prompt change.

Optional P2 convenience: a read-only **cache stats** card (doc count, hit rate
from metrics) and a guarded **"purge cache version…"** action. Explicitly not
required for v1.

---

## 12. Failure modes & edge cases

| Situation | Behavior |
|---|---|
| Mongo down at boot | Exactly today's behavior: env provider (or dictionary-only). Panel shows `source: env` + Mongo warning; provider CRUD returns 503. |
| Mongo down mid-flight | `LlmService` keeps the last applied provider (in-memory). Admin writes fail loudly; lookups unaffected. |
| Active provider's key rotated to a bad value | `PUT /active` verify-on-switch (default on) blocks bad *switches*; a bad *edit* of the live provider triggers hot reload + a post-reload connection test whose failure flags status `misconfigured` in the panel. Production behavior on LLM failure is unchanged and already safe: per-request fallback to the dictionary tier (`server/translate.ts` tier 2), surfaced via `fallbackRate`. |
| Deleting the active provider | `409 provider_active` — switch (or set none) first. Same for disabling it. |
| `activeProviderId` dangling (doc deleted out-of-band) | `reloadFromDb()` logs, falls back to env layer, status shows `misconfigured` + reason. |
| `CONFIG_ENCRYPTION_KEY` missing | Key-touching writes 503 with actionable message; reads/status/env-configured LLM unaffected. |
| Master key lost | Stored keys unrecoverable **by design**; re-enter keys. Runbook note. |
| Benchmark while a switch happens | Targets are ephemeral instances pinned at job start — unaffected. |
| Server restart mid-benchmark | Job state is in-memory: poll 404s, UI explains; no partial doc written. |
| Two admins editing concurrently | Last-write-wins on provider docs (single-admin reality); `configVersion` still converges all instances. Optimistic concurrency (`If-Match` on `updatedAt`) noted as P3. |
| Vendor 401 body quoting the bad key | Vendor error bodies truncated before storage/logging (§5.3). |

---

## 13. Security considerations (delta to docs/security.md)

New trust-boundary element: an **admin plane** on the same Express app.

- **Key exfiltration:** encrypted at rest (§5), write-only API (§5.2), masked
  UI, redacted audit/logs, backups safe. No reveal path exists.
- **Privilege escalation:** all admin routes behind `checkJwt` +
  `requireAdmin`; SPA guard is UX only. 403s are audited? — no: *denied*
  requests are logged (not persisted) to avoid an unauthenticated-write
  channel into Mongo.
- **Economic abuse of test/benchmark endpoints** (paid LLM calls): admin-only,
  hard caps, global mutex, rate limit, audit trail (§9.7).
- **SSRF via `baseUrl` / draft test:** an admin can point the server's fetch
  at arbitrary URLs. Mitigations: `https://` required in production
  (`http://` only for localhost/RFC-1918 dev), and this is an accepted
  admin-trust tradeoff — the same admin could achieve the same by saving the
  provider; there is no unauthenticated path to it.
- **CSRF:** N/A — bearer tokens, no cookies, `credentials: false` CORS
  unchanged.
- **Injection:** provider ids from params go through `ObjectId` validation;
  all Mongo writes bind typed scalars per the existing convention.
- Update the table in `docs/security.md` when this ships (it is a living doc).

---

## 14. Testing strategy

Vitest, mirroring the existing per-module test files.

**As shipped** (§18): every module is unit-tested directly against its own
functions/exports, not via HTTP — there is no supertest dependency anywhere
in this codebase (including pre-existing routers like `favorites.ts`), so
`authz` is tested by calling `isAdminSub()` directly rather than standing up
`createApp()` and asserting on response codes. There is no "permission path"
to test since RBAC (§6) was not implemented — only the allowlist path exists.

- **crypto**: encrypt/decrypt roundtrip; GCM tamper detection (flip a ct byte
  → throws); `keyVersion` + `_PREVIOUS` rotation path; missing-key 503.
- **authz**: `isAdminSub()` unit-tested directly (`server/admin/auth.test.ts`,
  via `vi.resetModules()` + dynamic re-import to exercise different
  `ADMIN_USER_IDS` env values) — allowlist hit/miss, empty allowlist, and
  malformed/missing `sub`.
- **providers repo/routes**: validation matrix (§4.1), masked responses never
  contain key material (assert on serialized body), `apiKey`-absent PATCH
  keeps the stored blob, delete/disable-active → 409.
- **LlmService**: env fallback when Mongo empty; DB wins when present; swap
  atomicity (old reference still usable); dangling active → env fallback +
  `misconfigured`.
- **benchmark**: job lifecycle with a mocked provider (deterministic fake
  latencies) — caps enforced, mutex 409, summary math (p50 on odd/even n),
  failed samples counted not thrown, **no cache reads/writes** and **no prod
  metric increments** (spy on `translationCache` / `metrics`).
- **metrics**: ring buffer bounded at 512; percentile correctness on a known
  sample set.
- **audit**: key material never present in stored diffs (property-style test
  over redaction helper).

---

## 15. Rollout plan

- **Phase 0 — prerequisites (no behavior change):** ✅ shipped. Generate
  `CONFIG_ENCRYPTION_KEY`; set `ADMIN_USER_IDS`; update `.env.example` files.
  (Auth0 RBAC setup dropped — §6, §17 Q1.)
- **Phase 1 — read-only plane (low risk, immediately useful):** ✅ shipped.
  `requireAdmin`, `GET status` + `GET metrics` (with percentiles), Overview
  page.
- **Phase 2 — manage & switch (the core):** ✅ shipped. Collections, crypto,
  provider CRUD, connection test (incl. draft), env import, `PUT /active` +
  `LlmService` hot swap, audit log, Providers page.
- **Phase 3 — Latency Lab:** ✅ shipped. Benchmark jobs + history + compare UI
  + "promote winner".
- **Phase 4 — optional polish:** **deferred**, not shipped. Scheduled probes
  + sparklines, vendor `/models` proxy, cache stats/purge card, config
  polling for multi-instance, admin i18n. See §18 for what this leaves
  half-built (route/collection/TTL index exist for probes; the prober itself
  doesn't).

Each phase ships independently; the app runs unchanged if the process stops
after any phase — Phase 4 stopping here is exactly that: no half-built state,
just unstarted work.

### New env vars (all in `server/.env`, documented in `server/.env.example`)

| Var | Default | Purpose |
|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | — (required for key writes) | AES-256-GCM master key, base64 |
| `CONFIG_ENCRYPTION_KEY_PREVIOUS` | — | decrypt-only, during rotation |
| `ADMIN_USER_IDS` | — | comma-separated Auth0 subs (the whole authz model — §6) |
| `ADMIN_RATE_LIMIT_RPM` | `30` | admin router rate limit |
| `LLM_CONFIG_POLL_SEC` | *(not implemented — Phase 4)* | cross-instance config convergence (0 = off) |
| `LLM_PROBE_INTERVAL_MIN` | `0` (off) | scheduled latency probes (§9.6) — config var exists and is read at boot, but the interval loop itself is Phase 4/not implemented, so the value currently has no effect |

### Proposed file layout

```
server/admin/router.ts        # createAdminRouter(deps) — all §8 routes
server/admin/auth.ts          # requireAdmin middleware
server/admin/crypto.ts        # encrypt/decrypt/redact helpers
server/admin/providersRepo.ts # llm_providers / llm_settings access + validation
server/admin/benchmark.ts     # job runner, mutex, summaries (§9.3)
server/admin/audit.ts         # append + query
server/llm/service.ts         # LlmService (§7)
src/api/admin.ts              # fetch layer (bearer via getAccessTokenSilently)
src/pages/admin/*             # Overview / Providers / Latency / Audit + components
```

---

## 16. Alternatives considered

| Alternative | Why not (here) |
|---|---|
| **Status quo** (env edit + restart) | No runtime switching, restart blip on every key rotation, and — decisive for this app — no way to latency-test candidates against production-identical prompts. |
| **JSON config file + SIGHUP/watch** | Avoids Mongo coupling, but: plaintext secrets on disk, no audit, no multi-instance story, and clashes with immutable-container deployment. Mongo is already a hard dependency. |
| **External secret manager (Vault/Doppler)** | Stronger secret story, real overkill for a solo-operated stack; the AES-GCM-at-rest + env master key design reaches the same practical bar (DB dump alone is useless). Revisit if the team grows. |
| **Separate admin app/service** | Better blast-radius isolation, but doubles auth wiring, deploy surface, and CORS complexity. An in-app router behind `requireAdmin` matches the project's scale; the lazy route keeps it out of the user bundle. |
| **LLM gateway (LiteLLM / Portkey / OpenRouter-as-router)** | Outsources key mgmt, routing and latency dashboards — but adds a network hop to every lookup (directly against the latency goal), an external dependency, and the app already owns a clean provider abstraction. Note: OpenRouter is *already available as a vendor* here, which covers "many models behind one key" when desired. |

---

## 17. Open questions — resolved 2026-07-11

All four were decided before implementation began; shipped exactly as
decided, confirmed against running code/config (§18).

1. **Auth0 RBAC vs allowlist-only → allowlist-only.** Ship on
   `ADMIN_USER_IDS` alone; no Auth0 dashboard RBAC setup. `requireAdmin`
   checks only the env allowlist (§6). Revisit RBAC if/when a second admin
   needs independent access.
2. **Scheduled probes default → off**, and the scheduler itself is deferred
   (Phase 4, not shipped) — see §18. `LLM_PROBE_INTERVAL_MIN` defaults to `0`
   in `server/config.ts`; even a nonzero value has no effect yet since the
   interval loop was never built. Not a partial rollout: nothing runs.
3. **Benchmark languages → en→en.** `server/admin/benchmark.ts`'s
   `DEFAULT_LANG = 'en'`; the canonical word set (§9.3) and, per the request
   shape, the language pair remain admin-configurable per run.
4. **Retention → confirmed as designed**, verified against the live TTL
   indexes via `mongosh`: `llm_benchmarks` 90 d (`expireAfterSeconds: 7776000`),
   `llm_latency_probes` 30 d (`2592000`), `admin_audit` 365 d (`31536000`).

---

## 18. Implementation notes (2026-07-11)

Phases 0–3 (§15) shipped in full and are deployed to production. This
section is the authoritative deviation list between this doc as originally
proposed and what actually shipped — read it before trusting any other
section's exact interface/route/type claims over the source.

**Auth model**
- Allowlist-only, not RBAC-primary (§6, §17 Q1). `<RequireAdmin>` on the
  frontend checks only `isAuthenticated` — there's no permission claim to
  gate on. The allowlist check is entirely server-side; a logged-in,
  non-allowlisted user reaches `/admin`'s shell and sees a 403 from the first
  `GET /llm/status` call, surfaced by `AdminLayout` as a distinct "not on the
  admin allowlist" state, not a route-level block.

**Types (`server/llm/service.ts`)**
- `LlmRuntimeStatus.source` is `'env' | 'db'` — two-valued, not three
  (`'none'` doesn't exist; "off" is expressed via `status`, not `source`).
- `LlmRuntimeStatus.appliedAt` is `string` (`.toISOString()`), not `Date`.

**Routes (§8)**
- `GET /api/admin/llm/probes` is not implemented — see Phase 4 below.
- `POST /api/admin/llm/import-env` idempotency is keyed on the **generated
  provider name** (e.g. `"DeepSeek (from env)"`, via
  `existingNames.has(candidate.name)` in `readEnvProviderCandidates()`), not
  a literal `vendor` field match. Re-running import is still a no-op once a
  provider with that name exists; renaming it manually would allow a
  duplicate on the next import.

**Benchmark runner (`server/admin/benchmark.ts`) — matches §9.3 closely**
- One addition beyond the original design: a defensive `MAX_TARGETS = 10`
  cap on `targets.length`, not specified in §9.3/§9.7. Generous relative to
  every documented use (compare mode uses 2) — added so a malformed/malicious
  request can't fan out into an unbounded number of concurrent vendor calls.
  Everything else (mutex, sequential-per-target/parallel-across-targets,
  250 ms gap, error-as-result, isolation from cache/metrics) matches §9.3–9.5
  as designed.

**Testing (§14)**
- Every module is unit-tested directly against its exports; there is no
  supertest dependency anywhere in this codebase, including pre-existing
  routers (`favorites.test.ts` does not use it either — the original §14
  text describing it as a supertest example was inaccurate even before this
  feature). `authz` tests call `isAdminSub()` directly rather than asserting
  on HTTP response codes from a running app.

**Not a deviation (confirmed matching as designed)**
- §9.1 production latency percentiles: `getMetricsSnapshot()` reports
  `llmLatencyByVendor: { p50, p95, p99, count, windowSize }` exactly as
  specified, additive alongside the pre-existing `llmAvgLatencyMsByVendor`.

**Phase 4 — deferred, not shipped**
- Scheduled probes (§9.6): the `llm_latency_probes` collection, its 30 d TTL
  index, and the `GET /probes` route all exist and are ready; the
  `setInterval`-based prober that would populate the collection was never
  built. `LLM_PROBE_INTERVAL_MIN` defaults to `0`/off per §17 Q2 regardless.
- Multi-instance config polling (§7.3): `LLM_CONFIG_POLL_SEC` does not exist
  in `server/config.ts`. Fine today — one `api` container — needed only if
  `docker-compose.yml` grows a second replica.
- Vendor `/models` proxy, cache stats/purge card (§11), admin i18n: not
  built. Admin copy is English-only, as §10.1 allowed for v1.

**Deployment**
- Backend: `docker compose up -d api` against the existing
  `docker-compose.yml` (image rebuilt via `docker compose build api` first).
  No compose file changes were needed — new env vars are optional with safe
  defaults (§7.2, §12), so the container boots and serves exactly as before
  for any operator who hasn't set `ADMIN_USER_IDS` yet.
- Frontend: `npm run build` → `rsync -a --delete` to the nginx web root
  (`/var/www/html/dict.ai-dictionary.org`), per the existing deploy process —
  no nginx config changes needed (§10.1's lazy route + existing SPA
  fallback/CSP already cover it).
- **Operator action required post-deploy:** `ADMIN_USER_IDS` is unset in
  production. The portal deploys safely either way (§7.2/§12 fail open to
  env-configured/dictionary-only behavior, never to a crash), but `/admin`
  is unreachable — every request 403s — until an operator adds their Auth0
  `sub` to `ADMIN_USER_IDS` in `server/.env` and runs
  `docker compose up -d api` once more.

**Connection-test timeout cap — aligned with production (fixed 2026-07-11, post-Phase-3)**
- As originally shipped, `POST /llm/test` and the verify path of
  `PUT /llm/active` hardcoded `TEST_TIMEOUT_MS = 10_000` — stricter than the
  15 s `DEFAULT_TIMEOUT_MS` production actually uses (`openaiCompat.ts`). A
  provider whose backend answered in the 10–15 s band therefore *passed in
  production but failed the admin **Test** button* (and got blocked by
  verify-on-switch) with a false `errorCode: "timeout"`. Fixed by exporting
  `DEFAULT_TIMEOUT_MS` from `server/providers/llm/openaiCompat.ts` (re-exported
  through the `providers/llm` barrel) and setting
  `TEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS`, so both endpoints now cap at the same
  15 s production uses. Commit `e44b1a2`.
- The cap is applied as `Math.min(cfg.timeoutMs ?? cap, cap)` — a **ceiling,
  not a floor** (§9.2). Raising a provider's per-model `timeoutMs` above 15 s
  fixes/speeds real production lookups (they read the model's `timeoutMs`
  directly via `providerToLlmConfig`) but does **not** raise the Test/verify
  ceiling — deliberately, so the admin UI stays synchronous. Consequence: a
  provider genuinely slower than 15 s can pass in production yet still show a
  Test/verify timeout.

**Operational note — a legitimately slow provider (`grok-4.5` behind a gateway)**
- Provider `6a5266b994a4e1caf1be1fed` (model `grok-4.5`) points at a
  self-hosted `new-api` gateway (`baseUrl https://new-api.ai-dictionary.org/v1`)
  whose channel for this model forwards upstream to a third-party reseller
  (`packyapi.com`). Real, **successful** completions through that channel were
  observed at 11–21 s (occasionally longer) — routinely above even the 15 s
  cap. Its `errorCode: "timeout"` from the Test button is therefore an accurate
  report of genuine upstream latency, not an app bug or a misconfiguration; the
  test cap moved the reported `ms` from ~10 000 to ~15 000 in lockstep with the
  fix above, confirming the fix landed.
- **Decision:** set this provider's per-model `timeoutMs` to `30000` so
  production cache-miss lookups to it succeed. This is a data change to the
  model entry in `llm_providers` — applied via the Providers page, or a scoped
  `mongosh` update to that model's `timeoutMs` (never touching the encrypted
  `apiKey`); no code change. Trade-offs accepted: (1) every cache miss routed to
  this provider carries that multi-second latency, a poor fit for a *primary*
  dictionary provider; (2) the **Test** button still caps at 15 s (above), so it
  may keep reporting a timeout for this provider even though production lookups
  now succeed. Faster alternatives (DeepSeek / OpenRouter / GLM) remain the
  better default per the same latency observations.
