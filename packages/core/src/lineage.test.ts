// Follow-up 2026-11-04, items 2, 6, 7: root index (noteRoot), sub-agent detection, lineage kind and the
// costModeledSubagentFast preset (incl. replay's hand-built summary shape).
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, SONNET } from './__fixtures__/catalog.ts'
import {
  assistantText, assistantToolUse, Conversation, EXPLORE_SYSTEM, FakeProvider, Harness, SEC, T0, testPolicy, toolResult, userText,
} from './__fixtures__/traces.ts'
import { createEngine } from './engine.ts'
import { PolicyError, validatePolicy } from './policy.ts'
import { policyPresets } from './presets.ts'
import { InMemoryStateStore } from './store-memory.ts'
import { summarize } from './summarize/index.ts'
import type { LastTurn, RequestSummary, SessionState, StateStore } from './types.ts'

const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`

describe('InMemoryStateStore.noteRoot', () => {
  it('answers are stable per (root, lineage) and the index stays bounded', async () => {
    const st = new InMemoryStateStore({ maxEntries: 2, maxLineagesPerRoot: 2 })
    expect(await st.noteRoot('r1', 'a')).toEqual({ rootSeen: false, lineageSeen: false })
    // the root's first lineage never reads as "new under a seen root"
    expect(await st.noteRoot('r1', 'a')).toEqual({ rootSeen: false, lineageSeen: true })
    expect(await st.noteRoot('r1', 'b')).toEqual({ rootSeen: true, lineageSeen: false })
    // a retry / concurrent first call of the same lineage keeps its answer
    expect(await st.noteRoot('r1', 'b')).toEqual({ rootSeen: true, lineageSeen: true })
    await st.noteRoot('r1', 'c') // 'b' is the oldest non-first lineage of r1 → evicted; 'a' (first) stays
    expect(await st.noteRoot('r1', 'a')).toEqual({ rootSeen: false, lineageSeen: true })
    expect(await st.noteRoot('r1', 'b')).toEqual({ rootSeen: true, lineageSeen: false })
    await st.noteRoot('r2', 'x')
    await st.noteRoot('r3', 'y') // r1 is the least recently used root → evicted
    expect(st.rootCount).toBe(2)
    expect(await st.noteRoot('r1', 'b')).toEqual({ rootSeen: false, lineageSeen: false })
  })

  it('put() under a known root keeps the root from being evicted', async () => {
    const st = new InMemoryStateStore({ maxEntries: 2 })
    await st.noteRoot('r1', 'r1/main')
    await st.noteRoot('r2', 'r2/main')
    await st.put({ key: { root: 'r1', lineage: 'r1/main', source: 'header' }, perModel: {}, turns: 0, switches: 0, lastSeenMs: 0 })
    await st.noteRoot('r3', 'r3/main') // evicts r2, not the active r1
    expect(await st.noteRoot('r1', 'r1/sub')).toEqual({ rootSeen: true, lineageSeen: false })
    expect(await st.noteRoot('r2', 'r2/main')).toEqual({ rootSeen: false, lineageSeen: false })
  })
})

describe('decide: transparent sub-agent detection (item 2)', () => {
  it('a new lineage under a seen root is subagent-start; noteRoot runs once, only without lineage state', async () => {
    const inner = new InMemoryStateStore()
    let calls = 0
    const store: StateStore = {
      get: (l) => inner.get(l), put: (s) => inner.put(s),
      noteRoot: (r, l) => { calls++; return inner.noteRoot(r, l) },
    }
    const engine = createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store })
    const hdr = { 'x-claude-code-session-id': 'cc-1' }
    const step = async (body: unknown, at: number) => {
      const s = engine.summarize('anthropic-messages', body, hdr, at)
      const d = await engine.decide(s)
      await engine.record(s, d, { servedModel: d.model, status: 200 })
      return d
    }
    const main = new Conversation().push(userText('hi'))
    expect((await step(main.body(), T0)).point).toBe('session-start')
    expect(calls).toBe(1)
    main.push(assistantText('ok'), userText('more'))
    expect((await step(main.body(), T0 + SEC)).point).toBe('user-turn')
    expect(calls).toBe(1) // lineage has state: no root lookup
    const sub = await step(new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look')).body(), T0 + 2 * SEC)
    expect(sub).toMatchObject({ action: 'initialize', point: 'subagent-start' })
    expect(sub.reason).toMatch(/^subagent-start: new lineage under seen root, tier=standard via default → /)
    expect(calls).toBe(2)
  })

  it('a retry after an unrecorded first call (4xx) and concurrent first calls stay subagent-start on the same model', async () => {
    const hz = new Harness(policyPresets.costModeledSubagentFast)
    await hz.cc(new Conversation().push(userText('main')).body())
    const sub = new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look'))
    const rejected = await hz.cc(sub.body(), {}, { at: T0 + SEC, status: 400 }) // record() stores nothing
    const retry = await hz.cc(sub.body(), {}, { at: T0 + 2 * SEC })
    expect(rejected.decision).toMatchObject({ point: 'subagent-start', model: HAIKU })
    expect(retry.decision).toMatchObject({ point: 'subagent-start', model: HAIKU })
    expect((await hz.store.get(retry.summary.session.lineage))!.kind).toBe('subagent')

    // two parallel sub-agents of one type share a lineage; both first calls are decided before any record
    const hdr = { 'x-claude-code-session-id': 'sess-1' }
    const PLAN = 'You are a planning agent. Produce a plan.'
    const a = hz.engine.summarize('anthropic-messages', new Conversation({ system: PLAN }).push(userText('plan a')).body(), hdr, T0 + 3 * SEC)
    const b = hz.engine.summarize('anthropic-messages', new Conversation({ system: PLAN }).push(userText('plan b')).body(), hdr, T0 + 3 * SEC)
    expect(a.session.lineage).toBe(b.session.lineage)
    const [da, db] = await Promise.all([hz.engine.decide(a), hz.engine.decide(b)])
    expect([da.point, db.point]).toEqual(['subagent-start', 'subagent-start'])
    expect(db.model).toBe(da.model)
  })

  it('kind keeps a sub-agent hint even when the lineage starts with a pinned call', async () => {
    const hz = new Harness(policyPresets.costModeledSubagentFast)
    const sub = new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look'))
    const pinned = await hz.cc(sub.body(), { 'x-router-parent-session': 'p-1', 'x-router-pin': SONNET })
    expect(pinned.decision.point).toBe('pinned')
    expect((await hz.store.get(pinned.summary.session.lineage))!.kind).toBe('subagent')
    sub.push(assistantText('found'), userText('and the tests?'))
    const next = await hz.cc(sub.body(), { 'x-router-parent-session': 'p-1' }, { at: T0 + 30 * SEC })
    // the sub-agent rule applies (desired fast), so the user turn evaluates a downgrade instead of 'retain: same-tier'
    expect(next.decision.reason).toMatch(/^(downgrade|downgrade-rejected:[a-z-]+): standard→fast /)
  })

  it('without noteRoot on the store, behavior is unchanged (session-start)', async () => {
    const inner = new InMemoryStateStore()
    const store: StateStore = { get: (l) => inner.get(l), put: (s) => inner.put(s) }
    const engine = createEngine({ policy: testPolicy(), catalog: fixtureCatalog, store })
    const hdr = { 'x-claude-code-session-id': 'cc-1' }
    const a = engine.summarize('anthropic-messages', new Conversation().push(userText('hi')).body(), hdr, T0)
    await engine.record(a, await engine.decide(a), { servedModel: SONNET, status: 200 })
    const b = engine.summarize('anthropic-messages', new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look')).body(), hdr, T0 + SEC)
    expect((await engine.decide(b)).point).toBe('session-start')
  })

  it('x-claude-code-parent-agent-id is a parent hint; root and lineage are unchanged', () => {
    const body = new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look')).body()
    const plain = summarize('anthropic-messages', body, { 'x-claude-code-session-id': 'cc-1' }, T0)
    const hinted = summarize('anthropic-messages', body, { 'x-claude-code-session-id': 'cc-1', 'x-claude-code-parent-agent-id': 'agent-0' }, T0)
    expect(hinted.hints.parentSession).toBe('agent-0')
    expect(hinted.session).toEqual(plain.session)
    const both = summarize('anthropic-messages', body, { 'x-claude-code-session-id': 'cc-1', 'x-claude-code-parent-agent-id': 'agent-0', 'x-router-parent-session': 'p' }, T0)
    expect(both.hints.parentSession).toBe('p')
    expect(both.session.root).toBe('p')
  })
})

describe('lineage kind and costModeledSubagentFast (items 6, 7)', () => {
  it('rules can match when.lineageKind; validatePolicy rejects other values', () => {
    expect(() => validatePolicy({ version: 'v', mode: 'auto', pools: {}, rules: [{ id: 'x', when: { lineageKind: 'child' }, tier: 'fast' }] }))
      .toThrow(PolicyError)
    expect(policyPresets.costModeledSubagentFast).toMatchObject({ version: 'preset-cost-modeled-subagent-fast-v2', userTurn: 'cost-gated' })
    expect(policyPresets.costModeledSubagentFast.rules).toEqual([{ id: 'subagent-fast', when: { lineageKind: 'subagent' }, tier: 'fast' }])
    expect(policyPresets.costModeled.rules).toEqual([])
    expect(policyPresets.boundaryGated.rules).toEqual([])
  })

  it('Claude Code trace: the sub-agent starts on fast, the main lineage stays standard', async () => {
    const hz = new Harness(policyPresets.costModeledSubagentFast)
    const main = new Conversation().push(userText(`Refactor. ${big(30_000)}`))
    const m1 = await hz.cc(main.body())
    expect(m1.decision).toMatchObject({ point: 'session-start', model: SONNET })
    main.push(assistantToolUse('t1', 'Task: explore'))
    const sub = new Conversation({ system: EXPLORE_SYSTEM }).push(userText('Explore the tokenizer.'))
    const s1 = await hz.cc(sub.body(), {}, { at: T0 + SEC })
    expect(s1.decision).toMatchObject({ point: 'subagent-start', model: HAIKU, reason: expect.stringContaining('via rule:subagent-fast') })
    sub.push(assistantToolUse('s1', 'cat'), toolResult('s1', 'code'))
    expect((await hz.cc(sub.body(), {}, { at: T0 + 2 * SEC })).decision.model).toBe(HAIKU)
    main.push(toolResult('t1', 'summary'))
    expect((await hz.cc(main.body(), {}, { at: T0 + 3 * SEC })).decision.model).toBe(SONNET)
    for (let i = 0; i < 3; i++) {
      main.push(assistantText(`done ${i}`), userText(`next ${i}`))
      const d = (await hz.cc(main.body(), {}, { at: T0 + (10 + i * 20) * SEC })).decision
      expect(d).toMatchObject({ model: SONNET, point: 'user-turn', reason: expect.stringMatching(/^retain: same-tier/) })
    }
    expect((await hz.store.get(m1.summary.session.lineage))!.kind).toBe('root')
    expect((await hz.store.get(s1.summary.session.lineage))!.kind).toBe('subagent')
  })

  // Replay builds summaries by hand: main lineage === root; a sub-agent lineage differs from the root and
  // (cooperative mode) carries hints.parentSession. Its store may lack noteRoot.
  const replaySummary = (lineage: string, root: string, n: number, lastTurn: LastTurn, at: number, parent?: string): RequestSummary => ({
    dialect: 'anthropic-messages',
    requestedModel: 'auto',
    session: { root, lineage, source: parent ? 'cooperative' : 'header' },
    lastTurn,
    nonPortableState: [],
    prefix: {
      toolsHash: `tools:${lineage}`, systemHash: `system:${lineage}`,
      blockHashes: [`tools:${lineage}`, `system:${lineage}`, ...Array.from({ length: n }, (_, i) => `${lineage}#${i}`)],
      estPromptTokens: 20_000 + n * 1500, messageCount: n,
    },
    hints: parent ? { parentSession: parent } : {},
    receivedAt: at,
  })

  it.each([
    ['InMemoryStateStore, cooperative', true, true, false],
    ['store without noteRoot, cooperative', false, true, false],
    ['InMemoryStateStore, transparent', true, false, false],
    ['InMemoryStateStore, sub-agent call first', true, true, true],
  ])('replay shape (%s): main stays standard across turns, the sub-agent goes fast', async (_n, withNoteRoot, cooperative, subFirst) => {
    const inner = new InMemoryStateStore()
    const store: StateStore = withNoteRoot ? inner : { get: (l) => inner.get(l), put: (s) => inner.put(s) }
    const engine = createEngine({ policy: policyPresets.costModeledSubagentFast, catalog: fixtureCatalog, store })
    const provider = new FakeProvider()
    const run = async (s: RequestSummary) => {
      const d = await engine.decide(s)
      await engine.record(s, d, { servedModel: d.model, status: 200, usage: provider.call(d.model, s) })
      return d
    }
    const ROOT = 'sess-42'
    const SUB = `${ROOT}/sub-1`
    const subCall = (n: number, lastTurn: LastTurn, at: number) => replaySummary(SUB, ROOT, n, lastTurn, at, cooperative ? ROOT : undefined)
    const mainModels: string[] = []
    const subModels: string[] = []
    let t = T0
    if (subFirst) subModels.push((await run(subCall(1, 'user-text', t))).model)
    for (let turn = 0; turn < 4; turn++) {
      t += 30 * SEC
      mainModels.push((await run(replaySummary(ROOT, ROOT, 1 + turn * 3, 'user-text', t))).model)
      t += SEC
      mainModels.push((await run(replaySummary(ROOT, ROOT, 2 + turn * 3, 'tool-result', t))).model)
      if (turn === 1 && !subFirst) {
        subModels.push((await run(subCall(1, 'user-text', t + SEC))).model)
        subModels.push((await run(subCall(2, 'tool-result', t + 2 * SEC))).model)
      }
    }
    // Every case can tell the sub-agent apart: the parentSession hint, or the root index (noteRoot).
    expect(new Set(mainModels)).toEqual(new Set([SONNET]))
    expect(new Set(subModels)).toEqual(new Set([HAIKU]))
    expect((await inner.get(ROOT) as SessionState).kind).toBe('root')
    expect((await inner.get(SUB))!.kind).toBe('subagent')
  })

  it('transparent sub-agent without noteRoot cannot be detected (kind root, documented limitation)', async () => {
    const inner = new InMemoryStateStore()
    const engine = createEngine({ policy: policyPresets.costModeledSubagentFast, catalog: fixtureCatalog, store: { get: (l) => inner.get(l), put: (s) => inner.put(s) } })
    const s = replaySummary('sess-1/sub', 'sess-1', 1, 'user-text', T0)
    const d = await engine.decide(s)
    expect(d).toMatchObject({ point: 'session-start', model: SONNET })
    await engine.record(s, d, { servedModel: d.model, status: 200 })
    expect((await inner.get('sess-1/sub'))!.kind).toBe('root')
  })

  it('kind is persisted on a failure-created state and reused on the retry after the window', async () => {
    const hz = new Harness(policyPresets.costModeledSubagentFast)
    await hz.cc(new Conversation().push(userText('main')).body())
    const sub = new Conversation({ system: EXPLORE_SYSTEM }).push(userText('look'))
    const failed = await hz.cc(sub.body(), {}, { at: T0 + SEC, status: 503 })
    expect(failed.decision.point).toBe('subagent-start')
    const created = (await hz.store.get(failed.summary.session.lineage))!
    expect(created.kind).toBe('subagent')
    expect(created.current).toBeUndefined()
    const retry = await hz.cc(sub.body(), {}, { at: T0 + 30 * SEC })
    expect(retry.decision).toMatchObject({ point: 'subagent-start', model: HAIKU })
  })
})
