import { SimpleFinError } from './types.js'

/**
 * SimpleFIN sends amounts as decimal strings ("-12.34"). Converted without floating point.
 * Extra decimal places are allowed only when they are zeros ("12.3400"); a real fraction of a
 * cent is refused rather than rounded, so money is never silently changed.
 */
export function decimalStringToCents(input: string): number {
  const m = /^([+-]?)(\d{1,13})(?:\.(\d+))?$/.exec(input.trim())
  if (!m) throw new SimpleFinError('bad_response', `Not a money amount: "${input}"`)
  const [, sign, whole, frac = ''] = m
  if (/[1-9]/.test(frac.slice(2))) {
    throw new SimpleFinError('bad_response', `Amount has a fraction of a cent: "${input}"`)
  }
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new SimpleFinError('bad_response', 'Amount is too large')
  return sign === '-' ? -cents : cents
}
