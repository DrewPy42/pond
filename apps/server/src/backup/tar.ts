/**
 * The small part of `tar` that Pond needs (docs/backup-design.md, "The archive"): ordinary files
 * in the POSIX "ustar" layout, which the standard `tar` command unpacks. The reader is strict on
 * purpose. Links, folders, extended headers, bad checksums and trailing data are all refused, and
 * the caller decides which names are allowed.
 */
import { BackupError } from './errors.js'

const BLOCK = 512
const MAX_SIZE = 0o77777777777 // 11 octal digits: just under 8 GiB

export interface TarInput {
  name: string
  size: number
  data: () => AsyncIterable<Uint8Array>
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK

/** ustar keeps long paths in two parts: `prefix` (155 bytes) and `name` (100), split at a "/". */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`Path is too long for a tar archive: ${path}`)
}

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, '0')}\0`

const checksum = (header: Buffer): number => {
  let sum = 0
  // The checksum field itself counts as spaces.
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
  return sum
}

export function tarHeader(path: string, size: number, mtimeSeconds: number): Buffer {
  if (!Number.isInteger(size) || size < 0 || size > MAX_SIZE)
    throw new Error(`File is too large for a tar archive: ${path}`)
  const h = Buffer.alloc(BLOCK)
  const { name, prefix } = splitName(path)
  h.write(name, 0, 100)
  h.write(octal(0o600, 8), 100)
  h.write(octal(0, 8), 108)
  h.write(octal(0, 8), 116)
  h.write(octal(size, 12), 124)
  h.write(octal(mtimeSeconds, 12), 136)
  h.write('0', 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  h.write(prefix, 345, 155)
  h.write(`${checksum(h).toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

/** The archive as a stream of chunks. Fails if a file's data doesn't match its declared size. */
export async function* writeTar(
  files: Iterable<TarInput>,
  mtimeSeconds: number,
): AsyncGenerator<Uint8Array> {
  for (const f of files) {
    yield tarHeader(f.name, f.size, mtimeSeconds)
    let written = 0
    for await (const chunk of f.data()) {
      written += chunk.length
      if (written > f.size) break
      yield chunk
    }
    if (written !== f.size) throw new Error(`File changed while it was being read: ${f.name}`)
    if (padding(f.size)) yield Buffer.alloc(padding(f.size))
  }
  yield Buffer.alloc(BLOCK * 2) // end of archive
}

const damaged = (why: string) => new BackupError('damaged_backup', why)

/** Reads exact byte counts from a stream of arbitrary chunks. */
class ByteReader {
  private iterator: AsyncIterator<Uint8Array>
  private rest: Buffer = Buffer.alloc(0)

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  /** Up to `max` bytes, or null at the end of the stream. */
  async some(max: number): Promise<Buffer | null> {
    while (this.rest.length === 0) {
      const next = await this.iterator.next()
      if (next.done) return null
      this.rest = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
    }
    const out = this.rest.subarray(0, max)
    this.rest = this.rest.subarray(out.length)
    return out
  }

  async *exactly(count: number): AsyncGenerator<Buffer> {
    let left = count
    while (left > 0) {
      const chunk = await this.some(left)
      if (!chunk) throw damaged('The backup ends too soon.')
      left -= chunk.length
      yield chunk
    }
  }

  async block(): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const p of this.exactly(BLOCK)) parts.push(Buffer.from(p))
    return Buffer.concat(parts)
  }
}

const text = (h: Buffer, start: number, length: number): string => {
  const field = h.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? length : end).toString('utf8')
}
const number = (h: Buffer, start: number, length: number): number => {
  const s = text(h, start, length).trim()
  if (!/^[0-7]+$/.test(s)) throw damaged('The archive has a damaged entry.')
  return parseInt(s, 8)
}
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0)

/**
 * Calls `onFile` for each file in order. `onFile` must consume `data` completely before it
 * returns; whatever it throws stops the read.
 */
export async function readTar(
  source: AsyncIterable<Uint8Array>,
  onFile: (name: string, size: number, data: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const reader = new ByteReader(source)
  for (;;) {
    const h = await reader.block()
    if (isZero(h)) {
      if (!isZero(await reader.block())) throw damaged('The archive does not end properly.')
      // Real tar pads the end with more zeros. Anything else hidden here is refused.
      for (let c = await reader.some(BLOCK); c; c = await reader.some(BLOCK))
        if (!isZero(c)) throw damaged('There is unexpected data after the end of the archive.')
      return
    }
    if (number(h, 148, 8) !== checksum(h)) throw damaged('The archive has a damaged entry.')
    if (h.subarray(257, 263).toString('latin1') !== 'ustar\0')
      throw damaged('The archive is not in the expected format.')
    const type = String.fromCharCode(h[156]!)
    if ((type !== '0' && type !== '\0') || text(h, 157, 100) !== '')
      throw damaged('The archive holds something other than ordinary files.')
    const prefix = text(h, 345, 155)
    const name = prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100)
    const size = number(h, 124, 12)
    let taken = 0
    await onFile(
      name,
      size,
      (async function* () {
        for await (const chunk of reader.exactly(size)) {
          taken += chunk.length
          yield chunk
        }
      })(),
    )
    if (taken !== size) throw new Error(`Archive entry was not fully read: ${name}`)
    for await (const _ of reader.exactly(padding(size))) void _
  }
}
