import { Router, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { LANGUAGES } from '../shared/languages'
import { REPORT_RATE_LIMIT_RPM } from './config'
import { CACHE_VERSION } from './translate'

/**
 * "Report this entry" (to-do §4) — the feedback loop into a corpus too large
 * to review manually. Public (no auth: anyone can flag a bad entry) but
 * rate-limited. Reports are stored in their own collection (word, langs,
 * cache version, optional free-text reason, timestamp) rather than mutating
 * the cache doc directly — keeps every report auditable instead of a single
 * flag that the next report silently overwrites; a review process reads this
 * collection and decides whether to purge/regenerate the cache entry.
 */
const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))
const MAX_TEXT_LENGTH = 256
const MAX_REASON_LENGTH = 500

interface ReportDoc {
  word: string
  sourceLang: string
  targetLang: string
  version: string
  reason?: string
  createdAt: Date
}

interface NormalizedReport {
  word: string
  sourceLang: string
  targetLang: string
  reason?: string
}

export function normalizeReport(body: unknown): NormalizedReport | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const word = typeof b.word === 'string' ? b.word.trim().toLowerCase() : ''
  const sourceLang = typeof b.sourceLang === 'string' ? b.sourceLang.trim().toLowerCase() : ''
  const targetLang = typeof b.targetLang === 'string' ? b.targetLang.trim().toLowerCase() : ''
  if (!word || word.length > MAX_TEXT_LENGTH) return null
  if (!LANGUAGE_CODES.has(sourceLang) || !LANGUAGE_CODES.has(targetLang)) return null

  const reasonRaw = typeof b.reason === 'string' ? b.reason.trim() : ''
  const reason = reasonRaw ? reasonRaw.slice(0, MAX_REASON_LENGTH) : undefined
  return { word, sourceLang, targetLang, ...(reason ? { reason } : {}) }
}

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: REPORT_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
})

export function createReportRouter(): Router {
  const router = Router()

  router.post('/report', reportLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = normalizeReport(req.body)
      if (!report) {
        res.status(400).json({ error: 'invalid_report' })
        return
      }
      const col = getMongoDb()?.collection<ReportDoc>('reports')
      if (col) {
        await col.insertOne({ ...report, version: CACHE_VERSION, createdAt: new Date() })
      }
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  return router
}
