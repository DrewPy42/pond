import type { ColumnMap } from '@pond/shared'
import { describe, expect, it } from 'vitest'
import { LedgerError, createTransaction } from '../ledger/service'
import { createRule } from '../rules/service'
import { IDS, makeLedgerWorld, type LedgerWorld } from '../testing/ledgerWorld'
import { commitImport, listImportBatches, previewImport } from './service'

/**
 * CSV import service tests on makeLedgerWorld() mock data (spaces HOME/BIZ; ann edits HOME, bob views
 * HOME; accounts CHECKING and SAVINGS in HOME, CARD in BIZ). The CSV text is built in each test and
 * everything runs on in-memory fakes: no files, no database.
 */

const MAP: ColumnMap = {
  hasHeader: true,
  dateColumn: 0,
  dateFormat: 'YYYY-MM-DD',
  descriptionColumn: 1,
  amount: { mode: 'single', column: 2, invert: false },
}
const CSV = [
  'Date,Description,Amount',
  '2030-01-05,CORNER MARKET,-42.50',
  '2030-01-06,PAYROLL ACME,2000.00',
  '2030-01-07,COFFEE SHOP,-4.50',
].join('\n')

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof LedgerError ? e.code : `other:${(e as Error).message}`
  }
  return 'no error'
}
const commit = (w: LedgerWorld, over: Partial<Parameters<typeof commitImport>[3]> = {}) =>
  commitImport(w.deps, w.actors.ann, IDS.HOME, {
    accountId: IDS.CHECKING,
    filename: 'jan.csv',
    csv: CSV,
    mapping: MAP,
    skipRows: [],
    includeDuplicateRows: [],
    ...over,
  })

describe('previewImport(deps, spaceId, { accountId, csv, mapping? })', () => {
  /**
   * Inputs:   a CSV with no mapping yet
   * Expected: the delimiter, the headers, sample rows and a suggested mapping (date, description and
   *           amount columns found); no rows analysed yet; nothing saved
   */
  it('detects the delimiter and suggests a mapping before the user chooses one', () => {
    const w = makeLedgerWorld()
    const p = previewImport(w.deps, IDS.HOME, { accountId: IDS.CHECKING, csv: CSV })
    expect(p).toMatchObject({
      delimiter: ',',
      columnCount: 3,
      headers: ['Date', 'Description', 'Amount'],
      rows: [],
    })
    expect(p.suggestedMapping).toMatchObject({
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      amount: { mode: 'single', column: 2 },
    })
    expect(w.repos.transactions.countForAccount(IDS.CHECKING)).toBe(0)
  })
  /**
   * Inputs:   the CSV with a mapping, with one row already in the account (same date, amount and text
   *           apart from case) and one unreadable row added
   * Expected: rows flagged "new", "duplicate" and "invalid" with counts; the invalid row says why; still
   *           nothing saved
   */
  it('flags new, duplicate and invalid rows without saving anything', () => {
    const w = makeLedgerWorld()
    createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-05',
      amountCents: -4250,
      description: 'Corner Market',
    })
    const csv = `${CSV}\nnot-a-date,BAD ROW,1.00`
    const p = previewImport(w.deps, IDS.HOME, { accountId: IDS.CHECKING, csv, mapping: MAP })
    expect(p.counts).toEqual({ total: 4, new: 2, duplicate: 1, invalid: 1 })
    expect(p.rows.map((r) => r.status)).toEqual(['duplicate', 'new', 'new', 'invalid'])
    expect(p.rows[3]!.problem).toContain('Unreadable date')
    expect(w.repos.transactions.countForAccount(IDS.CHECKING)).toBe(1)
  })
  /**
   * Inputs:   a file that isn't CSV (an unterminated quote); and an account from another Space
   * Expected: LedgerError "bad_csv" with a reason; "not_found" for the foreign account
   */
  it('reports a bad file clearly and refuses accounts from other Spaces', () => {
    const w = makeLedgerWorld()
    expect(
      code(() => previewImport(w.deps, IDS.HOME, { accountId: IDS.CHECKING, csv: 'a,"b\nc' })),
    ).toBe('bad_csv')
    expect(code(() => previewImport(w.deps, IDS.HOME, { accountId: IDS.CARD, csv: CSV }))).toBe(
      'not_found',
    )
  })
})

describe('commitImport(deps, actor, spaceId, input)', () => {
  /**
   * Inputs:   commit the three-row file into CHECKING
   * Expected: three "csv" transactions, each linked to one import batch, dated and signed correctly,
   *           each with one default split in HOME; the batch records the filename and count; the audit
   *           log notes the import
   */
  it('creates the transactions, a batch, and one default split each', () => {
    const w = makeLedgerWorld()
    const r = commit(w)
    expect(r).toMatchObject({ imported: 3, skipped: 0, duplicatesSkipped: 0, invalid: 0 })
    const txns = w.repos.transactions.listForAccountSince(IDS.CHECKING, '2030-01-01')
    expect(
      txns.map((t) => [t.txn.date, t.txn.amountCents, t.txn.source, t.txn.importBatchId]),
    ).toEqual([
      ['2030-01-07', -450, 'csv', r.batchId],
      ['2030-01-06', 200000, 'csv', r.batchId],
      ['2030-01-05', -4250, 'csv', r.batchId],
    ])
    for (const t of txns)
      expect(t.splits.map((s) => [s.spaceId, s.amountCents])).toEqual([
        [IDS.HOME, t.txn.amountCents],
      ])
    expect(w.repos.transactions.findInvariantViolations()).toEqual([])
    expect(w.repos.importBatches.findById(r.batchId)).toMatchObject({
      filename: 'jan.csv',
      rowCount: 3,
      status: 'done',
      createdBy: IDS.ann,
    })
    expect(w.repos.audit.list({ limit: 20 }).map((a) => a.action)).toContain('import.committed')
  })
  /**
   * Inputs:   import the same file twice
   * Expected: the second import finds all three as duplicates and refuses with "nothing_to_import"; with
   *           includeDuplicateRows for row 2 it imports just that row
   */
  it('does not silently re-import duplicates, but lets the user include chosen ones', () => {
    const w = makeLedgerWorld()
    commit(w)
    expect(code(() => commit(w))).toBe('nothing_to_import')
    const r = commit(w, { includeDuplicateRows: [2] })
    expect(r).toMatchObject({ imported: 1, duplicatesSkipped: 2 })
    expect(w.repos.transactions.countForAccount(IDS.CHECKING)).toBe(4)
  })
  /**
   * Inputs:   skip row 1 (unchecked in the review) and include a file with one invalid row
   * Expected: row 1 and the invalid row are not imported; counts report skipped and invalid
   */
  it('leaves out rows the user unchecked and rows that cannot be read', () => {
    const w = makeLedgerWorld()
    const r = commit(w, { csv: `${CSV}\n2030-01-08,,5.00`, skipRows: [1] })
    expect(r).toMatchObject({ imported: 2, skipped: 1, invalid: 1 })
    expect(
      w.repos.transactions
        .listForAccountSince(IDS.CHECKING, '2030-01-01')
        .map((t) => t.txn.descriptionRaw)
        .sort(),
    ).toEqual(['COFFEE SHOP', 'PAYROLL ACME'])
  })
  /**
   * Inputs:   a rule "contains market -> Groceries" and the file importing a "CORNER MARKET" row
   * Expected: that imported transaction is categorized by the rule (rulesApplied = 1); the others are not
   */
  it("runs the Space's rules on imported transactions", () => {
    const w = makeLedgerWorld()
    const groceries = w.category('HOME', 'Groceries')
    createRule(w.deps, w.actors.ann, IDS.HOME, {
      name: 'Market',
      priority: 1,
      enabled: true,
      conditions: [{ type: 'text', field: 'description', op: 'contains', value: 'market' }],
      actions: [{ type: 'set_category', categoryId: groceries }],
    })
    const r = commit(w)
    expect(r.rulesApplied).toBe(1)
    const market = w.repos.transactions
      .listForAccountSince(IDS.CHECKING, '2030-01-01')
      .find((t) => t.txn.descriptionRaw === 'CORNER MARKET')!
    expect(market.splits[0]!.categoryId).toBe(groceries)
  })
  /**
   * Inputs:   an import into a bank-fed account (history SimpleFIN doesn't have)
   * Expected: allowed; unlike hand-typed transactions, CSV import is meant for exactly this
   */
  it('can add history to a bank-fed account', () => {
    const w = makeLedgerWorld()
    w.repos.accounts.update(IDS.CHECKING, {})
    w.repos.accounts.create({
      id: 'bank-acct',
      name: 'Bank',
      type: 'checking',
      currency: 'USD',
      primarySpaceId: IDS.HOME,
      isManual: false,
    })
    expect(commit(w, { accountId: 'bank-acct' }).imported).toBe(3)
  })
  /**
   * Inputs:   debit/credit columns, a European-looking amount row, and a two-digit-year date format
   * Expected: split columns net correctly; the unreadable amount is invalid; M/D/YY dates are read
   */
  it('imports with split debit/credit columns and short dates', () => {
    const w = makeLedgerWorld()
    const mapping: ColumnMap = {
      hasHeader: true,
      dateColumn: 0,
      dateFormat: 'M/D/YY',
      descriptionColumn: 1,
      amount: { mode: 'split', debitColumn: 2, creditColumn: 3 },
    }
    const csv = [
      'Date,Desc,Debit,Credit',
      '1/5/30,COFFEE,4.50,',
      '1/6/30,PAY,,100.00',
      '1/7/30,ODD,"1.234,56",',
    ].join('\n')
    const r = commit(w, { csv, mapping })
    expect(r).toMatchObject({ imported: 2, invalid: 1 })
    expect(
      w.repos.transactions
        .listForAccountSince(IDS.CHECKING, '2030-01-01')
        .map((t) => t.txn.amountCents)
        .sort((a, b) => a - b),
    ).toEqual([-450, 10000])
  })
})

describe('listImportBatches(deps, spaceId)', () => {
  /**
   * Inputs:   one import into HOME's CHECKING, listed for HOME and for BIZ
   * Expected: HOME lists it (filename and row count); BIZ lists nothing
   */
  it("lists a Space's own imports only", () => {
    const w = makeLedgerWorld()
    commit(w)
    expect(listImportBatches(w.deps, IDS.HOME)).toMatchObject([
      { filename: 'jan.csv', rowCount: 3, accountId: IDS.CHECKING },
    ])
    expect(listImportBatches(w.deps, IDS.BIZ)).toEqual([])
  })
})
