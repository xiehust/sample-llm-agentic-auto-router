import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { output, responsesBody } from '../__fixtures__/fixtures.ts'
import { defaultPackDir, loadPack, packDirs } from '../pack.ts'
import { fakeTransport } from '../transport.ts'
import { handItems, parseHandItems, parseSwebench, scenarioCard, trajectoryItems } from './datasets.ts'
import { promptBytesOf, runEval, worstCaseUsd, type EvalResult } from './harness.ts'
import { INVOKE_PATHS } from './live-transport.ts'
import { costOf, findModel } from '@auto-router/pricing'
import { selectAdapter } from '../adapters/index.ts'
import { outputSchema } from '../schema.ts'
import { resampleHints } from './hints.ts'
import { buildReport, metrics, recommend, renderReport, stability, sweep } from './report.ts'
import { Ledger } from './scrub.ts'

const PKG = fileURLToPath(new URL('../../', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'assessor-eval-'))
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const grams = (s: string, n = 8) => { const w = norm(s).split(' '); const out = new Set<string>(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out }

const res = (over: Partial<EvalResult>): EvalResult => ({
  itemId: 'x', dataset: 'hand', category: 'c', gold: 'fast', model: 'm', variant: 'v', status: 'ok', latencyMs: 1000, called: true, packVersion: 'p', ...over,
})

describe('datasets', () => {
  it('builds cards through buildCard for the committed hand-labelled and trajectory sets', () => {
    const hand = handItems(join(PKG, 'eval/handlabelled.v1.jsonl'))
    expect(hand).toHaveLength(80)
    const traj = trajectoryItems(join(PKG, 'eval/trajectories.v1.jsonl'))
    expect(traj).toHaveLength(80)
    const sub = hand.find((h) => h.card.lineage.kind === 'subagent')
    expect(sub?.card.lineage.parentTier).toBe('standard')
    const second = traj.find((t) => t.id === 'tj-01#t1')!
    expect(second.card.stats.turnIndex).toBe(1)
    expect(second.card.firstUser?.text).toContain('--limit')
    expect(second.card.stats.prevTurnToolCalls).toBe(5)
  })
  it('passes previous-turn tool errors into the card', () => {
    const c = scenarioCard({ latest: 'still failing', first: 'fix it', lineage: 'root', turnIndex: 2, prevTurnToolCalls: 4, prevTurnToolErrors: 3 })
    expect(c.stats.prevTurnToolCalls).toBe(4)
    expect(c.stats.prevTurnToolErrors).toBe(3)
  })
  it('keeps the eval sets disjoint from the few-shot examples of every pack (normalized text and 8-grams)', () => {
    const exTexts = Object.values(packDirs).map((d) => loadPack(d)).flatMap((p) => p.examples.map((e) => JSON.stringify(e.card)))
    const exGrams = new Set(exTexts.flatMap((t) => [...grams(t)]))
    const evalTexts = [
      ...parseHandItems(join(PKG, 'eval/handlabelled.v1.jsonl')).flatMap((h) => [h.latest, h.first ?? '']),
      ...readFileSync(join(PKG, 'eval/trajectories.v1.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => (JSON.parse(l) as { turns: { latest: string }[] }).turns.map((t) => t.latest)),
    ].filter(Boolean)
    for (const t of evalTexts) {
      // Acknowledgement-only follow-ups ("ok", "thanks") are below the precheck size and carry no task content.
      if (norm(t).split(' ').length >= 4) expect(exTexts.some((e) => norm(e).includes(norm(t))), t).toBe(false)
      for (const g of grams(t)) expect(exGrams.has(g), `8-gram overlap: "${g}"`).toBe(false)
    }
  })
  it('rejects malformed rows', () => {
    const d = tmp()
    writeFileSync(join(d, 'swe.jsonl'), JSON.stringify({ instance_id: 'a', repo: 'r', problem_statement: 'p', difficulty: '2 weeks' }) + '\n')
    expect(() => parseSwebench(join(d, 'swe.jsonl'))).toThrow(/unknown difficulty/)
    writeFileSync(join(d, 'swe2.jsonl'), '[1,2]\n')
    expect(() => parseSwebench(join(d, 'swe2.jsonl'))).toThrow(/not an object/)
    writeFileSync(join(d, 'hand.jsonl'), JSON.stringify({ id: 'h', category: 'c', gold: 'ultra', latest: 'x' }) + '\n')
    expect(() => parseHandItems(join(d, 'hand.jsonl'))).toThrow(/bad gold/)
  })
})

describe('harness', () => {
  it('runs items, scrubs ids and stops at the budget cap', async () => {
    const items = handItems(join(PKG, 'eval/handlabelled.v1.jsonl')).slice(0, 6)
    // No usage in the body: cost unknown, so each call is booked at its worst-case reservation.
    const t = fakeTransport(() => ({ body: responsesBody(JSON.stringify(output(['explore-readonly'])), { usage: undefined }) }))
    const catalog = loadCatalog()
    const est = worstCaseUsd(catalog, 'global.openai.gpt-6-luna', 20_000, 800)
    const ledger = new Ledger(join(tmp(), 'l.json'), 3.5 * est) // the actual (cached) cost is far below the reservation
    const { results, stoppedByBudget } = await runEval({ items, model: 'global.openai.gpt-6-luna', transport: t, catalog, ledger, concurrency: 1 })
    expect(results.length).toBeGreaterThanOrEqual(3)
    expect(results.length + stoppedByBudget).toBe(6)
    expect(stoppedByBudget).toBeGreaterThan(0)
    expect(ledger.spentUsd).toBeLessThanOrEqual(3.5 * est)
    expect(results[0]).toMatchObject({ status: 'ok', proposedTier: 'fast', tierAt0: 'fast', called: true })
    expect(JSON.stringify(results)).not.toMatch(/resp_|msg_/)
  })
})

describe('worst-case reservation', () => {
  it('bounds the real cost even when the whole prompt is a Haiku cache write and every byte is a token', () => {
    const catalog = loadCatalog()
    for (const id of ['global.openai.gpt-6-luna', 'global.anthropic.claude-haiku-5-5']) {
      const price = findModel(catalog, id)!
      const bytes = promptBytesOf('系'.repeat(5000), 'x', {})
      const est = worstCaseUsd(catalog, id, bytes, 800)
      for (const ttl of [price.cache.defaultTtl, ...price.cache.ttls]) {
        const cost = costOf({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: { [ttl]: bytes }, outputTokens: 800, promptTokens: bytes }, price).total
        expect(cost).toBeLessThanOrEqual(est + 1e-12)
      }
      expect(costOf({ uncachedInputTokens: bytes, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 800, promptTokens: bytes }, price).total).toBeLessThanOrEqual(est + 1e-12)
    }
  })
  it('the live transport allows exactly the adapters\' invocation paths', () => {
    const catalog = loadCatalog()
    const schema = outputSchema([{ id: 'r' }])
    const cfg = { maxOutputTokens: 1, reasoningEffort: null, cache: false, packVersion: 'v' }
    const paths = [
      selectAdapter(findModel(catalog, 'global.openai.gpt-6-luna')!).buildRequest({ model: 'm', system: 's', user: 'u', schema, cfg }).path,
      selectAdapter(findModel(catalog, 'global.openai.gpt-6-luna')!, 'chat').buildRequest({ model: 'm', system: 's', user: 'u', schema, cfg }).path,
      selectAdapter(findModel(catalog, 'global.anthropic.claude-haiku-5-5')!).buildRequest({ model: 'm', system: 's', user: 'u', schema, cfg }).path,
    ]
    expect([...INVOKE_PATHS].sort()).toEqual([...new Set(paths)].sort())
  })
})

describe('report', () => {
  it('computes confusion, fast precision, frontier recall and the threshold sweep', () => {
    const rs = [
      res({ itemId: 'a', gold: 'fast', proposedTier: 'fast', tierAt0: 'fast', confidence: 0.9 }),
      res({ itemId: 'b', gold: 'standard', proposedTier: 'fast', tierAt0: 'fast', confidence: 0.85 }),
      res({ itemId: 'c', gold: 'frontier', proposedTier: 'frontier', tierAt0: 'frontier', confidence: 0.95 }),
      res({ itemId: 'd', gold: 'frontier', tierAt0: 'standard', confidence: 0.6 }),
      res({ itemId: 'e', gold: 'standard', status: 'unavailable', reason: 'timeout: x', called: true }),
    ]
    const m = metrics(rs)
    expect(m.confusion.standard.fast).toBe(1)
    expect(m.fastPrecision).toBe(0.5)
    expect(m.frontierRecall).toBe(0.5)
    expect(m.unavailableByCode).toEqual({ timeout: 1 })
    expect(m.fastFalsePositives).toEqual(['b'])
    const s = sweep(rs)
    expect(s.find((x) => x.threshold === 0.5)!.coverage).toBeCloseTo(4 / 5)
    expect(s.find((x) => x.threshold === 0.9)!.fastPrecision).toBe(1)
    expect(recommend(s).threshold).toBe(0.95) // fewer than 5 fast predictions anywhere
    const md = renderReport(buildReport(rs))
    expect(md).toContain('fast precision')
    expect(md).toContain('no licence declared')
  })
  it('measures hint stability with held tiers', () => {
    const t = (id: string, gold: EvalResult['gold'], p?: EvalResult['proposedTier'], status: EvalResult['status'] = 'ok') =>
      res({ itemId: id, dataset: 'traj', gold, status, ...(p ? { proposedTier: p } : {}) })
    const st = stability([
      t('a#t0', 'standard', 'standard'), t('a#t1', 'standard', 'fast'), t('a#t2', 'standard', 'standard'), t('a#t3', 'standard'), t('a#t4', 'fast', 'fast'),
      t('b#t0', 'fast', 'fast'), t('b#t1', 'fast', undefined, 'unavailable'), t('b#t2', 'fast', 'fast'),
    ])
    expect(st.trajectories).toBe(2)
    expect(st.transitions).toBe(6)
    expect(st.rawFlips).toBe(2) // a: s→f, f→s
    expect(st.heldFlips).toBe(3) // a: s→f, f→s, (none keeps s) s→f
    expect(st.heldDownFlips).toBe(2)
    expect(st.heldDownThenUp).toBe(1)
    expect(st.spuriousFlips).toBe(2)
    expect(st.goldChangeFollowRate).toBe(1)
    expect(st.flipsAtGoldChange).toBe(1) // a#t4 standard→fast with gold standard→fast
    expect(st.flipShareAtGoldChange).toBeCloseTo(1 / 3)
    expect(st.flipsByTurn).toEqual([0, 1, 1, 0, 1])
  })
})

describe('hints', () => {
  it('resamples hints.tier per (lineage, turn) from the confusion row and keeps other fields', () => {
    const d = tmp()
    const trace = [
      { lineage: 'L1', seq: 0, lastTurn: 'user-text', hints: { tier: 'fast' } },
      { lineage: 'L1', seq: 1, lastTurn: 'tool-result', hints: { tier: 'fast' } },
      { lineage: 'L1', seq: 2, lastTurn: 'user-text' },
      { lineage: 'L2', seq: 0, lastTurn: 'user-text', hints: { tier: 'fast' }, other: 1 },
    ]
    writeFileSync(join(d, 'in.jsonl'), trace.map((x) => JSON.stringify(x)).join('\n') + '\n')
    // gold fast → always predicted standard; gold standard → always none
    const results = [res({ gold: 'fast', proposedTier: 'standard' }), res({ gold: 'standard' })]
    const stats = resampleHints({ tracePath: join(d, 'in.jsonl'), results, model: 'm', outPath: join(d, 'out.jsonl') })
    const out = readFileSync(join(d, 'out.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(out[0]!.hints).toEqual({ tier: 'standard' })
    expect(out[1]!.hints).toEqual({ tier: 'standard' }) // within the turn: same as the turn start
    expect(out[2]!.hints).toBeUndefined() // gold standard → none → hint removed
    expect(out[3]).toMatchObject({ hints: { tier: 'standard' }, other: 1 })
    expect(stats.turns).toBe(3)
  })
})

describe('pack v2', () => {
  it('loads, validates and renders with its own version', () => {
    const v2 = loadPack(packDirs.v2)
    expect(v2.id).toBe('assessor/v2')
    expect(v2.rules.map((r) => r.id)).toEqual(loadPack(packDirs.v1).rules.map((r) => r.id))
    expect(v2.rules.every((r) => !r.auto)).toBe(true)
    expect(v2.rules.find((r) => r.id === 'mechanical-edit')!.instruction).toMatch(/suggests or sketches a fix is NOT a specified change/)
  })
})

describe('default pack selection', () => {
  it('defaults to v2.1 while v1 and v2 stay selectable', () => {
    expect(loadPack().id).toBe('assessor/v2.1')
    expect(defaultPackDir).toBe(packDirs['v2.1'])
    expect(loadPack(packDirs.v1).id).toBe('assessor/v1')
    expect(loadPack(packDirs.v2).id).toBe('assessor/v2')
  })
})

describe('pack v2.1', () => {
  const v1 = loadPack(packDirs.v1)
  const v2 = loadPack(packDirs.v2)
  const v21 = loadPack(packDirs['v2.1'])
  const rule = (p: typeof v1, id: string) => p.rules.find((r) => r.id === id)!
  it('takes the fast-side rules from v2 and the frontier rule from v1, every rule auto:false', () => {
    expect(v21.id).toBe('assessor/v2.1')
    expect(v21.rules.map((r) => r.id)).toEqual(v1.rules.map((r) => r.id))
    expect(v21.rules.every((r) => !r.auto)).toBe(true)
    expect(rule(v21, 'mechanical-edit')).toEqual(rule(v2, 'mechanical-edit'))
    expect(rule(v21, 'explore-readonly')).toEqual(rule(v2, 'explore-readonly'))
    expect(rule(v21, 'deep-investigation')).toEqual(rule(v1, 'deep-investigation'))
    expect(rule(v21, 'bounded-change').instruction).toMatch(/^.*likely local, and a bug report that points to the faulty code or suggests a fix\.$/)
  })
  it("uses v2's fully-specified definition and v1's routine and deep definitions", () => {
    expect(v21.instructions).toMatch(/proposed or sketched fix is `partially`, not `fully-specified`/)
    const defs = (s: string) => s.slice(s.indexOf('- `routine`'), s.indexOf('`deep`') + 200)
    expect(defs(v21.instructions)).toBe(defs(v1.instructions))
    expect(v21.instructions).not.toMatch(/decide the facts from three questions/)
  })
  it('adds only the suggested-fix → standard example to v1 examples', () => {
    expect(v21.examples.slice(0, v1.examples.length)).toEqual(v1.examples)
    const extra = v21.examples.slice(v1.examples.length)
    expect(extra.map((e) => e.tier)).toEqual(['standard'])
    expect(JSON.stringify(extra[0]!.card)).toMatch(/formatBytes/)
  })
})
