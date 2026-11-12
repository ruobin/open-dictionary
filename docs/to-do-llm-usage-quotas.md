# To-Do: LLM usage tiers, quotas & paid credits

Derived from [`design-llm-usage-quotas.md`](./design-llm-usage-quotas.md); its decisions were
recorded on 2026-11-12 (§13). The phases match its §10, and the app keeps working if you stop
after any phase. **(you)** marks account, dashboard and legal steps that happen outside the code.

**Verify** root changes with `npm run typecheck`, `npm test` and `npm run build`. Verify extension
changes with `npm run ext:test`, `npm run ext:build` and `npx tsc --noEmit -p extension/tsconfig.json`.
**Deploy** with `npm run deploy:api` / `npm run deploy:web`, never `npm start`. The web deploy must
keep build → `prerender:prod` → `rsync --delete`.

**Status (2026-11-12):** the code for Phases 0–2 is done and tested (design §15). Nothing is
deployed yet, so the open items in those phases are your account, deploy and switch-on steps.
Phase 3 (payments) is **deferred**: with very few users the Stripe setup isn't worth it yet, and
credits are deferred with it. To give a friend more, raise their daily allowance or make their
account unlimited in Admin → Usage & budget → Accounts.

## Deploy runbook (this host)

Production is the compose stack in this checkout (`open-dictionary-api`, `open-dictionary-mongo`)
behind host nginx. The web root `/var/www/html/dict.ai-dictionary.org` serves both
dict.ai-dictionary.org and ai-dictionary.org. Run everything from `/root/workspace/open-dictionary`
once the PR is merged. Nothing needs a new env var: the defaults are the decided ones ($1/day,
$5/month, shadow mode).

1. **Update the checkout and verify it:**
   ```bash
   git checkout main && git pull --ff-only
   npm ci && npm run typecheck && npm test && npm run build
   ```
2. **Make rollback points** (same pattern as the 2026-10-30 deploys in `/root/ops/nginx/README.md`):
   ```bash
   STAMP=$(date +%Y%m%d)
   docker tag open-dictionary-api:latest open-dictionary-api:rollback-$STAMP
   mkdir -p /root/ops/nginx/backup-$STAMP
   cp -a /var/www/html/dict.ai-dictionary.org /root/ops/nginx/backup-$STAMP/webroot
   BACKUP_KEEP_N=2 /usr/local/bin/open-dictionary-backup.sh   # fresh Mongo dump, keeps last week's too
   ```
3. **API first** (it must accept tokens before the web app sends them): `npm run deploy:api`, then:
   ```bash
   docker logs --since 5m open-dictionary-api 2>&1 | grep -E '\[usage\]|\[mongo\]|\[llm\]'
   #   expect: [usage] enforcement=shadow freeTier=on budget=$1/day $5/month pacing=even ...
   curl -s https://dict.ai-dictionary.org/health
   curl -s -A 'Mozilla/5.0' https://dict.ai-dictionary.org/api/usage/me
   #   expect: {"authState":"anonymous","enforcement":"shadow","tier":"anon",...}
   ```
   nginx refuses non-browser user agents on `/api/`, hence the `-A`.
4. **Web:** `npm run deploy:web` (build → prerender → rsync). Then check
   `https://dict.ai-dictionary.org/word/hello` (prerendered) and `/sitemap.xml`. Sign in on the
   site, look up a word that isn't cached yet, and check Admin → Usage & budget: the new word is
   listed under "You".
5. **Admin settings:**
   - **Providers → Edit:** enter the $/M input and output price of every model in use.
   - **Overview → "Everyone else uses":** the default, *Primary model only*, is live from step 3.
     Your current extension (0.3.0) sends no login, so its lookups count as a stranger's and get
     the single model. Choose *Same as me* until 0.4.0 is on your browsers if that matters to you.
   - **Usage & budget:** optionally set the alert webhook.
6. **Extension 0.4.0:** `extension/open-dictionary-extension-v0.4.0.zip` is built with
   `npm --prefix extension run build:prod` and zipped as in `extension/RELEASE.md` §2. Do the
   §3 checks, upload, and once it's approved, update your own browsers and sign in.
7. **Later (1–2 weeks of shadow data):** check Usage & budget (cost per new word, would-be
   refusals), then set **Enforcement: on** there.
8. **Log it:** append a dated entry to `/root/ops/nginx/README.md` (where open-dictionary deploys
   are logged), naming the rollback tag and the web-root backup.

**Rollback:**
- API: `docker tag open-dictionary-api:rollback-$STAMP open-dictionary-api:latest && docker compose up -d api`
- Web: `rsync -a --delete /root/ops/nginx/backup-$STAMP/webroot/ /var/www/html/dict.ai-dictionary.org/`
- Data: nothing to undo. The change only adds collections (`usage_counters`, `usage_ledger`,
  `accounts`, `usage_settings`, `usage_alerts`) and optional fields (`llm_settings.metered`,
  `llm_providers.models[].pricing`), which the old code ignores.
- Without a rollback: Usage & budget → Enforcement **off** stops all counting and refusals, and
  "Everyone else uses" → *Same as me* puts everyone back on the full setup.

## Before Phase 0: baseline and choices

- [ ] **(you)** Run the baseline query (design §10) on the host. Note the generations per day and
      the distinct IPs per day over the last 30 days.
- [ ] **(you)** Write down the real input and output prices of every model in use: primary,
      secondary, and the candidates for the metered model.
- [ ] **(you)** Shortlist a budget-class metered model (about $0.002 per new word, design §0).
- [ ] **(you)** Set a spend limit or budget alert in each LLM provider's console (design §9).
- [ ] **(you)** Check whether Stripe Managed Payments is available for your country and for this
      product (design §6.1). This only decides Phase 3, so it doesn't hold up the earlier phases.

## Phase 0: Measure (server and web, `enforcement=shadow`)

This phase blocks and reroutes nothing. It records who generates what, and what it costs.

### 0.1 Usage plumbing in the LLM tier (design §5.5)

- [x] `server/providers/llm/types.ts`: add the `UsageSink` type, `LlmTranslateOptions.usage` and
      `LlmMoreExamplesResult.meta`.
- [x] `translateFlow.ts`: pass the sink to the core and extras calls. Record the discarded
      `bad_response` attempt instead of dropping its `meta`.
- [x] `fusion.ts`: hand the sink to both providers and to `fuse()`, so the slower provider and the
      merge are recorded even though they finish after the response.
- [x] `openaiCompat.ts`:
  - [x] Send `stream_options: { include_usage: true }` on streamed Chat Completions.
  - [x] On a 400 that rejects it, remember that per provider and stop sending it (the same
        step-down as `requestVariants.ts`).
  - [x] Return usage from `moreExamples`.
- [x] `anthropic.ts`, `responses.ts`: report usage for every attempt, retries included.
- [x] When a vendor reports nothing, fall back to the byte-based estimate, flagged
      `estimated: true`.
- [x] Tests:
  - [x] each transport reports usage
  - [x] a fusion lookup records 5 calls (2 × core and extras, plus `fuse`) with the right kinds
  - [x] the retry is counted
  - [x] the estimate is used and flagged when usage is missing

### 0.2 Prices (design §5.5)

- [x] `server/admin/providersRepo.ts`: optional `models[].pricing { inputUsdPerMTok,
      outputUsdPerMTok }`, validated as finite, at least 0, and below a sane upper bound.
- [x] `src/components/admin/ProviderForm.tsx`: price fields per model.
- [x] `server/usage/pricing.ts`:
  - [x] a price map keyed by provider id (`llm:<vendor>:<model>`), rebuilt on `reloadFromDb()`
  - [x] the `LLM_DEFAULT_PRICE_IN/OUT_PER_MTOK` fallback, with a warning
  - [x] integer micro-USD math
  - [x] the reservation estimate: 1.25 × the 7-day p95, with the token-based estimate until there
        is data
- [x] Tests: cost math, the fallback, the estimate.
- [ ] **(you)** After the deploy, enter the real price of every model in the admin portal.

### 0.3 Store, settings and meter (design §5.3, §5.6)

- [x] `server/usage/store.ts`: the `UsageStore` interface with Mongo and in-memory implementations;
      `tryIncrement`, `tryReserveCost` and `add` (increments and undos). The balance debit and credit
      are *(deferred with payments and credits, 2026-11-12)*.
- [x] `server/db.ts`: create `usage_counters` (TTL on `expiresAt`), `usage_ledger` (180-day TTL and
      its indexes), `accounts` and `usage_alerts`. `usage_settings` needs no index;
      `credit_transactions` is *(deferred with payments and credits, 2026-11-12)*.
- [x] `server/usage/settings.ts`: env defaults (design §9) plus DB overrides, refreshed every 30 s.
- [x] `server/config.ts` and `server/.env.example`: the `USAGE_*` variables, including
      `USAGE_FREE_TIER_DAILY_USD=1.00` and `USAGE_FREE_TIER_MONTHLY_USD=5.00`.
- [x] `server/usage/meter.ts`:
  - [x] `reserve()`: pacing, the anonymous share, the verified allowance, the IP allowance and
        shadow mode. The paid ceiling and the balance are *(deferred with payments and credits, 2026-11-12)*
  - [x] `Ticket.settle()`: the user is charged only for an LLM answer; the dollars are always
        settled
  - [x] `QuotaDeniedError`
  - [x] best-effort ledger writes
- [x] Tests:
  - [x] the reserve decision table (principal × verification × settings × counters, shadow mode
        included)
  - [x] pacing: day 1, rollover, the last day, 28/29/30/31-day months, `pacing=off`
  - [x] the anonymous share; anonymous and unverified users sharing one IP allowance
  - [x] store contract: 20 parallel reserves at a limit of 5 give exactly 5; cost reservations never
        pass the budget; settle replaces the estimate with the actual cost (no balance debit:
        *(deferred with payments and credits, 2026-11-12)*)

### 0.4 Identity and email verification (design §5.2)

- [x] `server/app.ts`: build `optionalJwt` next to `checkJwt`, and pass it to the translate,
      more-examples and usage routers.
- [x] `server/usage/principal.ts`: `resolvePrincipal`; `authState` (`invalid` when the header is
      present but `req.auth` isn't); IPv6 /64 `ipKey`.
- [x] Move `translateLimiter` after `optionalJwt`, `skip` the owner, and key signed-in users by
      `sub`.
- [x] `server/abuseGuard.ts`: `LlmBudget` skips the owner.
- [x] `server/usage/verification.ts`:
  - [x] the cache rules: verified is trusted for 7 days, unverified for 10 minutes
  - [x] a 1.5 s timeout, one check per `sub` at a time, and at most 5 calls/s per process
  - [x] never store `false` after an error
  - [x] resend (`mgmt.jobs.verifyEmail`, at most once per 10 minutes and 5 times a day per
        account) and refresh (once per minute per account)
- [ ] **(you)** Confirm that the Auth0 machine-to-machine application behind
      `AUTH0_MGMT_CLIENT_ID` has the `read:users` and `update:users` grants.
- [x] `buildEntryCreator`: add the signed-in user's `sub`, so the Admin → Entries "Added by" column
      shows the account.
- [x] Tests: principal resolution, /64 keying, every row of the verification cache table, the rate
      limits.

### 0.5 Lookup integration (design §5.1, §5.3)

- [x] `server/translate.ts`:
  - [x] `translate()` takes an `LlmRouter`. Until Phase 2 both routes return `current()`.
  - [x] Add the `meter` hook between Tier 0 and Tier 1. `QuotaDeniedError` skips the cache write
        and the dictionary tier.
  - [x] On `QuotaDeniedError`, a joiner retries with its own hooks.
  - [x] Call `ticket.settle()` at release, after `Promise.allSettled(background)`.
  - [x] Lazy SSE headers: no `flushHeaders()` before the first event, so a denial is a plain 429
        with a JSON body and `Retry-After`.
  - [x] Send `event: usage` before `done`, and `X-Generation: charged` on the JSON route.
  - [x] Stop `recordLlmSpend()` from counting joiners.
- [x] `server/moreExamples.ts`: the same meter (`action: 'examples'`) and router, after its cache
      check.
- [x] Tests: the `translate.ts` list in design §11.

### 0.6 Usage API (design §5.7)

- [x] `server/usage/router.ts`:
  - [x] `GET /api/usage/me` (optional auth, `apiLimiter`), with the free-tier state cached for 10 s
  - [x] `POST /api/usage/verify-email/resend` and `POST /api/usage/verify-email/refresh`
- [x] Tests: the response shape for each tier (owner, exempt, verified, unverified, anonymous).
- [x] **Freeze the contract** (the `/api/usage/me` shape, the 429 body, the `usage` event). Phase 1
      builds on it.

### 0.7 The web app sends tokens (design §5.2)

- [x] `src/api/dictionary.ts`:
  - [x] an optional `getToken` on `lookupWord` and `lookupWordStream`
  - [x] a 429 `quota_exceeded` body becomes `LookupError('quota_exceeded')`, carrying `reason`,
        `actions` and `resetAt`
  - [x] handle the SSE `usage` event
- [x] `src/hooks/useDictionary.ts`: pass `getAccessTokenSilently` when signed in, and hold the first
      lookup until Auth0's `isLoading` clears (at most about 1 s).
- [x] `src/api/moreExamples.ts`: send the token too.
- [x] `src/api/dictionary.test.ts`: the token is attached, the 429 is mapped, and the `usage` event
      is handled.

### 0.8 Read-only admin Usage page (design §5.8)

- [x] `server/admin/usage.ts` and the route `GET /api/admin/usage/summary?days=30`.
- [x] `src/pages/admin/Usage.tsx`:
  - [x] gauges for today's paced budget, the month and the anonymous share
  - [x] spend by source and route
  - [x] cost per new word by model, including the would-be single-model cost
  - [x] would-deny counts
  - [x] top consumers
- [x] Wire it up: `AdminLayout.tsx` nav (Analytics) and `src/api/admin.ts`.

### 0.9 Deploy and observe

- [ ] Set `USAGE_ENFORCEMENT=shadow` and the other `USAGE_*` defaults in the production
      `server/.env`.
- [ ] Run `npm run deploy:api` first, then `npm run deploy:web` (the API must accept tokens before
      the web app sends them, design §10 rule 1).
- [ ] Smoke tests:
  - [ ] your own web lookup of a new word appears as `owner` in the ledger
  - [ ] an anonymous `curl` appears as `anon`
  - [ ] nothing is denied
- [ ] **Exit check**, after 1–2 weeks. You have:
  - [ ] p50/p95 cost per new word per model, including the single-model cost
  - [ ] daily spend, owner vs. others
  - [ ] distinct generating IPs and accounts
  - [ ] would-deny counts at the defaults

  If the defaults would often deny real people, adjust them.

## Phase 1: Extension release 0.4.0

Start as soon as the 0.6 contract is merged, so the store review runs while Phase 0 collects data.

- [x] `extension/src/background/lookupClient.ts`: add `Authorization: Bearer <token>` whenever
      `getAccessToken()` returns one, on lookups and the stream port. The extension has no "more
      examples".
- [x] `extension/src/shared/messages.ts`: a `quota_exceeded` error code that carries `reason`,
      `actions` and `resetAt`.
- [x] `ResultCard.tsx`: a panel per reason (design §4.6) with an "Open on the website" link. In the
      popup, **Sign in** calls `login()`.
- [x] `Popup.tsx`:
  - [x] a usage line from `/api/usage/me`, refetched each time the popup opens
  - [x] **Verify email** opens the website, which has the verify card. **Top up** is
        *(deferred with payments and credits, 2026-11-12)*.
- [x] Tests with the Chrome fakes in `testUtils.ts`: the token is attached when signed in (and not
      when signed out), and the 429 body is mapped.
- [x] Bump `manifest.json` to 0.4.0, and review the data disclosures in `STORE_LISTING.md`.
- [ ] **(you)** Build with `npm --prefix extension run build:prod` and follow `extension/RELEASE.md`
      (`npm run ext:build` already passes).
- [ ] **(you)** Submit to the store. Once it is approved, update the extension on each of your
      browsers and sign in.
- [ ] **Exit check:** your extension lookups appear as `owner` in the ledger.

## Phase 2: Route and enforce

### 2.1 Metered routing (design §4.4, §5.4)

- [x] `server/admin/providersRepo.ts`: `llm_settings.metered { mode, providerId?, modelId? }` with
      validation. A change bumps `configVersion`.
- [x] `server/llm/service.ts`:
  - [x] keep the bare primary and build the metered provider for each mode
  - [x] add `currentMetered()`
  - [x] a custom provider that fails to build falls back to the primary, with a warning
  - [x] add `status().metered`
- [x] `server/admin/router.ts`: as built, its own route `PUT /api/admin/llm/metered` (design §15);
      audited as `llm.metered.update`.
- [x] `src/components/admin/ActiveSwitcher.tsx`: the *Everyone else uses* selector. The Overview
      shows the metered model and any warning.
- [x] `server/translate.ts` and `server/moreExamples.ts`: the router returns `current()` for `full`
      and `currentMetered()` for `metered`; the ticket decides which.
- [x] Tests:
  - [x] the owner and unlimited accounts get `full`; everyone else gets `metered`
  - [x] the metered route never builds fusion
  - [x] a failed custom provider falls back to the primary
  - [x] `same_as_owner` works
- [ ] **(you)** Optional: create a separate provider entry with its own API key for the metered
      model, and give that key a vendor-side cap (design §9).

### 2.2 Owner Regenerate (design §5.4)

- [x] `POST /api/admin/entries/regenerate { word, sourceLang, targetLang }`:
  - [x] delete the current-version cache doc
  - [x] run `translate()` as the owner (route `full`) and return the entries
  - [x] audit it as `entry.regenerate`
- [x] `/api/usage/me` returns `fullModels` for the owner.
- [x] `src/components/WordEntry.tsx`: show *Regenerate with my setup* next to the footnote, to the
      owner only, when `generatedBy.models` differs from `fullModels`. After it succeeds, clear the
      word's `dict:v1:` localStorage key and re-render.
- [x] `src/pages/admin/Entries.tsx`: as built, a **Single-model only** filter, meaning LLM entries
      not produced by a fusion merge (design §15).
- [x] Tests: the entry is replaced, the audit row is written, and the route is owner-only.

### 2.3 Web quota UX (design §4.6)

- [x] `src/api/usage.ts` and `src/hooks/useUsage.ts`: refetch after `X-Generation: charged` or a
      `usage` event.
- [x] `src/components/UsageChip.tsx` next to `AuthButton`, following the visibility rules.
- [x] `src/components/QuotaPanel.tsx` on `WordPage.tsx`: one message and set of buttons per reason.
      Store `returnTo` for the top-up return.
- [x] `src/components/VerifyEmailCard.tsx`: Resend, I've verified, and a re-check when the tab
      regains focus.
- [x] `authState: "invalid"` shows a "sign in again" prompt.
- [x] `MoreExamplesButton.tsx`: the same reasons, inline.
- [x] `src/i18n/translations.ts`: every new string in en, zh, ja and es.

### 2.4 Admin controls (design §4.3, §5.8)

- [x] `GET|PUT /api/admin/usage/settings` and the settings form on the Usage page:
  - [x] the fields: enforcement, kill switch, pacing, budgets, allowances, anonymous share, the
        alert webhook (there is no paid ceiling without credits)
  - [x] audit saves as `usage.settings.update`
- [x] Alerts at 50, 80 and 100 % of the month, and once a day when today's budget runs out: a log
      line, an Overview banner, and the optional `USAGE_ALERT_WEBHOOK_URL`.
- [x] Accounts tab:
  - [x] search by email (through the Management API) or by sub
  - [x] set plan, status, the allowance override and a note (the email is looked up from Auth0 when
        a row is opened)
  - [x] show today's use and the last 7 days' new words and cost
  - [x] audit `account.update`
  - [ ] grant or adjust credits, the billing hold, and a transaction history *(deferred with payments and credits, 2026-11-12)*
- [ ] A boot sweep for unapplied credit transactions *(deferred with payments and credits, 2026-11-12)*
- [ ] `Clients.tsx`: the account next to the IP. Not built; Usage & budget lists the top accounts and
      IPs instead (design §15).

### 2.5 Docs and privacy (design §7)

- [x] `src/pages/PrivacyPage.tsx` and the `privacy.*` copy in all four languages: generations are
      recorded against the account for 180 days, and verification status is read from Auth0.
- [x] `docs/security.md`: translate becomes "public, optionally authenticated".
- [x] `docs/design-llm-abuse-guard.md` §7: point the global-budget follow-up to this design.
- [x] The README env table.

### 2.6 Turn it on

- [ ] Recalibrate the allowance defaults from the Phase 0 data (Admin → Usage).
- [ ] Deploy: `deploy:api` first, then `deploy:web`.
- [ ] **(you)** Pick the metered model in the switcher (default *Primary model only*) and check the
      Overview.
- [ ] Once the 0.4.0 extension has been out for a few days, set `enforcement=on` in Admin → Usage.
- [ ] Smoke tests (the manual list in design §11):
  - [ ] an anonymous `curl` gets a 429 after 5 new words
  - [ ] you are never denied, and you get the full setup
  - [ ] an unverified account gets the IP allowance, and 20 a day after verifying
  - [ ] the kill switch works
  - [ ] the budget gauge shows the paced number
- [ ] **Exit check**, after 1–2 weeks:
  - [ ] you were never denied
  - [ ] free spend stayed within $1 a day and $5 a month
  - [ ] strangers' new entries show the metered model under "Generated by"

## Phase 3: Payments

**Deferred (2026-11-12).** Kept as the plan for when paying users are worth the setup. Nothing in this
phase is built.

### 3.1 Business and legal setup

- [ ] **(you)** Stripe account:
  - [ ] business details, payout bank account, statement descriptor (e.g. `OPEN DICTIONARY`) and
        support email
  - [ ] enable Managed Payments and confirm the product category is eligible
  - [ ] if it isn't available, choose Paddle or Lemon Squeezy, or direct Stripe (design §6.1), and
        revisit 3.2
- [ ] **(you)** In both test and live mode, create the Product "Open Dictionary credits" with
      tax-inclusive Prices for the three packs (design §4.5, §6.2).
- [ ] **(you)** Create the webhook endpoint `https://dict.ai-dictionary.org/api/billing/webhook`
      with the 7 events listed in design §6.5. Copy the test and live signing secrets.
- [ ] **(you)** Create a restricted API key: Checkout Sessions write; Prices, Charges, Refunds and
      Disputes read.
- [ ] **(you)** Write the Terms (including the Credits section and the refund policy), the privacy
      additions, and the support contact (design §6.11). This isn't legal advice; check the
      provider's requirements.

### 3.2 Server billing core (design §6.3–§6.7, §6.10)

- [ ] Add `stripe` to `package.json`, and pin an API version that supports `managed_payments`.
- [ ] `server/billing/provider.ts`: the `BillingProvider` interface and the normalized event types.
- [ ] `server/billing/stripe.ts`:
  - [ ] `createCheckout`, with an idempotency key
  - [ ] `parseWebhook`, with `constructEvent`
  - [ ] `fetchCheckout`, expanding `line_items`
  - [ ] `listRecent` and `validatePrice`
- [ ] `server/billing/orders.ts`: `payment_orders` and its state machine. In `server/db.ts`, add the
      indexes and `payment_events` with a 400-day TTL.
- [ ] `server/billing/fulfil.ts`:
  - [ ] `fulfilOrder`: validate, claim, then grant exactly once
  - [ ] the cumulative refund clawback
  - [ ] the dispute clawback and restore, and the billing hold
- [ ] `server/billing/webhook.ts`:
  - [ ] mount it in `server/app.ts` **before** `express.json()` and `blocklistGuard`, with
        `express.raw({ type: 'application/json', limit: '256kb' })`
  - [ ] check the signature, and dedupe on `processedAt`
  - [ ] handle the events in the design §6.5 table
  - [ ] return 500 on errors, so Stripe retries
- [ ] `server/billing/router.ts`:
  - [ ] `POST /api/billing/checkout`, with every check and limit from design §6.3 and the error
        codes from design §8
  - [ ] `GET /api/billing/orders`
  - [ ] `GET /api/billing/orders/:id`: only the order's owner may read it; it also does the
        return-page pull
- [ ] `server/billing/reconcile.ts` and a timer in `server/index.ts` (at boot and every 24 h,
      `.unref()`), plus the admin route `POST /api/admin/billing/reconcile`.
- [ ] Config: `BILLING_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
      `STRIPE_MANAGED_PAYMENTS` and `BILLING_MAX_BALANCE`, in `server/config.ts` and
      `server/.env.example`.
- [ ] Payment alerts (design §6.12).
- [ ] Tests: the billing list in design §11.

### 3.3 Web top-up (design §4.6, §6.8)

- [ ] `src/api/billing.ts`.
- [ ] `src/pages/CreditsPage.tsx` at `/account/credits`:
  - [ ] balance, today's allowance, the verify-email card, a `PackCard` grid, order history
  - [ ] the return states: success (poll every 1.5 s for up to 30 s), pending, cancel, errors
  - [ ] the `returnTo` button
- [ ] Start checkout with `fetch` and then `location.assign(url)`. Never use a form post, because of
      the CSP's `form-action`.
- [ ] `src/pages/TermsPage.tsx` at `/terms`.
- [ ] Routes in `src/App.tsx`; links in `Header.tsx` (next to Privacy) and `AuthButton.tsx`
      (Credits); a Top up button in `QuotaPanel` and `UsageChip`.
- [ ] The privacy page's Payments section, in all four languages.
- [ ] i18n for every new string.

### 3.4 Admin Payments tab (design §5.8, §6.2)

- [ ] An orders list with a status filter, mismatches and disputes; revenue (gross, refunds,
      estimated fees).
- [ ] A packs editor, validated with `validatePrice`. Show each pack's margin at the measured p95
      cost: amber over 50 %, red over 100 %.
- [ ] A *Payments enabled* switch, greyed out with the reason until a provider is configured, at
      least one pack is valid, and the metered model has a price.
- [ ] A *Reconcile now* button; audit it as `billing.reconcile`.

### 3.5 End to end in test mode (design §11)

- [ ] Put test keys in the local `server/.env` and run `stripe listen --forward-to
      localhost:3001/api/billing/webhook`.
- [ ] Pay with `4242 4242 4242 4242`: the credits arrive once, and the balance and history update.
- [ ] 3DS with `4000 0025 0000 3155`; a decline with `4000 0000 0000 9995`; cancel on the hosted
      page.
- [ ] Let a session expire: the order becomes `expired`.
- [ ] Refund half, then the rest: the clawback is cumulative, and the balance can go negative.
- [ ] Open a dispute with `4000 0000 0000 0259`: clawback and hold. Close it as won: credits
      restored.
- [ ] Stop the API in the middle of a payment, then restart it: reconciliation grants the credits.
- [ ] Resend an event from the Stripe dashboard: no second grant.
- [ ] An unverified account, a billing hold, the balance cap and too many checkouts each return the
      right error.

### 3.6 Go live

- [ ] Put the live restricted key and the live webhook secret in the production `server/.env`, and
      set `BILLING_PROVIDER=stripe`.
- [ ] Deploy. Set the packs with live Price ids, and check that the Terms and privacy pages are
      live.
- [ ] **(you)** Turn on *Payments enabled* in Admin → Usage → Payments.
- [ ] **(you)** Buy the smallest pack with a real card. Check the receipt, the balance and the
      order. Refund it in the dashboard and check the clawback.
- [ ] **Exit check:** the live purchase and refund behaved as designed, and the next reconciliation
      reports nothing to fix.

## Phase 4: Tune and clean up

- [ ] After 2–4 weeks, review denials by reason, the pacing pattern, cost per new word, pack margins
      and purchases. Adjust the allowances, the packs or the metered model.
- [ ] Retire the in-memory `LlmBudget` once the Mongo counters have proven themselves (design §5.9).
- [ ] Add as-built notes to the design doc.
- [ ] Multi-region: until the replica set exists, keep metered traffic in one region or divide the
      budgets (design §8).
