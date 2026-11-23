import { z } from 'zod'

/**
 * CSV import: the browser uploads the file text, the server parses it with the column mapping the
 * user chose and returns a preview; nothing is saved until the user commits the reviewed rows.
 */
export const csvDelimiters = [',', ';', '\t', '|'] as const
export const dateFormats = [
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'M/D/YY',
  'D/M/YY',
  'YYYY/MM/DD',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
] as const
export type DateFormat = (typeof dateFormats)[number]

const column = z.number().int().min(0).max(49)

export const columnMapSchema = z.object({
  hasHeader: z.boolean(),
  /** Detected from the file when left out. */
  delimiter: z.enum(csvDelimiters).optional(),
  dateColumn: column,
  dateFormat: z.enum(dateFormats),
  descriptionColumn: column,
  payeeColumn: column.optional(),
  amount: z.union([
    /** One signed column. `invert` flips signs (some banks list card purchases as positive). */
    z.object({ mode: z.literal('single'), column, invert: z.boolean().default(false) }),
    /** Separate money-out and money-in columns. */
    z.object({ mode: z.literal('split'), debitColumn: column, creditColumn: column }),
  ]),
})
export type ColumnMap = z.infer<typeof columnMapSchema>

/** 6 MB of text: enough for tens of thousands of rows. */
export const MAX_CSV_CHARS = 6_000_000
export const MAX_CSV_ROWS = 20_000

const csvText = z.string().min(1).max(MAX_CSV_CHARS)

export const previewImportSchema = z.object({
  accountId: z.string().min(1),
  csv: csvText,
  /** Omit on the first call to get the detected delimiter and a suggested mapping. */
  mapping: columnMapSchema.optional(),
})

export const commitImportSchema = z.object({
  accountId: z.string().min(1),
  filename: z.string().trim().min(1).max(200),
  csv: csvText,
  mapping: columnMapSchema,
  /** Rows (as numbered in the preview) the user unchecked. */
  skipRows: z.array(z.number().int().min(1)).max(MAX_CSV_ROWS).default([]),
  /** Rows flagged as duplicates that the user chose to import anyway. */
  includeDuplicateRows: z.array(z.number().int().min(1)).max(MAX_CSV_ROWS).default([]),
})

export interface ImportPreviewRow {
  /** 1-based, counting data rows (the header is not a row). */
  rowNumber: number
  date: string | null
  amountCents: number | null
  description: string
  payee: string | null
  status: 'new' | 'duplicate' | 'invalid'
  problem: string | null
}

export interface ImportPreview {
  delimiter: string
  columnCount: number
  /** The first line, when the file seems to have a header. */
  headers: string[] | null
  /** The first few raw rows, for choosing columns. */
  sampleRows: string[][]
  suggestedMapping: ColumnMap | null
  /** Present once a mapping was supplied. */
  rows: ImportPreviewRow[]
  counts: { total: number; new: number; duplicate: number; invalid: number }
}

export interface ImportResult {
  batchId: string
  imported: number
  skipped: number
  duplicatesSkipped: number
  invalid: number
  /** How many imported transactions a rule changed. */
  rulesApplied: number
}

export interface ImportBatchView {
  id: string
  accountId: string
  filename: string
  rowCount: number
  createdAt: string
}
