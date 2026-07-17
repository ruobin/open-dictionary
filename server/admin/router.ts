import { Router, type Request } from 'express'
import rateLimit from 'express-rate-limit'
import { ADMIN_RATE_LIMIT_RPM, IS_PROD } from '../config'
import { adminSubFromReq } from './auth'
import { ConfigEncryptionUnavailableError } from './crypto'
import { recordAudit, parseAuditQuery, listAudit } from './audit'
import {
  listProviders,
  getProviderDoc,
  createProvider,
  updateProvider,
  deleteProvider,
  recordLastTest,
  setActive,
  providerToLlmConfig,
  MongoUnavailableError,
  type LlmProviderView,
} from './providersRepo'
import {
  validateBenchmarkRequest,
  startBenchmark,
  getBenchmarkJob,
  parseHistoryQuery,
  listBenchmarkHistory,
} from './benchmark'
import { validatePlaygroundRequest, runPlayground } from './playground'
import {
  parseEntriesQuery,
  isValidEntryId,
  listEntries,
  getEntry,
  getReportsSummary,
  deleteEntry,
  batchDeleteEntries,
  validateBatchIds,
  parseReportsQuery,
  listReports,
  dismissReport,
} from './entries'
import {
  LlmProviderError,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TIMEOUT_MS,
  type LlmProviderConfig,
} from '../providers/llm'
import { getMetricsSnapshot } from '../metrics'
import type { LlmService } from '../llm/service'

/**
 * Admin API surface (design doc §8), mounted at /api/admin behind
 * requireAdmin (allowlist-only, §17 Q1) in server/app.ts. Covers Phases 1-3
 * (read-only status/metrics, provider CRUD + hot-swap active provider, the
 * Latency Lab benchmark runner). Scheduled probes (§15 Phase 4) are
 * deliberately not implemented here — see docs/design-admin-portal.md status
 * notes — so `llm_latency_probes` stays provisioned but unpopulated and
 * there is no GET .../probes route.
 */

const TEST_WORD = 'run'
const TEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

/** Safe post-`requireAdmin` cast — the `adminOnly` middleware already confirmed a valid, allowlisted sub. */
function actorSub(req: Request): string {
  return adminSubFromReq(req) as string
}

function reqIp(req: Request): string {
  return req.ip ?? 'unknown'
}

function providerErrorStatus(error: string): number {
  switch (error) {
    case 'validation':
      return 400
    case 'duplicate_name':
      return 409
    case 'encryption_unavailable':
      return 503
    case 'not_found':
      return 404
    default:
      return 500
  }
}

// --- env import candidates ---

interface EnvProviderCandidate {
  vendor: string
  name: string
  apiKey: string
  model: string
  baseUrl?: string
  headers?: Record<string, string>
}

function truthy(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t ? t : undefined
}

function readEnvProviderCandidates(): EnvProviderCandidate[] {
  const candidates: EnvProviderCandidate[] = []

  const deepseekKey = truthy(process.env.DEEPSEEK_API_KEY)
  if (deepseekKey) {
    candidates.push({
      vendor: 'deepseek',
      name: 'DeepSeek (from env)',
      apiKey: deepseekKey,
      model: truthy(process.env.DEEPSEEK_MODEL) ?? DEFAULT_DEEPSEEK_MODEL,
      baseUrl: truthy(process.env.DEEPSEEK_BASE_URL),
    })
  }

  const openrouterKey = truthy(process.env.OPENROUTER_API_KEY)
  if (openrouterKey) {
    const headers: Record<string, string> = {}
    const referer = truthy(process.env.OPENROUTER_REFERER)
    const title = truthy(process.env.OPENROUTER_TITLE)
    if (referer) headers['HTTP-Referer'] = referer
    if (title) headers['X-Title'] = title
    candidates.push({
      vendor: 'openrouter',
      name: 'OpenRouter (from env)',
      apiKey: openrouterKey,
      model: truthy(process.env.OPENROUTER_MODEL) ?? DEFAULT_OPENROUTER_MODEL,
      baseUrl: truthy(process.env.OPENROUTER_BASE_URL),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    })
  }

  const glmKey = truthy(process.env.ZAI_API_KEY)
  if (glmKey) {
    candidates.push({
      vendor: 'glm',
      name: 'GLM (from env)',
      apiKey: glmKey,
      model: truthy(process.env.GLM_MODEL) ?? truthy(process.env.LLM_MODEL) ?? 'glm-5.2',
      baseUrl: truthy(process.env.GLM_BASE_URL) ?? truthy(process.env.LLM_BASE_URL),
    })
  }

  return candidates
}

export function createAdminRouter(llmService: LlmService): Router {
  const router = Router()

  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: ADMIN_RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  })
  router.use(adminLimiter)

  // --- status & metrics ---

  router.get('/llm/status', (_req, res) => {
    res.json({ ...llmService.status(), uptimeSec: Math.round(process.uptime()) })
  })

  router.get('/metrics', (_req, res) => {
    res.json(getMetricsSnapshot())
  })

  // --- providers CRUD ---

  router.get('/llm/providers', async (_req, res, next) => {
    try {
      const providers = await listProviders()
      res.json({ providers })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.post('/llm/providers', async (req, res, next) => {
    try {
      const sub = actorSub(req)
      const result = await createProvider(req.body, sub, IS_PROD)
      if (!result.ok) {
        const body = result.error === 'validation' ? { error: result.error, errors: result.errors } : { error: result.error }
        res.status(providerErrorStatus(result.error)).json(body)
        return
      }
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'provider.create',
        target: { providerId: result.view.id, name: result.view.name },
        diff: { created: result.view },
      })
      res.status(201).json({ provider: result.view })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.patch('/llm/providers/:id', async (req, res, next) => {
    try {
      const sub = actorSub(req)
      const result = await updateProvider(req.params.id, req.body, sub, IS_PROD)
      if (!result.ok) {
        const body = result.error === 'validation' ? { error: result.error, errors: result.errors } : { error: result.error }
        res.status(providerErrorStatus(result.error)).json(body)
        return
      }
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'provider.update',
        target: { providerId: result.view.id, name: result.view.name },
        diff: { updated: result.view },
      })
      if (llmService.status().providerId === result.view.id) {
        await llmService.reloadFromDb()
      }
      res.json({ provider: result.view })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.delete('/llm/providers/:id', async (req, res, next) => {
    try {
      const sub = actorSub(req)
      const result = await deleteProvider(req.params.id)
      if (result === 'not_found') {
        res.status(404).json({ error: 'not_found' })
        return
      }
      if (result === 'active') {
        res.status(409).json({ error: 'provider_active' })
        return
      }
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'provider.delete',
        target: { providerId: req.params.id },
      })
      res.status(204).end()
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- connection test (stored provider or unsaved draft) ---

  router.post('/llm/test', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        providerId?: unknown
        modelId?: unknown
        vendor?: unknown
        baseUrl?: unknown
        apiKey?: unknown
        model?: unknown
      }

      let cfg: LlmProviderConfig
      let providerIdEcho: string | undefined

      if (typeof body.providerId === 'string' && body.providerId.trim()) {
        const doc = await getProviderDoc(body.providerId.trim())
        if (!doc) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : undefined
        cfg = providerToLlmConfig(doc, modelId)
        providerIdEcho = doc._id.toHexString()
      } else {
        const vendor = typeof body.vendor === 'string' ? body.vendor.trim().toLowerCase() : ''
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (!vendor || !apiKey || !model) {
          res.status(400).json({ error: 'validation', errors: ['vendor, apiKey, and model are required for a draft test'] })
          return
        }
        cfg = {
          vendor,
          apiKey,
          model,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() || undefined : undefined,
        }
      }
      cfg = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs ?? TEST_TIMEOUT_MS, TEST_TIMEOUT_MS) }

      const startedAt = Date.now()
      let ok = true
      let errorCode: string | undefined
      try {
        const provider = llmService.buildEphemeral(cfg)
        await provider.translate({ text: TEST_WORD, sourceLang: 'en', targetLang: 'en' })
      } catch (err) {
        ok = false
        errorCode = err instanceof LlmProviderError ? err.code : 'network'
      }
      const ms = Date.now() - startedAt

      if (providerIdEcho) {
        await recordLastTest(providerIdEcho, { at: new Date(), ok, ms, errorCode: errorCode ?? null }).catch((err) => {
          console.error('[admin] failed to record lastTest:', err)
        })
      }

      res.json({ ok, ms, ...(errorCode ? { errorCode } : {}), ...(providerIdEcho ? { providerIdEcho } : {}) })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      if (err instanceof ConfigEncryptionUnavailableError) {
        res.status(503).json({ error: 'encryption_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- Latency Lab: on-demand benchmarks ---

  router.post('/llm/benchmark', async (req, res, next) => {
    try {
      const parsed = validateBenchmarkRequest(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: 'validation', errors: parsed.errors })
        return
      }
      const sub = actorSub(req)
      const result = await startBenchmark(parsed.value, sub, reqIp(req))
      if (!result.ok) {
        if (result.error === 'in_progress') {
          res.status(409).json({ error: 'in_progress' })
          return
        }
        if (result.error === 'target_not_found') {
          res.status(404).json({ error: 'target_not_found', providerId: result.providerId })
          return
        }
        res.status(400).json({ error: 'unknown_model', providerId: result.providerId, modelId: result.modelId })
        return
      }
      res.status(202).json({ runId: result.runId, total: result.total })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.get('/llm/benchmark/:runId', (req, res) => {
    const job = getBenchmarkJob(req.params.runId)
    if (!job) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json(job)
  })

  router.get('/llm/benchmarks', async (req, res, next) => {
    try {
      const options = parseHistoryQuery(req.query as Record<string, unknown>)
      const benchmarks = await listBenchmarkHistory(options)
      res.json({ benchmarks })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- Playground: ad-hoc direct LLM lookups (bypasses cache/metrics) ---

  router.post('/llm/playground', async (req, res, next) => {
    try {
      const parsed = validatePlaygroundRequest(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: 'validation', errors: parsed.errors })
        return
      }
      const result = await runPlayground(parsed.value, {
        getProviderDoc,
        buildEphemeral: (cfg) => llmService.buildEphemeral(cfg),
      })
      if (!result.ok) {
        if (result.error === 'target_not_found') {
          res.status(404).json({ error: 'target_not_found', providerId: result.providerId })
          return
        }
        res.status(400).json({ error: 'unknown_model', providerId: result.providerId, modelId: result.modelId })
        return
      }
      res.json({ results: result.results })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- switch active provider/model ---

  router.put('/llm/active', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { providerId?: unknown; modelId?: unknown; verify?: unknown }
      if (body.providerId !== null && typeof body.providerId !== 'string') {
        res.status(400).json({ error: 'validation', errors: ['providerId must be a string or null'] })
        return
      }
      const providerId = body.providerId as string | null
      const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : undefined
      const verify = body.verify === undefined ? true : Boolean(body.verify)
      const sub = actorSub(req)

      if (providerId !== null && verify) {
        const doc = await getProviderDoc(providerId)
        if (!doc) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        if (modelId && !doc.models.some((m) => m.id === modelId)) {
          res.status(400).json({ error: 'unknown_model' })
          return
        }
        const baseCfg = providerToLlmConfig(doc, modelId)
        const cfg = { ...baseCfg, timeoutMs: Math.min(baseCfg.timeoutMs ?? TEST_TIMEOUT_MS, TEST_TIMEOUT_MS) }
        try {
          const provider = llmService.buildEphemeral(cfg)
          await provider.translate({ text: TEST_WORD, sourceLang: 'en', targetLang: 'en' })
        } catch (err) {
          const errorCode = err instanceof LlmProviderError ? err.code : 'network'
          res.status(422).json({ error: 'verify_failed', errorCode })
          return
        }
      }

      const result = await setActive(providerId, modelId, sub)
      if (!result.ok) {
        const status = result.error === 'not_found' ? 404 : result.error === 'disabled' ? 409 : 400
        res.status(status).json({ error: result.error })
        return
      }

      await llmService.reloadFromDb()
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'active.switch',
        target: providerId ? { providerId } : undefined,
        diff: { activeProviderId: providerId, activeModelId: modelId ?? null },
      })
      res.json({ status: llmService.status() })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      if (err instanceof ConfigEncryptionUnavailableError) {
        res.status(503).json({ error: 'encryption_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- one-click env → DB import (idempotent by provider name) ---

  router.post('/llm/import-env', async (req, res, next) => {
    try {
      const sub = actorSub(req)
      const candidates = readEnvProviderCandidates()
      if (candidates.length === 0) {
        res.json({ imported: [], skipped: [] })
        return
      }

      const existing = await listProviders()
      const existingNames = new Set(existing.map((p) => p.name))

      const imported: LlmProviderView[] = []
      const skipped: string[] = []
      for (const c of candidates) {
        if (existingNames.has(c.name)) {
          skipped.push(c.name)
          continue
        }
        const result = await createProvider(
          {
            name: c.name,
            vendor: c.vendor,
            baseUrl: c.baseUrl,
            headers: c.headers,
            apiKey: c.apiKey,
            models: [{ id: c.model, isDefault: true }],
            enabled: true,
          },
          sub,
          IS_PROD
        )
        if (result.ok) {
          imported.push(result.view)
          existingNames.add(c.name)
        } else {
          skipped.push(c.name)
        }
      }

      if (imported.length > 0) {
        await recordAudit({
          actor: sub,
          ip: reqIp(req),
          action: 'env.import',
          diff: { imported: imported.map((p) => ({ id: p.id, name: p.name, vendor: p.vendor })) },
        })
      }

      res.json({ imported, skipped })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- audit log ---

  router.get('/audit', async (req, res, next) => {
    try {
      const options = parseAuditQuery(req.query as Record<string, unknown>)
      const entries = await listAudit(options)
      res.json({ entries })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  // --- cache entries (docs/design-admin-cache-entries.md) ---

  router.get('/entries', async (req, res, next) => {
    try {
      const query = parseEntriesQuery(req.query as Record<string, unknown>)
      const result = await listEntries(query)
      res.json(result)
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.get('/reports/summary', async (_req, res, next) => {
    try {
      const summary = await getReportsSummary()
      res.json(summary)
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.get('/reports', async (req, res, next) => {
    try {
      const query = parseReportsQuery(req.query as Record<string, unknown>)
      const result = await listReports(query)
      res.json(result)
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.delete('/reports/:id', async (req, res, next) => {
    try {
      const ok = await dismissReport(req.params.id)
      if (!ok) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const sub = actorSub(req)
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'report.dismiss',
        target: { name: req.params.id },
      })
      res.status(204).end()
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.get('/entries/:id', async (req, res, next) => {
    try {
      if (!isValidEntryId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const entry = await getEntry(req.params.id)
      if (!entry) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.json({ entry })
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.delete('/entries/:id', async (req, res, next) => {
    try {
      if (!isValidEntryId(req.params.id)) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const body = (req.body ?? {}) as { resolveReports?: unknown; reason?: unknown }
      const resolveReports = body.resolveReports === undefined ? true : Boolean(body.resolveReports)
      const reason =
        typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined

      const target = await getEntry(req.params.id)
      const result = await deleteEntry(req.params.id, { resolveReports })
      if (!result) {
        res.status(404).json({ error: 'not_found' })
        return
      }

      const sub = actorSub(req)
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'entry.delete',
        target: target ? { name: `${target.word} (${target.sourceLang}→${target.targetLang})` } : undefined,
        diff: {
          tier: target?.tier,
          version: target?.version,
          reportsResolved: result.reportsResolved,
          reason,
        },
      })
      res.json(result)
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  router.post('/entries/batch-delete', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { ids?: unknown; resolveReports?: unknown; reason?: unknown }
      const validated = validateBatchIds(body.ids)
      if (!validated.ok) {
        res.status(400).json({ error: 'validation', errors: [validated.error] })
        return
      }
      const resolveReports = body.resolveReports === undefined ? true : Boolean(body.resolveReports)
      const reason =
        typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined

      const result = await batchDeleteEntries(validated.value, { resolveReports })

      const sub = actorSub(req)
      await recordAudit({
        actor: sub,
        ip: reqIp(req),
        action: 'entry.batch_delete',
        target: { name: `${result.deletedIds.length} entries` },
        diff: {
          ids: validated.value,
          deletedIds: result.deletedIds,
          notFoundIds: result.notFoundIds,
          reportsResolved: result.reportsResolved,
          reason,
        },
      })
      res.json(result)
    } catch (err) {
      if (err instanceof MongoUnavailableError) {
        res.status(503).json({ error: 'mongo_unavailable' })
        return
      }
      next(err)
    }
  })

  return router
}
