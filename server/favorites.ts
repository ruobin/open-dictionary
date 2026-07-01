import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import type { FavoriteKey } from '../shared/favorites'
import { FAVORITES_RATE_LIMIT_RPM } from './config'

interface FavoriteDoc extends FavoriteKey {
  userKey: string
  createdAt: Date
}

interface Auth0Payload {
  sub?: string
}

// Auth0 subs look like "auth0|...", "google-oauth2|...", "email|...". Cap well
// above any real value to bound storage while never rejecting a legit identity.
const MAX_USER_KEY_LEN = 128

export function normalizeFavorite(body: unknown): FavoriteKey | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const word = typeof b.word === 'string' ? b.word.trim().toLowerCase() : ''
  const sourceLang = typeof b.sourceLang === 'string' ? b.sourceLang.trim().toLowerCase() : ''
  const targetLang = typeof b.targetLang === 'string' ? b.targetLang.trim().toLowerCase() : ''
  if (!word || !sourceLang || !targetLang || word.length > 256) return null
  return { word, sourceLang, targetLang }
}

/**
 * Derives the caller's identity from the VERIFIED Auth0 JWT (`req.auth.payload.sub`).
 * A client-supplied identity header must never be trusted — it is trivially
 * spoofable and would let anyone read/mutate another user's favorites (IDOR).
 */
function userKeyFromReq(req: Request): string | undefined {
  const payload = (req as unknown as { auth?: { payload?: Auth0Payload } }).auth?.payload
  const sub = payload?.sub?.trim()
  if (!sub || sub.length > MAX_USER_KEY_LEN) return undefined
  return sub
}

function collection() {
  return getMongoDb()?.collection<FavoriteDoc>('favorites')
}

const favoritesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: FAVORITES_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

/**
 * Favorites API (MongoDB-backed). Every route requires a valid Auth0 access
 * token (audience = AUTH0_AUDIENCE); the caller's identity is the JWT `sub`,
 * so a user can only ever read/mutate their own favorites. Keyed by
 * (userKey, word, sourceLang, targetLang).
 */
export function createFavoritesRouter(checkJwt: RequestHandler): Router {
  const router = Router()
  // Reject every request without a valid access token before any handler runs.
  router.use(checkJwt)

  router.get('/favorites', favoritesLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userKey = userKeyFromReq(req)
      if (!userKey) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      const col = collection()
      if (!col) {
        res.json([])
        return
      }
      const docs = await col.find({ userKey }).toArray()
      const favorites: FavoriteKey[] = docs.map(({ word, sourceLang, targetLang }) => ({
        word,
        sourceLang,
        targetLang,
      }))
      res.json(favorites)
    } catch (err) {
      next(err)
    }
  })

  router.post('/favorites', favoritesLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userKey = userKeyFromReq(req)
      if (!userKey) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      const fav = normalizeFavorite(req.body)
      if (!fav) {
        res.status(400).json({ error: 'invalid_favorite' })
        return
      }
      const col = collection()
      if (col) {
        await col.updateOne(
          { userKey, ...fav },
          { $setOnInsert: { createdAt: new Date() } },
          { upsert: true }
        )
      }
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  router.delete('/favorites', favoritesLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userKey = userKeyFromReq(req)
      if (!userKey) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      const fav = normalizeFavorite({
        word: req.query.word,
        sourceLang: req.query.from,
        targetLang: req.query.to,
      })
      if (!fav) {
        res.status(400).json({ error: 'invalid_favorite' })
        return
      }
      const col = collection()
      if (col) await col.deleteOne({ userKey, ...fav })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  return router
}
