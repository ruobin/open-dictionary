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

- [ ] **Multiple parts of speech per word.** `adaptLlm()` currently collapses everything into a
      single `partOfSpeech`. "run" (verb) and "run" (noun) must be separate `Meaning` sections.
      Change `LlmTranslationContent.meanings` to be grouped by POS.
- [ ] **CEFR level per sense and per example (A1–C2).** Cambridge tags these; learners rely on them.
      LLMs estimate CEFR reasonably well. Render as a small badge (e.g. `B2`) next to each sense.
- [ ] **Grammar labels.** countable/uncountable, transitive/intransitive, `[+ that clause]`,
      irregular forms (go → went → gone), plural forms. Learners search dictionaries specifically
      for this.
- [ ] **Register / usage labels.** formal, informal, slang, dated, offensive, UK vs US usage.
- [ ] **"Common mistakes" notes** (learner-corpus style) — e.g. *"make a photo" → say "take a
      photo"*. This is where an LLM can genuinely beat a static dictionary; Cambridge charges for
      similar content (English Grammar Today boxes).
- [ ] **Collocations.** "heavy rain (not ~~strong rain~~)", "commit a crime". Render as chips that
      link to their own entries — internal linking helps engagement *and* SEO (§5).
- [ ] **Word family.** run → runner, running, rerun; happy → happiness, unhappily. Also rendered as
      internal links.
- [ ] **Graded example sentences — the core pitch.** 2–3 examples per sense at *different* CEFR
      levels (one simple, one intermediate, one advanced), each tagged with its level.
- [ ] **"More examples like this" button** — follow-up LLM call that regenerates examples
      constrained by topic ("about football", "business context") and/or the user's level. Cache
      each variant under its own key (word + sense + constraint).
- [ ] Update `buildMessages()` prompt + `parseContent()` validation for the richer schema; bump
      `promptVersion` (§2).
- [ ] Update `PosSection.tsx` / `WordEntry.tsx` to render the new fields.

**Effort:** 1–2 weeks, mostly prompt iteration. Depends on §2.

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
- [ ] **"Report this entry" button** on `WordEntry` → new endpoint (e.g. `POST /api/report`) that
      flags the cache doc for regeneration (set a `flagged: true` field; regeneration job or manual
      review picks it up). This is the only feedback loop into a corpus too large to review manually.
- [ ] **Lightweight eval harness.** A fixed set of ~100 tricky words (polysemes, false friends,
      slang, inflected forms) with expected properties; run against a prompt/model change before
      bumping `promptVersion`. Wire into CI as a manual job (LLM cost).

---

## 5. SEO / SSR — **P1** (largest single work item; do before investing in growth)

Cambridge lives on organic search ("<word> meaning" queries). Our client-rendered React SPA serves
an empty `index.html` to crawlers — we cannot rank as-is.

- [ ] **Server-render (or pre-render) `/word/:term` pages.** Options:
  - Vite SSR entry + Express render middleware (stays on current stack), or
  - migrate the frontend to a framework with SSR built in (Next/Remix/Astro).
  - Cheapest v1: pre-render static HTML for every entry already in the Mongo cache and serve those
    to crawlers/first paint, hydrate the SPA on top.
- [ ] **Per-word `<title>` and meta description** ("SERENDIPITY | definition, examples,
      pronunciation — Open Dictionary").
- [ ] **schema.org structured data** — `DefinedTerm` / `DefinedTermSet` JSON-LD per entry.
- [ ] **Sitemap** generated from the cache collection (new script or route); submit to Search Console.
- [ ] **Alphabetical browse/index pages** (`/browse/a`, `/browse/a/2` …) — gives crawlers a link
      graph and users a browse path.
- [ ] Update `robots.txt` accordingly.
- [ ] Canonical URLs: decide how `?from=&to=` variants map to canonical pages (probably
      `/word/:term` canonical = en→en; language pairs get their own indexed paths, e.g.
      `/es-en/word/:term`, mirroring how Cambridge exposes bilingual editions).

---

## 6. Search UX — **P1**

- [ ] **Autocomplete / typeahead.** Cambridge shows instant suggestions; we only catch typos *after*
      a full LLM round-trip. Build a prefix index over (a) cached words in Mongo and (b) a seeded
      frequency wordlist. New endpoint `GET /api/suggest?q=…&lang=…` (rate-limited, no LLM, no auth).
- [ ] **Client-side fuzzy match** against the suggestion list to catch typos before spending an LLM
      call (keep the LLM "Did you mean?" as the fallback for what the wordlist misses).
- [ ] **Keyboard navigation** for suggestions (↑/↓/Enter/Escape) in `SearchBar.tsx`.

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
- [ ] **History page** — a real page listing history with re-lookup links (data already exists in
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
- [ ] Add a public "About / how definitions are generated" page — transparency that content is
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
