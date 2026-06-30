import { describe, expect, it } from 'vitest'
import { LlmProviderError } from './types'

describe('LlmProviderError', () => {
  it('sets name, code, and message', () => {
    const err = new LlmProviderError('timeout', 'Timed out after 15s')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LlmProviderError')
    expect(err.code).toBe('timeout')
    expect(err.message).toBe('Timed out after 15s')
  })

  it('defaults the message to the code', () => {
    const err = new LlmProviderError('not_configured')
    expect(err.message).toBe('not_configured')
  })

  it('captures an optional HTTP status', () => {
    const err = new LlmProviderError('api_error', '503 Service Unavailable', 503)
    expect(err.status).toBe(503)
  })

  it('leaves status undefined when not provided', () => {
    const err = new LlmProviderError('bad_response')
    expect(err.status).toBeUndefined()
  })
})
