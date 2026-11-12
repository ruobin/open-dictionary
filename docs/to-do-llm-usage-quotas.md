# To-Do: LLM usage tiers, quotas & paid credits

Derived from [`design-llm-usage-quotas.md`](./design-llm-usage-quotas.md); its decisions were
recorded on 2026-11-12 (§13). The phases match its §10, and the app keeps working if you stop
after any phase. **(you)** marks account, dashboard and legal steps that happen outside the code.

**Verify** root changes with `npm run typecheck`, `npm test` and `npm run build`. Verify extension
changes with `npm run ext:test`, `npm run ext:build` and `npx tsc --noEmit -p extension/tsconfig.json`.
**Deploy** with `npm run deploy:api` / `npm run deploy:web`, never `npm start`. The web deploy must
keep build → `prerender:prod` → `rsync --delete`.

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

- [ ] `server/providers/llm/types.ts`: add the `UsageSink` type, `LlmTranslateOptions.usage` and
      `LlmMoreExamplesResult.meta`.
- [ ] `translateFlow.ts`: pass the sink to the core and extras calls. Record the discarded
      `bad_response` attempt instead of dropping its `meta`.
- [ ] `fusion.ts`: hand the sink to both providers and to `fuse()`, so the slower provider and the
      merge are recorded even though they finish after the response.
- [ ] `openaiCompat.ts`:
  - [ ] Send `stream_options: { include_usage: true }` on streamed Chat Completions.
  - [ ] On a 400 that rejects it, remember that per provider and stop sending it (the same
        step-down as `requestVariants.ts`).
  - [ ] Return usage from `moreExamples`.
- [ ] `anthropic.ts`, `responses.ts`: report usage for every attempt, retries included.
- [ ] When a vendor reports nothing, fall back to the byte-based estimate, flagged
      `estimated: true`.
- [ ] Tests:
  - [ ] each transport reports usage
  - [ ] a fusion lookup records 5 calls (2 × core and extras, plus `fuse`) with the right kinds
  - [ ] the retry is counted
  - [ ] the estimate is used and flagged when usage is missing

### 0.2 Prices (design §5.5)

- [ ] `server/admin/providersRepo.ts`: optional `models[].pricing { inputUsdPerMTok,
      outputUsdPerMTok }`, validated as finite, at least 0, and below a sane upper bound.
- [ ] `src/components/admin/ProviderForm.tsx`: price fields per model.
- [ ] `server/usage/pricing.ts`:
  - [ ] a price map keyed by provider id (`llm:<vendor>:<model>`), rebuilt on `reloadFromDb()`
  - [ ] the `LLM_DEFAULT_PRICE_IN/OUT_PER_MTOK` fallback, with a warning
  - [ ] integer micro-USD math
  - [ ] the reservation estimate: 1.25 × the 7-day p95, with the token-based estimate until there
        is data
- [ ] Tests: cost math, the fallback, the estimate.
- [ ] **(you)** After the deploy, enter the real price of every model in the admin portal.

### 0.3 Store, settings and meter (design §5.3, §5.6)

- [ ] `server/usage/store.ts`: the `UsageStore` interface with Mongo and in-memory implementations;
      `tryIncrement`, `tryReserveCost`, `incCost`, `decrement`, and the balance debit and credit.
- [ ] `server/db.ts`: create `usage_counters` (TTL on `expiresAt`), `usage_ledger` (180-day TTL and
      the three indexes), `accounts`, `credit_transactions` and `usage_settings`.
- [ ] `server/usage/settings.ts`: env defaults (design §9) plus DB overrides, refreshed every 30 s.
- [ ] `server/config.ts` and `server/.env.example`: the `USAGE_*` variables, including
      `USAGE_FREE_TIER_DAILY_USD=1.00` and `USAGE_FREE_TIER_MONTHLY_USD=5.00`.
- [ ] `server/usage/meter.ts`:
  - [ ] `reserve()`: pacing, the anonymous share, the verified allowance, the IP allowance, the
        paid ceiling, the balance, and shadow mode
  - [ ] `Ticket.settle()`: the user is charged only for an LLM answer; the dollars are always
        settled
  - [ ] `QuotaDeniedError`
  - [ ] best-effort ledger writes
- [ ] Tests:
  - [ ] the reserve decision table (principal × verification × settings × counters, shadow mode
        included)
  - [ ] pacing: day 1, rollover, the last day, 28/29/30/31-day months, `pacing=off`
  - [ ] the anonymous share; anonymous and unverified users sharing one IP allowance
  - [ ] store contract: 20 parallel reserves at a limit of 5 give exactly 5; parallel cost
        reservations never pass the budget; settle replaces the estimate with the actual cost; the
        debit stops at 0 and when the account has a billing hold

### 0.4 Identity and email verification (design §5.2)

- [ ] `server/app.ts`: build `optionalJwt` next to `checkJwt`, and pass it to the translate,
      more-examples and usage routers.
- [ ] `server/usage/principal.ts`: `resolvePrincipal`; `authState` (`invalid` when the header is
      present but `req.auth` isn't); IPv6 /64 `ipKey`.
- [ ] Move `translateLimiter` after `optionalJwt`, `skip` the owner, and key signed-in users by
      `sub`.
- [ ] `server/abuseGuard.ts`: `LlmBudget` skips the owner.
- [ ] `server/usage/verification.ts`:
  - [ ] the cache rules: verified is trusted for 7 days, unverified for 10 minutes
  - [ ] a 1.5 s timeout, one check per `sub` at a time, and at most 5 calls/s per process
  - [ ] never store `false` after an error
  - [ ] resend (`mgmt.jobs.verifyEmail`, at most once per 10 minutes and 5 times a day per
        account) and refresh (once per minute per account)
- [ ] **(you)** Confirm that the Auth0 machine-to-machine application behind
      `AUTH0_MGMT_CLIENT_ID` has the `read:users` and `update:users` grants.
- [ ] `buildEntryCreator`: add the signed-in user's `sub`, so the Admin → Entries "Added by" column
      shows the account.
- [ ] Tests: principal resolution, /64 keying, every row of the verification cache table, the rate
      limits.

### 0.5 Lookup integration (design §5.1, §5.3)

- [ ] `server/translate.ts`:
  - [ ] `translate()` takes an `LlmRouter`. Until Phase 2 both routes return `current()`.
  - [ ] Add the `meter` hook between Tier 0 and Tier 1. `QuotaDeniedError` skips the cache write
        and the dictionary tier.
  - [ ] On `QuotaDeniedError`, a joiner retries with its own hooks.
  - [ ] Call `ticket.settle()` at release, after `Promise.allSettled(background)`.
  - [ ] Lazy SSE headers: no `flushHeaders()` before the first event, so a denial is a plain 429
        with a JSON body and `Retry-After`.
  - [ ] Send `event: usage` before `done`, and `X-Generation: charged` on the JSON route.
  - [ ] Stop `recordLlmSpend()` from counting joiners.
- [ ] `server/moreExamples.ts`: the same meter (`action: 'examples'`) and router, after its cache
      check.
- [ ] Tests: the `translate.ts` list in design §11.

### 0.6 Usage API (design §5.7)

- [ ] `server/usage/router.ts`:
  - [ ] `GET /api/usage/me` (optional auth, `apiLimiter`), with the free-tier state cached for 10 s
  - [ ] `POST /api/usage/verify-email/resend` and `POST /api/usage/verify-email/refresh`
- [ ] Tests: the response shape for each tier (owner, exempt, verified, unverified, anonymous).
- [ ] **Freeze the contract** (the `/api/usage/me` shape, the 429 body, the `usage` event). Phase 1
      builds on it.

### 0.7 The web app sends tokens (design §5.2)

- [ ] `src/api/dictionary.ts`:
  - [ ] an optional `getToken` on `lookupWord` and `lookupWordStream`
  - [ ] a 429 `quota_exceeded` body becomes `LookupError('quota_exceeded')`, carrying `reason`,
        `actions` and `resetAt`
  - [ ] handle the SSE `usage` event
- [ ] `src/hooks/useDictionary.ts`: pass `getAccessTokenSilently` when signed in, and hold the first
      lookup until Auth0's `isLoading` clears (at most about 1 s).
- [ ] `src/api/moreExamples.ts`: send the token too.
- [ ] `src/api/dictionary.test.ts`: the token is attached, the 429 is mapped, and the `usage` event
      is handled.

### 0.8 Read-only admin Usage page (design §5.8)

- [ ] `server/admin/usage.ts` and the route `GET /api/admin/usage/summary?days=30`.
- [ ] `src/pages/admin/Usage.tsx`:
  - [ ] gauges for today's paced budget, the month and the anonymous share
  - [ ] spend by source and route
  - [ ] cost per new word by model, including the would-be single-model cost
  - [ ] would-deny counts
  - [ ] top consumers
- [ ] Wire it up: `AdminLayout.tsx` nav (Analytics) and `src/api/admin.ts`.

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

- [ ] `extension/src/background/lookupClient.ts`: add `Authorization: Bearer <token>` whenever
      `getAccessToken()` returns one, on lookups, the stream port and more examples.
- [ ] `extension/src/shared/messages.ts`: a `quota_exceeded` error code that carries `reason`,
      `actions` and `resetAt`.
- [ ] `ResultCard.tsx`: a panel per reason (design §4.6). **Sign in** calls `login()`.
- [ ] `Popup.tsx`:
  - [ ] a usage line from `/api/usage/me`, refetched each time the popup opens
  - [ ] **Verify email** and **Top up** call `chrome.tabs.create({ url:
        'https://dict.ai-dictionary.org/account/credits' })`
  - [ ] **Top up** appears only when `payments.enabled` is true
- [ ] Tests with the Chrome fakes in `testUtils.ts`: the token is attached, the 429 body is mapped,
      and the links appear only when enabled.
- [ ] Bump `manifest.json` to 0.4.0, and review the data disclosures in `STORE_LISTING.md`.
- [ ] Build with `npm --prefix extension run build:prod` and follow `extension/RELEASE.md`.
- [ ] **(you)** Submit to the store. Once it is approved, update the extension on each of your
      browsers and sign in.
- [ ] **Exit check:** your extension lookups appear as `owner` in the ledger.

## Phase 2: Route and enforce

### 2.1 Metered routing (design §4.4, §5.4)

- [ ] `server/admin/providersRepo.ts`: `llm_settings.metered { mode, providerId?, modelId? }` with
      validation. A change bumps `configVersion`.
- [ ] `server/llm/service.ts`:
  - [ ] keep the bare primary and build the metered provider for each mode
  - [ ] add `currentMetered()`
  - [ ] a custom provider that fails to build falls back to the primary, with a warning
  - [ ] add `status().metered`
- [ ] `server/admin/router.ts`: `PUT /api/admin/llm/active` accepts `metered`; audit it as
      `llm.metered.update`.
- [ ] `src/components/admin/ActiveSwitcher.tsx`: the *Everyone else uses* selector. The Overview
      shows the metered model and any warning.
- [ ] `server/translate.ts` and `server/moreExamples.ts`: the router returns `current()` for `full`
      and `currentMetered()` for `metered`; the ticket decides which.
- [ ] Tests:
  - [ ] the owner and unlimited accounts get `full`; everyone else gets `metered`
  - [ ] the metered route never builds fusion
  - [ ] a failed custom provider falls back to the primary
  - [ ] `same_as_owner` works
- [ ] **(you)** Optional: create a separate provider entry with its own API key for the metered
      model, and give that key a vendor-side cap (design §9).

### 2.2 Owner Regenerate (design §5.4)

- [ ] `POST /api/admin/entries/regenerate { word, sourceLang, targetLang }`:
  - [ ] delete the current-version cache doc
  - [ ] run `translate()` as the owner (route `full`) and return the entries
  - [ ] audit it as `entry.regenerate`
- [ ] `/api/usage/me` returns `fullModels` for the owner.
- [ ] `src/components/WordEntry.tsx`: show *Regenerate with my setup* next to the footnote, to the
      owner only, when `generatedBy.models` differs from `fullModels`. After it succeeds, clear the
      word's `dict:v1:` localStorage key and re-render.
- [ ] `src/pages/admin/Entries.tsx`: a "generated by others" filter (the creator `sub` isn't the
      owner, or there is none).
- [ ] Tests: the entry is replaced, the audit row is written, and the route is owner-only.

### 2.3 Web quota UX (design §4.6)

- [ ] `src/api/usage.ts` and `src/hooks/useUsage.ts`: refetch after `X-Generation: charged` or a
      `usage` event.
- [ ] `src/components/UsageChip.tsx` next to `AuthButton`, following the visibility rules.
- [ ] `src/components/QuotaPanel.tsx` on `WordPage.tsx`: one message and set of buttons per reason.
      Store `returnTo` for the top-up return.
- [ ] `src/components/VerifyEmailCard.tsx`: Resend, I've verified, and a re-check when the tab
      regains focus.
- [ ] `authState: "invalid"` shows a "sign in again" prompt.
- [ ] `MoreExamplesButton.tsx`: the same reasons, inline.
- [ ] `src/i18n/translations.ts`: every new string in en, zh, ja and es.

### 2.4 Admin controls (design §4.3, §5.8)

- [ ] `GET|PUT /api/admin/usage/settings` and the settings form on the Usage page:
  - [ ] the fields: enforcement, kill switch, pacing, budgets, allowances, anonymous share, the
        paid ceiling, the alert webhook
  - [ ] audit saves as `usage.settings.update`
- [ ] Alerts at 50, 80 and 100 % of the month, and once a day when today's budget runs out: a log
      line, an Overview banner, and the optional `USAGE_ALERT_WEBHOOK_URL`.
- [ ] Accounts tab:
  - [ ] search by email (through the Management API) or by sub
  - [ ] set plan, status, allowance override and billing hold
  - [ ] grant or adjust credits with a note and an idempotency key (`credit_transactions`,
        exactly-once apply)
  - [ ] show transactions and recent generations
  - [ ] audit `account.update` and `account.credits.grant`
- [ ] A boot sweep for unapplied credit transactions less than 7 days old. Older ones raise an
      alert.
- [ ] `Clients.tsx`: the account (sub → email) next to the IP, and the per-IP counter.

### 2.5 Docs and privacy (design §7)

- [ ] `src/pages/PrivacyPage.tsx` and the `privacy.*` copy in all four languages: generations are
      recorded against the account for 180 days, and verification status is read from Auth0.
- [ ] `docs/security.md`: translate becomes "public, optionally authenticated".
- [ ] `docs/design-llm-abuse-guard.md` §7: point the global-budget follow-up to this design.
- [ ] The README env table.

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
