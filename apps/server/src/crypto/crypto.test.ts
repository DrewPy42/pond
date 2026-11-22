import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CryptoError, createCrypto, loadOrCreateMasterKey } from './index'

// createCrypto(masterKey) encrypts secrets at rest with AES-256-GCM (docs/security.md).
describe('createCrypto(masterKey): encrypt(plaintext) / decrypt(stored)', () => {
  const c = createCrypto(randomBytes(32))

  /**
   * Function: encrypt(plaintext), decrypt(stored)
   * Inputs:   a sample SimpleFIN-style access URL
   * Expected: the stored value starts with "v1:" and decrypts back to the exact input
   */
  it('round-trips', () => {
    const v = c.encrypt('https://user:pass@bridge.simplefin.org/simplefin')
    expect(v.startsWith('v1:')).toBe(true)
    expect(c.decrypt(v)).toBe('https://user:pass@bridge.simplefin.org/simplefin')
  })
  /**
   * Function: encrypt(plaintext)
   * Inputs:   the same text "x" encrypted twice
   * Expected: two different stored values (a new random nonce each time)
   */
  it('uses a fresh nonce each time', () => {
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'))
  })
  /**
   * Function: encrypt(plaintext)
   * Inputs:   an SSN-like string "123-45-6789"
   * Expected: the stored value does not contain it
   */
  it('never contains the plaintext', () => {
    expect(c.encrypt('123-45-6789')).not.toContain('123-45-6789')
  })
  /**
   * Function: encrypt / decrypt
   * Inputs:   "" and "päss 🐸"
   * Expected: both round-trip exactly
   */
  it('handles empty and unicode strings', () => {
    expect(c.decrypt(c.encrypt(''))).toBe('')
    expect(c.decrypt(c.encrypt('päss 🐸'))).toBe('päss 🐸')
  })
  /**
   * Function: decrypt(stored)
   * Inputs:   a valid stored value with its first ciphertext character changed
   * Expected: throws CryptoError (GCM authentication fails)
   */
  it('rejects tampering', () => {
    const [v, n, ct] = c.encrypt('secret').split(':') as [string, string, string]
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)
    expect(() => c.decrypt(`${v}:${n}:${flipped}`)).toThrow(CryptoError)
  })
  /**
   * Function: decrypt(stored)
   * Inputs:   a value encrypted with one key, decrypted with another key
   * Expected: throws CryptoError
   */
  it('rejects the wrong key', () => {
    const other = createCrypto(randomBytes(32))
    expect(() => other.decrypt(c.encrypt('secret'))).toThrow(CryptoError)
  })
  /**
   * Function: decrypt(stored)
   * Inputs:   "plain" and "v2:a:b" (unknown version)
   * Expected: throws CryptoError for both
   */
  it('rejects bad formats', () => {
    expect(() => c.decrypt('plain')).toThrow(CryptoError)
    expect(() => c.decrypt('v2:a:b')).toThrow(CryptoError)
  })
  /**
   * Function: loadOrCreateMasterKey(keyPath)
   * Inputs:   a temp folder with no key file, called twice
   * Expected: creates a 32-byte key with file mode 0600 the first time and returns the same key
   *           the second time (uses a real temp file, which is the point of this test)
   */
  it('creates the master key once with mode 0600 and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-key-'))
    const keyPath = path.join(dir, 'keys', 'master.key')
    const k1 = loadOrCreateMasterKey(keyPath)
    expect(k1.length).toBe(32)
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(loadOrCreateMasterKey(keyPath).equals(k1)).toBe(true)
    fs.rmSync(dir, { recursive: true })
  })
  /**
   * Function: loadOrCreateMasterKey(keyPath)
   * Inputs:   an existing key file containing only 5 bytes
   * Expected: throws CryptoError and leaves the file alone (never silently replaces a key that
   *           may guard existing data)
   */
  it('refuses a corrupt master key rather than replacing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-key-'))
    const keyPath = path.join(dir, 'master.key')
    fs.writeFileSync(keyPath, 'short', { mode: 0o600 })
    expect(() => loadOrCreateMasterKey(keyPath)).toThrow(CryptoError)
    fs.rmSync(dir, { recursive: true })
  })
})
