# LLM Provider Operations

This guide records the provider behavior and troubleshooting decisions used in
production. It intentionally excludes API keys, provider IDs, and other
credentials.

## Configuration Sources

- Environment variables establish the boot-time LLM baseline.
- An active provider stored in `llm_settings` overrides that baseline.
- Each stored provider has one or more model entries. A model can override its
  timeout and may include provider-specific request options.
- The active DB provider is built from its stored model configuration. It does
  not inherit `LLM_REQUEST_TIMEOUT_MS` from the environment.

## Lookup Latency Design

An uncached lookup is two **parallel** model calls, not one large one:

- **core** — headword, translation, IPA, senses with graded examples, and the
  typo check. The prompt asks for keys in display order, and this call is
  streamed.
- **extras** — common mistakes, collocations, word family. It runs concurrently,
  so it adds almost no wall-clock time. If it fails, the entry is still served
  but flagged `incomplete` and is **not cached** (otherwise the missing sections
  would be frozen in for the cache TTL). A typo answer cancels the extras call.

Other behaviors that matter when debugging a slow or odd lookup:

- **Reasoning is switched off by default.** Hidden reasoning was the biggest
  single cost (DeepSeek defaults to thinking at `high` effort). Each vendor sends
  its documented "off" switch: DeepSeek/GLM `thinking: {type: "disabled"}`,
  OpenRouter `reasoning: {effort: "none"}`, Responses `reasoning: {effort:
  "none"}`. If a model rejects it with HTTP 400/422, the request steps down a
  ladder (`none` → `minimal`/`low` → plain request) and the working rung is
  remembered per provider instance, so a rejection costs one round trip once, not
  on every lookup. A 400 that is unrelated to the switch does not downgrade
  anything permanently (the rung is only remembered after a lower one succeeds).
  GLM-5.3 models force thinking on, so they will land on the plain rung.
- **`max_tokens` is a runaway guard only** (core 4096, extras 2048) and is sent
  only for DeepSeek, GLM and OpenRouter — generic `openai-compat` gateways are
  left alone because newer OpenAI models reject `max_tokens`. Reasoning tokens
  count against it on several vendors, so keep it generous.
- **Prompts have a constant system prefix.** Language names, mode and the term
  go in the user message so providers' automatic prefix caching applies. Never
  interpolate request data into the system strings in `prompts.ts`.
- **Pronunciation audio** (Merriam-Webster, English source only) is fetched in
  parallel with the LLM. If it is not back 1.5 s after the answer, the answer is
  sent without it and the audio is merged into the cached entry when it arrives.
- **Cache writes are off the response path.** The in-flight dedup entry stays
  registered until they finish, so a request arriving in that window joins
  rather than paying for a second LLM call.
- **Fusion no longer blocks on the merge.** The first successful answer from
  either model is returned and cached immediately; the fused entry (primary's
  `fuse()` call, or the deterministic code merge if that fails) is produced in
  the background and overwrites the cache entry for later lookups. The one user
  who triggers an uncached lookup therefore sees a single-model answer.

### Streaming endpoint

`GET /api/translate-stream/:text?from=&to=` is the same lookup as
`/api/translate/:text` delivered as Server-Sent Events: zero or more
`partial` events (each a more complete `DictionaryEntry[]`), then `done` (final,
identical to the `/translate` body), or `error` (`not_found` / `internal`). The
web app uses it; the browser extension still uses `/translate`. It shares the
5 req/min per-IP limiter and the in-flight dedup. Invalid input gets an ordinary
JSON 4xx before any stream starts. The response sets `X-Accel-Buffering: no` so
the host nginx does not buffer it — no nginx change is needed. If the stream
transport fails in any way, the client falls back to `/translate`.

**Token-level partials.** When a listener is attached (the web path), BOTH model
calls stream upstream. `streamJson.ts` repairs the half-written JSON on every
snapshot — it closes the open string and brackets and drops a dangling key,
comma or half-typed literal — so a `partial` can contain a definition that is
still being written. Snapshots are throttled to one per 60 ms
(`PARTIAL_INTERVAL_MS` in `translateFlow.ts`); only a snapshot that was actually
sent starts a new interval. They are display hints: the resolved result is
always the authority, and a typo answer never produces a partial.

**Extras are held back until the core call finishes.** Common mistakes,
collocations and word family render *below* the senses, so showing them earlier
would push the senses down the page while they fill in. Content therefore only
ever grows downward; the extras (usually already finished by then) appear right
after the senses and are animated in by the page.

Upstream, a gateway that rejects `stream: true` (HTTP 400/422) is retried
without it and streaming is disabled for that provider instance; a gateway that
ignores `stream` and returns plain JSON also works (the page then just reveals
the finished text with the same animation). Admin tests, benchmarks and the eval
harness pass no listener and use plain requests.

### Web page animation

`src/components/LiveText.tsx`. Every streamed string (translation, definitions,
examples, mistakes, chips) is a `<LiveText>`. It reveals newly arrived characters
over a few frames — about 90 chars/s, speeding up in proportion to the backlog
so a burst never leaves the text trailing the model — and a blinking caret shows
under the entry while the lookup is in flight. Rules:

- **Instant results do not animate.** `useDictionary` sets `animate` only when at
  least one partial arrived or the lookup took longer than 250 ms; a cache hit
  renders in full.
- **One `WordEntry` instance per lookup** (streaming → done), so the animation
  carries on through completion instead of restarting. Pieces that mounted while
  animating finish revealing even after the answer is complete.
- "More examples" is hidden while streaming (it would act on a half-written
  definition).
- `prefers-reduced-motion` disables the reveal and the caret blink.

### Per-model request options

Besides OpenRouter `provider` routing, a model entry's `options` may carry
(validated in `server/admin/providersRepo.ts`; no UI editor yet — set via the
admin API):

```json
{ "requestBody": { "thinking": { "type": "enabled" }, "max_tokens": 3000 },
  "stream": false }
```

- `requestBody` — extra top-level request fields sent on every call. It may not
  set `model`, `messages`, `input`, `stream`, `tools`, `tool_choice`,
  `response_format`, `text` or `n`, and is limited to 2000 characters of JSON.
  Setting any reasoning field (`thinking`, `reasoning`, `reasoning_effort`,
  `enable_thinking`) turns the built-in reasoning-off defaults off for that
  model.
- `stream: false` — never stream this model upstream.

Measured on the live DeepSeek + OpenRouter fusion config (2026-10-28), uncached,
`en→zh`: previously 13.8 s / 39.3 s / 19.4 s for "serendipity" / "run" / "bank"
(the 39 s case included a fuse call hitting its 30 s timeout); now 1.8 s / 2.0 s
/ 2.1 s with the translation visible after about 0.5 s.

## Timeouts And Fallbacks

- The shared default LLM timeout is 30 seconds (`DEFAULT_TIMEOUT_MS`). It
  applies to DeepSeek, GLM, OpenRouter, generic Chat Completions, and the
  OpenAI Responses adapter when a model has no explicit `timeoutMs`.
- The connection-test, pre-switch verification, and playground calls are also
  capped at 30 seconds. A higher per-model timeout does not raise that cap.
- A timeout can occur after HTTP headers arrive while the response body is
  still streaming. The adapter deliberately keeps its abort timer active until
  the complete response body has been read.
- Translation requests that encounter LLM errors fall back to the dictionary
  provider. The server records the LLM error and logs the fallback; a healthy
  API container can therefore still show provider timeouts.

## Admin Switching

- Active-provider changes verify the selected primary before saving by default.
- When fusion is configured, a primary-only switch preserves and verifies the
  existing secondary as well. A bad secondary can block a primary switch.
- Set Secondary to `none` and switch while retaining a known-good primary to
  clear fusion first. Then perform the primary switch separately.
- The admin UI displays the verification target and error code for
  `verify_failed`, for example `primary (timeout)` or `secondary (api_error)`.

## NewAPI And GPT-5.6 Terra

- `gpt-5.6-terra` on NewAPI rejects `/v1/chat/completions`; the gateway returns
  HTTP 400 because this model supports the OpenAI Responses protocol instead.
- Configure the provider with vendor `openai-responses` and a base URL ending
  in `/v1`. The adapter sends requests to `/v1/responses`.
- The adapter reads `output_text` or `output[].content[]` entries of type
  `output_text`, and maps `usage.input_tokens` / `usage.output_tokens` to the
  app's token metadata.
- NewAPI can return malformed JSON even after a successful Responses request.
  The adapter requests `text.format` as a JSON Schema and retries one
  transient `bad_response` before reporting failure.
- A `bad_response` with two successful gateway calls indicates malformed or
  missing model output, not an API-key, networking, or endpoint-protocol error.

## OpenRouter Routing

Model entries may carry OpenRouter routing preferences in this shape:

```json
{
  "id": "openai/gpt-5.6-luna",
  "label": "OpenAI: GPT-5.6 Luna",
  "isDefault": false,
  "options": {
    "provider": {
      "order": ["openai", "azure"],
      "allow_fallbacks": true
    }
  }
}
```

For OpenRouter models, this is forwarded as the request-body `provider` object.
The active production configuration includes `openai/gpt-5.6-luna` with the
OpenAI-first, Azure-fallback policy above.

Catalog fields such as attachment support, reasoning/tool-call capability,
cost, and context/output limits describe a model but are not request-routing
fields used by this dictionary application.

## Troubleshooting Checklist

1. Use the provider card's **Test connection** action and note its error code.
2. Inspect `lastTest` and the API logs. `timeout` identifies a slow or stalled
   upstream response; `api_error` contains an upstream HTTP failure; and
   `bad_response` means the provider returned unusable output.
3. For an upstream gateway, inspect its request log at the same timestamp and
   compare the path, HTTP status, and model. A 200 gateway response can still
   result in `bad_response` if the generated text is invalid JSON.
4. For a switch blocked by verification, identify whether the primary or
   secondary target failed before changing configuration.
5. Use the Playground or benchmark only after the connection test succeeds;
   both issue real, billable provider calls.
