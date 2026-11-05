// Follow-up 2026-11-04, item 4: up to 4 prefix records per (lineage, model), so forks keep the parent warm.
import { describe, expect, it } from 'vitest'
import { OPUS, priceOf, SONNET } from './__fixtures__/catalog.ts'
import { assistantText, Conversation, Harness, MIN, SEC, T0, testPolicy, usage, userText, type Step } from './__fixtures__/traces.ts'
import { estimateCost } from './cost.ts'
import { summarize } from './summarize/index.ts'
import type { SessionState } from './types.ts'
import { blockSetOf, MAX_PREFIX_RECORDS, warmTokens } from './warmth.ts'

const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`
const last = (hs: string[]): string => hs[hs.length - 1] as string
const hashesOf = (st: SessionState, model = SONNET): string[] => st.perModel[model]!.prefixes!.map((r) => r.hash)
const warmOpts = { marginMs: 15_000, minTokens: 512 }

describe('parent and fork interleave (Claude Code compaction / prompt-suggestion forks)', () => {
  it("the fork's record does not evict the parent's: no prefix-reset, no false compaction, no miss", async () => {
    const hz = new Harness()
    const main = new Conversation().push(userText(big(30_000)))
    let t = T0
    const p1 = await hz.cc(main.body(), {}, { at: t })
    for (let turn = 1; turn <= 3; turn++) {
      main.push(assistantText(`answer ${turn}`))
      // fork: the parent's history plus one instruction, same system/tools ⇒ same lineage
      const fork = new Conversation().push(...main.messages, userText(`Suggest the next prompt (${turn}).`))
      const f = await hz.cc(fork.body(), {}, { at: (t += 2 * SEC) })
      expect(f.summary.session.lineage).toBe(p1.summary.session.lineage)
      expect(f.result.miss).toBeUndefined()
      main.push(userText(`next ${turn}`))
      const p = await hz.cc(main.body(), {}, { at: (t += 20 * SEC) })
      expect(p.decision).toMatchObject({ action: 'retain', model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^retain: same-tier; /) })
      expect(p.result.miss).toBeUndefined()
      const st = (await hz.store.get(p.summary.session.lineage))!
      // newest first: the parent's request, then the record it hit (its previous request, refreshed); the
      // fork's record survives because older ancestors are not refreshed and age out first
      const hs = hashesOf(st)
      expect(hs[0]).toBe(last(p.summary.prefix.blockHashes))
      expect(hs).toContain(last(f.summary.prefix.blockHashes))
      expect(hs).toHaveLength(Math.min(turn + 2, MAX_PREFIX_RECORDS))
      expect(st.perModel[SONNET]).toMatchObject({ cachedPrefixHash: last(p.summary.prefix.blockHashes), lastTouchMs: t })
    }
  })

  it('a confirmed miss removes only the records it falsified; the other branch stays', async () => {
    const hz = new Harness()
    const main = new Conversation().push(userText(big(20_000)))
    await hz.cc(main.body())
    main.push(assistantText('a'))
    const f = await hz.cc(new Conversation().push(...main.messages, userText('fork')).body(), {}, { at: T0 + SEC })
    main.push(userText('b'))
    const p = await hz.cc(main.body(), {}, { at: T0 + 2 * SEC, usage: usage(0, 21_000) })
    expect(p.result.miss).toMatchObject({ reason: 'prefix_changed', readTokens: 0 }) // the fork was the lineage's latest write
    const st = (await hz.store.get(p.summary.session.lineage))!
    expect(hashesOf(st)).toEqual([last(p.summary.prefix.blockHashes), last(f.summary.prefix.blockHashes)])
    expect(st.perModel[SONNET]!.cachedTokens).toBe(21_000)
  })
})

describe('record bounds and per-record expiry', () => {
  // Five conversations with different first messages share one lineage (same header, system, tools)
  // but have disjoint chains.
  const branch = (i: number) => new Conversation().push(userText(`${big(3000)} branch ${i}`))

  it(`a ${MAX_PREFIX_RECORDS + 1}th distinct prefix evicts the least recently touched`, async () => {
    const hz = new Harness()
    const steps: Step[] = []
    for (let i = 0; i < 5; i++) steps.push(await hz.cc(branch(i).body(), {}, { at: T0 + i * SEC }))
    const st = (await hz.store.get(steps[0]!.summary.session.lineage))!
    expect(hashesOf(st)).toEqual([4, 3, 2, 1].map((i) => last(steps[i]!.summary.prefix.blockHashes)))
    const probe = (i: number) => summarize('anthropic-messages', branch(i).push(assistantText('x'), userText('y')).body(), { 'x-claude-code-session-id': 'sess-1' }, T0 + 5 * SEC)
    const w = (i: number) => { const s = probe(i); return warmTokens(st, SONNET, s, s.receivedAt, { ...warmOpts, blocks: blockSetOf(s) }) }
    expect(w(0)).toBe(0)
    for (const i of [1, 2, 3, 4]) expect(w(i)).toBe(steps[i]!.summary.prefix.estPromptTokens)
  })

  it('records expire individually; the entry is idle only when every record is', async () => {
    const hz = new Harness()
    const a = await hz.cc(branch(0).body(), {}, { at: T0 })
    await hz.cc(branch(1).body(), {}, { at: T0 + 3 * MIN })
    const at = T0 + 5 * MIN // A: 300 s > 285 s (TTL − margin); B: 120 s
    const st = (await hz.store.get(a.summary.session.lineage))!
    const probeA = summarize('anthropic-messages', branch(0).push(assistantText('x'), userText('y')).body(), { 'x-claude-code-session-id': 'sess-1' }, at)
    const probeB = summarize('anthropic-messages', branch(1).push(assistantText('x'), userText('y')).body(), { 'x-claude-code-session-id': 'sess-1' }, at)
    expect(warmTokens(st, SONNET, probeA, at, { ...warmOpts, blocks: blockSetOf(probeA) })).toBe(0)
    expect(warmTokens(st, SONNET, probeB, at, { ...warmOpts, blocks: blockSetOf(probeB) })).toBeGreaterThan(3000)
    // A's branch went cold on its own: a free prefix-reset, not idle-expired (B keeps the entry alive)
    expect((await hz.cc(branch(0).push(assistantText('x'), userText('y')).body(), {}, { at })).decision.point).toBe('prefix-reset')
  })

  it('a legacy entry without prefixes is one record built from the compat fields', () => {
    const s = summarize('anthropic-messages', branch(0).body(), {}, T0 + SEC)
    const st: SessionState = {
      key: s.session, current: SONNET, turns: 1, switches: 0, lastSeenMs: T0,
      perModel: { [SONNET]: { model: SONNET, cachedPrefixHash: last(s.prefix.blockHashes), cachedTokens: 3000, lastTouchMs: T0, ttlMs: 5 * MIN } },
    }
    expect(warmTokens(st, SONNET, s, T0 + SEC, { ...warmOpts, blocks: blockSetOf(s) })).toBe(3000)
  })
})

describe('switch-back with several records is priced with fragmentation only', () => {
  it("returning to Sonnet reads the parent's record although a fork was recorded after it", async () => {
    const hz = new Harness(testPolicy({ hysteresis: { minTurnsBeforeSwitch: 0 }, horizon: { calls: 5 } }))
    const conv = new Conversation().push(userText(`start ${'x'.repeat(200_000)}`))
    const s1 = await hz.cc(conv.body(), {}, { at: T0 })
    conv.push(assistantText('ok'))
    await hz.cc(new Conversation().push(...conv.messages, userText('fork')).body(), {}, { at: T0 + 5 * SEC })
    conv.push(userText('think harder'))
    expect((await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 20 * SEC })).decision).toMatchObject({ action: 'switch', model: OPUS })
    conv.push(assistantText('done'), userText('carry on'))
    const s3 = await hz.cc(conv.body(), {}, { at: T0 + 40 * SEC })
    const P = s3.summary.prefix.estPromptTokens
    const h = { calls: 5, appendTokensPerCall: 1000, outputTokensPerCall: 250 }
    expect(s3.decision.estimate!.switchUsd).toBeCloseTo(estimateCost(priceOf(SONNET), { warmTokens: s1.summary.prefix.estPromptTokens, promptTokens: P, horizon: h, writeTtl: '5m' }).totalUsd, 12)
    expect(s3.decision).toMatchObject({ action: 'switch', model: SONNET, reason: expect.stringMatching(/^downgrade: /) })
  })
})
