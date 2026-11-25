import { z } from '@pond/sdk'
import { isRealDate } from './logic.js'

export const day = z.string().refine(isRealDate, 'Use a date like 2030-06-15')
/** Optional text: trimmed, and an empty box means "nothing". */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => s || null)
/**
 * A tax ID. Formats differ between countries and kinds of ID, so only the characters and length
 * are checked. (Validation messages never repeat what was typed.)
 */
export const taxId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{3,29}$/, 'Use 4 to 30 letters, numbers, spaces or dashes')
