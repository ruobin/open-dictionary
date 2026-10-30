# LLM abuse guard & client attribution

Status: **shipped 2026-10-30.** Covers how the API stops clients from running
up LLM token spend, the admin **Clients** page, and the **Added by** info on
the admin **Entries** page.

Code: `server/abuseGuard.ts`, `server/admin/clients.ts`,
`server/activityLog.ts` (`buildEntryCreator`, `uaForStorage`,
`expireEntryCreatorIps`), `server/cache/translationCache.ts` (`createdBy`),
`src/pages/admin/Clients.tsx`, `src/components/admin/EntryRow.tsx`,
`scripts/backfill-entry-creators.ts`. Host config: `/etc/nginx/conf.d/api-bot-block.conf`
(see `/root/ops/nginx/README.md` on the prod host).

---

## 1. Incident (2026-10-29 / 30)

LLM token usage jumped starting around 13:00 UTC on 10-29 and stayed high
overnight. The cause was **OpenAI's GPTBot** (`74.7.227.41`, UA
`…compatible; GPTBot/1.4; +https://openai.com/gptbot`):

1. It fetched `/word/<w>` pages and **executed the SPA**, which calls
   `/api/translate/<w>` and `/api/translate-stream/<w>`.
2. Prerendered pages link to related words (synonyms, phrases). About 21.6k of
   the ~22.6k linked words had no cache entry. For those, nginx served the SPA
   shell, and its API call was a cache miss, i.e. **one paid LLM call per page**
   (fusion mode called two providers per miss).
3. It sent about 9 req/min to the two translate routes, which share a 5 req/min
   per-IP limiter. About 5 got through each minute (the rest got 429): roughly
   300 LLM calls/hour and ~2.4k in the 28 h before mitigation. The cache grew
   from ~1.4k to ~3.9k en→en words in that time.

**The per-minute limits bounded the rate but not the daily total.** A client
that stays just under the RPM cap can still spend all day.

## 2. Defense layers

| Layer | Where | Effect |
|---|---|---|
| `robots.txt` `Disallow: /api/` | `public/robots.txt` | Compliant crawlers' renderers don't call the API. |
| nginx crawler block on `/api/` | `conf.d/api-bot-block.conf` → `$api_bot_block`; `if (...) return 403` in both vhosts' `location /api/` | Known crawler UAs get 403 before reaching Node. |
| nginx `/word/*` 404 for crawlers | `$word_fallback` map; `location /word/ { try_files $uri $uri/ $word_fallback; }` | Prerendered SEO pages stay crawlable. A **word with no prerendered page** gets 404 instead of the SPA shell, so crawlers can't find uncached words. Humans are unaffected. |
| App bot refusal | `llmGuard` on `/translate`, `/translate-stream`, `/more-examples` | Self-identified bots/scripts (`parseUserAgent().type === 'bot'`: GPTBot, curl, python-requests, …) get 403. This still holds if nginx config is lost or the API is reached another way. Toggle with `LLM_BLOCK_BOTS`. |
| **Daily LLM budget per IP** | `LlmBudget` (rolling 24 h, hourly buckets, in-memory) | After `LLM_DAILY_BUDGET_PER_IP` paid LLM calls (default 300), a client still gets **cache hits and in-flight joins**, but cache misses get `429 {error:'rate_limited', reason:'daily_llm_budget'}` + `Retry-After: 3600`. Catches spammers that fake browser UAs. |
| Admin blocklist | Mongo `blocked_clients` + `blocklistGuard` on `/api` | IPs/CIDRs get `403 {error:'blocked'}` on every public `/api` route. `/api/admin/*` is exempt, and an admin can't block their own IP. |
| Per-minute limiters | existing `express-rate-limit` | Unchanged (5 rpm on LLM routes). |

### Design decisions

- **Over-budget clients get 429 on a miss, not a dictionary fallback.** Passing
  `llm = null` would serve the free dictionary tier, but `doTranslate` caches
  that result for a year, which would lower quality for every later user. The
  over-budget path checks `canServeWithoutLlm()` (in flight, or a cache hit)
  first, so this extra cache read happens only for over-budget clients.
- **Budget counts actual LLM outcomes** (`tier === 'llm'`), not requests. Cache
  hits are free and don't count. An in-flight joiner can be counted too (small
  overcount, accepted).
- **Budget state is in-process.** It resets when the API restarts, which is
  fine for the single-container deployment. For multiple replicas, move it to
  Mongo/Redis.
- **Blocklist** uses `node:net` `BlockList` (IPv4/IPv6, CIDR). Prefixes
  broader than /8 (v4) or /16 (v6) are rejected. Changes take effect at once on
  the instance that made them; others refresh lazily every 30 s. Timed blocks
  set `expiresAt` (TTL index removes them).
- **Client IP** comes from `req.ip` with `TRUST_PROXY=1`, i.e. the rightmost
  `X-Forwarded-For` hop, which host nginx sets from the PROXY-protocol real IP.
  A client-supplied XFF is ignored. **Every vhost that proxies `/api/` must
  send `X-Forwarded-For`.** During this incident `ai-dictionary.org` didn't,
  so all its visitors looked like the docker gateway `172.21.0.1`: they shared
  one rate limit and budget and couldn't be blocked individually.

## 3. Detection & display: admin **Clients** page (`/admin/clients`)

`GET /api/admin/clients?hours=1|24|168` aggregates `activity_log` by IP
(index `activity_log_ip_ts`) and merges in live budget counters and blocklist
status. Columns: paid LLM calls, total lookups, distinct words, rate per hour,
live budget usage, last seen, device type, and (bots only) the user-agent.

Flags: `bot-ua`, `over-budget`, `near-budget` (≥ 50 %), `high-rate`
(≥ 60/h sustained over ≥ 20 lookups), `blocked`. A banner lists suspicious,
unblocked IPs. Each row has **Entries** (jumps to `/admin/entries?ip=…`) and
**Block/Unblock**. The blocklist section adds IPs/CIDRs manually, permanently
or for N hours.

Admin API: `GET /api/admin/blocklist`, `POST /api/admin/blocklist
{target, reason?, hours?}`, `DELETE /api/admin/blocklist/:target`
(URL-encode CIDRs). Audit actions: `client.block`, `client.unblock`.

Quick log check on the host (no admin login needed):

```bash
grep /api/translate /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
```

## 4. Attribution: Entries page **Added by**

Each cache doc (`translations`) gets `createdBy` = the client whose lookup
**generated** it, i.e. who paid for that LLM call:

```ts
createdBy?: { ip?: string; ua?: string; device: {type, browser?, os?}; channel: string; at: Date; inferred?: boolean }
```

- Written through `$setOnInsert`, so later rewrites (late audio, fusion
  upgrade) never overwrite it. For in-flight dedup, the lookup that started the
  generation is the creator.
- The Entries list has an **Added by** column (IP, device, `bot` badge, UA on
  hover). Click an IP to filter by it (`?ip=`, index
  `translations_created_by_ip`). The detail drawer shows the full record.
- **Older entries** were backfilled from `activity_log` by
  `scripts/backfill-entry-creators.ts` and marked `inferred: true`. It uses the
  most recent `llm`/`dictionary`-tier activity record for the same
  (word, langs) no later than `fetchedAt + 5 min`. Entries with no matching
  activity in the last 180 days stay "unknown".

```bash
# prod (needs the compose-network Mongo); dry run first, then --apply
docker compose run --rm --no-deps -v "$PWD/scripts:/app/scripts" api \
  node --import tsx scripts/backfill-entry-creators.ts [--apply]
```

## 5. Privacy

The published policy (`privacy.activityP1`, en/zh/ja/es) promises that a
person's raw browser identifier is never stored and that IP data is kept at
most 180 days. Therefore:

- **Raw User-Agent is stored only for self-identified bots/scripts**
  (`uaForStorage()`): in `activity_log.ua` and `createdBy.ua`. People get only
  the parsed device summary. (Human UAs logged during the first deploy on
  2026-10-30 were removed.)
- **Creator IPs expire after 180 days.** Cache entries live for up to 1 year,
  so `expireEntryCreatorIps()` runs at API boot and daily, removing
  `createdBy.ip`/`ua` from entries created more than 180 days ago while keeping
  device/channel/time. The UI shows "IP expired".
- The policy text now also mentions abuse prevention, bot user-agents, and
  the 180-day creator IP.

## 6. Configuration

| Env (`server/.env`) | Default | Meaning |
|---|---|---|
| `LLM_DAILY_BUDGET_PER_IP` | `300` | Paid LLM calls per IP per rolling 24 h; `0` disables the cap. Raise it if many users share a NAT/office IP. |
| `LLM_BLOCK_BOTS` | `1` | `0` lets self-identified bots/scripts (including `curl`) use LLM routes, e.g. for manual testing. |

## 7. Known limits / follow-ups

- Rotating residential IPs with browser UAs evade per-IP budgets. The next
  step would be a **global** daily LLM budget (circuit breaker) with an admin
  alert.
- Budget counters are lost on restart (at most one extra day of budget per IP).
- The nginx crawler list is UA-based. Crawlers that fake a browser UA are
  handled only by the app budget and the blocklist.
