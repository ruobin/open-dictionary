/**
 * Vendor-specific default request headers for LLM providers. Shared between
 * the server (which applies these at request time as a fallback — see
 * server/providers/llm/openrouter.ts) and the admin ProviderForm (which
 * pre-populates them so they're visible/editable rather than implicit).
 *
 * `origin` is passed in (server uses PUBLIC_BASE_URL, the SPA uses
 * window.location.origin) so this module stays environment-agnostic.
 */

/** App name shown next to OpenRouter dashboard log entries when no X-Title
 *  header is configured. */
export const DEFAULT_OPENROUTER_TITLE = 'Open Dictionary'

export interface HeaderDefault {
  name: string
  value: string
}

/**
 * Default header rows for a vendor. Only OpenRouter has recommended
 * attribution headers (`X-Title`, `HTTP-Referer`); other vendors return none.
 * The OpenRouter dashboard groups request logs by these two values, so
 * pre-filling them lets operators distinguish this app's traffic from other
 * apps sharing the same API key without editing anything.
 */
export function defaultHeadersForVendor(vendor: string, origin: string): HeaderDefault[] {
  if (vendor === 'openrouter') {
    const rows: HeaderDefault[] = [{ name: 'X-Title', value: DEFAULT_OPENROUTER_TITLE }]
    if (origin) rows.push({ name: 'HTTP-Referer', value: origin })
    return rows
  }
  return []
}
