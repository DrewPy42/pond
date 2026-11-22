export interface CategorySeed {
  name: string
  kind: 'income' | 'expense' | 'transfer'
  taxLine?: string
}

/** A short starter list for new personal Spaces. */
export const PERSONAL_SEEDS: readonly CategorySeed[] = [
  { name: 'Paycheck', kind: 'income' },
  { name: 'Other Income', kind: 'income' },
  { name: 'Groceries', kind: 'expense' },
  { name: 'Dining Out', kind: 'expense' },
  { name: 'Housing', kind: 'expense' },
  { name: 'Utilities', kind: 'expense' },
  { name: 'Transportation', kind: 'expense' },
  { name: 'Health', kind: 'expense' },
  { name: 'Insurance', kind: 'expense' },
  { name: 'Entertainment', kind: 'expense' },
  { name: 'Shopping', kind: 'expense' },
  { name: 'Travel', kind: 'expense' },
  { name: 'Education', kind: 'expense' },
  { name: 'Gifts & Donations', kind: 'expense' },
  { name: 'Personal Care', kind: 'expense' },
  { name: 'Fees & Interest', kind: 'expense' },
  { name: 'Taxes', kind: 'expense' },
  { name: 'Other Expenses', kind: 'expense' },
  { name: 'Transfer', kind: 'transfer' },
]

const C = (line: string) => `Schedule C, Line ${line}`

/**
 * Schedule C list ported from business_manager (backend/app/models/category.py). One change:
 * "Other Expenses" is Line 27a here (the old app said 48, which is the Part V total that
 * carries to 27a). Recorded in docs/decisions.md.
 */
export const BUSINESS_SEEDS: readonly CategorySeed[] = [
  { name: 'Gross Receipts / Sales', kind: 'income', taxLine: C('1') },
  { name: 'Other Income', kind: 'income', taxLine: C('6') },
  { name: 'Advertising', kind: 'expense', taxLine: C('8') },
  { name: 'Car and Truck Expenses', kind: 'expense', taxLine: C('9') },
  { name: 'Commissions and Fees', kind: 'expense', taxLine: C('10') },
  { name: 'Contract Labor', kind: 'expense', taxLine: C('11') },
  { name: 'Insurance', kind: 'expense', taxLine: C('15') },
  { name: 'Interest', kind: 'expense', taxLine: C('16') },
  { name: 'Legal and Professional Services', kind: 'expense', taxLine: C('17') },
  { name: 'Office Expense', kind: 'expense', taxLine: C('18') },
  { name: 'Rent or Lease', kind: 'expense', taxLine: C('20') },
  { name: 'Repairs and Maintenance', kind: 'expense', taxLine: C('21') },
  { name: 'Supplies', kind: 'expense', taxLine: C('22') },
  { name: 'Taxes and Licenses', kind: 'expense', taxLine: C('23') },
  { name: 'Travel', kind: 'expense', taxLine: C('24a') },
  { name: 'Meals (50% deductible)', kind: 'expense', taxLine: C('24b') },
  { name: 'Utilities', kind: 'expense', taxLine: C('25') },
  { name: 'Wages', kind: 'expense', taxLine: C('26') },
  { name: 'Other Expenses', kind: 'expense', taxLine: C('27a') },
  { name: 'Transfer', kind: 'transfer' },
]

export const seedsFor = (type: 'personal' | 'business'): readonly CategorySeed[] =>
  type === 'business' ? BUSINESS_SEEDS : PERSONAL_SEEDS
