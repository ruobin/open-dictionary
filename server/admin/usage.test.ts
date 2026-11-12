import { describe, expect, it } from 'vitest'
import { validateAccountPatch } from './usage'

describe('admin/usage: validateAccountPatch', () => {
  it('accepts plan, status, allowance and note changes', () => {
    expect(validateAccountPatch({ plan: 'unlimited', status: 'blocked', dailyAllowance: 50, note: '  friend  ' })).toEqual({
      ok: true,
      value: { plan: 'unlimited', status: 'blocked', dailyAllowance: 50, note: 'friend' },
    })
  })

  it('treats null (and an empty note) as "clear the override"', () => {
    expect(validateAccountPatch({ dailyAllowance: null, note: '' })).toEqual({ ok: true, value: { dailyAllowance: null, note: null } })
  })

  it('rejects unknown fields, bad values, and empty patches', () => {
    expect(validateAccountPatch({ plan: 'gold' }).ok).toBe(false)
    expect(validateAccountPatch({ dailyAllowance: 1.5 }).ok).toBe(false)
    expect(validateAccountPatch({ balance: 100 }).ok).toBe(false)
    expect(validateAccountPatch({}).ok).toBe(false)
    expect(validateAccountPatch(null).ok).toBe(false)
  })
})
