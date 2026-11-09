// Config state, drafts, validate, activate with optimistic lock, delivery, roll back, redeliver (design §2.1).
import type { SwapEffect } from '@auto-router/console-contract'
import { describe, expect, it } from 'vitest'
import { ADMIN, BAKED, baseDocument, call, ev, LUNA, setup, v22, type Setup , keysLoaded } from './test-fixtures.ts'

const BASE = BAKED
const activate = (s: Setup, body: Record<string, unknown>) => call(s.handler, ev('POST', '/api/admin/config/activate', { body }))
const validate = (s: Setup, document: unknown) => call(s.handler, ev('POST', '/api/admin/config/validate', { body: { document } }))

describe('config state', () => {
  it('GET config: active version, router state from config reports, universe, catalog, delivered', async () => {
    const s = setup()
    const pending = await call(s.handler, ev('GET', '/api/admin/config'))
    expect(pending.headers.etag).toBe(`"${BASE}"`)
    expect(pending.body).toMatchObject({ active: { n: 0, version: BASE, document: { schemaVersion: 1 } }, router: { status: 'pending' }, delivery: { state: 'delivered' } })
    expect(pending.body.universe).toContain(LUNA)
    expect(pending.body.catalog.models.find((m: any) => m.modelId === LUNA)).toMatchObject({ tier: 'fast' })
    s.usage.reports.push({ ts: '2026-11-08T11:00:00.000Z', task: 't1', configVersion: BASE, status: 'applied' })
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.router).toMatchObject({ status: 'active', reportedVersion: BASE, since: '2026-11-08T11:00:00.000Z', identityKeysLoaded: false, identityKeys: { reason: 'no-fresh-task' } })
    s.usage.reports.push({ ts: '2026-11-08T11:30:00.000Z', task: 't1', configVersion: BASE, status: 'rejected', issues: ['policy-invalid'] })
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.router).toMatchObject({ status: 'rejected', issues: ['policy-invalid'] })
  })

  it('drafts: save (may be invalid), shown on GET, discard; both audited', async () => {
    const s = setup()
    const saved = await call(s.handler, ev('PUT', '/api/admin/config', { body: { document: { anything: true }, baseVersion: BASE } }))
    expect(saved.body.draft).toMatchObject({ author: `user:${ADMIN.sub}`, baseVersion: BASE })
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.draft.document).toEqual({ anything: true })
    expect((await call(s.handler, ev('PUT', '/api/admin/config', { body: { document: {}, baseVersion: 'x' } }))).status).toBe(400)
    expect((await call(s.handler, ev('DELETE', '/api/admin/config'))).body).not.toHaveProperty('draft')
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body).not.toHaveProperty('draft')
    expect(s.console.audit.map((a) => a.action)).toEqual(['config.draft', 'config.discard'])
  })
})

describe('validate', () => {
  it('reports JSON-pointer paths, categories and specific rules; the changed sections', async () => {
    const s = setup()
    expect((await validate(s, { ...baseDocument(), identity: { mode: 'require' } })).body).toMatchObject({ ok: true, issues: [], effects: [{ effect: 'identity-strengthened', severity: 'info' }], changed: ['identity'] })
    const doc = baseDocument()
    const bad = await validate(s, {
      ...doc, schemaVersion: 2, assessor: { ...doc.assessor, threshold: 3, packVersion: 'assessor/v2.2+000000000000' },
      identity: { mode: 'strict' }, access: { groups: { member: { maxTier: 'huge' }, guest: {} } },
    })
    expect(bad.body.ok).toBe(false)
    expect(bad.body.issues.map((i: any) => `${i.path} ${i.code} ${i.rule}`)).toEqual([
      '/schemaVersion schema schema-version', '/assessor/packVersion assessor pack-version-drift', '/assessor/threshold assessor threshold-invalid',
      '/identity identity identity-invalid', '/access/groups/member/maxTier access cap-invalid', '/access/groups/guest access access-group-unknown',
    ])
  })
  it('universe, catalog and cap pins', async () => {
    const s = setup()
    s.deps.env.modelUniverse = s.deps.env.modelUniverse.filter((m) => m !== 'global.openai.gpt-6-astra')
    const r = await validate(s, { ...baseDocument(), access: { groups: { member: { allowPins: ['nope'] } } } })
    expect(r.body.issues.map((i: any) => `${i.code}:${i.rule}`)).toEqual(['universe:model-outside-universe', 'access:cap-pin-unknown'])
    const p = await validate(s, { ...baseDocument(), policy: { mode: 'sideways' } })
    expect(p.body.issues[0]).toMatchObject({ path: '/policy', code: 'schema', rule: 'policy-invalid' })
  })
  it('assessor and identity may be absent; a bare off block is valid; a stale off block is an error here', async () => {
    const s = setup()
    const { assessor: _, identity: __, ...minimal } = baseDocument()
    expect((await validate(s, minimal)).body.ok).toBe(true)
    expect((await validate(s, { ...baseDocument(), assessor: { mode: 'off' } })).body.ok).toBe(true)
    const stale = await validate(s, { ...baseDocument(), assessor: { ...baseDocument().assessor, mode: 'off', pack: 'v0' } })
    expect(stale.body.issues.map((i: any) => i.rule)).toEqual(['pack-unknown'])
  })
  it('validates against the packs the router reports; a pack missing from the archive is a warning', async () => {
    const s = setup()
    s.usage.reports.push({ ts: 'x', task: 't', configVersion: BASE, status: 'applied', packs: [{ name: 'v2.2', packVersion: v22.packVersion }, { name: 'v9', packVersion: 'assessor/v9+0123456789ab' }] })
    const r = await validate(s, baseDocument())
    expect(r.body.ok).toBe(true)
    expect(r.body.warnings.map((w: any) => w.rule)).toEqual(['pack-archive-missing', 'image-console-mismatch'])
    const v21 = await validate(s, { ...baseDocument(), assessor: { mode: 'observe', pack: 'v2.1', model: LUNA, threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' } })
    expect(v21.body.issues.map((i: any) => i.rule)).toEqual(['pack-unknown'])
  })
  it('rejects oversized and malformed bodies', async () => {
    const s = setup()
    expect((await call(s.handler, ev('POST', '/api/admin/config/validate', { body: '{' }))).body.error.code).toBe('bad-request')
    expect((await call(s.handler, ev('POST', '/api/admin/config/validate', { body: 'x'.repeat(300_000) }))).status).toBe(413)
    expect((await call(s.handler, ev('POST', '/api/admin/config/validate', { body: [] }))).status).toBe(400)
  })
})

describe('activate', () => {
  it('identity weakening is disruptive (0d): require → off needs confirmDisruptive; the audit shows the change', async () => {
    const s = setup()
    keysLoaded(s)
    expect((await activate(s, { document: { ...baseDocument(), identity: { mode: 'require' } }, comment: 'up', baseVersion: BASE })).status).toBe(201)
    const off = { ...baseDocument(), identity: { mode: 'off' } }
    const v = (await validate(s, off)).body
    expect(v.effects).toEqual([expect.objectContaining({ effect: 'identity-weakened', severity: 'disruptive' })])
    expect((await activate(s, { document: off, comment: 'down', baseVersion: '1-20261108T120000Z' })).body.error.code).toBe('disruptive-unconfirmed')
    expect((await activate(s, { document: off, comment: 'down', baseVersion: '1-20261108T120000Z', confirmDisruptive: true })).status).toBe(201)
    expect(s.console.audit.at(-1)).toMatchObject({ action: 'config.activate', before: { identity: 'require' }, after: { identity: 'off', effects: ['identity-weakened'] } })
    // observe → off is a weakening too; a section left out of the next document compares against the baked one.
    const s2 = setup()
    expect((await validate(s2, { ...baseDocument(), identity: { mode: 'off' } })).body.effects.map((e: any) => e.effect)).toEqual(['identity-weakened'])
    const { identity: _, ...noIdentity } = baseDocument()
    expect((await validate(s2, noIdentity)).body.effects).toEqual([])
  })
  it('assessor mode: leaving auto warns, other changes inform', async () => {
    const s = setup()
    const auto = { ...baseDocument(), assessor: { ...baseDocument().assessor, mode: 'auto', autoRules: 'all' } }
    expect((await validate(s, auto)).body.effects).toEqual([expect.objectContaining({ effect: 'assessor-mode', severity: 'info' })])
    expect((await activate(s, { document: auto, comment: 'auto', baseVersion: BASE })).status).toBe(201)
    expect((await validate(s, baseDocument())).body.effects).toEqual([expect.objectContaining({ effect: 'assessor-mode', severity: 'warn' })])
  })

  it('identity require needs every running task to report its signing keys (0d §7)', async () => {
    const s = setup()
    const document = { ...baseDocument(), identity: { mode: 'require' } }
    const refuse = async (reason: string) => {
      const r = await activate(s, { document, comment: 'c', baseVersion: BASE })
      expect(r).toMatchObject({ status: 422, body: { error: { code: 'identity-keys-not-loaded', reason, issues: [{ path: '/identity/mode', code: 'identity', rule: 'identity-keys-not-loaded' }] } } })
      return r
    }
    await refuse('no-fresh-task')
    // A stale line (> 15 min) does not count.
    keysLoaded(s, 't1', { ts: '2026-11-08T11:40:00.000Z' })
    await refuse('no-fresh-task')
    keysLoaded(s, 't1')
    ;(s.deps.tasks as any).running = 2
    expect((await refuse('partial')).body.error.message).toMatch(/1 of 2 running tasks/)
    ;(s.deps.tasks as any).running = undefined
    await refuse('partial') // running count unknown is never allowed
    ;(s.deps.tasks as any).running = 2
    keysLoaded(s, 't2', { identityKeys: { configured: false, loaded: false } })
    await refuse('not-configured')
    keysLoaded(s, 't2', { identityKeys: undefined }) // absent (malformed in the line): not loaded
    await refuse('task-without-keys')
    keysLoaded(s, 't2', { identityKeys: { configured: true, loaded: false } })
    expect((await refuse('task-without-keys')).body.error.message).toMatch(/t2/)
    const st = (await call(s.handler, ev('GET', '/api/admin/config'))).body.router
    expect(st).toMatchObject({ identityKeysLoaded: false, identityKeys: { loaded: false, reason: 'task-without-keys', fresh: 2, running: 2, withKeys: 1, task: 't2' } })
    keysLoaded(s, 't2')
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.router).toMatchObject({ identityKeysLoaded: true, identityKeys: { loaded: true, fresh: 2, running: 2, withKeys: 2 } })
    expect((await activate(s, { document, comment: 'c', baseVersion: BASE })).status).toBe(201)
  })

  it('baseVersion required (400) and current (409); invalid 422; then a new version delivered, audited, draft cleared', async () => {
    const s = setup()
    keysLoaded(s)
    const document = { ...baseDocument(), identity: { mode: 'require' } }
    expect((await activate(s, { document, comment: 'c' })).status).toBe(400)
    expect((await activate(s, { document, comment: 'c', baseVersion: '7-20261108T000000Z' })).body.error.code).toBe('config-version-moved')
    expect((await activate(s, { document, baseVersion: BASE })).status).toBe(400) // comment required
    const invalid = await activate(s, { document: { ...document, identity: { mode: 'x' } }, comment: 'c', baseVersion: BASE })
    expect(invalid).toMatchObject({ status: 422, body: { error: { code: 'validation-failed', issues: [{ path: '/identity' }] } } })
    await call(s.handler, ev('PUT', '/api/admin/config', { body: { document, baseVersion: BASE } }))

    const r = await activate(s, { document: { ...document, version: 'ignored' }, comment: 'tighten identity', baseVersion: BASE })
    expect(r.status).toBe(201)
    expect(r.body.version).toEqual({ version: '1-20261108T120000Z', n: 1, author: `user:${ADMIN.sub}`, createdAt: '2026-11-08T12:00:00.000Z', comment: 'tighten identity', changed: ['identity'] })
    expect(s.objects.puts).toEqual(['config/versions/1.json', 'config/active.json'])
    expect(JSON.parse(s.objects.objects.get('config/active.json')!)).toMatchObject({ version: '1-20261108T120000Z', identity: { mode: 'require' } })
    expect(s.console.active).toEqual({ n: 1, version: '1-20261108T120000Z', delivered: true })
    expect(s.console.draft).toBeUndefined()
    expect(s.console.audit.at(-1)).toMatchObject({ action: 'config.activate', target: 'config:1-20261108T120000Z', result: 'succeeded' })
    expect((await activate(s, { document, comment: 'again', baseVersion: BASE })).status).toBe(409)
  })
  it('only universe issues → outside-universe', async () => {
    const s = setup()
    s.deps.env.modelUniverse = s.deps.env.modelUniverse.filter((m) => m !== 'global.openai.gpt-6-astra')
    expect((await activate(s, { document: baseDocument(), comment: 'c', baseVersion: BASE })).body.error.code).toBe('outside-universe')
  })
  it('roll back: the old document with rollbackOf, re-validated against the running image', async () => {
    const s = setup()
    keysLoaded(s)
    await activate(s, { document: { ...baseDocument(), identity: { mode: 'require' } }, comment: 'c1', baseVersion: BASE })
    s.tick(60_000)
    const old = (await call(s.handler, ev('GET', `/api/admin/config/versions/${BASE}`))).body
    const r = await activate(s, { document: old.document, comment: 'undo', baseVersion: '1-20261108T120000Z', rollbackOf: BASE, confirmDisruptive: true })
    expect(r.body.version).toMatchObject({ n: 2, rollbackOf: BASE, changed: ['identity'] })
    expect(s.console.audit.at(-1)?.action).toBe('config.rollback')
    expect((await activate(s, { document: old.document, comment: 'x', baseVersion: r.body.version.version, rollbackOf: '9-20261108T000000Z' })).status).toBe(404)
  })
  it('disruptive effects need confirmDisruptive (policySwapEffects injected)', async () => {
    const s = setup()
    const effect: SwapEffect = { effect: 'alias-removed', severity: 'disruptive', detail: 'alias auto:fast removed' }
    s.deps.swapEffects = () => [effect]
    expect((await validate(s, baseDocument())).body.effects).toEqual([effect])
    expect((await activate(s, { document: baseDocument(), comment: 'c', baseVersion: BASE })).body.error.code).toBe('disruptive-unconfirmed')
    expect((await activate(s, { document: baseDocument(), comment: 'c', baseVersion: BASE, confirmDisruptive: true })).status).toBe(201)
  })
  it('core policySwapEffects by default: removing a pinnable model is disruptive and needs confirmDisruptive', async () => {
    const s = setup()
    const doc = baseDocument()
    const pol = structuredClone(doc.policy) as any
    pol.pools['openai-chat'].models = pol.pools['openai-chat'].models.filter((m: any) => m.model !== 'global.openai.gpt-6-astra')
    pol.pools['openai-responses'].models = pol.pools['openai-responses'].models.filter((m: any) => m.model !== 'global.openai.gpt-6-astra')
    const next = { ...doc, policy: pol }
    const v = (await validate(s, next)).body
    expect(v.effects.map((e: any) => `${e.effect}:${e.severity}`)).toEqual(expect.arrayContaining(['model-removed:warn', 'pin-removed:disruptive']))
    expect((await activate(s, { document: next, comment: 'c', baseVersion: BASE })).body.error.code).toBe('disruptive-unconfirmed')
    expect((await activate(s, { document: next, comment: 'c', baseVersion: BASE, confirmDisruptive: true })).status).toBe(201)
    expect((await validate(s, baseDocument())).body.effects.map((e: any) => e.effect)).toContain('model-added')
  })
  it('an active policy that no longer validates gives a disruptive cannot-compare effect (0d)', async () => {
    const s = setup()
    expect((await activate(s, { document: baseDocument(), comment: 'c1', baseVersion: BASE })).status).toBe(201)
    s.console.versions.get(1)!.document.policy = { mode: 'sideways' } // e.g. written by an older console
    const v = (await validate(s, baseDocument())).body
    expect(v.effects).toEqual([expect.objectContaining({ effect: 'cannot-compare', severity: 'disruptive' })])
    expect((await activate(s, { document: baseDocument(), comment: 'c', baseVersion: '1-20261108T120000Z' })).body.error.code).toBe('disruptive-unconfirmed')
  })
  it('a failed delivery: 502, active but undelivered; redeliver fixes it', async () => {
    const s = setup()
    s.objects.failPut = (k) => k === 'config/active.json'
    const r = await activate(s, { document: { ...baseDocument(), identity: { mode: 'off' } }, comment: 'c', baseVersion: BASE, confirmDisruptive: true })
    expect(r).toMatchObject({ status: 502, body: { error: { code: 'delivery-failed' } } })
    expect(s.console.active).toMatchObject({ n: 1, delivered: false })
    expect((await call(s.handler, ev('GET', '/api/admin/config'))).body.delivery).toEqual({ state: 'notDelivered', errorCode: 'delivery-failed' })
    expect(s.console.audit.at(-1)).toMatchObject({ result: 'failed', errorCode: 'delivery-failed' })
    s.objects.failPut = undefined
    expect(await call(s.handler, ev('POST', '/api/admin/config/redeliver'))).toMatchObject({ status: 200, body: { active: { n: 1 }, delivery: { state: 'delivered' } } })
    expect(s.console.audit.at(-1)?.action).toBe('config.redeliver')
  })
  it('versions: newest first by number, paged; fetched by version string or number', async () => {
    const s = setup()
    await activate(s, { document: { ...baseDocument(), identity: { mode: 'off' } }, comment: 'a', baseVersion: BASE, confirmDisruptive: true })
    s.tick(1000)
    await activate(s, { document: baseDocument(), comment: 'b', baseVersion: '1-20261108T120000Z' })
    const list = await call(s.handler, ev('GET', '/api/admin/config/versions'))
    expect(list.body.items.map((v: any) => v.n)).toEqual([2, 1]) // the baked document is no console version
    expect(list.body.items[0]).not.toHaveProperty('document')
    const p1 = await call(s.handler, ev('GET', '/api/admin/config/versions', { query: { limit: '1' } }))
    expect(p1.body).toMatchObject({ items: [{ n: 2 }], nextCursor: '2' })
    expect((await call(s.handler, ev('GET', '/api/admin/config/versions', { query: { before: '2', limit: '1' } }))).body.items.map((v: any) => v.n)).toEqual([1])
    expect((await call(s.handler, ev('GET', '/api/admin/config/versions/1'))).body.document.identity.mode).toBe('off')
    expect((await call(s.handler, ev('GET', '/api/admin/config/versions/1-20991231T000000Z'))).status).toBe(404)
    expect((await call(s.handler, ev('GET', '/api/admin/config/versions/x'))).status).toBe(404)
  })
})
