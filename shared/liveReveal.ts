/**
 * Pure maths behind the chat-style text reveal, shared by the web app
 * (src/components/LiveText.tsx) and the browser extension
 * (extension/src/shared/LiveText.tsx). Deliberately free of React so both
 * projects can import it without dragging in a second copy of React.
 */

/** Base reveal speed, characters per second. */
export const BASE_CPS = 90

/** Reveal speed grows with the backlog (rate = backlog / this), so the text
 *  keeps up with the model: a typical burst of a few dozen characters is gone
 *  within a couple of frames, and even a few hundred at once finish in under a
 *  second. */
export const CATCH_UP_SECONDS = 0.25

/** A lookup slower than this is revealed progressively even if no partial
 *  arrived (a non-streaming gateway still feels like a chat answer). */
export const SLOW_LOOKUP_MS = 250

/** How many characters should be visible `dtSeconds` after `shown` was last
 *  computed: a steady base speed that speeds up as the backlog grows. */
export function nextShown(shown: number, total: number, dtSeconds: number): number {
  const backlog = total - shown
  if (backlog <= 0) return total
  const rate = Math.max(BASE_CPS, backlog / CATCH_UP_SECONDS)
  return Math.min(total, shown + rate * dtSeconds)
}

/** Never cut between the halves of a surrogate pair (emoji). */
export function safeSlice(text: string, count: number): string {
  if (count >= text.length) return text
  const code = text.charCodeAt(count - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? count + 1 : count)
}

/** Whether a finished lookup should animate its text in: it streamed at least
 *  one partial, or it took long enough to feel slow. Instant cache hits do not. */
export function shouldAnimate(sawPartial: boolean, elapsedMs: number): boolean {
  return sawPartial || elapsedMs > SLOW_LOOKUP_MS
}
