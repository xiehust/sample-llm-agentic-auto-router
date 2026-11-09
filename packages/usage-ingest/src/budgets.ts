// Budget hard stops (PRD R7, design 0.15, a3 §3): after a batch commits, re-evaluate every principal it touched plus
// every principal already in identity/budget-blocks.json, and rewrite the file only when the set changed.
// Spend = list price of model calls + assessor consultations this calendar month (UTC), from the B# TOTAL item.
// Unmetered calls (0.3c) have no spend, only an approximate bound, so they never count against a budget.
import type { BlocksStore, BudgetBlock, BudgetBlocksDoc, BudgetSetting, BudgetSource, UsageStore } from './types.ts'

export interface BudgetDeps {
  source: BudgetSource
  blocks: BlocksStore
  store: UsageStore
  now: () => number
}

export interface BudgetReport { evaluated: number; blocked: number; written: boolean; conflicts: number; unblockable: number }

const MAX_CONFLICTS = 5
/** The router's block-list id rule (identity.ts parseBlockList): one entry outside it rejects the whole file. */
const ROUTER_ID = /^[\w-]{1,128}$/

export function effective(member: BudgetSetting | undefined, fallback: BudgetSetting | undefined): { limitNano?: number; hardStop: boolean } {
  const monthly = member && member.monthlyUsd !== undefined ? member.monthlyUsd : fallback?.monthlyUsd
  const hardStop = member?.hardStop ?? fallback?.hardStop ?? false
  return typeof monthly === 'number' && Number.isFinite(monthly) && monthly >= 0 ? { limitNano: Math.round(monthly * 1e9), hardStop } : { hardStop }
}

const sameSet = (a: BudgetBlock[], b: BudgetBlock[]): boolean =>
  a.length === b.length && a.every((x, i) => {
    const y = b[i]
    return !!y && x.kind === y.kind && x.id === y.id && x.month === y.month && x.limitUsd === y.limitUsd
  })

export async function evaluateBudgets(touched: Iterable<string>, deps: BudgetDeps): Promise<BudgetReport> {
  const report: BudgetReport = { evaluated: 0, blocked: 0, written: false, conflicts: 0, unblockable: 0 }
  for (;;) {
    const cur = await deps.blocks.read()
    const month = new Date(deps.now()).toISOString().slice(0, 7)
    const at = new Date(deps.now()).toISOString()
    const candidates = new Set<string>()
    for (const p of touched) if (p.startsWith('user:') || p.startsWith('client:')) candidates.add(p)
    for (const b of cur?.doc.principals ?? []) candidates.add(`${b.kind}:${b.id}`)
    const list = [...candidates].sort()
    report.evaluated = list.length
    if (list.length === 0) return report
    const [{ members, fallback }, totals] = await Promise.all([
      deps.source.get(list),
      deps.store.getCounters(list.map((p) => ({ pk: `B#${p}#${month}`, sk: 'TOTAL' }))),
    ])
    const prev = new Map((cur?.doc.principals ?? []).map((b) => [`${b.kind}:${b.id}`, b]))
    const next: BudgetBlock[] = []
    for (const p of list) {
      const e = effective(members.get(p), fallback)
      if (!e.hardStop || e.limitNano === undefined) continue
      const t = totals.get(`B#${p}#${month}|TOTAL`) ?? {}
      const spent = (t.spend ?? 0) + (t.asr ?? 0)
      if (spent < e.limitNano) continue
      const sep = p.indexOf(':')
      const kind = p.slice(0, sep) as BudgetBlock['kind']
      if (!ROUTER_ID.test(p.slice(sep + 1))) {
        report.unblockable += 1 // over budget, but an id the router's block list cannot carry: never poison the file
        continue
      }
      const old = prev.get(p)
      next.push({ kind, id: p.slice(sep + 1), reason: 'budget', month, at: old && old.month === month ? old.at : at,
        spentUsd: spent / 1e9, limitUsd: e.limitNano / 1e9 })
    }
    report.blocked = next.length
    const before = [...(cur?.doc.principals ?? [])].sort((x, y) => `${x.kind}:${x.id}`.localeCompare(`${y.kind}:${y.id}`))
    if (cur && sameSet(before, next)) return report
    if (!cur && next.length === 0) return report
    const doc: BudgetBlocksDoc = { schemaVersion: 1, generatedAt: at, principals: next }
    if (await deps.blocks.write(doc, cur?.etag) === 'ok') {
      report.written = true
      return report
    }
    report.conflicts += 1
    if (report.conflicts >= MAX_CONFLICTS) throw new Error('budget-blocks.json: too many concurrent writers')
  }
}
