import { MAX_LIMIT, PadError, z, type PadContext, type PadScope, type Row } from '@pond/sdk'
import { maskTaxId } from './logic.js'
import { PAY_PERIODS, RELATIONSHIPS, values, type PayView, type PersonView } from './types.js'
import { day, optionalText, taxId } from './validation.js'

const personFields = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  relationship: z.enum(values(RELATIONSHIPS)),
  email: optionalText(200),
  phone: optionalText(50),
  address: optionalText(500),
  startDate: day.nullable(),
  endDate: day.nullable(),
  /** Leave out to keep what's on file; null removes it. */
  taxId: taxId.nullable().optional(),
}
const personBody = z
  .object(personFields)
  .refine((p) => !p.startDate || !p.endDate || p.startDate <= p.endDate, {
    message: 'The end date is before the start date',
    path: ['endDate'],
  })
type PersonBody = z.infer<typeof personBody>

async function view(scope: PadScope, row: Row): Promise<PersonView> {
  const enc = row.tax_id_enc as string | null
  return {
    id: row.id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    relationship: row.relationship as string,
    email: row.email as string | null,
    phone: row.phone as string | null,
    address: row.address as string | null,
    startDate: row.start_date as string | null,
    endDate: row.end_date as string | null,
    taxIdMasked: enc ? maskTaxId(await scope.secrets.decrypt(enc)) : null,
  }
}

async function columns(scope: PadScope, b: PersonBody) {
  const out: Record<string, string | null> = {
    first_name: b.firstName,
    last_name: b.lastName,
    relationship: b.relationship,
    email: b.email,
    phone: b.phone,
    address: b.address,
    start_date: b.startDate,
    end_date: b.endDate,
  }
  if (b.taxId !== undefined)
    out.tax_id_enc = b.taxId === null ? null : await scope.secrets.encrypt(b.taxId)
  return out
}

export async function findPerson(scope: PadScope, id: string): Promise<Row> {
  const row = await scope.db.table('people').findOne({ id })
  if (!row) throw new PadError(404, 'not_found')
  return row
}

export function registerPeople(ctx: PadContext): void {
  ctx.router.get('/people', { role: 'owner' }, async (req) => {
    const rows = await req.db.table('people').find({
      orderBy: [
        ['last_name', 'asc'],
        ['first_name', 'asc'],
      ],
      limit: MAX_LIMIT,
    })
    return { people: await Promise.all(rows.map((r) => view(req, r))) }
  })

  ctx.router.post('/people', { role: 'owner', body: personBody }, async (req) => {
    const row = await req.db
      .table('people')
      .insert({ tax_id_enc: null, ...(await columns(req, req.body)) })
    await req.audit.record({
      action: 'person.added',
      targetType: 'person',
      targetId: row.id as string,
    })
    return { person: await view(req, row) }
  })

  ctx.router.put('/people/:id', { role: 'owner', body: personBody }, async (req) => {
    const id = req.params.id!
    await findPerson(req, id)
    await req.db.table('people').update({ id }, await columns(req, req.body))
    await req.audit.record({
      action: 'person.changed',
      targetType: 'person',
      targetId: id,
      meta: { taxIdChanged: req.body.taxId !== undefined },
    })
    return { person: await view(req, await findPerson(req, id)) }
  })

  // Removes everything held about the person, including their documents and the files.
  ctx.router.delete('/people/:id', { role: 'owner' }, async (req) => {
    const id = req.params.id!
    await findPerson(req, id)
    const documents = req.db.table('documents')
    for (;;) {
      const page = await documents.find({ where: { person_id: id }, limit: 200 })
      if (page.length === 0) break
      for (const d of page) {
        // The file first: if this stops half way, the row remains and deleting can be retried.
        await req.files.remove(d.file_id as string)
        await documents.delete({ id: d.id as string })
      }
    }
    await req.db.table('pay_records').delete({ person_id: id })
    await req.db.table('people').delete({ id })
    await req.audit.record({ action: 'person.deleted', targetType: 'person', targetId: id })
    return { ok: true }
  })

  ctx.router.get('/people/:id/tax-id', { role: 'owner', reauth: true }, async (req) => {
    const row = await findPerson(req, req.params.id!)
    if (!row.tax_id_enc) throw new PadError(404, 'not_found')
    await req.audit.record({
      action: 'taxid.revealed',
      targetType: 'person',
      targetId: row.id as string,
    })
    return { taxId: await req.secrets.decrypt(row.tax_id_enc as string) }
  })

  // ---------- Pay history: a record, not payroll ----------

  ctx.router.get('/people/:id/pay', { role: 'owner' }, async (req) => {
    await findPerson(req, req.params.id!)
    const rows = await req.db.table('pay_records').find({
      where: { person_id: req.params.id! },
      orderBy: [['effective_date', 'desc']],
      limit: MAX_LIMIT,
    })
    return {
      pay: rows.map((r): PayView => ({
        id: r.id as string,
        amountCents: r.amount_cents as number,
        per: r.per as string,
        effectiveDate: r.effective_date as string,
        note: r.note as string | null,
      })),
    }
  })

  ctx.router.post(
    '/people/:id/pay',
    {
      role: 'owner',
      body: z.object({
        amountCents: z.number().int().min(1).max(100_000_000_00),
        per: z.enum(values(PAY_PERIODS)),
        effectiveDate: day,
        note: optionalText(300),
      }),
    },
    async (req) => {
      await findPerson(req, req.params.id!)
      const row = await req.db.table('pay_records').insert({
        person_id: req.params.id!,
        amount_cents: req.body.amountCents,
        per: req.body.per,
        effective_date: req.body.effectiveDate,
        note: req.body.note,
      })
      await req.audit.record({
        action: 'pay.added',
        targetType: 'person',
        targetId: req.params.id!,
      })
      return { id: row.id }
    },
  )

  ctx.router.delete('/people/:id/pay/:payId', { role: 'owner' }, async (req) => {
    const removed = await req.db
      .table('pay_records')
      .delete({ id: req.params.payId!, person_id: req.params.id! })
    if (removed === 0) throw new PadError(404, 'not_found')
    await req.audit.record({
      action: 'pay.removed',
      targetType: 'person',
      targetId: req.params.id!,
    })
    return { ok: true }
  })
}
