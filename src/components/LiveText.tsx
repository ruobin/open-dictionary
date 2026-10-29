import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react'
import { nextShown, safeSlice } from '../../shared/liveReveal'

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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
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
