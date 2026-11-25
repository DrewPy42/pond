/** Words and shapes shared by the pad's server and web code. */

export const BUSINESS_TYPES = [
  { value: 'sole_proprietorship', label: 'Sole proprietorship' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'llc', label: 'LLC' },
  { value: 'corporation', label: 'Corporation' },
  { value: 's_corporation', label: 'S corporation' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
] as const

export const RELATIONSHIPS = [
  { value: 'owner', label: 'Owner' },
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
] as const

export const PAY_PERIODS = [
  { value: 'year', label: 'per year' },
  { value: 'month', label: 'per month' },
  { value: 'hour', label: 'per hour' },
] as const

export const DOC_TYPES = [
  { value: 'tax_form', label: 'Tax form' },
  { value: 'contract', label: 'Contract' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'id', label: 'ID' },
  { value: 'other', label: 'Other' },
] as const

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024

type ValuesOf<T extends readonly { value: string }[]> = [
  T[number]['value'],
  ...T[number]['value'][],
]
export const values = <T extends readonly { value: string }[]>(list: T) =>
  list.map((x) => x.value) as unknown as ValuesOf<T>
export const labelOf = (list: readonly { value: string; label: string }[], value: string | null) =>
  list.find((x) => x.value === value)?.label ?? ''

export interface ProfileView {
  legalName: string | null
  businessType: string | null
  address: string | null
  phone: string | null
  taxYearStartMonth: number
  /** e.g. "•••••6789", or null when none is on file. */
  taxIdMasked: string | null
}
export interface PersonView {
  id: string
  firstName: string
  lastName: string
  relationship: string
  email: string | null
  phone: string | null
  address: string | null
  startDate: string | null
  endDate: string | null
  taxIdMasked: string | null
}
export interface PayView {
  id: string
  amountCents: number
  per: string
  effectiveDate: string
  note: string | null
}
export interface DocumentView {
  id: string
  filename: string
  docType: string
  size: number
  taxYear: number | null
  personId: string | null
  personName: string | null
  note: string | null
  addedOn: string
}

export interface ReportLine {
  categoryId: string
  name: string
  taxLine: string | null
  /** Money received for income, money spent for expenses. Negative after large refunds. */
  cents: number
}
export interface ProfitAndLoss {
  from: string
  to: string
  income: ReportLine[]
  expenses: ReportLine[]
  totals: { incomeCents: number; expenseCents: number; netCents: number }
  /** Not in the totals: Pond only knows the net of these, so adding them would be a guess. */
  uncategorized: { count: number; netCents: number }
}
export interface TaxSummaryCategory {
  categoryId: string
  name: string
  cents: number
  /** Null means counted in full. */
  percent: number | null
  countedCents: number
}
export interface TaxSummaryGroup {
  /** Null is the "No tax line" group. */
  taxLine: string | null
  categories: TaxSummaryCategory[]
  totalCents: number
  countedCents: number
}
export interface TaxSummary {
  year: number
  from: string
  to: string
  income: TaxSummaryGroup[]
  expenses: TaxSummaryGroup[]
  totals: {
    incomeCents: number
    expenseCents: number
    countedExpenseCents: number
    netCents: number
  }
  uncategorized: { count: number; netCents: number }
}
