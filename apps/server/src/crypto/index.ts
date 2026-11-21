import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Field encryption for secrets at rest (security.md): AES-256-GCM, random 96-bit nonce per
 * value, stored as `v1:<nonce>:<ciphertext+tag>` (base64url). The version prefix allows key
 * rotation later. Passphrase-wrapped master key is a later feature.
 */
const VERSION = 'v1'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class CryptoError extends Error {}

export interface Crypto {
  encrypt(plaintext: string): string
  decrypt(stored: string): string
  isEncrypted(value: string): boolean
}

/** Load the master key, creating it (mode 0600, directory 0700) on first run. */
export function loadOrCreateMasterKey(keyPath: string): Buffer {
  if (fs.existsSync(keyPath)) {
    const mode = fs.statSync(keyPath).mode & 0o077
    if (mode !== 0) fs.chmodSync(keyPath, 0o600)
    const key = fs.readFileSync(keyPath)
    if (key.length !== KEY_BYTES) {
      throw new CryptoError(`Master key at ${keyPath} must be exactly ${KEY_BYTES} bytes`)
    }
    return key
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 })
  const key = randomBytes(KEY_BYTES)
  // 'wx' refuses to overwrite: never silently replace a key that guards existing data.
  fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' })
  return key
}

export function createCrypto(masterKey: Buffer): Crypto {
  if (masterKey.length !== KEY_BYTES) throw new CryptoError('Master key must be 32 bytes')
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
      const ct = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ])
      return `${VERSION}:${nonce.toString('base64url')}:${ct.toString('base64url')}`
    },
    decrypt(stored) {
      const [version, nonceB64, ctB64, ...rest] = stored.split(':')
      if (version !== VERSION || !nonceB64 || !ctB64 || rest.length > 0) {
        throw new CryptoError('Unrecognized encrypted value format')
      }
      const nonce = Buffer.from(nonceB64, 'base64url')
      const ct = Buffer.from(ctB64, 'base64url')
      if (nonce.length !== NONCE_BYTES || ct.length < TAG_BYTES) {
        throw new CryptoError('Malformed encrypted value')
      }
      const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
      decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES))
      try {
        return Buffer.concat([
          decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // Deliberately vague: never echo ciphertext or key material.
        throw new CryptoError('Decryption failed (wrong key or tampered value)')
      }
    },
    isEncrypted: (value) => value.startsWith(`${VERSION}:`),
  }
}
