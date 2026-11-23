import { MAX_CSV_ROWS, csvDelimiters } from '@pond/shared'

export class CsvError extends Error {
  constructor(
    public code: 'empty' | 'too_many_rows' | 'too_many_columns' | 'unterminated_quote',
    message: string,
  ) {
    super(message)
  }
}

const MAX_COLUMNS = 50

/** Counts a delimiter outside quotes on one line. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false
  let n = 0
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === delimiter && !inQuotes) n++
  }
  return n
}

/** The delimiter that splits the first lines into the same, largest number of columns. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, 6)
  let best = ','
  let bestScore = 0
  for (const d of csvDelimiters) {
    const counts = lines.map((l) => countOutsideQuotes(l, d))
    const first = counts[0] ?? 0
    if (first === 0) continue
    const consistent = counts.filter((c) => c === first).length
    const score = first * consistent
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

/**
 * A small RFC 4180 CSV reader: quoted fields, `""` for a quote inside quotes, line breaks inside
 * quotes, LF / CRLF / CR line ends, an optional byte-order mark. Cells are trimmed. Empty lines
 * are skipped. Limits protect the server from huge uploads.
 */
export function parseCsv(
  input: string,
  delimiter?: string,
): { delimiter: string; rows: string[][] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const d = delimiter ?? detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let sawContent = false

  const endCell = () => {
    row.push(cell.trim())
    cell = ''
    if (row.length > MAX_COLUMNS)
      throw new CsvError('too_many_columns', `More than ${MAX_COLUMNS} columns.`)
  }
  const endRow = () => {
    endCell()
    if (row.some((c) => c !== '')) {
      rows.push(row)
      if (rows.length > MAX_CSV_ROWS + 1)
        throw new CsvError('too_many_rows', `More than ${MAX_CSV_ROWS} rows.`)
    }
    row = []
    sawContent = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell.trim() === '') {
      inQuotes = true
      sawContent = true
    } else if (ch === d) {
      endCell()
      sawContent = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      cell += ch
      sawContent = true
    }
  }
  if (inQuotes) throw new CsvError('unterminated_quote', 'A quoted value was never closed.')
  if (sawContent || cell !== '' || row.length > 0) endRow()
  if (rows.length === 0) throw new CsvError('empty', 'The file has no rows.')
  return { delimiter: d, rows }
}
