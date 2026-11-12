# Design: LLM usage tiers, quotas & paid credits

**Status:** quotas & usage implemented (2026-11-12, not yet deployed) · payments and credits deferred · **Proposed:** 2026-11-12 · **Decided:** 2026-11-12 (§13) · **As built:** §15
**Checklist:** [`to-do-llm-usage-quotas.md`](./to-do-llm-usage-quotas.md)
**Builds on:** [`design-llm-abuse-guard.md`](./design-llm-abuse-guard.md). Its bot refusal, IP
blocklist, per-minute limits and nginx crawler layers all stay. This doc adds *who* is asking,
*which model* answers them, and *who pays* for it.

---

## 0. Summary

Only **generations** cost money: looking up a word that isn't in the dictionary yet (a cache miss
the LLM answers), or an uncached "more examples" batch. Cache hits, in-flight joins, browse,
suggest, word of the day and the prerendered SEO pages stay free and unlimited for everyone.

| | Owner (you) | Signed in, verified email | Signed in, email not verified | Anonymous |
|---|---|---|---|---|
| Identified by | Auth0 `sub` in `ADMIN_USER_IDS` | valid Auth0 token, and the Auth0 profile says `email_verified` | valid Auth0 token | no token or an invalid one; keyed by IP (IPv6 by /64) |
| Model for new words | your full setup (fusion when configured) | one model (the *metered model*) | the metered model | the metered model |
| Free new words | unlimited | 20 per UTC day | the anonymous allowance of their IP | 5 per IP per UTC day, within the anonymous share of the day's free budget |
| Credits | not needed | can buy and spend | can spend granted credits; must verify to buy | sign in to buy |
| Paused when the free budget runs out | never | free words yes, credits no | free words yes, credits no | yes |

- **Free budget: $1.00 a day and $5.00 a month** for all free usage combined, however many IPs or
  accounts it comes from. The monthly cap is the one that binds ($1 × 30 days is far more than $5),
  so the budget is **paced**: today's budget = min($1.00, what's left of the month ÷ days left).
  That is about $0.17 a day at the start of a month, and more when earlier days were quiet (§4.3).
- **Strangers get one model; you keep fusion.** A stranger's entry becomes the shared cached entry
  for that word, so you get an owner-only **Regenerate** on the word page (§4.4).
- **Credits:** 1 credit = 1 new word or 1 "more examples" batch. Users see credits. You see dollars:
  each generation's real token usage × the per-model price you set in the admin portal.
- **Top-ups:** prepaid credit packs through hosted Stripe Checkout, with Stripe as merchant of
  record (Managed Payments), so Stripe collects and files sales tax and VAT. Credits are granted
  from a signed webhook exactly once. Refunds and disputes claw credits back (§6).
- **Over a limit:** a cache miss gets `429 quota_exceeded` with a reason and next steps (sign in,
  verify email, top up, wait). It never falls back to the dictionary tier, because that result
  would be cached for a year.
- **Rollout:** 0 measure in shadow mode → 1 extension release → 2 route and enforce → 3 payments
  → 4 tune (§10). The step-by-step checklist is in the to-do doc.

**What $5 a month buys.** Prices are illustrative (§5.5); the metered model's price sets the size of
every slice:

| Metered model class | Cost per new word | Free new words per month | Per day at the start of a month (paced) |
|---|---|---|---|
| Budget ($0.30 / $1.20 per M tokens) | ≈ $0.002 | ≈ 2,500 | ≈ 80 |
| Mid ($1 / $4 per M) | ≈ $0.006 | ≈ 830 | ≈ 28 |
| Frontier ($3 / $15 per M) | ≈ $0.022 | ≈ 230 | ≈ 7 |

Choose a budget-class metered model. The allowances only decide how the budget is shared out.

---

## 1. Problem

Every cache miss on `/api/translate[-stream]/:text` and `/api/more-examples` is a paid LLM call,
and both routes are public and unauthenticated. One lookup is two parallel calls (core + extras,
`server/providers/llm/translateFlow.ts`). With fusion on, it is five: both providers × core/extras,
plus a background `fuse()` merge. That is roughly 3–4× the tokens.

The abuse guard caps one misbehaving client at `LLM_DAILY_BUDGET_PER_IP` (300 paid calls per IP per
day). That is not what the owner needs:

- **It is per IP.** N IPs get N × 300 calls a day. Its own follow-ups (§7 there) name a global
  budget as the missing piece.
- **It can't tell the owner from a stranger.** You get the same 5 rpm and 300/day as GPTBot did.
- **It counts calls, not money.** One fusion lookup on a frontier model costs about 40× a single
  lookup on a budget model (§5.5).
- **It lives in memory.** It resets on restart and won't work across the multi-region plan
  ([`design-geo-load-balancing.md`](./design-geo-load-balancing.md)).
- **There is no "more".** Someone who wants to use the app a lot has no way to pay for it.

## 2. Goals / non-goals

**Goals**

1. **Owner: unlimited and frictionless** on the web app and the extension, with the full model
   setup and no 5 rpm limiter.
2. **A hard dollar ceiling on free usage by others:** $1 per day and $5 per month, however many
   IPs or accounts.
3. **Anonymous visitors can still add new words** without signing in, a few a day.
4. **A path to more:** verify your email for a bigger daily allowance, buy credits, or get credits
   granted by the admin.
5. **Real, safe payments:** hosted checkout, credits granted exactly once, refunds and disputes
   handled, sales tax handled by a merchant of record.
6. **Cached content stays free and unlimited** for everyone. SEO pages, word of the day, browse and
   suggest are unchanged.
7. **No damage to the shared cache.** A denied request never writes a degraded entry, and the owner
   can upgrade an entry that a stranger's cheaper model wrote.

**Non-goals:** subscriptions; ads; showing users token or dollar amounts; custom top-up amounts
(fixed packs only); more than one currency at launch (USD); credit prices that vary by model; BYOK
(§12); Auth0 RBAC (the allowlist model stays).

## 3. Constraints from the current code

| Fact | Where | Consequence |
|---|---|---|
| Paid calls happen only in `doTranslate()` Tier 1, the `/more-examples` handler, and admin-only tools (playground, latency lab, probes). | `server/translate.ts`, `server/moreExamples.ts`, `server/admin/*` | Public traffic has two metering points. Admin tools are the owner by definition. |
| In-flight dedup: joiners share the leader's promise, keyed by (sourceLang, targetLang, text). | `translate()` | Only the leader may be charged. The leader's *denial* must not be passed on to joiners (§5.3). A joiner gets the leader's model route (§5.4). |
| Fusion's merge (and the slower provider) finish **after** the response is sent. | `fusion.ts` `upgrade`; `translate()` `background` | The cost is final only when the in-flight entry is released, so settle there. |
| Transports already return `meta {promptTokens, completionTokens}`, and `runTranslate` merges core + extras. | `translateFlow.ts`, `openaiCompat.ts`, `anthropic.ts`, `responses.ts` | Gaps: fusion drops the slower provider's usage and the merge call's usage. The discarded `bad_response` retry (Anthropic, Responses) isn't counted. `moreExamples` returns no usage. Streamed Chat Completions never send `stream_options.include_usage`, so some vendors report nothing. Nothing is persisted. |
| `LlmService.current()` returns fusion(primary, secondary) when `llm_settings.secondaryProviderId` is set, otherwise the primary alone. Callers: the JSON and stream handlers in `server/translate.ts`, and `server/moreExamples.ts`. | `server/llm/service.ts` | Add `currentMetered()`, and let callers pick a provider per route (§5.4). The bare primary is already built before it is wrapped in fusion. |
| Lookups send no token, but both clients can get one: web `getAccessTokenSilently`, extension `getAccessToken()`. | `src/api/dictionary.ts`, `extension/src/background/lookupClient.ts` | The clients must change. The extension needs a store release before enforcement starts. |
| With `authRequired: false`, `express-oauth2-jwt-bearer` calls `next()` on **any** failure, whether the token is missing or invalid. | `node_modules/express-oauth2-jwt-bearer/dist/index.js` | An expired owner token silently turns into an anonymous request. Detect "Authorization header present but no `req.auth`" and tell the client (§5.2). |
| The web app renews tokens with iframe silent auth (no refresh tokens, `cacheLocation="localstorage"`). The extension re-runs `launchWebAuthFlow` with `prompt=none`. | `src/main.tsx`, `extension/src/background/authClient.ts` | An `email_verified` claim in the access token would only change when the token is renewed, and a forced renewal fails where third-party cookies are blocked. Check verification on the server instead (§5.2). |
| The API already holds an Auth0 Management API client (`ManagementClient`), used by `/api/user-data` for `users.get` and `users.update`. | `server/app.ts` | Reading `email_verified` and resending verification emails need no new credentials. `users.update` already requires the `update:users` grant, which the verification-email job also needs. |
| The owner is `isAdminSub(sub)` (`ADMIN_USER_IDS`). | `server/admin/auth.ts` | Owner status comes from config, not the DB, so no DB write can lock the owner out. |
| The cache key is `(word, sourceLang, targetLang, version)`. It contains no model. | `server/cache/translationCache.ts` | Whoever generates a word first decides its entry for everyone, for a year (§4.4). |
| Mongo runs standalone (no replica set), so there are no multi-document transactions. | `docker-compose.yml` | Every counter, balance and order update must be a single-document atomic operation. |
| `express.json({ limit: '64kb' })` is global and mounted before every router. | `server/app.ts` | The payment webhook needs the raw body for its signature check, so it is mounted before `express.json()` (§6.5). |
| The site's CSP has `form-action 'self' <auth0>`, and `Permissions-Policy` sets `payment=()`. | `nginx.conf` | Go to hosted checkout with `location.assign()` from JS, never with a form post. No Stripe.js, iframe or Payment Request API is used, so the CSP doesn't change. |
| The web stream client maps 429 to a generic `api_error`. The extension maps 429 to `rate_limited`. | `src/api/dictionary.ts`, `lookupClient.ts` | Use **429** for quota denials, so already-installed extensions (≤ 0.3.0) show a reasonable "try later". |
| Periodic jobs run as `setInterval(…).unref()` in `server/index.ts`, on the single API instance. | `server/index.ts` | Billing reconciliation and the credit sweep follow the same pattern (§6.7). |
| Admin already has `DELETE /api/admin/entries/:id`. The "Generated by" footnote is rendered in `WordEntry.tsx`. Cache docs record a creator (IP, user agent, origin; no account). | `server/admin/router.ts`, `src/components/WordEntry.tsx`, `buildEntryCreator` | The owner Regenerate builds on these (§5.4). The creator gains the account `sub`. |

---

## 4. Product design

### 4.1 What costs a credit

**1 unit = 1 generation:** a cache-miss lookup that the LLM answered (typo answers and
"incomplete" answers count, since the tokens were spent either way), or one uncached "more
examples" batch. The unit comes from the daily free allowance first, then from the credit balance.

**Free:** cache hits; in-flight joins; client-cache hits; the owner's Regenerate; lookups where the
LLM failed and the dictionary fallback or an error answered. In that last case the unit goes back
to the user, but the dollars already spent still count against the budget.

Users reason about "new words": *words already in the dictionary are always free; adding a new word
uses one free new word, or one credit.*

### 4.2 Tiers and spending order

- **Owner:** exempt from every limit except the blocklist, and always on the full model setup.
  Usage is still recorded, so the dashboard shows the whole picture.
- **Unlimited plan:** an account you trust, such as a partner or your second account. It is treated
  exactly like the owner (no limits, full setup) and recorded as `exempt`.
- **Signed in, verified email:** the daily free allowance (`userDailyFree`, default 20, overridable
  per account) → the credit balance → denied. The free allowance pauses when the free budget runs
  out; credits keep working (decision 6), up to a sanity ceiling of 300 credit-funded generations
  per account per day.
- **Signed in, email not verified:** the anonymous allowance of their IP → the credit balance (for
  granted credits) → denied with "verify your email". Signing in never gives less than staying
  anonymous, and creating unverified accounts gives no extra free words.
- **Anonymous:** a per-IP allowance (5 a day, IPv6 by /64), inside the **anonymous share** (50 %) of
  today's free budget. The share keeps IP-rotating anonymous traffic from eating the budget that
  verified users rely on. Setting the allowance to 0 makes sign-in required for any generation.
- **Blocked accounts** (set by the admin): no generations; cache hits keep working. Bots and blocked
  IPs are unchanged (403).
- **Credits never expire** while the service runs. A balance can go negative after a refund or a
  chargeback (§6.6). A negative balance blocks credit spending, not the free allowance.

Windows are calendar UTC days and months. "Resets at 00:00 UTC" is easy to explain, and the burst
around the boundary is small at these sizes.

**User journeys**

| Who | What happens |
|---|---|
| Anonymous, first visit | Looks up 5 new words. The 6th shows "You've used today's free new words. Sign in to get 20 a day." Existing words keep working. |
| Signs in with Google | Google sign-ins normally arrive verified, so 20 new words a day from then on. |
| Signs up with email and password, hasn't clicked the link yet | Still has the 5 IP words. A card says "Verify your email to get 20 new words a day" with **Resend email** and **I've verified**. |
| Verified, used today's 20 | "You've used today's 20 free new words. Resets in 6 h." with **Top up**. |
| Buys 500 credits | Stripe Checkout, then back on the Credits page: "500 credits added." The next new word uses a credit. |
| Free budget used up for today | Free new words pause for everyone except you, unlimited accounts and credit holders. Existing words keep working. |

### 4.3 Free budget (the wallet guard)

The budget caps the summed **actual cost** of every generation whose `source` is `free` (anonymous,
unverified and the verified allowance): **$1.00 per UTC day and $5.00 per UTC month.**

**Pacing** (`pacing = even`, the default):

```
remaining   = monthlyCap − free spend this month before today
daysLeft    = days left in the month, including today
todayBudget = min(dailyCap, remaining ÷ daysLeft)
```

Unused budget rolls forward, the daily cap still bounds any single day, and the month can't run dry
in its first week. Examples for a 30-day month:

| Situation | Today's free budget |
|---|---|
| Day 1 | min($1.00, $5.00 ÷ 30) = **$0.17** |
| Day 15, $2.00 spent before today | min($1.00, $3.00 ÷ 16) = **$0.19** |
| Day 21, nothing spent yet | min($1.00, $5.00 ÷ 10) = **$0.50** |
| Day 26, nothing spent yet | min($1.00, $5.00 ÷ 5) = **$1.00** (the daily cap binds) |
| Day 30, $4.70 spent before today | min($1.00, $0.30 ÷ 1) = **$0.30** |
| `pacing = off`, day 1 | min($1.00, $5.00) = $1.00, so five busy days use up the month |

**Anonymous share:** generations from the IP allowance (anonymous and unverified users) may use at
most `anonShare` (50 %) of today's budget. Verified users can use all of it, including any part of
the anonymous share that went unused. On day 1 that is about $0.08, roughly 40 budget-class new words
for all anonymous visitors combined.

**Total exposure** = the free budget + the credits you grant. Revenue covers purchased credits
(§6.2), and the per-account ceiling bounds what one paying account can burn in a day.

**Alerts** fire at 50 / 80 / 100 % of the monthly budget, plus once a day when today's budget runs
out. Payment alerts are listed in §6.12. Every alert goes to a log line and an admin Overview
banner, and optionally to a webhook (`USAGE_ALERT_WEBHOOK_URL`, e.g. ntfy, Slack or Discord).

**Two admin switches:**

- **`freeTierEnabled`** is an instant kill switch: cache-only for everyone except you, unlimited
  accounts and credit spending.
- **`enforcement`** (`off`, `shadow` or `on`). `shadow` runs every check and records would-be
  denials without blocking anything. Use it for rollout and calibration.

### 4.4 Which model answers whom

- **Two routes.** `full` is your configured setup (primary, plus the secondary and the merge when
  fusion is on). It serves the owner and unlimited accounts. `metered` is one model and serves
  everyone else. Routing is independent of `enforcement`: it is a cost decision, not a denial.
- **The metered model** is picked in the admin active-provider switcher: *Everyone else uses:
  Primary model only* (the default) / *Same as me* / *any enabled provider and model*. The default
  is the primary of your active pair, without the secondary and without the merge.
- **The metered route is never fusion.** If a custom metered provider fails to build, the route
  falls back to the primary alone and the Overview shows a warning. It never falls back to the full
  setup.
- **The cache is shared.** The cache key has no model, so the first generation of a word decides
  its entry for everyone until it expires (1 year) or `CACHE_VERSION` changes. The existing
  "Generated by" footnote shows which model wrote it.
- **Owner Regenerate.** On an entry that the current full setup didn't write, you see *Regenerate
  with my setup* next to the footnote. It replaces the cached entry with a fresh full-route
  generation. It is free for you and doesn't touch the budget. Admin → Entries gains a "generated by
  others" filter.
- **Tip:** give the metered model its own provider entry with its own API key. Then the vendor-side
  spend cap you set for strangers (§9) can never block your own lookups.

### 4.5 Credits and top-ups

**Packs** (USD). The final price, with any tax, is shown on the Stripe page:

| Pack | Credits | Price | Per credit |
|---|---|---|---|
| Starter | 500 | $5 | 1.0¢ |
| Plus | 1,200 | $10 | 0.83¢ |
| Max | 3,000 | $20 | 0.67¢ |

The packs assume a budget-class metered model (≈ $0.002 per new word). §6.2 has the margin math, and
the admin Payments tab shows each pack's margin at the measured cost.

- **Who can buy:** signed-in users with a verified email. Decision 5 extends to purchases as an
  anti-fraud measure, and it means the account has an address you can reach.
- **Limits:** the balance can't go above 10,000 credits. Checkout can be started 5 times per hour
  and 10 times per day per account, with at most 3 unfinished checkouts at once.
- **Where to top up:** the Credits page (`/account/credits`), the quota panels, the usage chip, the
  account menu, and the extension popup (which opens the website).
- **Receipts:** Stripe emails them. The Credits page lists your orders.
- **Refund policy** (proposed; it goes on the Terms page, §6.11): unused credits from a purchase are
  refundable on request within 14 days. Used credits aren't refundable except where the law
  requires it. A refund or chargeback removes the purchased credits.

### 4.6 UX

**Web**

- **Usage chip** next to `AuthButton`. Anonymous: "3 of 5 free new words left today · Sign in for 20
  a day". Unverified: "3 of 5 left today · Verify your email for 20 a day". Verified: "17/20 free
  today · 120 credits". Hidden for the owner and for unlimited accounts. It appears after the day's
  first generation, or once 30 % or less is left, so it doesn't nag.
- **Denied lookup on `WordPage`:** a friendly panel instead of the generic error, worded by reason:

  | Reason | Shown to | Message | Buttons |
  |---|---|---|---|
  | `anon_daily` | anonymous | "You've used today's free new words. Sign in to get 20 a day." | Sign in · Browse existing words |
  | `unverified_daily` | signed in, unverified | "You've used today's free new words. Verify your email to get 20 a day." | Resend email · I've verified |
  | `anon_share` | anonymous or unverified | "Free new words for visitors are used up for today. Signed-in users with a verified email still have some." | Sign in, or Resend email |
  | `user_daily` | verified | "You've used today's 20 free new words. Resets in 6 h." | Top up |
  | `free_tier_budget` | anyone without credits | "Free new words are paused until 00:00 UTC. This project has a daily AI budget. Existing entries still work." | Top up (verified), Sign in (anonymous) |
  | `free_tier_paused` | anyone without credits | "Adding new words is paused right now. Existing entries still work." | Top up (verified) |
  | `paid_daily_max` | credit holders | "You've reached today's limit of 300 new words. Resets in 6 h." | — |

  Top up appears only when payments are on; without it, the panel shows "Need more? Get in touch".
- **Signed-out signal:** when the server reports `authState: "invalid"`, ask the user to sign in
  again instead of quietly spending the anonymous allowance.
- **Verify-email card** (on the Credits page and in the `unverified_daily` panel): *We sent a link
  to you@…* · **Resend email** · **I've verified**. "I've verified" asks the server to re-check
  (§5.2). The card re-checks by itself when the tab regains focus.
- **Credits page** (`/account/credits`, sign-in required):

  ```
  Credits ─────────────────────────────────────────────────────────────
   Balance  120 credits            Free today  17 of 20 left (00:00 UTC)
   1 credit = 1 new word or 1 "more examples" batch.
   Words already in the dictionary are always free.
  ─────────────────────────────────────────────────────────────────────
   [ 500 credits · $5 ]   [ 1,200 credits · $10 ]   [ 3,000 credits · $20 ]
                                                       best value
   Secure checkout by Stripe. The final price, with any tax, is shown there.
   By buying you agree to the Terms, including the refund policy.
  ─────────────────────────────────────────────────────────────────────
   Orders   2026-11-12   500 credits   $5.00   Paid       receipt ↗
  ```

- **Checkout return states** on the same page:
  - success: "Payment received, adding credits…", then "✓ 500 credits added. Balance: 620." If the
    user came from a denied lookup, a **Back to "serendipity"** button returns to that word.
  - still processing after 30 s: "Your payment is processing. Credits will appear here
    automatically; you can close this page."
  - canceled: "Checkout canceled. You weren't charged."
  - errors: payments unavailable, email not verified, balance limit reached, too many attempts.
- **Terms page** (`/terms`): service terms, a Credits section and the refund policy. It is linked
  from the header menu next to Privacy, from the Credits page, and next to every Buy button.
- **More examples:** the same reasons, shown inline under the button.
- All new copy in en / zh / ja / es (`src/i18n/translations.ts`).

**Extension:** the same reasons in `ResultCard` and `Popup`. The popup shows "17/20 free today · 120
credits". **Sign in** calls the extension's `login()`. **Verify email** and **Top up** open
`https://dict.ai-dictionary.org/account/credits` in a new tab with `chrome.tabs.create`, which needs
no new permission. The website and the extension sign in to the same Auth0 tenant, so it is the same
account and the same balance. Sign in to the extension on each of your own browsers, or your
extension lookups count as anonymous and use the metered model.

---

## 5. Technical design

### 5.1 Request flow

```
GET /api/translate-stream/:text
  blocklistGuard → optionalJwt → translateLimiter (owner skipped; key = sub or IP)
  → llmGuard (bots; LlmBudget backstop, owner skipped)
  → translate(lookup, llmRouter, dict, cache, { client, meter, onPartial })
       cache hit, or join an in-flight lookup ─────────────► free (a joiner gets the leader's route)
       miss, this request is the leader → ticket = meter.reserve()
            ├─ denied → QuotaDeniedError → HTTP 429 quota_exceeded
            │           (no cache write; joiners retry as leaders)
            └─ ok     → llm = llmRouter(ticket.route)        // 'full' or 'metered'
                        llm.translate(req, { onPartial, usage })
                        → partial* … usage … done
                        → on release: ticket.settle(outcome, usage.totals())
```

**SSE headers are sent lazily, on the first event.** Today the handler calls `flushHeaders()`
before `translate()`. Instead, defer the 200 and the event-stream headers until the first `partial`
or `done`. The reservation happens before the LLM call, so a denial always arrives before the first
partial and can still be a plain HTTP 429 with a JSON body. That means no pre-check read, and old
clients still get a 429. This replaces the current `refuseOverBudget` + `canServeWithoutLlm()`
pre-check for quota purposes.

### 5.2 Identity and email verification

- **Optional JWT:** build `optionalJwt = auth({ audience, issuerBaseURL, tokenSigningAlg: 'RS256',
  authRequired: false })` once in `server/app.ts`, next to `checkJwt`. Pass it into
  `createTranslateRouter`, `createMoreExamplesRouter` and the usage router.
- **Principal** is resolved synchronously from the token, with no DB read, before rate limiting:

  ```ts
  type Principal =
    | { kind: 'owner'; sub: string }                            // isAdminSub(sub)
    | { kind: 'user'; sub: string; ip: string; ipKey: string }  // account loaded lazily in reserve()
    | { kind: 'anon'; ip: string; ipKey: string }               // ipKey: IPv4 as is, IPv6 truncated to its /64
  type AuthState = 'valid' | 'anonymous' /* no header */ | 'invalid' /* header present, verification failed */
  ```

  Users carry `ipKey` because unverified users draw on the IP allowance. Unlimited and blocked
  accounts are detected in `reserve()`.
- **Rate limits by principal:** move `translateLimiter` after `optionalJwt`, `skip` the owner, and
  key signed-in users by `sub`, which avoids shared-NAT collisions. Anonymous traffic stays at 5 rpm
  per IP. The in-memory `LlmBudget` (300/IP/day) stays as a coarse backstop for non-owner traffic.
- **Web client:** `lookupWord` and `lookupWordStream` take an optional `getToken`. `useDictionary`
  passes `getAccessTokenSilently` when `isAuthenticated`; a token error means anonymous. **Hold the
  first lookup until Auth0 finishes loading (`isLoading`), up to about 1 s.** Otherwise your first
  lookup on a fresh page load goes out unauthenticated.
- **Extension:** `lookupClient.ts` adds `Authorization: Bearer <token>` whenever `getAccessToken()`
  returns one. CORS already handles it: favorites send the same header cross-origin, and `cors()`
  reflects the requested headers.

**Email verification is checked on the server and cached on the account**
(`server/usage/verification.ts`):

| Cached state | What `isEmailVerified(account)` does |
|---|---|
| verified, checked less than 7 days ago | returns true, no call |
| not verified, checked less than 10 minutes ago | returns false, no call |
| anything else | `mgmt.users.get({ id: sub })` with a 1.5 s timeout, then stores `email_verified === true` and the time |
| Management API error or timeout | returns false for this request and stores nothing, so it fails toward the smaller IP allowance, never a bigger one |

- It is called only where it matters: in `reserve()` on a cache miss, by `/api/usage/me`, and by
  checkout. Only one check per `sub` runs at a time, and a process-wide limit (5 calls/s) keeps the
  API well under Auth0's Management API rate limits. The 7-day re-check catches an email change,
  which resets verification in Auth0.
- `POST /api/usage/verify-email/refresh` forces a re-check (sign-in required; once per minute per
  account). The web card calls it on *I've verified* and when the tab regains focus.
- `POST /api/usage/verify-email/resend` calls the Management API verification-email job
  (`POST /api/v2/jobs/verification-email`, `mgmt.jobs.verifyEmail({ user_id: sub })`). Sign-in
  required; once per 10 minutes and 5 times per day per account. Social sign-ins are verified by
  their provider. If one isn't, the card suggests signing in another way.
- Why not a token claim: see §3 (token renewal) and §12.

### 5.3 Metering: `server/usage/`

| File | Role |
|---|---|
| `principal.ts` | `resolvePrincipal`, IPv6 /64 keying, `authState` |
| `meter.ts` | `reserve(principal, action) → Ticket`; `Ticket.settle(outcome, usage)`; `QuotaDeniedError` (reason, limit, used, resetAt, actions) |
| `store.ts` | `UsageStore` interface, a Mongo implementation, and an in-memory one for tests (same injection style as `LlmServiceDeps`) |
| `pricing.ts` | Usage × price → integer micro-USD; a price map keyed by provider `id` (`llm:<vendor>:<model>`) rebuilt on `reloadFromDb()`; the reservation estimate; a token estimate when a vendor reports none |
| `settings.ts` | The `usage_settings` singleton: env defaults plus DB overrides, refreshed every 30 s (same pattern as `llm_settings`) |
| `verification.ts` | The `email_verified` cache, resend and refresh (§5.2) |
| `router.ts` | `GET /api/usage/me`, the verify-email endpoints |

**Atomic primitives.** Each works on a single document, so concurrent requests can't overshoot:

```ts
/** n += by, only if n + by <= limit. Returns false when it would exceed the limit. */
async function tryIncrement(id: string, by: number, limit: number, expiresAt: Date): Promise<boolean> {
  await counters.updateOne({ _id: id }, { $setOnInsert: { n: 0, costMicros: 0, expiresAt } }, { upsert: true })
  const r = await counters.updateOne({ _id: id, n: { $lte: limit - by } }, { $inc: { n: by } })
  return r.modifiedCount === 1
}

/** Reserves `micros` of budget, only if costMicros + micros <= limitMicros. */
async function tryReserveCost(id: string, micros: number, limitMicros: number, expiresAt: Date): Promise<boolean> {
  await counters.updateOne({ _id: id }, { $setOnInsert: { n: 0, costMicros: 0, expiresAt } }, { upsert: true })
  const r = await counters.updateOne(
    { _id: id, costMicros: { $lte: limitMicros - micros } },
    { $inc: { costMicros: micros, n: 1 } },
  )
  return r.modifiedCount === 1
}

// Balance debit, also atomic; a billing hold or a balance below 1 makes it fail:
// accounts.updateOne({ _id: sub, creditBalance: { $gte: 1 }, billingHold: { $ne: true } },
//                    { $inc: { creditBalance: -1 } })
```

**Budget = reserve an estimate, settle the actual.** The dollar cost is only known after the
generation, so `reserve()` reserves an estimate and `settle()` replaces it with the real cost. Under
concurrency the caps hold to within the gap between the estimate and the real cost of the
generations in flight. The estimate is 1.25 × the p95 actual cost of that provider and action over
the last 7 days (from the ledger, refreshed every 10 minutes). Until there is data, it is the price
× 1,500 input + 1,500 output tokens for a lookup, or 600 + 600 for "more examples".

**Today's budget** is computed from one read of the day and month counters (§4.3):

```ts
const spentBefore = month.costMicros - day.costMicros          // both include open reservations
const remaining   = Math.max(0, monthlyCapMicros - spentBefore)
const todayBudget = settings.freeTierEnabled
  ? Math.min(dailyCapMicros, settings.pacing === 'even' ? Math.floor(remaining / daysLeftIncludingToday) : remaining)
  : 0
```

Keeping today's spend within `todayBudget` also keeps the month within its cap, so only the day
counter needs a conditional reservation. The month counter is incremented for accounting and pacing.

**`reserve()`** runs on the leader after a cache miss, right before Tier 1:

```
owner                                         → Ticket{ source: 'owner',  route: 'full' }
account = user ? loadAccount(sub) : null        // lazy upsert; plan, status and allowance cached 30 s
account.status == 'blocked'                   → deny 403 (same body as the IP blocklist)
account.plan == 'unlimited'                   → Ticket{ source: 'exempt', route: 'full' }
enforcement == 'off'                          → Ticket{ source: 'unmetered', route: 'metered' }
est = estimate(meteredProvider, action);  budget = todayBudget()

verified user:
    tryIncrement(d:<day>/u:<sub>, 1, account.dailyAllowance ?? userDailyFree)        else reason = 'user_daily'
    tryReserveCost(d:<day>/free, est, budget)       else undo; reason = budgetReason()
    → incCost(m:<month>/free, est); Ticket{ source: 'free', pool: 'account', route: 'metered' }
anonymous, or unverified user:
    tryIncrement(d:<day>/ip:<ipKey>, 1, anonDailyPerIp)   else reason = user ? 'unverified_daily' : 'anon_daily'
    tryReserveCost(d:<day>/free-anon, est, budget × anonShare)    else undo; reason = 'anon_share'
    tryReserveCost(d:<day>/free, est, budget)                     else undo both; reason = budgetReason()
    → incCost(m:<month>/free, est); Ticket{ source: 'free', pool: 'ip', route: 'metered' }

no free unit, signed-in user (decision 6: works during a free-budget pause):
    tryIncrement(d:<day>/paid:<sub>, 1, paidDailyMax)     else deny('paid_daily_max')
    debit balance                                         else undo; deny(reason)
    → Ticket{ source: 'balance', route: 'metered' }
otherwise → deny(reason)

budgetReason() = freeTierEnabled ? 'free_tier_budget' : 'free_tier_paused'
shadow mode: the same logic, but a denial records wouldDeny on the ledger and returns
             Ticket{ source: 'shadow', route: 'metered' }; its cost goes to d:<day>/spend:shadow,
             not to the free counters (in reality it wouldn't have happened).
```

`actions` on a denial: anonymous → `sign_in`; unverified → `verify_email`; verified → `buy_credits`
when payments are on; then `wait` for everyone.

**`Ticket.settle(outcome, usage)`** runs once, when the in-flight entry is released:

- `actual = cost(usage)`. The user is charged only if the outcome is an LLM answer (`tier === 'llm'`,
  or examples were generated).
- **Free tickets:** add `actual − est` to the day free counter, the anonymous-share counter (pool
  `ip`) and the month free counter. If the user isn't charged, also give back the allowance unit
  (`n − 1`). The dollars stay counted either way.
- **Balance tickets:** if the user isn't charged, return the credit and the daily paid unit.
- **Always:** add `actual` to `d:<day>/spend:<source>`, and write one ledger doc.
- Counter keys are fixed at reservation, so a generation that starts before midnight settles into
  the day and month it started in.

**Integration with `translate()`**

- `translate()` takes an `LlmRouter = (route: 'full' | 'metered') => LlmProvider | null` instead of a
  provider. Callers without a meter (tests, scripts) pass `() => provider`.
- `TranslateHooks` gets `meter?: () => Promise<Ticket>`. `doTranslate` calls it between Tier 0 and
  Tier 1 and picks the provider from `ticket.route`. `QuotaDeniedError` propagates without touching
  the cache or the dictionary tier.
- **The leader is denied but a joiner is allowed.** If a joiner's shared promise rejects with
  `QuotaDeniedError`, the joiner calls `translate()` again with its *own* hooks. The denied entry
  has already been released, so the joiner becomes the new leader or joins one. Without this, your
  lookup could join an anonymous visitor's denied lookup for the same word and get refused.
- **Settle at release.** `translate()` already waits on `Promise.allSettled(background)` before it
  drops the in-flight entry. Call `ticket.settle()` there, so fusion's late calls (owner route) are
  included. A metered generation has no fusion, so its background is only the cache write.
- **Joiners never reserve,** so they pay nothing and get the leader's route. This also removes
  today's small overcount, where `recordLlmSpend()` counts joiners.
- **`/more-examples`** uses the same meter (`action: 'examples'`) and router after its existing
  cache check. `LlmMoreExamplesResult` gains `meta`.

### 5.4 Model routing

- **Settings:** `llm_settings` gains `metered: { mode: 'primary' | 'same_as_owner' | 'provider',
  providerId?, modelId? }`. Absent means `primary`. Saving it bumps `configVersion`, like every
  active-provider change.
- **`LlmService`:** `reloadFromDb()` already builds the bare primary before wrapping it in fusion.
  Keep that reference and build the metered provider next to it:
  - `primary`: the bare primary.
  - `same_as_owner`: the same object as `current()`.
  - `provider`: `buildLlmProvider(providerToLlmConfig(doc, modelId))`. If it fails, use the primary
    and set a warning.

  The new method is `currentMetered(): LlmProvider | null`. In env-baseline mode both methods
  return the env provider. `status()` gains `metered: { mode, providerName?, model?, id?, warning? }`
  for the Overview.
- **Admin:** `PUT /api/admin/llm/active` accepts `metered`. The provider must exist and be enabled,
  and the model must belong to it. The change is audited as `llm.metered.update`. The
  `ActiveSwitcher` gets the *Everyone else uses* selector.
- **Callers** (`server/translate.ts` handlers, `server/moreExamples.ts`) pass
  `route => route === 'full' ? svc.current() : svc.currentMetered()`.
- **Cost guard:** payments can't be switched on while the metered model has no price (§6.2).
- **Owner Regenerate:** `POST /api/admin/entries/regenerate { word, sourceLang, targetLang }`
  (behind `requireAdmin`):
  1. Delete the current-version cache doc.
  2. Run `translate()` with the owner principal (route `full`). If the word happens to be in flight,
     this joins it.
  3. Return the entries. The action is audited as `entry.regenerate`.

  The web client then removes that word's `dict:v1:` localStorage key and re-renders. The link
  appears for the owner when the entry's `generatedBy.models` differ from the full setup's models,
  which `/api/usage/me` returns for the owner.

### 5.5 Cost accounting

- **`UsageSink`** has one method: `add({ providerId, kind: 'core'|'extras'|'fuse'|'examples',
  promptTokens, completionTokens, estimated })`. It is threaded through `LlmTranslateOptions.usage`,
  the way `onPartial` is today. `runTranslate` hands it to both transports, and fusion hands it to
  both providers and to `fuse()`.
- **Count the discarded `bad_response` retry.** `runTranslate` currently drops the first attempt's
  `meta`.
- **Streaming usage:** send `stream_options: { include_usage: true }` on streamed Chat Completions
  calls. If a gateway rejects it with a 400, remember that and stop sending it (the same step-down
  idea as `requestVariants.ts`).
- **When the vendor reports no usage,** use a conservative estimate (UTF-8 bytes / 3, for both the
  prompt and the completion), flag it `estimated: true`, and show the estimated share on the admin
  Usage page.
- **Prices:** add `LlmProviderModel.pricing?: { inputUsdPerMTok, outputUsdPerMTok }`, edited in the
  admin Provider form. Env-baseline providers and unpriced models fall back to
  `LLM_DEFAULT_PRICE_*` and raise a warning. Cached-input discounts are ignored, so the cost is
  over-estimated, never under.
- **Money** is stored as integer micro-USD (`costMicros`).

**Ballpark.** Prompt sizes were measured from `buildCoreMessages` / `buildExtrasMessages` (chars / 4):
core is about 800 tokens and extras about 460. Output is *assumed* to be about 1.2k tokens; Phase 0
replaces that guess with real numbers. **The prices are illustrative.** Substitute your providers'
real ones.

| Route | Tokens in / out | Budget model ($0.30 / $1.20 per M) | Frontier model ($3 / $15 per M) |
|---|---|---|---|
| Metered: one model (strangers) | ≈ 1.3k / 1.2k | ≈ $0.002 | ≈ $0.022 |
| Full with fusion: 2 providers + merge (you) | ≈ 5.5k / 3.8k | ≈ $0.006 | ≈ $0.074 |

Phase 0 runs before routing exists, so strangers still use fusion then. The ledger records every
call with its provider and kind, so the primary's core + extras calls give the exact single-model
cost those generations will have once routing is on.

### 5.6 Data model (Mongo)

Keys use `:` and `/` as separators, never `|`, because Auth0 subs contain `|`.

| Collection | Shape | Retention / indexes |
|---|---|---|
| `usage_counters` | `{ _id, n, costMicros, expiresAt }`. Keys: `d:<day>/ip:<ipKey>` (IP allowance), `d:<day>/u:<sub>` (verified allowance), `d:<day>/paid:<sub>` (credit-funded count), `d:<day>/free`, `d:<day>/free-anon` (anonymous share), `m:<month>/free`, `d:<day>/spend:<source>` | TTL on `expiresAt`: day keys +2 days, month keys +40 days. IP-keyed counters are gone within 2 days. |
| `usage_ledger` | One doc per settled generation: `{ ts, principal: { kind, sub?, ip?, emailVerified? }, action, source, pool?, route, charged, credits, word, sourceLang, targetLang, estMicros, costMicros, estimated, calls: [{ providerId, kind, in, out, estimated }], channel, shadow?, wouldDeny? }` | TTL 180 days (matches the privacy policy). Indexes `{ts:-1}`, `{'principal.sub':1, ts:-1}`, `{'principal.ip':1, ts:-1}`. |
| `accounts` | `{ _id: sub, plan ('free' or 'unlimited'), status ('active' or 'blocked'), dailyAllowance?, creditBalance (may be negative), emailVerified?, emailVerifiedCheckedAt?, billingHold?, appliedTx: [txId…], createdAt, updatedAt, lastSeenAt }` | Created lazily. No email is stored; the admin UI looks up sub → email through the Management API on demand. |
| `credit_transactions` | `{ _id: txId, sub, delta, kind ('purchase', 'grant', 'adjust', 'refund_clawback', 'dispute_clawback' or 'dispute_restore'), orderId?, by?, note?, createdAt, appliedAt? }` | Kept while the account exists (no IP). Index `{ sub: 1, createdAt: -1 }`. Provider-driven ids are deterministic (`purchase:<orderId>`, `clawback:<orderId>:<total>`, `dispute:<disputeId>`, `dispute_won:<disputeId>`); admin grants use the form's idempotency key (`grant:<uuid>`). |
| `payment_orders` | §6.4 | Kept while the account exists. Indexes `{ sub: 1, createdAt: -1 }`, unique sparse `{ sessionId: 1 }`, sparse `{ paymentId: 1 }`, `{ status: 1, createdAt: 1 }`. |
| `payment_events` | `{ _id: providerEventId, type, orderId?, livemode, receivedAt, processedAt?, result ('ok', 'ignored', 'mismatch' or 'error'), error? }` | TTL 400 days. The `_id` doubles as the dedupe key. |
| `usage_settings` | `{ _id: 'usage', enforcement, freeTierEnabled, pacing, anonDailyPerIp, anonShare, userDailyFree, paidDailyMaxPerAccount, freeTierDailyUsd, freeTierMonthlyUsd, paymentsEnabled, packs: [{ id, credits, priceId, amount, currency, active }], maxBalance, alertWebhookUrl?, updatedAt, updatedBy }` | Singleton |
| `llm_settings.metered` | New optional field (§5.4) | — |
| `llm_providers.models[].pricing` | New optional field | — |

Per-generation credit spends are not transactions. The ledger records them with `source:
'balance'`, which keeps `credit_transactions` small.

**Exactly-once balance changes without transactions:**

1. Insert the `credit_transactions` doc. A duplicate `_id` means it already exists, which turns
   webhook redeliveries and retries into no-ops.
2. Apply it with one conditional update: `accounts.updateOne({ _id: sub, appliedTx: { $ne: txId }
   }, { $inc: { creditBalance: delta }, $push: { appliedTx: { $each: [txId], $slice: -100 } } })`.
3. Set `appliedAt` on the transaction.

A sweep at boot and in the daily reconciliation (§6.7) reruns step 2 for transactions without
`appliedAt` that are less than 7 days old; the `appliedTx` guard makes the rerun safe. An older
unapplied transaction raises an alert instead, because the 100-entry guard might no longer hold
its id.

### 5.7 API contract

**`GET /api/usage/me`** (optional auth, `apiLimiter`):

```json
{ "tier": "user", "authState": "valid", "emailVerified": true,
  "today": { "used": 3, "limit": 20, "pool": "account", "resetAt": "2026-11-13T00:00:00Z" },
  "balance": 120, "paidToday": { "used": 0, "limit": 300 },
  "freeTier": "open",
  "payments": { "enabled": true,
                "packs": [{ "id": "starter", "credits": 500, "amount": 500, "currency": "usd" }] } }
```

- `tier` is `owner`, `exempt`, `user` or `anon`; `freeTier` is `open`, `budget_reached` or `paused`.
- Anonymous visitors get `pool: "ip"` and no balance. The owner gets `{ "tier": "owner",
  "fullModels": ["…"] }`, which the Regenerate link uses.
- Free-tier state is cached in memory for 10 s.

**A denial** is **HTTP 429** with `Retry-After` set to the seconds until `resetAt`, on `/translate`,
`/translate-stream` (thanks to the lazy SSE headers, §5.1) and `/more-examples`:

```json
{ "error": "quota_exceeded",
  "reason": "anon_daily | unverified_daily | anon_share | user_daily | free_tier_budget | free_tier_paused | paid_daily_max",
  "limit": 5, "used": 5, "resetAt": "2026-11-13T00:00:00Z",
  "actions": ["sign_in", "wait"], "balance": 0 }
```

- A blocked account gets the IP blocklist's 403.
- When Mongo is down for a metered principal, the response is `503 { "error":
  "generation_unavailable" }` with `Retry-After: 60` (§8).

**How clients learn their new balance:**

- **SSE:** after a charged generation, send `event: usage` with `{ source, today, balance }` before
  `done`. Older clients ignore unknown events.
- **JSON `/translate`:** send the response header `X-Generation: charged`, so the web client knows
  to refetch `/api/usage/me`.

**Verification:** `POST /api/usage/verify-email/resend` and `POST /api/usage/verify-email/refresh`.
Both require sign-in, and both return `{ "emailVerified": bool }` (§5.2).

**Billing** (§6): `POST /api/billing/checkout`, `GET /api/billing/orders`,
`GET /api/billing/orders/:id`, `POST /api/billing/webhook`.

**Admin endpoints.** All sit behind `requireAdmin`, and every write is audited (`usage.settings.update`,
`account.update`, `account.credits.grant`, `llm.metered.update`, `entry.regenerate`,
`billing.reconcile`).

- `GET /api/admin/usage/summary?days=30` returns:
  - spend per day by source (owner, exempt, free, balance, shadow) and route
  - the budget gauges (today's paced budget, the month, the anonymous share)
  - cost per generation (p50 and p95) by model
  - top accounts and IPs by credits and by cost
  - the share of estimated and unpriced calls
  - shadow-mode would-deny counts by reason
- `GET|PUT /api/admin/usage/settings` (packs are validated against Stripe on save, §6.2)
- `GET /api/admin/accounts?q=` (search by sub or email)
- `PATCH /api/admin/accounts/:sub` (`plan`, `status`, `dailyAllowance`, `billingHold`)
- `POST /api/admin/accounts/:sub/credits { delta, note, idempotencyKey }`
- `GET /api/admin/billing/orders?status=&q=` and `POST /api/admin/billing/reconcile`
- `POST /api/admin/entries/regenerate` (§5.4); `PUT /api/admin/llm/active` gains `metered`

### 5.8 Admin UI

- **New "Usage & budget" page** (`src/pages/admin/Usage.tsx`, in the Analytics nav section):
  - gauges for today's paced budget, the month and the anonymous share, with the pacing explained
    in one line ("$4.83 left ÷ 29 days")
  - spend over 30 days by source and route, split owner vs. everyone else
  - cost per new word by model, and the share of estimated and unpriced calls
  - would-deny counts (shadow) and denials (on) by reason
  - top consumers
  - a settings form: enforcement, kill switch, pacing, budgets, allowances, anonymous share, the
    paid ceiling, the alert webhook
- **Accounts tab** on the same page: search by email or sub. Shows plan, status, allowance override,
  email verified, balance, billing hold, transactions, orders and recent generations. Actions: set
  plan, status or allowance; grant or adjust credits with a note; lift a billing hold.
- **Payments tab:**
  - orders filtered by status
  - revenue over 30 days (gross, refunds, estimated fees)
  - pack margins at the measured cost (§6.2)
  - mismatches and disputes
  - a *Reconcile now* button
  - the packs editor, and the *payments enabled* switch with the reasons it is greyed out
- **Active-provider switcher:** the *Everyone else uses* selector (§5.4).
- **Clients:** the signed-in user (sub → email) next to the IP, and the per-IP counter.
- **Entries:** a "generated by others" filter.
- **Provider form:** a price per model.
- **Overview:** a banner when the month is 80 % used or more, the free tier is paused, the metered
  model has a warning, or a payment needs attention.

### 5.9 What stays from the abuse guard

- **Unchanged:** bot refusal, the blocklist, the nginx crawler rules, and `robots.txt`.
- **Per-minute limiters stay,** but skip the owner and key signed-in users by `sub`.
- **`LlmBudget` stays** as a per-IP backstop that also skips the owner. Retire it once the Mongo
  counters have proven themselves (Phase 4).
- **"429 on a miss, never a dictionary fallback"** now covers every quota denial.

---

## 6. Top-up payments

### 6.1 Provider: Stripe Checkout with Managed Payments

Selling to consumers in other countries brings sales tax duties. Many places, including the EU and
the UK, expect a foreign seller of digital services to register for VAT from the first sale. A
**merchant of record (MoR)** resells the product in its own name and collects and files those
taxes. For a one-person project that is worth a few percent of a small number.

| Option | Who is the seller (tax) | Fees, approximate (late 2026; check current pricing) | Integration |
|---|---|---|---|
| **Stripe Checkout + Managed Payments** (chosen) | Stripe, as MoR | standard Stripe processing + 3.5 %; about 6.4 % + $0.30 on a US card, more on international cards | Hosted Checkout Sessions with `managed_payments.enabled`; webhooks |
| Paddle | Paddle, as MoR | about 5 % + $0.50 | Paddle.js overlay or inline checkout on your page (CSP changes) |
| Lemon Squeezy (owned by Stripe) | Lemon Squeezy, as MoR | about 5 % + $0.50, plus a surcharge on some international cards | Hosted checkout links; HMAC-signed webhooks |
| Stripe Checkout, direct | You | about 2.9 % + $0.30 on US cards, plus international and FX surcharges; Stripe Tax adds 0.5 % for calculation only | Same as the chosen option without the MoR; you register and file tax yourself |

**Why Stripe with Managed Payments:**

- Stripe is the seller of record for eligible digital products, including SaaS.
- It uses the ordinary Checkout Sessions API, so if Managed Payments isn't available to you, the
  fallback is the same code with the flag off (plus your own tax setup).
- The payment page is hosted on Stripe's domain, so no card data touches this server (PCI SAQ A)
  and the CSP doesn't change.

**Check first:** Managed Payments is available only in some seller countries and for eligible
product types. Confirm eligibility for your account, and pin a Stripe API version that supports
`managed_payments` (Stripe's changelog lists it under the 2026-04-22 "dahlia" release). If you're
not eligible, choose between Paddle or Lemon Squeezy (§6.10 keeps the code provider-agnostic) and
direct Stripe with your own tax registration.

### 6.2 Packs and pricing

- **Packs** live in `usage_settings.packs`. Each has a stable `id` (`starter`, `plus`, `max`), a
  credit count and a Stripe Price id. Saving a pack calls `prices.retrieve`. The save is rejected
  unless the price is active, its mode (test or live) matches the key, and it has a unit amount and
  currency. The pack then mirrors that amount and currency for display.
- **One Stripe Product,** "Open Dictionary credits", with one Price per pack. Use tax-inclusive
  prices (`tax_behavior: inclusive`) so "$5" means $5 at checkout. In high-VAT countries you net a
  little less.
- **Margin per pack** (shown live on the Payments tab):
  - `fee` ≈ price × fee % + fixed fee
  - `tokenCost` = credits × the metered model's p95 cost per new word
  - `margin` = price − fee − tokenCost

  The pack is flagged amber when `tokenCost` is over 50 % of `price − fee`, and red when it is over
  100 %.

  | Pack | Fee (≈ 6.4 % + $0.30) | Token cost at $0.002 per new word | Margin if every credit is used |
  |---|---|---|---|
  | 500 / $5 | $0.62 | $1.00 | $3.38 |
  | 1,200 / $10 | $0.94 | $2.40 | $6.66 |
  | 3,000 / $20 | $1.58 | $6.00 | $12.42 |

  A mid-class metered model at about $0.006 per new word only breaks even on the 3,000-credit pack.
  If you pick a pricier metered model, raise prices or shrink packs.
- **Payments can be switched on only when** a billing provider is configured, at least one pack is
  valid, and the metered model has a price.

### 6.3 Top-up flow

```
Browser (web app)              API                                          Stripe
 │ Buy "starter"                │                                             │
 ├─ POST /api/billing/checkout ►│ auth + verified email + limits + max balance│
 │   { packId }                 │ insert payment_orders{status:'created'}     │
 │                              ├─ checkout.sessions.create(…) ──────────────►│
 │                              │◄──────────────────── { id: cs_…, url } ─────┤
 │                              │ order → 'open' (sessionId, expiresAt)       │
 │◄──── { orderId, url } ───────┤                                             │
 ├─ location.assign(url) ─────────────────────────────────────────────────────►│ user pays
 │                              │◄─ POST /api/billing/webhook (signed) ───────┤ checkout.session.completed
 │                              │ verify signature → dedupe → fulfilOrder()   │
 │                              │ order → 'paid', +500 credits exactly once   │
 │                              ├─ 200 ──────────────────────────────────────►│
 │◄──────────── redirect to /account/credits?order=<id>&checkout=success ─────┤
 ├─ GET /api/billing/orders/<id> (poll) ►│ paid? ← if still open after 5 s,   │
 │                              │   checkout.sessions.retrieve → fulfilOrder()│
 │◄── { status: 'paid', credits: 500, balance: 620 } ─┤                        │
```

**`POST /api/billing/checkout { packId }`:**

1. **Checks:** the caller is signed in and the account is active; the email is verified (§5.2);
   there is no billing hold; payments are enabled and the pack exists; balance + pack ≤ 10,000; the
   checkout limits from §4.5 hold. Each failure has its own error code (§8).
2. **Insert the order** `{ status: 'created' }` with a random UUID id.
3. **Create the Checkout Session**, using `idempotencyKey: 'checkout:' + orderId` so a retried
   request can't create two sessions:

   ```ts
   stripe.checkout.sessions.create({
     mode: 'payment',
     line_items: [{ price: pack.priceId, quantity: 1 }],
     client_reference_id: order._id,
     metadata: { orderId: order._id, packId: pack.id },
     customer_email: email,                 // prefill from the Auth0 profile; never stored by us
     success_url: `${PUBLIC_BASE_URL}/account/credits?order=${order._id}&checkout=success`,
     cancel_url: `${PUBLIC_BASE_URL}/account/credits?order=${order._id}&checkout=cancel`,
     expires_at: nowSeconds + 3600,         // abandoned checkouts expire after 1 h
     managed_payments: { enabled: true },   // Stripe is the merchant of record (§6.1)
   }, { idempotencyKey: `checkout:${order._id}` })
   ```

   Check the exact Managed Payments parameters against the pinned API version.
4. **Mark the order `open`,** with `sessionId` and `expiresAt`.
5. **Return `{ orderId, url }`.**

The client stores `returnTo` (the word page the user came from) in `sessionStorage` and then calls
`location.assign(url)`.

### 6.4 Orders and fulfilment

**`payment_orders`:**

```
{ _id: orderId, sub, packId, credits, priceId, provider: 'stripe', livemode,
  status, sessionId?, expiresAt?, paymentId? (payment_intent), amountTotal?, amountTax?, currency?,
  receiptUrl?, paidAt?, grantedAt?, refundedAmount?, clawedBack (credits), disputeStatus?,
  disputeClawback?, lastPulledAt?, error?, createdAt, updatedAt }
```

**States:**

```
created ──session created──► open ──paid──► paid ──refund──► partially_refunded ──► refunded
   │                          ├──async method──► pending ──succeeded──► paid
   │                          │                     └──failed──► failed
   │                          └──expired──► expired
   └──Stripe error──► error
open / pending / paid ──line items don't match──► mismatch (no credits; the owner reviews)
paid orders also carry disputeStatus: open → won or lost
```

**`fulfilOrder(orderId, evidence)`** is the only code that grants purchased credits. The webhook, the
return-page pull and the daily reconciliation all call it, and it is idempotent:

1. **Validate the evidence** (from the event or from `sessions.retrieve` with `line_items`
   expanded):
   - `client_reference_id` equals the order id
   - `payment_status` is `paid`
   - `livemode` matches the key
   - there is exactly one line item, with the pack's Price id and quantity 1

   Matching the Price id rather than the amount still works when Stripe shows the buyer a local
   currency. The amounts and tax are recorded as reported. On any mismatch, set the status to
   `mismatch`, grant nothing, and alert the owner.
2. **Claim the order:** `updateOne({ _id, status: { $in: ['created', 'open', 'pending'] } }, { $set:
   { status: 'paid', paidAt, paymentId, amountTotal, amountTax, currency, receiptUrl } })`. Losing
   that race is fine; the next step is idempotent anyway.
3. **Grant the credits:** insert `credit_transactions { _id: 'purchase:' + orderId, delta: +credits,
   kind: 'purchase' }` (a duplicate key means it is already there), then apply it exactly once
   (§5.6). Set `grantedAt` on the order.

### 6.5 Webhook

```ts
// server/app.ts: before express.json() and before blocklistGuard, with no rate limiter
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '256kb' }), billingWebhook)
```

1. **Verify the signature:** `stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'),
   STRIPE_WEBHOOK_SECRET)`. It needs the raw `Buffer` and checks the timestamp tolerance (5 min). A
   bad signature gets a 400 and is counted; repeated failures raise an alert, since they usually
   mean a rotated or wrong secret.
2. **Dedupe:** upsert `payment_events { _id: event.id }`. Skip the event only if it has
   `processedAt`. An event without it is processed again, because a previous attempt may have
   crashed halfway and every handler is idempotent.
3. **Handle the event:**

   | Event | Action |
   |---|---|
   | `checkout.session.completed` | `payment_status: paid` → `fulfilOrder`; `unpaid` (async method) → order `pending` |
   | `checkout.session.async_payment_succeeded` | `fulfilOrder` |
   | `checkout.session.async_payment_failed` | order `failed` |
   | `checkout.session.expired` | order `expired` (only if it isn't already paid) |
   | `charge.refunded` | refund clawback (§6.6) |
   | `charge.dispute.created` | dispute clawback and billing hold (§6.6) |
   | `charge.dispute.closed` | won: restore; lost: keep the hold |
   | anything else | `ignored` |

   Refund and dispute events are matched to the order by `payment_intent` (`paymentId`, stored at
   fulfilment). They don't rely on metadata being copied onto the charge.
4. **Record and reply:** set `processedAt` and `result`, then return 200. An exception returns 500,
   and Stripe retries; live-mode events are retried for up to three days.

Logs carry the event id, type and order id only, never the payload, which holds names and emails.
nginx needs no change: `/api/` is already proxied, and Stripe events are far below the default
`client_max_body_size` of 1 MB.

### 6.6 Refunds and disputes

- **Refunds** are issued in the Stripe dashboard (an admin button can come later). With Managed
  Payments, Stripe may also refund a customer under its own policy, so the code always reacts to
  the event, whoever started the refund.
  - On `charge.refunded`: `target = ceil(credits × amountRefunded ÷ amountTotal)`. If `target >
    clawedBack`, compare-and-set `clawedBack` on the order, then apply `clawback:<orderId>:<target>`
    with `delta = −(target − previous)`. The order becomes `partially_refunded` or `refunded`.
    `amountRefunded` is cumulative, so replays and multiple partial refunds stay correct.
- **Disputes** (chargebacks):
  - `charge.dispute.created`: apply `dispute:<disputeId>` with `delta = −(credits − clawedBack)`, store
    that as `disputeClawback`, set `accounts.billingHold = true` and `disputeStatus: open`, and alert
    the owner. With the hold on, the account can't buy or spend credits; the free allowance keeps
    working.
  - Won: apply `dispute_won:<disputeId>` (+`disputeClawback`), and lift the hold if the account has
    no other open dispute.
  - Lost: the hold stays. The owner can lift it, or block the account.
- **Negative balance:** if the credits were already spent, the balance goes negative. Credit
  spending stops until a top-up brings it back above zero.

### 6.7 Reconciliation and recovery

The webhook is the fast path; these make it impossible to lose a paid order:

- **Return-page pull:** `GET /api/billing/orders/:id` (sign-in required; only the owner of the order)
  checks an order that is `open` or `pending`, more than 5 s old and not checked in the last 5 s.
  It calls `checkout.sessions.retrieve(sessionId, { expand: ['line_items'] })` and runs
  `fulfilOrder` if it is paid. A slow webhook can't leave a happy buyer staring at an old balance.
- **Daily reconciliation** (`server/billing/reconcile.ts`, at boot and every 24 h with
  `setInterval(…).unref()`, plus *Reconcile now* in the admin):
  - list Checkout Sessions completed in the last 72 h and run `fulfilOrder` for each of our orders
  - list refunds and disputes from the last 72 h through the same idempotent handlers
  - expire orders that are still `open` an hour past `expiresAt`, after a `retrieve`
  - run the credit sweep (§5.6)
  - alert on anything that needed fixing
- **One runner:** the job assumes a single API instance, as today. With the multi-region plan, add a
  lease document (`jobs { _id: 'billing-reconcile', leaseUntil }`) so only one region runs it.

### 6.8 Return page

- `success`: poll `GET /api/billing/orders/:id` every 1.5 s for up to 30 s, then show the processing
  message (§4.6). On `paid`, refetch `/api/usage/me`, show the new balance, and offer the
  `returnTo` word.
- `cancel`: show the message. Don't fetch the order; an unpaid session expires on its own.
- The query string is never trusted: credits come only from `fulfilOrder`.
- Auth0 state survives the round trip, since the SPA keeps its cache in `localStorage`. If the
  token is gone, the page asks the user to sign in, then resumes polling.

### 6.9 Extension

- **Top up** and **Verify email** open `/account/credits` on the website in a new tab. There is no
  payment UI inside the extension.
- The popup refetches `/api/usage/me` each time it opens, so a new balance shows up without a
  reload.
- *Top up* is shown only when `payments.enabled` is true. The store release (Phase 1) can therefore
  ship before payments go live.

### 6.10 Provider adapter

```ts
interface BillingProvider {
  readonly id: 'stripe'
  createCheckout(input: { order: PaymentOrder; pack: CreditPack; email?: string;
                          successUrl: string; cancelUrl: string }): Promise<{ sessionId: string; url: string; expiresAt: Date }>
  /** Verifies the signature (throws on failure) and normalizes the event. */
  parseWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): BillingEvent
  fetchCheckout(sessionId: string): Promise<CheckoutEvidence>
  listRecent(since: Date): Promise<{ checkouts: CheckoutEvidence[]; refunds: RefundEvidence[]; disputes: DisputeEvidence[] }>
  validatePrice(priceId: string): Promise<{ amount: number; currency: string; livemode: boolean; active: boolean }>
}

type BillingEvent =
  | { kind: 'paid' | 'pending' | 'failed' | 'expired'; eventId: string; evidence: CheckoutEvidence }
  | { kind: 'refunded'; eventId: string; evidence: RefundEvidence }       // cumulative amountRefunded
  | { kind: 'dispute_opened' | 'dispute_won' | 'dispute_lost'; eventId: string; evidence: DisputeEvidence }
  | { kind: 'ignored'; eventId: string; type: string }
```

Orders, fulfilment, clawbacks and reconciliation only see these normalized types. Phase 3 ships the
Stripe adapter only. A Paddle or Lemon Squeezy adapter would add a file, not a redesign.

### 6.11 Legal and account setup

These are owner tasks; the to-do doc has the checklist. This section isn't legal advice: check the
provider's merchant requirements and your local rules.

- **Stripe account:** business details, payout bank account, statement descriptor (e.g. `OPEN
  DICTIONARY`), customer support email, Managed Payments enabled and the product confirmed
  eligible.
- **Terms page** (`/terms`), covering:
  - the service
  - what a credit is: no cash value, non-transferable, no expiry while the service runs
  - prices and taxes
  - the refund policy (§4.5)
  - what happens to unused purchased credits if new-word generation is discontinued (proposed:
    refunded)
  - acceptable use
  - contact

  With Managed Payments, Stripe's reseller terms cover the purchase and yours cover the service.
- **Privacy policy:** a Payments section (Stripe processes the payment; this site receives the
  order id, amounts, tax, country and status, never card details). An account-usage section (new
  words generated while signed in are recorded against the account for 180 days, for limits and
  billing; orders and credit history are kept while the account exists). One more line: email
  verification status is read from Auth0. Update all four languages.
- **A support contact** on the Terms page, on the Credits page and in Stripe's receipt settings.

### 6.12 Abuse and fraud controls

- Buying requires a signed-in account with a verified email, and the checkout limits in §4.5. Card
  testers can't mass-create sessions, and Stripe's own fraud screening runs on the hosted page.
- The 10,000-credit balance cap and the 300-a-day credit-spend ceiling bound what one account can
  hold or burn.
- Disputes trigger a billing hold and a clawback (§6.6).
- The secret key is a **restricted key**: Checkout Sessions write; Prices, Charges, Refunds and
  Disputes read. It lives only in `server/.env`, like the other secrets.
- **Owner alerts:** dispute opened, mismatch, repeated webhook signature failures, a reconciliation
  that fixed something, and an order paid but not granted after 10 minutes.

---

## 7. Security & privacy

- **Identity** comes only from a verified `sub` (the existing rule). An invalid token is treated as
  anonymous, the least-privileged principal, and flagged through `authState`.
- **Email verification** is read from Auth0 by the server. A client can't claim it, and an error
  falls back to the smaller allowance.
- **Atomicity:** limits, budget reservations, balances and order transitions are single-document
  conditional updates, so they can't overshoot or double-apply. The budget's leeway is bounded by
  the gap between the estimate and the real cost of in-flight generations (§5.3).
- **Many accounts or IPs:** the free budget bounds total exposure regardless. Unverified accounts
  share their IP's allowance, and the anonymous share protects verified users' part.
- **IPv6:** anonymous counters are keyed by /64, so rotating addresses within one allocation doesn't
  multiply the allowance.
- **Payments:** hosted checkout, so no card data reaches this server (PCI SAQ A). Webhooks are
  verified against the raw body with a timestamp tolerance, and deduplicated. Credits are granted
  only from verified evidence that matches a server-side order bound to the buyer's `sub`, never
  from the redirect.
- **New data linkage, so the privacy policy must change** (§6.11):
  - generations by signed-in users are recorded against their account (word, time, cost) for 180
    days
  - orders and credit history are kept while the account exists
  - the email address is passed to Stripe to prefill checkout and is not stored here

  Also update the trust-boundary table in `docs/security.md`: translate becomes "public,
  optionally authenticated", and add the new billing webhook boundary.
- **Retention:** IP-keyed counters expire within 2 days. Ledger IPs expire with the ledger at 180
  days, matching the existing creator-IP rule. Orders and transactions hold no IP.
- **No owner lockout:** owner status comes from `ADMIN_USER_IDS`, admin routes stay exempt from the
  blocklist, and the owner is never metered.

## 8. Failure modes

| Failure | Behavior |
|---|---|
| Mongo unavailable | Metered principals get **no generation** (`503 generation_unavailable`, fail closed). The owner is unaffected. With Mongo down the cache is down too, so failing open would make every lookup a paid miss. Checkout and webhooks return 503/500; Stripe retries the webhook. |
| Vendor omits usage | Byte-based estimate, flagged, and visible on the Usage page. |
| Model has no price | Env fallback price and a warning. Payments can't be switched on while the metered model is unpriced. |
| Custom metered provider fails to build | The metered route uses the primary alone, with a warning on the Overview. It never uses the full setup. |
| Crash between reserve and settle | The user loses one unit, and the counters keep the estimate instead of the real cost. Rare and bounded. |
| Auth0 JWKS unreachable | Tokens fail verification and are treated as anonymous. The owner sees `authState: invalid`. |
| Auth0 Management API down or rate-limited | Verification can't be checked, so a user who isn't cached as verified gets the IP allowance for that request. Resend returns 503. Checkout fails with `verification_unavailable`. |
| Free budget runs out at 10:00 UTC | Free new words pause until 00:00 UTC. The owner, unlimited accounts and credit spending continue. |
| Monthly budget used up | Free new words pause until the 1st (00:00 UTC). With pacing this happens only on the last day or two of a month. |
| Stripe API down at checkout | `503 payments_unavailable`; the order is marked `error`; the UI says to try later. |
| Webhook not delivered (server down, Mongo down, bad deploy) | Stripe retries for up to three days. Meanwhile the return-page pull and the daily reconciliation fulfil the order. |
| Webhook secret wrong or rotated | Every event gets a 400, and an alert fires after a few failures. Credits still arrive through the pull and the reconciliation. |
| Paid session doesn't match its order | Status `mismatch`, no credits, owner alert. Resolve by refunding, or by granting credits manually. |
| Refund after the credits were spent | The balance goes negative; credit spending stops until it is positive again. |
| Checkout error codes | `verify_email_required`, `billing_hold`, `max_balance`, `too_many_checkouts`, `payments_disabled`, `payments_unavailable`, `unknown_pack` |
| Multi-region with standalone Mongo per region | Each region enforces its own budget, multiplying exposure by the number of regions. Keep metered traffic in one region, or divide the budgets, until the replica set exists. |

## 9. Configuration

Env vars set the defaults, and values saved in the admin portal override them (same as
`llm_settings`). Packs and the metered model are set only in the admin portal. **The allowance
defaults are starting points. Calibrate them in Phase 0.** The dollar budget is your decision
(§13).

| Env (`server/.env`) | Default | Meaning |
|---|---|---|
| `USAGE_ENFORCEMENT` | `shadow` | `off`, `shadow` or `on` |
| `USAGE_FREE_TIER_DAILY_USD` | `1.00` | Free budget per UTC day |
| `USAGE_FREE_TIER_MONTHLY_USD` | `5.00` | Free budget per UTC month |
| `USAGE_FREE_TIER_PACING` | `even` | `even` (spread the month) or `off` (first come, first served) |
| `USAGE_ANON_DAILY_PER_IP` | `5` | Free new words per IP (IPv6 /64) per UTC day, for anonymous and unverified users. `0` means sign in to generate. |
| `USAGE_ANON_SHARE` | `0.5` | Share of today's free budget that the IP allowance may use |
| `USAGE_USER_DAILY_FREE` | `20` | Free new words per UTC day for a verified account |
| `USAGE_PAID_DAILY_MAX_PER_ACCOUNT` | `300` | Credit-funded generations per account per UTC day |
| `LLM_DEFAULT_PRICE_IN_PER_MTOK` / `LLM_DEFAULT_PRICE_OUT_PER_MTOK` | unset | Fallback price for models with no price set in the admin portal |
| `USAGE_ALERT_WEBHOOK_URL` | unset | Optional POST target for budget and payment alerts |
| `BILLING_PROVIDER` | `none` | `stripe` turns the billing routes on; the admin switch then controls sales |
| `STRIPE_SECRET_KEY` | unset | Restricted key (`rk_test_…` or `rk_live_…`, §6.12) |
| `STRIPE_WEBHOOK_SECRET` | unset | Signing secret of the webhook endpoint (`whsec_…`) |
| `STRIPE_MANAGED_PAYMENTS` | `true` | Stripe as merchant of record. `false` only if you handle tax yourself (§6.1). |
| `BILLING_MAX_BALANCE` | `10000` | Highest balance a checkout may lead to |

`PUBLIC_BASE_URL` (existing) builds the success and cancel URLs.

**Provider-side backstop (no code needed):** also set a spend limit or budget alert in each LLM
provider's console, so a cap still holds if the app-level limits have a bug. If the metered model
has its own provider entry and API key (§4.4), give that key its own cap with headroom for paid
usage: the $5 free budget, plus expected paid generations, plus a margin. Then a hit cap can never
block you.

## 10. Rollout

| Phase | Ships | Exit criteria | Size |
|---|---|---|---|
| **0 · Measure** | Usage sink and `include_usage`; accounting for fusion, the merge and retries; price fields; counters, ledger and the meter in `shadow`; optional JWT on lookup routes, principals and verification; the web app sends tokens; `/api/usage/me`; a read-only admin Usage page | 1–2 weeks of data: cost per new word (p50/p95) per model, including the would-be single-model cost; daily spend owner vs. others; distinct generating IPs and accounts; would-deny counts at the defaults. Your web lookups show as `owner`. | ~3 days |
| **1 · Extension release** | Token on lookups; quota-aware errors and panels; the usage line in the popup; *Verify email* and *Top up* links (hidden until payments are on). Version 0.4.0. | Published in the store; your own browsers updated and signed in; your extension lookups show as `owner` | ~1–2 days + store review |
| **2 · Route & enforce** | Metered routing and owner Regenerate; pacing, anonymous share and verified allowance live; quota chip, panels and verify-email card; settings form and kill switch; Accounts tab (manual grants); privacy and security doc updates; then `enforcement=on` | You are never denied; free spend stays within $1/day and $5/month; strangers' entries come from the metered model | ~4 days |
| **3 · Payments** | Stripe setup; Terms and privacy pages; billing server (checkout, webhook, fulfilment, clawbacks, reconciliation); Credits page; Payments tab; tested end to end in test mode; then live | A real purchase and a real refund in live mode behave as designed; reconciliation finds nothing to fix | ~4–5 days + account and legal setup |
| **4 · Tune** | Calibrate from real data; retire `LlmBudget`; as-built notes | 2–4 weeks of enforcement and sales without surprises | ongoing |

**Ordering rules:**

1. The API accepts tokens (in shadow) **before** the web app sends them. Phase 0 deploys the API
   first, then the web.
2. Submit the extension release (Phase 1) as soon as the API contract in §5.7 is merged. It can be
   reviewed while Phase 0 collects data.
3. Turn on metered routing only after **your own** browsers run the new extension. Otherwise your
   extension lookups are routed as a stranger's.
4. Set `enforcement=on` after the release has been out a few days. Users who haven't updated count
   as anonymous, and their 429s show the existing "rate limited" message.
5. Payments go live only after Phase 2 has been enforcing calmly for at least a few days.

**Baseline before Phase 0:** today's activity log records lookups per tier but not who made them.
Admin → Activity shows the tier breakdown. For per-day numbers, run this on the host:

```bash
docker exec open-dictionary-mongo mongosh open-dictionary --quiet --eval '
db.activity_log.aggregate([
  { $match: { tier: "llm", ts: { $gte: new Date(Date.now() - 30 * 864e5) } } },
  { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } }, calls: { $sum: 1 }, ips: { $addToSet: "$ip" } } },
  { $project: { calls: 1, distinctIps: { $size: "$ips" } } }, { $sort: { _id: 1 } } ]).forEach(printjson)'
```

## 11. Testing

- **Pure unit tests,** table-driven, in the style of `abuseGuard.test.ts`:
  - the reserve decision for every combination of principal × verification × settings × counter
    state, including shadow mode
  - pacing: day 1, mid-month with rollover, the last day, 28/29/30/31-day months, `pacing=off`
  - the anonymous share; anonymous and unverified users sharing one IP allowance
  - UTC day and month keys at rollover; a generation that settles after midnight
  - IPv6 /64 keying; cost math, the reservation estimate and the token estimate
- **Store contract:** run the primitives against the in-memory store, with the same suite optionally
  pointed at `docker compose up -d mongo`:
  - 20 parallel reserves at a limit of 5, of which exactly 5 succeed
  - parallel cost reservations never pass the budget
  - settle replaces the estimate with the actual cost
  - the balance debit stops at 0 and with a billing hold
- **Verification:** each row of the §5.2 cache table; one Management API call per `sub` at a time;
  resend and refresh limits; an API error never stores `false`.
- **`translate.ts`:**
  - the leader is charged once, and joiners are free and get the leader's route
  - a denied leader leads the joiner to retry against its own quota
  - an LLM failure returns the unit but keeps the dollars
  - a denial writes nothing to the dictionary tier or the cache
  - fusion's late calls land in the same ledger doc
  - the `bad_response` retry is counted
  - a stream denial is a real 429, because no headers were sent yet
- **Routing:** owner and unlimited accounts → full; everyone else → metered; a metered route never
  builds fusion; a failed custom metered provider falls back to the primary; `same_as_owner` works;
  Regenerate replaces the entry and audits.
- **Billing** (Stripe SDK mocked; signatures from `stripe.webhooks.generateTestHeaderString`):
  - a bad signature → 400
  - a duplicate event → no second grant
  - an event that crashed halfway is processed again
  - webhook and return-page pull at the same time → exactly one grant
  - a line-item mismatch → `mismatch`, no credits
  - an async payment goes pending → paid, or pending → failed
  - an expired session
  - partial then full refund → the right cumulative clawback, also when replayed
  - dispute opened → clawback and hold; won → restore and lift
  - reconciliation fixes a missed webhook
  - checkout refuses an unverified email, a billing hold, the balance cap and the rate limits
  - a pack save is rejected for a test-mode price under a live key
- **Clients:**
  - `src/api/dictionary.test.ts`: a 429 body becomes `LookupError('quota_exceeded')` with its reason
    and actions, and the SSE `usage` event is handled
  - the Credits page states: success, polling, pending, cancel, errors
  - the extension's `lookupClient` tests (fakes in `testUtils.ts`): the token is attached and quota
    errors are mapped
- **End to end in Stripe test mode:** forward events with `stripe listen --forward-to
  localhost:3001/api/billing/webhook`, then:
  - card `4242 4242 4242 4242` succeeds
  - `4000 0025 0000 3155` requires authentication (3DS)
  - `4000 0000 0000 9995` is declined
  - `4000 0000 0000 0259` creates a dispute
  - cancel on the hosted page; let a session expire
  - stop the API during a payment, then restart it: reconciliation grants the credits
- **Manual smoke** after each deploy:
  - curl anonymously until denied
  - the owner token is never denied and gets the full setup
  - an unverified account gets the IP allowance, then the verified allowance after verifying
  - with the kill switch flipped, free users are cache-only, and the owner and credit holders still
    generate

## 12. Alternatives considered

- **Require sign-in for any generation** (anonymous = cache only): the simplest and strongest
  option, but it hurts the first visit. Rejected (decision 1). Config still supports it
  (`USAGE_ANON_DAILY_PER_IP=0`).
- **A fixed count for the anonymous pool** (the earlier draft's 100 a day): not tied to money. With
  a pricier model it could exceed the whole day's budget and starve verified users. Replaced by the
  dollar share (§4.3).
- **No pacing:** simpler, but with $1/day and $5/month, five busy days, or one scripted abuser,
  would shut free usage for the rest of the month. Pacing stays switchable (`pacing=off`).
- **`email_verified` as an access-token claim** (an Auth0 post-login Action): no runtime call, but
  it needs an Auth0 dashboard change, and the claim only updates when the token renews. In this
  app, forcing a renewal means iframe silent auth, which breaks where third-party cookies are
  blocked. The server-side check with a cache costs about one Management API call per account.
- **Fusion for everyone:** the best shared cache, but 3–4× the cost per new word. Rejected
  (decision 3); *Same as me* remains one click away.
- **Upgrade a stranger's entry automatically when the owner views it:** spends money with no
  explicit intent. A one-click Regenerate instead.
- **Credits that cost more on pricier models:** precise but confusing. 1 credit = 1 new word; the
  pack prices absorb the model choice.
- **Paddle or Lemon Squeezy:** good merchants of record, but a different checkout and webhook model.
  Kept possible through the adapter (§6.10).
- **Direct Stripe without a merchant of record:** lower fees, but tax registration and filing are
  yours. The fallback if Managed Payments isn't available.
- **Embedded checkout or Stripe Elements:** keeps users on the site, but needs Stripe.js, CSP and
  Permissions-Policy changes, and a wider PCI scope. Hosted redirect instead.
- **Custom top-up amounts:** fixed per-transaction fees make tiny amounts uneconomic, and packs map
  one-to-one onto Stripe Prices.
- **Subscriptions:** recurring billing, dunning and cancellations are too heavy for a hobby app.
  Prepaid packs instead.
- **Token or dollar quotas shown to users:** precise but confusing. Kept internal; users see credits.
- **BYOK (users bring their own API key):** costs you nothing, but you'd hold other people's keys
  (the AES-GCM in `server/admin/crypto.ts` could be reused), take on support, and their spend would
  fill the shared cache for everyone. Deferred.
- **Redis for counters:** extra infrastructure. Mongo single-document atomics are enough at this
  scale and already fit the multi-region plan.
- **Rolling 24 h windows** (like `LlmBudget`): smoother, but "resets in 3 h 12 m" is harder to
  explain than midnight UTC.
- **A pre-check read before streaming** (today's `canServeWithoutLlm()` pattern): an extra read on
  every metered lookup. Lazy SSE headers (§5.1) give the same clean 429 for free.

## 13. Decisions

Recorded 2026-11-12.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Anonymous generation? | **Yes**, without sign-in: 5 new words per IP per day, within an anonymous share of the day's free budget | §4.2, §4.3, §5.3 |
| 2 | Free-tier budget? | **$1.00 per day and $5.00 per month**, paced across the month | §4.3, §9 |
| 3 | Which model answers strangers? | **One model**, not fusion. Default: the primary of your active pair; configurable. You keep fusion and get Regenerate. | §4.4, §5.4 |
| 4 | Payments? | **Real checkout** with prepaid top-ups: Stripe Checkout with Managed Payments as merchant of record | §4.5, §6 |
| 5 | Verified email for the signed-in free allowance? | **Yes.** Unverified accounts get the anonymous allowance. Also required for buying (design choice, §4.5). | §4.2, §5.2 |
| 6 | Credit spending during a free-budget pause? | **Yes**, within the 300-a-day ceiling per account | §4.2, §5.3 |

**Defaults this design chose** (all adjustable in Admin → Usage, with no deploy):

- 5 free new words per IP per day; the anonymous share is 50 % of today's budget
- 20 free new words per verified account per day
- pacing `even`
- 300 credit-funded generations per account per day
- packs of 500 / $5, 1,200 / $10 and 3,000 / $20
- a 10,000-credit balance cap
- credits never expire
- refunds of unused credits within 14 days

**Still to settle during setup** (none of these block the build):

1. **The metered model:** a budget-class model, confirmed with Phase 0 cost data (§0, §5.5).
2. **Stripe eligibility:** whether Managed Payments is available for your country and product. If
   it isn't, choose Paddle or Lemon Squeezy, or direct Stripe with your own tax setup (§6.1).
3. **Final pack prices** once the real cost per new word is known (§6.2).
4. **Wording of the Terms, the refund policy and the privacy text,** plus a support email address
   (§6.11).

## 14. Implementation map

| Area | Files |
|---|---|
| Metering core | New `server/usage/{principal,meter,store,pricing,settings,verification,router}.ts`; `server/db.ts` (collections and indexes) |
| Lookup path | `server/translate.ts` (router param, meter hook, joiner retry, settle at release, lazy SSE headers, `usage` event, `X-Generation`); `server/moreExamples.ts`; `server/abuseGuard.ts` (owner exemptions); `server/app.ts` (`optionalJwt`, limiter order, usage router); `buildEntryCreator` (add `sub`) |
| Usage plumbing | `server/providers/llm/{types,translateFlow,fusion,openaiCompat,anthropic,responses}.ts` |
| Model routing | `server/llm/service.ts` (`currentMetered()`, `status().metered`); `server/admin/providersRepo.ts` (`llm_settings.metered` and pricing validation); `server/admin/router.ts` (`PUT /llm/active`, `POST /entries/regenerate`); `src/components/admin/ActiveSwitcher.tsx` |
| Billing | New `server/billing/{provider,stripe,orders,fulfil,webhook,router,reconcile}.ts`; `server/app.ts` (raw-body webhook before `express.json()`, billing router); `server/index.ts` (reconcile and sweep timers); `package.json` (`stripe`) |
| Config | `server/config.ts`, `server/.env.example`, the README env table |
| Admin | `server/admin/{router,usage,accounts,billing}.ts`; `src/pages/admin/Usage.tsx` (Usage, Accounts and Payments tabs); `AdminLayout.tsx` nav; `ProviderForm.tsx`; `Clients.tsx`; `Entries.tsx` (filter); `Overview.tsx` (banners); `src/api/admin.ts` |
| Web | `src/api/{dictionary,moreExamples,usage,billing}.ts`; `src/hooks/{useDictionary,useUsage}.ts`; new `src/components/{UsageChip,QuotaPanel,VerifyEmailCard,PackCard}.tsx`; new `src/pages/{CreditsPage,TermsPage}.tsx`; `src/App.tsx` (routes); `Header.tsx` and `AuthButton.tsx` (links); `WordPage.tsx`; `WordEntry.tsx` (Regenerate); `MoreExamplesButton.tsx`; `PrivacyPage.tsx`; `src/i18n/translations.ts` |
| Extension | `extension/src/background/lookupClient.ts`; `extension/src/shared/messages.ts` (`quota_exceeded`); `ResultCard.tsx`; `Popup.tsx` (usage line, links); the version in `manifest.json`; the data disclosures in `STORE_LISTING.md`; a store release following `extension/RELEASE.md` |
| Docs | This file (add as-built notes); `docs/security.md` (trust boundary, webhook); `design-llm-abuse-guard.md` §7 (the global-budget follow-up is now covered); `to-do-llm-usage-quotas.md` |

## 15. As built (2026-11-12)

Phases 0–2 are implemented in one change: metering, optional sign-in on
lookups, the tiers and the paced budget, the metered model, admin controls,
and extension 0.4.0. **Nothing is deployed or switched on yet**; the
deployment steps are in the to-do doc.

**Deferred by decision (2026-11-12): payments, top-ups and credits.** With very
few users, the Stripe setup isn't worth it yet. Phase 3 (§6) is not
implemented, and neither is the credit balance, whose only other source would
have been manual grants. Consequences:

- A verified account that has used its daily allowance is refused
  (`user_daily`, next step `wait`). There is no balance to fall back to, so
  there is no `balance` source, no `paid_daily_max` reason, and no
  `buy_credits` action. `/api/usage/me` has no `balance` or `payments` field.
- To give a friend more, raise their **daily allowance** or set their plan to
  **unlimited** in Admin → Usage & budget → Accounts. An unlimited account
  gets the owner's full setup and no limits.
- The extension's *Top up* link and the web Credits and Terms pages aren't
  built.

**Where the code differs from the text above:**

| Topic | As built |
|---|---|
| Metered model setting | Its own route, `PUT /api/admin/llm/metered { mode, providerId?, modelId? }`, rather than a `metered` field on `PUT /llm/active`. It is stored in `llm_settings.metered`. The selector sits under the active-provider switcher on the Overview. |
| Entries filter | **Single-model only**: LLM entries whose `generatedBy` isn't a fusion merge. That is what Regenerate fixes, and it works for entries created before accounts were recorded, where "generated by others" couldn't be computed. |
| Entry creator | `createdBy.sub` is stored for signed-in creators. The 180-day expiry job removes it with the IP. |
| Clients page | Unchanged: it has no account column. Usage & budget lists the top accounts and IPs (7 days) from the ledger instead. |
| Default price | When `LLM_DEFAULT_PRICE_*` is unset, an unpriced model is charged $1 / $4 per million tokens. That is deliberately high for budget models, so a forgotten price makes the budget stricter, not looser. Unpriced models are listed on Usage & budget and the Overview. |
| `/api/usage/me` | Adds `verifiedLimit`, the verified allowance, for anonymous and unverified callers, so the UI can say "Sign in for 20 a day". |
| Refusal counts | `usage_counters` keys `d:<day>/denied:<reason>`, kept 35 days, feed the Refusals table. They count would-be refusals in shadow mode too. |
| Owner | Also exempt from the bot-UA refusal, not only from the limits. |
| Regenerate | `POST /api/admin/entries/regenerate`. If the fresh generation fails, the previous entry is written back, so a failure never leaves a dictionary-tier fallback cached. |
| Verified allowance | `dailyAllowance` (the admin override) applies only to verified accounts. Unverified accounts always share their IP's allowance. |
| Rate-limit keys | The per-minute limiters key anonymous traffic by IP /64, which is stricter than the previous full IPv6 address. |

**Code map:**

- Server: `server/usage/{types,windows,principal,settings,pricing,store,verification,meter,alerts,http,router,index}.ts`; `server/admin/usage.ts`.
- LLM tier: `server/providers/llm/usage.ts` (per-call tracking).
- Admin UI: `src/pages/admin/Usage.tsx`; `src/components/admin/MeteredSwitcher.tsx`.
- Web: `src/api/usage.ts`; `src/hooks/{useAccessToken,useUsage}.ts`; `src/components/{UsageChip,QuotaPanel,VerifyEmailCard}.tsx`.
- Tests: `server/usage/*.test.ts`; `server/translate.usage.test.ts`; `server/providers/llm/usage.test.ts`; the metered-route cases in `server/llm/service.test.ts`; the quota cases in `src/api/dictionary.test.ts` and `extension/src/background/lookupStream.test.ts`.

