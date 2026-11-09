// Line diff (LCS) for config versions; documents are a few hundred lines, so O(n·m) is fine.

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i]! }); i++; j++ }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ kind: 'del', text: x[i]! }); i++ }
    else { out.push({ kind: 'add', text: y[j]! }); j++ }
  }
  while (i < n) out.push({ kind: 'del', text: x[i++]! })
  while (j < m) out.push({ kind: 'add', text: y[j++]! })
  return out
}

/** Only changed lines with `context` unchanged lines around them ('…' marks a gap). */
export function compact(d: DiffLine[], context = 3): DiffLine[] {
  const keep = new Set<number>()
  d.forEach((l, i) => { if (l.kind !== 'same') for (let k = i - context; k <= i + context; k++) keep.add(k) })
  const out: DiffLine[] = []
  let gap = false
  d.forEach((l, i) => {
    if (keep.has(i)) { out.push(l); gap = false } else if (!gap) { out.push({ kind: 'same', text: '…' }); gap = true }
  })
  return out
}
