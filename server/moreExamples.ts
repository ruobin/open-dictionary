import { createHash } from 'crypto'
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { getMongoDb } from './db'
import { normalizeText, type GradedExample } from './translate'
import type { LlmService } from './llm/service'
import { LANGUAGES } from '../shared/languages'
import { MORE_EXAMPLES_RATE_LIMIT_RPM } from './config'
import { llmGuard, recordLlmSpend, refuseOverBudget } from './abuseGuard'
import { classifyChannel } from './activityLog'
import type { UsageService } from './usage'
import type { Ticket } from './usage/meter'
import { sendMeterError } from './usage/http'
import { identify, identityOf, rateLimitKey } from './usage/principal'

/**
 * "More examples like this" (to-do §3) — a follow-up LLM call scoped to one
 * sense, optionally constrained by topic and/or CEFR level. Cached under its
 * own key (word + sense + constraints) separately from the main translation
 * cache, since it's a different, more speculative shape (an examples list,
 * not a full entry) and doesn't need the same 1-year TTL story.
 */
const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code))
const CEFR_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
const MAX_DEFINITION_LENGTH = 500
const MAX_TOPIC_LENGTH = 100

export interface MoreExamplesDoc {
  _id: string
  word: string
  sourceLang: string
  targetLang: string
  senseDefinition: string
  topic?: string
  cefr?: string
  examples: GradedExample[]
  fetchedAt: Date
}

interface NormalizedRequest {
  word: string
  sourceLang: string
  targetLang: string
  senseDefinition: string
  topic?: string
  cefr?: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'
}

export function normalizeRequest(query: Record<string, unknown>): NormalizedRequest | null {
  const word = normalizeText(typeof query.word === 'string' ? query.word : '')
  if (!word) return null

  const sourceLang = typeof query.from === 'string' ? query.from.trim().toLowerCase() : 'en'
  const targetLang = typeof query.to === 'string' ? query.to.trim().toLowerCase() : 'en'
  if (!LANGUAGE_CODES.has(sourceLang) || !LANGUAGE_CODES.has(targetLang)) return null

  const senseDefinition =
    typeof query.definition === 'string' ? query.definition.trim().slice(0, MAX_DEFINITION_LENGTH) : ''
  if (!senseDefinition) return null

  const topicRaw = typeof query.topic === 'string' ? query.topic.trim().slice(0, MAX_TOPIC_LENGTH) : ''
  const topic = topicRaw ? topicRaw : undefined

  const cefrRaw = typeof query.cefr === 'string' ? query.cefr.trim().toUpperCase() : ''
  const cefr = CEFR_LEVELS.has(cefrRaw) ? (cefrRaw as NormalizedRequest['cefr']) : undefined

  return { word, sourceLang, targetLang, senseDefinition, ...(topic ? { topic } : {}), ...(cefr ? { cefr } : {}) }
}

function cacheKey(req: NormalizedRequest): string {
  const raw = `${req.sourceLang}|${req.targetLang}|${req.word}|${req.senseDefinition}|${req.topic ?? ''}|${req.cefr ?? ''}`
  return createHash('sha1').update(raw).digest('hex')
}

const moreExamplesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: MORE_EXAMPLES_RATE_LIMIT_RPM,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => identityOf(req, res).principal.kind === 'owner',
  keyGenerator: (req, res) => rateLimitKey(identityOf(req, res)),
  message: { error: 'rate_limited' },
})

export interface MoreExamplesRouterOptions {
  /** Usage metering (docs/design-llm-usage-quotas.md). Without it nothing is metered. */
  usage?: UsageService
  /** `auth({ authRequired: false })`. */
  optionalJwt?: RequestHandler
}

export function createMoreExamplesRouter(options: MoreExamplesRouterOptions = {}): Router {
  const router = Router()
  const { usage } = options
  const identity: RequestHandler[] = options.optionalJwt ? [options.optionalJwt, identify] : [identify]

  router.get(
    '/more-examples',
    ...identity,
    moreExamplesLimiter,
    llmGuard,
    async (req: Request, res: Response, next: NextFunction) => {
      let ticket: Ticket | undefined
      let charged = false
      let providerId: string | undefined
      try {
        const normalized = normalizeRequest(req.query as Record<string, unknown>)
        if (!normalized) {
          res.status(400).json({ error: 'invalid_request' })
          return
        }

        const col = getMongoDb()?.collection<MoreExamplesDoc>('more_examples')
        const key = cacheKey(normalized)
        if (col) {
          const cached = await col.findOne({ _id: key })
          if (cached) {
            res.json({ examples: cached.examples })
            return
          }
        }

        if (refuseOverBudget(res, true)) return

        const svc = req.app.locals.llmService as LlmService
        if (!svc.current() && !svc.currentMetered?.()) {
          res.status(503).json({ error: 'not_configured' })
          return
        }

        // Quota check (docs/design-llm-usage-quotas.md §5.3): one uncached
        // batch is one generation, on the same model route as lookups.
        const { principal } = identityOf(req, res)
        if (usage) {
          ticket = await usage.meter.reserve({
            principal,
            action: 'examples',
            channel: classifyChannel(req.get('origin')),
            word: normalized.word,
            sourceLang: normalized.sourceLang,
            targetLang: normalized.targetLang,
          })
        }
        const llm = ticket?.route === 'metered' ? (svc.currentMetered?.() ?? svc.current()) : svc.current()
        if (!llm) {
          res.status(503).json({ error: 'not_configured' })
          return
        }
        providerId = llm.id

        const result = await llm.moreExamples(
          {
            word: normalized.word,
            sourceLang: normalized.sourceLang,
            targetLang: normalized.targetLang,
            senseDefinition: normalized.senseDefinition,
            topic: normalized.topic,
            cefr: normalized.cefr,
          },
          ticket ? { usage: ticket.usage } : undefined
        )
        charged = result.examples.length > 0

        if (principal.kind !== 'owner') recordLlmSpend(req)

        if (col) {
          await col
            .updateOne(
              { _id: key },
              { $set: { ...normalized, examples: result.examples, fetchedAt: new Date() } },
              { upsert: true }
            )
            .catch((err) => console.warn('[more-examples] cache write failed (non-fatal):', err))
        }

        if (ticket?.source === 'free' && charged) res.setHeader('X-Generation', 'charged')
        res.json({ examples: result.examples })
      } catch (err) {
        if (sendMeterError(res, err)) return
        next(err)
      } finally {
        if (ticket) {
          void ticket
            .settle({ charged, ...(providerId ? { providerId } : {}) })
            .catch((err: unknown) => console.warn('[usage] settle failed (non-fatal):', err))
        }
      }
    }
  )

  return router
}
