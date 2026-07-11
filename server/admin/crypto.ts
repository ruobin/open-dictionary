import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { CONFIG_ENCRYPTION_KEY, CONFIG_ENCRYPTION_KEY_PREVIOUS } from '../config'

/**
 * AES-256-GCM encryption for LLM provider API keys at rest (design doc §5.1).
 * A Mongo dump (e.g. the nightly backup archive, scripts/mongodb-backup.sh)
 * must not by itself leak keys — decrypting requires the master key, which
 * lives only in server/.env, never in the database.
 */
export interface EncryptedSecret {
  v: 1
  alg: 'aes-256-gcm'
  iv: string
  ct: string
  tag: string
  keyVersion: number
  last4: string
}

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32

export class ConfigEncryptionUnavailableError extends Error {
  constructor() {
    super('CONFIG_ENCRYPTION_KEY is not set — cannot encrypt/decrypt provider API keys')
    this.name = 'ConfigEncryptionUnavailableError'
  }
}

function loadKey(base64: string, label: string): Buffer {
  let key: Buffer
  try {
    key = Buffer.from(base64, 'base64')
  } catch {
    throw new Error(`${label} is not valid base64`)
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${label} must decode to ${KEY_LENGTH} bytes (got ${key.length})`)
  }
  return key
}

/** Current (keyVersion 1) master key, or null if unset. */
function currentKey(): Buffer | null {
  return CONFIG_ENCRYPTION_KEY ? loadKey(CONFIG_ENCRYPTION_KEY, 'CONFIG_ENCRYPTION_KEY') : null
}

/** Decrypt-only previous-generation key, honored during rotation. */
function previousKey(): Buffer | null {
  return CONFIG_ENCRYPTION_KEY_PREVIOUS
    ? loadKey(CONFIG_ENCRYPTION_KEY_PREVIOUS, 'CONFIG_ENCRYPTION_KEY_PREVIOUS')
    : null
}

export function isEncryptionAvailable(): boolean {
  return Boolean(CONFIG_ENCRYPTION_KEY)
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = currentKey()
  if (!key) throw new ConfigEncryptionUnavailableError()

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
    keyVersion: 1,
    last4: plaintext.slice(-4),
  }
}

/**
 * Tries the current key first, then the previous key (rotation window). GCM's
 * auth tag makes a wrong key or tampered ciphertext throw rather than return
 * garbage.
 */
export function decryptSecret(secret: EncryptedSecret): string {
  const candidates = [currentKey(), previousKey()].filter((k): k is Buffer => k !== null)
  if (candidates.length === 0) throw new ConfigEncryptionUnavailableError()

  let lastErr: unknown
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(secret.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
      const pt = Buffer.concat([decipher.update(Buffer.from(secret.ct, 'base64')), decipher.final()])
      return pt.toString('utf8')
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`Failed to decrypt secret: ${(lastErr as Error)?.message ?? lastErr}`)
}

/** Masked, safe-to-return-to-the-client view of a stored secret. */
export interface MaskedSecret {
  set: true
  last4: string
}

export function maskSecret(secret: EncryptedSecret): MaskedSecret {
  return { set: true, last4: secret.last4 }
}

/**
 * Truncates a vendor error body before it is logged or persisted. Some
 * vendors' 401 responses quote the bad Authorization header back — this
 * bounds exposure even in error paths (design doc §5.3).
 */
export function redactVendorErrorBody(body: string, maxLength = 200): string {
  return body.slice(0, maxLength)
}
