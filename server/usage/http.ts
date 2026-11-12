import type { Response } from 'express'
import { AccountBlockedError, GenerationUnavailableError, QuotaDeniedError } from './meter'

/**
 * HTTP responses for metering refusals (docs/design-llm-usage-quotas.md §5.7).
 * Quota denials are 429 so already-installed extensions (≤ 0.3.0), which map
 * 429 to "rate limited", still show something sensible.
 */
export function sendMeterError(res: Response, err: unknown): boolean {
  if (err instanceof QuotaDeniedError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds))
    res.status(429).json(err.toBody())
    return true
  }
  if (err instanceof AccountBlockedError) {
    // Same body as the IP blocklist (server/abuseGuard.ts blocklistGuard).
    res.status(403).json({ error: 'blocked' })
    return true
  }
  if (err instanceof GenerationUnavailableError) {
    res.setHeader('Retry-After', '60')
    res.status(503).json({ error: 'generation_unavailable' })
    return true
  }
  return false
}
