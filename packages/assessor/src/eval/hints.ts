// Replay hints export (design §10.4). A synthetic replay trace carries the true need per turn in hints.tier; this
// resamples each (lineage, turn)'s tier from the measured confusion row of that gold tier, so replay can price the
// assessor's errors. The trace is parsed as JSON only and only hints.tier is rewritten; replay is not imported.
import { readFileSync, writeFileSync } from 'node:fs'
import type { Tier } from '../contract.ts'
import type { EvalResult } from './harness.ts'
import { metrics, PRED, type Pred } from './report.ts'

const TIERS = new Set<string>(['fast', 'standard', 'frontier'])

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface HintStats { turns: number; byGold: Record<string, Record<Pred, number>>; calls: number; rewritten: number }

/** Confusion rows (gold → distribution over predictions) for one model/variant. */
export function confusionRows(results: EvalResult[], model: string, variant?: string): Record<Tier, Array<[Pred, number]>> {
  const rs = results.filter((r) => r.model === model && (variant === undefined || r.variant === variant))
  if (rs.length === 0) throw new Error(`no results for ${model}${variant ? ` / ${variant}` : ''}`)
  const c = metrics(rs).confusion
  const rows = {} as Record<Tier, Array<[Pred, number]>>
  for (const g of ['fast', 'standard', 'frontier'] as Tier[]) {
    const total = PRED.reduce((a, p) => a + c[g][p], 0)
    // A gold tier with no eval items keeps its true tier (no evidence of error).
    rows[g] = total === 0 ? [[g, 1]] : PRED.map((p) => [p, c[g][p] / total] as [Pred, number])
  }
  return rows
}

export function resampleHints(o: { tracePath: string; results: EvalResult[]; model: string; variant?: string; outPath: string; seed?: number }): HintStats {
  const rows = confusionRows(o.results, o.model, o.variant)
  const rnd = mulberry32(o.seed ?? 1)
  const draw = (gold: Tier): Pred => {
    let u = rnd()
    for (const [p, w] of rows[gold]) { if ((u -= w) < 0) return p }
    return (rows[gold].at(-1) as [Pred, number])[0]
  }
  const turnOf = new Map<string, Pred>()
  const stats: HintStats = { turns: 0, byGold: {}, calls: 0, rewritten: 0 }
  const out: string[] = []
  for (const line of readFileSync(o.tracePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const call = JSON.parse(line) as Record<string, unknown>
    if (typeof call.lineage !== 'string') throw new Error('trace call without lineage')
    stats.calls++
    const hints = (call.hints && typeof call.hints === 'object' ? call.hints : {}) as Record<string, unknown>
    const startsTurn = !turnOf.has(call.lineage) || call.lastTurn === 'user-text'
    if (startsTurn) {
      const gold = (typeof hints.tier === 'string' && TIERS.has(hints.tier) ? hints.tier : 'standard') as Tier
      const p = draw(gold)
      turnOf.set(call.lineage, p)
      stats.turns++
      const row = (stats.byGold[gold] ??= Object.fromEntries(PRED.map((x) => [x, 0])) as Record<Pred, number>)
      row[p]++
    }
    const p = turnOf.get(call.lineage) as Pred
    const next = { ...hints }
    if (p === 'fast' || p === 'standard' || p === 'frontier') next.tier = p
    else delete next.tier
    if (next.tier !== hints.tier) stats.rewritten++
    if (Object.keys(next).length) call.hints = next
    else delete call.hints
    out.push(JSON.stringify(call))
  }
  writeFileSync(o.outPath, out.join('\n') + '\n')
  return stats
}
