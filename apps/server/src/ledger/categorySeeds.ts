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

/**
 * A general starter list for a business. It carries no tax lines: which form a business files
 * depends on what kind of business it is, and the tax summary is meant to go to an accountant.
 * (docs/business-pad-design.md, "Categories and tax lines".)
 */
export const BUSINESS_SEEDS: readonly CategorySeed[] = [
  { name: 'Gross Receipts / Sales', kind: 'income' },
  { name: 'Other Income', kind: 'income' },
  { name: 'Advertising', kind: 'expense' },
  { name: 'Car and Truck Expenses', kind: 'expense' },
  { name: 'Commissions and Fees', kind: 'expense' },
  { name: 'Contract Labor', kind: 'expense' },
  { name: 'Insurance', kind: 'expense' },
  { name: 'Interest', kind: 'expense' },
  { name: 'Legal and Professional Services', kind: 'expense' },
  { name: 'Office Expense', kind: 'expense' },
  { name: 'Rent or Lease', kind: 'expense' },
  { name: 'Repairs and Maintenance', kind: 'expense' },
  { name: 'Supplies', kind: 'expense' },
  { name: 'Taxes and Licenses', kind: 'expense' },
  { name: 'Travel', kind: 'expense' },
  { name: 'Meals', kind: 'expense' },
  { name: 'Utilities', kind: 'expense' },
  { name: 'Wages', kind: 'expense' },
  { name: 'Other Expenses', kind: 'expense' },
  { name: 'Transfer', kind: 'transfer' },
]

export const seedsFor = (type: 'personal' | 'business'): readonly CategorySeed[] =>
  type === 'business' ? BUSINESS_SEEDS : PERSONAL_SEEDS
