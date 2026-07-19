import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { LANGUAGES } from '../shared/languages'
import { MAX_LOOKUP_TEXT_LENGTH } from '../shared/limits'
import { ACTIVITY_PING_RATE_LIMIT_RPM } from './config'
import { normalizeText } from './translate'
import { recordActivity } from './activityLog'

/**
 * Client-cache hit beacon (docs/design-user-activity-log.md §14).
 * Fired by the web app / extension when a lookup is served from localStorage
 * or chrome.storage without hitting GET /api/translate/:text — so every user
 * lookup is visible in activity_log, not only server-side traffic.
 *
 * Public, unauthenticated, rate-limited. Never runs an LLM call.
 */

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))
const MAX_TEXT_LENGTH = MAX_LOOKUP_TEXT_LENGTH

export interface NormalizedActivityPing {
  word: string
  sourceLang: string
  targetLang: string
}

/** Pure body validation — unit-tested without touching Mongo/Express. */
export function normalizeActivityPing(body: unknown): NormalizedActivityPing | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>

  const wordRaw = typeof b.word === 'string' ? b.word : ''
  const word = normalizeText(wordRaw)
  if (!word || word.length > MAX_TEXT_LENGTH) return null

  const sourceLang = typeof b.sourceLang === 'string' ? b.sourceLang.trim().toLowerCase() : ''
  const targetLang = typeof b.targetLang === 'string' ? b.targetLang.trim().toLowerCase() : ''
  if (!LANGUAGE_CODES.has(sourceLang) || !LANGUAGE_CODES.has(targetLang)) return null

  return { word, sourceLang, targetLang }
}

const activityPingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ACTIVITY_PING_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function createActivityPingRouter(): Router {
  const router = Router()

  router.post('/activity-ping', activityPingLimiter, (req: Request, res: Response, next: NextFunction) => {
    try {
      const ping = normalizeActivityPing(req.body)
      if (!ping) {
        res.status(400).json({ error: 'invalid_ping' })
        return
      }

      recordActivity({
        word: ping.word,
        sourceLang: ping.sourceLang,
        targetLang: ping.targetLang,
        tier: 'client-cache',
        latencyMs: 0,
        ip: req.ip ?? 'unknown',
        userAgent: req.get('user-agent'),
        origin: req.get('origin'),
      })

      // 204 — sendBeacon callers don't need a body; keep the response minimal.
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  return router
}
