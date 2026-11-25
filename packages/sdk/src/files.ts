/**
 * Rules for pad files, shared by Pond's host and the SDK test host so they can't disagree.
 * A pad never handles raw bytes: the host receives, checks, stores and sends them.
 */

export const FILE_TYPES = ['pdf', 'jpeg', 'png'] as const
export type FileType = (typeof FILE_TYPES)[number]

/** The most any upload route may ask for. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const INFO: Record<FileType, { mime: string; extensions: string[]; magic: number[] }> = {
  pdf: { mime: 'application/pdf', extensions: ['pdf'], magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  jpeg: { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], magic: [0xff, 0xd8, 0xff] },
  png: {
    mime: 'image/png',
    extensions: ['png'],
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
}

export const mimeOf = (type: FileType): string => INFO[type].mime

/** What a file really is, from its first bytes. Its name and the browser's claim are ignored. */
export function detectFileType(bytes: Uint8Array): FileType | null {
  return (
    FILE_TYPES.find(
      (t) => bytes.length >= INFO[t].magic.length && INFO[t].magic.every((b, i) => bytes[i] === b),
    ) ?? null
  )
}

/**
 * A safe name to download a file as: no paths or control characters, a sensible length, and an
 * ending that matches what the file really is. (A PDF saved as "x.html" would otherwise be opened
 * as a web page on the person's computer.)
 */
export function safeDownloadName(name: string, type: FileType | null): string {
  let clean = [...name]
    .filter((c) => {
      const code = c.codePointAt(0)!
      // Control characters, and the invisible ones that can reverse how a name reads.
      return !(
        code < 32 ||
        (code >= 127 && code < 160) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      )
    })
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  clean = [...clean].slice(0, 150).join('')
  if (!clean) clean = 'file'
  if (!type) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 ? clean.slice(dot + 1).toLowerCase() : ''
  return INFO[type].extensions.includes(ext) ? clean : `${clean}.${INFO[type].extensions[0]}`
}

/** What a route's `upload` option allows. */
export interface UploadSpec {
  /** The largest file accepted, in bytes (at most `MAX_UPLOAD_BYTES`). */
  maxBytes: number
  types: FileType[]
}

/** The file an upload route received. It is already checked and stored; keep its `id`. */
export interface UploadedFile {
  id: string
  size: number
  type: FileType
}

/** What `req.files.download` returns. A route returns it, and the host sends the file. */
export interface PadDownload {
  $padDownload: { fileId: string; filename: string }
}
export const isPadDownload = (v: unknown): v is PadDownload =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as PadDownload).$padDownload?.fileId === 'string' &&
  typeof (v as PadDownload).$padDownload?.filename === 'string'

/** Throws if a route's `upload` option isn't one the host can honor. */
export function checkUploadSpec(spec: UploadSpec): void {
  if (!Number.isInteger(spec.maxBytes) || spec.maxBytes < 1 || spec.maxBytes > MAX_UPLOAD_BYTES)
    throw new Error(`upload.maxBytes must be 1 to ${MAX_UPLOAD_BYTES}`)
  if (!Array.isArray(spec.types) || spec.types.length === 0)
    throw new Error('upload.types must list at least one file type')
  for (const t of spec.types)
    if (!FILE_TYPES.includes(t)) throw new Error(`Unknown upload type "${String(t)}"`)
}
