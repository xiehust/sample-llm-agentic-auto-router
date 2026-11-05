import { describe, expect, it } from 'vitest'
import { allPolicies, POLICY_NAMES, scripted, toSummary } from './policies/index.ts'
import { BlockHasher } from './prefix.ts'
import { DEFAULT_POOLS, resolveTraceModel } from './pools.ts'
import { runReplay } from './replayer.ts'
import { agentSessions, breakEvenCalls } from './synth.ts'
import { catalog, HAIKU, OPUS } from './test-helpers.ts'

const trace = agentSessions({ sessions: 12, seed: 11 })
const byName = async () => {
  const run = await runReplay(trace, allPolicies(POLICY_NAMES, { catalog, hints: 'cooperative' }), { catalog, pools: DEFAULT_POOLS })
  return Object.fromEntries(run.results.map((r) => [r.policy, r]))
}

describe('policies on synthetic agent sessions', async () => {
  const r = await byName()
  it('all policies replay every call', () => {
    for (const n of POLICY_NAMES) expect(r[n]!.calls).toBe(trace.length)
  })
  it('sticky-session and always-* never switch', () => {
    for (const n of ['sticky-session', 'always-frontier', 'always-cheap', 'recorded']) expect(r[n]!.switches).toBe(0)
  })
  it('cache-blind classifier switches inside tool loops and pays cold writes', () => {
    expect(r.classifier!.toolTurnSwitches).toBeGreaterThan(0)
    expect(r.classifier!.coldWriteCalls).toBeGreaterThan(r['always-frontier']!.coldWriteCalls)
    expect(r.classifier!.hitRate).toBeLessThan(r['always-frontier']!.hitRate)
  })
  it('agent sessions are cache-friendly when pinned (hit rate > 80%)', () => expect(r['always-frontier']!.hitRate).toBeGreaterThan(0.8))
  it('always-cheap costs less than always-frontier', () => expect(r['always-cheap']!.costUsd.total).toBeLessThan(r['always-frontier']!.costUsd.total))
  it('delta vs recorded is reported', () => expect(r.recorded!.deltaVsRecordedPct).toBe(0))
  it('core policies run end to end and record decision points', () => {
    expect(r['core-cost']!.decisionPoints).toBeDefined()
    expect(r['core-boundary']!.meta).toMatchObject({ hints: 'cooperative' })
  })
})

describe('replayer guards', () => {
  it('rejects time-unordered traces', async () => {
    const c = breakEvenCalls({ contextTokens: 10_000, steps: 2 })
    await expect(runReplay([c[1]!, c[0]!], [scripted(OPUS, OPUS, 0)], { catalog, pools: DEFAULT_POOLS })).rejects.toThrow(/time-ordered/)
  })
  it('scripted switch is counted once, with a cold write', async () => {
    const c = breakEvenCalls({ contextTokens: 50_000, steps: 5 })
    const run = await runReplay(c, [scripted(OPUS, HAIKU, 2)], { catalog, pools: DEFAULT_POOLS })
    expect(run.results[0]).toMatchObject({ switches: 1, toolTurnSwitches: 1, coldWriteCalls: 1 })
  })
})

describe('resolveTraceModel', () => {
  const res = (raw: string, d: 'anthropic-messages' | 'openai-responses' = 'anthropic-messages') => resolveTraceModel(raw, d, catalog, DEFAULT_POOLS)
  it('maps TraceLab names', () => {
    expect(res('claude-opus-4-7')).toEqual({ id: 'global.anthropic.claude-opus-4-7', via: 'global-id' })
    expect(res('claude-haiku-4-5-20251001')).toEqual({ id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', via: 'prefix' })
    expect(res('claude-sonnet-4-6').via).toBe('keyword:standard')
    expect(res('gpt-5.6-sol', 'openai-responses')).toEqual({ id: 'global.openai.gpt-5.6-sol', via: 'global-id' })
    expect(res('gpt-5.3-codex-spark', 'openai-responses').via).toBe('keyword:fast')
    expect(res('gpt-5.5', 'openai-responses')).toEqual({ id: 'global.openai.gpt-5.6-sol', via: 'fallback' })
  })
})

describe('toSummary (design §2.1)', () => {
  const base = breakEvenCalls({ contextTokens: 10_000, steps: 1 })[1]!
  it('template family comes from the template segment', () => {
    const s = toSummary(base, new BlockHasher(), 'none')
    expect(s.prefix.toolsHash).toBe('tools:tpl:be')
    expect(s.requestedModel).toBe('auto')
    expect(s.prefix).toMatchObject({ estPromptTokens: base.promptTokens, messageCount: 2 })
  })
  it('without a template, conversation segment ids do not become the template family', () => {
    const a = { ...base, prefix: { segments: [{ id: 'L:s0', tokens: base.promptTokens }], templateTokens: 0 } }
    const b = { ...base, prefix: { segments: [{ id: 'L:s1', tokens: base.promptTokens }], templateTokens: 0 } }
    const h = new BlockHasher()
    expect(toSummary(a, h, 'none').prefix.toolsHash).toBe(toSummary(b, h, 'none').prefix.toolsHash)
  })
})

describe('intent-blind', () => {
  it('routes sub-agent lineages to fast and main to standard, per request', async () => {
    const t = agentSessions({ sessions: 10, seed: 5, subagentProb: 0.3 })
    const run = await runReplay(t, allPolicies(['intent-blind'], { catalog, hints: 'none' }), { catalog, pools: DEFAULT_POOLS })
    const r = run.results[0]!
    expect(r.tierMix.fast?.calls ?? 0).toBeGreaterThan(0)
    expect(r.tierMix.standard?.calls ?? 0).toBeGreaterThan(0)
    expect(r.tierMix.frontier).toBeUndefined()
    expect(r.switches).toBe(0) // intent is per lineage, so no in-lineage switches
  })
})

describe('core-cost-nocount (sensitivity variant)', () => {
  it('turns off only the count gates of costModeled', async () => {
    const { policyPresets } = await import('./deps.ts')
    const { withoutCountGates, makePolicy } = await import('./policies/index.ts')
    const p = withoutCountGates(policyPresets.costModeled)
    expect(p.hysteresis.minTurnsBeforeSwitch).toBe(0)
    expect(p.hysteresis.maxSwitchesPerLineage).toBe(Number.MAX_SAFE_INTEGER)
    expect(p.hysteresis.costRatio).toBe(policyPresets.costModeled.hysteresis.costRatio)
    expect(p.hysteresis.minUsd).toBe(policyPresets.costModeled.hysteresis.minUsd)
    expect(makePolicy('core-cost-nocount', { catalog, hints: 'cooperative' }).name).toBe('core-cost-nocount')
    expect(POLICY_NAMES).not.toContain('core-cost-nocount')
  })
})
