import { describe, expect, it } from 'vitest'
import { ALL, F1, F2, F3, F4, fxCatalog, fxPolicies } from './__fixtures__/fx.ts'
import { ingest, type IngestDeps } from './ingest.ts'
import { decodePayload, parseEvents, UnsupportedSchemaError } from './parse.ts'
import { principalKey } from './records.ts'
import { awslogsEvent, FakeStore, mapPolicies, payload } from './test-helpers.ts'
import type { RouterLine } from './types.ts'

const NOW = Date.parse('2026-11-08T06:00:00.000Z')
const deps = (store: FakeStore, over: Partial<IngestDeps> = {}): IngestDeps => ({
  catalog: fxCatalog, policies: mapPolicies(fxPolicies), store, retentionDays: 90, now: () => NOW, sleep: async () => {}, ...over,
})
const alice = { kind: 'user' as const, id: 'a1b2c3d4-0000-4000-8000-0000000alice', group: 'member' }
const bob = { kind: 'client' as const, id: 'svcclient7' }
const as = (p: RouterLine['principal'], lines: RouterLine[]): RouterLine[] => lines.map((l) => ({ ...l, principal: p }))

describe('ingest over 0d fixtures', () => {
  it('reconciles spend exactly and derives savings from rollups (static baseline)', async () => {
    const store = new FakeStore()
    const lines = [...as(alice, [...F1, ...F2, ...F3]), ...as(bob, ALL.slice(5))]
    const r = await ingest(payload(lines), deps(store))
    expect(r).toMatchObject({ requests: 12, written: 12, duplicates: 0, retries: 0 })
    // Spend: Σ costUsd.total, exactly, per month rollup and per record.
    expect(store.sum('A#2026-11', 'spend')).toBe(247_675_000)
    expect(store.records().reduce((s, rec) => s + Number((rec.cost as { a?: number }).a ?? 0), 0)).toBe(247_675_000)
    expect(store.sum('U#user:', 'spend') + store.sum('U#client:', 'spend')).toBe(247_675_000)
    // Net saving N = r − s − x over the static set.
    const n = store.sum('A#', 'r_st') - store.sum('A#', 's_st') - store.sum('A#', 'x_st')
    expect(n).toBe(52_350_000)
    expect(store.sum('A#', 's_st')).toBe(23_000_000)
    expect(store.sum('A#', 'asr')).toBe(400_000)
    expect(store.sum('A#', 'cold')).toBe(69_000_000)
    // Projection over F4 (observe).
    expect(store.sum('A#', 'pr_st') - store.sum('A#', 'ps_st') - store.sum('A#', 'px_st')).toBe(45_737_500)
    // Exclusions and the unmetered bound.
    expect([store.sum('A#', 'ex_pin'), store.sum('A#', 'ex_catalog-mismatch'), store.sum('A#', 'unm'), store.sum('A#', 'bound')]).toEqual([1, 1, 1, 50_000_000])
    // Per-class spend sums to spend here (no rounding residue in these fixtures).
    const cls = ['cIn', 'cRead', 'cWrite', 'cOut'].reduce((s, c) => s + store.sum('A#', c), 0)
    expect(cls).toBe(247_675_000)
    // Budget totals carry spend + assessor per principal.
    expect(store.counters.get('B#user:a1b2c3d4-0000-4000-8000-0000000alice#2026-11|TOTAL')).toMatchObject({ spend: 130_650_000, asr: 400_000 })
  })

  it('tier matrix: the static baseline tier is in the sort key; the served tier is set from the line\'s policy', async () => {
    const store = new FakeStore()
    await ingest(payload(as(alice, [...F1, ...F3])), deps(store))
    const u = `U#${principalKey(alice)}#2026-11`
    expect(store.counters.get(`${u}|08#anthropic-messages#fx.fast#standard`)).toMatchObject({ n_st: 2, r_st: 44_812_500 + 1_950_000 })
    expect(store.sets.get(`${u}|08#anthropic-messages#fx.fast#standard`)).toEqual({ servedTier: 'fast' })
    // a failover profile takes its pool entry's tier
    expect(store.sets.get(`${u}|08#anthropic-messages#fx.standard-geo#standard`)).toEqual({ servedTier: 'standard' })
  })

  it('stores the record fields the console needs, ids and codes only', async () => {
    const store = new FakeStore()
    const l: RouterLine = { ...F2[0]!, principal: alice, session: 'ab12cd34ef56ab78', hints: ['tier=fast'], sanitized: ['user_id'],
      requestedLength: 4, bodyBytes: 1234, bodyReadMs: 2, betaVeto: 'interleaved', miss: { reason: 'ttl_expired', expectedTokens: 10, readTokens: 0 },
      assessor: { id: 'assessor/fx', autoRules: 'pack', called: true, status: 'ok', tier: 'fast', confidence: 0.9, latencyMs: 5, costUsd: 0.0001, applied: true } }
    await ingest(payload([l]), deps(store))
    const [rec] = store.records()
    expect(rec).toMatchObject({
      pk: `P#${principalKey(alice)}`, sk: 'T#2026-11-08T02:00:00.000Z#f2a', gsi1pk: 'D#2026-11-08', gsi1sk: '2026-11-08T02:00:00.000Z#f2a',
      gsi2pk: `S#${principalKey(alice)}#ab12cd34ef56ab78`, principalGroup: 'member', servedTier: 'fast',
      hints: ['tier=fast'], sanitized: ['user_id'], requestedLength: 4, bodyBytes: 1234, bodyReadMs: 2, betaVeto: 'interleaved',
      miss: { reason: 'ttl_expired', expectedTokens: 10, readTokens: 0 },
      assessor: { id: 'assessor/fx', autoRules: 'pack', called: true, costNano: 100_000 },
      decision: { reasonParsed: { code: 'downgrade' } },
      cost: { cls: { input: 250_000, cacheRead: 0, cacheWrite: 25_937_500, output: 2_000_000, total: 28_187_500, tier: 'base' },
        a: 28_187_500, aStar: 5_187_500, routingSwitch: true, b: { static: { model: 'fx.standard', tier: 'standard', nano: 20_750_000 } } },
    })
    expect(rec!.ttl).toBe(Math.floor(Date.parse(l.ts) / 1000) + 90 * 86_400)
    expect(JSON.stringify(rec)).not.toMatch(/"(messages|content|system|prompt|body|text)"/)
  })

  it('is idempotent: a re-delivered batch adds nothing; a partly new batch adds only the new lines', async () => {
    const store = new FakeStore()
    await ingest(payload(as(alice, F1)), deps(store))
    const before = structuredClone([...store.counters])
    const again = await ingest(payload(as(alice, F1)), deps(store))
    expect(again).toMatchObject({ written: 0, duplicates: 1 })
    expect([...store.counters]).toEqual(before)
    const mixed = await ingest(payload(as(alice, [...F1, ...F2])), deps(store))
    expect(mixed).toMatchObject({ written: 2, duplicates: 1 })
    expect(store.sum('A#', 'req')).toBe(3)
    const dupInBatch = await ingest(payload(as(alice, [F3[0]!, F3[0]!])), deps(store))
    expect(dupInBatch).toMatchObject({ written: 1, duplicates: 1 })
  })

  it('retries transaction conflicts with backoff, and gives up (throws) after the attempt budget', async () => {
    const store = new FakeStore()
    store.failures = ['conflict', 'conflict']
    const sleeps: number[] = []
    const r = await ingest(payload(as(alice, F1)), deps(store, { sleep: async (ms) => { sleeps.push(ms) } }))
    expect(r).toMatchObject({ written: 1, retries: 2 })
    expect(sleeps.length).toBe(2)
    const stuck = new FakeStore()
    stuck.failures = Array(20).fill('conflict')
    await expect(ingest(payload(as(alice, F1)), deps(stuck))).rejects.toThrow(/after 8 attempts/)
  })

  it('chunks ≤ 20 requests per transaction and merges rollup deltas per key (≤ 100 items)', async () => {
    const store = new FakeStore()
    const many = Array.from({ length: 45 }, (_, i) => ({ ...F1[0]!, reqId: `m${i}`, ts: `2026-11-08T01:${String(i).padStart(2, '0')}:00.000Z`, principal: i % 2 ? alice : bob }))
    const r = await ingest(payload(many), deps(store))
    expect(r.written).toBe(45)
    expect(store.txSizes.length).toBe(3)
    expect(Math.max(...store.txSizes)).toBeLessThanOrEqual(100)
    expect(store.sum('A#', 'req')).toBe(45)
    expect(store.sum('A#', 'spend')).toBe(45 * 14_937_500)
  })

  it('rejected lines are records too (error code in reason), and count per principal and status, idempotently', async () => {
    const store = new FakeStore()
    const rej = (id: string, status: number): RouterLine => ({ ts: '2026-11-08T07:00:00.000Z', reqId: id, kind: 'rejected', status, principal: alice, reason: 'budget-exceeded' })
    const lines = [rej('r1', 429), rej('r2', 403), rej('r3', 401), rej('r4', 400)]
    await ingest(payload(lines), deps(store))
    await ingest(payload(lines), deps(store))
    expect([store.sum('U#', 'rej'), store.sum('U#', 'rej429'), store.sum('U#', 'rej403'), store.sum('U#', 'rej401'), store.sum('U#', 'rejOther')]).toEqual([4, 1, 1, 1, 1])
    const recs = store.records()
    expect(recs.map((r) => [r.kind, r.status, r.reason])).toEqual([['rejected', 429, 'budget-exceeded'], ['rejected', 403, 'budget-exceeded'],
      ['rejected', 401, 'budget-exceeded'], ['rejected', 400, 'budget-exceeded']])
    expect(recs[0]).toMatchObject({ pk: `P#${principalKey(alice)}`, sk: 'T#2026-11-08T07:00:00.000Z#r1', gsi1pk: 'D#2026-11-08' })
    expect([...store.items.keys()].some((key) => key.startsWith('R#'))).toBe(false)
  })

  it('status classes, reasoning tokens, long-context and boundPartial counters', async () => {
    const store = new FakeStore()
    const base = F1[0]!
    const lines: RouterLine[] = [
      { ...base, reqId: 's1', usage: { ...base.usage!, reasoningTokens: 40 }, costUsd: { ...base.costUsd!, tier: 'long' } },
      { ...base, reqId: 's2', status: 499, clientAborted: true },
      { ts: base.ts, reqId: 's3', kind: 'error', status: 502, error: 'UpstreamError' },
      { ...base, reqId: 's4', usage: undefined, costUsd: undefined, usageMissing: true, costBoundUsd: 0.01, boundPartial: true },
    ]
    await ingest(payload(lines), deps(store))
    expect([store.sum('A#', 's2xx'), store.sum('A#', 's499'), store.sum('A#', 's5xx'), store.sum('A#', 'err')]).toEqual([2, 1, 1, 1])
    expect([store.sum('A#', 'tReason'), store.sum('A#', 'long'), store.sum('A#', 'boundPartial'), store.sum('A#', 'unm')]).toEqual([40, 1, 1, 1])
  })

  it('keeps config lines for the console, with the task from the log stream', async () => {
    const store = new FakeStore()
    const cfg = { ts: '2026-11-08T06:00:00.000Z', kind: 'config', source: 'config', outcome: 'applied', from: '6-20261108T050000Z',
      configVersion: '7-20261108T055900Z', principalsVersion: '"etag-p3"', policyVersion: 'p-7', mode: 'auto', catalogVersion: 'fx-1',
      warnings: ['unknown-group:ops'], blocksEtag: '"etag-b1"', packs: [{ name: 'v2.2', packVersion: 'sha-1' }], drift: { pack: false },
      huge: { blob: 'x'.repeat(5000) }, 'bad key!': 1, pk: 'override-attempt' }
    await ingest(payload([cfg], 'router/router/9f8e7d6c'), deps(store))
    await ingest(payload([cfg], 'router/router/9f8e7d6c'), deps(store))
    const item = store.items.get('C#config|2026-11-08T06:00:00.000Z#9f8e7d6c#config')
    expect(item).toMatchObject({ pk: 'C#config', task: '9f8e7d6c', source: 'config', outcome: 'applied', from: '6-20261108T050000Z',
      configVersion: '7-20261108T055900Z', principalsVersion: '"etag-p3"', policyVersion: 'p-7', mode: 'auto', catalogVersion: 'fx-1',
      warnings: ['unknown-group:ops'], blocksEtag: '"etag-b1"', packs: [{ name: 'v2.2', packVersion: 'sha-1' }], drift: { pack: false },
      huge: { truncated: true } })
    expect(item).not.toHaveProperty('bad key!')
    expect(item).not.toHaveProperty('status')
    const rejected = { ts: '2026-11-08T06:01:00.000Z', kind: 'config', source: 'config', outcome: 'rejected', attempted: '8-x', issues: ['policy.mode: invalid'] }
    await ingest(payload([rejected], 'router/router/9f8e7d6c'), deps(store))
    expect(store.items.get('C#config|2026-11-08T06:01:00.000Z#9f8e7d6c#config')).toMatchObject({ outcome: 'rejected', attempted: '8-x', issues: ['policy.mode: invalid'] })
    // identity watches (a3): same task, same millisecond, different sources → separate items
    const at = '2026-11-08T06:02:00.000Z'
    const watches = ['jwks', 'blocks', 'budget-blocks'].map((source) => ({ ts: at, kind: 'config', source, outcome: 'applied', configVersion: '7-x', blocksEtag: `"${source}"` }))
    await ingest(payload(watches, 'router/router/9f8e7d6c'), deps(store))
    for (const s of ['jwks', 'blocks', 'budget-blocks']) {
      expect(store.items.get(`C#config|${at}#9f8e7d6c#${s}`)).toMatchObject({ source: s, outcome: 'applied', blocksEtag: `"${s}"` })
    }
  })

  it('state lines: only the task\'s latest is kept, as C#state (sk = task, TTL a day); a late batch never rolls it back', async () => {
    const store = new FakeStore()
    const state = (ts: string, over: Record<string, unknown> = {}) => ({ ts, kind: 'config', source: 'state', outcome: 'active',
      configVersion: '7-20261108T055900Z', principalsVersion: '"etag-p3"', policyVersion: 'p-7', mode: 'auto', catalogVersion: 'fx-1',
      effective: { identityMode: { value: 'observe', source: 'document', version: '7-20261108T055900Z' } },
      sources: { policy: 'document', identity: 'document', assessor: 'document', access: 'document' },
      identityKeys: { configured: true, loaded: true, kids: 2, versions: { jwks: '"j1"', blocks: '"b1"' } }, ...over })
    const stream = 'router/router/9f8e7d6c'
    const r1 = await ingest(payload([state('2026-11-08T06:00:00.000Z'), state('2026-11-08T06:05:00.000Z'), state('2026-11-08T06:02:00.000Z')], stream), deps(store))
    expect(r1).toMatchObject({ configs: 3, written: 0, state: 'written' })
    expect([...store.items.keys()]).toEqual(['C#state|9f8e7d6c'])          // no C#config items for state lines
    const item = store.items.get('C#state|9f8e7d6c')
    expect(item).toMatchObject({ pk: 'C#state', sk: '9f8e7d6c', task: '9f8e7d6c', ts: '2026-11-08T06:05:00.000Z', source: 'state', outcome: 'active',
      configVersion: '7-20261108T055900Z', effective: { identityMode: { value: 'observe', source: 'document' } }, sources: { identity: 'document' },
      identityKeys: { configured: true, loaded: true, kids: 2, versions: { jwks: '"j1"', blocks: '"b1"' } },
      ttl: Date.parse('2026-11-08T06:05:00.000Z') / 1000 + 86_400 })
    // a late batch (older line) and a re-delivery (same ts) leave it; a newer line replaces it
    expect((await ingest(payload([state('2026-11-08T06:04:00.000Z', { identityKeys: { configured: true, loaded: false, kids: 0, versions: {} } })], stream), deps(store))).state).toBe('stale')
    expect((await ingest(payload([state('2026-11-08T06:05:00.000Z')], stream), deps(store))).state).toBe('stale')
    expect(store.items.get('C#state|9f8e7d6c')).toMatchObject({ ts: '2026-11-08T06:05:00.000Z', identityKeys: { loaded: true } })
    await ingest(payload([state('2026-11-08T06:10:00.000Z', { identityKeys: { configured: true, loaded: false, kids: 0, versions: {} } })], stream), deps(store))
    expect(store.items.get('C#state|9f8e7d6c')).toMatchObject({ ts: '2026-11-08T06:10:00.000Z', identityKeys: { configured: true, loaded: false, kids: 0 } })
    // the comparison is between instants: a non-canonical ts is stored in canonical ISO form
    await ingest(payload([state('2026-11-08T14:11:00+08:00')], stream), deps(store))
    expect(store.items.get('C#state|9f8e7d6c')).toMatchObject({ ts: '2026-11-08T06:11:00.000Z' })
    // another task has its own item; other config lines in the same batch stay C#config items
    const mixed = await ingest(payload([state('2026-11-08T06:00:00.000Z'), { ts: '2026-11-08T06:00:01.000Z', kind: 'config', source: 'jwks', outcome: 'applied' }], 'router/router/aa11bb22'), deps(store))
    expect(mixed).toMatchObject({ written: 1, state: 'written' })
    expect(store.items.has('C#state|aa11bb22') && store.items.has('C#config|2026-11-08T06:00:01.000Z#aa11bb22#jwks')).toBe(true)
    // a malformed identityKeys is dropped (the console reads that as not loaded)
    await ingest(payload([state('2026-11-08T06:20:00.000Z', { identityKeys: { configured: 'yes', loaded: true } })], 'router/router/cc33dd44'), deps(store))
    expect(store.items.get('C#state|cc33dd44')).not.toHaveProperty('identityKeys')
  })

  it('observe projection: differing count and the projected tier matrix (baseline tier → projected tier)', async () => {
    const store = new FakeStore()
    await ingest(payload(as(alice, F4)), deps(store))
    expect(store.sum('A#', 'pdiff')).toBe(2) // f4a, f4b project fast while standard served; f4c projects standard
    expect([store.sum('A#', 'pmn_st_fast'), store.sum('A#', 'pmn_st_standard')]).toEqual([2, 1])
    expect(store.sum('A#', 'pmr_st_fast')).toBe(44_812_500 + 10_125_000)
    expect(store.sum('A#', 'pmr_st_standard')).toBe(0)
    const [rec] = store.records()
    expect(rec!.cost).toMatchObject({ projection: { model: 'fx.fast', tier: 'fast', switch: false } })
  })

  it('capped decisions: their own row with A, B and R, and tierLimit on the record', async () => {
    const store = new FakeStore()
    const capped: RouterLine = { ...F1[0]!, principal: alice, decision: { ...F1[0]!.decision!, model: 'fx.fast',
      reason: 'session-start: tier=frontier via rule:r1 → fx.fast; family=claude est=20000; access-cap:fast' } }
    await ingest(payload([capped]), deps(store))
    expect([store.sum('A#', 'cap_n'), store.sum('A#', 'cap_a'), store.sum('A#', 'cap_b'), store.sum('A#', 'cap_r')]).toEqual([1, 14_937_500, 59_750_000, 44_812_500])
    expect(store.sum('A#', 'n_st')).toBe(0) // not a routing saving
    const [rec] = store.records()
    expect(rec).toMatchObject({ tierLimit: { to: 'fx.fast', maxTier: 'fast' }, decision: { reasonParsed: { code: 'session-start', accessCap: 'fast', family: 'claude', est: 20000 } } })
  })

  it('assessor threshold comes from the resolved configuration document', async () => {
    const store = new FakeStore()
    await ingest(payload(as(alice, [F3[0]!])), deps(store, { policies: mapPolicies(fxPolicies, 0.7) }))
    expect(store.records()[0]).toMatchObject({ assessor: { id: 'assessor/fx', threshold: 0.7 } })
  })

  it('unattributed lines roll up under `none` and never touch a budget total', async () => {
    const store = new FakeStore()
    await ingest(payload([...F1, ...as({ kind: 'user', id: 'has#hash' }, F2)]), deps(store))
    expect(store.sum('U#none#', 'req')).toBe(3)
    expect([...store.counters.keys()].some((key) => key.startsWith('B#'))).toBe(false)
  })

  it('counts lines whose policy cannot be resolved', async () => {
    const store = new FakeStore()
    const r = await ingest(payload(as(alice, F4)), deps(store, { policies: mapPolicies({}) }))
    expect(r.policyUnknown).toBe(3)
    expect(store.sum('A#', 'ex_policy-unknown')).toBe(3)
    expect(store.sum('A#', 'spend')).toBe(109_450_000) // spend is still counted
  })
})

describe('payload parsing', () => {
  it('decodes the subscription event and keeps only request and config lines', () => {
    const p = payload([...F1, { _aws: { CloudWatchMetrics: [] }, Requests: 1 }, 'not json', { kind: 'boot' }, { ...F2[0]!, reqId: 'bad id!' }])
    const decoded = decodePayload(awslogsEvent(p))
    const parsed = parseEvents(decoded)
    expect(parsed.requests.map((l) => l.reqId)).toEqual(['f1'])
    expect(parsed.skipped).toEqual({ 'kind:none': 1, json: 1, 'kind:boot': 1, 'invalid:reqId': 1 })
    expect(parseEvents({ ...decoded, messageType: 'CONTROL_MESSAGE' }).requests).toEqual([])
  })

  it('an unknown schemaVersion fails the event (DLQ, replay after an upgrade)', () => {
    expect(() => parseEvents(payload([{ ...F1[0]!, schemaVersion: 2 }]))).toThrow(UnsupportedSchemaError)
    expect(parseEvents(payload([{ ...F1[0]!, schemaVersion: 1 }])).requests.length).toBe(1)
  })

  it('rejects malformed fields rather than storing them', () => {
    const bad = [
      { ...F1[0]!, reqId: 'u1', usage: { ...F1[0]!.usage!, promptTokens: -1 } },
      { ...F1[0]!, reqId: 'u2', costUsd: { total: 'x' } },
      { ...F1[0]!, reqId: 'u3', ts: 'yesterday' },
      { ...F1[0]!, reqId: 'u4', principal: { kind: 'admin' } },
    ]
    expect(parseEvents(payload(bad)).skipped).toEqual({ 'invalid:usage': 1, 'invalid:costUsd': 1, 'invalid:ts': 1, 'invalid:principal': 1 })
  })

  it('principal keys: ids only, anything the key layout cannot carry is unattributed', () => {
    expect(principalKey(alice)).toBe('user:a1b2c3d4-0000-4000-8000-0000000alice')
    expect(principalKey(bob)).toBe('client:svcclient7')
    expect(principalKey({ kind: 'none', reason: 'identity-missing' })).toBe('none')
    expect(principalKey({ kind: 'user', id: 'a#b' })).toBe('none')
    expect(principalKey(undefined)).toBe('none')
  })
})
