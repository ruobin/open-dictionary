# Design: Geo / IP Load Balancing Across Regional VPS

**Status:** Draft · **Scope:** deployment + edge infra (no API behavior change)
**Goal:** Route each user to the **geographically nearest** open-dictionary
instance (SG / US / EU) so an EU user hits the EU VPS instead of crossing the
Atlantic to SG, cutting end-to-end lookup latency from ~250–350 ms to ~30–60 ms.

---

## 1. Background & motivation

Today the app runs as a single deployment:

```
browser  ──HTTPS──▶  host nginx (TLS, SPA, CSP)  ──/api──▶  Express api (127.0.0.1:3002)  ──▶  local mongo
```

(`docker-compose.yml`: `api` container bound to `127.0.0.1:3002`, `mongo` is
private to the compose network; the SPA is built by `Dockerfile.web` and served
as static files by the same host nginx that owns TLS for
`dict.ai-dictionary.org`.)

There is one origin, in one region. Once a second (and third) VPS is stood up
in EU and US, naively putting all three behind a round-robin DNS or a single
anycast VIP would still send roughly ⅓ of EU users to SG — exactly the latency
penalty we want to avoid. We need **sticky-by-geography** routing: the request's
source IP → region → nearest healthy origin.

The app itself is **already region-agnostic**:

- It is **stateless per request** except for two Mongo collections that matter
  cross-request: `translations` (read-through LLM cache, keyed by
  `word/sourceLang/targetLang/version`) and `favorites` (keyed by Auth0 `sub`
  + word + langs). See `server/db.ts`.
- Identity is the verified Auth0 JWT `sub` (never a client header), so the same
  user can land on a different region on each visit without breaking auth.
- The admin portal stores its config in Mongo as singletons
  (`llm_settings`, `llm_providers`); that design doc already calls out a
  multi-instance future (§7 of `design-admin-portal.md`).

So the work here is almost entirely **edge / DNS / data layer**, not application
code.

---

## 2. Target topology

Three regions, one DNS name, three independent stacks:

```
                        ┌──────────────────────────┐
                        │   dict.ai-dictionary.org  │   A/AAAA records
                        │   (geo-aware DNS layer)   │   returned per EDNS
                        └────────────┬─────────────┘
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        ┌──────────┐            ┌──────────┐            ┌──────────┐
        │ SG VPS   │            │ EU VPS   │            │ US VPS   │
        │ (APAC)   │            │ (EU)     │            │ (NA)     │
        │          │            │          │            │          │
        │ nginx +  │            │ nginx +  │            │ nginx +  │
        │ api +    │            │ api +    │            │ api +    │
        │ mongo    │            │ mongo    │            │ mongo    │
        └──────────┘            └──────────┘            └──────────┘
              │                      │                      │
              └──────────► replicated cache (§6) ◄──────────┘
```

Each VPS is **identical in shape** to today's single-host stack
(`docker-compose.yml` unchanged in structure): nginx owns TLS + serves the SPA,
`api` container binds `127.0.0.1:3002`, `mongo` is private. The new things are:

1. A **geo-aware DNS / edge tier** in front of all three.
2. **Replication** of the `translations` and `favorites` collections so a user
   sees the same cache and favorites no matter which region answers.
3. **Per-region health checks** so a dead region is removed from DNS.

---

## 3. Routing strategies considered

| Option | How it routes | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Geo DNS only** (Cloudflare free/pro, NS1, Route 53 geolocation) | EDNS Client Subnet → continent/country → nearest A record | Cheap, no app change, no extra hop, survives region outage if health-checked | Coarse (metro-level only if EDNS supported); stale on resolver-level caching (~TTL-bound) | **Primary** |
| **B. Anycast + BGP** | Same IP advertised from all regions; BGP picks topology-nearest | Truly nearest by network, automatic failover | Requires ASN + IP space + BGP peering — out of scope for 3 VPS | Rejected |
| **C. Global HTTP reverse proxy / CDN** (Cloudflare proxied, Fastly, Fly Proxy) | Single anycast IP terminates TLS near the user, forwards to nearest healthy origin | Best UX (TLS hand-shake local), DDoS protection, can also serve the SPA statically from the edge | Adds one network hop for `/api`; the SPA's strict CSP + Auth0 connect-src already assume one origin (works fine); per-request cost if not on free tier | **Recommended for SPA**, see §4.2 |
| **D. Application-level redirect** (api responds 307 to `eu.dict…`) | Server reads `X-Forwarded-For`, geoip-lookups, redirects | Most accurate (real client IP) | Adds a round-trip (the thing we're trying to remove); CORS/Auth0 audience must allow all region hostnames | Rejected |
| **E. Client-side region selection** | JS probes latency to each region, picks one | No infra | Re-invents load balancing in the browser; breaks cacheability of the SPA; Auth0 callback URLs balloon | Rejected |

**Decision:** combine **A + C**:

- The **SPA is served through a CDN / proxy edge** (Cloudflare in proxy mode, or
  any CDN) so HTML + static assets are cached at the user's nearest POP — zero
  origin round-trip for the page itself.
- The **`/api/*` path** is routed via the **geo DNS layer** to the nearest
  *healthy* VPS origin (one network hop from the CDN POP to the origin).

This split matters: we do **not** want every `/api/translate` call to bounce
through a single global proxy (that re-centralizes latency). Geo DNS lets the
browser open the API socket directly to the regional VPS.

---

## 4. Routing design (detailed)

### 4.1 DNS layer

Use a geo-aware DNS provider. Concrete options that fit a 3-VPS hobby/small
project budget:

- **Cloudflare DNS (free)** — supports *geo steering* if you also use it for the
  CDN, plus per-continent A records. No per-query cost.
- **AWS Route 53** — geolocation routing policy, ~$0.50 per million queries +
  $0.50/health-check/month. Most mature health-check story.
- **NS1 / DNSimple** — better-programmable, pricier.

Records:

```
dict.ai-dictionary.org.   CNAME  →  geo-steering record set
  ├── continent AS → SG VPS IP        (covers SG, HK, JP, KR, IN, AU/NZ, ID, …)
  ├── continent EU → EU VPS IP        (covers UK, DE, FR, …, MENA)
  ├── continent NA → US VPS IP        (US, CA, MX)
  └── default     → SG VPS IP         (APAC is the existing/primary region)
```

Why continent granularity and not country:

- DNS geo is reliable at continent level everywhere; country-level depends on
  EDNS Client Subnet adoption, which Google/Cloudflare public resolvers support
  but many ISP resolvers do not.
- Latency differences *within* a continent are small relative to the
  inter-continent gap we're trying to close.

### 4.2 SPA / static assets

The SPA itself (`dist/`) is content-addressed (Vite hashes asset filenames) and
already served with `Cache-Control: public, immutable` on `/assets/`
(`nginx.conf`). Two viable models:

1. **Each VPS serves its own copy of `dist/`** behind the geo DNS — simplest,
   no new vendor, but a user in a region with no VPS still crosses an ocean for
   the HTML.
2. **Put `dist/` on a CDN** (Cloudflare, Bunny, etc.) with origin = any VPS;
   the HTML+JS are then served from a POP next to the user. Recommended.

Either way the SPA build is unchanged — `Dockerfile.web` and `nginx.conf` keep
working as-is.

### 4.3 Per-region health checks

Geo DNS alone does not fail over; the DNS provider must health-check each origin
and pull a sick region out of its bucket. Configure the DNS provider's
health-check probe to hit:

```
GET https://sg.dict.example/health   (and eu., us.)
```

The `/health` route already exists (`nginx.conf` proxies it to
`api:3001/health`). Mark a region down on **3 consecutive failures @ 10 s
intervals**. On failover, the DNS layer re-routes the affected continent's
traffic to the **next-nearest** region (e.g. EU down → EU traffic falls to US).

### 4.4 What the app sees

Each regional nginx already sets
`X-Forwarded-For`/`X-Real-IP` (`nginx.conf`), and the API already reads
`TRUST_PROXY=1` (`docker-compose.yml`). No code change needed — but we *should*
add one small thing: log the **serving region** in structured logs (§7) so we
can later verify routing is correct.

---

## 5. Per-region deployment (identical shape, region-tagged)

On each VPS, deploy the existing stack unchanged:

```bash
docker compose build api
docker compose up -d
```

Add **one new env var** to each region's `server/.env` so the API knows which
region it is serving (used in §6 replication tags and §7 observability):

```bash
# SG VPS
INSTANCE_REGION=sg

# EU VPS
INSTANCE_REGION=eu

# US VPS
INSTANCE_REGION=us
```

`server/config.ts` reads it with a sane default. It is purely informational —
the API's behavior does not depend on it.

The host nginx per VPS adds a `SERVER_NAME` per region and reuses the same
`nginx.conf` block (already `server_name _;`). The TLS cert must cover
`dict.ai-dictionary.org` (and any per-region debug hostname) — a single
Let's-Encrypt cert with SANs, or wildcard, replicated to each VPS.

---

## 6. Data layer: shared or replicated?

This is the most important decision in the doc. Two collections matter:

| Collection | Reads | Writes | Consistency need |
|---|---|---|---|
| `translations` (LLM cache) | every lookup | only on cache miss | **Eventual is fine** — worst case a region re-asks the LLM once |
| `favorites` | on every favorites list | on every add/remove | **Strong per-user** — a user adding a favorite in EU must see it from US seconds later |

### 6.1 Options

**(a) Independent Mongo per region, no replication.**
- Simplest. Each region builds its own cache from scratch.
- **Favorites and history break**: a user who favorited on SG (because their
  resolver sent them there last week) won't see the favorite when routed to EU
  today. **Unacceptable** for an authenticated product.

**(b) Single managed Mongo (Atlas) in one region, all VPS connect to it.**
- One source of truth; favorites/history consistent globally.
- **Reintroduces the latency we just removed**: every EU cache read pays a
  cross-continent round-trip to APAC (or wherever the cluster lives). Cache-hit
  lookups dominate traffic, so this defeats the whole exercise.

**(c) MongoDB Replica Set across the three VPS.** ← **Recommended**
- One logical replica set, three members (sg, eu, us). Each VPS's `api`
  connects to its **local** `mongo` (`mongodb://mongo:27017` — unchanged from
  today's `docker-compose.yml`).
- Writes (favorites add/remove, cache-miss inserts, admin-portal config
  changes) propagate asynchronously via oplog replication.
- Cache reads stay local (~sub-ms) → low latency preserved.
- Favorites/history converge globally in **oplog replication lag** (typically
  <1 s over decent links; worst case a few seconds across long-haul links).

**(d) Read-from-local, write-through to a primary + per-region cache.**
- More moving parts, no real benefit over (c) at this scale.

### 6.2 Decision: replica set across the three VPS

Topology:

```
                   MongoDB Replica Set: rs0
   ┌──────────────────┬──────────────────┬──────────────────┐
   │  sg-mongo (P)    │  eu-mongo (S)    │  us-mongo (S)    │
   │  priority 2      │  priority 1      │  priority 1      │
   └──────────────────┴──────────────────┴──────────────────┘
```

- **SG is primary** today (existing data, APAC is the largest user base, and
  it's the default region in §4.1). Set `priority` higher so it wins elections.
- **EU and US are secondaries** with `priority 1` so they can be promoted if SG
  goes down.
- All three `api` containers connect to their local `mongo` **with a replica-set
  URI** so the driver knows the full topology and can fail over:

  ```bash
  MONGODB_URI=mongodb://mongo:27017/?replicaSet=rs0
  ```

  (`mongo` is still the compose-internal hostname on each VPS; the driver
  discovers the other members via the replica-set hello response. The members
  must be reachable from each other over the network — see §8.)

### 6.3 Read preference & write concern

Tune the Mongo driver per query type:

| Operation | readPreference | writeConcern |
|---|---|---|
| `translations` cache read | `secondaryPreferred` (or `nearest`) | n/a |
| `translations` insert (cache miss) | n/a | `{ w: 1 }` — local primary ack only; eventual replication is fine, the entry is immutable |
| `favorites` write | n/a | `{ w: "majority" }` — survives a primary failover without losing the favorite |
| `favorites` read | `primary` | n/a — a user must see their own latest writes |
| admin-portal `llm_settings`/`llm_providers` write | n/a | `{ w: "majority" }` |
| admin-portal reads | `primary` | n/a |

Reading favorites from `primary` adds one network hop for EU/US users when they
open their favorites list — acceptable because (i) favorites reads are far less
frequent than lookups, (ii) the data set is tiny, and (iii) the alternative
(serving a stale favorite list) is worse UX. The cache (the hot path) stays
local.

This requires **a small code change**: pass a `readPreference` per operation in
`server/favorites.ts`, `server/cache/translationCache.ts`, and the admin-portal
repos. Mongo's Node driver supports this as a per-call option — no query
re-writes, just an options object.

### 6.4 What about Auth0 user history?

History lives in Auth0 `user_metadata` (`/api/user-data`), not Mongo. Auth0 is
already a global service, so history is consistent across regions for free — no
work here.

---

## 7. Observability

Per-region visibility is essential; otherwise we can't tell whether geo routing
is even working.

### 7.1 Logs

Add a structured-log field `region=$INSTANCE_REGION` to every API log line
(cheap, ~3 lines in `server/app.ts` request logging). Lets us grep per region
once logs are aggregated.

### 7.2 Health

Each region already exposes `/health`. The geo DNS provider's health checks hit
it (§4.3). Add a simple **status page** (could be the existing admin portal's
Overview page, `docs/design-admin-portal.md` §10) that polls all three regions'
`/health` and shows green/red per region — useful during incidents.

### 7.3 Latency verification

The admin portal already has a **Latency Lab** (`docs/design-admin-portal.md`
§4) that benchmarks LLM providers. We can re-use the same job-runner pattern to
periodically measure **origin-to-edge latency from each region** to a fixed
target (e.g. a Cloudflare-probe endpoint), giving us a chart of whether EU is
actually winning for EU users. Deferred to a follow-up — the geo DNS provider's
own analytics usually suffice at first.

### 7.4 Routing correctness spot-check

Before going live: from a VPN/remote probe in each of APAC/EU/NA, `dig
dict.ai-dictionary.org` and confirm the returned A record points to the right
VPS. Repeat after the TTL expires to make sure DNS failover (§4.3) actually
works.

---

## 8. Cross-VPS networking

The three `mongod` processes must talk to each other for replication. Public
internet exposure of Mongo is a non-starter; use a **meshed private network**:

- **Tailscale / WireGuard mesh** between the three VPS (recommended — Tailscale
  in particular makes a 3-node mesh near-zero-config). Each Mongo listens on
  its private interface; the replica-set members address each other by
  Tailscale hostname (`sg-mongo`, `eu-mongo`, `us-mongo`).
- **TLS** on the replication connection (`net.tls.mode: preferTLS`) even inside
  the mesh — defense in depth.
- **Auth**: enable Mongo auth (`--auth`), create a `replSet` user with
  `clusterMonitor` + read/write on `open-dictionary`. Required for any
  internet-adjacent Mongo and *mandatory* once members are networked together.

This mirrors the project's existing security posture (`docs/security.md`:
"enable MongoDB auth for shared hosts").

The existing `docker-compose.yml` publishes Mongo **only to the compose
network** (no `ports:` mapping on `mongo`). To join the replica set we either:

1. Run a second `mongod` directly on each VPS host (outside compose) bound to
   the Tailscale interface, and point `api` at it; or
2. Add a `ports:` mapping on `mongo` bound to the Tailscale interface only
   (`<tailscale-ip>:27017:27017`) and join that.

Option 1 keeps the existing "mongo not published" invariant cleanly; option 2
is a smaller diff. Either works; pick by operational taste.

---

## 9. Security review (delta vs. `docs/security.md`)

| Concern | Status quo (single region) | Multi-region delta |
|---|---|---|
| TLS termination | host nginx, HSTS | Same on each VPS; cert (Let's Encrypt w/ SANs, or wildcard) replicated |
| Mongo exposure | private to compose net | Private mesh (Tailscale/WG), TLS, auth — see §8 |
| Auth0 audience | one audience | Unchanged — same audience works from every region |
| CORS allowlist | `ALLOWED_ORIGINS` | Add the regional hostnames if per-region subdomains are exposed (only needed if we keep `eu.dict…` debug hostnames; if all regions answer `dict.ai-dictionary.org` via geo DNS, **no CORS change**) |
| CSP `connect-src` | `'self'` + Auth0 domain | Unchanged — the SPA only ever talks to its own origin, which is always `dict.ai-dictionary.org` regardless of which VPS answers |
| Rate limits | per-IP, in-process (`express-rate-limit`) | Now per-region, in-process. A user hitting multiple regions across requests gets N× the limit; acceptable at this scale, revisit if abused |
| Admin portal | `ADMIN_USER_IDS` allowlist | Works unchanged — admin config now replicates via Mongo (§6), so an admin change on any region propagates to all |

One **new** risk: a DNS-level attacker who can poison the geo records could
send victims to an attacker-controlled origin. Mitigated by: HSTS (already on,
`nginx.conf` line 14), Cert Transparency monitoring, and using a reputable DNS
provider with DNSSEC.

---

## 10. Phased rollout

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Wire the mesh** | Tailscale between the 3 VPS; each VPS runs the existing `docker-compose.yml` independently; no replication yet, no geo DNS | All three answer `https://<region>.dict…/health` green |
| **1. Replica set** | Convert the three local Mongos into a 3-member replica set with SG primary; switch `MONGODB_URI` to the RS URI; deploy the per-operation `readPreference` changes (§6.3) | A favorite added in EU appears in SG within replication lag; cache miss in one region eventually fills the others |
| **2. Geo DNS + health checks** | Cut `dict.ai-dictionary.org` over to geo-steering records; configure per-region health probes (§4.3) | `dig` from APAC/EU/NA probes returns the right VPS; simulated region-down pulls it from rotation |
| **3. SPA on CDN** (optional) | Move `dist/` to a CDN in front of any VPS as origin | HTML/JS served from a POP next to the user; origin `/api` still served by geo DNS |
| **4. Verify & tune** | One week of logs with the `region=` field; confirm EU traffic is dominated by EU users, p50 lookup latency in EU drops to <100 ms | Latency dashboard shows the expected regional improvement; failover drill passes |

Each phase is independently reversible — phase 1 with replication disabled falls
back to phase 0, phase 2 with DNS reverted falls back to single-region. No
application code is rewritten at any phase; the only code changes are the
`readPreference`/`writeConcern` options in §6.3 and the optional log field in §7.

---

## 11. Alternatives we explicitly rejected

- **Single global Mongo (Atlas)** — reintroduces cross-continent latency on the
  hot path. Rejected (§6.1b).
- **BGP anycast** — requires our own ASN + IP space. Out of scope for 3 VPS.
  Rejected (§3B).
- **Server-side 307 redirect to per-region subdomain** — adds a round-trip per
  session and complicates Auth0 callback URLs. Rejected (§3D).
- **Edge-side LLM fan-out / running the API at the CDN** — would duplicate the
  LLM-tier logic at the edge; the cache wouldn't be shared cleanly; and the LLM
  vendor (DeepSeek etc.) is itself region-pinned. Rejected.
- **Application-level multi-tenancy / sharding Mongo by user region** — shards
  the favorites data so each region "owns" some users. Eliminates cross-region
  replication but breaks the "any region can serve any user" property that
  makes failover trivial. Premature for the scale here.

---

## 12. Open questions

1. **DNS provider choice.** Cloudflare (free, also the CDN) vs. Route 53 (best
   health-check story). Decision can wait until phase 2.
2. **Per-region debug subdomains?** (`eu.dict.ai-dictionary.org` etc.) Useful
   for ops, slightly increases CORS/Auth0-callback surface. Lean: yes, behind
   `ALLOWED_ORIGINS`.
3. **Atlas vs. self-hosted replica set.** Atlas has a global cluster offering
   that would replace §6/§8 entirely, at managed-DB pricing. Worth pricing out
   before committing to self-hosted replication across consumer VPS links.
4. **`more_examples` (90 d TTL) and `reports` collections** — also part of the
   replica set; no special treatment needed but call out in the migration
   runbook.

---

## 13. Summary of code/config changes

| Area | Change | Size |
|---|---|---|
| `server/config.ts` | read `INSTANCE_REGION` env var | ~3 lines |
| `server/app.ts` | include `region` in request log fields | ~3 lines |
| `server/favorites.ts` | `readPreference: 'primary'`, `writeConcern: { w: 'majority' }` on writes | ~5 lines |
| `server/cache/translationCache.ts` | `readPreference: 'nearest'` on reads | ~2 lines |
| `server/admin/*Repo.ts` | `primary` reads, `majority` writes | ~5 lines |
| `docker-compose.yml` | `MONGODB_URI` becomes the RS URI; (optionally) expose `mongo` to the Tailscale interface | ~3 lines |
| `nginx.conf` | no change (works as-is per region) | 0 |
| `Dockerfile` / `Dockerfile.web` | no change | 0 |
| DNS provider | new geo-steering records + health checks | config |
| Each VPS host | Tailscale, Mongo auth, cert with SANs | ops |

**No frontend changes. No LLM-tier changes. No Auth0-flow changes.** The
existing app's statelessness (per-request identity from the JWT `sub`, no
server-side sessions, no client-IP-coupled behavior) is what makes this
clean — geo load balancing is purely an edge + data-layer concern.

---

## 14. Review notes (added 2026-07-14)

Overall the design is sound: continent-level geo DNS + a cross-region replica
set is the right shape for a 3-VPS budget, and the per-operation
read-preference table in §6.3 is exactly the right level of nuance. The points
below are gaps or inaccuracies found on review, roughly ordered by severity.

### 14.1 ⚠️ The "A + C" split in §3 is contradictory on a single hostname

§3 decides: SPA via CDN proxy, `/api/*` via geo DNS **on the same hostname**
(`dict.ai-dictionary.org`). That is not possible — DNS resolves a hostname to
either the CDN's anycast IP (proxied) *or* a regional origin IP (geo-steered).
You cannot split by URL path at the DNS layer. Pick one:

- **(i) Everything through Cloudflare proxy** — SPA cached at the POP, `/api`
  forwarded from the POP to the nearest origin. But origin selection by
  proximity requires **Cloudflare Load Balancing (paid add-on)**; without it,
  CF forwards to a single origin IP and we're back to one region for `/api`.
- **(ii) Everything on geo DNS (grey-cloud)** — no CDN for the SPA, but each
  region already serves `dist/` locally (§4.2 model 1) and assets are
  immutable-cached in the browser, so the real cost is only the first visit.
- **(iii) Split hostnames** — `dict.…` (SPA, proxied CDN) +
  `api.dict.…` (geo DNS). Contradicts "no frontend changes": the SPA's API
  base URL, `ALLOWED_ORIGINS` (CORS), and CSP `connect-src` all change.

Recommendation: start with **(ii)** — it matches the "no app change" spirit and
phase 3 stays truly optional. Re-evaluate (i)/(iii) only if TTFB for first-time
visitors becomes a measured problem. §3's decision line should be amended.

### 14.2 ⚠️ Cloudflare geo steering is not free

§4.1 lists "Cloudflare DNS (free) — supports geo steering". Geo steering is
part of **Cloudflare Load Balancing**, a paid feature (from ~$5/mo + per-region
pools). Free-tier CF DNS returns the same records to everyone. Route 53
geolocation policy (~$0.50/M queries + health checks) is likely the *cheapest*
real geo-DNS option here. The cost table should be corrected before phase 2.

### 14.3 ⚠️ The RS URI in §6.2 won't work as written

`mongodb://mongo:27017/?replicaSet=rs0` bootstraps discovery via the local
member, but the driver then **re-connects to all members using the hostnames
stored in the replica-set config** (the Tailscale names, e.g. `sg-mongo`).
Consequences:

- Each `api` container must be able to **resolve and reach the Tailscale
  hostnames of all three members**, not just its local `mongo`. That means
  routing the Tailscale interface into the compose network (or running
  Tailscale in a sidecar / host-network mode) and making the names resolvable
  in-container.
- The rs config hostnames must be the **same names from every region** — use
  the Tailscale MagicDNS names in `rs.initiate()`, never `mongo`.
- Do **not** work around this with `directConnection=true` — that disables
  topology awareness, breaking both failover and `readPreference`.

This is the single biggest operational trap in the design; phase 1 should
include an explicit "driver can see all three members from every region" check.

### 14.4 All writes cross the ocean to the primary (unstated)

§6.3 covers read locality but never states that **every write goes to the SG
primary**, wherever the user is:

- `favorites` add/remove from EU/US: EU→SG RTT + majority ack (~250–350 ms).
  Acceptable (infrequent, user-initiated mutation) but should be documented as
  expected behavior, not a regression.
- `translations` cache-miss insert from EU/US: also crosses to SG. Negligible
  next to the multi-second LLM call it accompanies, but consider making the
  insert fire-and-forget (don't await it in the request path) if it isn't
  already.

### 14.5 Let's Encrypt renewal breaks under geo DNS

§5 says "replicate a single LE cert with SANs to each VPS", but with geo
steering live, an **HTTP-01 challenge** for `dict.ai-dictionary.org` will hit
whichever region is nearest to the LE validation servers (and LE validates
from multiple vantage points) — regions without the challenge token fail
renewal. Switch to **DNS-01 challenges** (provider API token on one renewal
host) and distribute the cert to the three VPS, or terminate TLS at the CDN if
option 14.1(i) is chosen. This must land in phase 2, not as an afterthought at
first renewal +60 days.

### 14.6 Replica-set stability over consumer VPS links

Three-way WAN replication over Tailscale between budget VPS providers will see
latency spikes and brief partitions. Recommendations:

- Monitor **replication lag** explicitly (expose `rs.printSecondaryReplicationInfo()`
  equivalents via the admin portal or node-exporter) and alert at lag > 10 s.
- Tune `settings.electionTimeoutMillis` upward (e.g. 10 s) to avoid flappy
  elections on transient jitter.
- Note the majority-write implication: if SG is partitioned, `favorites` and
  admin writes **stall** until an EU/US election completes; `translations`
  reads keep working everywhere (`nearest`). That's the right trade-off — just
  document it as expected degraded mode.
- Size the **oplog** generously (default 5% of disk may be small on a budget
  VPS) so a member that's offline for hours can catch up without a full resync.

### 14.7 Smaller items

- **Backups** (`scripts/mongodb-backup.sh`): run `mongodump` against a
  **secondary** once the RS exists, and back up from ≥2 regions. Update the
  cron file in the migration runbook (extends open question §12.4).
- **Standalone → RS migration** (phase 1) requires a `mongod` restart with
  `--replSet` + `rs.initiate()`: brief downtime on SG; do it in a maintenance
  window and document rollback (restart without `--replSet`).
- **Initial sync seeding**: EU/US members will initial-sync the full SG data
  set over the WAN. Fine at today's size; for larger data, seed from a
  `mongodump`/restore before joining.
- **`w:1` on cache inserts** (§6.3) can lose an entry on primary failover —
  harmless (cache refills), worth a one-line comment in code so nobody
  "fixes" it to majority later.
- **Health check depth**: `/health` should verify Mongo connectivity, not just
  process liveness — otherwise a region with a wedged local mongo stays in DNS
  rotation while serving 500s.
- **Rate limits** (§9): per-region in-process limits effectively become 3× per
  user. Fine now; if abused, a shared Redis or Mongo-backed limiter is the
  fix — note it so it's a known trade-off.
