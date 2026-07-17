import {
  buildLlmProvider,
  createFusionProvider,
  LlmProviderError,
  type LlmProvider,
  type LlmProviderConfig,
  type LlmRegistryResult,
} from '../providers/llm'
import {
  getProviderDoc,
  getSettings,
  providerToLlmConfig,
  MongoUnavailableError,
  type LlmProviderDoc,
  type LlmSettingsDoc,
} from '../admin/providersRepo'

/**
 * Hot-swappable LLM provider wrapper (docs/design-admin-portal.md §7.1-7.2).
 * Boot order is env-baseline-first, always. `reloadFromDb()` then layers a
 * DB-sourced override on top when one is configured, and falls back to the
 * env baseline on any failure (dangling activeProviderId, disabled provider,
 * bad vendor config, decrypt failure) — this service is never left throwing,
 * only degraded, per §12's failure-mode table.
 */

export type LlmServiceSource = 'env' | 'db'
export type LlmServiceStatus = 'active' | 'disabled' | 'misconfigured'

export interface LlmServiceState {
  source: LlmServiceSource
  status: LlmServiceStatus
  message: string
  providerId?: string
  providerName?: string
  vendor?: string
  model?: string
  /** The built provider's own cache-key id, e.g. "llm:deepseek:deepseek-v4-flash". */
  id?: string
  /** When fusion mode is active: the secondary provider/model. Absent
   *  otherwise (single-provider mode). */
  secondaryProviderId?: string
  secondaryProviderName?: string
  secondaryModel?: string
  /** llm_settings.configVersion as of the last successful read — debugging aid for multi-instance drift (§7.3). */
  configVersion?: number
  appliedAt: string
}

export interface LlmService {
  /** The provider to use right now, or null if the LLM tier is off/broken. */
  current(): LlmProvider | null
  /** Diagnostic snapshot for the admin Overview page (GET /api/admin/llm/status). */
  status(): LlmServiceState
  /** Re-reads llm_settings and (re)builds the active provider. Never throws. */
  reloadFromDb(): Promise<void>
  /** Builds a provider from arbitrary config without touching current() — for
   *  the one-shot connection test and Latency Lab benchmarks (§7.1, §9). */
  buildEphemeral(cfg: LlmProviderConfig): LlmProvider
}

/**
 * Only the Mongo-touching reads are injectable — `providerToLlmConfig` /
 * `buildLlmProvider` are exercised for real even in tests, since they're
 * deterministic given fixed input and module env state.
 */
export interface LlmServiceDeps {
  getSettings: () => Promise<LlmSettingsDoc | null>
  getProviderDoc: (id: string) => Promise<LlmProviderDoc | null>
}

const defaultDeps: LlmServiceDeps = { getSettings, getProviderDoc }

export function createLlmService(envResult: LlmRegistryResult, deps: LlmServiceDeps = defaultDeps): LlmService {
  let activeProvider: LlmProvider | null = envResult.provider
  let currentState: LlmServiceState = {
    source: 'env',
    status: envResult.status,
    message: envResult.message,
    id: envResult.provider?.id,
    appliedAt: new Date().toISOString(),
  }

  function applyEnv(status: LlmServiceStatus, message: string, configVersion?: number): void {
    activeProvider = envResult.provider
    currentState = {
      source: 'env',
      status,
      message,
      id: envResult.provider?.id,
      configVersion,
      appliedAt: new Date().toISOString(),
    }
  }

  function disableViaDb(message: string, configVersion: number): void {
    activeProvider = null
    currentState = {
      source: 'db',
      status: 'disabled',
      message,
      configVersion,
      appliedAt: new Date().toISOString(),
    }
  }

  async function reloadFromDb(): Promise<void> {
    let settings: LlmSettingsDoc | null
    try {
      settings = await deps.getSettings()
    } catch (err) {
      if (!(err instanceof MongoUnavailableError)) {
        console.error('[llm-service] failed to read llm_settings — keeping current state:', err)
      }
      return
    }

    if (!settings) {
      // No settings doc has ever been written — the env baseline stands.
      applyEnv(envResult.status, envResult.message)
      return
    }

    if (settings.activeProviderId === undefined) {
      // Settings doc exists (e.g. touched only via touchConfigVersion) but
      // has no opinion on the active provider — env baseline stands.
      applyEnv(envResult.status, envResult.message, settings.configVersion)
      return
    }

    if (settings.activeProviderId === null) {
      // Admin deliberately switched the LLM tier off — do NOT fall back to env.
      disableViaDb('LLM tier explicitly disabled via admin panel', settings.configVersion)
      return
    }

    const providerId = settings.activeProviderId.toHexString()
    let doc: LlmProviderDoc | null
    try {
      doc = await deps.getProviderDoc(providerId)
    } catch (err) {
      console.error(`[llm-service] failed to load active provider ${providerId} — keeping current state:`, err)
      return
    }

    if (!doc) {
      console.error(
        `[llm-service] llm_settings.activeProviderId ${providerId} does not exist in llm_providers — reverting to env baseline`
      )
      applyEnv(
        'misconfigured',
        `Active provider ${providerId} not found — reverted to env baseline (${envResult.message})`,
        settings.configVersion
      )
      return
    }

    if (!doc.enabled) {
      console.error(`[llm-service] active provider "${doc.name}" is disabled — reverting to env baseline`)
      applyEnv(
        'misconfigured',
        `Provider "${doc.name}" is disabled — reverted to env baseline (${envResult.message})`,
        settings.configVersion
      )
      return
    }

    try {
      const cfg = providerToLlmConfig(doc, settings.activeModelId ?? undefined)
      const provider = buildLlmProvider(cfg)

      // --- fusion: optional second provider merged into the result. ---
      const secondaryState = await buildSecondary(settings, provider)
      if (secondaryState) {
        activeProvider = secondaryState.provider
        currentState = {
          source: 'db',
          status: 'active',
          message: `Fusion active: "${doc.name}" + "${secondaryState.name}" (${secondaryState.provider.id})`,
          providerId: doc._id.toHexString(),
          providerName: doc.name,
          vendor: doc.vendor,
          model: cfg.model,
          id: secondaryState.provider.id,
          secondaryProviderId: secondaryState.id,
          secondaryProviderName: secondaryState.name,
          secondaryModel: secondaryState.model,
          configVersion: settings.configVersion,
          appliedAt: new Date().toISOString(),
        }
      } else {
        activeProvider = provider
        currentState = {
          source: 'db',
          status: 'active',
          message: `Provider "${doc.name}" active (${provider.id})`,
          providerId: doc._id.toHexString(),
          providerName: doc.name,
          vendor: doc.vendor,
          model: cfg.model,
          id: provider.id,
          configVersion: settings.configVersion,
          appliedAt: new Date().toISOString(),
        }
      }
    } catch (err) {
      const detail = err instanceof LlmProviderError ? err.message : String(err)
      console.error(`[llm-service] failed to initialize provider "${doc.name}": ${detail} — reverting to env baseline`)
      applyEnv(
        'misconfigured',
        `Provider "${doc.name}" failed to initialize (${detail}) — reverted to env baseline (${envResult.message})`,
        settings.configVersion
      )
    }
  }

  /**
   * If the settings doc configures a secondary provider for fusion mode,
   * loads + builds it and wraps (primary, secondary) in a FusionProvider.
   * Returns null when no secondary is configured, or on any secondary failure
   * (in which case the primary stands alone — fusion is best-effort).
   */
  async function buildSecondary(
    settings: LlmSettingsDoc,
    primary: LlmProvider
  ): Promise<{ provider: LlmProvider; id: string; name: string; model: string } | null> {
    const secId = settings.secondaryProviderId
    if (!secId) return null
    const id = secId.toHexString()
    let secDoc: LlmProviderDoc | null
    try {
      secDoc = await deps.getProviderDoc(id)
    } catch (err) {
      console.error(`[llm-service] failed to load secondary provider ${id} — fusion disabled, primary stands alone:`, err)
      return null
    }
    if (!secDoc || !secDoc.enabled) {
      console.error(
        `[llm-service] secondary provider ${id} is missing or disabled — fusion disabled, primary stands alone`
      )
      return null
    }
    try {
      const secCfg = providerToLlmConfig(secDoc, settings.secondaryModelId ?? undefined)
      const secondary = buildLlmProvider(secCfg)
      const fusion = createFusionProvider({ primary, secondary })
      return { provider: fusion, id, name: secDoc.name, model: secCfg.model }
    } catch (err) {
      const detail = err instanceof LlmProviderError ? err.message : String(err)
      console.error(
        `[llm-service] failed to initialize secondary provider "${secDoc.name}": ${detail} — fusion disabled, primary stands alone`
      )
      return null
    }
  }

  return {
    current: () => activeProvider,
    status: () => currentState,
    reloadFromDb,
    buildEphemeral: (cfg: LlmProviderConfig) => buildLlmProvider(cfg),
  }
}
