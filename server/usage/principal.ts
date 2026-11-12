import { isIP } from 'node:net'
import type { NextFunction, Request, Response } from 'express'
import { clientIp } from '../abuseGuard'
import { isAdminSub } from '../admin/auth'
import type { AuthState, Principal } from './types'

/**
 * Who is asking (docs/design-llm-usage-quotas.md §5.2). Resolved
 * synchronously from the already-verified token, with no DB read, so rate
 * limiting can use it. `optionalJwt` must run first: it sets `req.auth` for a
 * valid token and leaves it unset for a missing or invalid one.
 */

/** Expands an IPv6 address into its eight 16-bit groups, or null if malformed. */
export function expandIpv6(ip: string): number[] | null {
  const addr = ip.split('%')[0].toLowerCase()
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const parse = (s: string, allowIpv4Tail: boolean): number[] | null => {
    if (!s) return []
    const out: number[] = []
    const parts = s.split(':')
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i]
      if (allowIpv4Tail && i === parts.length - 1 && p.includes('.')) {
        const octets = p.split('.')
        if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null
        const [a, b, c, d] = octets.map(Number)
        out.push((a << 8) | b, (c << 8) | d)
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(p)) return null
        out.push(parseInt(p, 16))
      }
    }
    return out
  }
  if (halves.length === 1) {
    const groups = parse(halves[0], true)
    return groups && groups.length === 8 ? groups : null
  }
  const head = parse(halves[0], false)
  const tail = parse(halves[1], true)
  if (!head || !tail) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** IPv4 as is; IPv6 truncated to its /64, so rotating within one allocation shares a counter. */
export function ipKeyFor(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const groups = expandIpv6(ip)
  if (!groups) return ip
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`
}

export interface UsageIdentity {
  principal: Principal
  authState: AuthState
}

function verifiedSub(req: Request): string | undefined {
  const sub = (req as unknown as { auth?: { payload?: { sub?: unknown } } }).auth?.payload?.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : undefined
}

export function resolveIdentity(req: Request): UsageIdentity {
  const ip = clientIp(req)
  const ipKey = ipKeyFor(ip)
  const sub = verifiedSub(req)
  if (sub) {
    return {
      principal: isAdminSub(sub) ? { kind: 'owner', sub, ip, ipKey } : { kind: 'user', sub, ip, ipKey },
      authState: 'valid',
    }
  }
  // express-oauth2-jwt-bearer with authRequired:false calls next() on ANY
  // failure, so a header without req.auth means the token was rejected
  // (expired, wrong audience, JWKS unreachable). Report it so the client can
  // ask the user to sign in again instead of quietly spending the anonymous
  // allowance.
  const header = req.get('authorization')
  return {
    principal: { kind: 'anon', ip, ipKey },
    authState: typeof header === 'string' && header.trim() !== '' ? 'invalid' : 'anonymous',
  }
}

const LOCALS_KEY = 'usageIdentity'

/** Middleware: resolves the identity once and keeps it on `res.locals`. */
export function identify(req: Request, res: Response, next: NextFunction): void {
  res.locals[LOCALS_KEY] = resolveIdentity(req)
  next()
}

export function identityOf(req: Request, res: Response): UsageIdentity {
  const cached = res.locals[LOCALS_KEY] as UsageIdentity | undefined
  return cached ?? resolveIdentity(req)
}

/** Rate-limit key: signed-in users by `sub` (no shared-NAT collisions), everyone else by IP (/64). */
export function rateLimitKey(identity: UsageIdentity): string {
  const p = identity.principal
  return p.kind === 'anon' ? `ip:${p.ipKey}` : `u:${p.sub}`
}
