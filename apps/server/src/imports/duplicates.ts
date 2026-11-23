/**
 * Duplicate detection for CSV import (data-model.md): same account + date + amount + normalized
 * description. Matching is by COUNT, so two genuine identical purchases on one day aren't both
 * treated as one: if the account already holds one such transaction and the file has two, the
 * first is a duplicate and the second is new.
 */
export interface DupFields {
  date: string
  amountCents: number
  description: string
}

export const normalizeDescription = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export const dupKey = (t: DupFields): string =>
  `${t.date}|${t.amountCents}|${normalizeDescription(t.description)}`

/** For each incoming row, true if it matches a transaction we already hold (consuming that match). */
export function markDuplicates(
  incoming: readonly DupFields[],
  existing: readonly DupFields[],
): boolean[] {
  const available = new Map<string, number>()
  for (const e of existing) available.set(dupKey(e), (available.get(dupKey(e)) ?? 0) + 1)
  return incoming.map((row) => {
    const key = dupKey(row)
    const left = available.get(key) ?? 0
    if (left > 0) {
      available.set(key, left - 1)
      return true
    }
    return false
  })
}
