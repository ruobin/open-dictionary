import { LlmProviderError, type LlmCallKind, type LlmUsageMeta, type UsageSink } from './types'

type PromptMessage = { content: string }

/**
 * Per-call token accounting for usage metering
 * (docs/design-llm-usage-quotas.md §5.5). Every upstream call reports exactly
 * once, whether it succeeded, was retried, or failed after the vendor may
 * already have billed for it.
 */

/** Conservative token estimate for text a vendor reported no usage for: UTF-8 bytes / 3. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 3) : 0
}

function promptText(messages: readonly PromptMessage[]): string {
  return messages.map((m) => m.content).join('\n')
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

export interface CallTracker {
  /** The transport returned `content`, possibly with vendor-reported usage. */
  ok(content: string, meta: LlmUsageMeta | undefined): void
  /** The transport threw; `partialText` is whatever was streamed before it did. */
  fail(err: unknown, partialText?: string): void
}

/** Starts tracking one upstream call. Reports at most once; never throws. */
export function trackCall(
  sink: UsageSink | undefined,
  providerId: string,
  kind: LlmCallKind,
  messages: readonly PromptMessage[]
): CallTracker {
  let reported = false
  const emit = (promptTokens: number, completionTokens: number, estimated: boolean): void => {
    if (reported || !sink) return
    reported = true
    try {
      sink.add({ providerId, kind, promptTokens, completionTokens, estimated })
    } catch {
      // A broken sink must never affect the lookup.
    }
  }
  return {
    ok(content, meta) {
      const inTokens = meta?.promptTokens
      const outTokens = meta?.completionTokens
      const reportedIn = isCount(inTokens) ? inTokens : undefined
      const reportedOut = isCount(outTokens) ? outTokens : undefined
      emit(
        reportedIn ?? estimateTokens(promptText(messages)),
        reportedOut ?? estimateTokens(content),
        reportedIn === undefined || reportedOut === undefined
      )
    },
    fail(err, partialText = '') {
      // Vendors don't bill a request they answered with an HTTP error status,
      // and a missing configuration never reached them. Anything else (a
      // timeout, a dropped stream, unparseable output) may have been billed.
      if (err instanceof LlmProviderError && (err.code === 'api_error' || err.code === 'not_configured')) return
      emit(estimateTokens(promptText(messages)), estimateTokens(partialText), true)
    },
  }
}
