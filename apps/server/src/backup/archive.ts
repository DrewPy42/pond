/**
 * A backup file: a tar archive inside standard age passphrase encryption, so the ordinary `age`
 * and `tar` commands can open it without Pond.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebStream } from 'node:stream/web'
import { Decrypter, Encrypter } from 'age-encryption'
import { BackupError, isNoSpace } from './errors.js'
import {
  FORMAT_VERSION,
  MANIFEST_PATH,
  MAX_MANIFEST_BYTES,
  manifestSchema,
  type Manifest,
  type ManifestEntry,
} from './manifest.js'
import { readTar, writeTar, type TarInput } from './tar.js'

/**
 * How hard passphrase guessing is made (2^18, age's own default: about 256 MB of memory while a
 * backup is made or opened). To be confirmed by timing it on a Raspberry Pi.
 */
export const DEFAULT_WORK_FACTOR = 18
/** A crafted file could ask for gigabytes of memory; refuse anything beyond this. */
const MAX_WORK_FACTOR = 20

export async function sha256File(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of fs.createReadStream(path)) {
    size += (chunk as Buffer).length
    hash.update(chunk as Buffer)
  }
  return { size, sha256: hash.digest('hex') }
}

/** Writes an encrypted archive: the manifest first, then every entry it lists. */
export async function writeArchive(o: {
  target: string
  passphrase: string
  workFactor: number
  manifest: Manifest
  /** Where each manifest entry's bytes come from. */
  sourceOf: (entry: ManifestEntry) => string
}): Promise<void> {
  const manifestBytes = Buffer.from(JSON.stringify(o.manifest, null, 2))
  const inputs: TarInput[] = [
    {
      name: MANIFEST_PATH,
      size: manifestBytes.length,
      data: async function* () {
        yield manifestBytes
      },
    },
    ...o.manifest.entries.map((e) => ({
      name: e.path,
      size: e.size,
      data: () => fs.createReadStream(o.sourceOf(e)) as AsyncIterable<Buffer>,
    })),
  ]
  const encrypter = new Encrypter()
  encrypter.setScryptWorkFactor(o.workFactor)
  encrypter.setPassphrase(o.passphrase)
  const plain = Readable.toWeb(
    Readable.from(writeTar(inputs, Math.floor(Date.parse(o.manifest.createdAt) / 1000)), {
      objectMode: false,
    }),
  )
  const encrypted = await encrypter.encrypt(plain as unknown as ReadableStream<Uint8Array>)
  await pipeline(
    Readable.fromWeb(encrypted as unknown as WebStream),
    fs.createWriteStream(o.target, { flags: 'wx', mode: 0o600, flush: true }),
  )
}

/** Checks the unencrypted header before any expensive or memory-hungry work. */
async function checkHeader(path: string, maxWorkFactor: number): Promise<void> {
  const handle = await fsp.open(path, 'r')
  try {
    const buffer = Buffer.alloc(256)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const [magic, stanza = ''] = buffer.subarray(0, bytesRead).toString('latin1').split('\n')
    const m = /^-> scrypt \S+ (\d{1,2})$/.exec(stanza)
    if (magic !== 'age-encryption.org/v1' || !m)
      throw new BackupError('not_a_backup', 'This is not a Pond backup file.')
    // The library refuses a header with a second passphrase entry before doing any work, so
    // the first one is the one that counts.
    if (Number(m[1]) > Math.min(maxWorkFactor, MAX_WORK_FACTOR))
      throw new BackupError('not_a_backup', 'This file asks for more memory than Pond will use.')
  } finally {
    await handle.close()
  }
}

async function openPlaintext(
  path: string,
  passphrase: string,
  maxWorkFactor: number,
): Promise<AsyncIterable<Uint8Array>> {
  await checkHeader(path, maxWorkFactor)
  const decrypter = new Decrypter()
  decrypter.addPassphrase(passphrase)
  const source = Readable.toWeb(fs.createReadStream(path)) as unknown as ReadableStream<Uint8Array>
  let plain: ReadableStream<Uint8Array>
  try {
    plain = await decrypter.decrypt(source)
  } catch (e) {
    if (/no identity matched/i.test((e as Error).message))
      throw new BackupError('wrong_passphrase', 'That passphrase does not open this backup.')
    throw new BackupError('damaged_backup', 'The backup file is damaged.')
  }
  return (async function* () {
    try {
      yield* plain as unknown as AsyncIterable<Uint8Array>
    } catch {
      // age notices any altered or missing piece.
      throw new BackupError('damaged_backup', 'The backup file is damaged or incomplete.')
    }
  })()
}

/** Where verified bytes go. Returning null checks an entry without keeping it. */
export type EntrySink = (entry: ManifestEntry) => Promise<fsp.FileHandle | null>

/**
 * Decrypts and verifies a whole backup. Only the paths the manifest lists are accepted, each
 * exactly once, with exactly the size and checksum it states. `onManifest` runs before anything
 * else is read, so the caller can refuse early.
 */
export async function readArchive(o: {
  source: string
  passphrase: string
  /** The most scrypt work (and so memory) the file may ask for. Never above Pond's own cap. */
  maxWorkFactor?: number
  onManifest?: (manifest: Manifest) => Promise<void> | void
  sink?: EntrySink
}): Promise<Manifest> {
  const plain = await openPlaintext(o.source, o.passphrase, o.maxWorkFactor ?? MAX_WORK_FACTOR)
  let manifest: Manifest | null = null
  const waiting = new Map<string, ManifestEntry>()
  await readTar(plain, async (name, size, data) => {
    if (!manifest) {
      if (name !== MANIFEST_PATH || size > MAX_MANIFEST_BYTES)
        throw new BackupError('not_a_backup', 'This is not a Pond backup file.')
      const parts: Buffer[] = []
      for await (const chunk of data) parts.push(Buffer.from(chunk))
      manifest = parseManifest(Buffer.concat(parts))
      for (const e of manifest.entries) waiting.set(e.path, e)
      await o.onManifest?.(manifest)
      return
    }
    const entry = waiting.get(name)
    if (!entry || entry.size !== size)
      throw new BackupError('damaged_backup', 'The backup holds something its list does not.')
    waiting.delete(name)
    const hash = createHash('sha256')
    const out = (await o.sink?.(entry)) ?? null
    try {
      for await (const chunk of data) {
        hash.update(chunk)
        if (out) await out.writeFile(chunk)
      }
    } catch (e) {
      if (isNoSpace(e)) throw new BackupError('not_enough_space')
      throw e
    } finally {
      await out?.close()
    }
    if (hash.digest('hex') !== entry.sha256)
      throw new BackupError('damaged_backup', 'A file in the backup does not match its checksum.')
  })
  if (!manifest || waiting.size > 0)
    throw new BackupError('damaged_backup', 'Something is missing from the backup.')
  return manifest
}

function parseManifest(bytes: Buffer): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new BackupError('damaged_backup', "The backup's list of contents is damaged.")
  }
  const format = (raw as { app?: unknown; format?: unknown } | null)?.format
  if (typeof format === 'number' && format > FORMAT_VERSION)
    throw new BackupError(
      'newer_backup',
      'This backup was made by a newer Pond. Update Pond first.',
    )
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success)
    throw new BackupError('damaged_backup', "The backup's list of contents is not valid.")
  return parsed.data
}
