/**
 * Minimal, dependency-free User-Agent parser (docs/design-user-activity-log.md
 * §5.1). Deliberately not a full UA-parsing library — the activity log only
 * needs three coarse buckets (device type, browser family, OS family) for a
 * growth dashboard, not exact browser/OS versions. Never stores or returns
 * the raw UA string; callers should discard it after calling this.
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown'

export interface ParsedUserAgent {
  type: DeviceType
  browser?: string
  os?: string
}

const BOT_PATTERN = /bot|spider|crawl|slurp|bingpreview|facebookexternalhit|curl|wget|python-requests|python-urllib|axios|node-fetch|postmanruntime|go-http-client|java\//i

/** Checked before browser detection (Edge/Opera UAs also contain `Chrome/`),
 *  and Safari is checked after Chrome (Chrome's UA also contains `Safari/`). */
function detectBrowser(ua: string): string | undefined {
  if (/edg\//i.test(ua)) return 'Edge'
  if (/opr\/|opera/i.test(ua)) return 'Opera'
  if (/chrome\//i.test(ua)) return 'Chrome'
  if (/firefox\//i.test(ua)) return 'Firefox'
  if (/safari\//i.test(ua)) return 'Safari'
  return undefined
}

/** iOS is checked before macOS since iOS UAs also contain "Mac OS X". */
function detectOs(ua: string): string | undefined {
  if (/windows/i.test(ua)) return 'Windows'
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS'
  if (/mac os x|macintosh/i.test(ua)) return 'macOS'
  if (/android/i.test(ua)) return 'Android'
  if (/linux/i.test(ua)) return 'Linux'
  return undefined
}

function detectType(ua: string): DeviceType {
  if (/ipad/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet'
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile'
  return 'desktop'
}

/** Parses a `User-Agent` header into a coarse device/browser/OS summary.
 *  Never throws — an empty/missing UA resolves to `{ type: 'unknown' }`. */
export function parseUserAgent(ua: string | undefined): ParsedUserAgent {
  if (!ua || !ua.trim()) return { type: 'unknown' }

  if (BOT_PATTERN.test(ua)) return { type: 'bot' }

  const browser = detectBrowser(ua)
  const os = detectOs(ua)
  const type = detectType(ua)

  return {
    type,
    ...(browser ? { browser } : {}),
    ...(os ? { os } : {}),
  }
}
