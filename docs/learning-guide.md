# Learning guide: understanding your own codebase

This guide is for someone who shipped open-dictionary by prompting and now
wants to understand how it works. It is a reading order with things to try, not
a reference. For the reference, see [architecture.md](./architecture.md), and
keep it open in another tab for the diagrams.

**How to use it.** There are twelve stages. Each one names a few files to read
in order, the ideas those files depend on, an experiment to run, and questions
to answer before moving on. Stages 1–5 are the core of the product and are
worth doing properly; plan on an evening each. Stages 6–12 can be read in any
order as you need them.

Read with the dev server running and a terminal beside the editor. You will
understand a function much faster by watching it log than by reading it twice.

**Do not start with** `server/admin/router.ts` (1,191 lines) or
`src/api/admin.ts` (903 lines). They are long because the admin portal has many
endpoints, not because they are deep. They make more sense after stage 9.

---

## The whole thing in six sentences

1. A lookup is `GET /api/translate/:word?from=&to=`.
2. The server looks in MongoDB first; a hit is returned as is.
3. On a miss it asks an LLM for a JSON dictionary entry, checks the shape,
   returns it, and stores it for a year.
4. If the LLM fails, an English word falls back to Merriam-Webster.
5. Because each miss costs money, several independent guards decide whether a
   given caller may trigger one.
6. The web app and the browser extension are two clients of that one API, each
   with a small local cache in front of it.

Everything below is detail on one of those sentences.

## Before you start

```bash
npm install
docker compose up -d mongo         # see README for exposing it to a host-run API
npm run dev:all                    # web on :5173, API on :3001
npm test                           # 687 tests, about 2 seconds
```

Three habits that pay off throughout:

- **Turn on LLM logging** when you want to see prompts and raw model output:
  `LLM_DEBUG=true npm run server`.
- **Call the API by hand.** `curl` identifies itself as a script and is refused
  on LLM routes, so send a browser-like User-Agent:
  ```bash
  curl -A "Mozilla/5.0 (Macintosh)" "http://localhost:3001/api/translate/serendipity?from=en&to=en"
  curl -N -A "Mozilla/5.0 (Macintosh)" "http://localhost:3001/api/translate-stream/petrichor?from=en&to=es"
  ```
  (`-N` turns off curl's buffering so you see events as they arrive.)
- **Look in the database.** `docker exec -it open-dictionary-mongo mongosh open-dictionary`,
  then `db.translations.findOne({ word: "serendipity" })`.

A note on the tests: they run with no database and no network, and they read
like specifications. When a function's behaviour is unclear, its `.test.ts`
neighbour usually states it in one line. Run one file with
`npx vitest run server/translate.test.ts`.

---

## Stage 1 — One request, end to end

**Goal:** follow a lookup from the HTTP request to the JSON response without
going into any of the functions it calls.

**Read, in order**

1. `server/index.ts` — the whole file. It is the boot script.
2. `server/app.ts` — `createApp`. Note the order things are mounted in.
3. `server/translate.ts` — only `createTranslateRouter` at the bottom, and only
   the first route (`/translate/:text`). Treat `translate(...)` as a black box
   for now.

**Ideas you need**

- *Express middleware.* A request passes through a list of functions. Each
  either responds, or calls `next()` to pass it on. `app.use(x)` adds one for
  every request; `router.get(path, a, b, handler)` adds a chain for one route.
  Order is behaviour.
- *Routers.* A `Router` is a mini-app you mount under a prefix. Every feature
  here exports a `createXRouter()` function.
- *`res.locals`.* A per-request scratch object. `identify` writes the caller's
  identity there; later middleware reads it.

**Try it**

Run the first `curl` above twice and watch the API log. The first line says
`"tier":"llm"`, the second `"tier":"cache"`. Then send `from=xx` and an empty
word and see which status codes come back.

**Check yourself**

<details><summary>Why is the favorites router mounted last among the public routers?</summary>

It calls `router.use(checkJwt)`, which runs for *every* request that reaches
that router, whatever the path. Mounted earlier, anonymous requests to
`/api/suggest` or `/api/translate` would get a 401 from it before reaching
their own router. The comment in `createApp` says so.
</details>

<details><summary>What does the server do if <code>MONGODB_URI</code> is not set?</summary>

It starts anyway. `translationCache` is `null`, so every lookup goes to the
LLM. Favorites read as an empty list, and adding one answers `ok` without
storing anything. Nothing crashes.
</details>

<details><summary>Where is the per-minute limit of 5 enforced, and can an env var raise it?</summary>

`translateLimiter` in `translate.ts`. The value comes from `config.ts`, which
clamps `TRANSLATE_RATE_LIMIT_RPM` with `Math.min(..., 5)`, so it can be lowered
but not raised.
</details>

---

## Stage 2 — The cache and the database

**Goal:** understand what is stored, under what key, and how it expires.

**Read**

1. `server/cache/translationCache.ts` — about 100 lines, all of it.
2. `server/db.ts` — skim `ensureIndexes`; read the `translations` part closely.
3. `server/translate.ts` — the `DictionaryEntry` interface near the top, and
   the comment on `CACHE_VERSION`.

**Ideas you need**

- *Read-through cache.* Callers ask the cache; on a miss the code computes the
  value, returns it, and writes it back. The cache is an optimisation in front
  of a slow, expensive source.
- *Deterministic `_id`.* The document id is a hash of the key fields. A lookup
  is a single primary-key read, and writing the same key twice updates one
  document instead of creating two.
- *Upsert with `$set` and `$setOnInsert`.* `$set` fields are written every
  time; `$setOnInsert` fields only when the document is first created. That is
  how `createdBy` survives later rewrites.
- *TTL index.* An index with `expireAfterSeconds` makes MongoDB delete
  documents on its own once a date field is old enough. This codebase uses it
  for all retention, with no cleanup jobs.
- *Versioned cache key.* `CACHE_VERSION` is part of the hash. Changing it
  orphans every existing entry at once.

**Try it**

In `mongosh`: `db.translations.getIndexes()`, then look at one document and
match each field to the `TranslationDoc` interface. Find `fetchedAt` and work
out the date it will expire.

**Check yourself**

<details><summary>You changed the prompt so entries include etymology. What else must you do, and why?</summary>

Bump `CACHE_VERSION`. Otherwise every word already cached keeps its old entry
for up to a year, and the change is visible only on words nobody has looked up
yet. Run `npm run eval` first: it checks live model output against structural
expectations.
</details>

<details><summary>Is the model name part of the cache key?</summary>

No. The key is word, source language, target language and version. Switching
models does not invalidate anything; the `generatedBy` field on each entry
records which model wrote it.
</details>

---

## Stage 3 — `translate()`: the orchestrator

**Goal:** understand the function everything else serves.

**Read** in `server/translate.ts`, in this order:

1. `doTranslate` — the tiers. Read it as three blocks: cache, LLM, dictionary.
2. `translateOnce` — the in-flight map wrapped around it.
3. `adaptLlm` — how the model's shape becomes the response shape.
4. `withinGrace`, `fetchAudioPhonetics`, `cacheSetSafe` — the small helpers.

Then read the `translate — in-flight dedup` and `translate — orchestration`
blocks in `server/translate.test.ts`. Each `it(...)` title is a rule.

**Ideas you need**

- *A promise is a value.* You can store one in a `Map`, hand the same one to
  several callers, and attach handlers to it later. The in-flight dedup is just
  that: the first caller creates the promise, later callers receive it.
- *Background work.* Code that should not delay the response is started
  without `await` and collected in the `background` array. `void somePromise`
  is the convention here for "deliberately not awaited".
- *Serialised writes.* `writeChain = writeChain.then(fn)` appends each write to
  the end of a chain, so they run one after another in the order they were
  queued.
- *Best-effort helpers.* `cacheSetSafe` and `fetchAudioPhonetics` catch their
  own errors and never reject. Read the doc comment on a function before
  assuming it can throw.

**Try it**

Pick a word that is not cached and fire two requests at once:

```bash
W=quixotic; for i in 1 2; do curl -s -A "Mozilla/5.0 (Macintosh)" "http://localhost:3001/api/translate/$W" -o /dev/null -w "%{time_total}s\n" & done; wait
```

Both take about the same time, and with `LLM_DEBUG=true` you will see one set
of model calls, not two.

**Check yourself**

<details><summary>Why does the in-flight entry stay registered after the response has been sent?</summary>

The cache write happens in the background. A request arriving in the gap
between "response sent" and "cache written" would miss the cache and pay for a
second generation. Keeping the entry until background work settles makes that
request a joiner instead.
</details>

<details><summary>An entry comes back with <code>incomplete: true</code>. What does the user see, and what is cached?</summary>

The user sees the core entry without the extras sections. Nothing is cached,
so the next lookup of that word tries again and may get the full entry.
</details>

<details><summary>Why is audio fetched in parallel instead of after the LLM answers?</summary>

It does not depend on the answer, and the LLM call is the slow part. Started
together, audio is almost always ready first. The code waits at most 1.5
seconds for it after the answer arrives; a later result is added to the cache
afterwards.
</details>

---

## Stage 4 — Talking to an LLM

**Goal:** understand how a vendor is called and why its output is not trusted.

**Read**

1. `server/providers/llm/types.ts` — the `LlmProvider` interface and
   `LlmTranslationContent`. This is the contract.
2. `server/providers/llm/prompts.ts` — the actual prompts. Read `CORE_SYSTEM`
   and `EXTRAS_SYSTEM` in full.
3. `server/providers/llm/parse.ts` — how model output is validated.
4. `server/providers/llm/deepseek.ts` — 37 lines; a vendor is mostly defaults.
5. `server/providers/llm/openaiCompat.ts` — `callChat` first, then `send`.
6. `server/providers/llm/translateFlow.ts` — `runTranslate`.

**Ideas you need**

- *Interface plus adapters.* The pipeline depends on `LlmProvider`, never on a
  vendor. Each adapter converts that interface to one HTTP dialect.
- *Model output is untrusted input.* The model is asked for JSON but can return
  anything. `parse.ts` rebuilds the object field by field, keeping only values
  of the right type. Nothing the model writes is spread straight into a
  response.
- *`AbortController`.* The way to cancel a `fetch`. `callChat` uses one for the
  timeout, and keeps the timer running until the *body* has been read, because
  a vendor can send headers promptly and then stall.
- *Typed errors.* `LlmProviderError` carries a `code` (`timeout`, `network`,
  `api_error`, `bad_response`, `not_configured`). Callers branch on the code.
- *Prompt caching.* System prompts are constants so vendors can reuse their
  processing of the prefix. Request data goes in the user message only.

**Try it**

```bash
npm run llm:ping -- petrichor
LLM_DEBUG=true npm run llm:ping -- petrichor     # prints prompts and raw responses
```

In the debug output, find the two requests (core and extras) and note that
they start at the same moment.

**Check yourself**

<details><summary>What would you write to add a new OpenAI-compatible vendor?</summary>

A wrapper like `deepseek.ts` (base URL, default model, reasoning-off variants),
a case in `buildLlmProvider` in `index.ts`, and, if it should be selectable by
`LLM_VENDOR`, a case in `createLlmProviderFromEnv`. Through the admin portal
you need no code at all: the `openai-compat` vendor takes any base URL.
</details>

<details><summary>Why are there two model calls per lookup instead of one?</summary>

Latency. The fields the reader wants first are in the smaller call, which
finishes sooner and streams. Running both in parallel costs the time of the
slower one, not the sum.
</details>

<details><summary>The model returns a <code>translation</code> for an English-to-English lookup. What happens?</summary>

`runTranslate` deletes it (`if (sameLang) delete content.translation`). The
prompt asks the model to omit it, and the code does not rely on the model
complying.
</details>

---

## Stage 5 — Streaming, from the model to the pixels

**Goal:** understand how a half-written answer is shown as it arrives. This is
the most intricate part of the project and the most satisfying to understand.
Use the diagram in [architecture.md §8.3](./architecture.md#83-how-a-half-written-answer-reaches-the-screen).

**Read**

1. `shared/sse.ts` — a complete SSE reader in 60 lines.
2. `server/providers/llm/streamJson.ts` — `repair`, then its tests.
3. `server/providers/llm/translateFlow.ts` — `throttle` and `publish`.
4. `server/translate.ts` — the `/translate-stream/:text` route and `writeSse`.
5. `src/api/dictionary.ts` — `lookupWordStream`.
6. `src/hooks/useDictionary.ts`.
7. `shared/liveReveal.ts` and `src/components/LiveText.tsx`.

**Ideas you need**

- *Server-Sent Events.* A long-lived HTTP response whose body is text frames:
  `event: name`, `data: payload`, blank line. This project uses it twice: the
  vendor streams tokens to the API, and the API streams snapshots to the
  browser. `shared/sse.ts` reads both.
- *Partial JSON.* `{"headword":"run","translation":"跑","meaningGroups":[{"partOfSp`
  is not valid JSON. `repair` closes what is open and drops what cannot be
  valid yet, so the prefix can be parsed.
- *Snapshots, not deltas.* Each `partial` event carries the whole entry so
  far. A client that misses one loses nothing.
- *Throttling.* Tokens arrive far faster than a screen needs. `throttle` lets
  at most one snapshot through every 60 ms.
- *`requestAnimationFrame` reveal.* The browser receives text in bursts;
  `LiveText` shows it at a steady rate that speeds up when it falls behind.

**Try it**

Run the streaming `curl` from "Before you start" on an uncached word and watch
`partial` events grow. Then open DevTools → Network on the web app, look up a
new word, and open the EventStream tab of the `translate-stream` request.

**Check yourself**

<details><summary>Why does the streaming route send its headers with the first event rather than immediately?</summary>

So that a refusal can still be a normal HTTP error. The quota check runs before
any partial is produced; if it fails, no event has been sent, the status is
still unset, and the client gets a plain `429` with a JSON body exactly as on
the non-streaming route.
</details>

<details><summary>The connection drops halfway through a stream. What does the web app do?</summary>

`lookupWordStream` falls back to `lookupWord`, the JSON endpoint. The server is
probably still generating, so that request joins the in-flight lookup (or reads
the cache if it has finished). No second generation is paid for.
</details>

<details><summary>Why are extras held back until the core call has finished?</summary>

They render below the senses. Showing them early would push the senses around
as they fill in. Holding them means the page only ever grows downward.
</details>

---

## Stage 6 — Fusion

**Goal:** understand how two models are combined without slowing the user down.

**Read** `server/providers/llm/fusion.ts`: the header comment,
`createFusionProvider`, then `mergeContents`. Follow `result.upgrade` back into
`doTranslate` in `server/translate.ts`.

**Ideas you need**

- *Decorator.* `FusionProvider` implements `LlmProvider` by wrapping two other
  providers. Nothing upstream changes.
- *Racing promises.* `firstFulfilled` resolves with the first success and
  rejects only if all fail.
- *Deferred improvement.* The result carries a promise (`upgrade`) for a better
  answer later. The caller responds now and overwrites the cache when it
  resolves.

**Check yourself**

<details><summary>Who sees the merged entry?</summary>

Everyone except the person whose lookup generated it. That person gets the
first model's answer immediately; the merge runs afterwards and replaces the
cached entry.
</details>

<details><summary>One model says the input is a typo; the other returns a full definition. What does the merge keep?</summary>

The definition. `typo` is kept only when both models flag it, in the fuse
prompt and in the code merge alike.
</details>

---

## Stage 7 — Identity and auth

**Goal:** understand how the server knows who is calling.

**Read**

1. `src/main.tsx` — the `Auth0Provider` setup.
2. `src/hooks/useAccessToken.ts`.
3. `server/app.ts` — `checkJwt` and `optionalJwt`.
4. `server/usage/principal.ts` — `resolveIdentity`.
5. `server/admin/auth.ts` — 40 lines.
6. `server/favorites.ts` — `userKeyFromReq` and one handler.
7. [security.md](./security.md) for the threat model.

**Ideas you need**

- *OAuth with PKCE.* The browser is redirected to Auth0 to sign in and comes
  back with tokens. The app never handles a password.
- *Access token (JWT).* A signed statement: "this is user `sub`, for this API,
  until this time." The API checks the signature against Auth0's public keys,
  so it needs no call to Auth0 per request.
- *Audience.* The token names the API it is for. A token issued for another
  API is rejected.
- *Authentication and authorisation are separate steps.* `checkJwt` answers
  "who is this?" (401 if unknown). `adminOnly` answers "may they do this?"
  (403 if not).
- *IDOR.* If a route took the user id from the request, anyone could read
  anyone's data by changing it. Every route here takes it from the verified
  token.

**Try it**

Sign in on the web app, copy the `Authorization` header from a request in
DevTools, and paste the token into a JWT decoder. Find `sub`, `aud`, `exp`.
Then call `/api/favorites` with no header, and `/api/admin/llm/status` with
your token before and after adding your `sub` to `ADMIN_USER_IDS`.

**Check yourself**

<details><summary>A signed-in user's token has expired and they look up a word. What happens?</summary>

`optionalJwt` does not reject; it leaves `req.auth` unset. `resolveIdentity`
sees an `Authorization` header with no verified identity and returns an
anonymous principal with `authState: 'invalid'`. The lookup proceeds against
the IP allowance, and the client can use that flag to prompt a new sign-in.
</details>

<details><summary>What stops someone from making themselves an admin from the browser?</summary>

Nothing in the browser matters. The admin check is `sub ∈ ADMIN_USER_IDS`,
evaluated on the server against the `sub` inside a token signed by Auth0. The
list lives in `server/.env`.
</details>

---

## Stage 8 — Cost control

**Goal:** understand the guards between a request and a paid model call, and
why there are four of them. Read the incident summary at the top of
`server/abuseGuard.ts` first; it explains what per-minute limits missed.

**Read**

1. `server/abuseGuard.ts` — the header, `LlmBudget`, `llmGuard`,
   `refuseOverBudget`.
2. `server/usage/types.ts` — the vocabulary.
3. `server/usage/meter.ts` — `reserve` at the bottom first, then `decide`, then
   `settle` inside `makeTicket`.
4. `server/usage/store.ts` — `conditionalInc`.
5. `server/usage/windows.ts` — `counterKeys`.
6. `server/providers/llm/usage.ts` — `trackCall`.
7. `server/usage/meter.test.ts`.

**Ideas you need**

- *Defence in layers.* The rate limit bounds bursts. The daily IP budget bounds
  a patient crawler. Quotas bound each person. The budget bounds the total.
- *Check-then-act races.* "Read the counter, compare, then increment" lets two
  concurrent requests both pass. The fix here is one database operation that
  increments only if the condition still holds.
- *Reserve and settle.* Hold an estimate before the work; replace it with the
  real cost after. The same idea as a card pre-authorisation.
- *Integer money.* Costs are micro-USD integers. Floating-point dollars
  accumulate rounding error; integers do not.
- *Shadow mode.* Run the full decision, record what it would have refused, and
  refuse nothing. It lets you see the effect of a policy before turning it on.
- *Fail open or fail closed.* When the metering store is down, `shadow` lets
  the request through and `on` refuses it. Each choice is deliberate.

**Try it**

Set `USAGE_ENFORCEMENT=on` and `USAGE_ANON_DAILY_PER_IP=2` in `server/.env`,
restart, and look up three uncached words while signed out. Read the third
response body. Then inspect `db.usage_counters.find()` and
`db.usage_ledger.find().sort({ts:-1}).limit(1)`.

**Check yourself**

<details><summary>Why can two simultaneous requests not both take the last free word of the day?</summary>

`tryIncrement` is a single `findOneAndUpdate` whose filter includes
`n <= limit - 1`. MongoDB applies the filter and the increment atomically per
document. The second request's filter no longer matches; its upsert collides on
`_id`, which the store reads as "limit reached".
</details>

<details><summary>The LLM call fails and the dictionary answers instead. Is the user charged?</summary>

No. `settle` is called with `charged: false`, which gives the allowance unit
back and replaces the reserved estimate with the actual token cost (the failed
call may still have consumed tokens, and that is recorded).
</details>

<details><summary>Why does the losing model in a fusion race still show up in the ledger?</summary>

The vendor billed for it. The ticket's usage sink is passed to both providers
and to the background merge, and `trackCall` reports every upstream call
exactly once, whether it won, lost, was retried or failed.
</details>

---

## Stage 9 — Configuration at runtime and the admin plane

**Goal:** understand how a provider can be swapped without a restart.

**Read**

1. `server/config.ts` — all of it; it is the list of every knob.
2. `server/llm/service.ts` — `reloadActive` and `reloadMetered`.
3. `server/llm/service.test.ts` — the `describe` titles are the state table.
4. `server/admin/crypto.ts`.
5. `server/admin/providersRepo.ts` — the document interfaces at the top.
6. `server/admin/router.ts` — just one mutation, `PUT /llm/active`, start to
   finish.

**Ideas you need**

- *Layered configuration.* Environment variables are the baseline. A database
  document overrides them. The same pattern is used for usage settings.
- *Absent, null, and a value are three states.* For `activeProviderId` they
  mean "no opinion", "explicitly off", and "this one".
- *Degrade, do not crash.* A broken override falls back to the baseline and
  says so in a status object.
- *Authenticated encryption.* AES-256-GCM produces ciphertext plus a tag that
  detects tampering. A fresh random IV is used for every encryption.
- *Write-only secrets.* The API accepts a key and from then on returns only its
  last four characters.
- *Audit log.* Every mutation records who, from where, and what changed.

**Check yourself**

<details><summary>An admin deletes the provider that is currently active. What do lookups use?</summary>

On the next reload the service finds that `activeProviderId` points at nothing,
logs an error, and reverts to the env baseline with status `misconfigured`.
Lookups continue on the env-configured provider, if there is one.
</details>

<details><summary>Someone obtains a copy of the Mongo backup. Can they use the provider API keys?</summary>

Not from the backup alone. The keys are AES-256-GCM ciphertext and the master
key is only in `server/.env`. They would need both.
</details>

---

## Stage 10 — The web app

**Goal:** understand where state lives and how data reaches the screen.

**Read**

1. `src/main.tsx`, then `src/App.tsx`.
2. `src/pages/WordPage.tsx`.
3. `src/hooks/useDictionary.ts` (again, now as a React reader).
4. `src/api/dictionary.ts` — the cache functions and `lookupWord`.
5. `src/hooks/useUserData.ts` and `src/hooks/useFavorites.ts`.
6. `src/components/WordEntry.tsx` and `PosSection.tsx`.
7. `src/i18n/I18nContext.tsx`.

**Ideas you need**

- *Custom hooks own state; components render it.* A hook is a function that
  uses `useState`/`useEffect` and returns values. Pages call hooks and pass
  results down.
- *Effect cleanup.* `useEffect` returns a function that runs when inputs change
  or the component unmounts. `useDictionary` uses it to abort the previous
  lookup, which is what prevents an old answer from overwriting a newer one.
- *The URL is state.* `/word/run?from=en&to=es` fully describes the page.
  Reload and share work because nothing essential lives only in memory.
- *Context.* A way to make a value available to a whole subtree without
  passing props (`I18nProvider`, `LiveProvider`, `Auth0Provider`).
- *Debounce.* History changes are saved 500 ms after the last change, so a
  burst of lookups makes one request.
- *Code splitting.* `lazy(() => import('./pages/admin'))` keeps the admin code
  out of the bundle ordinary visitors download.

**Try it**

Look up a word, then open DevTools → Application → Local Storage and find its
`dict:v1:` key. Reload: the Network tab shows no `translate` request, and an
`activity-ping` in its place. Delete the key and reload again.

**Check yourself**

<details><summary>You type a word and immediately navigate to another. Why does the first answer not appear on the second page?</summary>

The effect cleanup in `useDictionary` sets `cancelled = true` and aborts the
request. Even if the response arrives, the `then` handler returns early.
</details>

<details><summary>An anonymous user clicks the favorite star. What happens?</summary>

`useFavorites` stores the intended favorite in `sessionStorage` and redirects
to login. When the user returns authenticated, the pending favorite is applied
and the list is loaded.
</details>

---

## Stage 11 — The browser extension

**Goal:** understand why the extension is split the way it is.

**Read**

1. `extension/manifest.json`.
2. `extension/src/shared/messages.ts` — the message types are the internal API.
3. `extension/src/background/serviceWorker.ts`.
4. `extension/src/background/streamPort.ts`.
5. `extension/src/background/lookupClient.ts` — compare with
   `src/api/dictionary.ts`.
6. `extension/src/content/selectionListener.tsx`.
7. `extension/README.md`, the section on audio.

**Ideas you need**

- *Three execution contexts.* A content script runs inside someone else's
  page. The service worker runs in the background with no DOM and can be shut
  down at any time. Extension pages (popup, options) are ordinary pages with
  extension privileges.
- *Message passing.* Contexts cannot call each other's functions. They send
  messages. A discriminated union (`type: 'LOOKUP' | ...`) plus a `switch`
  gives compile-time checking of every message.
- *Ports for streams.* `sendMessage` is one request, one response. A `Port`
  stays open and carries many messages.
- *Shadow DOM.* An isolated subtree whose styles neither leak out nor are
  affected by the page.
- *CSP.* A page can restrict where media loads from, and that applies to
  content scripts too. Hence the offscreen document for audio.

**Check yourself**

<details><summary>Why does the content script not call the API itself?</summary>

It runs in the host page's origin, so the request would be subject to that
page's CORS and CSP rules and would expose the logic to the page. The service
worker has the extension's own origin and host permissions, and is the one
place that holds tokens and the cache.
</details>

---

## Stage 12 — Shipping it

**Read** `Dockerfile`, `docker-compose.yml`, `nginx.conf`,
`scripts/deploy-prod.sh`, the header of `scripts/prerender.ts`, and
`.github/workflows/ci.yml`. Then the "Production deployment" section of the
README.

**Ideas you need**

- *Reverse proxy.* nginx terminates TLS, serves static files, and forwards
  `/api` to the app. The app sees nginx's address unless it trusts
  `X-Forwarded-For`.
- *Multi-stage Docker build.* One stage installs dependencies, the next copies
  only what is needed to run.
- *SPA fallback.* Unknown paths return `index.html` so client-side routes work
  on reload.
- *Prerendering.* Generating static HTML ahead of time for crawlers, from data
  you already have.
- *Content Security Policy.* A response header listing where scripts, media
  and connections may go.

**Check yourself**

<details><summary>Why must prerender run after the build and before rsync?</summary>

`vite build` empties `dist/`. `rsync --delete` makes the web root match
`dist/` exactly. If prerender were skipped, every static word page would be
deleted from the live site. The deploy script fixes the order.
</details>

---

## Patterns that repeat

Once you recognise these, new files read much faster.

| Pattern | What it looks like | Examples |
|---|---|---|
| Factory with injected dependencies | `createX(deps)` returns an object of functions; tests pass fakes | `createApp`, `createMeter`, `createLlmService`, `createTranslationCache` |
| Pure core, exported for tests | Logic with no I/O is a standalone exported function | `normalizeText`, `adaptLlm`, `mergeContents`, `todayBudgetMicros`, `parseBlockTarget` |
| Never-throwing side path | A helper catches its own errors and logs | `cacheSetSafe`, `recordActivity`, `ticket.settle`, `trackCall` |
| In-memory copy of a Mongo document | Read synchronously on the hot path, refreshed in the background | blocklist, usage settings, model prices |
| Single-document atomic update | Condition and change in one operation, no transaction | `tryIncrement`, `tryReserveCost`, cache `set` |
| Typed error with a `code` | Callers branch on `err.code`, not on message text | `LlmProviderError`, `ProviderError`, `LookupError`, `MeterError` subclasses |
| Validate at the boundary | Untyped input is narrowed once, then trusted | `parseLookup`, `normalizeFavorite`, `parse.ts`, `validateUsageSettingsPatch` |
| Step down on rejection | Try the best option, remember what worked | reasoning ladder, `stream_options`, streaming → plain request |
| TTL instead of cleanup code | Retention is an index option | almost every collection in `db.ts` |

## Exercises

Small changes that each force you through one slice of the system. Do them on
a branch.

1. **Add a language.** Add an entry to `shared/languages.ts`. Find every place
   that reads the list (validation, the pickers, prompts). What did you not
   need to touch?
2. **Read a failing test.** In `translateOnce` in `server/translate.ts`,
   comment out the line `inFlight.set(key, state)` and run
   `npx vitest run server/translate.test.ts`. Three tests fail. Explain each
   one from its title before reverting.
3. **Trace one field.** Follow `register` from `CORE_SYSTEM` in `prompts.ts`
   through `parse.ts`, `adaptLlm`, the `DictionaryEntry` types on both sides,
   to the component that renders it, and to the extension's renderer.
4. **Add a field end to end.** Add an optional `etymology` string to the core
   answer. You will touch the prompt, the parser, `LlmTranslationContent`,
   `adaptLlm`, both `DictionaryEntry` types, the fuse prompt and code merge,
   the web and extension renderers, and `CACHE_VERSION`. Write the parser test
   first.
5. **Break the cache on purpose.** Stop the Mongo container while the API is
   running and look up a word. Read the logs and match each line to the code
   that printed it.
6. **Write a missing test.** `sanitizeHistoryList` in `server/app.ts` has
   none. Export it and test the duplicate, over-length and wrong-type cases.
7. **Explain a number.** Why is the cold-start estimate deliberately high, and
   what replaces it? (`usage/pricing.ts`, `createEstimator` in `meter.ts`.)

## Rough edges worth knowing about

These are honest notes on the current code, and good candidates for a first
refactor once you are comfortable.

- **Four copies of "read the verified `sub`".** `userIdFromReq` (`app.ts`),
  `userKeyFromReq` (`favorites.ts`), `adminSubFromReq` (`admin/auth.ts`) and
  `verifiedSub` (`usage/principal.ts`) do the same job with small differences.
- **`/api/user-data` lives inline in `app.ts`.** Every other feature has its
  own router module.
- **`LANGUAGE_CODES` is rebuilt in several files**, and the `LLM_DEBUG` regex
  is written out twice. Each belongs in one place.
- **The `DictionaryEntry` type exists three times** (server, web, extension)
  and is kept in sync by hand. `shared/` is the natural home.
- **The lookup client exists twice** (`src/api/dictionary.ts` and
  `extension/src/background/lookupClient.ts`), differing mainly in storage.
- **The extension asks Auth0 for `offline_access` but discards the refresh
  token** and renews with a silent `prompt=none` flow instead. The comment in
  `authClient.ts` explains the choice; the scope is then unnecessary, and
  extension sign-ins do not last the 90 days that web sign-ins do.
- **Favorites fail silently without a database.** `POST /api/favorites`
  answers `{ ok: true }` when MongoDB is not connected, and stores nothing.
  A 503 would be more honest.
- **`npm test` used to need `server/.env`.** `server/config.ts` exits the
  process when an `AUTH0_*` variable is missing, and most server tests import
  it. `vite.config.ts` now supplies placeholder values for test runs.
- **In-process state assumes one API container.** The daily IP budget, rate
  limits and in-flight dedup would each need a shared store before running a
  second instance. `design-geo-load-balancing.md` discusses this.
- **`admin/router.ts` is one 1,191-line file.** It would split cleanly by page.
- **Older design docs name files that have moved.** `design-translation-cache.md`
  refers to a `TranslateService` class; the orchestrator is the `translate()`
  function in `server/translate.ts`.

## Glossary

| Term | Meaning here |
|---|---|
| Tier | Which source answered a lookup: `cache`, `llm`, `dictionary`, or `client-cache` in the activity log |
| Entry | A `DictionaryEntry`: the JSON the UI renders and the cache stores |
| Core / extras | The two parallel model calls that make up one generation |
| Partial / snapshot | The entry so far, sent while the model is still writing |
| Provider | An object implementing `LlmProvider`; its id is `llm:<vendor>:<model>` |
| Adapter | Code that speaks one vendor wire protocol |
| Transport | The function inside an adapter that sends messages and returns text |
| Fusion | Two providers raced, then merged in the background |
| Upgrade | The merged entry that later replaces the first answer in the cache |
| Principal | Who a request is attributed to: `owner`, `user` or `anon` |
| Owner | A signed-in user whose `sub` is in `ADMIN_USER_IDS` |
| Route (usage) | Which model setup serves a generation: `full` or `metered` |
| Ticket | The object `reserve()` returns; carries the route, collects token usage, is settled once |
| Pool | Which allowance a free generation is counted against: `account` or `ip` |
| Shadow mode | Quotas are evaluated and recorded but never refuse |
| Env baseline | The provider built from environment variables at boot |
| In-flight | A lookup currently being generated, shared by concurrent callers |
| Leader / joiner | The request that started an in-flight lookup, and those that attached to it |
| CEFR | The A1–C2 language proficiency scale used to grade senses and examples |
| `sub` | The Auth0 user id inside a token, e.g. `google-oauth2\|1234` |
| JWKS | Auth0's published public keys, used to verify token signatures |
| M2M | The machine-to-machine Auth0 client the server uses for the Management API |
| MV3 | Manifest V3, the current Chrome extension platform |
