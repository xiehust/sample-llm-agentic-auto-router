// Self routes, record projection, usage and savings reports, packs, gateway, health, audit.
import { describe, expect, it } from 'vitest'
import { call, ev, LUNA, MEMBER, MEMBER_SUB, OTHER_SUB, record, REQ_A, REQ_B, setup, SOL, v22 } from './test-fixtures.ts'

const me = `user:${MEMBER_SUB}`

describe('profile and setup', () => {
  it('profile: role from the MEMBER item, tier limit from the group default, deployment info', async () => {
    const s = setup()
    const r = await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))
    expect(r.body).toMatchObject({
      principal: me, username: 'member1', name: 'member1', email: 'bbbbbbbb@example.com', role: 'member', groups: ['member'], tierLimit: { maxTier: 'standard' },
      deployment: { prefix: 'llmar', region: 'ap-northeast-1', mode: 'observe', identityMode: 'observe', retentionDays: 90, rollupDays: 400, defaultBaseline: 'static' },
    })
  })
  it('setup: configureJson for llmar; pools filtered to the tier limit; missing values (names for admins only)', async () => {
    const s = setup()
    const r = await call(s.handler, ev('GET', '/api/me/setup', { as: MEMBER }))
    expect(r.body.configureJson).toEqual({
      schemaVersion: 1, region: 'ap-northeast-1', cognitoDomain: 'https://auth.example.com', clientId: 'cliclient', scope: 'llmar/invoke', redirectPorts: [53682, 53683],
      gatewayUrl: 'https://gw.example.com', identityHeader: 'x-api-key', refreshDays: 30, tokenEndpoint: 'https://auth.example.com/oauth2/token',
    })
    const responses = r.body.pools.find((p: any) => p.dialect === 'openai-responses')
    expect(responses.tiers.map((t: any) => t.tier)).toEqual(['fast', 'standard']) // maxTier standard: frontier hidden
    expect(r.body).not.toHaveProperty('missing')
    delete s.deps.env.cliClientId
    s.deps.env.identityHeader = null
    const m = await call(s.handler, ev('GET', '/api/me/setup', { as: MEMBER }))
    expect(m.body).not.toHaveProperty('configureJson')
    expect(m.body.missing).toEqual(['deployment'])
    expect((await call(s.handler, ev('GET', '/api/me/setup'))).body.missing).toEqual(['cliClientId'])
    s.deps.env.cliClientId = 'c'
    expect((await call(s.handler, ev('GET', '/api/me/setup'))).body.configureJson.identityHeader).toBeNull()
  })
  it('latest: the caller’s request in the last 10 minutes only', async () => {
    const s = setup()
    s.usage.records.push(record({ reqId: REQ_A, principal: me, ts: '2026-11-08T11:45:00.000Z' }), record({ reqId: REQ_B, principal: `user:${OTHER_SUB}`, ts: '2026-11-08T11:58:00.000Z' }))
    expect((await call(s.handler, ev('GET', '/api/me/latest', { as: MEMBER }))).body).toEqual({})
    s.usage.records.push(record({ reqId: '33333333-3333-4333-8333-333333333333', principal: me, ts: '2026-11-08T11:58:00.000Z' }))
    expect((await call(s.handler, ev('GET', '/api/me/latest', { as: MEMBER }))).body.record).toEqual({
      ts: '2026-11-08T11:58:00.000Z', reqId: '33333333-3333-4333-8333-333333333333', status: 200, dialect: 'openai-responses', requested: 'auto', servedModel: SOL,
    })
  })
})

describe('records', () => {
  it('summary and detail from a stored record (17 shape)', async () => {
    const s = setup()
    s.usage.records.push(record({ reqId: REQ_A, principal: me, miss: { reason: 'model_changed', expectedTokens: 900, readTokens: 0 }, failover: { from: 'a', to: 'b', status: 429 },
      costUsd: { input: 0.001, cacheRead: 0.0005, cacheWrite: 0.0005, output: 0.0005, total: 0.0025, tier: 'base' } }))
    const list = await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER }))
    expect(list.body.items[0]).toEqual({
      ts: '2026-11-08T11:59:00.000Z', reqId: REQ_A, kind: 'model', status: 200, session: '0123456789abcdef', lineage: 'aaaaaaaaaaaaaaaa', dialect: 'openai-responses',
      requested: 'auto', action: 'initialize', point: 'session-start', mode: 'observe', servedModel: SOL, tier: 'standard', wouldChoose: LUNA, promptTokens: 1050,
      outputTokens: 40, costUsd: 0.0025, hitRate: 900 / 1050, flags: { failover: true, miss: 'model_changed', assessor: 'fast' }, bar: { read: 900, write: 50, uncached: 100 },
    })
    const d = (await call(s.handler, ev('GET', `/api/me/records/${REQ_A}`, { as: MEMBER }))).body
    expect(d).toMatchObject({
      identity: 'verified', stream: true, configVersion: '0-20261108T000000Z', failoverDetail: { from: 'a', to: 'b', status: 429 },
      decision: { action: 'initialize', model: SOL, policyVersion: 'p1', wouldChoose: LUNA },
      cost: { total: 0.0025, tier: 'base' }, missDetail: { reason: 'model_changed', expectedTokens: 900, readTokens: 0 },
      assessorDetail: { mode: 'observe', status: 'ok', packVersion: v22.packVersion, proposedTier: 'fast', basis: ['explore-readonly'], costUsd: 0.0004, applied: false },
      timing: { decideMs: 2, overheadMs: 3, upstreamTtfbMs: 400, durationMs: 1200 },
    })
    expect(d).not.toHaveProperty('caller')
  })
  it('decision code and cap from core parseReason as ingest stores it (decision.reasonParsed)', async () => {
    const s = setup()
    s.usage.records.push(record({ reqId: REQ_A, principal: me, decision: { action: 'initialize', point: 'session-start', mode: 'auto', model: LUNA, reason: 'session-start: x; family=f est=1; access-cap:fast',
      policyVersion: 'p1', reasonParsed: { code: 'session-start', family: 'f', est: 1, accessCap: 'fast' } } }))
    const d = (await call(s.handler, ev('GET', `/api/me/records/${REQ_A}`, { as: MEMBER }))).body
    expect(d.decision.code).toBe('session-start')
    expect(d.reasonParsed).toEqual({ code: 'session-start', family: 'f', est: 1, accessCap: 'fast' })
    expect(d.flags.capped).toBe(true)
  })
  it('filters: status class, miss, assessor, wouldChooseDiffers, action; bad values 400', async () => {
    const s = setup()
    s.usage.records.push(
      record({ reqId: REQ_A, principal: me }),
      record({ reqId: REQ_B, principal: me, ts: '2026-11-08T11:50:00.000Z', status: 403, kind: 'rejected', reason: 'identity-blocked', decision: undefined, assessor: undefined, miss: true }),
    )
    const q = async (query: Record<string, string>) => (await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER, query }))).body.items.map((r: any) => r.reqId)
    expect(await q({ status: '4xx' })).toEqual([REQ_B])
    expect(await q({ miss: 'any' })).toEqual([REQ_B])
    expect(await q({ assessor: 'true' })).toEqual([REQ_A])
    expect(await q({ wouldChooseDiffers: 'true' })).toEqual([REQ_A])
    expect(await q({ action: 'initialize,switch' })).toEqual([REQ_A])
    const rej = (await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER, query: { status: '4xx' } }))).body.items[0]
    expect(rej).toMatchObject({ kind: 'rejected', errorCode: 'identity-blocked', flags: { miss: 'unknown' } })
    const bads: Array<Record<string, string>> = [{ status: '3xx' }, { assessor: 'yes' }, { miss: 'some' }, { from: 'yesterday' }, { session: 'x' }, { limit: '500' }]
    for (const bad of bads) {
      expect((await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER, query: bad }))).status).toBe(400)
    }
  })
  it('session detail: lineages, models, switches, misses, cost, hit rate, live', async () => {
    const s = setup()
    s.usage.records.push(
      record({ reqId: REQ_A, principal: me, ts: '2026-11-08T11:00:00.000Z' }),
      record({ reqId: REQ_B, principal: me, ts: '2026-11-08T11:55:00.000Z', lineage: 'bbbbbbbbbbbbbbbb', servedModel: LUNA, miss: true,
        decision: { action: 'switch', point: 'subagent-start', mode: 'auto', model: LUNA, reason: 'r', policyVersion: 'p1' } }),
    )
    const r = (await call(s.handler, ev('GET', '/api/me/sessions/0123456789abcdef', { as: MEMBER }))).body
    expect(r).toMatchObject({
      session: '0123456789abcdef', first: '2026-11-08T11:00:00.000Z', last: '2026-11-08T11:55:00.000Z', requests: 2, models: [SOL, LUNA], switches: 1, misses: 1,
      failovers: 0, costUsd: 0.005, live: true,
      lineages: [{ lineage: 'aaaaaaaaaaaaaaaa', kind: 'root', requests: 1 }, { lineage: 'bbbbbbbbbbbbbbbb', kind: 'subagent', requests: 1 }],
    })
    expect(r.items.map((i: any) => i.reqId)).toEqual([REQ_A, REQ_B])
  })
})

describe('usage and savings', () => {
  const rows = (s: ReturnType<typeof setup>) => {
    const common = { dialect: 'openai-responses', baseTier: 'standard' }
    s.usage.rollupItems.push(
      { ...common, day: '2026-11-07', principal: me, servedModel: LUNA, counters: { req: 2, err: 1, tUnc: 100, tRead: 900, tW5m: 50, tOut: 40, tPrompt: 1050, spend: 3_000_000,
        cIn: 1_000_000, cRead: 1_000_000, cWrite: 500_000, cOut: 500_000, n_st: 2, b_st: 10_000_000, r_st: 8_000_000, s_st: 1_000_000, x_st: 400_000, cnet: 200_000 } },
      { ...common, day: '2026-11-08', principal: me, servedModel: SOL, counters: { req: 1, tPrompt: 0, spend: 4_000_000, n_st: 1, b_st: 4_000_000, r_st: 0, s_st: 0, x_st: 0, unm: 1, bound: 50_000_000 } },
      { ...common, day: '2026-11-08', principal: `user:${OTHER_SUB}`, servedModel: SOL, counters: { req: 9, spend: 9_000_000 } },
    )
  }
  it('usage report: own rows by model, totals, daily series; catalog ref', async () => {
    const s = setup(); rows(s)
    const r = (await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { from: '2026-11-07', to: '2026-11-08' } }))).body
    expect(r.range).toEqual({ from: '2026-11-07', to: '2026-11-08' })
    expect(r.rows.map((x: any) => [x.key, x.requests, x.cost.total])).toEqual([[SOL, 1, 0.004], [LUNA, 2, 0.003]])
    expect(r.rows[1]).toMatchObject({ errors: 1, tokens: { uncached: 100, cacheRead: 900, cacheWrite: { '5m': 50 }, output: 40, reasoning: 0 }, hitRate: 900 / 1050,
      cost: { input: 0.001, cacheRead: 0.001, cacheWrite: 0.0005, output: 0.0005 } })
    expect(r.totals).toMatchObject({ key: 'total', requests: 3, cost: { total: 0.007 }, unmetered: { count: 1, upperBoundUsd: 0.05, partial: false } })
    expect(r.daily.map((d: any) => [d.day, d.series])).toEqual([['2026-11-07', LUNA], ['2026-11-08', SOL]])
    expect((await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { groupBy: 'tier' } }))).body.rows.map((x: any) => x.key).sort()).toEqual(['fast', 'standard'])
    expect((await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { status: '2xx' } }))).status).toBe(400)
    expect((await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { from: '2026-01-01' } }))).status).toBe(400)
  })
  it('admin usage by caller with caller refs', async () => {
    const s = setup(); rows(s)
    const r = (await call(s.handler, ev('GET', '/api/admin/usage', { query: { from: '2026-11-07', to: '2026-11-08', groupBy: 'caller' } }))).body
    expect(r.rows.map((x: any) => [x.key, x.caller?.name])).toEqual([[`user:${OTHER_SUB}`, 'member2'], [me, 'member1']])
  })
  it('savings: A = B − R + S and N = R − S − X per baseline; tier matrix; prompt-cache saving', async () => {
    const s = setup(); rows(s)
    const r = (await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { view: 'savings', from: '2026-11-07', to: '2026-11-08' } }))).body
    expect(r.baseline).toBe('static')
    expect(r.kpis).toEqual({ requests: 3, A: 0.007, B: 0.014, R: 0.008, S: 0.001, X: 0.0004, N: 0.008 - 0.001 - 0.0004, rate: (0.008 - 0.001 - 0.0004) / 0.014 })
    expect(r.matrix).toEqual([{ from: 'standard', to: 'fast', n: 2, R: 0.008 }, { from: 'standard', to: 'standard', n: 1, R: 0 }])
    expect(r.promptCacheSaving).toBe(0.0002)
    expect(r.mode).toBe('observe')
    expect((await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { view: 'savings', baseline: 'cheapest' } }))).status).toBe(400)
  })
})

describe('packs, gateway, health, audit', () => {
  it('a member reads an archived pack by version (either encoding); unknown and malformed are 404', async () => {
    const s = setup()
    const r = await call(s.handler, ev('GET', `/api/packs/${encodeURIComponent(v22.packVersion)}`, { as: MEMBER }))
    expect(r.status).toBe(200)
    expect(r.body.rules.map((x: any) => x.id)).toEqual(['explore-readonly', 'mechanical-edit', 'bounded-change', 'deep-investigation'])
    expect(r.headers['cache-control']).toMatch(/immutable/)
    expect((await call(s.handler, ev('GET', `/api/packs/${v22.packVersion}`, { as: MEMBER }))).status).toBe(200)
    expect((await call(s.handler, ev('GET', '/api/packs/assessor%2Fv2.2%2B000000000000', { as: MEMBER }))).status).toBe(404)
    // '/' and '+' encoded (any case), raw '+', and a double-encoded value all reach the same archive key.
    const [id, hash] = v22.packVersion.split('+') as [string, string]
    for (const p of [`${id.replace('/', '%2f')}%2b${hash}`, `${id.replace('/', '%2F')}+${hash}`, encodeURIComponent(encodeURIComponent(v22.packVersion))]) {
      const res = await call(s.handler, ev('GET', `/api/packs/${p}`, { as: MEMBER }))
      expect(res.status, p).toBe(200)
      expect(res.body.packVersion).toBe(v22.packVersion)
    }
    expect(s.objects.objects.has(`packs/${v22.packVersion}.json`)).toBe(true)
    expect((await call(s.handler, ev('GET', '/api/packs/..%2F..%2Fconfig%2Factive', { as: MEMBER }))).status).toBe(404)
  })
  it('assessor packs: console manifest until the router reports, then the router’s packs and drift', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/admin/assessor/packs'))).body).toMatchObject({ schemaVersion: 1, default: 'v2.2', source: 'console', warnings: [] })
    s.usage.reports.push({ ts: 'x', task: 't', configVersion: '1', status: 'applied', packs: [{ name: 'v2.2', packVersion: v22.packVersion }], drift: { pack: 'v2.2' } })
    const after = (await call(s.handler, ev('GET', '/api/admin/assessor/packs'))).body
    expect(after).toMatchObject({ source: 'router', drift: { pack: 'v2.2' } })
    expect(after.packs.map((p: any) => p.name)).toEqual(['v2.2'])
  })
  it('gateway and health pass through; errors are 502 with their codes', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/admin/gateway'))).body).toMatchObject({ id: 'gw-1', forwardedHeaders: ['x-api-key'] })
    expect((await call(s.handler, ev('GET', '/api/admin/health', { query: { range: '6h' } }))).body).toMatchObject({ range: '6h', tasks: { running: 2 } })
    expect((await call(s.handler, ev('GET', '/api/admin/health', { query: { range: '2h' } }))).status).toBe(400)
    s.deps.gateway = { describe: async () => { throw new Error('denied') } }
    expect((await call(s.handler, ev('GET', '/api/admin/gateway'))).body.error.code).toBe('gateway-unavailable')
    s.deps.metrics = { health: async () => { throw new Error('denied') } }
    expect((await call(s.handler, ev('GET', '/api/admin/health'))).body.error.code).toBe('metrics-unavailable')
  })
  it('audit: filter by action list and actor; one log line per request with ids and codes only', async () => {
    const s = setup()
    await call(s.handler, ev('PATCH', '/api/admin/settings', { body: { defaultBaseline: 'standard' } }))
    expect((await call(s.handler, ev('GET', '/api/admin/audit', { query: { action: 'settings.change,member.role' } }))).body.items).toHaveLength(1)
    expect((await call(s.handler, ev('GET', '/api/admin/audit', { query: { actor: 'robert' } }))).status).toBe(400)
    await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))
    expect(s.logs.at(-1)).toEqual({ kind: 'console-api', requestId: 'req-1', method: 'GET', route: 'me.profile', status: 200, ms: 0, principal: me })
  })
})
