import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react'

/**
 * Chat-style text reveal for a lookup that was streamed in (or was slow enough
 * to feel like it). Entries served instantly from a cache render in full with
 * no animation at all.
 *
 *   animate    — this lookup should animate its text in
 *   streaming  — the answer is still being written (hides controls that act on
 *                half-written text, e.g. "more examples")
 */
export interface LiveState {
  animate: boolean
  streaming: boolean
}

const LiveContext = createContext<LiveState>({ animate: false, streaming: false })

export function LiveProvider({ value, children }: { value: LiveState; children: ReactNode }) {
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive(): LiveState {
  return useContext(LiveContext)
}

/** Base reveal speed, characters per second. */
const BASE_CPS = 90
/** Reveal speed grows with the backlog (rate = backlog / this), so the text
 *  keeps up with the model: a typical burst of a few dozen characters is gone
 *  within a couple of frames, and even a few hundred at once finish in under a
 *  second. */
const CATCH_UP_SECONDS = 0.25

/** How many characters should be visible `dtSeconds` after `shown` was last
 *  computed: a steady base speed that speeds up as the backlog grows. */
export function nextShown(shown: number, total: number, dtSeconds: number): number {
  const backlog = total - shown
  if (backlog <= 0) return total
  const rate = Math.max(BASE_CPS, backlog / CATCH_UP_SECONDS)
  return Math.min(total, shown + rate * dtSeconds)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/** Never cut between the halves of a surrogate pair (emoji). */
export function safeSlice(text: string, count: number): string {
  if (count >= text.length) return text
  const code = text.charCodeAt(count - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? count + 1 : count)
}

/**
 * Renders `text`, revealing newly arrived characters over a few frames instead
 * of all at once. An instance that mounted while the lookup was animating keeps
 * animating until it has caught up, even after the answer is complete, so the
 * ending never snaps.
 */
export function LiveText({ text }: { text: string }) {
  const { animate } = useLive()
  const animated = useRef(animate && !prefersReducedMotion())
  const shown = useRef(animated.current ? 0 : text.length)
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!animated.current) {
      shown.current = text.length
      return
    }
    if (shown.current > text.length) shown.current = text.length // text was replaced by a shorter one
    if (shown.current >= text.length) return

    let frame = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = Math.min(now - last, 250) / 1000
      last = now
      shown.current = nextShown(shown.current, text.length, dt)
      rerender()
      if (shown.current < text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text])

  return <>{safeSlice(text, Math.floor(shown.current))}</>
}

/** Blinking caret shown while the model is still writing. */
export function StreamCaret() {
  const { streaming } = useLive()
  return streaming ? <span className="stream-caret" aria-hidden="true" /> : null
}
