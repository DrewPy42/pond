/** Small helpers shared by the pad's pages. */
export const errorCode = (e: unknown): string => (e as { code?: string })?.code ?? 'error'

/** "April 2030" style month names, in the person's language. */
export const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  title: new Date(Date.UTC(2001, i, 15)).toLocaleDateString(undefined, {
    month: 'long',
    timeZone: 'UTC',
  }),
}))

export const items = (list: readonly { value: string; label: string }[]) =>
  list.map((x) => ({ value: x.value, title: x.label }))

/** Hands a text file to the browser to save. The mark at the start helps spreadsheets read accents. */
export function saveCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
