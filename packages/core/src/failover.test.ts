// Follow-up 2026-11-04, item 1: per-profile failure tracking and cross-model failover inside a tool loop.
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, KIMI, OPUS, priceOf, SOL, SONNET, SONNET_JP } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, Harness, SEC, T0, testPolicy, toolResult, userText } from './__fixtures__/traces.ts'
import type { SessionState } from './types.ts'

// Opus re-tiered to standard so Sonnet has a same-tier sibling.
const siblingPolicy = () => testPolicy({
  pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET, failover: [SONNET_JP] }, { model: OPUS, tier: 'standard' }, { model: HAIKU }] } },
})

async function toolLoop(hz: Harness) {
  const conv = new Conversation().push(userText('build it'))
  const first = await hz.cc(conv.body())
  conv.push(assistantToolUse('t1', 'make'), toolResult('t1', 'error'))
  return { conv, lineage: first.summary.session.lineage }
}

describe('failover inside a tool loop', () => {
  it('first moves to the next profile; only when every profile failed does it cross to a same-tier sibling', async () => {
    const hz = new Harness(siblingPolicy())
    const { conv, lineage } = await toolLoop(hz)
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 429 })
    const toJp = await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, status: 503 })
    expect(toJp.decision).toMatchObject({ action: 'switch', model: SONNET_JP, point: 'failover' })
    const st = (await hz.store.get(lineage))!
    expect(st.failures).toEqual({ [SONNET]: T0 + 1 * SEC, [SONNET_JP]: T0 + 2 * SEC })
    expect(st.lastFailure).toEqual({ model: SONNET_JP, status: 503, atMs: T0 + 2 * SEC })
    expect(st.failureStatus).toEqual({ [SONNET]: 429, [SONNET_JP]: 503 })
    const cross = await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC })
    expect(cross.decision).toMatchObject({ action: 'switch', model: OPUS, point: 'failover' })
    expect(cross.decision.reason).toMatch(/^failover-cross-model: all 2 profile\(s\) of global\.anthropic\.claude-sonnet-5-5 failed within 10000ms → global\.anthropic\.claude-opus-5-5 \(tool loop\) after 429; /)
    // the successful sibling call clears nothing it did not own; Sonnet's failures stay until they age out
    expect((await hz.store.get(lineage))!.failures).toEqual({ [SONNET]: T0 + 1 * SEC, [SONNET_JP]: T0 + 2 * SEC })
    expect((await hz.store.get(lineage))!.failureStatus).toEqual({ [SONNET]: 429, [SONNET_JP]: 503 })
  })

  it('a failed profile whose failure aged out of the window is usable again (wrap-around)', async () => {
    const hz = new Harness(siblingPolicy())
    const { conv } = await toolLoop(hz)
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 429 })
    await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC }) // served on jp.
    conv.push(assistantToolUse('t2', 'make'), toolResult('t2', 'error'))
    await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC, status: 429 }) // jp. fails; Sonnet's failure is 19 s old
    const back = await hz.cc(conv.body(), {}, { at: T0 + 21 * SEC })
    expect(back.decision).toMatchObject({ action: 'switch', model: SONNET, point: 'failover', reason: expect.stringMatching(/^failover: profile .*jp\..* → .*global\.anthropic\.claude-sonnet/) })
  })

  it('no sibling, or non-portable state, or previous_response_id → retain', async () => {
    // testPolicy: Sonnet's tier has no sibling
    const hz = new Harness()
    const { conv } = await toolLoop(hz)
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 429 })
    await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, status: 429 })
    expect((await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC })).decision).toMatchObject({
      action: 'retain', model: SONNET, point: 'failover', reason: expect.stringMatching(/^failover: exhausted .*\(hard lock: tool loop, no sibling\)/),
    })
  })

  it('outside locks the all-profiles check also comes first: profile, then sibling', async () => {
    const hz = new Harness(siblingPolicy())
    const conv = new Conversation().push(userText('hi'))
    await hz.cc(conv.body())
    conv.push(assistantText('a'), userText('b'))
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 429 })
    expect((await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, status: 429 })).decision.model).toBe(SONNET_JP)
    expect((await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC })).decision).toMatchObject({
      action: 'switch', model: OPUS, point: 'failover', reason: expect.stringMatching(/^failover: sibling /),
    })
  })
})

describe('profile rotation only for failover.profileRotateOn (default 429)', () => {
  it('a 5xx skips the other profile: sibling outside locks, cross-model inside a tool loop', async () => {
    for (const status of [500, 502, 503]) {
      const hz = new Harness(siblingPolicy())
      const conv = new Conversation().push(userText('hi'))
      await hz.cc(conv.body())
      conv.push(assistantText('a'), userText('b'))
      await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status })
      expect((await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({
        action: 'switch', model: OPUS, point: 'failover', reason: expect.stringMatching(new RegExp(`^failover: sibling .* after ${status}; no profile rotation on ${status}; `)),
      })
    }
    const hz = new Harness(siblingPolicy())
    const { conv } = await toolLoop(hz)
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 503 })
    expect((await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({
      action: 'switch', model: OPUS, point: 'failover',
      reason: expect.stringMatching(/^failover-cross-model: global\.anthropic\.claude-sonnet-5-5 failed \(no profile rotation on 503\) → global\.anthropic\.claude-opus-5-5 \(tool loop\) after 503; /),
    })
  })

  it('a 5xx with no sibling retains (the gateway fallback covers it); a tool loop says why', async () => {
    const hz = new Harness() // testPolicy: Sonnet has jp. but no same-tier sibling
    const conv = new Conversation().push(userText('hi'))
    await hz.cc(conv.body())
    conv.push(assistantText('a'), userText('b'))
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 503 })
    expect((await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({
      action: 'retain', model: SONNET, point: 'failover', reason: expect.stringMatching(/^failover: exhausted for global\.anthropic\.claude-sonnet-5-5 \(no profile rotation on 503\)/),
    })
    const hz2 = new Harness()
    const { conv: loop } = await toolLoop(hz2)
    await hz2.cc(loop.body(), {}, { at: T0 + 1 * SEC, status: 503 })
    expect((await hz2.cc(loop.body(), {}, { at: T0 + 2 * SEC })).decision.reason).toMatch(/^failover: exhausted .*\(hard lock: tool loop, no sibling; no profile rotation on 503\)/)
  })

  it("decides from the failed model's own status, never another model's (Sonnet 503, then sibling Opus 429)", async () => {
    const hz = new Harness(siblingPolicy())
    const conv = new Conversation().push(userText('hi'))
    const first = await hz.cc(conv.body())
    conv.push(assistantText('a'), userText('b'))
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 503 })
    expect((await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, status: 429 })).decision).toMatchObject({ model: OPUS, point: 'failover' })
    const st = (await hz.store.get(first.summary.session.lineage))!
    expect(st.lastFailure).toMatchObject({ model: OPUS, status: 429 })
    expect(st.failureStatus).toEqual({ [SONNET]: 503, [OPUS]: 429 })
    // current is still Sonnet: its own 503 does not rotate to jp., and the sibling Opus failed too → retain
    expect((await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC })).decision).toMatchObject({
      action: 'retain', model: SONNET, point: 'failover',
      reason: expect.stringMatching(/^failover: exhausted for global\.anthropic\.claude-sonnet-5-5 \(no profile rotation on 503\)/),
    })
  })

  it('three profiles: an own 429 still tries the untried third profile after the second profile fails with a 5xx', async () => {
    const apac = 'apac.anthropic.claude-sonnet-5-5'
    const catalog = { ...fixtureCatalog, models: [...fixtureCatalog.models, { ...priceOf(SONNET_JP), modelId: apac }] }
    const hz = new Harness(testPolicy({
      pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET, failover: [SONNET_JP, apac] }, { model: OPUS }, { model: HAIKU }] } },
    }), { catalog })
    const conv = new Conversation().push(userText('hi'))
    await hz.cc(conv.body())
    conv.push(assistantText('a'), userText('b'))
    await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 429 }) // global. throttled (own status 429)
    const toJp = await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC, status: 503 }) // jp. (or the router's retry) fails with 503
    expect(toJp.decision).toMatchObject({ model: SONNET_JP, point: 'failover' })
    expect((await hz.cc(conv.body(), {}, { at: T0 + 3 * SEC })).decision).toMatchObject({
      action: 'switch', model: apac, point: 'failover',
      reason: expect.stringMatching(/^failover: profile global\.anthropic\.claude-sonnet-5-5 → apac\.anthropic\.claude-sonnet-5-5 after 429; /),
    })
  })

  it('a first-call 5xx with no sibling returns no failover choice: the regular steps re-pick the same profile', async () => {
    const hz = new Harness() // testPolicy: Sonnet has jp. but no same-tier sibling
    const body = new Conversation().push(userText('hi')).body()
    await hz.cc(body, {}, { at: T0 + 1 * SEC, status: 503 })
    const d = (await hz.cc(body, {}, { at: T0 + 2 * SEC })).decision
    expect(d).toMatchObject({ action: 'initialize', model: SONNET })
    expect(d.point).not.toBe('failover')
    // with 429 the same first call rotates to jp.
    const hz429 = new Harness()
    await hz429.cc(body, {}, { at: T0 + 1 * SEC, status: 429 })
    expect((await hz429.cc(body, {}, { at: T0 + 2 * SEC })).decision).toMatchObject({ action: 'initialize', model: SONNET_JP, point: 'failover' })
  })

  it('legacy state without failureStatus falls back to lastFailure for the same model, else rotates', async () => {
    const after503 = async (strip: (st: SessionState) => void) => {
      const hz = new Harness()
      const conv = new Conversation().push(userText('hi'))
      const first = await hz.cc(conv.body())
      conv.push(assistantText('a'), userText('b'))
      await hz.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 503 })
      const st = (await hz.store.get(first.summary.session.lineage))!
      strip(st)
      await hz.store.put(st)
      return (await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision
    }
    // no failureStatus: lastFailure names Sonnet with 503 → no rotation
    expect(await after503((st) => { delete st.failureStatus })).toMatchObject({ action: 'retain', model: SONNET, point: 'failover', reason: expect.stringMatching(/after 503|on 503/) })
    // no status at all → rotates (pre-profileRotateOn behaviour)
    expect(await after503((st) => { delete st.failureStatus; delete st.lastFailure })).toMatchObject({ model: SONNET_JP, point: 'failover' })
  })

  it('profileRotateOn [429, 503] restores rotation on 503; [] disables it for 429', async () => {
    const on = new Harness(testPolicy({ failover: { profileRotateOn: [429, 503] } }))
    const conv = new Conversation().push(userText('hi'))
    await on.cc(conv.body())
    conv.push(assistantText('a'), userText('b'))
    await on.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 503 })
    expect((await on.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({ model: SONNET_JP, point: 'failover' })
    const off = new Harness(testPolicy({ failover: { profileRotateOn: [] } }))
    await off.cc(new Conversation().push(userText('hi')).body())
    await off.cc(conv.body(), {}, { at: T0 + 1 * SEC, status: 429 })
    expect((await off.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({ action: 'retain', model: SONNET, point: 'failover' })
  })
})

describe('failover of a model outside the pool', () => {
  it('a recently failed pinned model is not retained for an alias request: the user turn moves into the pool', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('hi'))
    await hz.cc(conv.body(), { 'x-router-pin': 'm-pinned' })
    conv.push(assistantText('a'), userText('b'))
    await hz.cc(conv.body(), { 'x-router-pin': 'm-pinned' }, { at: T0 + SEC, status: 429 })
    const d = (await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision
    expect(d).toMatchObject({ action: 'switch', model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^ineligible: m-pinned → /) })
    // inside a tool loop the hard lock still keeps it
    conv.push(assistantToolUse('t', 'x'), toolResult('t', 'y'))
    const hz2 = new Harness()
    await hz2.cc(new Conversation().push(userText('hi')).body(), { 'x-router-pin': 'm-pinned' })
    await hz2.cc(conv.body(), { 'x-router-pin': 'm-pinned' }, { at: T0 + SEC, status: 503 })
    expect((await hz2.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({ action: 'retain', model: 'm-pinned', point: 'hard-lock-tool-loop' })
  })
})

describe('SessionState.failures bookkeeping', () => {
  it('is bounded by the pool size, pruned to the window, and cleared per model on success', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('hi'))
    const s = await hz.cc(conv.body())
    const lineage = s.summary.session.lineage
    // testPolicy anthropic pool: Opus, Sonnet, jp. Sonnet, Haiku → bound 4
    const pins = ['m1', 'm2', 'm3', 'm4', 'm5']
    for (const [i, m] of pins.entries()) await hz.cc(conv.body(), { 'x-router-pin': m }, { at: T0 + (i + 1) * 100, status: 429 })
    let st = (await hz.store.get(lineage))!
    expect(Object.keys(st.failures!).sort()).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(st.lastFailure).toMatchObject({ model: 'm5', status: 429 })
    // success on m5 clears m5 only (and lastFailure, as before)
    await hz.cc(conv.body(), { 'x-router-pin': 'm5' }, { at: T0 + 1000 })
    st = (await hz.store.get(lineage))!
    expect(Object.keys(st.failures!).sort()).toEqual(['m2', 'm3', 'm4'])
    expect(st.lastFailure).toBeUndefined()
    // anything older than failover.windowMs is pruned on the next record
    await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC })
    expect((await hz.store.get(lineage))!.failures).toBeUndefined()
  })

  it('a legacy state with only lastFailure still fails over', async () => {
    const hz = new Harness()
    const conv = new Conversation().push(userText('hi'))
    const s = await hz.cc(conv.body())
    const st = (await hz.store.get(s.summary.session.lineage))!
    st.lastFailure = { model: SONNET, status: 429, atMs: T0 + SEC }
    delete st.failures
    await hz.store.put(st)
    conv.push(assistantText('a'), userText('b'))
    expect((await hz.cc(conv.body(), {}, { at: T0 + 2 * SEC })).decision).toMatchObject({ model: SONNET_JP, point: 'failover' })
  })
})

describe('failover inside a response chain (2026-11-04 item C)', () => {
  it('never rotates the profile: the exact model id is retained (failover-chain-locked)', async () => {
    // The fixture catalog has no second Sol profile, so Kimi stands in as Sol's failover profile.
    const hz = new Harness(testPolicy({
      pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: SOL, failover: [KIMI] }] } },
    }))
    const hdr = { 'x-session-id': 'chain' }
    await hz.step('openai-responses', { model: 'auto', input: 'hi' }, hdr, { responseId: 'resp_1' })
    const next = { model: 'auto', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'go' }] }
    await hz.step('openai-responses', next, hdr, { at: T0 + SEC, status: 503 })
    const d = (await hz.step('openai-responses', next, hdr, { at: T0 + 2 * SEC })).decision
    expect(d).toMatchObject({ action: 'retain', model: SOL, point: 'failover' })
    expect(d.reason).toMatch(/^failover-chain-locked: global\.openai\.gpt-6\.1-sol failed after 503, previous_response_id resp_1 stays on the same profile; /)
    // without the chain a 429 rotates to the next profile
    const free = new Harness(testPolicy({
      pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: SOL, failover: [KIMI] }] } },
    }))
    const items: unknown[] = [{ role: 'user', content: 'hi' }]
    await free.step('openai-responses', { model: 'auto', input: items }, hdr)
    items.push({ type: 'message', role: 'assistant', content: [] }, { role: 'user', content: 'go' })
    await free.step('openai-responses', { model: 'auto', input: items }, hdr, { at: T0 + SEC, status: 429 })
    expect((await free.step('openai-responses', { model: 'auto', input: items }, hdr, { at: T0 + 2 * SEC })).decision)
      .toMatchObject({ action: 'switch', model: KIMI, point: 'failover', reason: expect.stringMatching(/^failover: profile /) })
  })

  it('with no current model the chain is not rotated either (chain-state-missing default)', async () => {
    const hz = new Harness(testPolicy({
      pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: SOL, failover: [KIMI] }] } },
    }))
    const next = { model: 'auto', previous_response_id: 'resp_x', input: [{ role: 'user', content: 'go' }] }
    await hz.step('openai-responses', next, { 'x-session-id': 'c2' }, { status: 429 })
    const d = (await hz.step('openai-responses', next, { 'x-session-id': 'c2' }, { at: T0 + SEC })).decision
    expect(d).toMatchObject({ model: SOL, point: 'hard-lock-response-chain', reason: expect.stringMatching(/^chain-state-missing: /) })
  })
})
