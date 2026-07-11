import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshAuth() {
  vi.resetModules()
  return import('./auth')
}

afterEach(() => {
  delete process.env.ADMIN_USER_IDS
})

describe('admin/auth: isAdminSub', () => {
  it('returns false when ADMIN_USER_IDS is unset (empty allowlist)', async () => {
    const { isAdminSub } = await freshAuth()
    expect(isAdminSub('auth0|abc123')).toBe(false)
  })

  it('returns true for a sub in the comma-separated allowlist', async () => {
    process.env.ADMIN_USER_IDS = 'auth0|abc123, auth0|def456'
    const { isAdminSub } = await freshAuth()
    expect(isAdminSub('auth0|abc123')).toBe(true)
    expect(isAdminSub('auth0|def456')).toBe(true)
  })

  it('returns false for a sub not in the allowlist', async () => {
    process.env.ADMIN_USER_IDS = 'auth0|abc123'
    const { isAdminSub } = await freshAuth()
    expect(isAdminSub('auth0|someone-else')).toBe(false)
  })

  it('returns false for undefined, null, or empty string', async () => {
    process.env.ADMIN_USER_IDS = 'auth0|abc123'
    const { isAdminSub } = await freshAuth()
    expect(isAdminSub(undefined)).toBe(false)
    expect(isAdminSub(null)).toBe(false)
    expect(isAdminSub('')).toBe(false)
  })

  it('trims whitespace around allowlist entries', async () => {
    process.env.ADMIN_USER_IDS = '  auth0|abc123  ,  auth0|def456  '
    const { isAdminSub } = await freshAuth()
    expect(isAdminSub('auth0|abc123')).toBe(true)
    expect(isAdminSub('auth0|def456')).toBe(true)
  })
})

describe('admin/auth: adminSubFromReq', () => {
  it('reads sub from the verified JWT payload', async () => {
    const { adminSubFromReq } = await freshAuth()
    const req = { auth: { payload: { sub: 'auth0|abc123' } } } as unknown as Request
    expect(adminSubFromReq(req)).toBe('auth0|abc123')
  })

  it('returns undefined when there is no auth payload', async () => {
    const { adminSubFromReq } = await freshAuth()
    const req = {} as unknown as Request
    expect(adminSubFromReq(req)).toBeUndefined()
  })
})

describe('admin/auth: createRequireAdmin', () => {
  function mockRes() {
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response
    ;(res.status as ReturnType<typeof vi.fn>).mockReturnValue(res)
    return res
  }

  it('returns [checkJwt, adminOnly] with checkJwt passed through unchanged', async () => {
    const { createRequireAdmin } = await freshAuth()
    const checkJwt = vi.fn()
    const chain = createRequireAdmin(checkJwt as never)
    expect(chain).toHaveLength(2)
    expect(chain[0]).toBe(checkJwt)
  })

  it('the second middleware calls next() for an allowlisted sub', async () => {
    process.env.ADMIN_USER_IDS = 'auth0|abc123'
    const { createRequireAdmin } = await freshAuth()
    const [, adminOnly] = createRequireAdmin(vi.fn() as never)
    const req = { auth: { payload: { sub: 'auth0|abc123' } } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()
    adminOnly(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('the second middleware responds 403 forbidden for a non-allowlisted sub', async () => {
    process.env.ADMIN_USER_IDS = 'auth0|abc123'
    const { createRequireAdmin } = await freshAuth()
    const [, adminOnly] = createRequireAdmin(vi.fn() as never)
    const req = { auth: { payload: { sub: 'auth0|intruder' } } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()
    adminOnly(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' })
  })

  it('the second middleware responds 403 when there is no verified sub at all', async () => {
    process.env.ADMIN_USER_IDS = 'auth0|abc123'
    const { createRequireAdmin } = await freshAuth()
    const [, adminOnly] = createRequireAdmin(vi.fn() as never)
    const req = {} as unknown as Request
    const res = mockRes()
    const next = vi.fn()
    adminOnly(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })
})
