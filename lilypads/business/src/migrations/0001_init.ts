import { defineMigration } from '@pond/sdk'

/**
 * All per Space, and all empty until someone adds something. Tax IDs are stored encrypted with
 * `ctx.secrets`; money is integer cents.
 */
export default defineMigration('0001_init', (m) => {
  m.createTable('profile', {
    columns: {
      /** Always "profile": with the unique index, a Space has at most one row. */
      slot: 'text',
      legal_name: { type: 'text', nullable: true },
      business_type: { type: 'text', nullable: true },
      tax_id_enc: { type: 'text', nullable: true },
      address: { type: 'text', nullable: true },
      phone: { type: 'text', nullable: true },
      tax_year_start_month: { type: 'integer', default: 1 },
    },
    indexes: [{ columns: ['slot'], unique: true }],
  })
  /** Categories only partly counted in the tax summary. No row means fully counted. */
  m.createTable('deductions', {
    columns: { category_id: 'text', percent: 'integer' },
    indexes: [{ columns: ['category_id'], unique: true }],
  })
  m.createTable('people', {
    columns: {
      first_name: 'text',
      last_name: 'text',
      relationship: 'text',
      email: { type: 'text', nullable: true },
      phone: { type: 'text', nullable: true },
      address: { type: 'text', nullable: true },
      start_date: { type: 'text', nullable: true },
      end_date: { type: 'text', nullable: true },
      tax_id_enc: { type: 'text', nullable: true },
    },
  })
  m.createTable('pay_records', {
    columns: {
      person_id: 'text',
      amount_cents: 'integer',
      per: 'text',
      effective_date: 'text',
      note: { type: 'text', nullable: true },
    },
    indexes: [{ columns: ['person_id'] }],
  })
  m.createTable('documents', {
    columns: {
      file_id: 'text',
      filename: 'text',
      doc_type: 'text',
      size: 'integer',
      tax_year: { type: 'integer', nullable: true },
      person_id: { type: 'text', nullable: true },
      note: { type: 'text', nullable: true },
    },
    indexes: [{ columns: ['person_id'] }],
  })
})
