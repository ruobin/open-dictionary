import { ObjectId, type Db } from 'mongodb'
import { getMongoDb } from '../db'
import type { LlmProviderConfig } from '../providers/llm'
import { decryptSecret, encryptSecret, isEncryptionAvailable, maskSecret, type EncryptedSecret, type MaskedSecret } from './crypto'

/**
 * `llm_providers` / `llm_settings` access + validation (docs/design-admin-portal.md §4.1-4.2).
 * Mongo may legitimately be absent (MONGODB_URI unset) — every I/O function
 * throws {@link MongoUnavailableError} in that case rather than crashing; the
 * router turns that into a 503.
 */

export class MongoUnavailableError extends Error {
  constructor() {
    super('MongoDB is not connected — admin provider storage is unavailable')
    this.name = 'MongoUnavailableError'
  }
}

function requireDb(): Db {
  const db = getMongoDb()
  if (!db) throw new MongoUnavailableError()
  return db
}

function providersCol(db: Db) {
  return db.collection<LlmProviderDoc>('llm_providers')
}

function settingsCol(db: Db) {
  return db.collection<LlmSettingsDoc>('llm_settings')
}

export interface LlmProviderModel {
  id: string
  label?: string
  isDefault: boolean
  timeoutMs?: number
  temperature?: number
}

export interface LlmProviderLastTest {
  at: Date
  ok: boolean
  ms: number
  errorCode?: string | null
}

export interface LlmProviderDoc {
  _id: ObjectId
  name: string
  vendor: string
  baseUrl?: string
  headers?: Record<string, string>
  apiKey: EncryptedSecret
  models: LlmProviderModel[]
  enabled: boolean
  lastTest?: LlmProviderLastTest
  createdAt: Date
  updatedAt: Date
  updatedBy: string
}

/**
 * Singleton (`_id: "llm"`). `activeProviderId` has three meaningful states:
 * absent (undefined) = DB has no opinion yet, defer entirely to the env
 * baseline; `null` = admin explicitly switched the LLM tier off; an ObjectId
 * = the active provider. Never conflate "never touched" with "explicitly
 * off" — see server/llm/service.ts reloadFromDb().
 */
export interface LlmSettingsDoc {
  _id: 'llm'
  activeProviderId?: ObjectId | null
  activeModelId?: string | null
  /** Optional second provider for "LLM fusion" mode (design doc §X): when
   *  set, the service calls both providers in parallel and merges results.
   *  Absent/null = single-provider mode; an ObjectId = fusion enabled. The
   *  primary (activeProviderId) is always required for fusion. */
  secondaryProviderId?: ObjectId | null
  secondaryModelId?: string | null
  configVersion: number
  updatedAt?: Date
  updatedBy?: string
}

export interface LlmProviderView {
  id: string
  name: string
  vendor: string
  baseUrl?: string
  headers?: Record<string, string>
  apiKey: MaskedSecret
  models: LlmProviderModel[]
  enabled: boolean
  lastTest?: { at: string; ok: boolean; ms: number; errorCode?: string | null }
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export function maskProvider(doc: LlmProviderDoc): LlmProviderView {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    vendor: doc.vendor,
    baseUrl: doc.baseUrl,
    headers: doc.headers,
    apiKey: maskSecret(doc.apiKey),
    models: doc.models,
    enabled: doc.enabled,
    lastTest: doc.lastTest ? { ...doc.lastTest, at: doc.lastTest.at.toISOString() } : undefined,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: doc.updatedBy,
  }
}

// --- Validation (§4.1) — pure, unit-tested without touching Mongo ---

const KNOWN_VENDORS = ['deepseek', 'openrouter', 'glm', 'openai-compat'] as const
const MAX_NAME_LEN = 64
const MAX_MODELS = 20
const MAX_MODEL_ID_LEN = 128

export interface ValidatedProviderFields {
  name: string
  vendor: string
  baseUrl?: string
  headers?: Record<string, string>
  models: LlmProviderModel[]
  enabled: boolean
}

export type ValidationResult =
  | { ok: true; value: ValidatedProviderFields }
  | { ok: false; errors: string[] }

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  const m = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return false
}

function validateModels(raw: unknown, errors: string[]): LlmProviderModel[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('models must be a non-empty array')
    return []
  }
  if (raw.length > MAX_MODELS) {
    errors.push(`models must have at most ${MAX_MODELS} entries`)
    return []
  }
  const out: LlmProviderModel[] = []
  const seenIds = new Set<string>()
  let defaultCount = 0
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`models[${i}] must be an object`)
      return
    }
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    if (!id || id.length > MAX_MODEL_ID_LEN) {
      errors.push(`models[${i}].id must be 1-${MAX_MODEL_ID_LEN} chars`)
      return
    }
    if (seenIds.has(id)) {
      errors.push(`models[${i}].id "${id}" is a duplicate`)
      return
    }
    seenIds.add(id)
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined
    const isDefault = Boolean(e.isDefault)
    if (isDefault) defaultCount++
    const timeoutMs = typeof e.timeoutMs === 'number' && e.timeoutMs > 0 ? e.timeoutMs : undefined
    const temperature =
      typeof e.temperature === 'number' && e.temperature >= 0 && e.temperature <= 2 ? e.temperature : undefined
    out.push({ id, label, isDefault, timeoutMs, temperature })
  })
  if (out.length === 0) return out
  if (defaultCount === 0) {
    // Sole convenience default — unambiguous only when nothing else claimed it.
    out[0].isDefault = true
  } else if (defaultCount > 1) {
    errors.push('exactly one model may have isDefault: true')
  }
  return out
}

/**
 * Validates everything except `apiKey` (handled separately — see
 * {@link resolveApiKeyForUpdate} — since create requires it and update
 * treats it as optional).
 */
export function validateProviderFields(input: unknown, isProd: boolean): ValidationResult {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['body must be an object'] }
  const b = input as Record<string, unknown>

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > MAX_NAME_LEN) errors.push(`name must be 1-${MAX_NAME_LEN} chars`)

  const vendor = typeof b.vendor === 'string' ? b.vendor.trim().toLowerCase() : ''
  if (!(KNOWN_VENDORS as readonly string[]).includes(vendor)) {
    errors.push(`vendor must be one of: ${KNOWN_VENDORS.join(', ')}`)
  }

  let baseUrl: string | undefined
  const rawBaseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : ''
  if (vendor === 'openai-compat' && !rawBaseUrl) {
    errors.push('baseUrl is required for vendor "openai-compat"')
  }
  if (rawBaseUrl) {
    try {
      const url = new URL(rawBaseUrl)
      if (url.protocol === 'https:') {
        baseUrl = rawBaseUrl
      } else if (url.protocol === 'http:' && (!isProd || isPrivateOrLocalHost(url.hostname))) {
        baseUrl = rawBaseUrl
      } else {
        errors.push('baseUrl must be https:// (http:// only allowed for localhost/private-network dev targets)')
      }
    } catch {
      errors.push('baseUrl must be a valid URL')
    }
  }

  let headers: Record<string, string> | undefined
  if (b.headers !== undefined && b.headers !== null) {
    if (typeof b.headers !== 'object' || Array.isArray(b.headers)) {
      errors.push('headers must be an object of string values')
    } else {
      const entries = Object.entries(b.headers as Record<string, unknown>).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim().length > 0
      )
      if (entries.length > 0) headers = Object.fromEntries(entries)
    }
  }

  const models = validateModels(b.models, errors)
  const enabled = b.enabled === undefined ? true : Boolean(b.enabled)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { name, vendor, baseUrl, headers, models, enabled } }
}

/**
 * §5.2 write-only semantics: apiKey absent or null on a PATCH ⇒ keep the
 * existing blob. A non-empty string ⇒ replace. Pure so the "PATCH without
 * apiKey keeps the stored blob" rule is unit-testable without Mongo.
 */
export function resolveApiKeyForUpdate(
  incomingApiKey: string | null | undefined
): { keep: true } | { keep: false; plaintext: string } | { error: string } {
  if (incomingApiKey === undefined || incomingApiKey === null) return { keep: true }
  const trimmed = incomingApiKey.trim()
  if (!trimmed) return { error: 'apiKey, if provided, must be a non-empty string' }
  return { keep: false, plaintext: trimmed }
}

/** Picks the model for a request: explicit id, else the provider's default, else the first. */
export function resolveModel(
  doc: Pick<LlmProviderDoc, 'models'>,
  modelId?: string | null
): LlmProviderModel | null {
  if (modelId) {
    const found = doc.models.find((m) => m.id === modelId)
    if (found) return found
  }
  return doc.models.find((m) => m.isDefault) ?? doc.models[0] ?? null
}

/** Decrypts and shapes a stored provider doc into what `buildLlmProvider()` needs. */
export function providerToLlmConfig(doc: LlmProviderDoc, modelId?: string | null): LlmProviderConfig {
  const model = resolveModel(doc, modelId)
  if (!model) throw new Error(`Provider "${doc.name}" has no models configured`)
  return {
    vendor: doc.vendor,
    apiKey: decryptSecret(doc.apiKey),
    model: model.id,
    baseUrl: doc.baseUrl,
    headers: doc.headers,
    timeoutMs: model.timeoutMs,
    temperature: model.temperature,
  }
}

// --- Mongo I/O ---

async function touchConfigVersion(db: Db, actorSub: string): Promise<void> {
  await settingsCol(db).updateOne(
    { _id: 'llm' },
    { $inc: { configVersion: 1 }, $set: { updatedAt: new Date(), updatedBy: actorSub } },
    { upsert: true }
  )
}

export async function listProviders(): Promise<LlmProviderView[]> {
  const db = requireDb()
  const docs = await providersCol(db).find().sort({ name: 1 }).toArray()
  return docs.map(maskProvider)
}

export async function getProviderDoc(id: string): Promise<LlmProviderDoc | null> {
  const db = requireDb()
  if (!ObjectId.isValid(id)) return null
  return providersCol(db).findOne({ _id: new ObjectId(id) })
}

export type CreateProviderResult =
  | { ok: true; view: LlmProviderView }
  | { ok: false; error: 'validation'; errors: string[] }
  | { ok: false; error: 'duplicate_name' }
  | { ok: false; error: 'encryption_unavailable' }

export async function createProvider(input: unknown, actorSub: string, isProd: boolean): Promise<CreateProviderResult> {
  const fields = validateProviderFields(input, isProd)
  if (!fields.ok) return { ok: false, error: 'validation', errors: fields.errors }

  const b = input as Record<string, unknown>
  const apiKeyPlain = typeof b.apiKey === 'string' ? b.apiKey.trim() : ''
  if (!apiKeyPlain) return { ok: false, error: 'validation', errors: ['apiKey is required'] }
  if (!isEncryptionAvailable()) return { ok: false, error: 'encryption_unavailable' }

  const db = requireDb()
  const now = new Date()
  const doc: LlmProviderDoc = {
    _id: new ObjectId(),
    ...fields.value,
    apiKey: encryptSecret(apiKeyPlain),
    createdAt: now,
    updatedAt: now,
    updatedBy: actorSub,
  }
  try {
    await providersCol(db).insertOne(doc)
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { ok: false, error: 'duplicate_name' }
    throw err
  }
  await touchConfigVersion(db, actorSub)
  return { ok: true, view: maskProvider(doc) }
}

export type UpdateProviderResult =
  | { ok: true; view: LlmProviderView }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'validation'; errors: string[] }
  | { ok: false; error: 'duplicate_name' }
  | { ok: false; error: 'encryption_unavailable' }

export async function updateProvider(
  id: string,
  input: unknown,
  actorSub: string,
  isProd: boolean
): Promise<UpdateProviderResult> {
  if (!ObjectId.isValid(id)) return { ok: false, error: 'not_found' }
  const db = requireDb()
  const _id = new ObjectId(id)
  const existing = await providersCol(db).findOne({ _id })
  if (!existing) return { ok: false, error: 'not_found' }

  const fields = validateProviderFields(input, isProd)
  if (!fields.ok) return { ok: false, error: 'validation', errors: fields.errors }

  const b = input as Record<string, unknown>
  const rawApiKey = b.apiKey === null ? null : typeof b.apiKey === 'string' ? b.apiKey : undefined
  const decision = resolveApiKeyForUpdate(rawApiKey)
  if ('error' in decision) return { ok: false, error: 'validation', errors: [decision.error] }
  if (!decision.keep && !isEncryptionAvailable()) return { ok: false, error: 'encryption_unavailable' }
  const apiKey = decision.keep ? existing.apiKey : encryptSecret(decision.plaintext)

  const update: Partial<LlmProviderDoc> = {
    ...fields.value,
    apiKey,
    updatedAt: new Date(),
    updatedBy: actorSub,
  }
  try {
    await providersCol(db).updateOne({ _id }, { $set: update })
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { ok: false, error: 'duplicate_name' }
    throw err
  }
  await touchConfigVersion(db, actorSub)
  const updated = await providersCol(db).findOne({ _id })
  return { ok: true, view: maskProvider(updated as LlmProviderDoc) }
}

export type DeleteProviderResult = 'deleted' | 'not_found' | 'active'

export async function deleteProvider(id: string): Promise<DeleteProviderResult> {
  if (!ObjectId.isValid(id)) return 'not_found'
  const db = requireDb()
  const _id = new ObjectId(id)
  const settings = await settingsCol(db).findOne({ _id: 'llm' })
  if (settings?.activeProviderId && settings.activeProviderId.equals(_id)) return 'active'
  const result = await providersCol(db).deleteOne({ _id })
  return result.deletedCount === 0 ? 'not_found' : 'deleted'
}

export async function recordLastTest(id: string, result: LlmProviderLastTest): Promise<void> {
  if (!ObjectId.isValid(id)) return
  const db = requireDb()
  await providersCol(db).updateOne({ _id: new ObjectId(id) }, { $set: { lastTest: result } })
}

export async function getSettings(): Promise<LlmSettingsDoc | null> {
  const db = requireDb()
  return settingsCol(db).findOne({ _id: 'llm' })
}

export type SetActiveResult =
  | { ok: true; settings: LlmSettingsDoc }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'disabled' }
  | { ok: false; error: 'unknown_model' }
  | { ok: false; error: 'secondary_equals_primary' }

/** Resolves and validates a (providerId, modelId) target against the
 *  providers collection. Returns the ObjectId + verified modelId, or an
 *  error code. Shared between primary and secondary validation. */
async function resolveTarget(
  db: Db,
  providerId: string,
  modelId: string | undefined
): Promise<{ ok: true; objectId: ObjectId; modelId: string | undefined } | { ok: false; error: 'not_found' | 'disabled' | 'unknown_model' }> {
  if (!ObjectId.isValid(providerId)) return { ok: false, error: 'not_found' }
  const objectId = new ObjectId(providerId)
  const doc = await providersCol(db).findOne({ _id: objectId })
  if (!doc) return { ok: false, error: 'not_found' }
  if (!doc.enabled) return { ok: false, error: 'disabled' }
  if (modelId && !doc.models.some((m) => m.id === modelId)) return { ok: false, error: 'unknown_model' }
  return { ok: true, objectId, modelId }
}

/**
 * Sets the active primary provider (and optional secondary for fusion mode).
 * - `primaryId === null` disables the LLM tier entirely and clears any
 *   secondary (fusion requires a primary).
 * - `secondary` omitted/undefined leaves any existing secondary untouched
 *   (so a primary-only "Switch" doesn't silently unconfigure fusion).
 * - `secondary === null` explicitly clears fusion mode.
 */
export async function setActive(
  primaryId: string | null,
  primaryModelId: string | undefined,
  actorSub: string,
  secondary?: { providerId: string | null; modelId?: string } | null
): Promise<SetActiveResult> {
  const db = requireDb()

  // --- primary ---
  let primaryObjectId: ObjectId | null = null
  if (primaryId !== null) {
    const r = await resolveTarget(db, primaryId, primaryModelId)
    if (!r.ok) return r
    primaryObjectId = r.objectId
  }

  // --- secondary (fusion) ---
  let secondaryObjectId: ObjectId | null = null
  let secondaryModelId: string | null = null
  if (primaryObjectId === null) {
    // Disabling the primary also clears the secondary — fusion without a
    // primary is meaningless.
    secondaryObjectId = null
    secondaryModelId = null
  } else if (secondary === undefined) {
    // Preserve existing secondary (if any). Only set the $set fields below
    // when secondary is explicitly provided.
  } else if (secondary === null || secondary.providerId === null) {
    secondaryObjectId = null
    secondaryModelId = null
  } else {
    const r = await resolveTarget(db, secondary.providerId, secondary.modelId)
    if (!r.ok) return r
    // Same provider+model as the primary is wasteful (two identical calls).
    // Same provider with a DIFFERENT model is a legitimate fusion (e.g. two
    // OpenRouter models), so only reject an exact match.
    if (r.objectId.equals(primaryObjectId!) && (r.modelId ?? null) === (primaryModelId ?? null)) {
      return { ok: false, error: 'secondary_equals_primary' }
    }
    secondaryObjectId = r.objectId
    secondaryModelId = r.modelId ?? null
  }

  const $set: Record<string, unknown> = {
    activeProviderId: primaryObjectId,
    activeModelId: primaryModelId ?? null,
    updatedAt: new Date(),
    updatedBy: actorSub,
  }
  // Only touch the secondary fields when the caller expressed an opinion
  // about fusion — keeps a primary-only switch from wiping a configured pair.
  if (secondary !== undefined) {
    $set.secondaryProviderId = secondaryObjectId
    $set.secondaryModelId = secondaryModelId
  }

  await settingsCol(db).updateOne(
    { _id: 'llm' },
    {
      $inc: { configVersion: 1 },
      $set,
    },
    { upsert: true }
  )
  const settings = await settingsCol(db).findOne({ _id: 'llm' })
  return { ok: true, settings: settings as LlmSettingsDoc }
}
