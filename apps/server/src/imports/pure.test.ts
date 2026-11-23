import type { ColumnMap } from '@pond/shared'
import { describe, expect, it } from 'vitest'
import { CsvError, detectDelimiter, parseCsv } from './csv'
import { markDuplicates, normalizeDescription } from './duplicates'
import {
  guessDateFormat,
  parseAmountCell,
  parseDateCell,
  parseRows,
  suggestMapping,
} from './mapping'

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof CsvError ? e.code : 'other'
  }
  return 'no error'
}

describe('parseCsv(text, delimiter?)', () => {
  /**
   * Inputs:   a simple file with a header and two rows
   * Expected: delimiter ",", three rows of trimmed cells
   */
  it('reads plain comma-separated rows', () => {
    expect(
      parseCsv('Date,Description,Amount\n2030-01-05, Coffee ,-4.50\n2030-01-06,Pay,100.00'),
    ).toEqual({
      delimiter: ',',
      rows: [
        ['Date', 'Description', 'Amount'],
        ['2030-01-05', 'Coffee', '-4.50'],
        ['2030-01-06', 'Pay', '100.00'],
      ],
    })
  })
  /**
   * Inputs:   quoted cells with a comma, an escaped quote ("") and a line break inside quotes
   * Expected: the quotes are removed and the special characters kept inside the cell
   */
  it('handles quotes, escaped quotes and line breaks inside cells', () => {
    const r = parseCsv('a,b\n"Smith, J","He said ""hi"""\n"two\nlines",x')
    expect(r.rows).toEqual([
      ['a', 'b'],
      ['Smith, J', 'He said "hi"'],
      ['two\nlines', 'x'],
    ])
  })
  /**
   * Inputs:   Windows (CRLF) and old Mac (CR) line endings, a leading byte-order mark, blank lines
   * Expected: same rows as with LF; the BOM is dropped; blank lines are skipped
   */
  it('copes with CRLF, CR, a BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
    expect(parseCsv('a,b\r1,2').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  /**
   * Inputs:   semicolon, tab and pipe separated files; a comma inside quotes that must not count
   * Expected: the right delimiter is detected each time
   */
  it('detects the delimiter', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|')
    expect(detectDelimiter('"x, y";b\n"p, q";d')).toBe(';')
  })
  /**
   * Inputs:   an empty file; a quote that never closes; 60 columns; more rows than allowed
   * Expected: CsvError "empty", "unterminated_quote", "too_many_columns", "too_many_rows"
   */
  it('refuses empty, malformed and oversized files', () => {
    expect(code(() => parseCsv(''))).toBe('empty')
    expect(code(() => parseCsv('a,"b\nc'))).toBe('unterminated_quote')
    expect(code(() => parseCsv(Array.from({ length: 60 }, (_, i) => i).join(',')))).toBe(
      'too_many_columns',
    )
    expect(code(() => parseCsv(Array.from({ length: 20_005 }, () => 'x,y').join('\n')))).toBe(
      'too_many_rows',
    )
  })
})

describe('parseDateCell(value, format)', () => {
  /**
   * Inputs:   "2030-01-05" (YYYY-MM-DD), "01/05/2030" (MM/DD/YYYY), "05/01/2030" (DD/MM/YYYY),
   *           "1/5/30" (M/D/YY), "01-05-2030 12:30" (with a time)
   * Expected: all "2030-01-05"
   */
  it('reads each supported format into YYYY-MM-DD', () => {
    expect(parseDateCell('2030-01-05', 'YYYY-MM-DD')).toBe('2030-01-05')
    expect(parseDateCell('01/05/2030', 'MM/DD/YYYY')).toBe('2030-01-05')
    expect(parseDateCell('05/01/2030', 'DD/MM/YYYY')).toBe('2030-01-05')
    expect(parseDateCell('1/5/30', 'M/D/YY')).toBe('2030-01-05')
    expect(parseDateCell('01-05-2030 12:30', 'MM-DD-YYYY')).toBe('2030-01-05')
  })
  /**
   * Inputs:   "02/30/2030", "13/01/2030" as MM/DD, "2030-1-5x", "yesterday", and the right text in the
   *           wrong format
   * Expected: null for each (impossible dates and mismatches are never guessed)
   */
  it('refuses impossible dates and wrong formats', () => {
    for (const [v, f] of [
      ['02/30/2030', 'MM/DD/YYYY'],
      ['13/01/2030', 'MM/DD/YYYY'],
      ['2030-1-5x', 'YYYY-MM-DD'],
      ['yesterday', 'YYYY-MM-DD'],
      ['2030-01-05', 'MM/DD/YYYY'],
    ] as const) {
      expect(parseDateCell(v, f), v).toBeNull()
    }
  })
  /**
   * Inputs:   samples like "25/01/2030" and "03/02/2030"
   * Expected: guessDateFormat picks DD/MM/YYYY (the only format that reads all of them)
   */
  it('guesses the format that reads the most sample cells', () => {
    expect(guessDateFormat(['25/01/2030', '03/02/2030'])).toBe('DD/MM/YYYY')
    expect(guessDateFormat(['2030-01-25', '2030-02-03'])).toBe('YYYY-MM-DD')
  })
})

describe('parseAmountCell(value)', () => {
  /**
   * Inputs:   "12.34", "$1,234.50", "-5", "(5.00)", "5.00-", "+12", " € 3.20 "
   * Expected: 1234, 123450, -500, -500, -500, 1200, 320
   */
  it('reads common money formats into cents', () => {
    const cases: [string, number][] = [
      ['12.34', 1234],
      ['$1,234.50', 123450],
      ['-5', -500],
      ['(5.00)', -500],
      ['5.00-', -500],
      ['+12', 1200],
      [' € 3.20 ', 320],
    ]
    for (const [v, cents] of cases) expect(parseAmountCell(v), v).toBe(cents)
  })
  /**
   * Inputs:   "", "abc", "1.234" (a fraction of a cent), "1.234,56" and "12,34" (European)
   * Expected: null for each (refused, never guessed)
   */
  it('refuses empty, non-numeric, sub-cent and European-format amounts', () => {
    for (const v of ['', 'abc', '1.234', '1.234,56', '12,34'])
      expect(parseAmountCell(v), v).toBeNull()
  })
})

describe('parseRows(rows, mapping)', () => {
  const single: ColumnMap = {
    hasHeader: true,
    dateColumn: 0,
    dateFormat: 'MM/DD/YYYY',
    descriptionColumn: 1,
    amount: { mode: 'single', column: 2, invert: false },
  }
  const rows = [
    ['Date', 'Desc', 'Amount'],
    ['01/05/2030', 'COFFEE', '-4.50'],
    ['01/06/2030', 'PAYROLL', '2,000.00'],
  ]

  /**
   * Inputs:   the rows above with a header and a single signed amount column
   * Expected: two data rows numbered 1 and 2, dates and cents parsed, no problems
   */
  it('turns raw cells into typed rows, skipping the header', () => {
    const r = parseRows(rows, single)
    expect(r.map((x) => [x.rowNumber, x.date, x.amountCents, x.description, x.problem])).toEqual([
      [1, '2030-01-05', -450, 'COFFEE', null],
      [2, '2030-01-06', 200000, 'PAYROLL', null],
    ])
  })
  /**
   * Inputs:   the same rows with invert = true (a card export that lists purchases as positive)
   * Expected: signs flipped: -450 becomes +450 and +200000 becomes -200000
   */
  it('can invert signs', () => {
    const r = parseRows(rows, { ...single, amount: { mode: 'single', column: 2, invert: true } })
    expect(r.map((x) => x.amountCents)).toEqual([450, -200000])
  })
  /**
   * Inputs:   separate debit and credit columns: a debit of 4.50, a credit of 100.00
   * Expected: -450 and +10000 (money out negative, money in positive)
   */
  it('reads split debit and credit columns', () => {
    const map: ColumnMap = { ...single, amount: { mode: 'split', debitColumn: 2, creditColumn: 3 } }
    const r = parseRows(
      [
        ['Date', 'Desc', 'Debit', 'Credit'],
        ['01/05/2030', 'COFFEE', '4.50', ''],
        ['01/06/2030', 'PAY', '', '100.00'],
      ],
      map,
    )
    expect(r.map((x) => x.amountCents)).toEqual([-450, 10000])
  })
  /**
   * Inputs:   rows with a missing date, a bad date, a bad amount, a zero amount, a missing description,
   *           and a short row
   * Expected: each is reported with its own reason and no amount/date guessed
   */
  it('reports why a row is unusable', () => {
    const r = parseRows(
      [
        ['Date', 'Desc', 'Amount'],
        ['', 'x', '1'],
        ['13/45/2030', 'x', '1'],
        ['01/05/2030', 'x', 'abc'],
        ['01/05/2030', 'x', '0.00'],
        ['01/05/2030', '', '5'],
        ['01/05/2030'],
      ],
      single,
    )
    expect(r.map((x) => x.problem)).toEqual([
      'Missing date',
      'Unreadable date "13/45/2030"',
      'Unreadable amount "abc"',
      'Amount is zero',
      'Missing description',
      'Missing amount',
    ])
  })
})

describe('suggestMapping(rows, delimiter)', () => {
  /**
   * Inputs:   a header row "Transaction Date, Description, Amount" and ISO dates
   * Expected: a mapping with hasHeader, date column 0 (YYYY-MM-DD), description column 1, single amount column 2
   */
  it('maps columns from header names', () => {
    const m = suggestMapping(
      [
        ['Transaction Date', 'Description', 'Amount'],
        ['2030-01-05', 'COFFEE', '-4.50'],
      ],
      ',',
    )!
    expect(m).toMatchObject({
      hasHeader: true,
      dateColumn: 0,
      dateFormat: 'YYYY-MM-DD',
      descriptionColumn: 1,
      amount: { mode: 'single', column: 2 },
    })
  })
  /**
   * Inputs:   headers "Posted Date, Memo, Withdrawals, Deposits"
   * Expected: split amount mode with the withdrawal and deposit columns
   */
  it('finds separate debit and credit columns', () => {
    const m = suggestMapping(
      [
        ['Posted Date', 'Memo', 'Withdrawals', 'Deposits'],
        ['01/05/2030', 'COFFEE', '4.50', ''],
      ],
      ',',
    )!
    expect(m.amount).toEqual({ mode: 'split', debitColumn: 2, creditColumn: 3 })
  })
  /**
   * Inputs:   no header; columns: a date, some text, an amount
   * Expected: hasHeader false and columns found from their contents
   */
  it('finds columns by content when there is no header', () => {
    const m = suggestMapping(
      [
        ['01/05/2030', 'CORNER MARKET', '-4.50'],
        ['01/06/2030', 'PAYROLL ACME', '1200.00'],
      ],
      ',',
    )!
    expect(m).toMatchObject({
      hasHeader: false,
      dateColumn: 0,
      descriptionColumn: 1,
      amount: { mode: 'single', column: 2 },
    })
  })
  /**
   * Inputs:   text with no date-like column
   * Expected: null (the user maps columns by hand)
   */
  it('gives up when it cannot find a date', () => {
    expect(
      suggestMapping(
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
        ',',
      ),
    ).toBeNull()
  })
})

describe('markDuplicates(incoming, existing) and normalizeDescription(text)', () => {
  const row = (description: string, amountCents = -450, date = '2030-01-05') => ({
    date,
    amountCents,
    description,
  })

  /**
   * Inputs:   "Corner Market #12!" and "corner  market 12"
   * Expected: both normalize to "corner market 12" (case, punctuation and spacing ignored)
   */
  it('normalizes descriptions', () => {
    expect(normalizeDescription('Corner Market #12!')).toBe('corner market 12')
    expect(normalizeDescription('corner  market 12')).toBe('corner market 12')
  })
  /**
   * Inputs:   an incoming row matching a held transaction apart from punctuation; one with a different
   *           amount; one on a different date
   * Expected: [true, false, false]
   */
  it('flags a row that matches a held transaction on date, amount and description', () => {
    expect(
      markDuplicates(
        [row('COFFEE SHOP!'), row('COFFEE SHOP', -451), row('COFFEE SHOP', -450, '2030-01-06')],
        [row('coffee shop')],
      ),
    ).toEqual([true, false, false])
  })
  /**
   * Inputs:   the file has TWO identical coffees on one day; the account already holds ONE
   * Expected: [true, false]: the first is the duplicate, the second is a genuine second purchase
   */
  it('matches by count so two real identical purchases are not both called duplicates', () => {
    expect(markDuplicates([row('COFFEE'), row('COFFEE')], [row('coffee')])).toEqual([true, false])
    expect(markDuplicates([row('COFFEE'), row('COFFEE')], [row('coffee'), row('coffee')])).toEqual([
      true,
      true,
    ])
    expect(markDuplicates([row('COFFEE'), row('COFFEE')], [])).toEqual([false, false])
  })
})
