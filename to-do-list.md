# To-Do List — Road to a No-Ads, LLM-Powered Cambridge Dictionary Alternative

**Goal:** Evolve this MVP into a serious competitor / no-ads alternative to
[Cambridge Dictionary](https://dictionary.cambridge.org/dictionary/english/), differentiated by
LLM-generated, learner-graded content (especially better example sentences) instead of ads.

**Status legend:** each item is a checkbox; nest sub-tasks under it. Priorities: **P0** (do first,
unblocks everything else), **P1** (core competitiveness), **P2** (growth/retention), **P3** (nice to have).

---

## 1. Ship the data we already generate but throw away — **P0**

The LLM already returns `translation` and `examples`, we pay for them and cache them for a year,
but the UI never renders them (see the NOTE in `server/translate.ts` `adaptLlm()` — "no slot in the
current dictionary UI").

- [x] Extend the `DictionaryEntry` shape (`server/translate.ts` + `src/api/dictionary.ts`) with
      `translation?: string` and `examples?: string[]`.
- [x] Map `content.translation` and `content.examples` through `adaptLlm()` instead of dropping them.
- [x] Render them in `src/components/WordEntry.tsx`:
  - Translation shown prominently under the headword when `sourceLang !== targetLang`.
  - "More examples" section under the meanings.
- [x] Note: already-cached entries (cached *before* this change) won't have these fields — handled
      naturally by the cache-versioning task below.

**Effort:** days. **Why first:** zero new cost, immediate visible value for learners.

---

## 2. Cache-key versioning — **P0** (do *before* investing in prompt quality)

The Mongo cache key is `(word, sourceLang, targetLang)` only — the design-doc appendix records that
`provider` was dropped from the key. Consequence: any prompt/schema/model improvement will keep
serving year-old frozen entries and we can never compare quality.

- [x] Add a `promptVersion` (or restore `provider:model`) component to the cache key in
      `server/cache/translationCache.ts`. (Implemented as `CACHE_VERSION` in `server/translate.ts`.)
- [x] Bump it whenever the prompt in `server/providers/llm/openaiCompat.ts` (`buildMessages`) or the
      response schema changes.
- [x] Document the invalidation story in `docs/design-translation-cache.md` (replaces the manual
      `deleteMany` escape hatch for prompt changes).
- [x] Decide policy for old-version entries: leave to TTL-expire (recommended, cheap) vs eager purge.

**Effort:** small. **Why P0:** without it, every prompt improvement below is invisible for up to a year.

---

## 3. Learner-grade entry schema — **P1** (the differentiator vs Cambridge)

Cambridge's moat is entry *depth*. Current schema (`server/providers/llm/types.ts`,
`LlmTranslationContent`) is flat: one `partOfSpeech`, 1–3 definitions, maybe one example each.
Upgrade the prompt + schema + UI to produce:

- [x] **Multiple parts of speech per word.** `adaptLlm()` currently collapses everything into a
      single `partOfSpeech`. "run" (verb) and "run" (noun) must be separate `Meaning` sections.
      Change `LlmTranslationContent.meanings` to be grouped by POS. (New `meaningGroups` field,
      each with its own `partOfSpeech` + `senses[]`; verified live with "run" and "bank" — separate
      colored POS sections render correctly.)
- [x] **CEFR level per sense and per example (A1–C2).** Cambridge tags these; learners rely on them.
      LLMs estimate CEFR reasonably well. Render as a small badge (e.g. `B2`) next to each sense.
      (Color-coded badge: green A, amber B, red C.)
- [x] **Grammar labels.** countable/uncountable, transitive/intransitive, `[+ that clause]`,
      irregular forms (go → went → gone), plural forms. Learners search dictionaries specifically
      for this.
- [x] **Register / usage labels.** formal, informal, slang, dated, offensive, UK vs US usage.
- [x] **"Common mistakes" notes** (learner-corpus style) — e.g. *"make a photo" → say "take a
      photo"*. This is where an LLM can genuinely beat a static dictionary; Cambridge charges for
      similar content (English Grammar Today boxes).
- [x] **Collocations.** "heavy rain (not ~~strong rain~~)", "commit a crime". Render as chips that
      link to their own entries — internal linking helps engagement *and* SEO (§5). (Verified the
      internal link loop end-to-end: clicking a chip navigates to `/word/:term` and generates a
      fresh entry. Had to add a defensive `cleanLinkTerm()`/`wordHref()` helper (`shared/wordLink.ts`)
      after the model initially returned annotated items like "runner (noun)" — the annotation is
      still shown, but stripped from the link target.)
- [x] **Word family.** run → runner, running, rerun; happy → happiness, unhappily. Also rendered as
      internal links.
- [x] **Graded example sentences — the core pitch.** 2–3 examples per sense at *different* CEFR
      levels (one simple, one intermediate, one advanced), each tagged with its level.
- [ ] **"More examples like this" button** — follow-up LLM call that regenerates examples
      constrained by topic ("about football", "business context") and/or the user's level. Cache
      each variant under its own key (word + sense + constraint). **Deferred** — scoped out of this
      pass as a separate interactive feature (new endpoint + its own caching scheme) rather than part
      of the core schema upgrade.
- [x] Update `buildMessages()` prompt + `parseContent()` validation for the richer schema; bump
      `promptVersion` (§2). (`CACHE_VERSION` bumped `v2` → `v3`.)
- [x] Update `PosSection.tsx` / `WordEntry.tsx` to render the new fields.

**Effort:** 1–2 weeks, mostly prompt iteration. Depends on §2.

**Notes from implementation:** the first live test surfaced two real prompt-reliability bugs, both
fixed and verified against the live LLM: (1) the model sometimes included a `translation` field even
in same-language define mode (harmless in the prompt's wording, but the client renders it whenever
truthy, so it would visibly mis-render) — fixed with a stronger prompt instruction *and* a defensive
strip in `openaiCompat.ts` when `sourceLang === targetLang`; (2) collocations/word-family items
sometimes came back with parenthetical POS annotations or slash-alternatives (e.g. "runner (noun)",
"run for president/mayor"), which would have produced broken link targets — fixed with a stronger
prompt instruction plus the `cleanLinkTerm()` defensive fallback above. Both are the kind of thing
the to-do's "eval harness" (§4) would catch systematically going forward.

---

## 4. Quality control & trust — **P1** (make-or-break for an LLM dictionary)

A dictionary's product is *trust*, and each LLM answer is frozen in the cache for a year.

- [ ] **Strict structured outputs.** Use `response_format: { type: "json_schema", … }` where the
      vendor supports it, instead of `json_object` + the regex JSON extraction in `parseContent()`
      (`server/providers/llm/openaiCompat.ts`). Fewer malformed entries entering the cache.
- [ ] **Pre-generate the head of the distribution with a stronger model.**
  - Source a frequency wordlist (e.g. top 10–20k lemmas per source language).
  - Offline batch job (new script under `scripts/`) generates entries with a *stronger/slower*
    model, optionally with a second-model review pass, and seeds the Mongo cache.
  - Live traffic then only hits the fast/cheap model for the long tail.
  - Bonus: kills the cold-start latency problem for the words people actually look up.
- [x] **"Report this entry" button** on `WordEntry` → new endpoint (e.g. `POST /api/report`) that
      flags the cache doc for regeneration (set a `flagged: true` field; regeneration job or manual
      review picks it up). This is the only feedback loop into a corpus too large to review manually.
      (Implemented as its own `reports` collection — word/langs/cache-version/reason/timestamp — rather
      than a single overwritable flag on the cache doc, so every report is auditable.)
- [ ] **Lightweight eval harness.** A fixed set of ~100 tricky words (polysemes, false friends,
      slang, inflected forms) with expected properties; run against a prompt/model change before
      bumping `promptVersion`. Wire into CI as a manual job (LLM cost).

---

## 5. SEO / SSR — **P1** (largest single work item; do before investing in growth)

Cambridge lives on organic search ("<word> meaning" queries). Our client-rendered React SPA serves
an empty `index.html` to crawlers — we cannot rank as-is.

- [x] **Server-render (or pre-render) `/word/:term` pages.** Options:
  - Vite SSR entry + Express render middleware (stays on current stack), or
  - migrate the frontend to a framework with SSR built in (Next/Remix/Astro).
  - Cheapest v1: pre-render static HTML for every entry already in the Mongo cache and serve those
    to crawlers/first paint, hydrate the SPA on top.
  (Implemented the "cheapest v1" option: `scripts/prerender.ts`, run via `npm run prerender` after
  `npm run build` — batch-generates `dist/word/<word>/index.html` for every already-cached en→en LLM
  entry, only touching content that's already cached so crawler traffic can never trigger a new LLM
  call. Relies on the SPA-fallback nginx rule (`try_files $uri $uri/ /index.html;`) already required
  for this app to work today — no nginx changes needed. Verified end-to-end against a real nginx
  container: `/word/hello` 301s to `/word/hello/` (standard directory-index redirect, same as any
  static-site generator) which then serves the prerendered page; CSR (`createRoot`, not
  `hydrateRoot`) fully replaces it on mount, so there's no hydration-mismatch risk. Must be run as
  part of the deploy process — MONGODB_URI isn't reachable during the CI build step, so it's a
  separate opt-in script, not folded into `npm run build`.)
- [x] **Per-word `<title>` and meta description** ("SERENDIPITY | definition, examples,
      pronunciation — Open Dictionary"). Done twice: statically in the prerendered HTML
      (`scripts/render.ts`) and live client-side for CSR navigation (`src/hooks/useDocumentMeta.ts`,
      wired into WordPage/Home/History/About) so the browser tab title/meta stay correct even when
      React Router navigates without a full page load.
- [x] **schema.org structured data** — `DefinedTerm` / `DefinedTermSet` JSON-LD per entry. (`DefinedTerm`
      only; skipped `DefinedTermSet` — there's no natural "set" grouping yet, e.g. by language pair or
      topic, to hang it off.)
- [x] **Sitemap** generated from the cache collection (new script or route); submit to Search Console.
      (`dist/sitemap.xml`, generated by `scripts/prerender.ts`. Submitting to Search Console is a
      manual step for whoever owns that account — not something this script can do.)
- [x] **Alphabetical browse/index pages** (`/browse/a`, `/browse/a/2` …) — gives crawlers a link
      graph and users a browse path. (Statically generated alongside word pages; only letters with at
      least one cached word get a page. Linked from the About page.)
- [x] Update `robots.txt` accordingly. (`scripts/prerender.ts` appends a `Sitemap:` line to
      `dist/robots.txt` pointing at `PUBLIC_BASE_URL`.)
- [x] Canonical URLs: decide how `?from=&to=` variants map to canonical pages (probably
      `/word/:term` canonical = en→en; language pairs get their own indexed paths, e.g.
      `/es-en/word/:term`, mirroring how Cambridge exposes bilingual editions). **Decided: en→en
      canonical only** — every `?from=&to=` variant's `<link rel="canonical">` points back to the
      plain `/word/:term` page; language pairs aren't separately indexed/sitemapped in this pass.

---

## 6. Search UX — **P1**

- [x] **Autocomplete / typeahead.** Cambridge shows instant suggestions; we only catch typos *after*
      a full LLM round-trip. Build a prefix index over (a) cached words in Mongo and (b) a seeded
      frequency wordlist. New endpoint `GET /api/suggest?q=…&lang=…` (rate-limited, no LLM, no auth).
      (Prefix index over cached words only — part (b), a seeded frequency wordlist, doesn't exist yet;
      see §4 pre-generated corpus. Coverage is limited to words someone has already looked up.)
- [ ] **Client-side fuzzy match** against the suggestion list to catch typos before spending an LLM
      call (keep the LLM "Did you mean?" as the fallback for what the wordlist misses). Deferred:
      no wordlist to fuzzy-match against yet (depends on the item above).
- [x] **Keyboard navigation** for suggestions (↑/↓/Enter/Escape) in `SearchBar.tsx`.

---

## 7. Audio & pronunciation for all languages — **P1/P2**

Audio is currently English-only, merged best-effort from Merriam-Webster
(`mergeAudioFromDictionary()` in `server/translate.ts`; noted in the design doc).

- [ ] **TTS provider integration** (cloud TTS APIs are near-free at this scale) for:
  - non-English headwords (closes the "no audio button for non-English" gap), and
  - **example-sentence playback** — big deal for learners, and Cambridge *doesn't* do it.
- [ ] Cache generated audio (object storage or Mongo GridFS; keyed by text+lang+voice) so each
      utterance is synthesized once.
- [ ] Keep MW audio for English headwords where available (real human recordings beat TTS); TTS as
      fallback.
- [ ] UK/US voice variants where the TTS provider supports them (matches the existing
      `pickAudio()` UK/US logic in `WordEntry.tsx`).

---

## 8. Learner retention features — **P2**

Favorites + history exist but are a dead end today. Turn them into a learning loop:

- [ ] **Spaced-repetition review** of favorited words. LLM generates cloze/quiz questions from the
      cached entry (cacheable per word). Simple SM-2-style scheduling stored per user in Mongo
      (extend the favorites collection or a new `reviews` collection).
- [ ] **Word of the day** — trivially generated from the pre-seeded wordlist, cached daily; good
      for return visits and (later) email/push.
- [x] **History page** — a real page listing history with re-lookup links (data already exists in
      `useUserData`).
- [ ] **User level setting (A1–C2)** in profile → used to pick which graded examples to show first
      and to tune "more examples" generation (§3).
- [ ] Later: streaks, per-user stats ("words learned this week").

---

## 9. Performance & operations — **P2**

- [ ] **Streaming or optimistic UI for cache misses.** Worst case today is a 15 s spinner
      (`LLM_REQUEST_TIMEOUT_MS`). Either stream the LLM entry in progressively, or immediately show
      the dictionary-fallback result and swap in the LLM entry when ready.
- [x] **Stampede protection.** Design doc defers it, but with SEO traffic a popular uncached word
      fans out into N simultaneous LLM calls. In-flight `Map<key, Promise>` dedup in
      `translate()` — ~15 lines.
- [ ] **Metrics** per design doc §12: cache hit/miss by tier, LLM latency/error by vendor, fallback
      rate. Even plain structured logs + a dashboard query is enough to start.
- [ ] Backups: current policy keeps only the single latest weekly dump
      (`scripts/mongodb-backup.sh`). Once the cache represents real LLM spend, keep more history
      (the pre-generated corpus is expensive to rebuild).

---

## 10. Licensing & sustainability — **P1 decision, ongoing**

- [ ] **Check the Merriam-Webster API license.** Free MW API keys are for **non-commercial** use.
      If this becomes a real product, the MW fallback + audio merging need a commercial agreement
      or a replacement (e.g. Wiktionary/Wikidata extracts + TTS for audio).
- [ ] **Never scrape Cambridge** (or copy their definitions into prompts). All content must be
      LLM-original or from properly licensed sources.
- [ ] **Sustainability without ads.** The cache makes marginal cost per user tiny after warm-up, so
      a freemium model fits the existing architecture: free lookups for everyone; paid tier for
      learning features (unlimited regenerated examples, quizzes/SRS, sentence audio). Decide early
      so §8 features are built with the gate in mind.
- [x] Add a public "About / how definitions are generated" page — transparency that content is
      AI-generated with a report/feedback loop (§4) builds trust and manages expectations.

---

## Suggested sequence

1. **§1 + §2** — render translation/examples, version the cache key (first PR, days).
2. **§3 + §4 (structured outputs, eval set)** — richer schema + prompt with CEFR/multi-POS/
   collocations (1–2 weeks, mostly prompt iteration).
3. **§6 autocomplete, §9 stampede dedup, §7 TTS** — each small and independent; parallelizable.
4. **§5 SSR/SEO** — the big one; do it before spending on growth.
5. **§4 pre-generated top-N corpus** with a strong model, then **§8 learner features** on top of
   favorites.

---

*Created 2026-07-10 from an architecture/product review of the MVP. Update checkboxes as items land;
re-prioritize freely.*
