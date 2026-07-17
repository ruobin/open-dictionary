import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY_A = Buffer.alloc(32, 7).toString('base64')
const KEY_B = Buffer.alloc(32, 9).toString('base64')

async function freshCrypto() {
  vi.resetModules()
  // `../config` runs dotenv at module-load and re-populates env vars from
  // server/.env on every fresh import — which would mask the "no key
  // configured" cases below whenever a real key is present in the dev
  // environment. Stub it with lazy getters so the tests' process.env
  // manipulation takes effect at call time instead of import time.
  vi.doMock('../config', () => ({
    get CONFIG_ENCRYPTION_KEY(): string | undefined {
      return process.env.CONFIG_ENCRYPTION_KEY?.trim() || undefined
    },
    get CONFIG_ENCRYPTION_KEY_PREVIOUS(): string | undefined {
      return process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS?.trim() || undefined
    },
  }))
  return import('./crypto')
}

describe('admin/crypto', () => {
  afterEach(() => {
    delete process.env.CONFIG_ENCRYPTION_KEY
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS
  })

  it('round-trips a secret and captures last4', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const { encryptSecret, decryptSecret } = await freshCrypto()
    const secret = encryptSecret('sk-test-1234567890')
    expect(secret.last4).toBe('7890')
    expect(secret.alg).toBe('aes-256-gcm')
    expect(decryptSecret(secret)).toBe('sk-test-1234567890')
  })

  it('produces a different iv/ciphertext each time (no nonce reuse)', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const { encryptSecret } = await freshCrypto()
    const a = encryptSecret('same-plaintext')
    const b = encryptSecret('same-plaintext')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('throws when the ciphertext is tampered with', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const { encryptSecret, decryptSecret } = await freshCrypto()
    const secret = encryptSecret('sk-test-1234567890')
    const tampered = { ...secret, ct: Buffer.from('tampered-ciphertext-bytes!').toString('base64') }
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('throws when decrypting with the wrong key and no previous key set', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const { encryptSecret } = await freshCrypto()
    const secret = encryptSecret('sk-test-1234567890')

    process.env.CONFIG_ENCRYPTION_KEY = KEY_B
    const { decryptSecret } = await freshCrypto()
    expect(() => decryptSecret(secret)).toThrow()
  })

  it('decrypts old secrets via CONFIG_ENCRYPTION_KEY_PREVIOUS during rotation', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const { encryptSecret } = await freshCrypto()
    const secret = encryptSecret('sk-test-1234567890')

    // Rotate: new key becomes current, old key becomes the decrypt-only fallback.
    process.env.CONFIG_ENCRYPTION_KEY = KEY_B
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = KEY_A
    const { decryptSecret, encryptSecret: encryptWithNewKey } = await freshCrypto()
    expect(decryptSecret(secret)).toBe('sk-test-1234567890')

    // New writes use the new key, independent of the old one.
    const reEncrypted = encryptWithNewKey('sk-test-1234567890')
    expect(reEncrypted.ct).not.toBe(secret.ct)
  })

  it('throws ConfigEncryptionUnavailableError when no key is configured', async () => {
    const { encryptSecret, ConfigEncryptionUnavailableError } = await freshCrypto()
    expect(() => encryptSecret('x')).toThrow(ConfigEncryptionUnavailableError)
  })

  it('reports availability via isEncryptionAvailable', async () => {
    const unset = await freshCrypto()
    expect(unset.isEncryptionAvailable()).toBe(false)

    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const set = await freshCrypto()
    expect(set.isEncryptionAvailable()).toBe(true)
  })

  it('masks a secret to {set, last4} only — no key material', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_A
    const { encryptSecret, maskSecret } = await freshCrypto()
    const secret = encryptSecret('sk-test-1234567890')
    const masked = maskSecret(secret)
    expect(masked).toEqual({ set: true, last4: '7890' })
    expect(JSON.stringify(masked)).not.toContain(secret.ct)
  })

  it('redactVendorErrorBody truncates to the given length', async () => {
    const { redactVendorErrorBody } = await freshCrypto()
    const long = 'a'.repeat(500)
    expect(redactVendorErrorBody(long, 200)).toHaveLength(200)
    expect(redactVendorErrorBody('short')).toBe('short')
  })
})
