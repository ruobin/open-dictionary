# Design: User activity log (lookups, IP, device — growth/behavior analytics)

**Status:** implemented · **Proposed:** 2026-07-19 · **Shipped:** 2026-07-19
**Scope:** a new `activity_log` MongoDB collection that records one entry per public
dictionary lookup (`GET /api/translate/:text`) — word, language pair, cache tier, client
IP, and parsed device/browser/OS info — plus a new admin-only `/admin/activity` page
(list + aggregated summary) so the operator can analyze user behavior and app growth
(popular words, traffic trend, device/channel mix) without shell access to Mongo.

---

## 1. Why

Today the only visibility into real usage is `server/metrics.ts` (in-memory counters,
reset on every restart, no per-word or per-client breakdown) and an unstructured
per-request console log line (`[translate] {tier, sourceLang, targetLang, textLength,
latencyMs}` — deliberately `textLength`, never the actual word, per the design doc's own
comment in `server/translate.ts`). Neither answers basic growth questions an operator
needs:

- *Which words are actually popular?* (Word of the day (`server/wordOfDay.ts`) picks
  randomly from the cache; there's no "trending" or "most looked up" signal at all.)
- *Is traffic growing week over week? From where (web app vs. the Chrome extension)?*
- *What devices/browsers do real users have?* (Relevant for prioritizing future work —
  e.g. §7/§9 of `to-do-list.md`, TTS and mobile UX.)
- *Rough unique-visitor counts* to gauge growth, without a full analytics/ads SDK (this
  project deliberately ships **zero** third-party trackers — `docs/security.md`,
  `src/i18n/translations.ts` `privacy.webP2`).

### Goals

1. Record one document per lookup: normalized word, source/target language, which tier
   served it (`cache` | `llm` | `dictionary`), latency, client IP, and a parsed
   device/browser/OS summary from `User-Agent` — enough for word-popularity, traffic
   trend, and device/channel breakdowns.
2. Never slow down or fail a user's lookup because of logging — fire-and-forget,
   identical failure-isolation posture to `cacheSetSafe()` in `server/translate.ts`.
3. Admin-only surface: a raw paginated log (mirrors `/admin/audit`'s cursor pattern) and
   an aggregated summary (top words, traffic by day, breakdown by tier/channel/device) —
   reusing the existing `requireAdmin` + `adminLimiter` plane, no new trust boundary.
4. Bounded retention via a Mongo TTL index — this is higher-volume, more
   privacy-sensitive data than any existing collection, so it gets the **shortest**
   TTL in the codebase (180 days — half of `translations`'/`admin_audit`'s 365 days),
   not indefinite.
5. Be transparent about it: update `docs/security.md` and the public `/privacy` page to
   disclose that lookups are logged (word, IP, device) for internal product analytics,
   never shared with third parties, never used for advertising.

### Non-goals

- **No third-party analytics/tracking.** This is first-party, server-side, admin-only
  data — no client-side script, pixel, or SDK, no data leaves this server. The existing
  privacy claim ("no advertising trackers, analytics pixels, or third-party scripts")
  remains true; this section documents what changes: server-side request logging now
  *persists* (previously it was a console line, gone on log rotation) and now *includes*
  the word and a device summary, not just `textLength`.
- **No per-user identity for this log.** `GET /api/translate/:text` is deliberately
  public/unauthenticated (design doc precedent: `docs/security.md`'s trust-boundary
  table) — there is no JWT to read a `sub` from on this route, so entries are anonymous
  (IP + device only, no `userKey`/Auth0 identity). Joining lookups to a signed-in user's
  favorites/history is explicitly out of scope for v1 (see §9).
- **No IP geolocation lookup** (MaxMind/ipapi/etc.) — out of scope; the raw IP alone is
  enough for a rough unique-visitor count and is what the user asked for. A future pass
  could add offline GeoIP if country-level breakdowns become valuable (§9).
- **No client-side analytics event batching** (e.g. logging every keystroke/search
  suggestion) — v1 logs exactly one event per completed `/api/translate/:text` response,
  the same request that already produces a `[translate]` console log line today.
- **No export/CSV, no charting library** — the summary is plain JSON rendered as
  numbers/tables in the admin page, consistent with every other admin stat card
  (`Overview.tsx`'s `Stat` component, `AuditTable.tsx`'s plain `<table>`).
- **No purge/delete admin action** on this collection in v1 — read-only, same posture as
  `/admin/audit` (append-only, TTL-only cleanup). Could be added later if needed (§9).

---

## 2. Current state (what this builds on)

| Piece | Where | Relevance |
|---|---|---|
| Per-request structured console log (ephemeral) | `server/translate.ts` `router.get('/translate/:text', ...)` | The exact point this feature hooks into — same request, same computed `{tier, sourceLang, targetLang, latencyMs}`, now also persisted with `word` + client metadata instead of just logged and discarded. |
| In-memory metrics (aggregate only, no persistence, no per-word) | `server/metrics.ts` | Complementary, not replaced — metrics stay the "hot, in-process counters" layer; this log is the "durable, queryable, per-event" layer. |
| `TRUST_PROXY` / `req.ip` | `server/app.ts`, `server/config.ts` | Already configured so `req.ip` reflects the real client IP behind the edge nginx (`TRUST_PROXY=1` in prod) — reused as-is, same precedent as `server/admin/router.ts`'s `reqIp()`. |
| Admin plane: auth, rate limit, router pattern | `server/admin/{router,auth}.ts` | New read-only routes bolted onto the existing `createAdminRouter()` — no new auth model, mirrors how Cache Entries (`docs/design-admin-cache-entries.md`) and Reports were added. |
| Cursor pagination + TTL collection precedent | `server/admin/audit.ts`, `server/db.ts` (`admin_audit`) | Same `{ts: -1}` sort + `before` cursor pattern reused verbatim for the raw activity log list; same TTL-index-on-a-date-field pattern for retention. |
| `ALLOWED_ORIGINS` / extension origin allowlisting | `server/app.ts`, `docs/design-browser-extension.md` §6 | The Chrome extension calls the same public `/api/translate/:text` endpoint from a `chrome-extension://<id>` origin — the `Origin` header is what lets this feature tell "web app" traffic apart from "extension" traffic (§5). |
| Privacy policy page | `src/pages/PrivacyPage.tsx`, `src/i18n/translations.ts` (`privacy.*` keys) | Gets one new disclosure paragraph (§8) — the existing page/i18n `t()` fallback-to-English mechanism means only the English string is strictly required; other locales fall back automatically until translated. |

---

## 3. Data model — one new collection, no changes to existing ones

**`activity_log`** (new):

```jsonc
{
  "_id": ObjectId,
  "ts": ISODate,
  "word": "serendipity",          // normalizeText()'d, same value used as the cache key
  "sourceLang": "en", "targetLang": "en",
  "tier": "cache",                  // "cache" | "llm" | "dictionary" — same enum as TranslateOutcome
  "latencyMs": 42,
  "ip": "203.0.113.7",             // req.ip (TRUST_PROXY-aware, same value server/admin/router.ts's reqIp() uses)
  "channel": "web",                 // "web" | "extension" | "other" — derived from Origin header (§5)
  "device": {                       // parsed from User-Agent (server/util/userAgent.ts), never stores the raw UA string
    "type": "desktop",              // "desktop" | "mobile" | "tablet" | "bot" | "unknown"
    "browser": "Chrome",
    "os": "Windows"
  }
}
```

Design choices:

- **No `userKey`/identity field** — see §1 non-goals; `/api/translate/:text` has no JWT to
  read. If auth is ever added to this route, `userKey` can be added as an optional field
  without a migration (older docs simply lack it, same pattern as `TranslationDoc`'s
  additive fields over time).
- **Raw `ip`, not hashed/truncated** — matches the existing precedent of
  `admin_audit.ip` (`server/admin/audit.ts`) storing the actor's raw IP; the tradeoff is
  accepted the same way there (admin-only read access, TTL-bounded, disclosed in the
  privacy policy). Storing a rough unique-visitor count and doing any future abuse
  investigation both need the real IP, not a hash. Revisit if this ever needs to be
  handed to a party outside the admin plane (§9).
- **Only `device: {type, browser, os}`, never the raw `User-Agent` string** — the raw UA
  string is far more fingerprint-able (exact browser/OS patch version, installed
  extensions in some UAs) than the coarse categories a growth dashboard actually needs;
  parsing down to three enums is a deliberate minimization step, done once at write time
  by `server/util/userAgent.ts` rather than stored raw and parsed later.
- **TTL 180 days** (`ACTIVITY_LOG_TTL_SECONDS`, `server/db.ts`) — shorter than
  `translations` (365d, content people keep re-requesting) and `admin_audit` (365d,
  low-volume compliance trail); this collection is the highest-volume, most
  privacy-sensitive one in the app, so it gets the shortest retention of any TTL'd
  collection here. 180 days is still enough for month-over-month growth comparisons.

### Indexes (`server/db.ts`)

```ts
await activityLog.createIndex({ ts: 1 }, { expireAfterSeconds: ACTIVITY_LOG_TTL_SECONDS, name: 'activity_log_ttl' })
await activityLog.createIndex({ word: 1 }, { name: 'activity_log_word' })
```

One ascending TTL index on `ts` doubles as the sort index for the raw list's
newest-first cursor pagination (identical precedent: `admin_audit_ttl` is the *only*
index `listAudit()` needs despite sorting `{ts: -1}` — MongoDB can traverse an ascending
index in reverse). The second index supports the summary's per-word grouping/top-words
aggregation without a full collection scan as volume grows.

---

## 4. Write path — `server/activityLog.ts`

```ts
export interface RecordActivityInput {
  word: string
  sourceLang: string
  targetLang: string
  tier: 'cache' | 'llm' | 'dictionary'
  latencyMs: number
  ip: string
  userAgent?: string
  origin?: string
}

/** Fire-and-forget: never throws, never awaited by the caller. Mirrors
 *  cacheSetSafe()'s failure isolation — a logging failure must never affect
 *  the user-facing response. */
export function recordActivity(input: RecordActivityInput): void
```

Hooked into `server/translate.ts`'s existing route handler, right after the
`[translate]` console log line (same data is already computed there — `tier`,
`sourceLang`, `targetLang`, `latencyMs` — this just also captures `text` (the word,
already normalized), `req.ip`, `req.get('user-agent')`, and `req.get('origin')`):

```ts
recordActivity({
  word: text,
  sourceLang,
  targetLang,
  tier: outcome.tier,
  latencyMs,
  ip: req.ip ?? 'unknown',
  userAgent: req.get('user-agent'),
  origin: req.get('origin'),
})
```

Called synchronously but **not awaited** — the `.insertOne()` promise is fired and its
rejection swallowed with a `console.warn`, identical in shape to `cacheSetSafe`'s
try/catch. The HTTP response is sent immediately regardless of whether the write has
landed. If Mongo is unavailable, this silently no-ops (same `getMongoDb() ?? null`
guard used everywhere else in the codebase).

---

## 5. Device/channel parsing (pure, unit-tested)

### 5.1 `server/util/userAgent.ts`

No new dependency (`ua-parser-js` was considered — this codebase's stated convention is
to prefer hand-rolled parsing/fakes over new dependencies for scoped needs, e.g.
`docs/design-admin-cache-entries.md` §10 explicitly declining `mongodb-memory-server`).
A UA string only needs to collapse to three coarse buckets here, not a full parse:

```ts
export interface ParsedUserAgent {
  type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown'
  browser?: string
  os?: string
}

export function parseUserAgent(ua: string | undefined): ParsedUserAgent
```

- **Bot detection first** (checked before device type): a small allowlist of substrings
  (`bot`, `spider`, `crawl`, `googlebot`, `bingbot`, `curl`, `wget`, `python-requests`,
  etc.) — classifies known crawlers/scripts distinctly from real human traffic so they
  don't pollute "unique visitor"/device-mix stats. Not exhaustive (this is a growth
  dashboard signal, not a security control — no bot traffic is blocked or treated
  differently by the rate limiter).
- **Type**: `tablet` (iPad, Android + "Tablet" token), `mobile` (iPhone, Android without
  "Tablet", other known mobile tokens), else `desktop`, else `unknown` for an
  empty/unrecognized UA.
- **Browser**: checked in a specific order to resolve UA-string ambiguity (Edge and
  Opera both include a `Chrome/` token; Chrome itself is checked last) — Edge, Opera,
  Chrome, Firefox, Safari (checked after Chrome since Chrome's UA also includes
  `Safari/`), else `undefined`.
- **OS**: Windows, macOS, iOS (checked before macOS's `Mac OS X` substring, since iOS
  UAs also contain it), Android, Linux, else `undefined`.

### 5.2 Channel classification (in `server/activityLog.ts`)

```ts
export function classifyChannel(origin: string | undefined): 'web' | 'extension' | 'other'
```

`origin?.startsWith('chrome-extension://')` → `'extension'` (the only cross-origin
caller of this public endpoint per `docs/design-browser-extension.md` §6); anything else
(including no `Origin` header at all, e.g. most same-origin web-app fetches) →
`'web'`. **Known limitation**, documented rather than solved: a same-origin browser
fetch does not always send an `Origin` header, so direct `curl`/script traffic against
the production domain is indistinguishable from real web-app traffic and is bucketed as
`'web'`. This is a directional growth signal, not a precise attribution system — precise
per-channel counting would need a dedicated client header, deferred as unnecessary
complexity for v1 (§9).

---

## 6. Admin API (`server/admin/activityLog.ts` + routes on the existing admin router)

Both routes under `/api/admin/activity*`, behind the existing `requireAdmin` +
`adminLimiter` — same as every other admin route. **Read-only**, so — like `/audit`,
`/metrics`, and `/reports/summary` — neither route is audited (nothing is mutated).

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/admin/activity` | Paginated raw log, newest first | Query: `word?`, `tier?` (`cache`\|`llm`\|`dictionary`), `channel?` (`web`\|`extension`\|`other`), `deviceType?`, `limit` (default 50, max 200), `before?` (cursor, `ts` ISO string) — identical shape/semantics to `parseAuditQuery`/`listAudit`. Returns `{ entries: ActivityLogView[], hasMore }`. |
| `GET /api/admin/activity/summary` | Aggregated stats over a trailing window | Query: `days?` (default 7, max 90). Returns `{ windowDays, totalLookups, uniqueIps, byTier, byChannel, byDeviceType, topWords, dailyCounts }` (§7). |

### 6.1 View shapes

```ts
export interface ActivityLogView {
  id: string
  ts: string
  word: string
  sourceLang: string
  targetLang: string
  tier: 'cache' | 'llm' | 'dictionary'
  latencyMs: number
  ip: string
  channel: 'web' | 'extension' | 'other'
  device: { type: string; browser?: string; os?: string }
}

export interface ActivitySummary {
  windowDays: number
  totalLookups: number
  uniqueIps: number
  byTier: Record<string, number>
  byChannel: Record<string, number>
  byDeviceType: Record<string, number>
  topWords: { word: string; count: number }[]   // top 20, ties broken by most recent
  dailyCounts: { date: string; count: number }[] // one entry per UTC day in the window, zero-filled
}
```

---

## 7. Summary aggregation — Mongo-side, not fetch-everything-into-JS

Unlike Cache Entries' report-count join (deliberately done in JS over a full `find()`
because report volume was ~2 documents), activity volume is expected to be materially
higher (every public lookup, potentially thousands/day), so the summary is computed with
a single Mongo `aggregate([...])` using `$facet` — one round trip, bounded by
`$match: { ts: { $gte: cutoff } }` using the `activity_log_ttl` index:

```ts
col.aggregate([
  { $match: { ts: { $gte: cutoff } } },
  { $facet: {
      total: [{ $count: 'n' }],
      byTier: [{ $group: { _id: '$tier', n: { $sum: 1 } } }],
      byChannel: [{ $group: { _id: '$channel', n: { $sum: 1 } } }],
      byDeviceType: [{ $group: { _id: '$device.type', n: { $sum: 1 } } }],
      topWords: [{ $group: { _id: '$word', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }],
      dailyCounts: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, n: { $sum: 1 } } }],
      uniqueIps: [{ $group: { _id: '$ip' } }, { $count: 'n' }],
  } },
])
```

`dailyCounts` is zero-filled in application code for any date in `[today - windowDays,
today]` with no matching group, so the frontend's day-by-day list never has silent gaps.

---

## 8. Frontend

### 8.1 New route

```
/admin/activity        Activity — summary cards + top words + raw log
```

Added to `src/pages/admin/index.tsx`'s `<Routes>` and `AdminLayout.tsx`'s nav
(`Overview · Providers · Latency lab · Playground · Entries · Reports · Activity ·
Audit log`).

### 8.2 Page layout

```
┌ Activity ──────────────────────────────────────────────────────────┐
│ Window: [7 days ▾]                                    [Refresh]     │
├───────────────────────────────────────────────────────────────────  │
│  Total lookups   Unique IPs   Cache   LLM   Dictionary               │
│      1,204            310      812    301      91                   │
├───────────────────────────────────────────────────────────────────  │
│ Top words                     │ By channel      │ By device          │
│ serendipity        42         │ web       1,050  │ desktop    780    │
│ ephemeral          31         │ extension   154  │ mobile     390    │
│ ...                           │                  │ bot         34    │
├───────────────────────────────────────────────────────────────────  │
│ Daily lookups (last 7 days) — simple bar list, no charting lib       │
├───────────────────────────────────────────────────────────────────  │
│ Recent lookups                                                        │
│ 2026-07-19 10:02  serendipity  en→en  cache  desktop/Chrome  web  12ms│
│ ...                                                    [Load more]    │
└───────────────────────────────────────────────────────────────────── │
```

Reuses existing primitives verbatim: `Stat` (`Overview.tsx`), `.admin-table` (plain
`<table>`, no new CSS component needed beyond a couple of small layout rules), the
`Audit.tsx` cursor `[Load more]` pattern for the raw log.

### 8.3 New files

```
server/util/userAgent.ts          # parseUserAgent() — pure, unit-tested
server/util/userAgent.test.ts
server/activityLog.ts             # recordActivity(), classifyChannel(), parseActivityQuery(), listActivity(), getActivitySummary()
server/activityLog.test.ts        # pure-function unit tests
server/admin/router.ts            # + GET /activity, GET /activity/summary (existing file, extended)
src/api/admin.ts                  # + ActivityLogView / ActivitySummary types + listActivity()/getActivitySummary() (existing file, extended)
src/pages/admin/Activity.tsx      # new page
src/pages/admin/AdminLayout.tsx   # + nav link (existing file, extended)
src/pages/admin/index.tsx         # + <Route path="activity" .../> (existing file, extended)
src/styles/admin.css              # + a couple of small .admin-activity-* layout rules (existing file, extended)
docs/security.md                  # + one line noting activity_log under the existing admin table + new PII note
docs/README.md                    # + index row for this doc
src/pages/PrivacyPage.tsx          # + one new disclosure paragraph
src/i18n/translations.ts          # + 'privacy.activityP1' (English; other locales fall back automatically)
```

No new env vars.

---

## 9. Privacy & security considerations (delta to `docs/security.md`)

No new trust boundary for the *admin* side — `/api/admin/activity*` sits behind the
same `requireAdmin` allowlist as everything else. The material change is on the
**public** side: `/api/translate/:text` (already public/unauthenticated) now durably
persists per-request data it previously only logged to stdout and discarded.

- **What's newly persisted that wasn't before:** the actual looked-up word (previously
  only `textLength` was logged, explicitly to avoid persisting search terms — see the
  comment in `server/translate.ts`), the client IP, and a coarse device/browser/OS
  summary. This is a deliberate, disclosed product decision (growth analytics), not an
  oversight — reflected in the updated `/privacy` page (§1 goal 5).
- **Data minimization applied:** raw `User-Agent` is never stored, only the three-field
  parsed summary (§3, §5.1); IP is stored raw (not hashed) because a rough
  unique-visitor count needs it, but retention is capped at 180 days (shortest TTL in
  the app) and read access is admin-only.
- **No new data exposure to non-admins** — nothing in this feature is reachable without
  clearing `requireAdmin`, same as Cache Entries/Reports.
- **Injection**: every query parameter is validated the same way as `parseEntriesQuery`/
  `parseAuditQuery` (typed allowlist checks, no raw user input reaches a Mongo filter
  unescaped); `word` filtering on the admin list route is an exact match (not a
  prefix-regex like `/admin/entries`), so there's no regex-DoS surface to consider here
  at all.
- **Volume/cost**: this is a pure Mongo write per public request — no LLM cost, no new
  rate limit needed on the write path (it rides the existing `translateLimiter`, 5
  req/min/IP hard cap). The admin list/summary routes ride the existing 30 rpm/IP
  `adminLimiter`.
- **Retention**: 180-day TTL (§3) — shortest of any collection in this codebase,
  reflecting that this is the most privacy-sensitive, highest-volume data the app
  stores.

---

## 10. Failure modes & edge cases

| Situation | Behavior |
|---|---|
| Mongo down / unavailable | `recordActivity()` no-ops silently (same `getMongoDb()` guard as every other collection access) — a lookup still succeeds and is still served; it's just not logged for that request. |
| `activity_log` write is slow/hangs | Never blocks the response — the insert is fired without `await` in the request handler; a slow write only delays when the doc lands, not the HTTP response. |
| Malformed/missing `User-Agent` header | `parseUserAgent(undefined)` returns `{ type: 'unknown' }` — never throws. |
| Extension traffic vs. web traffic misclassified | Documented limitation (§5.2) — a directional signal, not a precise one; acceptable for a growth dashboard, not used for any billing/security decision. |
| Admin summary query with `days` far in the past (e.g. before this feature shipped) | Just returns zero counts / an empty `dailyCounts` window — no error, no special-casing needed (there is nothing to find before the collection existed). |
| Very high traffic (word goes viral) | `topWords`/`dailyCounts` aggregation is bounded by the `$match` time-window and `$limit: 20` — cost scales with documents *in the window*, not the whole collection; TTL keeps the collection itself bounded long-term. |

---

## 11. Testing strategy

Mirrors the existing admin-module pattern (`docs/design-admin-cache-entries.md` §10):
pure functions unit-tested directly, Mongo I/O functions manually verified (no
`mongodb-memory-server`, consistent with the rest of this codebase).

- **`server/util/userAgent.test.ts`**: `parseUserAgent()` against real UA strings for
  iPhone Safari, Android Chrome, Android tablet, Windows Chrome, Windows Edge, macOS
  Safari, macOS Chrome, Linux Firefox, Googlebot, `curl/8.x`, empty string, `undefined`.
- **`server/activityLog.test.ts`**: `classifyChannel()` (extension origin, web origin,
  no origin, arbitrary third-party origin), `parseActivityQuery()` (defaults, limit
  clamping, `before` parsing, tier/channel/deviceType allowlist validation — mirrors
  `parseAuditQuery`/`parseEntriesQuery`'s existing test style).
- **Manual verification** (Mongo I/O, `recordActivity`/`listActivity`/
  `getActivitySummary`): looked up several words locally, confirmed
  `activity_log` documents appear with correct `word`/`tier`/`ip`/`device`/`channel`;
  confirmed `/admin/activity` renders the summary and raw list against real data;
  confirmed a lookup's response time is unaffected (no added latency from the
  fire-and-forget write).

---

## 12. Rollout plan

Single-phase — this is additive, read-only-admin-side, and the write path fails open
(§10), so there's no reason to split it into read-then-write phases the way Cache
Entries did (that feature's *write* path was a destructive delete; this feature's write
path is an insert nobody can lose sleep over).

### Todo list (implementation checklist)

- [x] `server/db.ts` — `activity_log` collection: TTL index on `ts` (180 days), plus a
      `word` index for the summary aggregation.
- [x] `server/util/userAgent.ts` — `parseUserAgent()`.
- [x] `server/util/userAgent.test.ts` — unit tests.
- [x] `server/activityLog.ts` — `recordActivity()`, `classifyChannel()`,
      `parseActivityQuery()`, `listActivity()`, `getActivitySummary()`.
- [x] `server/activityLog.test.ts` — unit tests for the pure functions.
- [x] `server/translate.ts` — call `recordActivity()` (fire-and-forget) from the
      `/translate/:text` route handler.
- [x] `server/admin/router.ts` — wire `GET /activity`, `GET /activity/summary`.
- [x] `src/api/admin.ts` — add `ActivityLogView`/`ActivitySummary` types +
      `listActivity()`/`getActivitySummary()` fetch functions.
- [x] `src/pages/admin/Activity.tsx` — page: summary cards, top words, breakdowns,
      daily counts, paginated raw log.
- [x] `src/pages/admin/AdminLayout.tsx` — nav link.
- [x] `src/pages/admin/index.tsx` — route.
- [x] `src/styles/admin.css` — small layout rules for the new page.
- [x] `docs/security.md` — admin-plane table row + PII/retention note.
- [x] `docs/README.md` — index row for this doc.
- [x] `src/pages/PrivacyPage.tsx` + `src/i18n/translations.ts` — disclosure paragraph.
- [x] `npm run typecheck`, `npm test`, `npm run build` all pass.
- [x] Manual verification against the live dev Mongo (§11): rebuilt and redeployed the
      API container locally, looked up `serendipity` (iPhone Safari UA), `ephemeral`
      (Windows Chrome UA + `chrome-extension://` origin), and `hello` (curl UA);
      confirmed `activity_log` gained exactly the expected three documents with correct
      `word`/`tier`/`latencyMs`/`ip`/`channel` (`web`, `extension`, `web`) and `device`
      (`mobile/Safari/iOS`, `desktop/Chrome/Windows`, `bot`); confirmed the `$facet`
      summary aggregation runs against the real collection and returns correct
      `total`/`byTier`/`topWords`/`uniqueIps`. Test documents were deleted afterward so
      they don't pollute real growth data.
- [x] Deploy: `docker compose build api && docker compose up -d api` (backend), then
      `npm run deploy:web` (ships the admin SPA bundle with the new `/admin/activity`
      page).

---

## 13. Future work (explicitly out of scope for v1)

- **Optional identity linkage** — if a future version adds an optional `Authorization`
  header check on `/api/translate/:text` (without *requiring* auth, since the endpoint
  must stay public), `userKey` could be added to correlate lookups with a signed-in
  user's favorites/history for personalized "you looked this up 3 times" features.
- **GeoIP country/region breakdown** — an offline MaxMind GeoLite2 lookup on `ip` at
  write or query time, surfaced as a `byCountry` facet in the summary.
- **Precise channel attribution** — a dedicated `X-Client: extension` header sent only
  by the extension's `lookupClient.ts`, instead of inferring from `Origin` (§5.2).
- **Purge/redact admin action** — a way to delete a specific IP's history on request
  (e.g. a user privacy request) ahead of the 180-day TTL, analogous to Cache Entries'
  delete action but for this collection.
- **Alerting on traffic anomalies** (spike/drop) — out of scope, consistent with the
  admin portal's existing "no alerting infra" non-goal (`docs/design-admin-portal.md`
  §1 non-goals).
