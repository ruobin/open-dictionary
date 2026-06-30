/** Shared error type for content providers (dictionary tier). The LLM tier
 *  has its own LlmProviderError; both expose a `code` so the translate route
 *  can map them to HTTP status without coupling to a single class. */
export type ProviderErrorCode = 'not_found' | 'timeout' | 'network' | 'api_error'

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status?: number

  constructor(code: ProviderErrorCode, message?: string, status?: number) {
    super(message ?? code)
    this.name = 'ProviderError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}
