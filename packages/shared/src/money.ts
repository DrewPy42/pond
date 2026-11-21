/**
 * Money is signed integer cents. Positive = money into the account.
 * Never use floats in logic; these helpers exist for parsing and display only.
 */
export type Cents = number

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer cent amount: ${value}`)
  return value
}

/** Parse "12.34", "-12.3", "$1,234.50", "(5.00)" into cents. Throws on garbage. */
export function parseCents(input: string): Cents {
  let s = input.trim()
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[$,\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new RangeError(`Cannot parse money amount: "${input}"`)
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return assertCents(negative ? -cents : cents)
}

/** Format cents as a plain decimal string, e.g. -1234 -> "-12.34". */
export function formatCents(cents: Cents): string {
  assertCents(cents)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Sum cents exactly. */
export function sumCents(values: readonly Cents[]): Cents {
  return assertCents(values.reduce((a, b) => a + assertCents(b), 0))
}

/** True when splits add up exactly to the transaction amount (invariant, see data-model.md). */
export function splitsBalance(txnCents: Cents, splitCents: readonly Cents[]): boolean {
  return splitCents.length >= 1 && sumCents(splitCents) === assertCents(txnCents)
}

/**
 * Divide `total` into `parts` integer shares that sum exactly to `total`.
 * Remainder cents go to the earliest shares.
 */
export function allocateCents(total: Cents, parts: number): Cents[] {
  assertCents(total)
  if (!Number.isInteger(parts) || parts < 1)
    throw new RangeError('parts must be a positive integer')
  const sign = total < 0 ? -1 : 1
  const abs = Math.abs(total)
  const base = Math.floor(abs / parts)
  const rem = abs % parts
  return Array.from({ length: parts }, (_, i) => sign * (base + (i < rem ? 1 : 0)))
}
