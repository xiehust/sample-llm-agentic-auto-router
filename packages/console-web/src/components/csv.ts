// CSV export of what a table shows (4f: Usage, Savings, Decisions, Audit). Generated in the browser from the loaded
// rows, so it needs no extra API. Cells are quoted, and values that a spreadsheet would execute (=, +, -, @ at the
// start) are prefixed with a quote (CSV injection).

export type Cell = string | number | boolean | undefined | null

export function csvCell(v: Cell): string {
  if (v === undefined || v === null) return ''
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !(typeof v === 'number')) s = `'${s}`
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

/** Header lines (e.g. catalog version and filters, each prefixed with '#') then a header row and the rows. */
export function toCsv(meta: string[], header: string[], rows: Cell[][]): string {
  const lines = [...meta.map((m) => `# ${m.replace(/[\r\n]+/g, ' ')}`), header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))]
  return `﻿${lines.join('\r\n')}\r\n`
}

export function download(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
