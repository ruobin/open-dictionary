import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ADMIN_USER_IDS } from '../config'

/**
 * Admin authorization (docs/design-admin-portal.md §6) — allowlist-only by
 * explicit product decision: no Auth0 RBAC / `permissions` claim dependency,
 * just `sub ∈ ADMIN_USER_IDS`. Authentication itself (401 for a missing or
 * invalid token) remains `checkJwt`'s job, built once in server/app.ts; this
 * module only adds the 403 authorization layer on top.
 */

interface Auth0Payload {
  sub?: string
}

/** The verified `sub` claim from the JWT. Never trust a client-supplied identity — this must run after `checkJwt`. */
export function adminSubFromReq(req: Request): string | undefined {
  const payload = (req as unknown as { auth?: { payload?: Auth0Payload } }).auth?.payload
  return payload?.sub
}

/** Pure allowlist check — unit-testable without building a request. */
export function isAdminSub(sub: string | undefined | null): boolean {
  return typeof sub === 'string' && sub.length > 0 && ADMIN_USER_IDS.has(sub)
}

function adminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminSub(adminSubFromReq(req))) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  next()
}

/**
 * `[checkJwt, adminOnly]`, ready to spread into `router.use(...)`. 401 for a
 * missing/invalid token is `checkJwt`'s existing behavior (unchanged); 403
 * `{ error: "forbidden" }` for a valid token whose `sub` is not allowlisted.
 */
export function createRequireAdmin(checkJwt: RequestHandler): RequestHandler[] {
  return [checkJwt, adminOnly]
}
