// Effective configuration (0d-effective-config.md §4): document ?? baked per section, 'unknown' (never 'off')
// when baked.json is unreadable, the v#0#<sha8> seed, complete drafts, reported vs configured.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { validatePolicy } from '@auto-router/core/policy'
import { bakedConfigDocument } from '@auto-router/router/settings'
import { reportedConfigs } from './effective.ts'
import { BAKED, baseDocument, call, ev, LUNA, manifest, MEMBER, policy, setup , keysLoaded } from './test-fixtures.ts'

const activate = (s: ReturnType<typeof setup>, document: unknown, baseVersion = BAKED) =>
  call(s.handler, ev('POST', '/api/admin/config/activate', { body: { document, comment: 'c', baseVersion } }))

describe('effective settings', () => {
  it('no active document: every section comes from baked.json, with its version (the deployed c1 case)', async () => {
    const s = setup()
    const p = (await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body
    expect(p.deployment).toMatchObject({ identityMode: 'observe', mode: 'observe' })
    expect(p.deployment.effective.identityMode).toEqual({ value: 'observe', source: 'baked', version: BAKED })
    expect(p.deployment.effective.assessorModel).toEqual({ value: LUNA, source: 'baked', version: BAKED })
    expect(p.tierLimit).toEqual({ maxTier: 'standard' }) // access from baked
    const st = (await call(s.handler, ev('GET', '/api/me/setup', { as: MEMBER }))).body
    expect(st).toMatchObject({ identityMode: 'observe', mode: 'observe', effective: { routerMode: { source: 'baked' } } })
    expect(st.pools.length).toBeGreaterThan(0)
    const cfg = (await call(s.handler, ev('GET', '/api/admin/config'))).body
    expect(cfg.active).toMatchObject({ version: BAKED, n: 0, author: 'cdk' })
    expect(cfg.effective).toMatchObject({ sources: { policy: 'baked', identity: 'baked', assessor: 'baked', access: 'baked' }, bakedVersion: BAKED })
    expect(cfg.effective.document).toEqual(baseDocument()) // a new draft starts from this complete document
    expect(cfg.delivery).toEqual({ state: 'delivered' })
  })

  it('baked.json unreadable or missing, no document: unknown, never off', async () => {
    for (const breakIt of [(s: ReturnType<typeof setup>) => { s.objects.failGet = (k) => k === 'config/baked.json' }, (s: ReturnType<typeof setup>) => { s.objects.objects.delete('config/baked.json') },
      (s: ReturnType<typeof setup>) => { s.objects.objects.set('config/baked.json', '{"not":"a document"}') }]) {
      const s = setup()
      breakIt(s)
      const p = (await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body
      expect(p.deployment).toMatchObject({ identityMode: 'unknown', mode: 'unknown' })
      expect(p.deployment.effective.identityMode).toEqual({ source: 'unknown' })
      expect(JSON.stringify(p)).not.toMatch(/"identityMode":"off"/)
      const st = (await call(s.handler, ev('GET', '/api/me/setup', { as: MEMBER }))).body
      expect(st).toMatchObject({ identityMode: 'unknown', mode: 'unknown', pools: [] })
      expect(await call(s.handler, ev('GET', '/api/admin/config'))).toMatchObject({ status: 503, body: { error: { code: 'config-unavailable' } } })
      // Nothing to compare against: validate and activate refuse too.
      expect((await call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document: baseDocument() } }))).status).toBe(503)
      expect((await activate(s, baseDocument())).status).toBe(503)
    }
  })

  it('a document section wins over baked; a missing section falls back to baked (hand-written documents)', async () => {
    const s = setup()
    keysLoaded(s)
    const { assessor: _, ...noAssessor } = { ...baseDocument(), identity: { mode: 'require' as const } }
    expect((await activate(s, noAssessor)).status).toBe(201)
    const eff = (await call(s.handler, ev('GET', '/api/admin/config'))).body.effective
    expect(eff.sources).toEqual({ policy: 'document', identity: 'document', assessor: 'baked', access: 'document' })
    expect(eff.identityMode).toEqual({ value: 'require', source: 'document', version: '1-20261108T120000Z' })
    expect(eff.assessorMode).toEqual({ value: 'observe', source: 'baked', version: BAKED })
    expect(eff.document.assessor).toEqual(baseDocument().assessor)
    // Unreadable baked: the document's sections stay known, the missing one is unknown.
    s.objects.failGet = () => true
    const s2 = (await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body.deployment.effective
    expect(s2).toMatchObject({ identityMode: { value: 'require', source: 'document' }, assessorMode: { source: 'unknown' } })
  })

  it('seeds CONFIG v#0#<sha8> once per baked version (immutable), readable as a version; ETag caches the read', async () => {
    const s = setup()
    await call(s.handler, ev('GET', '/api/admin/config'))
    expect([...s.console.baked.keys()]).toEqual(['0123abcd'])
    const first = s.console.baked.get('0123abcd')
    await call(s.handler, ev('GET', '/api/admin/config'))
    expect(s.console.baked.get('0123abcd')).toEqual(first)
    expect((await call(s.handler, ev('GET', `/api/admin/config/versions/${BAKED}`))).body).toMatchObject({ version: BAKED, n: 0, document: baseDocument() })
    // A new deploy-time document: a new seed; the old one stays for old records.
    s.objects.objects.set('config/baked.json', JSON.stringify({ ...baseDocument(), version: '0-baked.89abcdef', identity: { mode: 'off' } }))
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body.deployment.identityMode).toBe('off') // the real baked value
    expect([...s.console.baked.keys()].sort()).toEqual(['0123abcd', '89abcdef'])
    expect((await call(s.handler, ev('GET', '/api/admin/config/versions/0-baked.ffffffff'))).status).toBe(404)
    // Roll back to the baked document by its version: a new console version with the baked content.
    const rb = await call(s.handler, ev('POST', '/api/admin/config/activate', { body: { document: baseDocument(), comment: 'restore', baseVersion: '0-baked.89abcdef', rollbackOf: BAKED } }))
    expect(rb).toMatchObject({ status: 201, body: { version: { n: 1, rollbackOf: BAKED } } })
  })

  it('a legacy ACTIVE "0-baked" pointer: the baked document is in force and either base version activates', async () => {
    const s = setup()
    s.console.active = { n: 0, version: '0-baked', delivered: true }
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.active.version).toBe(BAKED)
    const r = await call(s.handler, ev('POST', '/api/admin/config/activate', { body: { document: { ...baseDocument(), identity: { mode: 'off' } }, comment: 'c', baseVersion: '0-baked', confirmDisruptive: true } }))
    expect(r.status).toBe(201)
    expect(s.console.active?.version).toMatch(/^1-/)
  })

  it('ACTIVE naming a missing console version is 503 config-unavailable, not a silent fall back to baked (0d)', async () => {
    const s = setup()
    s.console.active = { n: 4, version: '4-20261108T000000Z', delivered: true }
    for (const path of ['/api/admin/config', '/api/me/profile']) expect((await call(s.handler, ev('GET', path))).body.error.code).toBe('config-unavailable')
  })
  it('a baked.json the router itself would reject counts as unreadable (router validateConfigDocument)', async () => {
    const s = setup()
    s.objects.objects.set('config/baked.json', JSON.stringify({ ...baseDocument(), policy: { mode: 'sideways' } }))
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body.deployment.identityMode).toBe('unknown')
    expect(s.logs.some((l) => l.kind === 'console-api-baked-invalid')).toBe(true)
    s.objects.objects.set('config/baked.json', JSON.stringify({ ...baseDocument(), assessor: { ...baseDocument().assessor, pack: 'v9' } }))
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body.deployment.identityMode).toBe('unknown')
  })
  it('redeliver with only the baked configuration in force writes nothing to config/active.json', async () => {
    const s = setup()
    expect((await call(s.handler, ev('POST', '/api/admin/config/redeliver'))).status).toBe(200)
    expect(s.objects.puts).not.toContain('config/active.json')
  })
})

describe('the real baked artifact (router bakedConfigDocument, as RouterStack stages it)', () => {
  it('is read, seeded at v#0#<sha8>, its runtime seq dropped, and a draft started from it activates', async () => {
    const s = setup()
    const baked = bakedConfigDocument({ policy: validatePolicy(policy), env: { ROUTER_IDENTITY_MODE: 'observe', ROUTER_ASSESSOR_MODE: 'observe' },
      packs: manifest.packs.map((p) => ({ name: p.name, packVersion: p.packVersion, autoCapable: p.autoCapable })) }, (t) => createHash('sha256').update(t).digest('hex'))
    expect(baked.version).toMatch(/^0-baked\.[0-9a-f]{8}$/)
    s.objects.objects.set('config/baked.json', JSON.stringify(baked))
    const cfg = (await call(s.handler, ev('GET', '/api/admin/config'))).body
    expect(cfg.effective).toMatchObject({ bakedVersion: baked.version, identityMode: { value: 'observe', source: 'baked' }, assessorMode: { value: 'observe', source: 'baked' } })
    expect(cfg.effective.document).not.toHaveProperty('seq')
    expect([...s.console.baked.keys()]).toEqual([baked.version.slice('0-baked.'.length)])
    keysLoaded(s)
    const r = await call(s.handler, ev('POST', '/api/admin/config/activate', { body: { document: { ...cfg.effective.document, identity: { mode: 'require' } }, comment: 'from effective', baseVersion: cfg.active.version } }))
    expect(r).toMatchObject({ status: 201, body: { version: { n: 1, changed: ['identity'] } } })
  })
})

describe('reported vs configured (0d §4.4)', () => {
  it('reported = the fresh state line per task (≤ 15 min); matches when every reported value equals the configured one', async () => {
    const s = setup()
    const eff = (r: Record<string, string>) => ({ identityMode: 'observe', assessorMode: 'observe', policyVersion: String(baseDocument().policy.version), mode: 'observe', ...r })
    keysLoaded(s, 'a', { configVersion: BAKED, effective: eff({}), sources: { policy: 'baked', identity: 'baked', assessor: 'baked', access: 'baked' }, ts: '2026-11-08T11:50:00.000Z' })
    keysLoaded(s, 'b', { configVersion: BAKED, effective: eff({ identityMode: 'off' }), ts: '2026-11-08T11:55:00.000Z' })
    keysLoaded(s, 'old', { effective: eff({}), ts: '2026-11-08T11:00:00.000Z' })
    // Config lines no longer drive `reported`.
    s.usage.reports.push({ ts: '2026-11-08T11:59:00.000Z', task: 'c', source: 'boot', outcome: 'active', effective: eff({}) })
    const r = (await call(s.handler, ev('GET', '/api/admin/config'))).body.reported
    expect(r.map((x: any) => [x.task, x.matches])).toEqual([['b', false], ['a', true]])
    expect(r[1]).toMatchObject({ at: '2026-11-08T11:50:00.000Z', configVersion: BAKED, sources: { identity: 'baked' } })
  })
  it('not comparable when the configured value is unknown', () => {
    const settings = { identityMode: { source: 'unknown' as const }, routerMode: { source: 'unknown' as const }, policyVersion: { source: 'unknown' as const },
      assessorMode: { source: 'unknown' as const }, assessorPack: { source: 'unknown' as const }, assessorModel: { source: 'unknown' as const } }
    const [one] = reportedConfigs([{ ts: '2026-11-08T11:00:00.000Z', task: 't', effective: { identityMode: 'observe' } }], settings, Date.parse('2026-11-08T12:00:00Z'))
    expect(one).not.toHaveProperty('matches')
  })
})
