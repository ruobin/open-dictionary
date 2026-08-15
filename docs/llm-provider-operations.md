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
