import { describe, expect, it } from 'vitest'
import {
  counterKeys,
  dayKeyExpiry,
  daysInUtcMonth,
  daysLeftInUtcMonth,
  monthKeyExpiry,
  nextUtcDay,
  nextUtcMonth,
  utcDay,
  utcMonth,
} from './windows'

describe('usage windows', () => {
  it('uses calendar UTC days and months', () => {
    const t = new Date('2026-11-12T23:59:59.999Z')
    expect(utcDay(t)).toBe('2026-11-12')
    expect(utcMonth(t)).toBe('2026-11')
    expect(nextUtcDay(t).toISOString()).toBe('2026-11-13T00:00:00.000Z')
    expect(nextUtcMonth(t).toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(utcDay(new Date('2026-11-13T00:00:00.000Z'))).toBe('2026-11-13')
  })

  it('rolls over at year end', () => {
    const t = new Date('2026-12-31T12:00:00Z')
    expect(nextUtcDay(t).toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(nextUtcMonth(t).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('counts the days left in the month, today included', () => {
    expect(daysLeftInUtcMonth(new Date('2026-11-01T00:00:00Z'))).toBe(30)
    expect(daysLeftInUtcMonth(new Date('2026-11-30T18:00:00Z'))).toBe(1)
    expect(daysInUtcMonth(new Date('2028-02-10T00:00:00Z'))).toBe(29)
    expect(daysInUtcMonth(new Date('2026-02-10T00:00:00Z'))).toBe(28)
    expect(daysLeftInUtcMonth(new Date('2026-12-15T00:00:00Z'))).toBe(17)
  })

  it('keeps day counters 2 days past their day and month counters 40 days past the start of the month', () => {
    expect(dayKeyExpiry(new Date('2026-11-12T08:00:00Z')).toISOString()).toBe('2026-11-15T00:00:00.000Z')
    expect(monthKeyExpiry(new Date('2026-11-30T08:00:00Z')).toISOString()).toBe('2026-12-11T00:00:00.000Z')
  })

  it('builds counter keys without the | that Auth0 subs contain as a separator', () => {
    expect(counterKeys.user('2026-11-12', 'google-oauth2|123')).toBe('d:2026-11-12/u:google-oauth2|123')
    expect(counterKeys.ip('2026-11-12', '2001:db8:1:2::/64')).toBe('d:2026-11-12/ip:2001:db8:1:2::/64')
    expect(counterKeys.monthFree('2026-11')).toBe('m:2026-11/free')
  })
})
