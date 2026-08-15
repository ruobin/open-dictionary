import { AdminApiError } from '../../api/admin'

const MESSAGES: Record<string, string> = {
  duplicate_name: 'A provider with this name already exists.',
  encryption_unavailable: 'Secrets storage is not configured on the server (CONFIG_ENCRYPTION_KEY missing).',
  mongo_unavailable: 'Database is unavailable right now.',
  not_found: 'That item no longer exists.',
  provider_active: 'This provider is currently active — switch to another provider first.',
  rate_limited: 'Too many requests — wait a moment and try again.',
  forbidden: 'You are not authorized to perform this action.',
  in_progress: 'A benchmark run is already in progress.',
  verify_failed: 'Verification call failed — the provider was not switched.',
  unknown_model: 'Unknown model for this provider.',
  target_not_found: 'One of the selected providers no longer exists.',
}

/** One human-readable line for any admin API failure. For multi-message
 *  validation errors (`AdminApiError.errors`), prefer rendering that list
 *  directly — this collapses it into a single joined string. */
export function describeApiError(err: unknown): string {
  if (err instanceof AdminApiError) {
    if (err.errors && err.errors.length > 0) return err.errors.join('; ')
    if (err.code === 'verify_failed') {
      const target = err.target ?? 'selected'
      const reason = err.errorCode ?? 'error'
      return `Verification failed for the ${target} provider (${reason}) — the provider was not switched.`
    }
    return MESSAGES[err.code] ?? err.message
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}
