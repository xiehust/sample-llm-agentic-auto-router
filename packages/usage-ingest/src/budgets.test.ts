import { describe, expect, it } from 'vitest'
import { F1, fxCatalog, fxPolicies } from './__fixtures__/fx.ts'
import { effective, evaluateBudgets } from './budgets.ts'
import { ingest } from './ingest.ts'
import { FakeBlocks, FakeBudgets, FakeStore, mapPolicies, payload } from './test-helpers.ts'
import type { RouterLine } from './types.ts'

const NOV = Date.parse('2026-11-08T06:00:00.000Z')
const DEC = Date.parse('2026-12-01T00:10:00.000Z')
const alice = 'user:alice-sub-1'
const line = (reqId: string, principal = alice): RouterLine => {
  const [kind, id] = principal.split(':') as ['user' | 'client', string]
  return { ...F1[0]!, reqId, principal: { kind, id } }
}

function setup(now = NOV) {
  const store = new FakeStore()
  const blocks = new FakeBlocks()
  const budgets = new FakeBudgets()
  let t = now
  const run = (lines: RouterLine[]) => ingest(payload(lines), {
    catalog: fxCatalog, policies: mapPolicies(fxPolicies), store, retentionDays: 90, now: () => t, sleep: async () => {},
    budgets: { source: budgets, blocks },
  })
  return { store, blocks, budgets, run, setNow: (v: number) => { t = v } }
}

describe('budget hard stops', () => {
  it('effective settings: member over default; null means no budget', () => {
    expect(effective({ monthlyUsd: 5 }, { monthlyUsd: 1, hardStop: true })).toEqual({ limitNano: 5_000_000_000, hardStop: true })
    expect(effective({ monthlyUsd: null }, { monthlyUsd: 1, hardStop: true })).toEqual({ hardStop: true })
    expect(effective(undefined, { monthlyUsd: 1 })).toEqual({ limitNano: 1_000_000_000, hardStop: false })
    expect(effective({ hardStop: false }, { monthlyUsd: 1, hardStop: true })).toEqual({ limitNano: 1_000_000_000, hardStop: false })
  })

  it('blocks a principal once spend (model calls + assessor) reaches a hard-stop budget, and writes only on change', async () => {
    const s = setup()
    s.budgets.members[alice] = { monthlyUsd: 0.02, hardStop: true }
    const r1 = await s.run([line('b1')])          // 0.0149375 < 0.02
    expect(r1.budgets).toMatchObject({ evaluated: 1, blocked: 0, written: false })
    expect(s.blocks.doc).toBeUndefined()
    const r2 = await s.run([line('b2')])          // 0.029875 ≥ 0.02
    expect(r2.budgets).toMatchObject({ blocked: 1, written: true })
    expect(s.blocks.doc?.principals).toEqual([{ kind: 'user', id: 'alice-sub-1', reason: 'budget', month: '2026-11', at: '2026-11-08T06:00:00.000Z',
      spentUsd: 0.029875, limitUsd: 0.02 }])
    const r3 = await s.run([line('b3')])          // still blocked: same set, no rewrite
    expect(r3.budgets).toMatchObject({ blocked: 1, written: false })
    expect(s.blocks.writes).toBe(1)
  })

  it('an id outside the router\'s block-list rule is never written (one bad entry would reject the whole file)', async () => {
    const s = setup()
    const odd = 'client:svc+1'
    s.budgets.members[odd] = { monthlyUsd: 0.001, hardStop: true }
    s.budgets.members[alice] = { monthlyUsd: 0.001, hardStop: true }
    const r = await s.run([line('h1', odd), line('h2')])
    expect(r.budgets).toMatchObject({ blocked: 1, unblockable: 1, written: true })
    expect(s.blocks.doc?.principals.map((p) => `${p.kind}:${p.id}`)).toEqual([alice])
  })

  it('soft budgets (no hard stop) and unattributed traffic never block', async () => {
    const s = setup()
    s.budgets.fallback = { monthlyUsd: 0.001 }
    await s.run([line('c1'), { ...F1[0]!, reqId: 'c2' }])
    expect(s.blocks.doc).toBeUndefined()
  })

  it('a listed principal is re-evaluated without new traffic: a raised budget unblocks', async () => {
    const s = setup()
    s.budgets.members[alice] = { monthlyUsd: 0.01, hardStop: true }
    await s.run([line('d1')])
    expect(s.blocks.doc?.principals.length).toBe(1)
    s.budgets.members[alice] = { monthlyUsd: 1, hardStop: true }
    const r = await s.run([line('d2', 'user:someone-else')])
    expect(r.budgets).toMatchObject({ evaluated: 2, blocked: 0, written: true })
    expect(s.blocks.doc?.principals).toEqual([])
  })

  it('a new month starts from zero spend: last month\'s blocks are lifted', async () => {
    const s = setup()
    s.budgets.members[alice] = { monthlyUsd: 0.01, hardStop: true }
    await s.run([line('e1')])
    expect(s.blocks.doc?.principals[0]?.month).toBe('2026-11')
    s.setNow(DEC)
    await s.run([line('e2', 'user:other')])
    expect(s.blocks.doc?.principals).toEqual([])
  })

  it('a concurrent writer: re-read, re-evaluate, write with the new etag', async () => {
    const s = setup()
    s.budgets.members[alice] = { monthlyUsd: 0.01, hardStop: true }
    s.blocks.conflictsLeft = 1
    s.blocks.doc = { schemaVersion: 1, generatedAt: '2026-11-08T05:00:00.000Z', principals: [] }
    const r = await s.run([line('f1')])
    expect(r.budgets).toMatchObject({ written: true, conflicts: 1 })
    expect(s.blocks.doc?.principals.map((p) => p.id)).toEqual(['alice-sub-1'])
  })

  it('gives up after repeated conflicts (the event is retried)', async () => {
    const s = setup()
    s.budgets.members[alice] = { monthlyUsd: 0.01, hardStop: true }
    s.blocks.conflictsLeft = 10
    s.blocks.doc = { schemaVersion: 1, generatedAt: 'x', principals: [] }
    await expect(s.run([line('g1')])).rejects.toThrow(/concurrent writers/)
  })

  it('evaluateBudgets with nothing touched and no file does nothing', async () => {
    const s = setup()
    const r = await evaluateBudgets([], { source: s.budgets, blocks: s.blocks, store: s.store, now: () => NOV })
    expect(r).toEqual({ evaluated: 0, blocked: 0, written: false, conflicts: 0, unblockable: 0 })
  })
})
