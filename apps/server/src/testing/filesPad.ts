import {
  PadError,
  definePad,
  defineMigration,
  definePadModule,
  manifestSchema,
  z,
  type PadModule,
  type Permission,
  type PadDefinition,
} from '@pond/sdk'

/**
 * A test-only pad that uses the host's file and password re-check features, including ways a pad
 * might misuse them (naming a file it was never given, failing after an upload).
 */
export function makeFilesPad(
  o: { permissions?: Permission[]; register?: PadDefinition['register'] } = {},
): PadModule {
  const manifest = manifestSchema.parse({
    id: 'filer',
    name: 'Filer',
    version: '1.0.0',
    author: 'Tests',
    license: 'MIT',
    pondApi: '^1.1',
    spaceTypes: ['personal', 'business'],
    permissions: o.permissions ?? ['files:store'],
  })
  const server = definePad({
    register:
      o.register ??
      ((ctx) => {
        ctx.router.post(
          '/docs',
          {
            role: 'editor',
            query: z.object({ name: z.string().min(1).max(300), fail: z.string().optional() }),
            upload: { maxBytes: 1000, types: ['pdf', 'png'] },
          },
          async (req) => {
            if (req.query.fail === 'expected') throw new PadError(409, 'nope')
            if (req.query.fail === 'bug') throw new Error('pad bug')
            const row = await req.db.table('docs').insert({
              file_id: req.file!.id,
              name: req.query.name,
              size: req.file!.size,
              kind: req.file!.type,
            })
            return { id: row.id, fileId: req.file!.id, bodySeen: req.body !== undefined }
          },
        )
        // `as` lets a test ask for any file id, as a hostile or buggy pad might.
        ctx.router.get(
          '/docs/:id',
          { role: 'viewer', query: z.object({ as: z.string().optional() }) },
          async (req) => {
            const row = await req.db.table('docs').findOne({ id: req.params.id! })
            if (!row && !req.query.as) throw new PadError(404, 'not_found')
            return req.files.download(
              req.query.as ?? (row!.file_id as string),
              (row?.name as string) ?? 'x',
            )
          },
        )
        ctx.router.delete('/docs/:id', { role: 'editor' }, async (req) => {
          const row = await req.db.table('docs').findOne({ id: req.params.id! })
          if (!row) throw new PadError(404, 'not_found')
          await req.files.remove(row.file_id as string)
          await req.db.table('docs').delete({ id: req.params.id! })
          return { ok: true }
        })
        ctx.router.get('/secret/:id', { role: 'owner', reauth: true }, (req) => {
          if (req.params.id === 'missing') throw new PadError(404, 'not_found')
          return { value: 'TOP-SECRET-VALUE' }
        })
        ctx.router.get('/secret-file', { role: 'owner', reauth: true }, async (req) => {
          const row = await req.db.table('docs').findOne({})
          return req.files.download(row!.file_id as string, row!.name as string)
        })
        ctx.router.post(
          '/guarded-upload',
          { role: 'owner', reauth: true, upload: { maxBytes: 1000, types: ['pdf'] } },
          () => ({ ok: true }),
        )
      }),
  })
  return definePadModule({
    manifest,
    migrations: [
      defineMigration('0001_init', (m) => {
        m.createTable('docs', {
          columns: { file_id: 'text', name: 'text', size: 'integer', kind: 'text' },
        })
      }),
    ],
    server,
  })
}
