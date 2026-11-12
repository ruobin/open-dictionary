import type { Db } from 'mongodb'
import { createBudgetAlerts } from './alerts'
import { createMeter, type Meter } from './meter'
import { getUsageSettings, type UsageSettings } from './settings'
import { createMongoUsageStore, type UsageStore } from './store'
import { createVerifier, type Auth0Directory, type Verifier } from './verification'

/**
 * LLM usage tiers and quotas (docs/design-llm-usage-quotas.md). One service
 * per process, built in server/app.ts and handed to the routers that can
 * trigger paid generations.
 */
export interface UsageService {
  readonly store: UsageStore | null
  readonly meter: Meter
  readonly verifier: Verifier
  readonly directory: Auth0Directory | null
  settings(): UsageSettings
  /** Provider currently serving the metered route. */
  meteredProviderId(): string | undefined
}

export interface UsageServiceOptions {
  db: Db | null
  directory: Auth0Directory | null
  meteredProviderId: () => string | undefined
  /** Overrides for tests. */
  store?: UsageStore | null
  settings?: () => UsageSettings
  now?: () => Date
}

export function createUsageService(opts: UsageServiceOptions): UsageService {
  const store = opts.store !== undefined ? opts.store : opts.db ? createMongoUsageStore(opts.db) : null
  const settings = opts.settings ?? getUsageSettings
  const verifier = createVerifier({ directory: opts.directory, store })
  const alerts = createBudgetAlerts({ db: () => opts.db, webhookUrl: () => settings().alertWebhookUrl, now: opts.now })
  const meter = createMeter({
    store,
    settings,
    verifier,
    meteredProviderId: opts.meteredProviderId,
    alerts,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { store, meter, verifier, directory: opts.directory, settings, meteredProviderId: opts.meteredProviderId }
}

export type { Ticket, AllowanceView } from './meter'
export { MeterError, QuotaDeniedError, AccountBlockedError, GenerationUnavailableError } from './meter'
