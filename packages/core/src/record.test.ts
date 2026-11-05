import { describe, expect, it } from 'vitest'
import { HAIKU, KIMI, OPUS, SOL, SONNET, SONNET_JP } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, Harness, MIN, SEC, T0, testPolicy, toolResult, usage, userText } from './__fixtures__/traces.ts'
import { pruneExpired } from './record.ts'
import type { SessionState } from './types.ts'

const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`

describe('record: failover (scenario 16)', () => {
  it('429 → next profile of the same model; stays there until the next break point', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    await hz.cc(conv.body())
    conv.push(assistantToolUse('t1', 'make'), toolResult('t1', 'ok'))
    // the call fails on Sonnet: no cache/counter change, failover armed
    const failed = await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, status: 429 })
    expect(failed.decision.model).toBe(SONNET)
    const st = await hz.store.get(failed.summary.session.lineage)
    expect(st!.lastFailure).toEqual({ model: SONNET, status: 429, atMs: T0 + 2 * SEC })
    expect(st!.calls).toBe(1)
    // retry inside the window (even mid tool loop) goes to the jp. profile
    const retry = await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC })
    expect(retry.decision).toMatchObject({ action: 'switch', model: SONNET_JP, point: 'failover' })
    expect(retry.decision.reason).toMatch(/^failover: profile .* after 429; /)
    // failureStatus is kept and pruned with failures: the jp. success leaves Sonnet's entry, which ages out with it
    expect((await hz.store.get(failed.summary.session.lineage))!).toMatchObject({ failures: { [SONNET]: T0 + 2 * SEC }, failureStatus: { [SONNET]: 429 } })
    // user turn: same tier, stay on the failover profile
    conv.push(assistantText('built'), userText('ship it'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })).decision).toMatchObject({ action: 'retain', model: SONNET_JP, point: 'user-turn' })
    const aged = (await hz.store.get(failed.summary.session.lineage))!
    expect(aged.failures).toBeUndefined()
    expect(aged.failureStatus).toBeUndefined()
    // next break point (idle) moves back to the primary profile
    conv.push(assistantText('shipped'), userText('next task'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC + 6 * MIN })).decision).toMatchObject({ action: 'switch', model: SONNET, point: 'idle-expired' })
  })

  it('no profile left → retain (exhausted); outside the window → no failover; 4xx ≠ 429 is ignored', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('hi'))
    const s = await hz.cc(conv.body('auto:fast'))
    expect(s.decision.model).toBe(HAIKU)
    conv.push(assistantText('a'), userText('b'))
    await hz.cc(conv.body('auto:fast'), {}, { at: T0 + SEC, status: 503 })
    const d = (await hz.cc(conv.body('auto:fast'), {}, { at: T0 + 2 * SEC })).decision
    expect(d).toMatchObject({ action: 'retain', model: HAIKU, point: 'failover', reason: expect.stringMatching(/^failover: exhausted/) })

    const hz2 = new Harness()
    const c2 = new Conversation().push(userText('hi'))
    await hz2.cc(c2.body())
    c2.push(assistantText('a'), userText('b'))
    await hz2.cc(c2.body(), {}, { at: T0 + SEC, status: 500 })
    expect((await hz2.cc(c2.body(), {}, { at: T0 + 30 * SEC })).decision.point).toBe('user-turn')

    const hz3 = new Harness()
    const c3 = new Conversation().push(userText('hi'))
    const first = await hz3.cc(c3.body())
    const before = await hz3.store.get(first.summary.session.lineage)
    await hz3.cc(c3.body(), {}, { at: T0 + SEC, status: 400 })
    expect(await hz3.store.get(first.summary.session.lineage)).toEqual(before)
  })

  it('profiles exhausted → same-tier sibling; never on a response chain; in a tool loop only cross-model without non-portable state', async () => {
    const pools = { 'openai-responses': { defaultTier: 'standard' as const, models: [{ model: SOL }, { model: KIMI }] } }
    const hdr = { 'x-session-id': 'r' }
    // unlocked user turn: SOL has no other profile, so the standard sibling takes over
    const free = new Harness(testPolicy({ pools }))
    const items: unknown[] = [{ role: 'user', content: 'hi' }]
    await free.step('openai-responses', { model: 'auto', input: items }, hdr)
    items.push({ type: 'message', role: 'assistant', content: [] }, { role: 'user', content: 'more' })
    await free.step('openai-responses', { model: 'auto', input: items }, hdr, { at: T0 + SEC, status: 429 })
    expect((await free.step('openai-responses', { model: 'auto', input: items }, hdr, { at: T0 + 2 * SEC })).decision)
      .toMatchObject({ action: 'switch', model: KIMI, point: 'failover', reason: expect.stringMatching(/^failover: sibling /) })

    // response chain: the stored response belongs to SOL, so a sibling model must not continue it
    const chain = new Harness(testPolicy({ pools }))
    await chain.step('openai-responses', { model: 'auto', input: 'hi' }, hdr, { responseId: 'resp_1' })
    const next = { model: 'auto', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'x' }] }
    await chain.step('openai-responses', next, hdr, { at: T0 + SEC, status: 429 })
    expect((await chain.step('openai-responses', next, hdr, { at: T0 + 2 * SEC })).decision)
      .toMatchObject({ action: 'retain', model: SOL, point: 'failover', reason: expect.stringMatching(/^failover-chain-locked: /) })

    // tool loop (follow-up item 1): Opus has no other profile, so all its profiles failed → cross-model to the
    // same-tier sibling, because the history carries no provider-specific state
    const loopPolicy = testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'frontier', models: [{ model: OPUS }, { model: SONNET, tier: 'frontier' }] } } })
    const loop = new Harness(loopPolicy)
    const conv = new Conversation().push(userText('go'))
    await loop.cc(conv.body())
    conv.push(assistantToolUse('t', 'x'), toolResult('t', 'y'))
    await loop.cc(conv.body(), {}, { at: T0 + SEC, status: 529 })
    expect((await loop.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({
      action: 'switch', model: SONNET, point: 'failover', reason: expect.stringMatching(/^failover-cross-model: all 1 profile\(s\) of .*opus.* failed within 10000ms → .*sonnet.* \(tool loop\) after 529; /),
    })
    // ... but signed thinking in the history pins the loop to the model: retain
    const think = new Harness(loopPolicy)
    const c2 = new Conversation().push(userText('go'))
    await think.cc(c2.body())
    c2.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'h', signature: 'sig' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'x' } }] }, toolResult('t', 'y'))
    await think.cc(c2.body(), {}, { at: T0 + SEC, status: 529 })
    expect((await think.cc(c2.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({
      action: 'retain', model: OPUS, point: 'failover', reason: expect.stringMatching(/^failover: exhausted .*hard lock: tool loop with anthropic-thinking-signature/),
    })
  })

  it('a failure on the very first request fails over too', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('hi'))
    await hz.cc(conv.body(), {}, { status: 429 })
    expect((await hz.cc(conv.body(), {}, { at: T0 + SEC })).decision).toMatchObject({ action: 'initialize', model: SONNET_JP, point: 'failover' })
  })
})

describe('record: served model differs (scenario 17)', () => {
  it('state follows the served model; the miss is attributed model_changed', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    await hz.cc(conv.body())
    conv.push(assistantText('ok'), userText('go'))
    const s = await hz.cc(conv.body(), {}, { at: T0 + 10 * SEC, served: HAIKU })
    expect(s.decision.model).toBe(SONNET)
    expect(s.result.servedDiffers).toBe(true)
    expect(s.result.miss).toMatchObject({ reason: 'model_changed', readTokens: 0 })
    expect(s.result.miss!.expectedTokens).toBeGreaterThan(10_000)
    const st = (await hz.store.get(s.summary.session.lineage))!
    expect(st.current).toBe(HAIKU)
    expect(st.switches).toBe(1)
    expect(st.costSwitches ?? 0).toBe(0)
    expect(st.lastMiss).toMatchObject({ reason: 'model_changed', atMs: T0 + 10 * SEC })
    expect(st.perModel[HAIKU]!.cachedTokens).toBe(s.summary.prefix.estPromptTokens)
    expect(st.perModel[SONNET]).toBeDefined() // Sonnet's entry stays warm for a switch back
  })
})

describe('record: miss attribution (scenario 18)', () => {
  async function warmThenMiss(atOffset: number) {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    const s1 = await hz.cc(conv.body())
    conv.push(assistantText('ok'), userText('go'))
    const s2 = await hz.cc(conv.body(), {}, { at: T0 + atOffset, usage: usage(0, 12_000) })
    return { hz, s1, s2 }
  }
  it('ttl_expired: the entry was older than 0.8 × TTL', async () => {
    const { s2 } = await warmThenMiss(270 * SEC) // within TTL − margin (285 s), beyond 240 s
    expect(s2.decision.point).toBe('user-turn')
    expect(s2.result.miss).toMatchObject({ reason: 'ttl_expired', readTokens: 0 })
  })
  it('unknown: fresh entry, same model, prefix intact (server-local miss, eviction)', async () => {
    const { hz, s2 } = await warmThenMiss(10 * SEC)
    expect(s2.result.miss!.reason).toBe('unknown')
    // the miss is learned: the entry was rewritten from usage
    expect((await hz.store.get(s2.summary.session.lineage))!.perModel[SONNET]!.cachedTokens).toBe(12_000)
  })
  it('a read ≥ 50% of the expected tokens is a hit; a zero-cache response deletes the entry', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    const s1 = await hz.cc(conv.body())
    conv.push(assistantText('ok'), userText('go'))
    const hit = await hz.cc(conv.body(), {}, { at: T0 + SEC, usage: usage(s1.summary.prefix.estPromptTokens, 50) })
    expect(hit.result.miss).toBeUndefined()
    conv.push(assistantText('ok'), userText('again'))
    const none = await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, usage: { uncachedInputTokens: 12_000, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 10, promptTokens: 12_000 } })
    expect(none.result.miss!.reason).toBe('unknown')
    expect((await hz.store.get(none.summary.session.lineage))!.perModel[SONNET]).toBeUndefined()
  })
  it('prefix_changed: a concurrent sibling moved the lineage elsewhere', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    const s1 = await hz.cc(conv.body())
    const st = (await hz.store.get(s1.summary.session.lineage))!
    st.lastPrefixHash = 'ffffffffffffffff' // a sibling branch was recorded last
    await hz.store.put(st)
    conv.push(assistantText('ok'), userText('go'))
    const s2 = await hz.cc(conv.body(), {}, { at: T0 + SEC, usage: usage(0, 12_000) })
    expect(s2.result.miss!.reason).toBe('prefix_changed')
  })
  it('missing usage is unknown, never a miss; a warm entry is refreshed, a cold one predicted', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    const s1 = await hz.cc(conv.body(), {}, { usage: null })
    let st = (await hz.store.get(s1.summary.session.lineage))!
    expect(st.perModel[SONNET]).toMatchObject({ cachedTokens: s1.summary.prefix.estPromptTokens, lastTouchMs: T0, ttlMs: 5 * MIN })
    conv.push(assistantText('ok'), userText('go'))
    const s2 = await hz.cc(conv.body(), {}, { at: T0 + 4 * MIN, usage: null })
    expect(s2.result.miss).toBeUndefined()
    st = (await hz.store.get(s1.summary.session.lineage))!
    expect(st.perModel[SONNET]).toMatchObject({ cachedTokens: s1.summary.prefix.estPromptTokens, lastTouchMs: T0 + 4 * MIN })
  })
})

describe('record: counters, TTLs and implicit caches', () => {
  it('turns count user-text calls; switches and costSwitches count real moves; TTL follows written TTLs', async () => {
    const hz = new Harness(testPolicy({ horizon: { calls: 30 } }))
    const conv = new Conversation().push(userText(big(50_000)))
    const s1 = await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { usage: usage(0, 56_000, '1h') })
    let st = (await hz.store.get(s1.summary.session.lineage))!
    expect(st).toMatchObject({ turns: 1, calls: 1, switches: 0 })
    expect(st.perModel[st.current!]!.ttlMs).toBe(60 * MIN)
    conv.push(assistantToolUse('t', 'x'), toolResult('t', 'y'))
    await hz.cc(conv.body(), {}, { at: T0 + SEC })
    conv.push(assistantText('ok'), userText('continue'))
    const s3 = await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })
    expect(s3.decision.reason).toMatch(/^downgrade: /)
    st = (await hz.store.get(s1.summary.session.lineage))!
    expect(st).toMatchObject({ turns: 2, calls: 3, switches: 1, costSwitches: 1, lastSwitchTurn: 1, current: SONNET })
  })

  it('implicit-only models assume the whole prompt is cached when usage reports nothing', async () => {
    const hz = new Harness(testPolicy({ pools: { 'openai-chat': { defaultTier: 'standard', models: [{ model: KIMI }] } } }))
    const s = await hz.step('openai-chat', { model: 'auto', messages: [{ role: 'user', content: big(5000) }] }, { 'x-session-id': 'k' },
      { usage: { uncachedInputTokens: 5010, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 5, promptTokens: 5010 } })
    expect((await hz.store.get(s.summary.session.lineage))!.perModel[KIMI]).toMatchObject({ cachedTokens: 5010, ttlMs: 30 * MIN })
  })

  it('Responses: responseId writes a resp: alias carrying the current model', async () => {
    const hz = new Harness()
    const s = await hz.step('openai-responses', { model: 'auto', input: 'hello' }, { 'x-session-id': 'r' }, { responseId: 'resp_77' })
    const alias = await hz.store.get('resp:resp_77')
    expect(alias).toMatchObject({ current: SOL, key: { lineage: 'resp:resp_77', root: s.summary.session.root } })
  })
})

describe('record: expired entries of other models are pruned (2026-11-04 item B)', () => {
  it('drops another model once its TTL has passed; keeps it while live', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText(big(10_000)))
    const first = await hz.cc(conv.body())
    const lineage = first.summary.session.lineage
    conv.push(assistantText('a'), userText('harder'))
    await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 10 * SEC })
    conv.push(assistantText('b'), userText('more'))
    await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 4 * MIN })
    expect(Object.keys((await hz.store.get(lineage))!.perModel).sort()).toEqual([OPUS, SONNET].sort())
    conv.push(assistantText('c'), userText('again'))
    await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 5 * MIN + SEC })
    const st = (await hz.store.get(lineage))!
    expect(st.current).toBe(OPUS)
    expect(Object.keys(st.perModel)).toEqual([OPUS])
  })

  it('prunes record by record, never touches the current model, handles entries without records', () => {
    const ttl = 5 * MIN
    const now = T0 + 10 * MIN
    const state: SessionState = {
      key: { root: 'r', lineage: 'r', source: 'header' },
      current: SONNET,
      turns: 3,
      switches: 1,
      lastSeenMs: now,
      perModel: {
        // current, long expired: kept (idle-expired detection reads it)
        [SONNET]: { model: SONNET, cachedPrefixHash: 's1', cachedTokens: 100, lastTouchMs: T0, ttlMs: ttl, prefixes: [{ hash: 's1', tokens: 100, touchMs: T0 }] },
        // one live and one expired record: only the expired one goes; compat fields follow the remaining record
        [OPUS]: {
          model: OPUS, cachedPrefixHash: 'o2', cachedTokens: 300, lastTouchMs: now - MIN, ttlMs: ttl,
          prefixes: [{ hash: 'o2', tokens: 300, touchMs: T0 + 2 * MIN }, { hash: 'o1', tokens: 200, touchMs: now - MIN }],
        },
        // every record expired: the entry goes
        [HAIKU]: { model: HAIKU, cachedPrefixHash: 'h1', cachedTokens: 50, lastTouchMs: T0 + MIN, ttlMs: ttl, prefixes: [{ hash: 'h1', tokens: 50, touchMs: T0 + MIN }] },
        // tokens-only entry (hand-built summaries): lastTouchMs + ttl decides
        [SONNET_JP]: { model: SONNET_JP, cachedTokens: 80, lastTouchMs: now - ttl, ttlMs: ttl },
        [KIMI]: { model: KIMI, cachedTokens: 80, lastTouchMs: now - ttl - 1, ttlMs: ttl },
      },
    }
    pruneExpired(state, now)
    expect(Object.keys(state.perModel).sort()).toEqual([OPUS, SONNET, SONNET_JP].sort())
    expect(state.perModel[SONNET]!.prefixes).toHaveLength(1)
    expect(state.perModel[OPUS]).toEqual({
      model: OPUS, cachedPrefixHash: 'o1', cachedTokens: 200, lastTouchMs: now - MIN, ttlMs: ttl, prefixes: [{ hash: 'o1', tokens: 200, touchMs: now - MIN }],
    })
  })
})
