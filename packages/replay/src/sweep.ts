import { type CacheTtl, type PriceCatalog, type Policy } from './deps.ts'
import type { PolicyResult } from './metrics.ts'
import { allPolicies, POLICY_NAMES } from './policies/index.ts'
import type { Pools } from './pools.ts'
import { runReplay } from './replayer.ts'
import type { SimConfig } from './sim.ts'
import { agentSessions, synthStats } from './synth.ts'
import { type GateAnalysis, gateAnalysis } from './gate.ts'
import { policyPresets } from './deps.ts'

export interface SweepCell {
  scenario: 'A-subagent-intent' | 'B-turn-intent'
  pair?: { main: string; alt: string }
  altTurnShare?: number
  gate?: GateAnalysis
  subagentProb: number
  idle: 'default' | 'heavy'
  claudeTtl: CacheTtl
  stats: Record<string, number>
  results: PolicyResult[]
  /** cost-modeled vs cache-blind under the same intent: (blind − modeled) / blind, in % (positive = cost-modeled cheaper) */
  advantagePct?: number
}

export interface SweepOpts {
  catalog: PriceCatalog
  pools: Pools
  sessions?: number
  seed?: number
  subagentProbs?: number[]
  idles?: ('default' | 'heavy')[]
  claudeTtls?: CacheTtl[]
  hints?: 'none' | 'cooperative'
  /** cache-blind and cost-modeled policies compared in advantagePct */
  blind?: string
  modeled?: string
}

const PAIRS = [
  { main: 'standard', alt: 'fast' },
  { main: 'frontier', alt: 'standard' },
] as const

/**
 * Synthetic sensitivity sweep. (A) sub-agent intent: intent-blind vs core-cost-subfast, over sub-agent
 * share × idle × Claude TTL. (B) per-turn intent: hint-blind vs core-cost (cooperative hints.tier), over
 * tier pair × alt-turn share × idle × Claude TTL at 8% sub-agents, with a gate analysis per cell.
 */
export async function runSweep(o: SweepOpts): Promise<SweepCell[]> {
  const claudeIds = o.catalog.models.filter((m) => m.family === 'claude').map((m) => m.modelId)
  const modeledA = o.modeled ?? (POLICY_NAMES.includes('core-cost-subfast') ? 'core-cost-subfast' : 'core-cost')
  const ttls = o.claudeTtls ?? (['5m', '1h'] as CacheTtl[])
  const idles = o.idles ?? ['default', 'heavy']
  const cells: SweepCell[] = []
  const setup = (claudeTtl: CacheTtl) => {
    const ttlMap = Object.fromEntries(claudeIds.map((id) => [id, claudeTtl])) as Record<string, CacheTtl>
    const sim: SimConfig = claudeTtl === '5m' ? {} : { ttlOverride: ttlMap }
    const corePolicy = (p: Policy): Policy => (claudeTtl === '5m' ? p : { ...p, cache: { ...p.cache, writeTtl: { ...p.cache.writeTtl, ...ttlMap } } })
    return { sim, corePolicy }
  }
  const adv = (rs: PolicyResult[], blind: string, modeled: string) => {
    const b = rs.find((r) => r.policy === blind)
    const m = rs.find((r) => r.policy === modeled)
    return b && m && b.costUsd.total > 0 ? (100 * (b.costUsd.total - m.costUsd.total)) / b.costUsd.total : undefined
  }
  const names = POLICY_NAMES.filter((n) => n !== 'recorded')
  for (const subagentProb of o.subagentProbs ?? [0.04, 0.08, 0.16]) {
    for (const idle of idles) {
      const trace = agentSessions({ sessions: o.sessions ?? 400, seed: o.seed ?? 2026, subagentProb, idle })
      for (const claudeTtl of ttls) {
        const { sim, corePolicy } = setup(claudeTtl)
        const run = await runReplay(trace, allPolicies(names, { catalog: o.catalog, hints: o.hints ?? 'cooperative', corePolicy }), { catalog: o.catalog, pools: o.pools, sim })
        const a = adv(run.results, 'intent-blind', modeledA)
        cells.push({ scenario: 'A-subagent-intent', subagentProb, idle, claudeTtl, stats: synthStats(trace), results: run.results, ...(a !== undefined ? { advantagePct: a } : {}) })
      }
    }
  }
  for (const pair of PAIRS) {
    for (const altTurnShare of [0.15, 0.3]) {
      for (const idle of idles) {
        const trace = agentSessions({ sessions: o.sessions ?? 400, seed: o.seed ?? 2026, subagentProb: 0.08, idle, altTurnShare, turnTiers: pair })
        for (const claudeTtl of ttls) {
          const { sim, corePolicy } = setup(claudeTtl)
          // Sensitivity (standard→fast only): count gates off for the (hint-driven) user-turn downgrades.
          const names = ['hint-blind', 'core-boundary', 'core-cost', ...(pair.alt === 'fast' ? ['core-cost-nocount'] : [])]
          const run = await runReplay(trace, allPolicies(names, { catalog: o.catalog, hints: 'cooperative', corePolicy }), { catalog: o.catalog, pools: o.pools, sim })
          const gate = await gateAnalysis(trace, { catalog: o.catalog, pools: o.pools, policy: corePolicy(policyPresets.costModeled), sim })
          const a = adv(run.results, 'hint-blind', 'core-cost')
          cells.push({ scenario: 'B-turn-intent', pair, altTurnShare, subagentProb: 0.08, idle, claudeTtl, stats: synthStats(trace), results: run.results, gate, ...(a !== undefined ? { advantagePct: a } : {}) })
        }
      }
    }
  }
  return cells
}

const money = (x: number) => x.toFixed(2)
const signed = (x?: number) => (x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`)

export function renderSweep(cells: SweepCell[]): string {
  const L: string[] = []
  const A = cells.filter((c) => c.scenario === 'A-subagent-intent')
  const B = cells.filter((c) => c.scenario === 'B-turn-intent')
  const modeledA = POLICY_NAMES.includes('core-cost-subfast') ? 'core-cost-subfast' : 'core-cost'
  const row = (c: SweepCell, blind: string, modeled: string, lead: string) => {
    const b = c.results.find((r) => r.policy === blind)!
    const m = c.results.find((r) => r.policy === modeled)!
    return `| ${lead} | ${c.idle} | ${c.claudeTtl} | ${money(b.costUsd.total)} | ${money(m.costUsd.total)} | ${signed(c.advantagePct)} | ${b.switchesPer100Calls.toFixed(2)} | ${m.switchesPer100Calls.toFixed(2)} | ${money(b.coldWriteLostUsd)} | ${money(m.coldWriteLostUsd)} | ${b.intentAdherence === undefined ? '—' : (100 * b.intentAdherence).toFixed(0) + '%'} | ${m.intentAdherence === undefined ? '—' : (100 * m.intentAdherence).toFixed(0) + '%'} |`
  }
  const head = (blind: string, modeled: string, first: string) => [
    `| ${first} | Idle | Claude TTL | ${blind} $ | ${modeled} $ | Advantage | ${blind} sw/100 | ${modeled} sw/100 | ${blind} cold-write $ | ${modeled} cold-write $ | ${blind} intent adherence | ${modeled} intent adherence |`,
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  const range = (cs: SweepCell[]) => {
    const xs = cs.map((c) => c.advantagePct ?? 0)
    return xs.length ? `${Math.min(...xs).toFixed(1)}% … ${Math.max(...xs).toFixed(1)}%` : '—'
  }
  L.push(`### (A) SYNTHETIC — sub-agent intent: \`intent-blind\` vs \`${modeledA}\``, '')
  L.push(...head('intent-blind', modeledA, 'Sub-agent share (realized)'))
  for (const c of A) L.push(row(c, 'intent-blind', modeledA, `${(100 * c.subagentProb).toFixed(0)}% (${(100 * (c.stats.subagentShareOfToolSteps ?? 0)).toFixed(1)}%)`))
  L.push('', `Advantage of cost-modeled (positive = cheaper): ${range(A)}.`, '')
  L.push('### (B) SYNTHETIC — per-turn intent (cooperative hints.tier): `hint-blind` vs `core-cost`', '')
  L.push(...head('hint-blind', 'core-cost', 'Pair main→alt, alt share'))
  for (const c of B) L.push(row(c, 'hint-blind', 'core-cost', `${c.pair!.main}→${c.pair!.alt}, ${(100 * c.altTurnShare!).toFixed(0)}%`))
  for (const pair of PAIRS) L.push('', `Advantage ${pair.main}→${pair.alt}: ${range(B.filter((c) => c.pair!.main === pair.main))}.`)
  const sens = B.filter((c) => c.results.some((r) => r.policy === 'core-cost-nocount'))
  if (sens.length) {
    L.push('', '#### Sensitivity (standard→fast): count gates on (defaults) vs off for hint-driven downgrades', '')
    L.push('Not a recommendation: the defaults (minTurnsBeforeSwitch 2, maxSwitchesPerLineage 6) are kept. "off" sets minTurnsBeforeSwitch 0 and no switch cap; the cost gate still applies.', '')
    L.push('| Cell | core-cost $ (defaults) | core-cost $ (count gates off) | Δ off vs defaults | sw/100 defaults | sw/100 off | cold-write $ defaults | cold-write $ off | intent adherence defaults | intent adherence off |')
    L.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const c of sens) {
      const d = c.results.find((r) => r.policy === 'core-cost')!
      const n = c.results.find((r) => r.policy === 'core-cost-nocount')!
      const ad = (x?: number) => (x === undefined ? '—' : (100 * x).toFixed(0) + '%')
      L.push(`| ${(100 * c.altTurnShare!).toFixed(0)}% ${c.idle} ${c.claudeTtl} | ${money(d.costUsd.total)} | ${money(n.costUsd.total)} | ${signed((100 * (n.costUsd.total - d.costUsd.total)) / d.costUsd.total)} | ${d.switchesPer100Calls.toFixed(2)} | ${n.switchesPer100Calls.toFixed(2)} | ${money(d.coldWriteLostUsd)} | ${money(n.coldWriteLostUsd)} | ${ad(d.intentAdherence)} | ${ad(n.intentAdherence)} |`)
    }
  }
  L.push('', '#### Gate analysis (core-cost, per hinted switch request at a user turn; cost = that turn + the lineage\'s next turn)', '')
  L.push('| Cell | Requests | Allowed (down/up) | Blocked (down/up) | Allowed: core $ vs blind $ | Blocked: core $ vs blind $ | Blocked turn calls p50/p90 | Blocked prompt p50/p90 | Block reasons |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const c of B) {
    const g = c.gate!
    L.push(`| ${c.pair!.main}→${c.pair!.alt} ${(100 * c.altTurnShare!).toFixed(0)}% ${c.idle} ${c.claudeTtl} | ${g.hintedSwitches} | ${g.direction.down.allowed}/${g.direction.up.allowed} | ${g.direction.down.blocked}/${g.direction.up.blocked} | ${money(g.allowed.coreUsd)} vs ${money(g.allowed.blindUsd)} | ${money(g.blocked.coreUsd)} vs ${money(g.blocked.blindUsd)} | ${g.blocked.turnCalls.p50}/${g.blocked.turnCalls.p90} | ${Math.round(g.blocked.promptTokens.p50 / 1000)}K/${Math.round(g.blocked.promptTokens.p90 / 1000)}K | ${Object.entries(g.blockedByReason).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} |`)
  }
  return L.join('\n')
}
