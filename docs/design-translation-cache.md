# Design Doc: Server-Side MongoDB Cache for LLM-Backed Translations

**Status:** Draft (v2)
**Date:** 2026-06-30
**Scope:** A read-through cache that persists translations/explanations of words/expressions fetched from external providers so identical future requests are served from the database instead of re-calling the provider.

**Provider model (v2 change):**
- **Primary tier = LLM**, and the LLM layer is **vendor-agnostic** (DeepSeek / OpenRouter / GLM / … behind one interface; swap by config, no code change).
- **Fallback tier = Merriam-Webster Collegiate API**, invoked **only when the LLM fails**. English-only; pronunciation audio URLs from MW are also merged into LLM-produced entries (best-effort, when sourceLang=en) and cached alongside. **Audio playback is therefore only available for English source words** — non-English lookups have no audio button in the UI.

---

## 1. Context & Current State

| Premise | Reality today | Source |
|---|---|---|
| "Translation API / LLM" | Not present. The only external content source is the **Merriam-Webster Collegiate API** (`dictionaryapi.com`), called **server-side** by `server/providers/dictionary.ts`. The Express server now sees dictionary traffic (alongside `/health`, `/api/user-data`, `/api/favorites`). | `server/providers/dictionary.ts` |
| "Cache into db" | The only cache is **per-browser `localStorage`**: key `dict:v1:{word}`, value `{ data, fetchedAt }`, 30-day TTL. No shared/cross-user cache; no server-side persistence of any kind. | `src/api/dictionary.ts:1-29` |
| DB driver | None installed. | `package.json` |

**Implication:** This design is **net-new**. It introduces (a) a server-side lookup/translation route, (b) the first DB dependency, (c) a vendor-agnostic LLM provider abstraction as the **primary** source, and (d) the existing dictionary API demoted to a **fallback** that runs only on LLM failure.

> Note on the codebase: as part of this work the whole project is being migrated to TypeScript; module names below refer to `.ts`/`.tsx` files (e.g. `src/api/dictionary.ts`).

---

## 2. Goals & Non-Goals

**Goals**
1. Persist every successful response to MongoDB, keyed by its request dimensions + the provider that produced it.
2. Serve identical future requests directly from the DB (read-through cache), TTL = **1 year**.
3. **LLM is the primary provider**, behind a **vendor-agnostic** interface — switching OpenAI↔Anthropic↔Gemini is a config change, not a code change.
4. **Dictionary API is a fallback** invoked only when the LLM tier errors (network/4xx/5xx/timeout).
5. Share the cache across **all users** (the core benefit over per-browser `localStorage`).
6. Keep provider API keys off the client by moving lookups server-side.
7. Follow existing project conventions (ESM/TS, `dotenv` + `process.env`, the `{data, fetchedAt}` + TTL envelope already used in `dictionary.ts`).

**Non-Goals**
- Replacing the browser `localStorage` L1 cache (it stays; see §8).
- Building the LLM prompt/quality layer (the cache is correct regardless of prompt; providers are pluggable).
- Per-user caches (cache is global and anonymous).
- Real-time upstream invalidation (TTL + model-bump is sufficient; see §13).

---

## 3. Why MongoDB

The cacheable payload is **deeply nested, evolving JSON** (dictionary entries nest `meanings[].definitions[].example`; LLM outputs are free-form — examples, etymology, usage notes that don't fit a fixed table).

- **Document model** fits nested, schema-flexible payloads without a migration per provider field.
- **TTL indexes** (`expireAfterSeconds`) give automatic background expiry mapped directly onto a TTL constant.
- **Mature Node driver**, first-class indexing, good fit with the Express/ESM/TS stack.
- Ad-hoc analysis (hit-rate by provider/lang) is cheap via the compound index.

Rejected: Redis (weaker for nested/evolving documents), DynamoDB (AWS lock-in not justified), browser-only IndexedDB (no cross-user sharing — the primary goal).

---

## 4. Architecture

### 4.1 Component diagram

```
Browser (React SPA)
  │  GET /api/translate/:text?from=&to=
  ▼
Express server  (server/index.ts + server/translate.ts + server/cache/ + server/providers/)
  │
  └── TranslateService.translate(req)          # read-through orchestrator
        │
        ├── TIER 1 — LLM (primary, vendor-agnostic)
        │     ├── 1a. cache.get(llmKey)  ──────────────────────►  MongoDB
        │     │        hit? → return result.content
        │     ├── 1b. miss → llmRegistry.active.translate(req)   (OpenAI | Anthropic | Gemini, by config)
        │     ├── 1c. success → cache.set(llmKey, result) ────►  MongoDB ; return
        │     └── 1d. LLM error → fall through to Tier 2
        │
        ├── TIER 2 — Merriam-Webster Collegiate API (English-only, fallback only on LLM failure)
        │     ├── 2a. cache.get(dictKey)
        │     │        hit? → return result.content
        │     ├── 2b. miss → dictionaryProvider.translate(req)
        │     └── 2c. success → cache.set(dictKey, result) ───►  MongoDB ; return
        │
        └── both tiers failed → optional STALE serve, else error
```

### 4.2 New modules

| Module | Responsibility |
|---|---|
| `server/translate.ts` (route) | Express router: `GET /api/translate/:text`. Validates input, rate-limits, calls `TranslateService`. |
| `server/cache/TranslateService.ts` | Read-through orchestrator: tiered LLM→dictionary lookup, owns TTL/stale/error-fallback policy. |
| `server/cache/mongo.ts` | Connection management, driver wiring, graceful-fail toggle. |
| `server/cache/cacheKey.ts` | Pure fn: request + provider → deterministic `_id` + Mongo filter. |
| `server/providers/llm/types.ts` | **Vendor-agnostic** `LlmProvider` interface + `LlmTranslationRequest/Result`. |
| `server/providers/llm/index.ts` | LLM registry: picks the active vendor from config (`LLM_VENDOR`). |
| `server/providers/llm/openai.ts` / `anthropic.ts` / `gemini.ts` | Concrete vendor adapters behind the same `LlmProvider` interface. Add a vendor = add one file + one registry entry. |
| `server/providers/dictionary.ts` | Fallback provider: wraps the current browser fetch (`dictionary.ts:43`) moved server-side. |

### 4.3 Vendor-agnostic LLM interface

```ts
// server/providers/llm/types.ts
export interface LlmProvider {
  /** Stable id included in the cache key, e.g. "openai:gpt-4o", "anthropic:claude-3.5". */
  readonly id: string
  translate(req: LlmTranslationRequest): Promise<LlmTranslationResult>
}
```

The **code** is vendor-agnostic (one interface, pluggable adapters, config-selected). The **cache key** is vendor-specific on purpose (§5) so that bumping the vendor/model refreshes answers instead of serving a competitor's year-old cached output. This distinction is deliberate and documented.

### 4.4 Cached result envelope (provider-agnostic)

```ts
interface TranslationResult {
  kind: 'llm' | 'definition'          // which tier produced it
  content: unknown                     // raw provider payload, stored untransformed
}
```
Mirrors the current cache which stores the dictionary JSON **untransformed** (`dictionary.ts:61` writes raw `data`) so the UI reads it directly.

---

## 5. Cache Key Design

**Decision: provider-aware key, with the LLM tier keyed by `vendor:model`.**

```
key = { text, sourceLang, targetLang, provider }
```
- LLM tier: `provider = "llm:<vendor>:<model>"` (e.g. `"llm:openai:gpt-4o"`).
- Dictionary tier: `provider = "dict:free-dictionary-api:v2"`.

**Why vendor/model in the key (not a blanket `"llm"`):** the cache TTL is **1 year**. If all LLM vendors shared one key, switching from OpenAI to Anthropic to improve quality would silently serve OpenAI's year-old answers until expiry — defeating the purpose. Keying by `vendor:model` means a model bump produces fresh cache misses and fresh answers, which is the desired behavior. The *cost* (cold cache after a vendor switch) is acceptable and one-time.

**Tiered lookup semantics** (this is the core of "dictionary only when LLM fails"):

```
translate(req):
  # TIER 1 — LLM slot
  llmKey = cacheKey(req, llmProvider.id)        # "llm:openai:gpt-4o"
  hit = cache.get(llmKey);  if hit: return hit   # canonical LLM answer served on hit

  try:
    result = llmProvider.translate(req)          # MISS → call LLM (primary)
    cache.set(llmKey, result); return result
  catch (e):
    metrics.llmError(e);                          # LLM failed → fall through

  # TIER 2 — dictionary slot (read ONLY after LLM failure)
  dictKey = cacheKey(req, "dict:free-dictionary-api:v2")
  hit = cache.get(dictKey);  if hit: return hit   # serve cached fallback (e.g. prolonged outage)

  result = dictionaryProvider.translate(req)      # call dictionary API
  cache.set(dictKey, result); return result
```

Consequences:
- **LLM healthy:** every word is cached under the LLM slot; the dictionary API is **never called**. ✓ matches "dictionary as fallback only when LLM doesn't work."
- **LLM outage:** the dictionary slot fills once per word; subsequent requests during the outage are served from that slot (no repeated dictionary calls).
- **Self-healing after recovery:** if word *W* only has a dictionary-slot entry (from a prior outage), the next request still checks the LLM slot first (miss) → calls the now-healthy LLM → fills the LLM slot → returns the canonical LLM answer. The dictionary-slot entry then sits idle until TTL.

**Normalization** (deterministic — required for hits): `text` → trim + lowercase + NFC + collapse-whitespace + length cap (§10); `sourceLang`/`targetLang` → lowercased BCP-47.

---

## 6. Data Model

**Collection:** `translations`

```ts
{
  _id: "<sha256(normalizedKey) hex>",          // deterministic; avoids Mongo `$`/`.` key pitfalls
  key: {
    text:        "serendipity",                 // normalized
    sourceLang:  "en",
    targetLang:  "en",
    provider:    "llm:openai:gpt-4o",           // | "dict:free-dictionary-api:v2"
  },
  result: { kind: "llm", content: { /* raw payload */ } },
  schemaVersion: 1,                             // mirrors `dict:v1:` prefix for future migrations
  fetchedAt: ISODate("2026-06-30T..."),         // TTL index target
  source: { provider: "openai", model: "gpt-4o", apiVersion: "v1" },  // provenance
  meta:   { charCount: 11, byteSize: 1843 },
}
```

**Indexes**
- **TTL index:** `db.translations.createIndex({ fetchedAt: 1 }, { expireAfterSeconds: CACHE_TTL_SECONDS })`. Default **`CACHE_TTL_SECONDS = 365 * 24 * 3600` (1 year)** — see §7 rationale.
- **Compound unique query index:** `db.translations.createIndex({ "key.text": 1, "key.sourceLang": 1, "key.targetLang": 1, "key.provider": 1 }, { unique: true })`.

`_id` is a hash (not the raw `text`) so adversarial `:text` containing `.`/leading-`$` can't produce invalid Mongo keys; the original `key.text` is retained for querying/debugging.

---

## 7. Cache Lifecycle & TTL Rationale

**Read-through, write-on-miss, tiered LLM→dictionary** (pseudocode in §5).

**Policy**
- **Only successful results are cached** (never errors/transient failures) — mirrors the current cache that writes only after a successful `res.json()` (`dictionary.ts:61`).
- **TTL via Mongo TTL index** (lazy background deletion ~60s granularity); the app only reads/writes.
- **Stale-while-revalidate:** default OFF. When *both* tiers fail, a flag `CACHE_SERVE_STALE_ON_ERROR` may serve a just-expired doc from either slot. Off initially for predictable semantics.
- **Stampede:** out of scope for v1 (duplicate provider calls on cold popular keys). Add an in-flight `Map<key, Promise>` dedup later if needed.
- **LLM non-determinism:** an LLM is non-deterministic across calls; caching **freezes** the first response for the TTL. With a **1-year TTL** this is a strong freeze — acceptable for a reference dictionary (consistency is a feature), and *controllable* because bumping `LLM_VENDOR`/model refreshes the cache (§5).

**Why a 1-year TTL**
- Dictionary/translation content is essentially stable; longer TTL = fewer provider calls = lower cost and latency.
- 1 year aligns with "cache once, serve forever-ish" for a low-churn reference dataset.
- The downside (stale answers if the world changes) is mitigated by (a) vendor/model keying — bumping the model invalidates the whole LLM tier naturally, and (b) a manual invalidation escape hatch (`db.translations.deleteMany({ "key.provider": /^llm:/ })`) documented for operators.

---

## 8. API Design

### New route
```
GET /api/translate/:text?from=<lang>&to=<lang>
```
- `:text` — URL-encoded, length-capped (§10).
- `from`/`to` — optional, default `en`.

The LLM-vs-dictionary decision is **server-side and transparent**: the client gets whichever tier succeeded, with no `provider=` query param needed in the normal path. (A privileged `provider=` override may be added later for ops/warm-up.)

**Response (success):** the cached `result.content` (raw provider payload), shaped as the UI expects today. **Errors** reuse the existing server vocabulary (`server/index.ts` error shape) so the frontend hook types stay unchanged:
```json
{ "error": "not_found" | "timeout" | "network" | "api_error" | "internal" }
```

### Frontend change (minimal)
`lookupWord` in `src/api/dictionary.ts:43` swaps its `fetch(...dictionaryapi.dev...)` target for `/api/translate/:word`. The surrounding `localStorage` L1 cache, timeout, and error mapping stay — it becomes a **two-tier** read: browser L1 (`localStorage`) → server L2 (Mongo) → LLM → dictionary-fallback. The L1 is explicitly **kept** (Non-Goal) to avoid a network round-trip on repeat device visits.

---

## 9. Configuration

Follows the existing `server/.env` + `process.env` pattern and validation idiom (`server/index.ts`). Add to `server/.env.example`:

```
# --- Cache (MongoDB) ---
MONGODB_URI=                                # required when CACHE_ENABLED=true
MONGODB_DB=open_dictionary
CACHE_ENABLED=true                          # false = bypass DB, call providers directly
CACHE_TTL_SECONDS=31536000                  # 1 year
CACHE_SERVE_STALE_ON_ERROR=false

# --- LLM (primary, vendor-agnostic) ---
LLM_VENDOR=openai                           # openai | anthropic | gemini   (swap = no code change)
LLM_MODEL=gpt-4o                            # part of cache key; bump to refresh answers
LLM_REQUEST_TIMEOUT_MS=15000
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# --- Dictionary fallback (Merriam-Webster Collegiate, English-only) ---
MERRIAM_WEBSTER_API_KEY=your-key-from-dictionaryapi.com
# Override the API base URL (optional; default https://www.dictionaryapi.com/api/v3)
# DICTIONARY_API_BASE=https://www.dictionaryapi.com/api/v3
```

Startup validation (extends `server/index.ts` hard-fail idiom): if `CACHE_ENABLED=true && !MONGODB_URI` → exit 1. If `!LLM_VENDOR || !<vendor>_API_KEY` → exit 1. With `CACHE_ENABLED=false` the server still boots (degraded pass-through).

---

## 10. Security & Input Handling

- **Provider keys move server-side** (LLM + dictionary), never `VITE_`-prefixed. Today's browser-direct model would otherwise expose any key.
- **Input validation on `:text`:** trim + lowercase + NFC + collapse whitespace, reject if empty or length > 256. Reuses the spirit of `sanitizeWordList` (`server/index.ts`).
- **Rate limiting:** a dedicated limiter for `/api/translate` (20 req/min by default, configurable via `TRANSLATE_RATE_LIMIT_RPM`) alongside the existing global 60/min (`server/index.ts`). Translate stays **unauthenticated** (public data) but **rate-limited**.
- **No injection surface:** Mongo writes use field values (never operator-shaped user keys); the hashed `_id` (§6) neutralizes `.`/`$` in `text`. Do not log `result.content` at info level in prod.

---

## 11. Failure Modes

| Failure | Behavior |
|---|---|
| LLM error (any) | Fall through to dictionary tier (§5). |
| Dictionary also fails | If `CACHE_SERVE_STALE_ON_ERROR` and an expired doc exists in either slot, serve it; else return error using the existing vocabulary (§8). |
| MongoDB unreachable / query error | `TranslateService` catches, logs + metric, **bypasses cache** and still calls the LLM tier (then dictionary). Cache is an optimization, never the source of truth. `CACHE_ENABLED=false` makes this permanent. |
| Provider success but DB write fails | Result still returned to client; next request just misses and re-fetches. Logged. |
| Cold-key stampede | Tolerated in v1. |
| TTL index lag | Mongo TTL deletes are approximate (~60s); briefly-serving-expired is benign. |

---

## 12. Observability

Structured logs + counters (no metrics infra today):
- **Counters:** `cache.hit{tier}`, `cache.miss{tier}`, `llm.error{vendor}`, `llm.latency{vendor}`, `dict.fallback_used`, `dict.error`, `cache.read.latency`.
- **Log fields:** `tier`, `provider`, `sourceLang`, `targetLang`, `textLength` (not `text`), `cacheStatus`, `latencyMs`, `error`.
- **Operational:** `db.translations.countDocuments({})`, per-tier counts via the compound index, fallback rate = signal for LLM reliability.

---

## 13. Open Questions

1. **1-year LLM freeze sign-off** — confirm we accept the same LLM answer for a word for up to a year (desirable for consistency; mitigated by model-bump). Needs conscious owner sign-off.
2. **Invalidation escape hatch** — beyond model-bump, do we want an admin endpoint to purge by prefix/lang? Likely yes for ops.
3. **Dictionary fallback caching scope** — caching fallback answers (under their own slot) is correct for outage resilience; accept the minor storage overhead, or evict dictionary-slot entries when the LLM slot for the same word later fills? (Recommend: leave them; cheap.)
4. **Stale-while-revalidate default** — keep OFF for v1; revisit with provider SLOs.
5. **`provider=` override** — expose for ops warm-up/forced-tier? Not in v1.
6. **Testing** — vitest is set up (5 files, 28 tests: `languageName`, `normalizeText`, `adaptLlm`, `normalizeFavorite`, `ProviderError`, `LlmProviderError`). Integration tests with a real DB / `mongodb-memory-server` remain a follow‑up.

---

## 14. Migration / Rollout Plan

Each phase is independently shippable and reversible.

1. **Infra.** Add `mongodb` (+ dev `mongodb-memory-server`) deps. `server/cache/mongo.ts` + config (§9) + startup validation. Ship behind `CACHE_ENABLED=false`. No behavior change.
2. **LLM abstraction + first vendor.** `server/providers/llm/{types,index,openai}.ts`. Wire one vendor behind `LLM_VENDOR`. No cache use yet.
3. **Dictionary fallback.** `server/providers/dictionary.ts` wrapping the existing fetch, now server-side.
4. **Route + tiered cache, flagged off.** `server/translate.ts` + `TranslateService` + `cacheKey.ts`. `/api/translate/:text` end-to-end: verify LLM-primary, dictionary-fallback-on-error, and cache hit/miss with `CACHE_ENABLED` on/off.
5. **Frontend cutover.** Point `lookupWord` (`src/api/dictionary.ts:43`) at the new route. Keep `localStorage` L1. Roll back by reverting the base URL.
6. **More LLM vendors** as needed — one adapter file each, no cache/route changes.

At every phase the app stays fully functional; the cache degrades to pass-through if MongoDB is absent or `CACHE_ENABLED=false`, and the dictionary fallback keeps the app usable if the LLM is absent/unconfigured.

---

## 15. Alternatives Considered

- **Provider-agnostic LLM cache key (`"llm"`, no vendor):** rejected — with a 1-year TTL it would freeze whichever vendor answered first and poison quality improvements; vendor/model keying (§5) chosen instead. The *code* stays vendor-agnostic.
- **Dictionary as primary (status quo):** rejected per the v2 requirement — LLM is primary, dictionary is fallback only.
- **Redis / SQL:** rejected (§3).
- **Browser-only NoSQL (IndexedDB):** rejected — no cross-user sharing; provider keys would stay client-side.
- **Two-tier browser L1 + server L2:** adopted minimally — existing `localStorage` L1 retained, Mongo is the new shared L2.
- **Shorter TTL (30 days, matching current `localStorage`):** rejected for the server L2 — 1 year better matches stable reference content and minimizes provider cost; model-bump provides intentional refresh.

---

## Appendix: Implementation notes (2026-06-30)

The code as landed differs from the above design in a few places:

| Design doc | Implementation | Rationale |
|---|---|---|
| Dict cache key = `(text, src, tgt, provider)` — per-provider slots (§5) | Key = `(word, src, tgt)` only; provider stored as metadata, not in the key | Simpler single-slot model; a later provider switch won't auto-refresh the cache, but the tier that created it is logged (`source: 'llm'\|\'dict'`). |
| LLM providers listed in §4.2 | DeepSeek (default), OpenRouter, and Z.AI GLM all implemented; they share `openaiCompat.ts` | All three are OpenAI‑compatible; adding a vendor is ~30 lines. |
| Anonymous favorites stored in `localStorage` (§1) | Anonymous favoriting disabled — prompts login via Auth0; a `sessionStorage` pending-favorite is applied post-login | Moves anon favorites off the client entirely; the pending-favorite flow gives a smooth login→favorite UX. |
| Favorites in Auth0 `user_metadata` (§1) | Favorites moved to MongoDB, keyed by `(userKey, word, src, tgt)` | MongoDB is the single source for favorites now (the design doc didn't address favorites storage directly). |
| Favorites JWT-enforced per docs /user-data pattern | Soft `X-User-Key` header (Auth0 `sub` for authed users) — no JWT verification on favorites endpoints | MVP simplification; auth hardening is a documented follow‑up. |
| History stored alongside favorites in Auth0/localStorage (§1) | History left in Auth0/localStorage, now carries source/target language (FavoriteKey shape: `{word, sourceLang, targetLang}`). Legacy bare strings are coerced (en→en default). | Only favorites were requested for MongoDB migration; history entries were upgraded to the same shape for consistency. |
| Per-provider tiered cache with stale-while-revalidate (§7) | Single-slot cache with read-through; no stale-while-revalidate (yet) | Kept the implementation tractable; add when provider SLOs are known. |
| Cache TTL = 1 year (§6) | Same — 1-year TTL index | Verified in `server/db.ts` ensureIndexes. |
| Rate limits (§10) | Configurable via env: `TRANSLATE_RATE_LIMIT_RPM` (default 20), `FAVORITES_RATE_LIMIT_RPM` (120), `USERDATA_RATE_LIMIT_RPM` (60). | Makes per‑deployment tuning trivial. |
| DeepSeek added as default LLM provider | — | `LLM_VENDOR` defaults to `deepseek` (model `deepseek-v4-flash`, base `https://api.deepseek.com`); OpenRouter and GLM are alternatives. Three OpenAI‑compatible providers share `openaiCompat.ts`. |
| Free Dictionary API replaced by Merriam-Webster Collegiate (§4.2, §6) | `server/providers/dictionary.ts` now calls `https://www.dictionaryapi.com/api/v3/references/collegiate/json/{word}?key=…` (English-only). Definitions are parsed from MW's `shortdef` (mapped to a single meaning with `partOfSpeech`). Audio URLs are constructed from MW's `sound.audio` token using `https://media.merriam-webster.com/audio/prons/en/us/mp3/{subdir}/{audio}.mp3` where `{subdir}` follows MW's rule: `bix`/`gg`/`number`/first-letter of the filename. | The 30-day browser localStorage L1 still uses the Free Dictionary cache key prefix `dict:v1:` (stale naming, harmless). |

