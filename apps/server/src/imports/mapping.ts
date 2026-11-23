import { parseCents, type ColumnMap, type DateFormat } from '@pond/shared'

// ---------- Dates ----------

const FORMATS: Record<
  DateFormat,
  { re: RegExp; order: ['y' | 'm' | 'd', 'y' | 'm' | 'd', 'y' | 'm' | 'd'] }
> = {
  'YYYY-MM-DD': { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ['y', 'm', 'd'] },
  'YYYY/MM/DD': { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order: ['y', 'm', 'd'] },
  'MM/DD/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['m', 'd', 'y'] },
  'DD/MM/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['d', 'm', 'y'] },
  'M/D/YY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, order: ['m', 'd', 'y'] },
  'D/M/YY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, order: ['d', 'm', 'y'] },
  'MM-DD-YYYY': { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ['m', 'd', 'y'] },
  'DD-MM-YYYY': { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ['d', 'm', 'y'] },
}

/** Strictly reads a date in the chosen format and returns YYYY-MM-DD, or null. Two-digit years are 20xx. */
export function parseDateCell(value: string, format: DateFormat): string | null {
  const spec = FORMATS[format]
  const m = spec.re.exec(value.trim().replace(/\s.*$/, '')) // ignore a trailing time like "12:30"
  if (!m) return null
  const parts: Record<string, number> = {}
  spec.order.forEach((k, i) => (parts[k] = Number(m[i + 1])))
  const year = (parts.y as number) < 100 ? 2000 + (parts.y as number) : (parts.y as number)
  const month = parts.m as number
  const day = parts.d as number
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const t = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null
}

// ---------- Amounts ----------

/**
 * Reads a money cell: "$1,234.50", "(5.00)", "-5", "5.00-", "+12". US-style separators only;
 * anything else (such as "1.234,56") is refused rather than guessed. Returns cents or null.
 */
export function parseAmountCell(value: string): number | null {
  let s = value.trim().replace(/[$€£\s]/g, '')
  if (s === '') return null
  if (/^[\d,.]+-$/.test(s)) s = `-${s.slice(0, -1)}` // trailing minus
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return null // European format
  if (/,\d{1,2}$/.test(s)) return null // "12,34": a decimal comma
  try {
    return parseCents(s)
  } catch {
    return null
  }
}

// ---------- Rows ----------

export interface ParsedRow {
  /** 1-based among data rows. */
  rowNumber: number
  date: string | null
  amountCents: number | null
  description: string
  payee: string | null
  problem: string | null
}

/** Turns raw cells into typed rows using the user's column mapping; bad rows say why. */
export function parseRows(rows: string[][], map: ColumnMap): ParsedRow[] {
  const data = map.hasHeader ? rows.slice(1) : rows
  return data.map((cells, i): ParsedRow => {
    const cell = (idx: number | undefined) => (idx === undefined ? '' : (cells[idx] ?? ''))
    const rowNumber = i + 1
    const description = cell(map.descriptionColumn)
    const payee = map.payeeColumn !== undefined ? cell(map.payeeColumn) || null : null
    const base = { rowNumber, description, payee }

    const dateText = cell(map.dateColumn)
    if (dateText === '') return { ...base, date: null, amountCents: null, problem: 'Missing date' }
    const date = parseDateCell(dateText, map.dateFormat)
    if (!date)
      return {
        ...base,
        date: null,
        amountCents: null,
        problem: `Unreadable date "${dateText.slice(0, 30)}"`,
      }

    let amountCents: number | null
    if (map.amount.mode === 'single') {
      const text = cell(map.amount.column)
      amountCents = parseAmountCell(text)
      if (amountCents === null) {
        return {
          ...base,
          date,
          amountCents: null,
          problem: text === '' ? 'Missing amount' : `Unreadable amount "${text.slice(0, 30)}"`,
        }
      }
      if (map.amount.invert) amountCents = -amountCents
    } else {
      const debitText = cell(map.amount.debitColumn)
      const creditText = cell(map.amount.creditColumn)
      const debit = debitText === '' ? 0 : parseAmountCell(debitText)
      const credit = creditText === '' ? 0 : parseAmountCell(creditText)
      if (debit === null || credit === null || (debitText === '' && creditText === '')) {
        return { ...base, date, amountCents: null, problem: 'Unreadable or missing amount' }
      }
      // Money out is shown as a positive number in a debit column; keep the sign rule simple.
      amountCents = Math.abs(credit) - Math.abs(debit)
    }
    if (amountCents === 0) return { ...base, date, amountCents, problem: 'Amount is zero' }
    if (!description && !payee)
      return { ...base, date, amountCents, problem: 'Missing description' }
    return {
      ...base,
      description: description || (payee as string),
      date,
      amountCents,
      problem: null,
    }
  })
}

// ---------- Suggesting a mapping ----------

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '')
const DATE_HEADERS = [
  'date',
  'transactiondate',
  'posteddate',
  'postdate',
  'postingdate',
  'bookingdate',
]
const DESC_HEADERS = [
  'description',
  'details',
  'memo',
  'name',
  'payee',
  'merchant',
  'narrative',
  'transactiondescription',
]
const AMOUNT_HEADERS = ['amount', 'transactionamount', 'value']
const DEBIT_HEADERS = ['debit', 'withdrawal', 'withdrawals', 'moneyout', 'paidout', 'debitamount']
const CREDIT_HEADERS = ['credit', 'deposit', 'deposits', 'moneyin', 'paidin', 'creditamount']

/** Dates: try each format on the sample and pick the one that reads the most cells. */
export function guessDateFormat(samples: string[]): DateFormat {
  const order: DateFormat[] = [
    'YYYY-MM-DD',
    'MM/DD/YYYY',
    'DD/MM/YYYY',
    'YYYY/MM/DD',
    'M/D/YY',
    'D/M/YY',
    'MM-DD-YYYY',
    'DD-MM-YYYY',
  ]
  let best: DateFormat = 'YYYY-MM-DD'
  let bestHits = -1
  for (const f of order) {
    const hits = samples.filter((s) => parseDateCell(s, f) !== null).length
    if (hits > bestHits) {
      best = f
      bestHits = hits
    }
  }
  return best
}

/**
 * Looks at the header names (or, without a header, at the contents) and proposes a mapping.
 * Returns null when it can't find a date and an amount; the user then picks columns by hand.
 */
export function suggestMapping(rows: string[][], delimiter: string): ColumnMap | null {
  const first = rows[0] ?? []
  const hasHeader =
    first.length > 0 &&
    first.every((c) => c === '' || parseAmountCell(c) === null) &&
    first.some((c) => /[a-z]/i.test(c))
  const data = hasHeader ? rows.slice(1, 11) : rows.slice(0, 10)
  const headers = hasHeader ? first.map(norm) : []
  const find = (names: string[]) => headers.findIndex((h) => names.includes(h))
  const column = (i: number) => data.map((r) => r[i] ?? '').filter((c) => c !== '')

  let dateColumn = find(DATE_HEADERS)
  if (dateColumn < 0) {
    dateColumn = first.findIndex((_, i) => {
      const cells = column(i)
      return (
        cells.length > 0 &&
        cells.filter((c) =>
          (['YYYY-MM-DD', 'MM/DD/YYYY', 'M/D/YY', 'YYYY/MM/DD'] as DateFormat[]).some((f) =>
            parseDateCell(c, f),
          ),
        ).length >=
          cells.length * 0.8
      )
    })
  }
  if (dateColumn < 0) return null

  let descriptionColumn = find(DESC_HEADERS)
  if (descriptionColumn < 0 || descriptionColumn === dateColumn) {
    // The widest text column that isn't the date or a number.
    let widest = -1
    let width = 0
    first.forEach((_, i) => {
      if (i === dateColumn) return
      const cells = column(i)
      if (cells.length === 0 || cells.every((c) => parseAmountCell(c) !== null)) return
      const w = cells.reduce((n, c) => n + c.length, 0) / cells.length
      if (w > width) {
        widest = i
        width = w
      }
    })
    descriptionColumn = widest
  }
  if (descriptionColumn < 0) return null

  const amountColumn = find(AMOUNT_HEADERS)
  const debit = find(DEBIT_HEADERS)
  const credit = find(CREDIT_HEADERS)
  let amount: ColumnMap['amount'] | null = null
  if (amountColumn >= 0) amount = { mode: 'single', column: amountColumn, invert: false }
  else if (debit >= 0 && credit >= 0)
    amount = { mode: 'split', debitColumn: debit, creditColumn: credit }
  else {
    const numeric = first.findIndex(
      (_, i) =>
        i !== dateColumn &&
        column(i).length > 0 &&
        column(i).every((c) => parseAmountCell(c) !== null),
    )
    if (numeric >= 0) amount = { mode: 'single', column: numeric, invert: false }
  }
  if (!amount) return null

  return {
    hasHeader,
    delimiter: delimiter as ColumnMap['delimiter'],
    dateColumn,
    dateFormat: guessDateFormat(column(dateColumn)),
    descriptionColumn,
    amount,
  }
}
