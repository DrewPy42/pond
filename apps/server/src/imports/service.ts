import type {
  ColumnMap,
  ImportBatchView,
  ImportPreview,
  ImportPreviewRow,
  ImportResult,
} from '@pond/shared'
import { recordAudit } from '../audit.js'
import { LedgerError, type Actor, type Deps } from '../ledger/service.js'
import { applyRulesToTransaction } from '../rules/service.js'
import type { AccountRecord } from '../repos/types.js'
import { CsvError, parseCsv } from './csv.js'
import { markDuplicates } from './duplicates.js'
import { parseRows, suggestMapping, type ParsedRow } from './mapping.js'

/**
 * CSV statement import (docs/scope-v1.md, M4). Two steps, both stateless on the server: PREVIEW
 * parses the file with the user's column mapping and flags duplicates (saving nothing); COMMIT
 * re-parses the same file and creates the reviewed rows. Duplicates are flagged, never silently
 * dropped: the user decides.
 */

const DAY = 86_400_000

function accountInSpace(d: Deps, spaceId: string, accountId: string): AccountRecord {
  const a = d.repos.accounts.findById(accountId)
  if (!a || a.primarySpaceId !== spaceId) throw new LedgerError(404, 'not_found')
  return a
}

function readCsv(csv: string, delimiter?: string) {
  try {
    return parseCsv(csv, delimiter)
  } catch (e) {
    if (e instanceof CsvError)
      throw new LedgerError(400, 'bad_csv', { message: e.message, reason: e.code })
    throw e
  }
}

interface Analysis {
  rows: ImportPreviewRow[]
  /** Parsed rows that are valid, with their duplicate flag, keyed by row number. */
  valid: (ParsedRow & { duplicate: boolean })[]
}

/** Parses with the mapping and compares against what the account already holds. */
function analyse(d: Deps, account: AccountRecord, rawRows: string[][], map: ColumnMap): Analysis {
  const parsed = parseRows(rawRows, map)
  const ok = parsed.filter((r) => r.problem === null && r.date !== null && r.amountCents !== null)
  const earliest = ok.reduce((min, r) => (r.date! < min ? r.date! : min), '9999-12-31')
  // Existing transactions from the earliest imported day on (a little earlier is harmless).
  const existing =
    ok.length === 0
      ? []
      : d.repos.transactions
          .listForAccountSince(
            account.id,
            new Date(Date.parse(`${earliest}T00:00:00Z`) - DAY).toISOString().slice(0, 10),
          )
          .filter((t) => t.txn.status === 'active')
          .map((t) => ({
            date: t.txn.date,
            amountCents: t.txn.amountCents,
            description: t.txn.descriptionRaw,
          }))
  const flags = markDuplicates(
    ok.map((r) => ({ date: r.date!, amountCents: r.amountCents!, description: r.description })),
    existing,
  )
  const dupByRow = new Map(ok.map((r, i) => [r.rowNumber, flags[i]!]))
  const rows: ImportPreviewRow[] = parsed.map((r) => ({
    rowNumber: r.rowNumber,
    date: r.date,
    amountCents: r.amountCents,
    description: r.description,
    payee: r.payee,
    status: r.problem ? 'invalid' : dupByRow.get(r.rowNumber) ? 'duplicate' : 'new',
    problem: r.problem,
  }))
  return { rows, valid: ok.map((r) => ({ ...r, duplicate: dupByRow.get(r.rowNumber) ?? false })) }
}

/** Step 1: read the file, suggest a mapping, and (once there is one) show the rows with flags. */
export function previewImport(
  d: Deps,
  spaceId: string,
  input: { accountId: string; csv: string; mapping?: ColumnMap },
): ImportPreview {
  const account = accountInSpace(d, spaceId, input.accountId)
  const { delimiter, rows: raw } = readCsv(input.csv, input.mapping?.delimiter)
  const suggestedMapping = suggestMapping(raw, delimiter)
  const columnCount = raw.reduce((n, r) => Math.max(n, r.length), 0)
  const base = {
    delimiter,
    columnCount,
    headers: suggestedMapping?.hasHeader || input.mapping?.hasHeader ? (raw[0] ?? null) : null,
    sampleRows: raw.slice(0, 6),
    suggestedMapping,
  }
  if (!input.mapping)
    return { ...base, rows: [], counts: { total: 0, new: 0, duplicate: 0, invalid: 0 } }

  const { rows } = analyse(d, account, raw, {
    ...input.mapping,
    delimiter: input.mapping.delimiter ?? (delimiter as ColumnMap['delimiter']),
  })
  const count = (s: ImportPreviewRow['status']) => rows.filter((r) => r.status === s).length
  return {
    ...base,
    rows,
    counts: {
      total: rows.length,
      new: count('new'),
      duplicate: count('duplicate'),
      invalid: count('invalid'),
    },
  }
}

/** Step 2: create the reviewed rows as transactions, then run the Space's rules on them. */
export function commitImport(
  d: Deps,
  actor: Actor,
  spaceId: string,
  input: {
    accountId: string
    filename: string
    csv: string
    mapping: ColumnMap
    skipRows: number[]
    includeDuplicateRows: number[]
  },
): ImportResult {
  const account = accountInSpace(d, spaceId, input.accountId)
  const { delimiter, rows: raw } = readCsv(input.csv, input.mapping.delimiter)
  const { rows, valid } = analyse(d, account, raw, {
    ...input.mapping,
    delimiter: input.mapping.delimiter ?? (delimiter as ColumnMap['delimiter']),
  })

  const skip = new Set(input.skipRows)
  const include = new Set(input.includeDuplicateRows)
  const chosen = valid.filter(
    (r) => !skip.has(r.rowNumber) && (!r.duplicate || include.has(r.rowNumber)),
  )
  if (chosen.length === 0) throw new LedgerError(400, 'nothing_to_import')

  const batchId = d.newId()
  const created: string[] = []
  d.repos.transaction(() => {
    d.repos.importBatches.create({
      id: batchId,
      accountId: account.id,
      filename: input.filename,
      format: 'csv',
      columnMap: input.mapping,
      status: 'done',
      rowCount: chosen.length,
      createdBy: actor.id,
    })
    for (const r of chosen) {
      const id = d.newId()
      d.repos.transactions.create(
        {
          id,
          accountId: account.id,
          source: 'csv',
          date: r.date!,
          amountCents: r.amountCents!,
          descriptionRaw: r.description,
          payee: r.payee,
          importBatchId: batchId,
        },
        [{ id: d.newId(), spaceId, amountCents: r.amountCents! }],
      )
      created.push(id)
    }
  })

  let rulesApplied = 0
  for (const id of created) if (applyRulesToTransaction(d, id).changed) rulesApplied++

  recordAudit(
    d.repos.audit,
    {
      actorId: actor.id,
      action: 'import.committed',
      targetType: 'account',
      targetId: account.id,
      spaceId,
      meta: { filename: input.filename, imported: chosen.length },
    },
    d.now(),
    d.newId,
  )
  const duplicates = rows.filter((r) => r.status === 'duplicate').length
  return {
    batchId,
    imported: chosen.length,
    skipped: valid.filter((r) => skip.has(r.rowNumber)).length,
    duplicatesSkipped: Math.max(0, duplicates - chosen.filter((r) => r.duplicate).length),
    invalid: rows.filter((r) => r.status === 'invalid').length,
    rulesApplied,
  }
}

export function listImportBatches(d: Deps, spaceId: string): ImportBatchView[] {
  const ids = d.repos.accounts.listForSpace(spaceId, { includeArchived: true }).map((a) => a.id)
  return d.repos.importBatches.listForAccounts(ids).map((b) => ({
    id: b.id,
    accountId: b.accountId,
    filename: b.filename,
    rowCount: b.rowCount,
    createdAt: b.createdAt,
  }))
}
