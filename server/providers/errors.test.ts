import { describe, expect, it } from 'vitest'
import { ProviderError } from './errors'

describe('ProviderError', () => {
  it('sets name, code, and message', () => {
    const err = new ProviderError('not_found', 'No entry found')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ProviderError')
    expect(err.code).toBe('not_found')
    expect(err.message).toBe('No entry found')
  })

  it('defaults the message to the code', () => {
    const err = new ProviderError('timeout')
    expect(err.message).toBe('timeout')
  })

  it('captures an optional HTTP status', () => {
    const err = new ProviderError('api_error', 'Upstream error', 500)
    expect(err.status).toBe(500)
  })

  it('leaves status undefined when not provided', () => {
    const err = new ProviderError('network')
    expect(err.status).toBeUndefined()
  })
})
