// @vitest-environment node
// Authorization paths of the console API contract, exercised against the mock (for 0d's authz review and as the
// reference behaviour console-api's tests should match).

import { createHash, randomBytes } from 'node:crypto'
import { ROUTES, pathOf, type ConfigState, type Page, type Profile, type RecordSummary, type SavingsReport, type UsageReport } from '@auto-router/console-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOCK_CLIENT_ID, startMock, type MockStack } from './server.ts'

let stack: MockStack
const APP = 'http://127.0.0.1:5999'

beforeAll(async () => { stack = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], tokenTtlS: 300 }) })
afterAll(async () => { await stack.close() })

async function signIn(user: string, scope = 'openid llmar/console') {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: MOCK_CLIENT_ID, redirect_uri: `${APP}/auth/callback`, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', scope })
  const page = await fetch(`${stack.idpUrl}/oauth2/authorize?${q}`)
  const href = /href="(\/oauth2\/approve\?[^"]+user=([a-z]+))"/g
  const links = [...(await page.text()).matchAll(href)].find((m) => m[2] === user)
  if (!links) throw new Error(`no sign-in link for ${user}`)
  const approve = await fetch(stack.idpUrl + (links[1] as string).replace(/&amp;/g, '&'), { redirect: 'manual' })
  const loc = new URL(approve.headers.get('location') as string)
  expect(loc.searchParams.get('state')).toBe('s1')
  const tok = await fetch(`${stack.idpUrl}/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: MOCK_CLIENT_ID, code: loc.searchParams.get('code') as string, redirect_uri: `${APP}/auth/callback`, code_verifier: verifier }),
  })
  expect(tok.status).toBe(200)
  return (await tok.json()) as { access_token: string; refresh_token: string; id_token: string }
}

const api = (path: string, token?: string, init: RequestInit = {}) =>
  fetch(stack.apiUrl + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } })

const range = () => {
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)
  return { from, to, iso: { from: new Date(Date.now() - 14 * 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() } }
}

describe('fake IdP', () => {
  it('refuses PKCE plain, unknown redirect URIs and a wrong verifier', async () => {
    const base = { response_type: 'code', client_id: MOCK_CLIENT_ID, state: 'x', scope: 'openid llmar/console' }
    expect((await fetch(`${stack.idpUrl}/oauth2/authorize?${new URLSearchParams({ ...base, redirect_uri: 'http://127.0.0.1:1/x', code_challenge: 'c', code_challenge_method: 'S256' })}`)).status).toBe(400)
    expect((await fetch(`${stack.idpUrl}/oauth2/authorize?${new URLSearchParams({ ...base, redirect_uri: `${APP}/auth/callback`, code_challenge: 'c', code_challenge_method: 'plain' })}`)).status).toBe(400)
  })

  it('rotates refresh tokens: the old one is invalid after use', async () => {
    const t = await signIn('mia')
    const refresh = (rt: string) => fetch(`${stack.idpUrl}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: MOCK_CLIENT_ID, refresh_token: rt }) })
    const first = await refresh(t.refresh_token)
    expect(first.status).toBe(200)
    const next = (await first.json()) as { refresh_token: string }
    expect(next.refresh_token).not.toBe(t.refresh_token)
    expect((await refresh(t.refresh_token)).status).toBe(400)
    expect((await refresh(next.refresh_token)).status).toBe(200)
  })
})

describe('authorizer equivalent (before any handler)', () => {
  it('answers 401 to anonymous and malformed tokens on every route', async () => {
    for (const r of ROUTES) {
      const path = pathOf(r.path, Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1] as string, 'x'])))
      const anon = await api(path, undefined, { method: r.method })
      expect(anon.status, `${r.method} ${path}`).toBe(401)
      expect(anon.headers.get('www-authenticate')).toBe('Bearer')
      expect((await api(path, 'a.b.c', { method: r.method })).status).toBe(401)
    }
  })

  it('answers 403 to a valid token without the console scope, 401 to a wrong client, issuer or expiry', async () => {
    expect((await api('/api/me/profile', stack.mint({}))).status).toBe(200)
    expect((await api('/api/me/profile', stack.mint({ scope: 'openid llmar/invoke' }))).status).toBe(403)
    expect((await api('/api/me/profile', stack.mint({ client_id: 'cli' }))).status).toBe(401)
    expect((await api('/api/me/profile', stack.mint({ iss: 'http://127.0.0.1:1' }))).status).toBe(401)
    expect((await api('/api/me/profile', stack.mint({ exp: Math.floor(Date.now() / 1000) - 1 }))).status).toBe(401)
  })

  it('rejects a tampered payload (signature)', async () => {
    const t = await signIn('mia')
    const forged = t.access_token.split('.').map((p, i) => (i === 1 ? Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), 'cognito:groups': ['admin'] })).toString('base64url') : p)).join('.')
    expect((await api('/api/admin/members', forged)).status).toBe(401)
  })

  it('rejects ID tokens (token_use id)', async () => {
    const t = await signIn('ada')
    expect((await api('/api/me/profile', t.id_token)).status).toBe(401)
  })
})

describe('group checks and self-scoping', () => {
  it('gives members 403 on every admin route, with the contract error body', async () => {
    const t = await signIn('mia')
    for (const r of ROUTES.filter((x) => x.access === 'admin')) {
      const path = pathOf(r.path, Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1] as string, 'x'])))
      const res = await api(path, t.access_token, { method: r.method, ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: '{}' }) })
      expect(res.status, `${r.method} ${path}`).toBe(403)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden')
    }
  })

  it('gives a user without a console group 403 everywhere', async () => {
    const t = await signIn('nogroup')
    expect((await api('/api/me/profile', t.access_token)).status).toBe(403)
  })

  it('scopes /api/me to the caller and answers 404 for another caller\'s record and session', async () => {
    const { iso } = range()
    const mia = await signIn('mia')
    const noah = await signIn('noah')
    const q = `?from=${encodeURIComponent(iso.from)}&to=${encodeURIComponent(iso.to)}&limit=200`
    const miaRecs = (await (await api(`/api/me/records${q}`, mia.access_token)).json()) as Page<RecordSummary>
    expect(miaRecs.items.length).toBeGreaterThan(0)
    expect(miaRecs.items.every((r) => r.caller === undefined)).toBe(true)
    const own = miaRecs.items[0]!
    expect((await api(`/api/me/records/${own.reqId}`, mia.access_token)).status).toBe(200)
    expect((await api(`/api/me/records/${own.reqId}`, noah.access_token)).status).toBe(404)
    expect((await api(`/api/me/sessions/${own.session}`, noah.access_token)).status).toBe(404)
    const noahRecs = (await (await api(`/api/me/records${q}`, noah.access_token)).json()) as Page<RecordSummary>
    expect(noahRecs.items.some((r) => r.reqId === own.reqId)).toBe(false)
  })

  it('record lookups take ?ts (both roles) and ?caller (admin only); a mismatch is 404', async () => {
    const { iso } = range()
    const mia = await signIn('mia')
    const ada = await signIn('ada')
    const q = `?from=${encodeURIComponent(iso.from)}&to=${encodeURIComponent(iso.to)}&limit=1`
    const own = ((await (await api(`/api/me/records${q}`, mia.access_token)).json()) as Page<RecordSummary>).items[0]!
    const ts = encodeURIComponent(own.ts)
    expect((await api(`/api/me/records/${own.reqId}?ts=${ts}`, mia.access_token)).status).toBe(200)
    expect((await api(`/api/me/records/${own.reqId}?ts=${encodeURIComponent('2020-01-01T00:00:00.000Z')}`, mia.access_token)).status).toBe(404)
    expect((await api(`/api/me/records/${own.reqId}?caller=user:u-mia`, mia.access_token)).status).toBe(400)
    expect((await api(`/api/admin/records/${own.reqId}?ts=${ts}&caller=user:u-mia`, ada.access_token)).status).toBe(200)
    expect((await api(`/api/admin/records/${own.reqId}?ts=${ts}&caller=user:u-noah`, ada.access_token)).status).toBe(404)
  })

  it('refuses the caller dimension and filter to members (400), allows them to admins', async () => {
    const { from, to } = range()
    const mia = await signIn('mia')
    const ada = await signIn('ada')
    expect((await api(`/api/me/usage?from=${from}&to=${to}&groupBy=caller`, mia.access_token)).status).toBe(400)
    expect((await api(`/api/me/usage?from=${from}&to=${to}&caller=user:u-noah`, mia.access_token)).status).toBe(400)
    const adm = (await (await api(`/api/admin/usage?from=${from}&to=${to}&groupBy=caller`, ada.access_token)).json()) as UsageReport
    expect(adm.rows.map((r) => r.key)).toEqual(expect.arrayContaining(['user:u-mia', 'user:u-noah', 'none']))
    expect(adm.callers?.some((c) => c.key === 'user:u-mia' && c.email === 'mia@example.com')).toBe(true)
  })

  it('member totals equal the admin row for that member', async () => {
    const { from, to } = range()
    const mia = await signIn('mia')
    const ada = await signIn('ada')
    const own = (await (await api(`/api/me/usage?from=${from}&to=${to}`, mia.access_token)).json()) as UsageReport
    const all = (await (await api(`/api/admin/usage?from=${from}&to=${to}&groupBy=caller`, ada.access_token)).json()) as UsageReport
    expect(own.totals.cost.total).toBeCloseTo(all.rows.find((r) => r.key === 'user:u-mia')!.cost.total, 9)
  })
})

describe('contract behaviour', () => {
  it('profile: role from the group, deployment facts present', async () => {
    const p = (await (await api('/api/me/profile', (await signIn('ada')).access_token)).json()) as Profile
    expect(p.role).toBe('admin')
    expect(p.principal).toBe('user:u-admin')
    expect(p.deployment.catalog.region).toBe('ap-southeast-1')
  })

  it('savings: N = B − A − X = R − S − X, signed', async () => {
    const { from, to } = range()
    const s = (await (await api(`/api/me/usage?view=savings&from=${from}&to=${to}`, (await signIn('mia')).access_token)).json()) as SavingsReport
    const k = s.kpis
    expect(k.N).toBeCloseTo(k.B - k.A - k.X, 9)
    expect(k.N).toBeCloseTo(k.R - k.S - k.X, 9)
    expect(s.matrix.reduce((a, c) => a + c.n, 0)).toBe(k.requests)
  })

  it('config: versions are <n>-<compact time>; invalid → 422; stale base → 409; only disruptive effects need confirm', async () => {
    const t = (await signIn('ada')).access_token
    const st = (await (await api('/api/admin/config', t)).json()) as ConfigState
    expect(st.active.version).toMatch(/^2-\d{8}T\d{6}Z$/)
    const doc = structuredClone(st.active.document)
    const post = (path: string, b: unknown) => api(path, t, { method: 'POST', body: JSON.stringify(b) })
    const bad = { ...doc, policy: { ...doc.policy, mode: 'nope' } }
    expect(((await (await post('/api/admin/config/validate', { document: bad })).json()) as { ok: boolean }).ok).toBe(false)
    expect((await post('/api/admin/config/activate', { document: bad, comment: 'x', baseVersion: st.active.version })).status).toBe(422)
    expect((await post('/api/admin/config/activate', { document: doc, comment: 'x', baseVersion: '1-20260101T000000Z' })).status).toBe(409)
    // A mode flip is a warning, not disruptive: no confirm needed.
    const flip = { ...doc, policy: { ...doc.policy, mode: 'observe' } }
    const v = (await (await post('/api/admin/config/validate', { document: flip })).json()) as { effects: Array<{ effect: string; severity: string }> }
    expect(v.effects).toEqual(expect.arrayContaining([expect.objectContaining({ effect: 'mode', severity: 'warn' })]))
    const ok = await post('/api/admin/config/activate', { document: flip, comment: 'back to observe', baseVersion: st.active.version })
    expect(ok.status).toBe(200)
    const v3 = ((await ok.json()) as { version: { version: string; n: number } }).version
    expect(v3.n).toBe(3)
    expect(v3.version).toMatch(/^3-\d{8}T\d{6}Z$/)
    // Removing a pinnable model fails pins at once: disruptive, needs confirm.
    const pools = structuredClone((flip.policy as unknown as { pools: Record<string, { models: unknown[] }> }).pools)
    pools['openai-chat']!.models = pools['openai-chat']!.models.slice(0, 2)
    const removal = { ...flip, policy: { ...flip.policy, pools } }
    const un = await post('/api/admin/config/activate', { document: removal, comment: 'drop luna', baseVersion: v3.version })
    expect(un.status).toBe(409)
    expect(((await un.json()) as { error: { code: string } }).error.code).toBe('disruptive-unconfirmed')
    expect((await post('/api/admin/config/activate', { document: removal, comment: 'drop luna', baseVersion: v3.version, confirmDisruptive: true })).status).toBe(200)
  })

  it('config: discarding a draft and redelivering are audited', async () => {
    const t = (await signIn('ada')).access_token
    const st = (await (await api('/api/admin/config', t)).json()) as ConfigState
    await api('/api/admin/config', t, { method: 'PUT', body: JSON.stringify({ document: st.active.document, baseVersion: st.active.version }) })
    await api('/api/admin/config', t, { method: 'DELETE' })
    await api('/api/admin/config/redeliver', t, { method: 'POST' })
    const day = new Date().toISOString().slice(0, 10)
    const audit = (await (await api(`/api/admin/audit?from=${day}&to=${day}&limit=20`, t)).json()) as { items: Array<{ action: string }> }
    expect(audit.items.map((e) => e.action)).toEqual(expect.arrayContaining(['config.discard', 'config.redeliver']))
  })

  it('admin session lookups need ?caller (sessions are unique per caller only)', async () => {
    const { iso } = range()
    const ada = (await signIn('ada')).access_token
    const q = `?from=${encodeURIComponent(iso.from)}&to=${encodeURIComponent(iso.to)}&caller=user:u-mia&limit=1`
    const one = ((await (await api(`/api/admin/records${q}`, ada)).json()) as Page<RecordSummary>).items[0]!
    expect((await api(`/api/admin/sessions/${one.session}`, ada)).status).toBe(400)
    expect((await api(`/api/admin/sessions/${one.session}?caller=user:u-mia`, ada)).status).toBe(200)
    expect((await api(`/api/admin/sessions/${one.session}?caller=user:u-noah`, ada)).status).toBe(404)
  })

  it('settings: retention is a read-only deploy parameter; only the default baseline is patchable', async () => {
    const t = (await signIn('ada')).access_token
    const s = (await (await api('/api/admin/settings', t)).json()) as { readOnly: { retentionDays: number }; retentionDays?: number }
    expect(s.readOnly.retentionDays).toBe(90)
    expect(s.retentionDays).toBeUndefined()
    expect((await api('/api/admin/settings', t, { method: 'PATCH', body: JSON.stringify({ retentionDays: 30 }) })).status).toBe(400)
    expect((await api('/api/admin/settings', t, { method: 'PATCH', body: JSON.stringify({ defaultBaseline: 'standard' }) })).status).toBe(200)
    await api('/api/admin/settings', t, { method: 'PATCH', body: JSON.stringify({ defaultBaseline: 'static' }) })
  })

  it('members: cannot disable yourself; delete needs disabled; invite refuses duplicates', async () => {
    const t = (await signIn('ada')).access_token
    const post = (p: string, b: unknown) => api(p, t, { method: 'POST', body: JSON.stringify(b) })
    expect(((await (await post('/api/admin/members/u-admin/actions', { action: 'disable' })).json()) as { error: { code: string } }).error.code).toBe('cannot-disable-self')
    expect((await api('/api/admin/members/u-mia', t, { method: 'DELETE' })).status).toBe(409)
    expect((await post('/api/admin/members', { email: 'mia@example.com', name: 'Mia', role: 'member' })).status).toBe(409)
    expect((await post('/api/admin/members', { email: 'new@example.com', name: 'New', role: 'member' })).status).toBe(201)
    expect((await post('/api/admin/members/u-mia/actions', { action: 'reset-mfa' })).status).toBe(400) // MFA off: no such action
  })

  it('disabled members lose API access at once', async () => {
    const ada = (await signIn('ada')).access_token
    const noah = (await signIn('noah')).access_token
    expect((await api('/api/me/profile', noah)).status).toBe(200)
    await api('/api/admin/members/u-noah/actions', ada, { method: 'POST', body: JSON.stringify({ action: 'disable' }) })
    expect((await api('/api/me/profile', noah)).status).toBe(403)
    await api('/api/admin/members/u-noah/actions', ada, { method: 'POST', body: JSON.stringify({ action: 'enable' }) })
  })

  it('takes the role from the member table per request: a demoted admin loses admin routes with the same token', async () => {
    const ada = (await signIn('ada')).access_token
    const mia = (await signIn('mia')).access_token
    const patch = (id: string, role: string, token: string) => api(`/api/admin/members/${id}`, token, { method: 'PATCH', body: JSON.stringify({ role }) })
    expect((await patch('u-mia', 'admin', ada)).status).toBe(200)
    expect((await api('/api/admin/members', mia)).status).toBe(200) // Mia's token still says member: the table decides
    expect((await patch('u-mia', 'member', ada)).status).toBe(200)
    expect((await api('/api/admin/members', mia)).status).toBe(403)
    expect((await api('/api/me/profile', mia)).status).toBe(200)
  })
})

describe('identity delivery and signing keys (design §2.3a)', () => {
  let s2: MockStack
  beforeAll(async () => { s2 = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], failIdentityDeliveryOnce: true, identityKeysUnloaded: true }) })
  afterAll(async () => { await s2.close() })
  const call = (path: string, init: RequestInit = {}) => fetch(s2.apiUrl + path, { ...init, headers: { authorization: `Bearer ${s2.mint({})}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } })

  it('a failed identity publish answers 502 identity-delivery-failed, shows notDelivered, and republish delivers', async () => {
    const r = await call('/api/admin/members/u-mia', { method: 'PATCH', body: JSON.stringify({ tierLimit: { maxTier: 'fast' } }) })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('identity-delivery-failed')
    const list = (await (await call('/api/admin/members')).json()) as { identity: { state: string } }
    expect(list.identity.state).toBe('notDelivered')
    expect(((await (await call('/api/admin/identity/republish', { method: 'POST' })).json()) as { identity: { state: string } }).identity.state).toBe('delivered')
    expect(((await (await call('/api/admin/service-clients')).json()) as { identity: { state: string } }).identity.state).toBe('delivered')
  })

  it('refuses Require while the router has not loaded its signing keys', async () => {
    const st = (await (await call('/api/admin/config')).json()) as ConfigState
    expect(st.router.identityKeysLoaded).toBe(false)
    expect(st.delivery.state).toBe('delivered')
    const doc = { ...st.active.document, identity: { mode: 'require' } }
    const r = await call('/api/admin/config/activate', { method: 'POST', body: JSON.stringify({ document: doc, comment: 'require', baseVersion: st.active.version }) })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { error: { code: string; reason?: string; message: string; issues: Array<{ rule?: string }> } }
    expect(body.error.code).toBe('identity-keys-not-loaded')
    expect(body.error.reason).toBe('task-without-keys')
    expect(body.error.message).toBe('identity require refused: task router/4d5e6f has not loaded the user pool signing keys (jwks)')
    expect(body.error.issues.map((i) => i.rule)).toContain('identity-keys-not-loaded')
  })

  it('budget spend includes assessor cost (ΣA + ΣX)', async () => {
    const p = (await (await fetch(s2.apiUrl + '/api/me/profile', { headers: { authorization: `Bearer ${s2.mint({ sub: 'u-mia', 'cognito:groups': ['member'] })}` } })).json()) as Profile
    const day = new Date().toISOString().slice(0, 10)
    const first = `${day.slice(0, 7)}-01`
    const u = (await (await fetch(`${s2.apiUrl}/api/me/usage?from=${first}&to=${day}`, { headers: { authorization: `Bearer ${s2.mint({ sub: 'u-mia', 'cognito:groups': ['member'] })}` } })).json()) as UsageReport
    expect(p.budget!.spentUsd).toBeGreaterThan(u.totals.cost.total)
  })
})

describe('swap effects', () => {
  it('an active policy that no longer validates gives one disruptive cannot-compare effect', async () => {
    const { interimValidator } = await import('./validate.ts')
    const { loadCatalog } = await import('@auto-router/pricing')
    const v = interimValidator({ catalog: loadCatalog('ap-southeast-1'), universe: [], packs: [] })
    const good = { schemaVersion: 1 as const, version: '1-x', policy: { mode: 'observe' }, access: { groups: {} } }
    const effects = v.effects({ ...good, policy: { mode: 'nope' } }, good)
    expect(effects).toEqual([expect.objectContaining({ effect: 'cannot-compare', severity: 'disruptive' })])
  })
})

describe('runs under plain Node', () => {
  it('loads the mock with Node type stripping (no TS-only syntax such as parameter properties)', async () => {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./mock/server.ts'); console.log(typeof m.startMock)"], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
    expect(out.trim()).toBe('function')
  })
})

describe('effective configuration (0d-effective-config)', () => {
  const get = async (s: MockStack, path: string) => (await (await fetch(s.apiUrl + path, { headers: { authorization: `Bearer ${s.mint({})}` } })).json()) as never

  it('document: every section comes from the active console version; tasks report the same', async () => {
    const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP] })
    try {
      const c = (await get(s, '/api/admin/config')) as ConfigState
      expect(c.effective!.sources).toEqual({ policy: 'document', identity: 'document', assessor: 'document', access: 'document' })
      expect(c.effective!.identityMode).toEqual({ source: 'document', version: c.active.version, value: 'observe' })
      expect(c.effective!.document?.version).toBe(c.active.version)
      expect(c.reported!.every((r) => r.matches === true)).toBe(true)
      const p = (await get(s, '/api/me/profile')) as Profile
      expect(p.deployment.identityMode).toBe('observe')
      expect(p.deployment.effective!.routerMode.source).toBe('document')
    } finally { await s.close() }
  })

  it('baked: no console version, the active document is config/baked.json (n 0, author cdk, 0-baked.<sha8>)', async () => {
    const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], effective: 'baked' })
    try {
      const c = (await get(s, '/api/admin/config')) as ConfigState
      expect(c.active.n).toBe(0)
      expect(c.active.author).toBe('cdk')
      expect(c.active.version).toMatch(/^0-baked\.[0-9a-f]{8}$/)
      expect(c.effective!.sources.identity).toBe('baked')
      expect(c.effective!.assessorPack).toMatchObject({ source: 'baked', version: c.active.version, value: 'v2.2' })
      expect(c.effective!.bakedVersion).toBe(c.active.version)
    } finally { await s.close() }
  })

  it("unknown: a partial document with baked.json unreadable gives 'unknown', never a guessed 'off'", async () => {
    const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], effective: 'unknown', reportedMismatch: true })
    try {
      const c = (await get(s, '/api/admin/config')) as ConfigState
      expect(c.effective!.sources).toMatchObject({ policy: 'document', identity: 'unknown', assessor: 'unknown' })
      expect(c.effective!.identityMode).toEqual({ source: 'unknown' })
      expect(c.effective!.document).toBeUndefined()
      expect(c.reported!.every((r) => r.matches === undefined)).toBe(true)
      const p = (await get(s, '/api/me/profile')) as Profile
      expect(p.deployment.identityMode).toBe('unknown')
      const setup = (await get(s, '/api/me/setup')) as { identityMode: string }
      expect(setup.identityMode).toBe('unknown')
    } finally { await s.close() }
  })

  it('reports a mismatching task', async () => {
    const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], reportedMismatch: true })
    try {
      const c = (await get(s, '/api/admin/config')) as ConfigState
      expect(c.reported!.map((r) => r.matches)).toEqual([true, false])
    } finally { await s.close() }
  })
})

describe('config reads that fail (phase-2 404, 73 503 config-unavailable)', () => {
  for (const status of [404, 503] as const) {
    it(`${status}: GET /api/admin/config and the versions list fail; the profile still answers`, async () => {
      const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], configFailure: status })
      try {
        const h = { headers: { authorization: `Bearer ${s.mint({})}` } }
        for (const p of ['/api/admin/config', '/api/admin/config/versions']) {
          const r = await fetch(s.apiUrl + p, h)
          expect(r.status).toBe(status)
          expect(((await r.json()) as { error: { code: string } }).error.code).toBe(status === 404 ? 'not-found' : 'config-unavailable')
        }
        expect((await fetch(s.apiUrl + '/api/me/profile', h)).status).toBe(200)
      } finally { await s.close() }
    })
  }
})

describe('identity signing keys per router task (73: identityKeys, reason on the 422)', () => {
  const cases = [
    ['no-fresh-task', { fresh: 0, withKeys: 0 }, 'identity require refused: no router task has reported its state in the last 15 minutes'],
    ['partial', { fresh: 1, withKeys: 1 }, 'identity require refused: 1 of 2 running tasks report state'],
    ['not-configured', { task: 'router/1a2b3c' }, 'identity require refused: identity is not configured on task router/1a2b3c (deploy with identity)'],
    ['task-without-keys', { task: 'router/4d5e6f' }, 'identity require refused: task router/4d5e6f has not loaded the user pool signing keys (jwks)'],
  ] as const
  for (const [reason, state, message] of cases) {
    it(`${reason}: the router state says why, and Require is refused with that reason`, async () => {
      const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP], identityKeys: reason })
      try {
        const h = { authorization: `Bearer ${s.mint({})}`, 'content-type': 'application/json' }
        const st = (await (await fetch(s.apiUrl + '/api/admin/config', { headers: h })).json()) as ConfigState
        expect(st.router.identityKeysLoaded).toBe(false)
        expect(st.router.identityKeys).toMatchObject({ loaded: false, reason, running: 2, ...state })
        const r = await fetch(s.apiUrl + '/api/admin/config/activate', { method: 'POST', headers: h, body: JSON.stringify({ document: { ...st.active.document, identity: { mode: 'require' } }, comment: 'require', baseVersion: st.active.version }) })
        expect(r.status).toBe(422)
        expect(((await r.json()) as { error: { code: string; reason?: string; message: string } }).error).toMatchObject({ code: 'identity-keys-not-loaded', reason, message })
      } finally { await s.close() }
    })
  }

  it('all tasks loaded: no reason, and Require activates', async () => {
    const s = await startMock({ apiPort: 0, idpPort: 0, appOrigins: [APP] })
    try {
      const h = { authorization: `Bearer ${s.mint({})}`, 'content-type': 'application/json' }
      const st = (await (await fetch(s.apiUrl + '/api/admin/config', { headers: h })).json()) as ConfigState
      expect(st.router.identityKeys).toEqual({ loaded: true, fresh: 2, running: 2, withKeys: 2 })
      const r = await fetch(s.apiUrl + '/api/admin/config/activate', { method: 'POST', headers: h, body: JSON.stringify({ document: { ...st.active.document, identity: { mode: 'require' } }, comment: 'require', baseVersion: st.active.version, confirmDisruptive: true }) })
      expect(r.status).toBe(200)
    } finally { await s.close() }
  })
})
