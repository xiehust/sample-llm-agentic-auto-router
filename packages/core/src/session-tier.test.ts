// Opt-in session-scoped tier (policy.sessionTier 'root', core design §13; task 11-07-claude-code-harbor-eval, 73's
// R1–R5): one assessor consultation per session root, and every later auto decision under the root takes the tier
// of the root lineage's current model.
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, OPUS, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, EXPLORE_SYSTEM, filler, Harness, MIN, SEC, T0, testPolicy, TOOLS, toolResult, userText } from './__fixtures__/traces.ts'
import { createEngine } from './engine.ts'
import { PolicyError, validatePolicy, type Tier } from './policy.ts'
import { InMemoryStateStore } from './store-memory.ts'
import type { AssessorResult, StateStore, TierAssessor } from './types.ts'

class FakeAssessor implements TierAssessor {
  readonly id = 'fake/v1'
  calls = 0
  constructor(public impl: () => Promise<AssessorResult>) {}
  assess(): Promise<AssessorResult> {
    this.calls++
    return this.impl()
  }
}
const ok = (tier: Tier): (() => Promise<AssessorResult>) => async () => ({ status: 'ok', tier, confidence: 0.95, audit: {}, latencyMs: 3 })
const unavailable = async (): Promise<AssessorResult> => ({ status: 'unavailable', reason: 'test', latencyMs: 3 })

const SESSION = { 'x-router-session': 'trial-1' }
const GP_SYSTEM = [{ type: 'text', text: `You are a general-purpose sub-agent.\n${filler(3000, 'gp')}` }]

function setup(impl: () => Promise<AssessorResult>, o: { sessionTier?: boolean; mode?: 'observe' | 'auto' } = {}) {
  const assessor = new FakeAssessor(impl)
  const policy = testPolicy({ userTurn: 'retain', ...(o.sessionTier === false ? {} : { sessionTier: 'root' as const }), ...(o.mode ? { mode: o.mode, observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': 'global.openai.gpt-6.1-sol', 'openai-responses': 'global.openai.gpt-6.1-sol' } } : {}) })
  const hz = new Harness(policy, { assessor, assessorMode: 'auto', assessorDowngradeFrom: ['standard', 'frontier'] }, { card: () => ({ v: 'card' }) })
  return { hz, assessor }
}
const main = (): Conversation => new Conversation().push(userText('fix the failing test'))
const sub = (system: unknown = GP_SYSTEM, model = 'auto'): Conversation => new Conversation({ system, model }).push(userText('look into the parser'))

describe('policy.sessionTier', () => {
  it('validates: absent stays absent (identical Policy), root is kept, anything else is an error', () => {
    const base = { version: 'v', mode: 'auto', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET }] } } }
    expect('sessionTier' in validatePolicy(base)).toBe(false)
    expect(validatePolicy({ ...base, sessionTier: 'root' }).sessionTier).toBe('root')
    expect(() => validatePolicy({ ...base, sessionTier: 'lineage' })).toThrow(PolicyError)
  })

  it('needs a store with the root index', () => {
    const store: StateStore = { get: async () => undefined, put: async () => undefined }
    expect(() => createEngine({ policy: testPolicy({ sessionTier: 'root' }), catalog: fixtureCatalog, store })).toThrow(/noteRoot\(\) and rootLineage\(\)/)
    expect(() => createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store })).not.toThrow()
  })
})

describe('sessionTier root: one consultation per session root', () => {
  it('R2: an explicit-model helper first does not take the root; the main loop is session-start and consults once', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    const helper = await hz.step('anthropic-messages', sub(EXPLORE_SYSTEM, HAIKU).body(), SESSION)
    expect(helper.decision).toMatchObject({ action: 'pin', model: HAIKU })
    const m = await hz.step('anthropic-messages', main().body(), SESSION, { at: T0 + SEC })
    expect(m.decision).toMatchObject({ action: 'initialize', point: 'session-start', model: OPUS })
    expect(m.decision.assessment).toMatchObject({ status: 'ok', tier: 'frontier', applied: true })
    expect((await hz.store.get(m.summary.session.lineage))!.kind).toBe('root')
    expect(assessor.calls).toBe(1)
  })

  for (const [tier, model] of [['frontier', OPUS], ['standard', SONNET], ['fast', HAIKU]] as const) {
    it(`R3: a main-model sub-agent runs at the root's tier (${tier}) without consulting`, async () => {
      const { hz, assessor } = setup(ok(tier))
      expect((await hz.step('anthropic-messages', main().body(), SESSION)).decision.model).toBe(model)
      const s = await hz.step('anthropic-messages', sub().body(), SESSION, { at: T0 + SEC })
      expect(s.decision).toMatchObject({ point: 'subagent-start', model })
      expect(s.decision.reason).toContain('via session-tier')
      expect(s.decision.assessment).toBeUndefined()
      expect(assessor.calls).toBe(1)
    })
  }

  it('R4: the main loop under a changed tools/system (a new lineage) keeps the tier, no consultation', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    await hz.step('anthropic-messages', main().body(), SESSION)
    const changed = new Conversation({ tools: [...TOOLS, { name: 'LateTool', input_schema: { type: 'object' } }] }).push(userText('fix the failing test'))
    const d = await hz.step('anthropic-messages', changed.body(), SESSION, { at: T0 + SEC })
    expect(d.decision.model).toBe(OPUS)
    expect(d.decision.reason).toContain('via session-tier')
    expect(assessor.calls).toBe(1)
  })

  it('R5: compaction and idle-expiry break points with user text keep the tier, no consultation', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    const conv = main()
    await hz.step('anthropic-messages', conv.body(), SESSION)
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'a.py'))
    expect((await hz.step('anthropic-messages', conv.body(), SESSION, { at: T0 + SEC })).decision.model).toBe(OPUS)
    const compacted = new Conversation().push(userText('summary of the earlier work'), assistantText('ok'), userText('continue'))
    const c = await hz.step('anthropic-messages', compacted.body(), { ...SESSION, 'x-router-boundary': 'compaction' }, { at: T0 + 2 * SEC })
    expect(c.decision).toMatchObject({ point: 'compaction', model: OPUS })
    compacted.push(assistantText('y'), userText('more'))
    const idle = await hz.step('anthropic-messages', compacted.body(), SESSION, { at: T0 + 60 * MIN })
    expect(idle.decision).toMatchObject({ point: 'idle-expired', model: OPUS })
    expect(assessor.calls).toBe(1)
  })

  it('no opinion at the root: the pool default for the whole session, never re-consulted', async () => {
    const { hz, assessor } = setup(unavailable)
    expect((await hz.step('anthropic-messages', main().body(), SESSION)).decision.model).toBe(SONNET)
    const s = await hz.step('anthropic-messages', sub().body(), SESSION, { at: T0 + SEC })
    expect(s.decision.model).toBe(SONNET)
    expect(assessor.calls).toBe(1)
  })

  it('a root whose first call failed: the root retry reuses its consultation; another lineage meanwhile is pending', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    const first = await hz.step('anthropic-messages', main().body(), SESSION, { status: 400 })
    expect(first.decision.model).toBe(OPUS)
    const s = await hz.step('anthropic-messages', sub().body(), SESSION, { at: T0 + SEC })
    expect(s.decision.reason).toContain('via session-tier:pending')
    expect(s.decision.model).toBe(SONNET)
    const retry = await hz.step('anthropic-messages', main().body(), SESSION, { at: T0 + 2 * SEC })
    expect(retry.decision).toMatchObject({ point: 'session-start', model: OPUS })
    expect(assessor.calls).toBe(1)
  })

  it('observe mode: no re-consultation; the session tier is the served root model (observe never acts)', async () => {
    const { hz, assessor } = setup(ok('frontier'), { mode: 'observe' })
    expect((await hz.step('anthropic-messages', main().body(), SESSION)).decision).toMatchObject({ model: SONNET, wouldChoose: OPUS })
    const s = await hz.step('anthropic-messages', sub().body(), SESSION, { at: T0 + SEC })
    expect(s.decision).toMatchObject({ model: SONNET, wouldChoose: SONNET })
    expect(s.decision.reason).toContain('via session-tier')
    expect(assessor.calls).toBe(1)
  })

  it('without the key (control): today a main-model sub-agent consults again', async () => {
    const { hz, assessor } = setup(ok('frontier'), { sessionTier: false })
    await hz.step('anthropic-messages', main().body(), SESSION)
    const s = await hz.step('anthropic-messages', sub().body(), SESSION, { at: T0 + SEC })
    expect(s.decision.point).toBe('subagent-start')
    expect(assessor.calls).toBe(2)
  })

  it('explicit models stay pinned under the key (helpers are served as requested)', async () => {
    const { hz } = setup(ok('frontier'))
    await hz.step('anthropic-messages', main().body(), SESSION)
    const h = await hz.step('anthropic-messages', sub(EXPLORE_SYSTEM, HAIKU).body(), SESSION, { at: T0 + SEC })
    expect(h.decision).toMatchObject({ action: 'pin', model: HAIKU })
  })
})

// The store type is exercised above through Harness (InMemoryStateStore implements the root index).
void InMemoryStateStore
