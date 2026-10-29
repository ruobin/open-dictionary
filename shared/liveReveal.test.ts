import { describe, expect, it } from 'vitest'
import { nextShown, safeSlice, shouldAnimate } from './liveReveal'

describe('nextShown', () => {
  it('advances at a steady base speed for a small backlog', () => {
    const next = nextShown(0, 20, 0.1) // backlog is small, so the base 90 chars/s applies
    expect(next).toBeCloseTo(9, 5)
  })

  it('speeds up so a sizeable backlog drains in under a second', () => {
    for (const size of [40, 200, 400]) {
      let shown = 0
      let seconds = 0
      while (shown < size && seconds < 5) {
        shown = nextShown(shown, size, 1 / 60)
        seconds += 1 / 60
      }
      expect(shown).toBe(size)
      expect(seconds).toBeLessThan(1)
    }
  })

  it('never overshoots and is a no-op once caught up', () => {
    expect(nextShown(9.9, 10, 5)).toBe(10)
    expect(nextShown(10, 10, 1)).toBe(10)
    expect(nextShown(12, 10, 1)).toBe(10)
  })

  it('is monotonic as the target grows', () => {
    let shown = 0
    let total = 0
    for (let i = 0; i < 100; i += 1) {
      total += 3
      const next = nextShown(shown, total, 1 / 60)
      expect(next).toBeGreaterThanOrEqual(shown)
      expect(next).toBeLessThanOrEqual(total)
      shown = next
    }
  })
})

describe('safeSlice', () => {
  it('does not split a surrogate pair', () => {
    const text = 'a😀b'
    expect(safeSlice(text, 2)).toBe('a😀')
    expect(safeSlice(text, 1)).toBe('a')
    expect(safeSlice(text, 99)).toBe(text)
  })
})

describe('shouldAnimate', () => {
  it('animates streamed or slow lookups, never instant cache hits', () => {
    expect(shouldAnimate(true, 10)).toBe(true)
    expect(shouldAnimate(false, 900)).toBe(true)
    expect(shouldAnimate(false, 5)).toBe(false)
    expect(shouldAnimate(false, 250)).toBe(false)
  })
})
