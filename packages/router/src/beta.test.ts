import { describe, expect, it } from 'vitest'
import type { Decision } from '@auto-router/core'
import { loadCatalog } from '@auto-router/pricing'
import { betaVeto, DEFAULT_BETA_TABLE, parseBetas, rejectedBeta, type PoolModel } from './beta.ts'
import { poolTiers } from './models.ts'
import { testPolicy } from './test-helpers.ts'

const OPUS = 'global.anthropic.claude-opus-5-5'
const SONNET = 'global.anthropic.claude-sonnet-5-5'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const POOL: PoolModel[] = [{ model: OPUS, tier: 'frontier' }, { model: SONNET, tier: 'standard' }, { model: HAIKU, tier: 'fast' }]
// Claude Code's default anthropic-beta values (none is known to be rejected by Bedrock).
const CLAUDE_CODE_BETAS = ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'fine-grained-tool-streaming-2025-05-14', 'context-management-2025-06-27']
const d = (action: Decision['action'], model: string, mode: Decision['mode'] = 'auto', wouldChoose?: string): Decision =>
  ({ action, model, point: 'user-turn', reason: 'cost: cheaper', policyVersion: 'v', mode, ...(wouldChoose ? { wouldChoose } : {}) })
// Test table: Sonnet rejects beta "s-only-bad"; every Claude rejects "all-bad".
const T = { 's-only-bad': ['*.anthropic.claude-sonnet-*'], 'all-bad-*': ['*.anthropic.claude-*'] }

describe('beta deny list', () => {
  it('treats unknown betas as allowed and matches exact keys and prefix globs', () => {
    expect(rejectedBeta(DEFAULT_BETA_TABLE, SONNET, CLAUDE_CODE_BETAS)).toBeUndefined()
    expect(rejectedBeta(DEFAULT_BETA_TABLE, SONNET, ['extended-cache-ttl-2025-04-11'])).toBe('extended-cache-ttl-2025-04-11')
    expect(rejectedBeta(T, 'jp.anthropic.claude-sonnet-5-5', ['x', 's-only-bad'])).toBe('s-only-bad')
    expect(rejectedBeta(T, OPUS, ['s-only-bad'])).toBeUndefined()
    expect(parseBetas(' a, b ,,c')).toEqual(['a', 'b', 'c'])
  })

  it("Claude Code's default betas never change an initialize onto Sonnet 5.5 (the review's Haiku regression)", () => {
    const init = d('initialize', SONNET)
    expect(betaVeto(init, CLAUDE_CODE_BETAS, { pool: POOL }).decision).toBe(init)
    const sw = d('switch', OPUS)
    expect(betaVeto(sw, CLAUDE_CODE_BETAS, { current: HAIKU, pool: POOL }).decision).toBe(sw)
  })
})

describe('beta veto: observe mode never changes the served model', () => {
  it('only re-annotates wouldChoose', () => {
    const obs = d('initialize', SONNET, 'observe', SONNET)
    const v = betaVeto(obs, ['s-only-bad'], { pool: POOL }, T)
    expect(v.decision.model).toBe(SONNET)
    expect(v.decision.action).toBe('initialize')
    expect(v.decision.wouldChoose).toBe(OPUS)
    expect(v.decision.reason).toMatch(/would-choose beta-incompatible: s-only-bad/)
    expect(v.vetoed).toBe('s-only-bad')
  })
  it('leaves observe decisions alone when wouldChoose accepts the betas', () => {
    const obs = d('retain', SONNET, 'observe', HAIKU)
    expect(betaVeto(obs, ['s-only-bad'], { pool: POOL }, T).decision).toBe(obs)
  })
})

describe('beta veto: auto mode moves only to the same or a higher tier', () => {
  it('moves a rejected Sonnet initialize up to Opus, never down to Haiku', () => {
    expect(betaVeto(d('initialize', SONNET), ['s-only-bad'], { pool: POOL }, T).decision).toMatchObject({ model: OPUS, reason: 'beta-incompatible: s-only-bad' })
  })
  it('retains the current model on a switch when it is same-or-higher tier and compatible', () => {
    const v = betaVeto(d('switch', SONNET), ['s-only-bad'], { current: OPUS, pool: POOL }, T)
    expect(v.decision).toMatchObject({ action: 'retain', model: OPUS })
  })
  it('does not retain a lower-tier current model; picks a same-or-higher tier instead', () => {
    const v = betaVeto(d('switch', SONNET), ['s-only-bad'], { current: HAIKU, pool: POOL }, T)
    expect(v.decision).toMatchObject({ action: 'switch', model: OPUS })
  })
  it('keeps the decision when no same-or-higher tier model accepts the betas', () => {
    const top = d('initialize', OPUS)
    expect(betaVeto(top, ['all-bad-1'], { pool: POOL }, T).decision).toBe(top)
    const mid = d('initialize', SONNET)
    expect(betaVeto(mid, ['all-bad-1'], { pool: POOL }, T).decision).toBe(mid)
  })
  it('never changes pins or retains', () => {
    for (const dec of [d('pin', SONNET), d('retain', SONNET)]) expect(betaVeto(dec, ['s-only-bad'], { current: OPUS, pool: POOL }, T).decision).toBe(dec)
  })
})

describe('poolTiers', () => {
  it('uses the pool override, else the catalog tier', () => {
    expect(poolTiers(testPolicy(), loadCatalog('ap-northeast-1'), 'anthropic-messages')).toEqual(POOL)
  })
})
