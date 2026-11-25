/** `manifest.json`: the first entry of every backup, describing all the others. */
import { z } from 'zod'

export const FORMAT_VERSION = 1
export const MANIFEST_PATH = 'manifest.json'
export const DB_PATH = 'pond.db'
export const KEY_PATH = 'keys/master.key'
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

/** The same shapes the file store accepts. None allows a dot, so ".." can't be written. */
const FILE_ENTRY =
  /^files\/[a-z][a-z0-9-]{1,29}\/[A-Za-z0-9][A-Za-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

export const isFileEntry = (path: string): boolean => FILE_ENTRY.test(path)

/** The only paths a Pond backup may contain, besides the manifest itself. */
export const isContentPath = (path: string): boolean =>
  path === DB_PATH || path === KEY_PATH || isFileEntry(path)

const count = z.number().int().nonnegative()

export const manifestSchema = z
  .object({
    app: z.literal('pond'),
    format: z.number().int().positive(),
    pondVersion: z.string().max(40),
    schemaVersion: count,
    /** Each LilyPad's applied migrations. */
    lilypads: z.record(z.string().max(40), z.array(z.string().max(200)).max(1000)),
    instanceId: z.string().max(64),
    createdAt: z.iso.datetime(),
    counts: z.record(z.string().max(128), count),
    entries: z
      .array(
        z.object({
          path: z.string().refine(isContentPath, 'unexpected path'),
          size: count,
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .max(200_000),
  })
  .refine((m) => new Set(m.entries.map((e) => e.path)).size === m.entries.length, 'repeated path')
  .refine((m) => m.entries.some((e) => e.path === DB_PATH), 'no database')
  .refine((m) => m.entries.some((e) => e.path === KEY_PATH && e.size === 32), 'no master key')

export type Manifest = z.infer<typeof manifestSchema>
export type ManifestEntry = Manifest['entries'][number]
