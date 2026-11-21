import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CryptoError, createCrypto, loadOrCreateMasterKey } from './index'

describe('crypto', () => {
  const c = createCrypto(randomBytes(32))

  it('round-trips', () => {
    const v = c.encrypt('https://user:pass@bridge.simplefin.org/simplefin')
    expect(v.startsWith('v1:')).toBe(true)
    expect(c.decrypt(v)).toBe('https://user:pass@bridge.simplefin.org/simplefin')
  })
  it('uses a fresh nonce each time', () => {
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'))
  })
  it('never contains the plaintext', () => {
    expect(c.encrypt('123-45-6789')).not.toContain('123-45-6789')
  })
  it('handles empty and unicode strings', () => {
    expect(c.decrypt(c.encrypt(''))).toBe('')
    expect(c.decrypt(c.encrypt('päss 🐸'))).toBe('päss 🐸')
  })
  it('rejects tampering', () => {
    const [v, n, ct] = c.encrypt('secret').split(':') as [string, string, string]
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)
    expect(() => c.decrypt(`${v}:${n}:${flipped}`)).toThrow(CryptoError)
  })
  it('rejects the wrong key', () => {
    const other = createCrypto(randomBytes(32))
    expect(() => other.decrypt(c.encrypt('secret'))).toThrow(CryptoError)
  })
  it('rejects bad formats', () => {
    expect(() => c.decrypt('plain')).toThrow(CryptoError)
    expect(() => c.decrypt('v2:a:b')).toThrow(CryptoError)
  })
  it('creates the master key once with mode 0600 and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-key-'))
    const keyPath = path.join(dir, 'keys', 'master.key')
    const k1 = loadOrCreateMasterKey(keyPath)
    expect(k1.length).toBe(32)
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(loadOrCreateMasterKey(keyPath).equals(k1)).toBe(true)
    fs.rmSync(dir, { recursive: true })
  })
  it('refuses a corrupt master key rather than replacing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-key-'))
    const keyPath = path.join(dir, 'master.key')
    fs.writeFileSync(keyPath, 'short', { mode: 0o600 })
    expect(() => loadOrCreateMasterKey(keyPath)).toThrow(CryptoError)
    fs.rmSync(dir, { recursive: true })
  })
})
