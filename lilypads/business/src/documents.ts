import { MAX_LIMIT, PadError, z, type PadContext } from '@pond/sdk'
import { findPerson } from './people.js'
import { DOC_TYPES, MAX_DOCUMENT_BYTES, values, type DocumentView } from './types.js'

const taxYear = z.coerce.number().int().min(1990).max(2200)
const docType = z.enum(values(DOC_TYPES))
const id = z.string().min(1).max(64)

export function registerDocuments(ctx: PadContext): void {
  ctx.router.get(
    '/documents',
    {
      role: 'owner',
      query: z.object({
        type: docType.optional(),
        taxYear: taxYear.optional(),
        personId: id.optional(),
      }),
    },
    async (req) => {
      const q = req.query
      const [rows, people] = await Promise.all([
        req.db.table('documents').find({
          where: {
            ...(q.type ? { doc_type: q.type } : {}),
            ...(q.taxYear ? { tax_year: q.taxYear } : {}),
            ...(q.personId ? { person_id: q.personId } : {}),
          },
          orderBy: [['created_at', 'desc']],
          limit: MAX_LIMIT,
        }),
        req.db.table('people').find({ limit: MAX_LIMIT }),
      ])
      const names = new Map(
        people.map((p) => [p.id as string, `${p.first_name as string} ${p.last_name as string}`]),
      )
      return {
        documents: rows.map((r): DocumentView => ({
          id: r.id as string,
          filename: r.filename as string,
          docType: r.doc_type as string,
          size: r.size as number,
          taxYear: r.tax_year as number | null,
          personId: r.person_id as string | null,
          personName: r.person_id ? (names.get(r.person_id as string) ?? null) : null,
          note: r.note as string | null,
          addedOn: (r.created_at as string).slice(0, 10),
        })),
      }
    },
  )

  ctx.router.post(
    '/documents',
    {
      role: 'owner',
      upload: { maxBytes: MAX_DOCUMENT_BYTES, types: ['pdf', 'jpeg', 'png'] },
      query: z.object({
        filename: z.string().trim().min(1).max(200),
        type: docType,
        taxYear: taxYear.optional(),
        personId: id.optional(),
        note: z.string().trim().max(300).optional(),
      }),
    },
    async (req) => {
      const q = req.query
      if (q.personId) await findPerson(req, q.personId)
      const row = await req.db.table('documents').insert({
        file_id: req.file!.id,
        filename: q.filename,
        doc_type: q.type,
        size: req.file!.size,
        tax_year: q.taxYear ?? null,
        person_id: q.personId ?? null,
        note: q.note || null,
      })
      await req.audit.record({
        action: 'document.added',
        targetType: 'document',
        targetId: row.id as string,
        meta: { type: q.type },
      })
      return { id: row.id }
    },
  )

  ctx.router.get('/documents/:id/download', { role: 'owner' }, async (req) => {
    const row = await req.db.table('documents').findOne({ id: req.params.id! })
    if (!row) throw new PadError(404, 'not_found')
    await req.audit.record({
      action: 'document.downloaded',
      targetType: 'document',
      targetId: row.id as string,
    })
    return req.files.download(row.file_id as string, row.filename as string)
  })

  ctx.router.delete('/documents/:id', { role: 'owner' }, async (req) => {
    const row = await req.db.table('documents').findOne({ id: req.params.id! })
    if (!row) throw new PadError(404, 'not_found')
    await req.files.remove(row.file_id as string)
    await req.db.table('documents').delete({ id: req.params.id! })
    await req.audit.record({
      action: 'document.deleted',
      targetType: 'document',
      targetId: req.params.id!,
    })
    return { ok: true }
  })
}
