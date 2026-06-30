import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import type { FavoriteKey } from '../shared/favorites'

interface FavoriteDoc extends FavoriteKey {
  userKey: string
  createdAt: Date
}

function normalizeFavorite(body: unknown): FavoriteKey | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const word = typeof b.word === 'string' ? b.word.trim().toLowerCase() : ''
  const sourceLang = typeof b.sourceLang === 'string' ? b.sourceLang.trim().toLowerCase() : ''
  const targetLang = typeof b.targetLang === 'string' ? b.targetLang.trim().toLowerCase() : ''
  if (!word || !sourceLang || !targetLang || word.length > 256) return null
  return { word, sourceLang, targetLang }
}

function userKeyFromReq(req: Request): string | undefined {
  return req.header('x-user-key')?.trim() || undefined
}

function collection() {
  return getMongoDb()?.collection<FavoriteDoc>('favorites')
}

const favoritesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

/**
 * Favorites API (MongoDB-backed). Identity is a soft `X-User-Key` header
 * (the authed user's sub, or a client-generated anon id) — favorites are
 * low-sensitivity; harden with JWT verification for production.
 *
 * Keyed by (userKey, word, sourceLang, targetLang).
 */
export function createFavoritesRouter(): Router {
  const router = Router()

  router.get('/favorites', favoritesLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userKey = userKeyFromReq(req)
      if (!userKey) {
        res.status(400).json({ error: 'missing_user_key' })
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
        res.status(400).json({ error: 'missing_user_key' })
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
        res.status(400).json({ error: 'missing_user_key' })
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
