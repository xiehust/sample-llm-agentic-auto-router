// Tier assessor hook (parent design.md §3, approved 2026-11-04; core design.md §12).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureCatalog, HAIKU, OPUS, SOL, SONNET } from './__fixtures__/catalog.ts'
import {
  assistantText, assistantThinking, assistantToolUse, Conversation, EXPLORE_SYSTEM, filler, Harness, MIN, SEC, T0, testPolicy, toolResult, userText,
} from './__fixtures__/traces.ts'
import { ASSESS_MEMO_MAX, ASSESSOR_DEFAULTS, assessorConfig, remember } from './assess.ts'
import { createEngine } from './engine.ts'
import type { Policy, Tier } from './policy.ts'
import { InMemoryStateStore } from './store-memory.ts'
import type { AssessedTurn, AssessorResult, CardContext, DecideExtras, TierAssessor } from './types.ts'

type Impl = (card: unknown, signal: AbortSignal) => Promise<AssessorResult>

/** Counts calls; `impl` can be swapped between turns. */
class FakeAssessor implements TierAssessor {
  readonly id: string
  calls = 0
  signals: AbortSignal[] = []
  constructor(public impl: Impl, id = 'fake/v1') {
    this.id = id
  }
  assess(card: unknown, signal: AbortSignal): Promise<AssessorResult> {
    this.calls++
    this.signals.push(signal)
    return this.impl(card, signal)
  }
}
const ok = (tier: Tier | undefined, confidence = 0.9, latencyMs = 12): Impl => async () =>
  ({ status: 'ok', ...(tier ? { tier } : {}), confidence, audit: { note: 'fake' }, latencyMs })

/** A card thunk that records every CardContext it was given. */
function cardSpy(): { extras: DecideExtras; cards: CardContext[] } {
  const cards: CardContext[] = []
  return { cards, extras: { card: (ctx) => { cards.push(ctx); return { ctx } } } }
}

/** As if a gate-forced move had put the lineage on `current`, away from `from` (see gate.test.ts forcedState). */
async function forceGate(hz: Harness, lineage: string, current: string, from: string): Promise<void> {
  const st = (await hz.store.get(lineage))!
  const warm = Object.values(st.perModel)[0]!
  st.current = current
  st.perModel[current] = { ...warm, model: current }
  st.gateForced = { from, atMs: T0 }
  await hz.store.put(st)
}

function setup(impl: Impl, o: { policy?: Policy; mode?: 'off' | 'observe' | 'auto'; timeoutMs?: number; minConfidence?: number; downgradeFrom?: Tier[] } = {}) {
  const assessor = new FakeAssessor(impl)
  const spy = cardSpy()
  const hz = new Harness(o.policy ?? testPolicy(), {
    assessor,
    assessorMode: o.mode ?? 'auto',
    ...(o.timeoutMs !== undefined ? { assessorTimeoutMs: o.timeoutMs } : {}),
    ...(o.minConfidence !== undefined ? { assessorMinConfidence: o.minConfidence } : {}),
    ...(o.downgradeFrom !== undefined ? { assessorDowngradeFrom: o.downgradeFrom } : {}),
  }, spy.extras)
  return { hz, assessor, cards: spy.cards }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('assessor: consultation outcomes at session start', () => {
  it('ok with enough confidence sets the initial tier (applied)', async () => {
    const { hz, assessor, cards } = setup(ok('frontier', 0.91))
    const { decision } = await hz.cc(new Conversation().push(userText('design the system')).body())
    expect(decision).toMatchObject({ action: 'initialize', point: 'session-start', model: OPUS })
    expect(decision.reason).toMatch(/^session-start: tier=frontier via assessor\(0\.91\) → global\.anthropic\.claude-opus-5-5; /)
    expect(decision.assessment).toEqual({ assessorId: 'fake/v1', status: 'ok', tier: 'frontier', confidence: 0.91, latencyMs: 12, applied: true })
    expect(assessor.calls).toBe(1)
    expect(cards).toEqual([{ compactions: 0, lineageKind: 'root' }])
  })

  it('an opinion equal to the pool default does not change the model (applied:false)', async () => {
    const { hz } = setup(ok('standard'))
    const { decision } = await hz.cc(new Conversation().push(userText('hi')).body())
    expect(decision.model).toBe(SONNET)
    expect(decision.assessment).toMatchObject({ status: 'ok', tier: 'standard', applied: false })
  })

  it('low confidence, no tier, unavailable, invalid tier: no opinion', async () => {
    const cases: Array<[Impl, Record<string, unknown>]> = [
      [ok('frontier', 0.5), { status: 'ok', tier: 'frontier', confidence: 0.5 }],
      [ok(undefined, 0.99), { status: 'ok', confidence: 0.99 }],
      [async () => ({ status: 'unavailable', reason: 'throttled', latencyMs: 30 }), { status: 'unavailable', latencyMs: 30 }],
      [async () => ({ status: 'ok', tier: 'ultra', confidence: 0.99, audit: {}, latencyMs: 5 }) as unknown as AssessorResult, { status: 'invalid', confidence: 0.99 }],
      [async () => ({ status: 'ok', tier: 'frontier', confidence: 7, audit: {}, latencyMs: 5 }), { status: 'invalid' }],
      [async () => null as unknown as AssessorResult, { status: 'invalid' }],
      // a result whose fields throw on read is invalid, not a rejected decide()
      [async () => ({ get status(): 'ok' { throw new Error('getter') } }) as unknown as AssessorResult, { status: 'invalid' }],
    ]
    for (const [impl, expected] of cases) {
      const { hz, assessor } = setup(impl)
      const { decision } = await hz.cc(new Conversation().push(userText('hi')).body())
      expect(decision.model).toBe(SONNET)
      expect(decision.reason).toContain('via default')
      expect(decision.assessment).toMatchObject({ ...expected, applied: false })
      expect(decision.assessment?.tier === undefined || expected.tier !== undefined).toBe(true)
      expect(assessor.calls).toBe(1)
    }
  })

  it('a throwing or rejecting assess() and a throwing card thunk are errors (no opinion)', async () => {
    const sync = setup(() => { throw new Error('boom') })
    expect((await sync.hz.cc(new Conversation().push(userText('hi')).body())).decision).toMatchObject({ model: SONNET, assessment: { status: 'error', applied: false } })
    const rej = setup(async () => { throw new Error('boom') })
    expect((await rej.hz.cc(new Conversation().push(userText('hi')).body())).decision).toMatchObject({ model: SONNET, assessment: { status: 'error', applied: false } })

    const assessor = new FakeAssessor(ok('frontier'))
    const hz = new Harness(testPolicy(), { assessor, assessorMode: 'auto' }, { card: () => { throw new Error('card failed') } })
    const { decision } = await hz.cc(new Conversation().push(userText('hi')).body())
    expect(decision).toMatchObject({ model: SONNET, assessment: { status: 'error', latencyMs: 0, applied: false } })
    expect(assessor.calls).toBe(0)
  })

  it('timeout: the signal is aborted, the timer cleared, and the decision has no opinion (fake timers)', async () => {
    vi.useFakeTimers({ now: T0 })
    const { hz, assessor } = setup((_card, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    }))
    const p = hz.cc(new Conversation().push(userText('hi')).body())
    expect(ASSESSOR_DEFAULTS.timeoutMs).toBe(5000)
    await vi.advanceTimersByTimeAsync(ASSESSOR_DEFAULTS.timeoutMs - 1)
    expect(assessor.signals[0]?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const { decision } = await p
    expect(assessor.signals[0]?.aborted).toBe(true)
    expect(decision).toMatchObject({ model: SONNET, assessment: { status: 'timeout', latencyMs: 5000, applied: false } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('timeout with an assessor that ignores the signal (real short timeout); a fast answer leaves no timer behind', async () => {
    const { hz } = setup(() => new Promise(() => {}), { timeoutMs: 15 })
    const { decision } = await hz.cc(new Conversation().push(userText('hi')).body())
    expect(decision.assessment).toMatchObject({ status: 'timeout', applied: false })
    expect(decision.assessment!.latencyMs).toBeGreaterThanOrEqual(10)

    vi.useFakeTimers({ now: T0 })
    const fast = setup(ok('frontier'))
    const d = (await fast.hz.cc(new Conversation().push(userText('hi')).body())).decision
    expect(d.assessment).toMatchObject({ status: 'ok', applied: true })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('assessor: modes', () => {
  async function trace(hz: Harness) {
    const conv = new Conversation().push(userText(`start ${filler(30_000)}`))
    const out = [await hz.cc(conv.body())]
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'ok'))
    out.push(await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC }))
    conv.push(assistantText('done'), userText('next'))
    out.push(await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC }))
    return out.map((s) => s.decision)
  }

  it("'observe' audits but every decision equals the no-assessor decision", async () => {
    const base = await trace(new Harness())
    const { hz, assessor } = setup(ok('fast', 0.99), { mode: 'observe' })
    const obs = await trace(hz)
    expect(assessor.calls).toBe(2) // session start + user turn; not the tool loop
    expect(obs[0]).toEqual({ ...base[0], assessment: { assessorId: 'fake/v1', status: 'ok', tier: 'fast', confidence: 0.99, latencyMs: 12, applied: false } })
    expect(obs[1]).toEqual(base[1])
    expect(obs[2]).toEqual({ ...base[2], assessment: expect.objectContaining({ status: 'ok', tier: 'fast', applied: false }) })
  })

  it("'off', no assessor, or no card thunk: never called, no assessment, decisions unchanged", async () => {
    const base = await trace(new Harness())
    const off = setup(ok('fast', 0.99), { mode: 'off' })
    expect(await trace(off.hz)).toEqual(base)
    expect(off.assessor.calls).toBe(0)
    const assessor = new FakeAssessor(ok('fast', 0.99))
    expect(await trace(new Harness(testPolicy(), { assessor, assessorMode: 'auto' }))).toEqual(base)
    expect(await trace(new Harness(testPolicy(), { assessor, assessorMode: 'auto' }, {}))).toEqual(base)
    expect(assessor.calls).toBe(0)
  })

  it('policy observe: the opinion feeds wouldChoose, the observe default is served; a concrete model is a pin (no consultation)', async () => {
    const policy = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL } })
    const { hz, assessor } = setup(ok('frontier'), { policy })
    const { decision } = await hz.cc(new Conversation({ model: SONNET }).push(userText('hi')).body())
    expect(decision).toMatchObject({ mode: 'observe', action: 'pin', model: SONNET })
    expect(decision.wouldChoose).toBeUndefined()
    expect(decision.assessment).toBeUndefined()
    expect(assessor.calls).toBe(0)
    const alias = (await hz.step('anthropic-messages', new Conversation().push(userText('x')).body(), { 'x-session-id': 'o2' })).decision
    expect(alias).toMatchObject({ model: SONNET, wouldChoose: OPUS, assessment: { applied: true }, projected: { model: OPUS, switch: false } })
    expect(alias.reason).toMatch(/^observe-default: session-start: tier=frontier via assessor\(0\.90\)/)
  })
})

describe('assessor: caching per (lineage, user turn)', () => {
  it('a second decide for the same turn reuses the result (cached), concurrent decides share one call', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    const body = new Conversation().push(userText('hi')).body()
    const s = hz.engine.summarize('anthropic-messages', body, { 'x-claude-code-session-id': 'c' }, T0)
    const [a, b] = await Promise.all([hz.engine.decide(s, hz.extras), hz.engine.decide(s, hz.extras)])
    const c = await hz.engine.decide(s, hz.extras)
    expect(assessor.calls).toBe(1)
    expect(a.assessment?.cached).toBeUndefined()
    expect(b.assessment).toMatchObject({ cached: true, applied: true, tier: 'frontier' })
    expect(c).toEqual(b)
  })

  it('costUsd is reported once, on the decision that called the assessor; never audit, never on cached reuse', async () => {
    const { hz, assessor } = setup(async () => ({ status: 'ok', tier: 'frontier', confidence: 0.9, audit: { quote: 'untrusted prompt text' }, latencyMs: 12, costUsd: 0.0004 }))
    const s = hz.engine.summarize('anthropic-messages', new Conversation().push(userText('hi')).body(), { 'x-claude-code-session-id': 'cost' }, T0)
    const a = await hz.engine.decide(s, hz.extras)
    const b = await hz.engine.decide(s, hz.extras)
    expect(assessor.calls).toBe(1)
    expect(a.assessment).toEqual({ assessorId: 'fake/v1', status: 'ok', tier: 'frontier', confidence: 0.9, latencyMs: 12, applied: true, costUsd: 0.0004 })
    expect(b.assessment).toMatchObject({ cached: true })
    expect(b.assessment).not.toHaveProperty('costUsd')
    expect(a.assessment).not.toHaveProperty('audit')
    // a malformed costUsd is dropped, the opinion is kept
    const bad = setup(async () => ({ status: 'ok', tier: 'frontier', confidence: 0.9, audit: {}, latencyMs: 3, costUsd: -1 }))
    const { decision } = await bad.hz.cc(new Conversation().push(userText('hi')).body())
    expect(decision.assessment).toMatchObject({ status: 'ok', tier: 'frontier', applied: true })
    expect(decision.assessment).not.toHaveProperty('costUsd')
  })

  it('record persists it: another engine on the same store reuses it for a retry of the same turn', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    const body = new Conversation().push(userText('hi')).body()
    const first = await hz.cc(body)
    const st = (await hz.store.get(first.summary.session.lineage))!
    expect(st.assessed).toMatchObject({ assessorId: 'fake/v1', status: 'ok', tier: 'frontier', confidence: 0.9, latencyMs: 12 })
    expect(st.assessed!.turnKey).toMatch(/^m1:[0-9a-f]{16}$/)

    const other = new FakeAssessor(ok('fast'))
    const engine2 = createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store: hz.store, assessor: other, assessorMode: 'auto' })
    const s2 = engine2.summarize('anthropic-messages', body, { 'x-claude-code-session-id': 'sess-1' }, T0 + SEC)
    const retry = await engine2.decide(s2, cardSpy().extras)
    expect(other.calls).toBe(0)
    expect(retry.assessment).toMatchObject({ cached: true, tier: 'frontier' })
    expect(assessor.calls).toBe(1)
    // a different assessor id does not reuse it
    const third = new FakeAssessor(ok('fast'), 'fake/v2')
    const engine3 = createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store: hz.store, assessor: third, assessorMode: 'observe' })
    await engine3.decide(s2, cardSpy().extras)
    expect(third.calls).toBe(1)
  })

  it('a timeout is reused for a retry of the same turn only; the next user turn asks again', async () => {
    const { hz, assessor } = setup(() => new Promise(() => {}), { timeoutMs: 5 })
    const conv = new Conversation().push(userText('a'))
    const first = await hz.cc(conv.body(), {}, { status: 503 })
    expect(first.decision.assessment).toMatchObject({ status: 'timeout' })
    // record() persisted it on the 5xx path
    expect((await hz.store.get(first.summary.session.lineage))!.assessed).toMatchObject({ status: 'timeout', assessorId: 'fake/v1' })
    // retry of the same request after the failover window (a session-start point again): cached, not re-asked
    const retry = await hz.cc(conv.body(), {}, { at: T0 + MIN })
    expect(retry.decision).toMatchObject({ point: 'session-start', assessment: { status: 'timeout', cached: true } })
    expect(assessor.calls).toBe(1)
    assessor.impl = ok('frontier')
    conv.push(assistantText('x'), userText('b'))
    const next = await hz.cc(conv.body(), {}, { at: T0 + MIN + 10 * SEC })
    expect(next.decision).toMatchObject({ model: OPUS, assessment: { status: 'ok', applied: true } })
    expect(next.decision.assessment?.cached).toBeUndefined()
    expect(assessor.calls).toBe(2)
  })

  it('the in-engine memo is bounded (oldest entries evicted first)', () => {
    const cfg = assessorConfig({ assessor: new FakeAssessor(ok('fast')) })!
    const rec = Promise.resolve({ turnKey: 't', assessorId: 'fake/v1', status: 'ok', latencyMs: 1 } satisfies AssessedTurn)
    for (let i = 0; i < ASSESS_MEMO_MAX + 5; i++) remember(cfg, `k${i}`, rec)
    expect(cfg.memo.size).toBe(ASSESS_MEMO_MAX)
    expect(cfg.memo.has('k0')).toBe(false)
    expect(cfg.memo.has('k4')).toBe(false)
    expect(cfg.memo.has('k5')).toBe(true)
    expect(cfg.memo.has(`k${ASSESS_MEMO_MAX + 4}`)).toBe(true)
  })

  it('a new user turn calls again; tool-loop calls in between never do', async () => {
    const { hz, assessor, cards } = setup(ok('standard'))
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body())
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'x'))
    await hz.cc(conv.body(), {}, { at: T0 + SEC })
    conv.push(assistantToolUse('t2', 'ls'), toolResult('t2', 'y'))
    await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })
    expect(assessor.calls).toBe(1)
    conv.push(assistantText('done'), userText('b'))
    await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })
    expect(assessor.calls).toBe(2)
    expect(cards).toHaveLength(2)
  })
})

describe('assessor: never consulted', () => {
  it('on tool loops, response chains, pins, hint/alias tiers, rule matches and failover (card thunk untouched)', async () => {
    const { hz, assessor, cards } = setup(ok('frontier'))
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body(), { 'x-router-tier': 'standard' }) // hint
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'x'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + SEC })).decision.point).toBe('hard-lock-tool-loop')
    await hz.cc(conv.body(), { 'x-router-pin': SONNET }, { at: T0 + 2 * SEC }) // header pin
    await hz.step('anthropic-messages', new Conversation({ model: SONNET }).push(userText('p')).body(), { 'x-session-id': 'p' }) // concrete model
    await hz.step('anthropic-messages', new Conversation().push(userText('q')).body('auto:fast'), { 'x-session-id': 'q' }) // alias tier
    conv.push(assistantText('ok'), userText('b'))
    assessor.impl = ok('standard') // stay on the current model, so its 429 arms failover
    await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC, status: 429 }) // consulted (user turn), fails
    expect(assessor.calls).toBe(1)
    const fo = await hz.cc(conv.body(), {}, { at: T0 + 4 * SEC })
    expect(fo.decision.point).toBe('failover')
    expect(fo.decision.assessment).toBeUndefined()
    expect(assessor.calls).toBe(1)
    expect(cards).toHaveLength(1)

    const r = setup(ok('frontier'))
    await r.hz.step('openai-responses', { model: 'auto', input: 'plan' }, {}, { responseId: 'resp_1' })
    expect(r.assessor.calls).toBe(1)
    const chained = await r.hz.step('openai-responses', { model: 'auto', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'go' }] }, {}, { at: T0 + SEC })
    expect(chained.decision).toMatchObject({ point: 'hard-lock-response-chain' })
    const missing = await r.hz.step('openai-responses', { model: 'auto', previous_response_id: 'resp_zz', input: [{ role: 'user', content: 'go' }] }, {}, { at: T0 + 2 * SEC })
    expect(missing.decision.reason).toMatch(/^chain-state-missing: /)
    expect(r.assessor.calls).toBe(1)

    const rule = setup(ok('frontier'), { policy: testPolicy({ rules: [{ id: 'all', when: { minPromptTokens: 0 }, tier: 'fast' }] }) })
    expect((await rule.hz.cc(new Conversation().push(userText('a')).body())).decision).toMatchObject({ model: HAIKU })
    expect(rule.assessor.calls).toBe(0)
    expect(rule.cards).toHaveLength(0)
  })

  it('a session start whose last message is a tool result is not consulted', async () => {
    const { hz, assessor } = setup(ok('frontier'))
    const conv = new Conversation().push(userText('a'), assistantToolUse('t1', 'ls'), toolResult('t1', 'x'))
    expect((await hz.cc(conv.body())).decision).toMatchObject({ point: 'session-start', model: SONNET })
    expect(assessor.calls).toBe(0)
  })
})

describe('assessor: CardContext', () => {
  it('currentModel / currentTier / compactions on the main lineage; parentTier for a sub-agent', async () => {
    const { hz, cards } = setup(ok(undefined))
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }) // not consulted: hint
    expect(cards).toHaveLength(0)

    // sub-agent: same session, different system prompt → new lineage under the seen root; the parent is on Opus
    const sub = await hz.cc(new Conversation({ system: EXPLORE_SYSTEM }).push(userText('find files')).body(), {}, { at: T0 + 500 })
    expect(sub.decision.point).toBe('subagent-start')
    expect(cards.at(-1)).toEqual({ parentTier: 'frontier', compactions: 0, lineageKind: 'subagent' })

    conv.push(assistantText('x'), userText('b'))
    await hz.cc(conv.body(), {}, { at: T0 + SEC })
    expect(cards.at(-1)).toEqual({ currentModel: OPUS, currentTier: 'frontier', compactions: 0, lineageKind: 'root' })

    // compaction via hint: consulted (user text), counted by record()
    const compacted = new Conversation().push(userText('summary of earlier work'), assistantText('ok'), userText('continue'))
    const c = await hz.cc(compacted.body(), { 'x-router-boundary': 'compaction' }, { at: T0 + 2 * SEC })
    expect(c.decision.point).toBe('compaction')
    expect(cards.at(-1)).toMatchObject({ compactions: 0 })
    expect((await hz.store.get(c.summary.session.lineage))!.compactions).toBe(1)
    compacted.push(assistantText('y'), userText('more'))
    await hz.cc(compacted.body(), {}, { at: T0 + 3 * SEC })
    // with no opinion, user turns and the compaction break point use the pool default: the lineage is on Sonnet now
    expect(cards.at(-1)).toEqual({ currentModel: SONNET, currentTier: 'standard', compactions: 1, lineageKind: 'root' })
  })

  it('parentTier is left out when the store has no root index', async () => {
    const assessor = new FakeAssessor(ok(undefined))
    const spy = cardSpy()
    const store = new InMemoryStateStore()
    const bare = { get: store.get.bind(store), put: store.put.bind(store), noteRoot: store.noteRoot.bind(store) }
    const engine = createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store: bare, assessor, assessorMode: 'auto' })
    const hdr = { 'x-claude-code-session-id': 's' }
    const main = engine.summarize('anthropic-messages', new Conversation().push(userText('a')).body(), hdr, T0)
    await engine.record(main, await engine.decide(main, spy.extras), { servedModel: SONNET, status: 200 })
    const sub = engine.summarize('anthropic-messages', new Conversation({ system: EXPLORE_SYSTEM }).push(userText('b')).body(), hdr, T0 + SEC)
    expect((await engine.decide(sub, spy.extras)).point).toBe('subagent-start')
    expect(spy.cards.at(-1)).toEqual({ compactions: 0, lineageKind: 'subagent' })
  })
})

describe('assessor: tier changes mid-session (auto)', () => {
  it('an upgrade applies at once on a user turn, without the cost gate', async () => {
    const { hz, assessor } = setup(ok('standard'))
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body())
    conv.push(assistantText('x'), userText('this is hard'))
    assessor.impl = ok('frontier', 0.95)
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })
    expect(decision).toMatchObject({ action: 'switch', model: OPUS, point: 'user-turn', assessment: { tier: 'frontier', applied: true } })
    expect(decision.reason).toMatch(/^upgrade:assessor\(0\.95\): standard→frontier /)
  })

  it('an idle-expired user turn is consulted and the opinion picks the tier at the break point', async () => {
    const { hz, assessor } = setup(ok('standard'))
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body())
    conv.push(assistantText('x'), userText('back'))
    assessor.impl = ok('fast')
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })
    expect(decision).toMatchObject({ point: 'idle-expired', model: HAIKU, action: 'switch', assessment: { applied: true } })
  })

  it('a downgrade goes through the cost gate, the min-turns gate and userTurn retain', async () => {
    // Short horizon: the saving is below minUsd.
    const small = setup(ok('standard'), { policy: testPolicy({ horizon: { calls: 1 } }) })
    const conv = new Conversation().push(userText('a'))
    await small.hz.cc(conv.body())
    conv.push(assistantText('x'), userText('easy now'))
    small.assessor.impl = ok('fast')
    const d = (await small.hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'retain', model: SONNET, assessment: { tier: 'fast', applied: false } })
    expect(d.reason).toMatch(/^downgrade-rejected:cost: /)

    // Large context, right after an assessor upgrade: min-turns blocks the downgrade (frontier downgrades
    // allowed here, so the count gate is what stops it; the default guard is covered below).
    const big = setup(ok('standard'), { downgradeFrom: ['standard', 'frontier'] })
    const c2 = new Conversation().push(userText(filler(60_000)))
    await big.hz.cc(c2.body())
    c2.push(assistantText('x'), userText('hard'))
    big.assessor.impl = ok('frontier')
    expect((await big.hz.cc(c2.body(), {}, { at: T0 + 10 * SEC })).decision).toMatchObject({ action: 'switch', model: OPUS })
    c2.push(assistantText('y'), userText('easy'))
    big.assessor.impl = ok('fast')
    const m = (await big.hz.cc(c2.body(), {}, { at: T0 + 20 * SEC })).decision
    expect(m).toMatchObject({ action: 'retain', model: OPUS, assessment: { tier: 'fast', applied: false } })
    expect(m.reason).toMatch(/^downgrade-rejected:min-turns: \(1 < 2\) frontier→fast /)

    // userTurn 'retain': user turns never switch, whatever the opinion (and are not consulted, see below).
    const ret = setup(ok('standard'), { policy: testPolicy({ userTurn: 'retain' }) })
    const c3 = new Conversation().push(userText('a'))
    await ret.hz.cc(c3.body())
    c3.push(assistantText('x'), userText('hard'))
    ret.assessor.impl = ok('frontier')
    const r = (await ret.hz.cc(c3.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(r).toMatchObject({ action: 'retain', model: SONNET, reason: expect.stringMatching(/^retain: boundary-gated/) })
  })
})

describe("assessor: userTurn 'retain' consults only where the opinion can act", () => {
  const retain = () => testPolicy({ userTurn: 'retain' })

  it('a plain user turn is not consulted (no call, no card, no assessment); the session start still is', async () => {
    const { hz, assessor, cards } = setup(ok('frontier'), { policy: retain() })
    const conv = new Conversation().push(userText('a'))
    const start = (await hz.cc(conv.body())).decision
    expect(start).toMatchObject({ point: 'session-start', model: OPUS, assessment: { tier: 'frontier', applied: true } })
    expect(assessor.calls).toBe(1)
    conv.push(assistantText('x'), userText('b'))
    const turn = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(turn).toMatchObject({ action: 'retain', model: OPUS, point: 'user-turn', reason: expect.stringMatching(/^retain: boundary-gated/) })
    expect(turn.assessment).toBeUndefined()
    expect(assessor.calls).toBe(1)
    expect(cards).toHaveLength(1)
  })

  it('a break point (idle-expired) is still consulted and applied', async () => {
    const { hz, assessor } = setup(ok('standard'), { policy: retain() })
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body())
    conv.push(assistantText('x'), userText('back'))
    assessor.impl = ok('fast')
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })
    expect(decision).toMatchObject({ point: 'idle-expired', model: HAIKU, action: 'switch', assessment: { applied: true } })
    expect(assessor.calls).toBe(2)
  })

  it('a forced move (current model outside the pool) is consulted: the opinion picks the target', async () => {
    const { hz, assessor } = setup(ok('frontier'), { policy: retain() })
    const conv = new Conversation().push(userText('hi'))
    await hz.cc(conv.body(), { 'x-router-pin': 'm-pinned' })
    expect(assessor.calls).toBe(0) // pins skip it
    conv.push(assistantText('a'), userText('b'))
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'switch', model: OPUS, point: 'user-turn', reason: expect.stringMatching(/^ineligible: m-pinned → /), assessment: { tier: 'frontier' } })
    expect(assessor.calls).toBe(1)
  })

  it('a gate-forced lineage is consulted, so it recovers to the tier the assessor chose', async () => {
    const { hz, assessor } = setup(ok('fast'), { policy: testPolicy({ userTurn: 'retain', horizon: { calls: 1 } }) })
    const conv = new Conversation().push(userText('small'))
    const s = await hz.cc(conv.body())
    expect(s.decision).toMatchObject({ point: 'session-start', model: HAIKU, assessment: { applied: true } })
    // as if a later gate-forced move had put the lineage on Sonnet (see gate.test.ts forcedState)
    const st = (await hz.store.get(s.summary.session.lineage))!
    st.current = SONNET
    st.perModel[SONNET] = { ...st.perModel[HAIKU]!, model: SONNET }
    st.gateForced = { from: HAIKU, atMs: T0 }
    await hz.store.put(st)
    conv.push(assistantText('a'), userText('b'))
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'switch', model: HAIKU, point: 'user-turn', reason: expect.stringMatching(/^gate-recover: /), assessment: { tier: 'fast' } })
    expect(assessor.calls).toBe(2)
  })

  it('a gate-forced lineage is not consulted while the gate fallback holds it (nothing passes the gate)', async () => {
    const { hz, assessor } = setup(ok('standard'), { policy: testPolicy({ userTurn: 'retain' }) })
    const conv = new Conversation().push(userText('small'))
    const s = await hz.cc(conv.body())
    await forceGate(hz, s.summary.session.lineage, SONNET, HAIKU)
    // ~950K tokens: above the 0.9 headroom of every model, inside Sonnet's 1M window → gate-fallback:current
    conv.push(assistantText('a'), userText(filler(950_000)))
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'retain', model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^retain: boundary-gated; .*gate-fallback:current$/) })
    expect(d.assessment).toBeUndefined()
    expect(assessor.calls).toBe(1)
  })

  it("userTurn 'cost-gated' (the default) still consults every user-text turn", async () => {
    const { hz, assessor } = setup(ok('standard'))
    const conv = new Conversation().push(userText('a'))
    await hz.cc(conv.body())
    conv.push(assistantText('x'), userText('b'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision.assessment).toMatchObject({ status: 'ok' })
    expect(assessor.calls).toBe(2)
  })
})

describe('assessor: downgrade guard (assessorDowngradeFrom, default [standard])', () => {
  /** Session on Sonnet, an assessor upgrade to Opus, then the assessor says `then` on the next user turn. */
  async function upThen(then: Tier, o: Parameters<typeof setup>[1] = {}) {
    const x = setup(ok('standard'), { policy: testPolicy({ hysteresis: { minTurnsBeforeSwitch: 0 } }), ...o })
    const conv = new Conversation().push(userText(filler(60_000)))
    await x.hz.cc(conv.body())
    conv.push(assistantText('x'), userText('hard'))
    x.assessor.impl = ok('frontier')
    const up = (await x.hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    conv.push(assistantText('y'), userText('easy'))
    x.assessor.impl = ok(then)
    const next = (await x.hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })).decision
    return { up, next, x }
  }

  it('frontier current + assessor standard: retained, guarded, not applied', async () => {
    const { up, next } = await upThen('standard')
    expect(up).toMatchObject({ action: 'switch', model: OPUS, assessment: { applied: true } })
    expect(next).toMatchObject({ action: 'retain', model: OPUS, assessment: { tier: 'standard', applied: false, guard: 'assessor-downgrade-guarded' } })
    expect(next.reason).toMatch(/; assessor-downgrade-guarded frontier→standard$/)
  })

  it('the same downgrade is not guarded when frontier is listed (it reaches the cost gate)', async () => {
    const { next } = await upThen('standard', { downgradeFrom: ['standard', 'frontier'] })
    expect(next.assessment).not.toHaveProperty('guard')
    expect(next.reason).toMatch(/^(switch|downgrade)/)
  })

  it('standard current + assessor fast is not guarded and goes through the cost gate', async () => {
    const small = setup(ok('standard'), { policy: testPolicy({ horizon: { calls: 1 } }) })
    const conv = new Conversation().push(userText('a'))
    await small.hz.cc(conv.body())
    conv.push(assistantText('x'), userText('easy now'))
    small.assessor.impl = ok('fast')
    const d = (await small.hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d.assessment).not.toHaveProperty('guard')
    expect(d.reason).toMatch(/^downgrade-rejected:cost: /)
  })

  it('a start point with a frontier pool default guards a fast opinion; upgrades are never guarded', async () => {
    const p = testPolicy()
    const policy = { ...p, pools: { ...p.pools, 'anthropic-messages': { ...p.pools['anthropic-messages']!, defaultTier: 'frontier' as const } } }
    const g = setup(ok('fast'), { policy })
    const d = (await g.hz.cc(new Conversation().push(userText('hi')).body())).decision
    expect(d).toMatchObject({ model: OPUS, assessment: { tier: 'fast', applied: false, guard: 'assessor-downgrade-guarded' } })
    const u = setup(ok('frontier'), { downgradeFrom: [] })
    const e = (await u.hz.cc(new Conversation().push(userText('hi')).body())).decision
    expect(e).toMatchObject({ model: OPUS, assessment: { applied: true } })
    expect(e.assessment).not.toHaveProperty('guard')
  })

  it('client hint tiers are not guarded', async () => {
    const { x } = await upThen('standard')
    const conv = new Conversation().push(userText(filler(60_000)))
    const s0 = (await x.hz.cc(conv.body(), { 'x-router-tier': 'frontier', 'x-claude-code-session-id': 'h' })).decision
    conv.push(assistantText('x'), userText('easy'))
    const s1 = (await x.hz.cc(conv.body(), { 'x-router-tier': 'standard', 'x-claude-code-session-id': 'h' }, { at: T0 + 10 * SEC })).decision
    expect(s0.model).toBe(OPUS)
    expect(s1.assessment).toBeUndefined()
    expect(s1.reason).not.toMatch(/guarded/)
  })

  it('policy observe: wouldChoose reflects the guard; assessorMode observe audits the guard only', async () => {
    // In policy observe the lineage's current model is the served one, so the guard is exercised at a start
    // point whose pool default is frontier.
    const frontierDefault = (p: Policy): Policy => ({ ...p, pools: { ...p.pools, 'anthropic-messages': { ...p.pools['anthropic-messages']!, defaultTier: 'frontier' } } })
    const observeDefaults = { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL }
    const obs = setup(ok('fast'), { policy: frontierDefault(testPolicy({ mode: 'observe', observeDefaults })) })
    const d = (await obs.hz.cc(new Conversation().push(userText('hi')).body())).decision
    expect(d).toMatchObject({ mode: 'observe', model: SONNET, wouldChoose: OPUS, assessment: { tier: 'fast', guard: 'assessor-downgrade-guarded', applied: false } })
    const audit = setup(ok('fast'), { mode: 'observe', policy: frontierDefault(testPolicy()) })
    const a = (await audit.hz.cc(new Conversation().push(userText('hi')).body())).decision
    expect(a).toMatchObject({ model: OPUS, assessment: { guard: 'assessor-downgrade-guarded', applied: false } })
    expect(a.reason).not.toMatch(/guarded/)
  })

  it('a gate-forced lineage is judged from the model it was forced off, not the forced model', async () => {
    // standard forced up to frontier: a standard opinion is no downgrade (recovers), a fast one meets the guard
    // with from = standard (allowed), so neither is clamped to frontier. Recovery restores at most standard: the
    // fast downgrade waits for a later user turn and its gates.
    for (const tier of ['standard', 'fast'] as const) {
      const { hz, assessor } = setup(ok('standard'))
      const conv = new Conversation().push(userText('small'))
      const s = await hz.cc(conv.body())
      await forceGate(hz, s.summary.session.lineage, OPUS, SONNET)
      assessor.impl = ok(tier)
      conv.push(assistantText('a'), userText('b'))
      const d = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
      expect(d).toMatchObject({ action: 'switch', model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^gate-recover: /), assessment: { tier } })
      expect(d.assessment?.guard).toBeUndefined()
      expect(d.reason.includes('the downgrade waits for the usual gates')).toBe(tier === 'fast')
      expect((await hz.store.get(s.summary.session.lineage))!.gateForced).toBeUndefined()
      if (tier === 'fast') {
        // the next user turn is an ordinary downgrade decision: the count gate (min-turns after the recovery switch)
        conv.push(assistantText('c'), userText('d'))
        const next = (await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })).decision
        expect(next).toMatchObject({ action: 'retain', model: SONNET, reason: expect.stringMatching(/^downgrade-rejected:/) })
      }
    }
    // frontier forced down to standard: a standard opinion is a downgrade from frontier → guarded, the lineage
    // recovers to frontier instead of the gate move silently becoming a downgrade
    const { hz, assessor } = setup(ok('frontier'))
    const conv = new Conversation().push(userText('small'))
    const s = await hz.cc(conv.body())
    expect(s.decision.model).toBe(OPUS)
    await forceGate(hz, s.summary.session.lineage, SONNET, OPUS)
    assessor.impl = ok('standard')
    conv.push(assistantText('a'), userText('b'))
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'switch', model: OPUS, reason: expect.stringMatching(/^gate-recover: .*assessor-downgrade-guarded frontier→standard$/),
      assessment: { tier: 'standard', guard: 'assessor-downgrade-guarded', applied: false } })
  })

  it("userTurn 'retain': a held recovery restores the from tier; the next plain user turn retains (boundary-gated)", async () => {
    const { hz, assessor } = setup(ok('standard'), { policy: testPolicy({ userTurn: 'retain' }) })
    const conv = new Conversation().push(userText('small'))
    const s = await hz.cc(conv.body())
    await forceGate(hz, s.summary.session.lineage, OPUS, SONNET)
    assessor.impl = ok('fast')
    conv.push(assistantText('a'), userText('b'))
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'switch', model: SONNET, reason: expect.stringMatching(/^gate-recover: .*\(desired fast: the downgrade waits for the usual gates\)/) })
    conv.push(assistantText('c'), userText('d'))
    const next = (await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })).decision
    expect(next).toMatchObject({ action: 'retain', model: SONNET, reason: expect.stringMatching(/^retain: boundary-gated/) })
    expect(next.assessment).toBeUndefined() // plain retained user turn: not consulted
  })

  it('rejects a bad assessorDowngradeFrom', () => {
    expect(() => createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store: new InMemoryStateStore(), assessorDowngradeFrom: ['ultra' as Tier] })).toThrow(/assessorDowngradeFrom/)
  })
})

describe('assessor: auto upgrades still respect the gate, portability and hard locks', () => {
  it('a tier the context gate excludes is not chosen (applied:false)', async () => {
    // Haiku re-tiered to frontier: its 200K window fails the 0.9 headroom at ~196K tokens.
    const policy = testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: HAIKU, tier: 'frontier' }, { model: SONNET }] } } })
    const { hz, assessor } = setup(ok('frontier'), { policy })
    const { decision } = await hz.cc(new Conversation().push(userText(filler(190_000))).body())
    expect(assessor.calls).toBe(1)
    expect(decision).toMatchObject({ point: 'session-start', model: SONNET, assessment: { tier: 'frontier', applied: false } })
  })

  it('non-portable state: same-family upgrade applies; same-model makes it a hard lock (not consulted)', async () => {
    const conv = (): Conversation => new Conversation().push(userText('a'))
    const fam = setup(ok('standard'))
    const c1 = conv()
    await fam.hz.cc(c1.body())
    c1.push(assistantThinking('x'), userText('hard'))
    fam.assessor.impl = ok('frontier')
    expect((await fam.hz.cc(c1.body(), {}, { at: T0 + 10 * SEC })).decision).toMatchObject({ action: 'switch', model: OPUS, assessment: { applied: true } })

    const strict = setup(ok('standard'), { policy: testPolicy({ portability: { 'anthropic-thinking-signature': 'same-model' } }) })
    const c2 = conv()
    await strict.hz.cc(c2.body())
    c2.push(assistantThinking('x'), userText('hard'))
    strict.assessor.impl = ok('frontier')
    const d = (await strict.hz.cc(c2.body(), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'retain', model: SONNET, point: 'hard-lock-state' })
    expect(d.assessment).toBeUndefined()
    expect(strict.assessor.calls).toBe(1)
    expect(strict.cards).toHaveLength(1)
  })
})

describe('assessor: engine options', () => {
  const base = { policy: testPolicy(), catalog: fixtureCatalog, store: new InMemoryStateStore() }
  it('rejects bad timeout, confidence, mode and assessor shapes with a clear error', () => {
    const a = new FakeAssessor(ok('fast'))
    for (const bad of [{ assessorTimeoutMs: 0 }, { assessorTimeoutMs: -1 }, { assessorTimeoutMs: Number.NaN }, { assessorTimeoutMs: Infinity }]) {
      expect(() => createEngine({ ...base, assessor: a, ...bad })).toThrow(/assessorTimeoutMs must be a finite number > 0/)
    }
    for (const bad of [-0.1, 1.5, Number.NaN]) {
      expect(() => createEngine({ ...base, assessor: a, assessorMinConfidence: bad })).toThrow(/assessorMinConfidence must be a number in \[0, 1\]/)
    }
    expect(() => createEngine({ ...base, assessorMode: 'sometimes' as 'auto' })).toThrow(TypeError)
    expect(() => createEngine({ ...base, assessor: { id: '', assess: a.assess } })).toThrow(/assessor must have/)
    expect(() => createEngine({ ...base, assessor: a, assessorMinConfidence: 0, assessorTimeoutMs: 1 })).not.toThrow()
    expect(() => createEngine({ ...base, assessorMinConfidence: 1 })).not.toThrow()
  })

  it('assessorMinConfidence is honoured', async () => {
    const { hz } = setup(ok('frontier', 0.6), { minConfidence: 0.5 })
    expect((await hz.cc(new Conversation().push(userText('a')).body())).decision).toMatchObject({ model: OPUS, assessment: { applied: true } })
  })
})
