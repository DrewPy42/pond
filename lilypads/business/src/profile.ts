import { PadError, z, type PadContext, type PadScope, type Row } from '@pond/sdk'
import { maskTaxId } from './logic.js'
import { BUSINESS_TYPES, values, type ProfileView } from './types.js'
import { optionalText, taxId } from './validation.js'

const where = { slot: 'profile' }

async function view(scope: PadScope, row: Row | null): Promise<ProfileView> {
  const enc = (row?.tax_id_enc as string | null | undefined) ?? null
  return {
    legalName: (row?.legal_name as string | null | undefined) ?? null,
    businessType: (row?.business_type as string | null | undefined) ?? null,
    address: (row?.address as string | null | undefined) ?? null,
    phone: (row?.phone as string | null | undefined) ?? null,
    taxYearStartMonth: (row?.tax_year_start_month as number | undefined) ?? 1,
    taxIdMasked: enc ? maskTaxId(await scope.secrets.decrypt(enc)) : null,
  }
}

export function registerProfile(ctx: PadContext): void {
  ctx.router.get('/profile', { role: 'owner' }, async (req) => ({
    profile: await view(req, await req.db.table('profile').findOne(where)),
  }))

  ctx.router.put(
    '/profile',
    {
      role: 'owner',
      body: z.object({
        legalName: optionalText(200),
        businessType: z.enum(values(BUSINESS_TYPES)).nullable(),
        address: optionalText(500),
        phone: optionalText(50),
        taxYearStartMonth: z.number().int().min(1).max(12),
        /** Leave out to keep what's on file; null removes it. */
        taxId: taxId.nullable().optional(),
      }),
    },
    async (req) => {
      const b = req.body
      const table = req.db.table('profile')
      const patch: Record<string, string | number | null> = {
        legal_name: b.legalName,
        business_type: b.businessType,
        address: b.address,
        phone: b.phone,
        tax_year_start_month: b.taxYearStartMonth,
      }
      if (b.taxId !== undefined)
        patch.tax_id_enc = b.taxId === null ? null : await req.secrets.encrypt(b.taxId)
      if ((await table.update(where, patch)) === 0) await table.insert({ ...where, ...patch })
      await req.audit.record({
        action: 'profile.changed',
        meta: { taxIdChanged: b.taxId !== undefined },
      })
      return { profile: await view(req, await table.findOne(where)) }
    },
  )

  ctx.router.get('/profile/tax-id', { role: 'owner', reauth: true }, async (req) => {
    const enc = (await req.db.table('profile').findOne(where))?.tax_id_enc as string | null
    if (!enc) throw new PadError(404, 'not_found')
    await req.audit.record({ action: 'taxid.revealed', targetType: 'business' })
    return { taxId: await req.secrets.decrypt(enc) }
  })
}
