import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, LUNA, OPUS, SOL, SONNET } from './__fixtures__/catalog.ts'
import {
  assistantText, assistantThinking, assistantToolUse, Conversation, EXPLORE_SYSTEM, Harness, MIN, SEC, T0, testPolicy,
  toolResult, TOOLS, userText,
} from './__fixtures__/traces.ts'
import { NoEligibleModelError } from './decide.ts'
import { createEngine } from './engine.ts'
import { InMemoryStateStore } from './store-memory.ts'
import { summarize } from './summarize/index.ts'

const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`
const FRONTIER = { 'x-router-tier': 'frontier' }

describe('decide: session start and rules (scenario 1)', () => {
  it('initializes on the pool default tier', async () => {
    const hz = new Harness()
    const { decision } = await hz.cc(new Conversation().push(userText('hello')).body())
    expect(decision).toMatchObject({ action: 'initialize', point: 'session-start', model: SONNET, mode: 'auto', policyVersion: 'test-v1' })
    expect(decision.reason).toMatch(/^session-start: tier=standard via default → global\.anthropic\.claude-sonnet-5-5; family=[0-9a-f]{12} est=\d+$/)
  })
  it('a matching rule picks the tier; alias tiers apply', async () => {
    const hz = new Harness(testPolicy({ rules: [{ id: 'big', when: { minPromptTokens: 20_000 }, tier: 'frontier' }] }))
    const d = (await hz.cc(new Conversation().push(userText(big(30_000))).body())).decision
    expect(d).toMatchObject({ action: 'initialize', model: OPUS })
    expect(d.reason).toContain('via rule:big')
    const fast = (await hz.step('anthropic-messages', new Conversation().push(userText('hi')).body('auto:fast'), { 'x-session-id': 'other' })).decision
    expect(fast).toMatchObject({ model: HAIKU })
    expect(fast.reason).toContain('via alias')
  })
  it('rules can match requestedModel prefixes and agent ids', async () => {
    const hz = new Harness(testPolicy({
      aliases: { auto: 'default', 'auto-claude-x': 'default' },
      rules: [{ id: 'agent', when: { agentId: ['explore'] }, tier: 'fast' }, { id: 'pfx', when: { requestedModel: ['auto-claude*'] }, tier: 'frontier' }],
    }))
    expect((await hz.cc(new Conversation().push(userText('a')).body(), { 'x-router-agent-id': 'explore' })).decision.model).toBe(HAIKU)
    expect((await hz.step('anthropic-messages', new Conversation().push(userText('b')).body('auto-claude-x'), { 'x-session-id': 'z' })).decision.model).toBe(OPUS)
  })
  it('the context gate excludes small windows; with nothing left it falls back to the largest window', async () => {
    const hz = new Harness(testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'fast', models: [{ model: HAIKU }, { model: SONNET }] } } }))
    const d = (await hz.cc(new Conversation().push(userText(big(190_000))).body())).decision
    expect(d.model).toBe(SONNET) // Haiku's 200K × 0.9 is too small
    const only = new Harness(testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'fast', models: [{ model: HAIKU }] } } }))
    const g = (await only.cc(new Conversation().push(userText(big(190_000))).body())).decision
    expect(g.model).toBe(HAIKU)
    expect(g.reason).toMatch(/; gate-fallback$/)
  })
  it('throws NoEligibleModelError for an alias without a pool', async () => {
    const policy = testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET }] } } })
    const engine = createEngine({ policy, catalog: fixtureCatalog, store: new InMemoryStateStore() })
    const s = engine.summarize('openai-chat', { model: 'auto', messages: [{ role: 'user', content: 'x' }] }, {}, T0)
    await expect(engine.decide(s)).rejects.toBeInstanceOf(NoEligibleModelError)
  })
})

describe('decide: hard locks', () => {
  it('scenario 2: tool loop stays on the current model even when the desired tier changes', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('fix it'))
    await hz.cc(conv.body())
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'a b c'))
    const { decision } = await hz.cc(conv.body(), FRONTIER, { at: T0 + 2 * SEC })
    expect(decision).toMatchObject({ action: 'retain', model: SONNET, point: 'hard-lock-tool-loop' })
    expect(decision.reason).toMatch(/^hard-lock: tool loop; /)
  })

  it('scenario 3: Responses previous_response_id locks the chain, incl. the headerless resp: alias chain', async () => {
    const hz = new Harness()
    const r1 = await hz.step('openai-responses', { model: 'auto', input: 'plan the migration' }, {}, { responseId: 'resp_1' })
    expect(r1.decision).toMatchObject({ action: 'initialize', model: SOL })
    const r2 = await hz.step('openai-responses', { model: 'auto', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'now do it fast' }] },
      { 'x-router-tier': 'fast' }, { at: T0 + 5 * SEC, responseId: 'resp_2' })
    expect(r2.summary.session.lineage).toBe('resp:resp_1')
    expect(r2.decision).toMatchObject({ action: 'retain', model: SOL, point: 'hard-lock-response-chain' })
    const r3 = await hz.step('openai-responses', { model: 'auto', previous_response_id: 'resp_2', input: [{ type: 'function_call_output', call_id: 'c', output: 'ok' }] },
      FRONTIER, { at: T0 + 9 * SEC })
    expect(r3.decision).toMatchObject({ action: 'retain', model: SOL, point: 'hard-lock-tool-loop' })
    const r4 = await hz.step('openai-responses', { model: 'auto', previous_response_id: 'resp_2', input: [{ role: 'user', content: 'and?' }] },
      FRONTIER, { at: T0 + 12 * SEC })
    expect(r4.decision).toMatchObject({ model: SOL, point: 'hard-lock-response-chain' })
  })

  it('scenario 4: encrypted reasoning (same-model) leaves only the current model → hard-lock-state', async () => {
    const hz = new Harness()
    const hdr = { 'x-session-id': 'resp-sess' }
    const items: unknown[] = [{ role: 'user', content: 'q' }]
    await hz.step('openai-responses', { model: 'auto', store: false, input: items }, hdr)
    items.push({ type: 'reasoning', id: 'rs', encrypted_content: 'gAAAA' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] }, { role: 'user', content: 'q2' })
    const { decision } = await hz.step('openai-responses', { model: 'auto', store: false, input: items }, { ...hdr, 'x-router-tier': 'fast' }, { at: T0 + 30 * SEC })
    expect(decision).toMatchObject({ action: 'retain', model: SOL, point: 'hard-lock-state' })
    expect(decision.reason).toMatch(/^hard-lock: non-portable state openai-encrypted-reasoning; /)
  })

  it('thinking signatures: same-family by default (Claude pool can move), same-model when configured', async () => {
    const run = async (hz: Harness) => {
      const conv = new Conversation().push(userText(big(2000)))
      await hz.cc(conv.body())
      conv.push(assistantThinking('answer'), userText('next'))
      return (await hz.cc(conv.body(), FRONTIER, { at: T0 + 10 * SEC })).decision
    }
    expect(await run(new Harness())).toMatchObject({ action: 'switch', model: OPUS, point: 'user-turn' })
    const locked = await run(new Harness(testPolicy({ portability: { 'anthropic-thinking-signature': 'same-model' } })))
    expect(locked).toMatchObject({ action: 'retain', model: SONNET, point: 'hard-lock-state' })
  })
})

describe('decide: free break points', () => {
  it('scenario 7: idle > TTL is a free switch to the desired tier', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(50_000)))
    await hz.cc(conv.body(), FRONTIER)
    conv.push(assistantText('ok'), userText('more'))
    const { decision } = await hz.cc(conv.body(), {}, { at: T0 + 6 * MIN })
    expect(decision).toMatchObject({ action: 'switch', model: SONNET, point: 'idle-expired' })
    expect(decision.estimate).toBeUndefined()
    // within TTL − margin it is a user turn, not a break point
    const hz2 = new Harness()
    const c2 = new Conversation().push(userText(big(50_000)))
    await hz2.cc(c2.body(), FRONTIER)
    c2.push(assistantText('ok'), userText('more'))
    expect((await hz2.cc(c2.body(), {}, { at: T0 + 4 * MIN })).decision.point).toBe('user-turn')
    // the safety margin: 5m − 15s is already expired
    const hz3 = new Harness()
    const c3 = new Conversation().push(userText(big(50_000)))
    await hz3.cc(c3.body(), FRONTIER)
    c3.push(assistantText('ok'), userText('more'))
    expect((await hz3.cc(c3.body(), {}, { at: T0 + 5 * MIN - 10 * SEC })).decision.point).toBe('idle-expired')
  })

  it('scenario 8: compaction by shrink (chain breaks, prompt < 0.6 × cached) and by hint', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(50_000)))
    await hz.cc(conv.body(), FRONTIER)
    const compacted = new Conversation().push(userText('Summary of the conversation so far: ...'), assistantText('ok'), userText('continue'))
    const { decision } = await hz.cc(compacted.body(), {}, { at: T0 + 30 * SEC })
    expect(decision).toMatchObject({ action: 'switch', model: SONNET, point: 'compaction' })
    expect(decision.reason).toMatch(/^compaction:shrink: /)

    const hz2 = new Harness()
    const c2 = new Conversation().push(userText(big(50_000)))
    await hz2.cc(c2.body(), FRONTIER)
    c2.push(assistantText('ok'), userText('more'))
    const h = (await hz2.cc(c2.body(), { 'x-router-boundary': 'compaction' }, { at: T0 + 30 * SEC })).decision
    expect(h).toMatchObject({ action: 'switch', model: SONNET, point: 'compaction' })
    expect(h.reason).toMatch(/^compaction:hint: /)
  })

  it('scenario 9: cache params change without shrink → prefix-reset (same lineage)', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(20_000)))
    const s1 = await hz.cc(conv.body(), FRONTIER)
    conv.push(assistantText('ok'), userText('more'))
    const body = { ...conv.body(), thinking: { type: 'enabled', budget_tokens: 4000 } }
    const { decision, summary } = await hz.cc(body, {}, { at: T0 + 30 * SEC })
    expect(summary.session.lineage).toBe(s1.summary.session.lineage)
    expect(summary.prefix.systemHash).toBe(s1.summary.prefix.systemHash)
    expect(decision).toMatchObject({ action: 'switch', model: SONNET, point: 'prefix-reset' })
  })

  it('scenario 9: tools change under a cooperative agent id → prefix-reset; transparently it is a new lineage under the seen root', async () => {
    const hz = new Harness()
    const agent = { 'x-router-agent-id': 'main' }
    const conv = new Conversation().push(userText(big(20_000)))
    await hz.cc(conv.body(), { ...agent, ...FRONTIER })
    conv.push(assistantText('ok'), userText('more'))
    const body = { ...conv.body(), tools: [...TOOLS, { name: 'Web', description: 'search', input_schema: { type: 'object' } }] }
    expect((await hz.cc(body, agent, { at: T0 + 30 * SEC })).decision).toMatchObject({ action: 'switch', model: SONNET, point: 'prefix-reset' })
    const plain = new Harness()
    const c2 = new Conversation().push(userText(big(20_000)))
    const first = await plain.cc(c2.body())
    c2.push(assistantText('ok'), userText('more'))
    const second = await plain.cc({ ...c2.body(), tools: [...TOOLS, { name: 'Web', description: 'search', input_schema: { type: 'object' } }] }, {}, { at: T0 + 30 * SEC })
    expect(second.summary.session.lineage).not.toBe(first.summary.session.lineage)
    // Same session header (root), new template family: the root index reads it as a new lineage (free break point).
    expect(second.decision.point).toBe('subagent-start')
    expect(second.decision.reason).toMatch(/^subagent-start: new lineage under seen root, /)
  })

  it('task-start and subagent-start hints are break points', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(20_000)))
    await hz.cc(conv.body(), FRONTIER)
    conv.push(assistantText('ok'), userText('new task'))
    expect((await hz.cc(conv.body(), { 'x-router-boundary': 'task-start' }, { at: T0 + SEC })).decision).toMatchObject({ point: 'task-start', model: SONNET })
    const sub = await hz.cc(new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look')).body(), { 'x-router-parent-session': 'sess-1' })
    expect(sub.decision).toMatchObject({ action: 'initialize', point: 'subagent-start' })
  })

  it('a breakpoint that moves to the newest message every turn is not a prefix reset', async () => {
    const hz = new Harness()
    const body = (msgs: Array<[string, string]>) => ({
      ...new Conversation().body(),
      messages: msgs.map(([role, text], i) => ({ role, content: [{ type: 'text', text, ...(i === msgs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }] })),
    })
    const msgs: Array<[string, string]> = [['user', big(30_000)]]
    await hz.cc(body(msgs))
    msgs.push(['assistant', 'ok'], ['user', 'next'])
    const s2 = await hz.cc(body(msgs), FRONTIER, { at: T0 + 10 * SEC })
    // a user turn priced against a warm Sonnet, not a free break point
    expect(s2.decision).toMatchObject({ point: 'user-turn', action: 'switch', model: OPUS, reason: expect.stringMatching(/^upgrade:hint: /) })
    expect(s2.result.miss).toBeUndefined()
  })

  it('a small uncached conversation is not a prefix reset', async () => {
    const hz = new Harness()
    const conv = new Conversation({ system: 'tiny', tools: [] }).push(userText('hi'))
    await hz.cc(conv.body())
    conv.push(assistantText('hello'), userText('how are you'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + SEC })).decision).toMatchObject({ action: 'retain', point: 'user-turn', reason: expect.stringMatching(/^retain: same-tier/) })
  })
})

describe('decide: user turn economics', () => {
  async function downgradeAt(tokens: number, calls: number, over: Parameters<typeof testPolicy>[0] = {}) {
    const hz = new Harness(testPolicy({ horizon: { calls }, ...over }))
    const conv = new Conversation().push(userText(big(tokens)))
    await hz.cc(conv.body(), FRONTIER)
    conv.push(assistantText('ok'), userText('continue'))
    return (await hz.cc(conv.body(), {}, { at: T0 + 30 * SEC })).decision
  }

  it('scenario 10: downgrade passes the break-even over a long horizon', async () => {
    const d = await downgradeAt(50_000, 30)
    expect(d).toMatchObject({ action: 'switch', model: SONNET, point: 'user-turn' })
    expect(d.reason).toMatch(/^downgrade: frontier→standard /)
    expect(d.estimate!.horizonCalls).toBe(30)
    expect(d.estimate!.stayUsd - d.estimate!.switchUsd).toBeGreaterThan(Math.max(0.02, 0.2 * d.estimate!.switchUsd))
  })
  it('scenario 10: short horizon or huge context fails the break-even', async () => {
    const short = await downgradeAt(50_000, 5)
    expect(short).toMatchObject({ action: 'retain', model: OPUS, point: 'user-turn' })
    expect(short.reason).toMatch(/^downgrade-rejected:cost: /)
    expect(short.estimate!.stayUsd).toBeLessThan(short.estimate!.switchUsd)
    const huge = await downgradeAt(150_000, 15)
    expect(huge.reason).toMatch(/^downgrade-rejected:cost: /)
  })

  it('scenario 11: minTurnsBeforeSwitch and maxSwitchesPerLineage gates', async () => {
    const hz = new Harness(testPolicy({ horizon: { calls: 30 } }))
    const conv = new Conversation().push(userText(big(50_000)))
    await hz.cc(conv.body(), FRONTIER)
    conv.push(assistantText('a'), userText('b'))
    expect((await hz.cc(conv.body(), { 'x-router-tier': 'standard' }, { at: T0 + 10 * SEC })).decision.action).toBe('switch')
    conv.push(assistantText('c'), userText('d'))
    const d = (await hz.cc(conv.body(), { 'x-router-tier': 'fast' }, { at: T0 + 20 * SEC })).decision
    expect(d).toMatchObject({ action: 'retain', model: SONNET })
    expect(d.reason).toMatch(/^downgrade-rejected:min-turns: \(1 < 2\)/)
    conv.push(assistantText('e'), userText('f'))
    expect((await hz.cc(conv.body(), { 'x-router-tier': 'fast' }, { at: T0 + 30 * SEC })).decision).toMatchObject({ action: 'switch', model: HAIKU })

    const capped = await downgradeAt(50_000, 30, { hysteresis: { maxSwitchesPerLineage: 0 } })
    expect(capped.reason).toMatch(/^downgrade-rejected:max-switches: /)
  })

  it('scenario 12: upgrade by x-router-tier switches without a cost gate', async () => {
    const hz = new Harness(testPolicy({ horizon: { calls: 1 } }))
    const conv = new Conversation().push(userText(big(50_000)))
    await hz.cc(conv.body())
    conv.push(assistantText('ok'), userText('this is hard'))
    const { decision } = await hz.cc(conv.body(), FRONTIER, { at: T0 + 10 * SEC })
    expect(decision).toMatchObject({ action: 'switch', model: OPUS, point: 'user-turn' })
    expect(decision.reason).toMatch(/^upgrade:hint: standard→frontier /)
    expect(decision.estimate!.switchUsd).toBeGreaterThan(decision.estimate!.stayUsd)
  })

  it('no lower/higher tier available → retain', async () => {
    const hz = new Harness(testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET }, { model: OPUS }] } } }))
    const conv = new Conversation().push(userText('x'))
    await hz.cc(conv.body())
    conv.push(assistantText('ok'), userText('quick one'))
    expect((await hz.cc(conv.body(), { 'x-router-tier': 'fast' }, { at: T0 + SEC })).decision.reason).toMatch(/^retain: no-lower-tier/)
  })

  it('a current model that left the pool is replaced at the next user turn (ineligible)', async () => {
    const store = new InMemoryStateStore()
    const mk = (models: string[]) => createEngine({ policy: testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: models.map((model) => ({ model })) } } }), catalog: fixtureCatalog, store })
    const a = mk([SONNET, OPUS])
    const conv = new Conversation().push(userText('x'))
    const s1 = a.summarize('anthropic-messages', conv.body(), { 'x-session-id': 's' }, T0)
    await a.record(s1, await a.decide(s1), { servedModel: SONNET, status: 200 })
    const b = mk([OPUS, HAIKU])
    conv.push(assistantText('ok'), userText('y'))
    const s2 = b.summarize('anthropic-messages', conv.body(), { 'x-session-id': 's' }, T0 + SEC)
    const d = await b.decide(s2)
    expect(d).toMatchObject({ action: 'switch', model: OPUS, point: 'user-turn' })
    expect(d.reason).toMatch(/^ineligible: /)
  })

  it('assistant prefill retains', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('x'))
    await hz.cc(conv.body())
    conv.push(assistantText('{"partial":'))
    expect((await hz.cc(conv.body(), FRONTIER, { at: T0 + SEC })).decision).toMatchObject({ action: 'retain', reason: expect.stringMatching(/^retain: prefill/) })
  })

  it("userTurn 'retain' never switches at user turns but still switches at break points", async () => {
    const hz = new Harness(testPolicy({ userTurn: 'retain' }))
    const conv = new Conversation().push(userText(big(20_000)))
    await hz.cc(conv.body())
    conv.push(assistantText('a'), userText('b'))
    expect((await hz.cc(conv.body(), FRONTIER, { at: T0 + SEC })).decision).toMatchObject({ action: 'retain', model: SONNET, reason: expect.stringMatching(/^retain: boundary-gated; /) })
    conv.push(assistantText('c'), userText('d'))
    expect((await hz.cc(conv.body(), FRONTIER, { at: T0 + 10 * MIN })).decision).toMatchObject({ action: 'switch', model: OPUS, point: 'idle-expired' })
    // hard locks still come first, even across an idle gap
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'x'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + 30 * MIN })).decision).toMatchObject({ action: 'retain', model: OPUS, point: 'hard-lock-tool-loop' })
  })
})

describe('decide: pins (scenario 14)', () => {
  it('a concrete model in auto mode is pinned; x-router-pin pins in any mode', async () => {
    const hz = new Harness()
    const d = (await hz.cc(new Conversation().push(userText('x')).body(HAIKU))).decision
    expect(d).toMatchObject({ action: 'pin', model: HAIKU, point: 'pinned' })
    expect(d.reason).toMatch(/^pin: concrete model /)
    const pinned = await hz.cc(new Conversation().push(userText('y')).body(), { 'x-router-pin': OPUS, 'x-claude-code-session-id': 'other' })
    expect(pinned.decision).toMatchObject({ action: 'pin', model: OPUS, point: 'pinned', reason: expect.stringMatching(/^pin: x-router-pin /) })
    // pinned calls are still accounted: state follows the served model
    expect((await hz.store.get(pinned.summary.session.lineage))!.current).toBe(OPUS)
  })
})

describe('decide: observe mode (scenario 15)', () => {
  const observe = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL } })

  it('serves the requested concrete model, fills wouldChoose, and state follows the served model', async () => {
    const hz = new Harness(observe)
    const conv = new Conversation().push(userText(big(50_000)))
    const s1 = await hz.cc(conv.body(OPUS))
    expect(s1.decision).toMatchObject({ mode: 'observe', action: 'initialize', model: OPUS, wouldChoose: SONNET, point: 'session-start' })
    expect((await hz.store.get(s1.summary.session.lineage))!.current).toBe(OPUS)
    conv.push(assistantText('ok'), userText('go on'))
    const s2 = await hz.cc(conv.body(OPUS), {}, { at: T0 + 10 * SEC })
    // auto would weigh Opus→Sonnet against the real (Opus-warm) state; observe still serves Opus
    expect(s2.decision).toMatchObject({ model: OPUS, wouldChoose: OPUS, action: 'retain', point: 'user-turn' })
    expect(s2.decision.reason).toMatch(/^downgrade-rejected:cost: /)
    expect(s2.decision.estimate).toBeDefined()
  })

  it('alias requests are served the observe default with an observe-default reason', async () => {
    const hz = new Harness(observe)
    const d = (await hz.step('openai-chat', { model: 'auto:fast', messages: [{ role: 'user', content: 'hi' }] }, { 'x-session-id': 'o' })).decision
    expect(d).toMatchObject({ mode: 'observe', model: SOL, wouldChoose: LUNA, action: 'initialize' })
    expect(d.reason).toMatch(/^observe-default: session-start: /)
  })

  it('hard locks hold in observe mode: wouldChoose stays on the current model', async () => {
    const hz = new Harness(observe)
    const conv = new Conversation().push(userText('fix it'))
    await hz.cc(conv.body())
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'a b'))
    const d = (await hz.cc(conv.body(), FRONTIER, { at: T0 + SEC })).decision
    expect(d).toMatchObject({ mode: 'observe', model: SONNET, wouldChoose: SONNET, action: 'retain', point: 'hard-lock-tool-loop' })
  })

  it('a concrete model for a dialect without a pool is pinned', async () => {
    const policy = testPolicy({ mode: 'observe', pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET }] } }, observeDefaults: { 'anthropic-messages': SONNET } })
    const engine = createEngine({ policy, catalog: fixtureCatalog, store: new InMemoryStateStore() })
    const s = summarize('openai-chat', { model: 'some-model', messages: [] }, {}, T0)
    expect(await engine.decide(s)).toMatchObject({ action: 'pin', model: 'some-model', reason: expect.stringMatching(/^pin: no pool/) })
  })
})
