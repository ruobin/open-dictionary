import {
  LlmProviderError,
  type LlmTranslationContent,
  type LlmTranslateOptions,
  type LlmTranslationRequest,
  type LlmTranslationResult,
  type LlmUsageMeta,
} from './types'
import { buildCoreMessages, buildExtrasMessages, type ChatMessage } from './prompts'
import { parseContent, parseExtrasContent, type LlmExtras } from './parse'
import { extractPartialContent, extractPartialExtras } from './streamJson'

/**
 * Wire-agnostic translate flow shared by the Chat Completions and Responses
 * adapters. A lookup is two PARALLEL model calls instead of one big one:
 *
 *   core   — headword, translation, IPA, senses (+ typo). Streamed, so the UI
 *            can paint the translation within the first second or so.
 *   extras — common mistakes, collocations, word family. Small and slow-to-matter;
 *            runs concurrently, so it adds no wall-clock time in practice.
 *
 * Wall-clock cost is max(core, extras) rather than the sum, and the core call
 * generates far fewer tokens than the old single monolithic answer.
 *
 * When the caller wants partial answers, BOTH calls stream and their text is
 * re-parsed (see streamJson.ts) at most every PARTIAL_INTERVAL_MS, so the page
 * can show the answer growing token by token.
 */

/** Minimum gap between partial snapshots handed to the caller. */
export const PARTIAL_INTERVAL_MS = 60

/** Leading + trailing throttle: the first call runs now, bursts collapse into
 *  one trailing run, and `cancel()` guarantees nothing fires afterwards. `fn`
 *  returns whether it actually emitted; only emissions start a new interval, so
 *  a run that had nothing to show never delays the first real snapshot. */
function throttle(fn: () => boolean, ms: number): { call(): void; cancel(): void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const run = (): void => {
    timer = undefined
    if (cancelled) return
    if (fn()) last = Date.now()
  }
  return {
    call() {
      if (cancelled || timer) return
      const wait = last + ms - Date.now()
      if (wait <= 0) run()
      else timer = setTimeout(run, wait)
    },
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
export interface TransportCall {
  kind: 'core' | 'extras'
  label: string
  /** Receives the full text accumulated so far; only called by streaming transports. */
  onText?: (accumulated: string) => void
  signal?: AbortSignal
}

export interface TransportResult {
  content: string
  meta?: LlmUsageMeta
}

export type Transport = (messages: ChatMessage[], call: TransportCall) => Promise<TransportResult>

export interface TranslateFlowConfig {
  /** Retry the core call once when the model returns unparseable output. */
  retryBadResponse?: boolean
}

export function mergeUsage(a: LlmUsageMeta | undefined, b: LlmUsageMeta | undefined): LlmUsageMeta | undefined {
  if (!a && !b) return undefined
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
  }
}

export async function runTranslate(
  vendor: string,
  transport: Transport,
  req: LlmTranslationRequest,
  opts: LlmTranslateOptions = {},
  config: TranslateFlowConfig = {}
): Promise<LlmTranslationResult> {
  const label = `text="${req.text.slice(0, 60)}"`
  const sameLang = req.sourceLang.toLowerCase() === req.targetLang.toLowerCase()

  // ---- partial snapshots (display only; the resolved result is the authority) ----
  let coreText = ''
  let extrasText = ''
  let coreDone = false
  let lastSnapshot = ''
  const publish = throttle(() => {
    const core: LlmTranslationContent | null = extractPartialContent(coreText)
    // A typo answer is a correction nudge, not an entry — never paint it as one.
    if (!core || core.typo) return false
    // A bare headword isn't worth painting either (and is exactly what a typo
    // answer looks like until its `typo` key arrives), so wait for something
    // substantive: a translation or the first sense group.
    if (sameLang) delete core.translation
    if (!core.translation && !core.meaningGroups?.length) return false
    // The extras render BELOW the senses, so they are held back until the core
    // call has finished: showing them earlier would push the senses down the
    // page as they fill in. Content then only ever grows downward.
    const extras: LlmExtras | null = coreDone && extrasText ? extractPartialExtras(extrasText) : null
    const merged: LlmTranslationContent = { ...core, ...(extras ?? {}) }
    const snapshot = JSON.stringify(merged)
    if (snapshot === lastSnapshot) return false
    lastSnapshot = snapshot
    opts.onPartial?.(merged)
    return true
  }, PARTIAL_INTERVAL_MS)
  const onCoreText = opts.onPartial
    ? (accumulated: string): void => {
        coreText = accumulated
        publish.call()
      }
    : undefined
  const onExtrasText = opts.onPartial
    ? (accumulated: string): void => {
        extrasText = accumulated
        publish.call()
      }
    : undefined

  try {
    const extrasAbort = new AbortController()
    const extrasPromise = transport(buildExtrasMessages(req), {
      kind: 'extras',
      label: `extras ${label}`,
      onText: onExtrasText,
      signal: extrasAbort.signal,
    })
      .then((r) => ({ extras: parseExtrasContent(vendor, r.content), meta: r.meta }))
      .catch((err: unknown) => {
        if (!extrasAbort.signal.aborted) {
          console.warn(`[${vendor}] extras call failed (serving without extras, not caching): ${(err as Error)?.message ?? err}`)
        }
        return null
      })

    const attempts = config.retryBadResponse ? 2 : 1
    let content: ReturnType<typeof parseContent> | undefined
    let coreMeta: LlmUsageMeta | undefined
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await transport(buildCoreMessages(req), { kind: 'core', label: `core ${label}`, onText: onCoreText })
        coreText = res.content
        coreDone = true
        publish.call()
        content = parseContent(vendor, res.content)
        coreMeta = res.meta
        break
      } catch (err) {
        const retryable = err instanceof LlmProviderError && err.code === 'bad_response' && attempt + 1 < attempts
        if (!retryable) {
          extrasAbort.abort()
          throw err
        }
        coreText = ''
        coreDone = false
        lastSnapshot = ''
      }
    }
    if (!content) {
      extrasAbort.abort()
      throw new LlmProviderError('bad_response', `${vendor} response could not be parsed`)
    }

    // Defensive: the model occasionally includes a "translation" even in
    // same-language define mode despite the prompt saying to omit it. The UI
    // shows this field whenever it's truthy, so a same-language hallucination
    // would visibly (and wrongly) render a translation.
    if (sameLang) delete content.translation

    if (content.typo) {
      extrasAbort.abort()
      return coreMeta ? { content, meta: coreMeta } : { content }
    }

    const extras = await extrasPromise
    if (extras) Object.assign(content, extras.extras)
    const meta = mergeUsage(coreMeta, extras?.meta)
    return {
      content,
      ...(meta ? { meta } : {}),
      ...(extras ? {} : { incomplete: true }),
    }
  } finally {
    publish.cancel()
  }
}
