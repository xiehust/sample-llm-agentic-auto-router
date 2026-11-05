import type { PriceCatalog } from './deps.ts'
import type { PolicyResult } from './metrics.ts'
import type { Pools } from './pools.ts'
import type { ReplayRun } from './replayer.ts'
import type { SimConfig } from './sim.ts'

export interface ReplayReport {
  schema: 'replay-report/v1'
  meta: {
    generatedAt: string
    trace: { path: string; sha256?: string; calls: number; sessions: number; lineages: number; firstTs?: string; lastTs?: string; filter?: string }
    catalog: { version: string; asOf: string; region: string }
    sim: SimConfig
    pools: Pools
    modelMap: Record<string, string>
    attribution?: string
    notes: string[]
  }
  policies: PolicyResult[]
}

export function buildReport(run: ReplayRun, a: { tracePath: string; sha256?: string; filter?: string; catalog: PriceCatalog; sim: SimConfig; pools: Pools; attribution?: string; notes?: string[]; now?: Date }): ReplayReport {
  const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString())
  return {
    schema: 'replay-report/v1',
    meta: {
      generatedAt: (a.now ?? new Date()).toISOString(),
      trace: {
        path: a.tracePath,
        ...(a.sha256 ? { sha256: a.sha256 } : {}),
        calls: run.trace.calls,
        sessions: run.trace.sessions,
        lineages: run.trace.lineages,
        ...(run.trace.firstTs !== undefined ? { firstTs: iso(run.trace.firstTs), lastTs: iso(run.trace.lastTs) } : {}),
        ...(a.filter ? { filter: a.filter } : {}),
      },
      catalog: { version: a.catalog.version, asOf: a.catalog.asOf, region: a.catalog.region },
      sim: a.sim,
      pools: a.pools,
      modelMap: run.modelMap,
      ...(a.attribution ? { attribution: a.attribution } : {}),
      notes: a.notes ?? [],
    },
    policies: run.results,
  }
}

const usd = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(4))
const pct = (x: number) => `${(100 * x).toFixed(1)}%`
const signed = (x?: number) => (x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`)

export function renderMarkdown(r: ReplayReport): string {
  const L: string[] = []
  const t = r.meta.trace
  L.push(`Trace: ${t.path} — ${t.calls} calls, ${t.sessions} sessions${t.filter ? `, filter ${t.filter}` : ''}; catalog ${r.meta.catalog.version} (${r.meta.catalog.region})`)
  L.push('')
  L.push('| Policy | Cost $ | Δ vs recorded | Hit rate | Switches /100 calls | Tool-turn switches | Cold writes | Cold-write $ lost | Frontier / standard / fast calls |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const p of r.policies) {
    const share = (k: string) => pct((p.tierMix[k]?.calls ?? 0) / Math.max(1, p.calls))
    L.push(`| ${p.policy}${p.meta?.coreIsStub ? ' (stub core)' : ''} | ${usd(p.costUsd.total)} | ${signed(p.deltaVsRecordedPct)} | ${pct(p.hitRate)} | ${p.switchesPer100Calls.toFixed(2)} | ${p.toolTurnSwitches} | ${p.coldWriteCalls} | ${usd(p.coldWriteLostUsd)} | ${share('frontier')} / ${share('standard')} / ${share('fast')} |`)
  }
  const rec = r.policies.find((p) => p.policy === 'recorded')
  if (rec?.calibration) {
    L.push('')
    L.push('Calibration (policy `recorded`): simulated vs recorded hit rate')
    L.push('')
    L.push('| Dialect | Calls | Simulated | Recorded | Δ pp |')
    L.push('|---|---|---|---|---|')
    for (const [d, c] of Object.entries(rec.calibration)) L.push(`| ${d} | ${c!.calls} | ${pct(c!.simulatedHitRate)} | ${pct(c!.recordedHitRate)} | ${c!.deltaPp >= 0 ? '+' : ''}${c!.deltaPp.toFixed(1)} |`)
  }
  if (r.meta.notes.length) {
    L.push('')
    for (const n of r.meta.notes) L.push(`- ${n}`)
  }
  if (r.meta.attribution) {
    L.push('')
    L.push(r.meta.attribution)
  }
  return L.join('\n')
}
