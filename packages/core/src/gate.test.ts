// Follow-up 2026-11-04, item 5: gate fallback prefers the current / cheapest physically fitting model, and a
// gate-forced move is not sticky (gate-recover).
import { describe, expect, it } from 'vitest'
import { HAIKU, OPUS, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, Harness, SEC, T0, testPolicy, toolResult, userText, type Step } from './__fixtures__/traces.ts'
import { summarize } from './summarize/index.ts'

const text = (tokens: number, salt = ''): string => `${salt} ${'x'.repeat(Math.max(0, tokens * 4 - salt.length - 1))}`
const hdr = { 'x-claude-code-session-id': 'sess-1' }

describe('summarize: maxOutputTokens', () => {
  it('reads the per-dialect output cap', () => {
    expect(summarize('anthropic-messages', { max_tokens: 4096, messages: [] }, {}, T0).maxOutputTokens).toBe(4096)
    expect(summarize('openai-chat', { max_completion_tokens: 900, max_tokens: 100, messages: [] }, {}, T0).maxOutputTokens).toBe(900)
    expect(summarize('openai-chat', { max_tokens: 100, messages: [] }, {}, T0).maxOutputTokens).toBe(100)
    expect(summarize('openai-responses', { max_output_tokens: 2048, input: 'x' }, {}, T0).maxOutputTokens).toBe(2048)
    expect(summarize('openai-responses', { input: 'x', max_output_tokens: 'lots' }, {}, T0).maxOutputTokens).toBeUndefined()
  })
})

describe('gate fallback (replay repro: 909,981-token prompt)', () => {
  it('a Sonnet session past the 0.9 headroom of every model stays on Sonnet; compaction later is a normal break point', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(text(850_000, 'task')))
    const steps: Step[] = []
    let t = T0
    const go = async (body: unknown, dt: number) => { t += dt; const s = await hz.cc(body, {}, { at: t }); steps.push(s); return s }
    expect((await go(conv.body(), 0)).decision).toMatchObject({ action: 'initialize', model: SONNET })
    conv.push(assistantToolUse('t1', 'cat big.log'), toolResult('t1', text(30_000, 'log')))
    await go(conv.body(), 2 * SEC)
    // grow the user turn to the replay size
    const base = hz.engine.summarize('anthropic-messages', new Conversation().push(...conv.messages, assistantText('read it'), userText('')).body(), hdr, t).prefix.estPromptTokens
    conv.push(assistantText('read it'), userText(text(909_981 - base, 'now fix')))
    const big = await go(conv.body(), 20 * SEC)
    expect(Math.abs(big.summary.prefix.estPromptTokens - 909_981)).toBeLessThanOrEqual(2)
    expect(big.decision).toMatchObject({ action: 'retain', model: SONNET, point: 'user-turn' })
    expect(big.decision.reason).toMatch(/; gate-fallback:current$/)
    for (let i = 0; i < 3; i++) {
      conv.push(assistantText(`fixed ${i}`), userText(text(1000, `more ${i}`)))
      expect((await go(conv.body(), 30 * SEC)).decision).toMatchObject({ action: 'retain', model: SONNET })
    }
    const compacted = new Conversation().push(userText(text(50_000, '<summary>')), assistantText('ok'), userText('continue'))
    const c = await go(compacted.body(), 30 * SEC)
    expect(c.decision).toMatchObject({ point: 'compaction', action: 'retain', model: SONNET })
    expect(steps.some((s) => s.decision.model === OPUS)).toBe(false)
    expect((await hz.store.get(c.summary.session.lineage))!).toMatchObject({ switches: 0 })
    expect((await hz.store.get(c.summary.session.lineage))!.gateForced).toBeUndefined()
  })

  it('no current model: the cheapest model that physically fits (lowest tier), else the largest window', async () => {
    const hz = new Harness()
    const body = new Conversation().push(userText(text(950_000))).body()
    const d = (await hz.cc(body)).decision
    expect(d).toMatchObject({ action: 'initialize', model: SONNET })
    expect(d.reason).toMatch(/; gate-fallback:cheapest$/)
    const huge = (await hz.cc({ ...body, max_tokens: 64_000 }, { 'x-claude-code-session-id': 'other' })).decision
    expect(huge.model).toBe(OPUS) // nothing fits 950K + 64K: largest window (first of the 1M models)
    expect(huge.reason).toMatch(/; gate-fallback$/)
  })
})

describe('gate-forced moves are not sticky', () => {
  it('Haiku outgrows its gate → gate-forced to Sonnet; tool loops stay; compaction recovers to Haiku (gate-recover)', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(text(150_000, 'scan')))
    let t = T0
    const go = (body: unknown, dt: number) => hz.cc(body, {}, { at: (t += dt) })
    expect((await go(conv.body('auto:fast'), 0)).decision.model).toBe(HAIKU)
    conv.push(assistantText('ok'), userText(text(35_000, 'more files'))) // ≈ 191K > 180K (Haiku 200K × 0.9)
    const forced = await go(conv.body('auto:fast'), 20 * SEC)
    expect(forced.decision).toMatchObject({ action: 'switch', model: SONNET, point: 'user-turn' })
    expect(forced.decision.reason).toMatch(/^gate-forced: global\.anthropic\.claude-haiku-5-5 → global\.anthropic\.claude-sonnet-5-5 tier=fast via alias; /)
    const lineage = forced.summary.session.lineage
    expect((await hz.store.get(lineage))!.gateForced).toEqual({ from: HAIKU, atMs: t })
    conv.push(assistantToolUse('t1', 'grep'), toolResult('t1', 'hits'))
    expect((await go(conv.body('auto:fast'), 2 * SEC)).decision).toMatchObject({ point: 'hard-lock-tool-loop', model: SONNET })
    conv.push(assistantText('found'), userText('next'))
    // fast still does not pass the gate: no recovery, and the downgrade path finds no lower tier
    expect((await go(conv.body('auto:fast'), 20 * SEC)).decision).toMatchObject({ action: 'retain', model: SONNET, reason: expect.stringMatching(/^retain: no-lower-tier/) })
    const compacted = new Conversation().push(userText(text(20_000, '<summary>')), assistantText('ok'), userText('go on'))
    const rec = await go(compacted.body('auto:fast'), 20 * SEC)
    expect(rec.decision).toMatchObject({ action: 'switch', model: HAIKU, point: 'compaction' })
    expect(rec.decision.reason).toMatch(/^gate-recover: compaction:shrink, forced from global\.anthropic\.claude-haiku-5-5, tier=fast via alias → /)
    expect((await hz.store.get(lineage))!.gateForced).toBeUndefined()
  })

  it('a break point while the desired tier is still gate-blocked is not a recovery (gateForced kept)', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(text(150_000, 'scan')))
    let t = T0
    const go = (body: unknown, dt: number) => hz.cc(body, {}, { at: (t += dt) })
    await go(conv.body('auto:fast'), 0)
    conv.push(assistantText('ok'), userText(text(35_000, 'more files')))
    const forced = await go(conv.body('auto:fast'), 20 * SEC)
    expect(forced.decision.model).toBe(SONNET)
    conv.push(assistantText('found'), userText('next'))
    const idle = await go(conv.body('auto:fast'), 10 * 60 * SEC) // ≈ 191K: Haiku still outside its gate
    expect(idle.decision).toMatchObject({ action: 'retain', model: SONNET, point: 'idle-expired' })
    expect(idle.decision.reason).toMatch(/^idle-expired: /)
    expect((await hz.store.get(forced.summary.session.lineage))!.gateForced).toEqual({ from: HAIKU, atMs: T0 + 20 * SEC })
  })

  async function forcedState(policy = testPolicy({ horizon: { calls: 1 } })) {
    const hz = new Harness(policy)
    const conv = new Conversation().push(userText(text(20_000, 'small')))
    const s = await hz.cc(conv.body('auto:fast'))
    // as if an earlier gate-forced move had put the lineage on Sonnet with a warm entry
    const st = (await hz.store.get(s.summary.session.lineage))!
    st.current = SONNET
    st.perModel[SONNET] = { ...st.perModel[HAIKU]!, model: SONNET }
    st.gateForced = { from: HAIKU, atMs: T0 }
    await hz.store.put(st)
    conv.push(assistantText('a'), userText('b'))
    return { hz, conv, lineage: s.summary.session.lineage }
  }

  it.each([['cost-gated', 'cost-gated'], ['retain', 'retain']] as const)('userTurn %s: a user turn where the desired tier passes again recovers without the cost gate', async (_n, userTurn) => {
    const { hz, conv, lineage } = await forcedState(testPolicy({ horizon: { calls: 1 }, userTurn }))
    const d = (await hz.cc(conv.body('auto:fast'), {}, { at: T0 + 10 * SEC })).decision
    expect(d).toMatchObject({ action: 'switch', model: HAIKU, point: 'user-turn', reason: expect.stringMatching(/^gate-recover: /) })
    expect(d.estimate).toBeUndefined()
    expect((await hz.store.get(lineage))!.gateForced).toBeUndefined()
  })

  it('hard locks still come first', async () => {
    const { hz, conv } = await forcedState()
    conv.push(assistantToolUse('t', 'x'), toolResult('t', 'y'))
    expect((await hz.cc(conv.body('auto:fast'), {}, { at: T0 + 10 * SEC })).decision).toMatchObject({ action: 'retain', model: SONNET, point: 'hard-lock-tool-loop' })
  })
})
