import { describe, expect, it } from 'vitest'
import { policyPresets } from './deps.ts'
import { gateAnalysis } from './gate.ts'
import { allPolicies } from './policies/index.ts'
import { DEFAULT_POOLS } from './pools.ts'
import { runReplay } from './replayer.ts'
import { validateCall } from './schema.ts'
import { renderSweep, runSweep } from './sweep.ts'
import { agentSessions, synthStats } from './synth.ts'
import { catalog } from './test-helpers.ts'

describe('per-turn intent hints', () => {
  const t = agentSessions({ sessions: 30, seed: 9, altTurnShare: 0.3, turnTiers: { main: 'frontier', alt: 'standard' } })
  it('stamps valid hints on main-lineage calls only, without changing trace shape', () => {
    t.forEach((c, i) => validateCall(c, `c${i}`))
    expect(t.some((c) => c.hints?.tier === 'standard')).toBe(true)
    expect(t.filter((c) => c.lineage !== c.session).every((c) => c.hints === undefined)).toBe(true)
    const plain = agentSessions({ sessions: 30, seed: 9 })
    expect(plain.map((c) => c.promptTokens)).toEqual(t.map((c) => c.promptTokens))
  })
  it('hint-blind follows every hint; core-cost adheres less and switches less', async () => {
    const run = await runReplay(t, allPolicies(['hint-blind', 'core-cost'], { catalog, hints: 'cooperative' }), { catalog, pools: DEFAULT_POOLS })
    const [blind, core] = run.results
    expect(blind!.intentAdherence).toBe(1)
    expect(core!.intentAdherence!).toBeLessThanOrEqual(1)
    expect(core!.switches).toBeLessThanOrEqual(blind!.switches)
  })
  it('gate analysis classifies every hinted switch request', async () => {
    const g = await gateAnalysis(t, { catalog, pools: DEFAULT_POOLS, policy: policyPresets.costModeled })
    expect(g.hintedSwitches).toBe(g.allowed.turns + g.blocked.turns)
    expect(g.direction.down.allowed + g.direction.down.blocked + g.direction.up.allowed + g.direction.up.blocked).toBe(g.hintedSwitches)
    expect(g.hintedSwitches).toBeGreaterThan(0)
  })
})

describe('synthStats', () => {
  it('lands near the cited targets (research C §3) at 400 sessions', () => {
    const s = synthStats(agentSessions({ sessions: 400, seed: 2026, subagentProb: 0.04 }))
    expect(s.medianIntraTurnGapS).toBeGreaterThan(0.8)
    expect(s.medianIntraTurnGapS).toBeLessThan(2)
    expect(s.medianCrossTurnGapS).toBeGreaterThan(120)
    expect(s.medianCrossTurnGapS).toBeLessThan(240)
    expect(s.medianAppendTokens).toBeGreaterThan(600)
    expect(s.medianAppendTokens).toBeLessThan(1200)
    expect(s.medianPromptTokens).toBeGreaterThan(50_000)
    expect(s.compactedSessionShare).toBeGreaterThan(0.03)
    expect(s.compactedSessionShare).toBeLessThan(0.15)
  })
})

describe('sweep', () => {
  it('runs A and B cells and renders both sections', async () => {
    const cells = await runSweep({ catalog, pools: DEFAULT_POOLS, sessions: 8, subagentProbs: [0.08], idles: ['default'], claudeTtls: ['5m'] })
    expect(cells.filter((c) => c.scenario === 'A-subagent-intent')).toHaveLength(1)
    expect(cells.filter((c) => c.scenario === 'B-turn-intent')).toHaveLength(4)
    const md = renderSweep(cells)
    expect(md).toContain('(A) SYNTHETIC')
    expect(md).toContain('Gate analysis')
  })
})
