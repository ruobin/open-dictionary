# Design: Admin Cache Entries screen (view/moderate/delete `translations` docs)

**Status:** implemented (Phase 1 + 2, plus a dedicated `/admin/reports` page) · **Date:** 2026-07-14
**Scope:** a new `/admin/entries` page (+ supporting `/api/admin/entries*` routes) that lets an
allowlisted admin search, inspect, and delete individual documents in the MongoDB `translations`
collection — the corpus of cached LLM/dictionary dictionary entries served to every user.

> **Implementation note (post-ship):** all four open questions in §15 were resolved before
> implementation: (1) `resolveReports` defaults to `true`; (2) `mostReported` sort defaults on only
> when `hasReports=true`, `newest` otherwise, both as originally proposed; (3) no `WordEntry.tsx`
> refactor was needed — it was already a pure presentational component (`entries`, `sourceLang`,
> `targetLang`, `isFavorite`, `onToggleFavorite` props, no internal data-fetching), so the admin
> detail drawer imports it directly, unmodified; (4) **a dedicated `/admin/reports` page was built**
> (superseding §4.1's "no separate reports page" reasoning) per explicit user request — it lists
> individual report submissions newest-first with dismiss (delete the report, leave the entry) and
> delete-entry actions, plus a deep link into the matching `/admin/entries` row. See §17 for the
> as-built delta from this doc's original plan.

---

## 1. Why

Every dictionary lookup that isn't already cached gets one LLM-generated entry, frozen into the
`translations` collection for up to **1 year** (`docs/design-translation-cache.md` §7). There is
already a user-facing feedback loop for this — the **"Report this entry"** button
(`server/report.ts`, to-do §4) — but reports only *flag* a word into a separate `reports`
collection; nothing today lets an operator actually **look at** a flagged (or any) cached entry
and **delete** it so the next lookup regenerates a fresh one.

Concretely, today the only way to fix a bad cached entry is:

```js
docker exec open-dictionary-mongo mongosh open-dictionary --eval '
  db.translations.deleteOne({ _id: "<hash>" })
'
```

— which requires shell access to the box, knowing the `_id` hashing scheme
(`server/cache/translationCache.ts` `docId()`), and manually cross-referencing the `reports`
collection to know *which* words need attention. This doesn't scale past "the one developer with
docker access," and it's exactly the kind of operational task the admin portal
(`docs/design-admin-portal.md`) already exists to move out of shell access and into a reviewed,
audited UI.

### Goals

1. **Browse & search** cached `translations` entries: by word (prefix/substring), source/target
   language, tier (`llm` | `dict`), and — the highest-signal filter — **has open reports**.
2. **View full entry detail**: the exact JSON payload served to users (`entries[]`), plus metadata
   (tier, `version`, `fetchedAt`, age) and any associated `reports` docs (reason, reporter count,
   timestamp) so an admin can judge quality without opening a second tool.
3. **Delete** one (or a small selected batch of) bad/low-quality entries — the next user lookup for
   that word/lang-pair regenerates it from the current LLM prompt, at current `CACHE_VERSION`.
4. Deleting an entry **also resolves its associated reports** (so the report queue doesn't keep
   nagging about a problem that's already fixed) — configurable per delete action.
5. **Audit every delete** the same way every other admin mutation is audited (`admin_audit`,
   `docs/design-admin-portal.md` §4.5) — who deleted what cached word, when, and why (optional
   free-text reason).
6. Reuse 100% of the existing admin plane's auth, rate limiting, and UI shell — this is Phase 5 of
   the admin portal, not a new trust boundary.

### Non-goals

- **Editing entry content in place.** An admin cannot hand-edit a definition/example — that would
  let hand-authored content silently masquerade as LLM output with no `CACHE_VERSION` bump to
  signal the change, and it's a much bigger surface (rich text editing, re-validating the
  `DictionaryEntry` shape). If content is wrong, delete it and let the pipeline regenerate it, or
  fix the prompt (existing `CACHE_VERSION` bump path, `docs/design-translation-cache.md` §7.1).
- **Bulk/mass deletion by query** (e.g. "delete all `dict`-tier entries" or "delete everything
  matching `/^un/`"). Out of scope for v1 — high blast-radius, and the existing manual
  `deleteMany(...)` escape hatch (`docs/design-translation-cache.md` §7.1) already covers rare
  emergency-purge needs. v1 ships **select-and-delete from a filtered list**, capped per action
  (§9), not an unbounded query-shaped delete.
- **Regenerating an entry on demand from the admin panel** ("force refresh this word now"). Nice
  future addition (§13) — v1 relies on the existing behavior that a cache miss regenerates
  naturally on the next real user lookup.
- **Editing/deleting `more_examples` or `word_of_day` docs.** Same `translations` corpus only for
  v1; the design generalizes but isn't built for those collections now (§13).
- **Non-English fallback-tier or Merriam-Webster content moderation UI** beyond what's already
  visible on the entry (no new MW-specific tooling).
- **Automatic quality scoring / anomaly detection.** This is a manual review tool; a "flagged by N
  reports" sort is the only automated signal (§4).

---

## 2. Current state (what this builds on)

| Piece | Where | Relevance |
|---|---|---|
| `translations` collection (the corpus) | `server/cache/translationCache.ts`, `server/db.ts` | What this screen reads/deletes. `_id` is `sha1(sourceLang\|targetLang\|word\|version)` (`docId()`) — opaque, not human-typeable, so the UI must never require an admin to know it. |
| `reports` collection (user feedback) | `server/report.ts` | The "why should I look at this word" signal. Never previously surfaced anywhere but Mongo shell. |
| Compound query index `{ sourceLang, word }` (`translations_suggest`) | `server/db.ts` | Already exists for `/api/suggest`; reusable for the admin word-prefix search — **no new index needed** for the primary filter. |
| Reports indexes `{ word, sourceLang, targetLang }`, `{ createdAt: -1 }` | `server/db.ts` | Reusable for the "has reports" join (§5). |
| Admin plane: auth, rate limit, audit, router pattern | `server/admin/{router,auth,audit}.ts` | This feature is new routes bolted onto the existing `createAdminRouter(llmService)` — no new auth model. |
| Admin SPA shell, nav, page/component conventions | `src/pages/admin/*`, `src/components/admin/*`, `src/styles/admin.css` | New page follows the exact `Providers.tsx`/`Audit.tsx` shape: outlet context, `src/api/admin.ts` fetch layer, `.admin-*` CSS classes. |
| `CACHE_VERSION` / tiered lookup semantics | `server/translate.ts`, `docs/design-translation-cache.md` §5, §7 | Deleting a doc only removes that exact `(word, src, tgt, version)` slot; a regenerate is just "the next request misses and refetches" — no new invalidation mechanism needed. |
| `DictionaryEntry` shape (what's rendered) | `server/translate.ts`, `src/api/dictionary.ts` | The detail view renders this exact JSON — same shape the public `WordEntry.tsx` component consumes, so a "preview" can reuse it (§6, §13). |

---

## 3. Data model — no new collections, no schema change

This feature is **read/delete only** against two existing collections. No new Mongo collection,
no new field on `TranslationDoc` or `ReportDoc`. (An earlier idea — adding a `flagged: boolean` to
`TranslationDoc`, floated in the to-do §4 comment — is explicitly **not** taken; report state stays
sourced live from `reports` counts, so there is nothing to keep in sync.)

**`translations`** (`server/cache/translationCache.ts` `TranslationDoc`) — read + delete:
```jsonc
{
  "_id": "e949e4d5…",              // sha1(sourceLang|targetLang|word|version) — opaque
  "word": "hello", "sourceLang": "en", "targetLang": "en",
  "entries": [ /* DictionaryEntry[] — the exact payload served to users */ ],
  "source": "llm",                  // "llm" | "dict" — which tier produced it
  "version": "v3",                  // CACHE_VERSION at write time
  "fetchedAt": ISODate, "schemaVersion": 1
}
```

**`reports`** (`server/report.ts` `ReportDoc`) — read + delete (on resolve):
```jsonc
{ "_id": ObjectId, "word": "model", "sourceLang": "en", "targetLang": "en",
  "version": "v3", "reason": "definition is wrong for the tech sense", "createdAt": ISODate }
```

Reports are matched to a translation doc by `(word, sourceLang, targetLang)` — **not** `version`,
so a report filed against an older `CACHE_VERSION` still surfaces against whatever doc currently
occupies that `(word, src, tgt)` slot today (the report is about the *word*, the version is
provenance). This mirrors how `server/report.ts`'s own doc comment already frames reports as
independent of the cache doc they were about.

---

## 4. Admin API (`server/admin/entries.ts` + routes on the existing admin router)

All routes under `/api/admin/entries*`, behind the existing `requireAdmin` + `adminLimiter`
(`server/admin/router.ts`) — no new middleware, same 30 rpm/IP ceiling as every other admin route
(reads are cheap Mongo queries, no LLM cost, so no separate cap is needed).

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/admin/entries` | Paginated, filtered list | Query: `word?` (prefix match via existing `translations_suggest`-style regex, same `escapeRegex` helper as `server/suggest.ts`), `sourceLang?`, `targetLang?`, `tier?` (`llm`\|`dict`), `hasReports?` (`true`\|`false`\|absent=any), `sort?` (`newest`\|`oldest`\|`mostReported`, default `mostReported` when `hasReports=true` else `newest`), `limit` (default 25, max 100), `before?` (cursor, `fetchedAt` ISO string). Returns `{ entries: EntrySummaryView[], hasMore }`. |
| `GET /api/admin/entries/:id` | Full detail | `:id` is the Mongo `_id` hash (opaque, copied from the list row — never typed by hand). Returns `{ entry: EntryDetailView }` — full `entries[]` payload + all matching `reports` docs. `404` if the doc no longer exists (e.g. already deleted in another tab). |
| `DELETE /api/admin/entries/:id` | Delete one cached entry | Body: `{ resolveReports?: boolean (default true), reason?: string (≤500 chars) }`. Deletes the `translations` doc; if `resolveReports`, also deletes every `reports` doc matching the same `(word, sourceLang, targetLang)`. Audits (`entry.delete`). `404` if already gone (idempotent-friendly: not an error the UI needs to treat specially, just refresh the list). |
| `POST /api/admin/entries/batch-delete` | Delete a small selected batch | Body: `{ ids: string[] (1–20), resolveReports?: boolean (default true), reason?: string }`. Same semantics as single delete, looped server-side inside one handler; one audit entry summarizing the batch (§7). **Not** a query-shaped bulk delete — `ids` must be literal `_id`s the client already fetched via `GET /entries`, closing off "type a regex, wipe the corpus" as an attack/mistake shape. |
| `GET /api/admin/reports/summary` | Reports overview counts | `{ total, byWordCount (top N words by report count) }` — powers an "N entries have open reports" stat on Overview (§8) without a separate reports browser page (v1 folds reports entirely into the entry-centric view — see §4.1). |

### 4.1 Why no separate `/admin/reports` page

Reports only matter in the context of *the entry they're about* — an admin's workflow is always
"a word was reported → look at the current cached entry for that word → decide delete or leave."
A standalone reports list would just be a worse, disconnected version of the same lookup. So v1
surfaces reports as:
- a **filter** (`hasReports=true`) and **sort** (`mostReported`) on the entries list,
- a **section in the entry detail view** (report reasons + count + dates),
- a **summary stat** on Overview (§8) linking straight into the filtered list.

If reports volume ever grows enough to need triage independent of a specific word (e.g. marking a
report "reviewed, entry is fine, no action needed" without deleting anything), that's a
`reports.status` field + dedicated page — noted as a possible follow-up (§13), not built now
because there is currently no volume to justify it (2 reports total in production as of this
writing).

### 4.2 List response shape

```ts
interface EntrySummaryView {
  id: string                 // translations._id
  word: string
  sourceLang: string
  targetLang: string
  tier: 'llm' | 'dict'
  version: string
  fetchedAt: string           // ISO
  reportCount: number         // 0 if none
  headwordPreview?: string    // entries[0].meanings[0]?.definitions[0]?.definition, truncated — list-row context without a full fetch
}
```

### 4.3 Detail response shape

```ts
interface EntryDetailView {
  id: string
  word: string
  sourceLang: string
  targetLang: string
  tier: 'llm' | 'dict'
  version: string
  fetchedAt: string
  entries: DictionaryEntry[]   // exact payload — reuse the existing shared type, no new interface duplication
  reports: {
    id: string
    reason?: string
    createdAt: string
  }[]
}
```

`DictionaryEntry` is imported from `server/translate.ts` (already exported) on the server side and
from `src/api/dictionary.ts` (already exported, structurally identical) on the client — **no new
type duplication**, matching how `src/api/admin.ts` already re-declares server view shapes 1:1 for
every other admin resource (`ProviderView`, `BenchmarkTargetResult`, etc.).

---

## 5. Query implementation notes

- **Word filter**: prefix-regex against `word`, reusing `escapeRegex()` (currently private to
  `server/suggest.ts` — move it to a small shared `server/util/regex.ts`, or duplicate the
  one-liner; either is fine, flagged as a to-do item below). Anchored `^` prefix match uses the
  existing `translations_suggest` index (`{ sourceLang: 1, word: 1 }`) efficiently when
  `sourceLang` is also given; an unanchored substring search is **not** offered in v1 (would force
  a collection scan on `word` — acceptable to add later behind a "contains" toggle once corpus size
  warrants it, see §13).
- **`hasReports` / `mostReported`**: reports are in a separate collection, so this is implemented as
  a two-step read (not a Mongo `$lookup` aggregation, to keep the query simple and index-friendly
  at current scale — a few dozen to low hundreds of docs):
  1. `reports.aggregate([{ $group: { _id: {word,sourceLang,targetLang}, count: {$sum:1}, lastAt: {$max:"$createdAt"} } }])` (or a filtered/prefixed variant when `word`/langs are also supplied) → an in-memory `Map` of report counts per `(word, src, tgt)` key, capped at a few hundred groups (bounded by realistic report volume — revisit with a real `$lookup` if reports ever reach thousands).
  2. Apply as a post-filter/sort over the `translations` page. Because `limit` is small (≤100) and
     `hasReports=true` implies "start from the reports groups, not from all translations," the
     `hasReports=true` path actually queries `translations` by the specific `(word, src, tgt)` keys
     from step 1 (an `$or` of ≤ a few hundred exact matches) rather than scanning the whole
     collection — cheap either way at today's corpus size (78 translations, 2 reports).
- **Pagination**: cursor on `fetchedAt` (same pattern as `server/admin/audit.ts`'s `before` param),
  not skip/offset — consistent with the one other paginated admin list in this codebase.
- **No full-text search** on definition content in v1 — word-prefix is the practical entry point
  (an admin reviewing quality almost always starts from "the word that was reported" or "a word I
  want to spot-check"), and Mongo Atlas Search / a text index is real added infra for a need that
  hasn't materialized (§13).

---

## 6. Frontend

### 6.1 New route

```
/admin/entries         Cache Entries — list + filters + detail drawer
```

Added to `src/pages/admin/index.tsx`'s `<Routes>` and `AdminLayout.tsx`'s nav
(`Overview · Providers · Latency lab · Entries · Audit log`) — same lazy-loaded admin bundle,
no separate code-split (the whole `/admin/*` tree is already one lazy chunk).

### 6.2 Page layout

```
┌ Cache Entries ───────────────────────────────────────────────────────┐
│ Word: [_______]  Lang: en→[en ▾]  Tier: [any ▾]  ☐ Has reports only  │
│ Sort: [Most reported ▾]                          [Refresh]           │
├────────────────────────────────────────────────────────────────────  │
│ ☐ hello        en→en   llm   v3   2026-07-01    ⚠ 0        [View]   │
│ ☐ model        en→en   llm   v3   2026-06-28    ⚠ 1        [View]   │
│ ☐ affordance   en→tr   llm   v3   2026-07-10    ⚠ 1        [View]   │
├────────────────────────────────────────────────────────────────────  │
│ 3 selected                          [Delete selected…] [Load more]   │
└────────────────────────────────────────────────────────────────────  │

Detail drawer (opened via [View], same drawer pattern as ProviderForm):
┌ hello · en → en ──────────────────────────────────────── [Close]    │
│ tier: llm · version: v3 · cached 2026-07-01 · id: e949e4d5…         │
│                                                                       │
│ REPORTS (1)                                                          │
│ "definition is wrong for the tech sense" — 2026-07-10                │
│                                                                       │
│ ENTRY JSON                                    [rendered preview ▾]   │
│ { "word": "hello", "meanings": [ … ] }         (WordEntry-style view) │
│                                                                       │
│ [Delete this entry…]                                                 │
└───────────────────────────────────────────────────────────────────── │
```

- **Rendered preview toggle**: the detail drawer defaults to (or offers a toggle for) rendering
  `entries` through the *same* presentational logic as the public `WordEntry.tsx` component — an
  admin judging "is this a bad definition" wants to see it as a user would, not squint at raw JSON.
  Pure JSON view stays available (collapsible `<details>`/toggle) for anyone who wants the exact
  payload, e.g. to paste into a bug report. Implementation: extract `WordEntry`'s pure rendering
  (no data-fetching) into a shape it can accept as a prop today already does
  (`entries: DictionaryEntry[]`), so the admin page imports the same component — **zero UI
  duplication**, one bugfix in one place if the entry-rendering markup ever changes.
- **Delete confirmation**: a modal/inline confirm (matching the existing `window.confirm(...)`
  pattern used by `Providers.tsx handleDelete` for provider deletion) — for v1, a plain
  `window.confirm` is consistent with the rest of the admin UI; an optional free-text reason field
  can be a simple `prompt()`-style inline input in the confirm dialog, not a separate modal
  component. Batch delete confirms with the count ("Delete 3 entries? This cannot be undone.").
- **Post-delete state**: row disappears from the list immediately (optimistic) or the list
  reloads — reuse the exact `handleDelete` → `reload()` pattern from `Providers.tsx`.

### 6.3 New files

```
server/admin/entries.ts        # list/detail/delete + report-count join (§4, §5)
server/admin/entries.test.ts   # unit tests (§10)
src/api/admin.ts               # + listEntries / getEntry / deleteEntry / batchDeleteEntries / getReportsSummary
src/pages/admin/Entries.tsx    # page — list + filters + selection + drawer host
src/components/admin/EntryRow.tsx        # one list row (checkbox, word/langs/tier/date/report badge, View)
src/components/admin/EntryDetailDrawer.tsx  # drawer: metadata + reports + rendered/JSON toggle + delete
src/components/admin/EntryFilters.tsx    # the filter bar (word/lang/tier/hasReports/sort)
```

`src/components/WordEntry.tsx` gains no new file but a small internal refactor: split its pure
render logic (given `entries: DictionaryEntry[]`) from its data-fetching/hook usage, so
`EntryDetailDrawer` can import just the render piece. If that split turns out messier than
expected once someone is in the code, the fallback is a small **read-only** duplicate renderer
scoped to admin — noted as an acceptable fallback, not a blocker to shipping the rest of the
feature.

---

## 7. Audit trail

New `AdminAuditAction` values, added alongside the existing six
(`provider.create/update/delete`, `active.switch`, `benchmark.run`, `env.import`) in both
`server/admin/audit.ts` and `src/api/admin.ts`'s mirrored `AdminAuditAction` type:

- `entry.delete` — `target: { name: "<word> (<sourceLang>→<targetLang>)" }`,
  `diff: { tier, version, reportsResolved: number, reason? }`. (No `providerId`-shaped target
  applies here; `AdminAuditTarget.name` already exists and is a plain string, reused as-is — no
  new target field needed, since a `translations` doc doesn't have a stable human `_id` worth
  displaying, unlike a provider's Mongo `ObjectId`.)
- `entry.batch_delete` — `target: { name: "<count> entries" }`,
  `diff: { ids: string[], reportsResolved: number, reason? }` (ids capped at 20 per §4, so the diff
  stays small; existing `redactDiff()` in `server/admin/audit.ts` runs over this diff exactly like
  every other action's — no key-shaped fields here, so nothing gets redacted, which is correct).

No change needed to `redactDiff()` itself — entry diffs contain no `apiKey`-shaped fields, so the
existing sensitive-key-name regex simply never matches, same as `active.switch`'s diff today.

---

## 8. Overview page integration (small addition)

Add one stat card to `src/pages/admin/Overview.tsx`: **"Entries with open reports: N"** (from
`GET /api/admin/reports/summary`), linking to `/admin/entries?hasReports=true`. This is the single
highest-value discoverability hook — an admin lands on Overview and immediately sees "3 words need
attention" instead of having to know the Entries page exists and think to filter it.

---

## 9. Guardrails / cost & safety

Unlike the Providers/Latency Lab features, this touches **no paid LLM calls** — deletes are cheap
Mongo writes and the regeneration cost (one LLM call) is paid by whichever real user's lookup
happens to miss the cache next, exactly the same cost profile as any organic cache miss today.
Guardrails here are about **blast radius of an accidental/malicious delete**, not spend:

| Guardrail | Value |
|---|---|
| Batch delete size | 1–20 `ids` per call, ids must come from a prior `GET /entries` response (no query-shaped bulk delete — §1 non-goals) |
| List page size | default 25, hard cap 100 |
| Admin route rate limit | existing 30 rpm/IP (`ADMIN_RATE_LIMIT_RPM`), unchanged, applies to these routes too |
| Delete is hard, not soft | no "trash/undo" in v1 (see §12 for why, and the mitigation) — deliberate simplification, revisit if mis-deletes become a real incident |
| Audit | every delete/batch-delete recorded with actor + word(s) + reason (§7) |

---

## 10. Testing strategy

Mirrors the existing admin-module pattern (`docs/design-admin-portal.md` §14: direct unit tests
against exported functions, no supertest anywhere in this codebase):

- **Query/filter builders** (pure functions, unit-tested without Mongo): `parseEntriesQuery()`
  (word/lang/tier/hasReports/sort/limit/before parsing + validation, mirroring
  `server/admin/benchmark.ts`'s `validateBenchmarkRequest` and `server/admin/audit.ts`'s
  `parseAuditQuery` styles), `escapeRegex` reuse.
- **Report-count join logic**: given a fixed set of fake `reports` groups + `translations` docs,
  assert the merged `EntrySummaryView[]` has correct `reportCount` and `mostReported` ordering —
  testable as a pure function taking the two raw arrays, without touching Mongo (same style as
  `server/admin/benchmark.ts`'s `summarize()` unit tests).
- **Delete handlers**: with a fake Mongo-like collection double (or `mongodb-memory-server` if
  introduced — not currently a dependency, so prefer hand-rolled fakes consistent with the rest of
  this codebase's test style), assert: doc removed, matching reports removed when
  `resolveReports !== false`, reports left alone when `resolveReports: false`, 404 semantics when
  the id doesn't exist, batch cap enforced (21 ids → 400).
- **Audit**: assert `entry.delete`/`entry.batch_delete` diffs never contain full entry content (no
  need to redact — just confirm the diff shape is the small summary described in §7, not an
  accidental full-payload dump that would bloat the audit collection).
- **Frontend**: no existing frontend test infra to extend beyond what's there today (this codebase
  has no component-level frontend tests currently — consistent scope, not introducing new tooling
  for this feature alone).

---

## 11. Security considerations (delta to `docs/security.md`)

No new trust boundary — this is additional routes under the existing `/api/admin/*` plane, so every
control in `docs/security.md`'s "Admin plane" table (allowlist authz, rate limiting, audit,
injection safety) applies unchanged. Specific notes:

- **Injection**: `:id` path params are opaque sha1 hex strings, not `ObjectId`s — validate as
  `/^[a-f0-9]{40}$/` before querying (analogous to how provider routes validate `ObjectId.isValid`)
  rather than passing the raw param straight into a Mongo filter.
- **Regex DoS via `word` filter**: `escapeRegex()` already neutralizes special characters (reused
  from `server/suggest.ts`), and the pattern is always anchored (`^prefix`), which Mongo can use an
  index for and which bounds worst-case backtracking — no unanchored/arbitrary user regex is ever
  passed to Mongo.
- **Read exposure**: entry detail responses include full `DictionaryEntry` content, which is
  already public information (anyone can look up the same word via `/api/translate/:text`) — no new
  data exposure, just a different access path to the same public corpus, now report-annotated.
- **Delete is destructive but admin-trust-scoped**: same accepted tradeoff as every other admin
  mutation (`docs/security.md`'s SSRF-via-`baseUrl` note is the closest precedent) — an allowlisted
  admin can already do far more damage via server/mongo shell access; this doesn't lower the bar,
  it replaces a shell command with an audited UI action.

---

## 12. Failure modes & edge cases

| Situation | Behavior |
|---|---|
| Delete a doc that's already gone (double-click, two admins) | `404` from `DELETE /entries/:id` — UI treats as success-ish (refresh list), not a scary error; idempotent from the user's perspective. |
| Delete an entry while a real user's request for that exact word is in-flight (`translate.ts`'s in-flight dedup) | No conflict: the in-flight request already has its result in memory and will `cacheSetSafe()` normally after the admin's delete completes — the doc simply gets rewritten a few hundred ms later by that in-flight request, indistinguishable from the delete happening a moment later. Not a race worth guarding against. |
| Delete, then the exact same word is looked up again immediately by a real user | Clean cache miss → regenerates via the normal LLM→dictionary tiering (`server/translate.ts` `doTranslate()`) — this *is* the intended remediation path, not a special case. |
| Mongo down | List/detail/delete all fail the same way every other admin Mongo-backed route does today — `503 { error: "mongo_unavailable" }` (`MongoUnavailableError` pattern, `server/admin/providersRepo.ts`). |
| `resolveReports: false` used, then the same word is deleted again later | Reports persist across the first delete (by design) and get resolved on whichever delete call actually passes `resolveReports: true` (or the default) — no special handling needed, it's just "reports outlive one specific cached doc" as documented in §3. |
| No "undo" for a delete | Accepted for v1 (§1 non-goals implicitly, made explicit here): the practical "undo" is that the word gets regenerated by the next real lookup, which for the vast majority of dictionary words produces an equivalent-quality result (the whole point of deleting a *bad* one). If an admin needs the literal prior bytes back, the nightly `scripts/mongodb-backup.sh` dump is the recovery path — same as it is for any other accidental Mongo write today. Noted as a possible P2 (§13: soft-delete/trash) if this bites someone in practice. |
| Batch delete where some ids are already gone | Per-id best-effort: the handler doesn't fail the whole batch because of an already-missing doc; response reports how many were actually deleted vs. not-found, audit records the requested batch either way. |

---

## 13. Future work (explicitly out of scope for v1)

- **Regenerate-on-demand** button in the detail drawer (delete + immediately trigger a synchronous
  LLM call + show the new result inline) — turns "delete and hope a user looks it up soon" into an
  instant admin-driven refresh. Straightforward to add once v1's delete path is proven; deferred to
  keep this doc's scope to the originally requested view/delete need.
- **Soft delete / trash with restore window** — if accidental deletes turn out to be a real
  incident, add a `deletedAt`-flagged copy (or a short-TTL `translations_trash` collection) instead
  of a hard delete, with a "Recently deleted (7 days)" tab and a restore action. Not built now
  because there is no evidence yet that hard-delete-plus-backup isn't sufficient.
- **Reports triage state** (`reports.status: "open" | "resolved" | "wontfix"`) independent of
  deleting the entry — lets an admin dismiss a report as "checked, entry is actually fine" without
  touching the cache doc. Deferred per §4.1 (no current volume to justify it).
- **Bulk/query-shaped delete** (e.g. "delete all entries for `targetLang=fr`" for a language being
  sunset, or "delete everything below `CACHE_VERSION v2`") — a genuinely useful ops tool eventually,
  but a much bigger blast-radius feature than "select rows I've already looked at and delete them";
  deferred until there's a concrete need (the existing manual `deleteMany` shell escape hatch
  already covers today's rare cases).
- **Full-text / substring search over definitions** — needs a text index or external search infra;
  word-prefix search is sufficient for the "I know which word to review" workflow that reports and
  manual spot-checks both produce.
- **Extend to `more_examples` and `word_of_day` collections** — same view/delete pattern, smaller
  collections, lower priority; the design here generalizes (swap the collection + adjust the detail
  shape) if/when needed.
- **CSV/JSON export of a filtered entry list** — useful for offline quality review at scale; trivial
  to add once the list endpoint exists, not needed for v1's interactive-review workflow.

---

## 14. Rollout plan

Each phase independently shippable, matching the existing admin portal's phased-rollout precedent
(`docs/design-admin-portal.md` §15):

- **Phase 1 — read-only:** `GET /entries` (list + filters), `GET /entries/:id` (detail with
  rendered preview + reports), `GET /reports/summary`, the `/admin/entries` page. Zero write
  surface — safe to ship and get real usage/feedback on the filters before adding delete.
- **Phase 2 — delete:** `DELETE /entries/:id`, `POST /entries/batch-delete`, confirm dialogs,
  audit entries, the Overview stat card link-through.
- **Phase 3 (optional, only if needed) — polish:** any of §13's follow-ups, prioritized by real
  usage (e.g. regenerate-on-demand is the most likely first pick if admins keep manually
  re-looking-up a word right after deleting it).

### New/changed files (proposed layout)

```
server/admin/entries.ts          # list/detail/delete + report-count join, parseEntriesQuery()
server/admin/entries.test.ts     # unit tests
server/admin/router.ts           # + GET/DELETE routes wired in (existing file, extended)
server/admin/audit.ts            # + 'entry.delete' | 'entry.batch_delete' to AdminAuditAction
server/util/regex.ts             # (new, small) escapeRegex() moved here from suggest.ts, reused
server/suggest.ts                # import escapeRegex from the new shared location
src/api/admin.ts                 # + entries/reports types + fetch functions, + AdminAuditAction values
src/pages/admin/Entries.tsx      # new page
src/pages/admin/AdminLayout.tsx  # + nav link
src/pages/admin/Overview.tsx     # + "open reports" stat card
src/pages/admin/index.tsx        # + <Route path="entries" .../>
src/components/admin/EntryRow.tsx
src/components/admin/EntryDetailDrawer.tsx
src/components/admin/EntryFilters.tsx
src/components/WordEntry.tsx     # small refactor: extract pure render piece for reuse in the drawer
src/styles/admin.css             # + .admin-entries-* rules (list rows, report badge, drawer sections)
docs/security.md                 # + one line noting entries CRUD under the existing admin table (no new boundary)
```

No new env vars, no new Mongo collections, no new indexes required for v1 (existing
`translations_suggest` and `reports_word`/`reports_recent` indexes already fit the query patterns
in §5).

---

## 15. Open questions

1. **`resolveReports` default** — default `true` (deleting an entry resolves its reports) seems
   right for the common case ("I looked at the report, fixed it by deleting, done"), but should
   double-check this is the desired default vs. always requiring an explicit choice in the confirm
   dialog (a checkbox, defaulted checked, is the proposed UI — §6.2).
2. **`mostReported` default sort** — proposed default sort is `mostReported` only when
   `hasReports=true` is set, `newest` otherwise. Confirm that's the right default rather than always
   defaulting to `mostReported` regardless of the filter (i.e., should un-reported-but-recently-bad
   entries surface without explicitly filtering?).
3. **Rendered-preview reuse risk** (§6.3) — confirm the `WordEntry.tsx` render/data-fetch split is
   acceptable scope for this feature, or whether a intentionally-simpler read-only admin-only
   renderer is preferred to avoid touching a user-facing component at all. Leaning toward the
   split (DRY, one source of truth for "what does an entry look like") but flagging the tradeoff
   explicitly since it's the one change here that touches non-admin code.
4. **Is `/admin/reports` really unnecessary?** (§4.1) — confirmed reasonable at 2 reports total
   today; revisit if report volume grows enough that "which reports have I already looked at and
   decided to leave" becomes its own workflow independent of any specific delete decision.

---

## 16. Todo list (implementation checklist)

Ordered to match the phased rollout (§14); each top-level item is independently shippable/testable.

### Phase 1 — read-only list, detail, and reports surfacing
- [x] `server/util/regex.ts`: extract `escapeRegex()` out of `server/suggest.ts` into a shared
      location; update `server/suggest.ts` to import it (no behavior change, pure refactor).
- [x] `server/admin/entries.ts`:
  - [x] `parseEntriesQuery()` — pure, unit-tested query/filter parser (word, sourceLang, targetLang,
        tier, hasReports, sort, limit, before) mirroring `parseAuditQuery`/`validateBenchmarkRequest`.
  - [x] Report-count join: `groupReportsByEntry()` (or similar pure function) taking raw `reports`
        docs and returning a `Map<"src|tgt|word", { count, lastAt }>` — unit-testable without Mongo.
  - [x] `listEntries(query)` — Mongo I/O: queries `translations` (+ the report-count map from
        `reports`), returns `{ entries: EntrySummaryView[], hasMore }`. Handles the two query
        shapes from §5 (plain prefix scan vs. `hasReports=true`'s exact-key `$or`).
  - [x] `getEntry(id)` — validates `id` matches `/^[a-f0-9]{40}$/`, fetches the `translations` doc +
        all matching `reports` docs, returns `EntryDetailView` or `null`.
  - [x] `getReportsSummary()` — `{ total, byWordCount }` for the Overview stat card.
- [x] `server/admin/entries.test.ts` — unit tests per §10 (query parsing, report-count join,
      `getEntry` 404 shape via a fake collection double).
- [x] `server/admin/router.ts` — wire `GET /entries`, `GET /entries/:id`,
      `GET /reports/summary` (reuse existing `MongoUnavailableError` → 503 pattern).
- [x] `src/api/admin.ts` — add `EntrySummaryView`, `EntryDetailView`, `ReportsSummary` types +
      `listEntries()`, `getEntry()`, `getReportsSummary()` fetch functions (mirroring existing
      `listProviders`/`listAudit` shapes).
- [x] `src/components/WordEntry.tsx` — refactor to split pure rendering (given `entries:
      DictionaryEntry[]`) from data-fetching, so it's importable read-only elsewhere. (Fallback: a
      separate minimal admin-only renderer if the split proves too invasive — see §6.3, §15 Q3.)
- [x] `src/components/admin/EntryFilters.tsx` — filter bar (word input, lang selects reusing
      `shared/languages.ts` `LANGUAGES`, tier select, "has reports" checkbox, sort select).
- [x] `src/components/admin/EntryRow.tsx` — one list row: checkbox, word, langs, tier badge,
      `fetchedAt` (relative + absolute on hover, matching `AuditTable`'s date convention), report
      count badge, `[View]` button.
- [x] `src/components/admin/EntryDetailDrawer.tsx` — drawer: metadata header, reports section,
      rendered-preview/raw-JSON toggle (using the split `WordEntry` render piece), close button.
      No delete button yet in this phase (read-only).
- [x] `src/pages/admin/Entries.tsx` — page: filters, paginated list (cursor "Load more" like
      `Audit.tsx`), selection state (checkboxes, unused until Phase 2), drawer host.
- [x] `src/pages/admin/AdminLayout.tsx` — add `NavLink` to `/admin/entries` in the nav bar.
- [x] `src/pages/admin/index.tsx` — add `<Route path="entries" element={<Entries />} />`.
- [x] `src/pages/admin/Overview.tsx` — add "Entries with open reports: N" stat card, linking to
      `/admin/entries?hasReports=true`.
- [x] `src/styles/admin.css` — add `.admin-entries-*` rules (filter bar layout, row report badge,
      drawer sections) following existing `.admin-*` naming.
- [x] Manual verification: filters return correct results against the live 78-doc/2-report corpus;
      detail drawer renders both toggled views correctly; Overview stat links through correctly.

### Phase 2 — delete
- [x] `server/admin/entries.ts`:
  - [x] `deleteEntry(id, { resolveReports, actorSub, ip, reason })` — deletes the `translations`
        doc, conditionally deletes matching `reports`, returns `{ deleted: boolean, reportsResolved:
        number }` (deleted=false when already gone → caller maps to 404 vs. treats as success).
  - [x] `batchDeleteEntries(ids, opts)` — validates `1 ≤ ids.length ≤ 20`, loops `deleteEntry`,
        aggregates results for the audit diff and the response.
- [x] `server/admin/audit.ts` — add `'entry.delete' | 'entry.batch_delete'` to `AdminAuditAction`
      (both the type union and any switch/validation referencing the full action list).
- [x] `server/admin/router.ts` — wire `DELETE /entries/:id`, `POST /entries/batch-delete`; call
      `recordAudit()` with the shapes from §7; enforce the 1–20 cap with a `400` on violation.
- [x] `server/admin/entries.test.ts` — add delete/batch-delete tests per §10 (doc removed, reports
      resolved/not per flag, 404 on missing, cap enforcement, partial-success batch reporting).
- [x] `src/api/admin.ts` — add `'entry.delete' | 'entry.batch_delete'` to the mirrored
      `AdminAuditAction` type; add `deleteEntry()`, `batchDeleteEntries()` fetch functions.
- [x] `src/components/admin/EntryDetailDrawer.tsx` — add `[Delete this entry…]` button + confirm
      dialog (optional reason input), calling `onDeleted()` to close the drawer and refresh the list.
- [x] `src/pages/admin/Entries.tsx` — wire selection checkboxes to a real "Delete selected…" action
      with a count-aware confirm dialog; handle partial-success responses (some ids not-found).
- [x] `docs/security.md` — add a one-line note that entries CRUD lives under the existing admin
      table (no new trust boundary), per §11.
- [x] `docs/design-admin-portal.md` — cross-reference this doc from the "future/related" area if
      that doc maintains such a list (optional, low-priority housekeeping).
- [x] Manual verification against the live corpus: delete a low-value/test entry end-to-end, confirm
      (a) it disappears from `translations`, (b) its `reports` docs are gone (default flag), (c) an
      `admin_audit` entry was written, (d) a fresh lookup of that word regenerates cleanly via
      `/api/translate/:word`.

### Phase 3 (optional/follow-up, not blocking ship)
- [ ] Revisit §13 items based on real admin usage after Phase 1+2 are live for a while
      (regenerate-on-demand is the most likely first candidate per §13's own note).

---

## 17. As-built delta (implemented 2026-07-14)

Phase 1 and Phase 2 shipped together in one pass, plus one addition beyond the original plan:

- **`/admin/reports` page — built, superseding §4.1.** Per explicit user instruction ("I need
  `/admin/reports` for my own purpose"), a dedicated reports page was added rather than folding
  reports entirely into the entries view as §4.1 originally proposed. New surface:
  - `GET /api/admin/reports` — newest-first paginated list of individual `reports` docs
    (`server/admin/entries.ts` `listReports()`/`parseReportsQuery()`), each annotated with the
    matching `translations._id` (if the entry still exists) via one batched `$or` lookup — no N+1.
  - `DELETE /api/admin/reports/:id` — dismisses a single report without touching the cache entry
    (`dismissReport()`), audited as a new `report.dismiss` action. This is exactly the "reports
    triage state independent of deleting the entry" follow-up §13 had deferred — built now because
    there's a concrete need for it.
  - `src/pages/admin/Reports.tsx` — table of word / langs / reason / reported-at, with
    **Dismiss** (delete the report only), **Delete entry** (deletes the cached entry and thus
    resolves every report on that word/lang-pair, not just the one row — the list updates
    accordingly), and a **View entry** deep link into `/admin/entries?word=<word>`.
  - `/admin/entries` gained `?word=` search-param support (in addition to the pre-existing
    `?hasReports=true`) so the deep link actually lands on the right row.
  - The Overview stat card now links to `/admin/reports` instead of the filtered entries list.
  - `reports._id` is a Mongo `ObjectId`, not a sha1 hash like `translations._id` — validated with
    its own `/^[a-f0-9]{24}$/` pattern (`isValidReportId()`), distinct from `isValidEntryId()`.
- **`WordEntry.tsx`**: no changes made. On inspection it was already a pure presentational
  component (props: `entry`, `sourceLang`, `targetLang`, `isFavorite`, `onToggleFavorite`, no
  internal `useDictionary`/data-fetching hook) — `EntryDetailDrawer.tsx` imports and renders it
  directly, with `isFavorite={false}` and a no-op `onToggleFavorite`. §15 Q3 resolved: no split
  needed, no fallback renderer needed.
- **Testing**: pure functions (`parseEntriesQuery`, `groupReportsByEntry`, `toEntrySummaries`,
  `sortEntrySummaries`, `validateBatchIds`, `isValidEntryId`, `isValidReportId`,
  `parseReportsQuery`) are unit-tested in `server/admin/entries.test.ts` (43 tests), consistent with
  the rest of the admin module's testing convention (§10). Mongo I/O functions (`listEntries`,
  `getEntry`, `deleteEntry`, `batchDeleteEntries`, `listReports`, `dismissReport`,
  `getReportsSummary`) were manually verified end-to-end against the live dev Mongo (disposable
  `zzz_`-prefixed test docs, cleaned up afterward) rather than given a mocked-Mongo unit test suite —
  no `mongodb-memory-server` dependency was introduced, per §10's stated preference.
- Full `npm run typecheck`, `npm run test` (vitest), and `npm run build` all pass; the only failing
  tests are the two pre-existing, unrelated `server/admin/crypto.test.ts` failures caused by
  `CONFIG_ENCRYPTION_KEY` being set in this environment (fails identically on a clean checkout).
