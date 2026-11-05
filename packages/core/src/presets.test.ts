import { loadCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, OPUS, SOL, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, Conversation, Harness, SEC, T0, userText } from './__fixtures__/traces.ts'
import { createEngine } from './engine.ts'
import { validatePolicy } from './policy.ts'
import { policyPresets } from './presets.ts'
import { InMemoryStateStore } from './store-memory.ts'

const presets = Object.entries(policyPresets)

describe('policyPresets', () => {
  it.each(presets)('%s passes validatePolicy and createEngine against the fixture catalog', (_name, p) => {
    expect(validatePolicy(p)).toEqual(p)
    expect(p.mode).toBe('auto')
    expect(p.aliases).toEqual({ auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard', 'auto:frontier': 'frontier' })
    expect(() => createEngine({ policy: p, catalog: fixtureCatalog, store: new InMemoryStateStore() })).not.toThrow()
  })

  it('versions and userTurn', () => {
    expect(policyPresets.boundaryGated).toMatchObject({ version: 'preset-boundary-gated-v1', userTurn: 'retain' })
    expect(policyPresets.costModeled).toMatchObject({ version: 'preset-cost-modeled-v2', userTurn: 'cost-gated' })
    expect(policyPresets.costModeled.pools['openai-responses']!.models).toEqual([
      { model: 'global.openai.gpt-6-astra', tier: 'frontier' },
      { model: 'global.openai.gpt-6.1-sol', tier: 'standard' },
      { model: 'global.openai.gpt-6-luna', tier: 'fast' },
    ])
  })

  it('on the same 3-user-turn trace, boundaryGated never switches at user turns; costModeled does when break-even passes', async () => {
    const run = async (name: keyof typeof policyPresets) => {
      const hz = new Harness(policyPresets[name])
      const conv = new Conversation().push(userText(`Design the schema. ${'context '.repeat(25_000)}`)) // ≈ 56K tokens
      const out = [await hz.cc(conv.body(), { 'x-router-tier': 'frontier' })]
      conv.push(assistantText('Here is the schema.'), userText('Now write the boilerplate.'))
      out.push(await hz.cc(conv.body(), { 'x-router-tier': 'fast' }, { at: T0 + 30 * SEC }))
      conv.push(assistantText('Done.'), userText('And the rest of it.'))
      out.push(await hz.cc(conv.body(), { 'x-router-tier': 'fast' }, { at: T0 + 60 * SEC }))
      return out.map((s) => s.decision)
    }
    const gated = await run('boundaryGated')
    expect(gated.map((d) => [d.point, d.action, d.model])).toEqual([
      ['session-start', 'initialize', OPUS], ['user-turn', 'retain', OPUS], ['user-turn', 'retain', OPUS],
    ])
    expect(gated[1]!.reason).toMatch(/^retain: boundary-gated; /)

    const modeled = await run('costModeled')
    expect(modeled.map((d) => [d.point, d.action, d.model])).toEqual([
      ['session-start', 'initialize', OPUS], ['user-turn', 'switch', HAIKU], ['user-turn', 'retain', HAIKU],
    ])
    expect(modeled[1]!.reason).toMatch(/^downgrade: frontier→fast /)
    expect(modeled[1]!.estimate!.stayUsd).toBeGreaterThan(modeled[1]!.estimate!.switchUsd)
  })
})

describe('policyPresets against the real @auto-router/pricing catalog (smoke)', () => {
  const catalog = loadCatalog()
  it.each(presets)('%s: createEngine accepts it and routes each dialect', async (_name, p) => {
    const engine = createEngine({ policy: p, catalog, store: new InMemoryStateStore() })
    const a = engine.summarize('anthropic-messages', new Conversation().push(userText('hi')).body(), { 'x-session-id': 's' }, T0)
    expect(await engine.decide(a)).toMatchObject({ action: 'initialize', model: SONNET })
    // separate sessions: a second lineage under the same root would be a sub-agent (fast under costModeledSubagentFast)
    const c = engine.summarize('openai-chat', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, { 'x-session-id': 's2' }, T0)
    expect(await engine.decide(c)).toMatchObject({ action: 'initialize', model: SOL })
    const r = engine.summarize('openai-responses', { model: 'auto:frontier', input: 'hi' }, { 'x-session-id': 's3' }, T0)
    expect(await engine.decide(r)).toMatchObject({ action: 'initialize', model: 'global.openai.gpt-6-astra' })
  })

  it('costModeled v2: minTurnsBeforeSwitch 1, so a hinted downgrade right after a hinted upgrade reaches the cost check', async () => {
    expect(policyPresets.costModeled.hysteresis.minTurnsBeforeSwitch).toBe(1)
    expect(policyPresets.costModeledSubagentFast.hysteresis.minTurnsBeforeSwitch).toBe(1)
    expect(policyPresets.boundaryGated.hysteresis.minTurnsBeforeSwitch).toBe(2)
    const run = async (p: typeof policyPresets.costModeled) => {
      const hz = new Harness(p)
      const conv = new Conversation().push(userText(`Plan it. ${'context '.repeat(25_000)}`))
      const out = [await hz.cc(conv.body(), { 'x-router-tier': 'standard' })]
      conv.push(assistantText('Plan.'), userText('Hard part now.'))
      out.push(await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 30 * SEC }))
      conv.push(assistantText('Done.'), userText('Easy follow-up.'))
      out.push(await hz.cc(conv.body(), { 'x-router-tier': 'fast' }, { at: T0 + 60 * SEC }))
      return out.map((s) => s.decision)
    }
    const v1 = await run(validatePolicy({ ...policyPresets.costModeled, version: 'v1-equivalent', hysteresis: { ...policyPresets.costModeled.hysteresis, minTurnsBeforeSwitch: 2 } }))
    const v2 = await run(policyPresets.costModeled)
    for (const d of [v1, v2]) expect(d[1]).toMatchObject({ action: 'switch', model: OPUS })
    expect(v1[2]!.reason).toMatch(/min-turns: \(1 < 2\)/)
    expect(v2[2]!.reason).not.toMatch(/min-turns/)
  })
})
