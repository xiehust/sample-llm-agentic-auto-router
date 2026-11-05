import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, OPUS, SONNET } from './__fixtures__/catalog.ts'
import { testPolicy } from './__fixtures__/traces.ts'
import { createEngine } from './engine.ts'
import { checkPolicyAgainstCatalog, PolicyError, POLICY_DEFAULTS, RETRYABLE_STATUS, validatePolicy } from './policy.ts'
import * as core from './index.ts'
import { InMemoryStateStore } from './store-memory.ts'

const minimal = { version: 'v1', mode: 'auto', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET }] } } }

function issuesOf(input: unknown): string[] {
  try {
    validatePolicy(input)
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError)
    return (e as PolicyError).issues
  }
  throw new Error('expected PolicyError')
}

describe('validatePolicy (scenario 21)', () => {
  it('fills defaults', () => {
    const p = validatePolicy(minimal)
    expect(p.schemaVersion).toBe(1)
    expect(p.hysteresis).toEqual(POLICY_DEFAULTS.hysteresis)
    expect(p.horizon).toEqual({ calls: 15, appendTokensPerCall: 1000, outputTokensPerCall: 250 })
    expect(p.gate.contextHeadroom).toBe(0.9)
    expect(p.cache.ttlSafetyMarginMs).toBe(15_000)
    expect(p.compaction.shrinkRatio).toBe(0.6)
    expect(p.failover.windowMs).toBe(10_000)
    expect(p.failover.profileRotateOn).toEqual([429])
    expect(p.userTurn).toBe('cost-gated')
    expect(p.aliases).toMatchObject({ auto: 'default', 'auto:fast': 'fast' })
    expect(p.portability).toEqual({
      'anthropic-thinking-signature': 'same-family', 'openai-encrypted-reasoning': 'same-model', 'kimi-reasoning-content': 'same-family',
    })
    expect(p.rules).toEqual([])
  })

  it('failover.profileRotateOn: retryable statuses only (RETRYABLE_STATUS), deduplicated; [] allowed', () => {
    expect([...RETRYABLE_STATUS]).toEqual([429, 500, 502, 503, 504])
    expect(issuesOf({ ...minimal, failover: { profileRotateOn: [501] } })).toEqual(['failover.profileRotateOn: array of retryable statuses (429, 500, 502, 503, 504) required'])
    expect(validatePolicy({ ...minimal, failover: { profileRotateOn: [429, 503, 429] } }).failover).toEqual({ windowMs: 10_000, profileRotateOn: [429, 503] })
    expect(validatePolicy({ ...minimal, failover: { profileRotateOn: [] } }).failover.profileRotateOn).toEqual([])
    for (const bad of [[400], [429.5], ['429'], 429, [600], [501], [529]]) {
      expect(issuesOf({ ...minimal, failover: { profileRotateOn: bad } })).toEqual([expect.stringMatching(/^failover\.profileRotateOn: /)])
    }
  })

  it('is idempotent on its own output', () => {
    const p = testPolicy({ userTurn: 'retain' })
    expect(validatePolicy(p)).toEqual(p)
  })

  it('aggregates every bad value', () => {
    const issues = issuesOf({
      schemaVersion: 2,
      mode: 'turbo',
      userTurn: 'sometimes',
      pools: { 'anthropic-messages': { defaultTier: 'huge', models: [{ model: SONNET, tier: 'x' }, { model: SONNET }] }, converse: {} },
      rules: [{ id: 'a', tier: 'fast', when: {} }, { id: 'a', tier: 'nope', when: { minPromptTokens: -1 } }, { id: 'c', tier: 'fast', when: { lineagekind: 'subagent' } }],
      gate: { contextHeadroom: 1.5 },
      hysteresis: { costRatio: 0.5, minTurnsBeforeSwitch: 1.5 },
      horizon: { calls: 0 },
      compaction: { shrinkRatio: 0 },
      cache: { writeTtl: { [SONNET]: '2h' } },
      portability: { x: 'anywhere' },
    })
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/^schemaVersion/),
      expect.stringMatching(/^version/),
      expect.stringMatching(/^mode/),
      expect.stringMatching(/^userTurn/),
      expect.stringMatching(/^pools\.anthropic-messages\.defaultTier/),
      expect.stringMatching(/^pools\.anthropic-messages\.models\[0\]\.tier/),
      expect.stringMatching(/^pools\.anthropic-messages\.models\[1\]\.model: duplicate/),
      expect.stringMatching(/^pools\.converse: unknown dialect/),
      expect.stringMatching(/^rules\[1\]\.id: duplicate/),
      expect.stringMatching(/^rules\[1\]\.tier/),
      expect.stringMatching(/^rules\[1\]\.when\.minPromptTokens/),
      // an unknown (e.g. misspelled) condition would otherwise make the rule match every call
      expect.stringMatching(/^rules\[2\]\.when\.lineagekind: unknown condition/),
      expect.stringMatching(/^gate\.contextHeadroom/),
      expect.stringMatching(/^hysteresis\.costRatio/),
      expect.stringMatching(/^hysteresis\.minTurnsBeforeSwitch/),
      expect.stringMatching(/^horizon\.calls/),
      expect.stringMatching(/^compaction\.shrinkRatio/),
      expect.stringMatching(/^cache\.writeTtl/),
      expect.stringMatching(/^portability\.x/),
    ]))
    expect(issues.length).toBeGreaterThanOrEqual(19)
  })

  it('observe mode requires observeDefaults for every pooled dialect', () => {
    const issues = issuesOf({ ...minimal, mode: 'observe', pools: { ...minimal.pools, 'openai-chat': { defaultTier: 'fast', models: [{ model: 'x' }] } }, observeDefaults: { 'anthropic-messages': SONNET } })
    expect(issues).toEqual(['observeDefaults.openai-chat: required in observe mode (model served for alias requests)'])
    expect(validatePolicy({ ...minimal, mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET } }).mode).toBe('observe')
  })

  it('defaults mode to observe (record-only before auto)', () => {
    expect(issuesOf({ version: 'v', pools: minimal.pools })).toEqual([expect.stringMatching(/^observeDefaults\.anthropic-messages/)])
  })

  it('checkPolicyAgainstCatalog (exported): a model the catalog lacks is named together with the catalog region', () => {
    expect(core.checkPolicyAgainstCatalog).toBe(checkPolicyAgainstCatalog)
    expect(core.PolicyError).toBe(PolicyError)
    const policy = testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET }, { model: 'eu.anthropic.claude-sonnet-5-5' }] } } })
    const other = { ...fixtureCatalog, region: 'eu-west-3' }
    let err: unknown
    try { checkPolicyAgainstCatalog(policy, other) } catch (e) { err = e }
    expect(err).toBeInstanceOf(PolicyError)
    expect((err as PolicyError).issues).toEqual([
      `pools.anthropic-messages.models[1]: model 'eu.anthropic.claude-sonnet-5-5' not in catalog ${fixtureCatalog.version} for region eu-west-3 (not offered there, or not priced yet)`,
    ])
    expect((err as PolicyError).message).toMatch(/eu\.anthropic\.claude-sonnet-5-5.*region eu-west-3/)
    expect(() => checkPolicyAgainstCatalog(testPolicy(), fixtureCatalog)).not.toThrow()
  })

  it('createEngine cross-checks pool, failover and observe-default models against the catalog', () => {
    const store = new InMemoryStateStore()
    const bad = validatePolicy({
      version: 'v', mode: 'observe',
      pools: {
        'anthropic-messages': { defaultTier: 'standard', models: [{ model: OPUS, failover: ['jp.nope'] }, { model: 'global.openai.gpt-6-luna' }] },
      },
      observeDefaults: { 'anthropic-messages': 'missing-model' },
    })
    let err: unknown
    try {
      createEngine({ policy: bad, catalog: fixtureCatalog, store })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PolicyError)
    expect((err as PolicyError).issues).toEqual([
      expect.stringContaining("failover[0]: model 'jp.nope' not in catalog"),
      expect.stringContaining("does not support anthropic-messages"),
      expect.stringContaining("observeDefaults.anthropic-messages: model 'missing-model' not in catalog"),
    ])
    expect(() => createEngine({ policy: testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'fast', models: [{ model: HAIKU }] } } }), catalog: fixtureCatalog, store })).not.toThrow()
    // a write TTL the model does not offer is rejected
    let ttlErr: unknown
    try {
      createEngine({ policy: testPolicy({ cache: { writeTtl: { [SONNET]: '30m', [OPUS]: '1h' } } }), catalog: fixtureCatalog, store })
    } catch (e) {
      ttlErr = e
    }
    expect((ttlErr as PolicyError).issues).toEqual([expect.stringMatching(/^cache\.writeTtl\.global\.anthropic\.claude-sonnet-5-5: '30m' not offered/)])
  })
})
