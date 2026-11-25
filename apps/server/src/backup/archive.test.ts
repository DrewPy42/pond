/** The backup file format: tar inside age passphrase encryption. Real files in a temp folder. */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Encrypter } from 'age-encryption'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_PASSPHRASE, makeBackup, tempDir } from '../testing/backupWorld.js'
import { readArchive } from './archive.js'
import { readTar, tarHeader, writeTar } from './tar.js'

let dir: string
beforeEach(async () => void (dir = await tempDir()))
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const FILE =
  'files/business/01890000-0000-7000-8000-000000000001/01890000-0000-7000-8000-000000000002'

const chunks = async function* (...parts: Uint8Array[]) {
  yield* parts
}
const collect = async (source: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = []
  for await (const p of source) parts.push(p)
  return Buffer.concat(parts)
}
const entriesOf = async (tar: Buffer) => {
  const out: Record<string, Buffer> = {}
  await readTar(chunks(tar), async (name, _size, data) => {
    out[name] = await collect(data)
  })
  return out
}
const makeTar = (files: Record<string, Buffer>) =>
  collect(
    writeTar(
      Object.entries(files).map(([name, bytes]) => ({
        name,
        size: bytes.length,
        data: () => chunks(bytes),
      })),
      0,
    ),
  )
const END = Buffer.alloc(1024)
/** A header with one field changed and the checksum made right again. */
const forged = (name: string, change: (h: Buffer) => void) => {
  const h = tarHeader(name, 0, 0)
  change(h)
  h.fill(32, 148, 156)
  const sum = h.reduce((a, b) => a + b, 0)
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

describe('writeTar(files) and readTar(source)', () => {
  /**
   * Inputs:   an empty file, a 513-byte file and a path longer than 100 characters
   * Expected: reading gives the same names and bytes, and the system `tar` command unpacks them,
   *           so a backup can be opened without Pond
   */
  it('round-trips, and the standard tar command can unpack the result', async () => {
    const files = { 'a.txt': Buffer.alloc(0), 'keys/b': randomBytes(513), [FILE]: randomBytes(9) }
    const tar = await makeTar(files)
    expect(await entriesOf(tar)).toEqual(files)

    await fs.writeFile(path.join(dir, 'x.tar'), tar)
    await fs.mkdir(path.join(dir, 'out'))
    execFileSync('tar', ['-xf', path.join(dir, 'x.tar'), '-C', path.join(dir, 'out')])
    for (const [name, bytes] of Object.entries(files))
      expect(await fs.readFile(path.join(dir, 'out', name))).toEqual(bytes)
  })

  /**
   * Inputs:   archives holding a symbolic link, a hard link, a folder, an extended header, a
   *           wrong checksum, a cut-off end, and hidden data after the end
   * Expected: each is refused as damaged
   */
  it('refuses anything that is not a plain, complete archive of ordinary files', async () => {
    const good = await makeTar({ a: Buffer.from('hello') })
    const link = (type: string) =>
      Buffer.concat([forged('l', (h) => (h.write(type, 156), h.write('/etc/passwd', 157))), END])
    const bad: Record<string, Buffer> = {
      symlink: link('2'),
      hardlink: link('1'),
      folder: Buffer.concat([forged('d/', (h) => h.write('5', 156)), END]),
      extended: Buffer.concat([forged('p', (h) => h.write('x', 156)), END]),
      checksum: Buffer.from(good).fill('b', 0, 1),
      truncated: good.subarray(0, 700),
      trailing: Buffer.concat([good, Buffer.from('surprise')]),
    }
    for (const [what, tar] of Object.entries(bad))
      await expect(entriesOf(tar), what).rejects.toMatchObject({ code: 'damaged_backup' })
  })
})

describe('readArchive({ source, passphrase })', () => {
  const write = async (bytes: Buffer) => {
    const file = path.join(dir, 'b.pond')
    await fs.writeFile(file, bytes)
    return file
  }
  const read = (source: string, passphrase = BACKUP_PASSPHRASE) =>
    readArchive({ source, passphrase })
  /** Any tar content, encrypted like a backup: how a hostile file would be made. */
  const encrypt = async (plain: Buffer) => {
    const e = new Encrypter()
    e.setScryptWorkFactor(10)
    e.setPassphrase(BACKUP_PASSPHRASE)
    return Buffer.from(await e.encrypt(plain))
  }

  /**
   * Inputs:   a backup of a database, a key and a 200,000-byte file (several encryption chunks)
   * Expected: it opens with the passphrase and lists those three entries
   */
  it('opens a complete backup', async () => {
    const source = await write(await makeBackup({ files: { [FILE]: randomBytes(200_000) } }))
    const manifest = await read(source)
    expect(manifest.entries.map((e) => e.path)).toEqual(['pond.db', 'keys/master.key', FILE])
  })

  /**
   * Inputs:   the wrong passphrase; the file cut short; one byte changed near the end; a text file
   * Expected: wrong_passphrase, damaged_backup, damaged_backup, not_a_backup
   */
  it('refuses a wrong passphrase and a truncated, altered or unrelated file', async () => {
    const bytes = await makeBackup({ files: { [FILE]: randomBytes(150_000) } })
    await expect(read(await write(bytes), 'not the passphrase')).rejects.toMatchObject({
      code: 'wrong_passphrase',
    })
    await expect(read(await write(bytes.subarray(0, bytes.length - 100)))).rejects.toMatchObject({
      code: 'damaged_backup',
    })
    const altered = Buffer.from(bytes)
    altered[altered.length - 50]! ^= 1
    await expect(read(await write(altered))).rejects.toMatchObject({ code: 'damaged_backup' })
    await expect(read(await write(Buffer.from('shopping list')))).rejects.toMatchObject({
      code: 'not_a_backup',
    })
  })

  /**
   * Inputs:   a file whose header asks for a work factor of 22 (about 4 GB of memory)
   * Expected: refused before any key is derived, so an upload can't exhaust a Pi
   */
  it('refuses a file that asks for too much memory', async () => {
    const bytes = await makeBackup()
    const hostile = Buffer.from(bytes.toString('latin1').replace(/ 10\n/, ' 22\n'), 'latin1')
    await expect(read(await write(hostile))).rejects.toMatchObject({ code: 'not_a_backup' })
  })

  /**
   * Inputs:   manifests listing "../escape", an absolute path, a path outside files/, a repeated
   *           path, and no master key; and a newer format number
   * Expected: all refused (the newer format with "newer_backup"), and nothing reaches the sink
   */
  it('accepts only the paths a Pond backup can contain', async () => {
    const entry = (p: string, size = 0) => ({ path: p, size, sha256: '0'.repeat(64) })
    const base = [entry('pond.db'), entry('keys/master.key', 32)]
    const manifestOnly = async (over: object) => {
      const text = Buffer.from(
        JSON.stringify({
          app: 'pond',
          format: 1,
          pondVersion: '0',
          schemaVersion: 6,
          lilypads: {},
          instanceId: 'a',
          createdAt: '2026-01-01T00:00:00.000Z',
          counts: {},
          entries: base,
          ...over,
        }),
      )
      return write(await encrypt(await makeTar({ 'manifest.json': text })))
    }
    let reached = 0
    const attempt = async (source: string) =>
      readArchive({
        source,
        passphrase: BACKUP_PASSPHRASE,
        sink: async () => (reached++, null),
      })
    for (const bad of ['../escape', '/etc/passwd', 'files/a/../../x', 'keys/other', 'pond.db-wal'])
      await expect(
        attempt(await manifestOnly({ entries: [...base, entry(bad)] })),
        bad,
      ).rejects.toMatchObject({ code: 'damaged_backup' })
    await expect(
      attempt(await manifestOnly({ entries: [...base, entry('pond.db')] })),
    ).rejects.toMatchObject({ code: 'damaged_backup' })
    await expect(
      attempt(await manifestOnly({ entries: [entry('pond.db')] })),
    ).rejects.toMatchObject({ code: 'damaged_backup' })
    await expect(attempt(await manifestOnly({ format: 2 }))).rejects.toMatchObject({
      code: 'newer_backup',
    })
    expect(reached).toBe(0)
  })

  /**
   * Inputs:   archives with an unlisted extra file, a listed file missing, and contents that don't
   *           match the listed checksum
   * Expected: each refused as damaged
   */
  it('requires exactly the listed entries with the listed contents', async () => {
    const good = await makeBackup()
    const source = await write(good)
    const out: Record<string, Buffer> = {}
    const { Decrypter } = await import('age-encryption')
    const d = new Decrypter()
    d.addPassphrase(BACKUP_PASSPHRASE)
    Object.assign(out, await entriesOf(Buffer.from(await d.decrypt(await fs.readFile(source)))))
    const variants: Record<string, Record<string, Buffer>> = {
      extra: { ...out, [FILE]: Buffer.from('x') },
      missing: { 'manifest.json': out['manifest.json']!, 'pond.db': out['pond.db']! },
      checksum: { ...out, 'keys/master.key': randomBytes(32) },
    }
    for (const [what, files] of Object.entries(variants))
      await expect(
        read(await write(await encrypt(await makeTar(files)))),
        what,
      ).rejects.toMatchObject({ code: 'damaged_backup' })
  })

  const has = (command: string) => spawnSync('which', [command]).status === 0

  /**
   * Inputs:   a Pond backup given to the real `age` command, typing the passphrase through
   *           `expect` (age only asks at the keyboard)
   * Expected: age decrypts it to a tar holding the manifest. Skipped where either isn't installed.
   */
  it.skipIf(!has('age') || !has('expect'))('opens with the real age command', async () => {
    const source = await write(await makeBackup())
    const plain = path.join(dir, 'plain.tar')
    execFileSync('expect', [
      '-c',
      `spawn age -d -o ${plain} ${source}; expect "passphrase"; send "${BACKUP_PASSPHRASE}\\r"; expect eof; catch wait result; exit [lindex $result 3]`,
    ])
    expect(Object.keys(await entriesOf(await fs.readFile(plain)))).toContain('manifest.json')
  })
})
