import { describe, expect, it } from 'vitest'
import type { ExtensionMessage, ExtensionResponse, LookupResponse, SettingsResponse } from './messages'

/**
 * Message-contract tests (design doc §11 / Phase 2's originally-deferred
 * unit tests, added in Phase 8): pure type-level construction + narrowing
 * checks. These exist mainly to pin the discriminated-union shapes so a
 * future edit to `messages.ts` that silently breaks a `type`/`ok`
 * discriminant is caught at test time, not just by `tsc` at every call
 * site (which wouldn't catch e.g. an accidentally-widened union).
 */
describe('ExtensionMessage construction', () => {
  it('builds a LOOKUP message', () => {
    const message: ExtensionMessage = {
      type: 'LOOKUP',
      text: 'hello',
      sourceLang: 'en',
      targetLang: 'es',
    }
    expect(message.type).toBe('LOOKUP')
  })

  it('builds a GET_SETTINGS message', () => {
    const message: ExtensionMessage = { type: 'GET_SETTINGS' }
    expect(message.type).toBe('GET_SETTINGS')
  })

  it('builds a SET_SETTINGS message with a partial patch', () => {
    const message: ExtensionMessage = {
      type: 'SET_SETTINGS',
      settings: { sourceLang: 'fr' },
    }
    expect(message.type).toBe('SET_SETTINGS')
    if (message.type === 'SET_SETTINGS') {
      expect(message.settings).toEqual({ sourceLang: 'fr' })
    }
  })
})

describe('ExtensionResponse narrowing', () => {
  it('narrows a successful LookupResponse via ok + entries', () => {
    const response: LookupResponse = { ok: true, entries: [] }
    if (response.ok) {
      expect(response.entries).toEqual([])
    } else {
      throw new Error('expected ok: true')
    }
  })

  it('narrows a failed LookupResponse to its error code', () => {
    const response: LookupResponse = { ok: false, error: 'rate_limited' }
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toBe('rate_limited')
    }
  })

  it('narrows a SettingsResponse via the "settings" property', () => {
    const response: SettingsResponse = {
      ok: true,
      settings: { sourceLang: 'en', targetLang: 'en', showSelectionIcon: true },
    }
    const generic: ExtensionResponse = response
    expect(generic.ok).toBe(true)
    if (generic.ok && 'settings' in generic) {
      expect(generic.settings.sourceLang).toBe('en')
    } else {
      throw new Error('expected a SettingsResponse')
    }
  })

  it('distinguishes a LookupResponse from a SettingsResponse at the same ok:true state via the discriminant property', () => {
    const lookup: ExtensionResponse = { ok: true, entries: [] }
    const settings: ExtensionResponse = {
      ok: true,
      settings: { sourceLang: 'en', targetLang: 'en', showSelectionIcon: true },
    }
    expect('entries' in lookup).toBe(true)
    expect('settings' in lookup).toBe(false)
    expect('settings' in settings).toBe(true)
    expect('entries' in settings).toBe(false)
  })
})
