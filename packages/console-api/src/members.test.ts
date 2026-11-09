// Members, service clients, budgets and settings: Cognito via the directory port, identity objects for the router.
import { describe, expect, it } from 'vitest'
import { ADMIN, call, ev, MEMBER, MEMBER_SUB, OTHER_SUB, setup, type Setup } from './test-fixtures.ts'

const principals = (s: Setup) => JSON.parse(s.objects.objects.get('identity/principals.json') ?? '{}')
const blocks = (s: Setup) => JSON.parse(s.objects.objects.get('identity/blocks.json') ?? '{"principals":[]}')
const budget = { monthlyUsd: 50, alertAt: 0.8, hardStop: true }
const act = (s: Setup, id: string, action: string) => call(s.handler, ev('POST', `/api/admin/members/${id}/actions`, { body: { action } }))

describe('members', () => {
  it('invite: Cognito user, MEMBER item, principals.json; no e-mail in the audit', async () => {
    const s = setup()
    const r = await call(s.handler, ev('POST', '/api/admin/members', { body: { email: 'New.Person@Example.com', name: 'New', role: 'member', budget, tierLimit: { maxTier: 'fast' } } }))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ email: 'new.person@example.com', name: 'New', role: 'member', status: 'invited', mfa: 'not-enrolled', costThisMonthUsd: 0, budget, tierLimit: { maxTier: 'fast' } })
    expect(principals(s)[`user:${r.body.id}`]).toEqual({ group: 'member', cap: { maxTier: 'fast' } })
    expect(s.console.members.get(`user:${r.body.id}`)).toMatchObject({ group: 'member', budget })
    expect(JSON.stringify(s.console.audit)).not.toContain('example.com')
    const again = await call(s.handler, ev('POST', '/api/admin/members', { body: { email: 'new.person@example.com', name: 'x', role: 'member' } }))
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'email-exists' } } })
    for (const body of [{ email: 'bad', name: 'x', role: 'member' }, { email: 'a@b.cd', role: 'member' }, { email: 'a@b.cd', name: 'x', role: 'service' },
      { email: 'a@b.cd', name: 'x', role: 'member', budget: { monthlyUsd: 5 } }, { email: 'a@b.cd', name: 'x', role: 'member', extra: 1 }]) {
      expect((await call(s.handler, ev('POST', '/api/admin/members', { body }))).status).toBe(400)
    }
    expect((await call(s.handler, ev('POST', '/api/admin/members', { body: { email: 'a@b.cd', name: 'x', role: 'member', tierLimit: { maxTier: 'x' } } }))).body.error.code).toBe('validation-failed')
  })

  it('PATCH role / budget / tierLimit: MEMBER item first, then Cognito; null clears; self and last admin refused', async () => {
    const s = setup()
    const path = `/api/admin/members/${MEMBER_SUB}`
    const r = await call(s.handler, ev('PATCH', path, { body: { role: 'admin', budget } }))
    expect(r.body).toMatchObject({ role: 'admin', budget })
    expect(s.directory.calls).toEqual(['role:member1:admin'])
    expect(principals(s)[`user:${MEMBER_SUB}`]).toEqual({ group: 'admin' })
    expect((await call(s.handler, ev('PATCH', path, { body: { budget: null } }))).body).not.toHaveProperty('budget')
    expect((await call(s.handler, ev('PATCH', `/api/admin/members/${ADMIN.sub}`, { body: { role: 'member' } }))).body.error.code).toBe('cannot-disable-self')
    expect((await call(s.handler, ev('PATCH', path, { body: { role: 'member' } }))).status).toBe(200) // two admins: allowed
    expect((await call(s.handler, ev('PATCH', path, { body: { group: 'x' } }))).status).toBe(400)
    expect(s.console.audit.map((a) => a.action)).toEqual(['member.role', 'member.update', 'member.role'])
  })

  it('last-admin guard by MEMBER items', async () => {
    const s = setup()
    // The other admin is the only active admin item left besides the caller once the caller is disabled in the table.
    s.console.members.get(`user:${MEMBER_SUB}`)!.group = 'admin'
    s.directory.users.get('member1')!.groups = ['admin']
    s.console.members.get(`user:${ADMIN.sub}`)!.disabled = false
    expect((await act(s, MEMBER_SUB, 'disable')).status).toBe(200) // two active admins
    // Now only the caller is an active admin: demoting the (disabled) member is fine, disabling self is not.
    expect((await act(s, ADMIN.sub, 'disable')).body.error.code).toBe('cannot-disable-self')
  })

  it('disable revokes sign-in and blocks at the router; enable unblocks; delete needs disabled first', async () => {
    const s = setup()
    const path = `/api/admin/members/${MEMBER_SUB}`
    expect((await call(s.handler, ev('DELETE', path))).body.error.code).toBe('not-disabled')
    expect((await act(s, MEMBER_SUB, 'disable')).body).toMatchObject({ status: 'disabled' })
    expect(s.directory.calls).toEqual(['disable:member1', 'signout:member1'])
    expect(blocks(s)).toMatchObject({ schemaVersion: 1, etag: expect.any(String), principals: [{ kind: 'user', id: MEMBER_SUB, reason: 'disabled', at: '2026-11-08T12:00:00.000Z' }] })
    expect((await act(s, MEMBER_SUB, 'enable')).body).toMatchObject({ status: 'active' })
    expect(blocks(s).principals).toEqual([])
    await act(s, MEMBER_SUB, 'disable')
    expect((await call(s.handler, ev('DELETE', path))).status).toBe(204)
    expect(principals(s)).not.toHaveProperty(`user:${MEMBER_SUB}`)
    expect((await call(s.handler, ev('GET', path))).status).toBe(404)
  })

  it('actions: self-disable refused, unknown action 400 (also reset-mfa: MFA is off), resend only before first sign-in, sign-out', async () => {
    const s = setup()
    expect((await act(s, ADMIN.sub, 'disable')).body.error.code).toBe('cannot-disable-self')
    expect((await act(s, MEMBER_SUB, 'explode')).status).toBe(400)
    const mfa = await act(s, MEMBER_SUB, 'reset-mfa')
    expect(mfa).toMatchObject({ status: 400, body: { error: { message: 'action: resend-invite | disable | enable | sign-out' } } })
    expect((await act(s, MEMBER_SUB, 'resend-invite')).status).toBe(400)
    await act(s, MEMBER_SUB, 'sign-out')
    expect(s.directory.calls).toEqual(['signout:member1'])
    expect(s.console.audit.map((a) => a.action)).toEqual(['member.signOut'])
    expect((await call(s.handler, ev('GET', '/api/admin/members/not-a-sub'))).status).toBe(404)
  })

  it('list and detail: role from the MEMBER item, month cost from budget spend, history from the audit', async () => {
    const s = setup()
    s.usage.spend.set(`user:${MEMBER_SUB}#2026-11`, 1_500_000_000)
    await call(s.handler, ev('PATCH', `/api/admin/members/${MEMBER_SUB}`, { body: { tierLimit: { maxTier: 'standard' } } }))
    const list = await call(s.handler, ev('GET', '/api/admin/members'))
    expect(list.body.items).toHaveLength(3)
    expect(list.body.items.find((m: any) => m.username === 'member1')).toMatchObject({ role: 'member', costThisMonthUsd: 1.5, tierLimit: { maxTier: 'standard' } })
    const d = await call(s.handler, ev('GET', `/api/admin/members/${MEMBER_SUB}`))
    expect(d.body.history).toEqual([expect.objectContaining({ status: 'role', by: `user:${ADMIN.sub}` })])
  })
})

describe('identity delivery (design §2.3a)', () => {
  it('a failed identity put answers 502 identity-delivery-failed, audits it, keeps the change; republish repeats it', async () => {
    const s = setup()
    s.objects.failPut = (k) => k.startsWith('identity/')
    const r = await act(s, MEMBER_SUB, 'disable')
    expect(r).toMatchObject({ status: 502, body: { error: { code: 'identity-delivery-failed' } } })
    expect(s.console.members.get(`user:${MEMBER_SUB}`)?.disabled).toBe(true)
    expect(s.console.audit.at(-1)).toMatchObject({ action: 'member.disable', result: 'failed', errorCode: 'identity-delivery-failed' })
    expect((await call(s.handler, ev('GET', '/api/admin/members'))).body.identity).toMatchObject({ state: 'notDelivered', errorCode: 'identity-delivery-failed' })
    s.objects.failPut = undefined
    expect((await call(s.handler, ev('POST', '/api/admin/identity/republish'))).body).toMatchObject({ identity: { state: 'delivered' } })
    expect(blocks(s).principals).toEqual([expect.objectContaining({ id: MEMBER_SUB })])
    expect((await call(s.handler, ev('GET', '/api/admin/service-clients'))).body.identity.state).toBe('delivered')
  })
  it('after a failed publish, a later partial publish rewrites both objects before reporting delivered (0d)', async () => {
    const s = setup()
    s.objects.failPut = (k) => k === 'identity/blocks.json'
    expect((await act(s, MEMBER_SUB, 'disable')).status).toBe(502) // principals written, blocks stale
    s.objects.failPut = undefined
    s.objects.puts.length = 0
    // An invite publishes principals only, but the state was notDelivered: blocks.json is rewritten too.
    expect((await call(s.handler, ev('POST', '/api/admin/members', { body: { email: 'n@example.org', name: 'N', role: 'member' } }))).status).toBe(201)
    expect(s.objects.puts).toEqual(expect.arrayContaining(['identity/principals.json', 'identity/blocks.json']))
    expect(blocks(s).principals).toEqual([expect.objectContaining({ id: MEMBER_SUB })])
    expect(s.console.identityDelivery?.state).toBe('delivered')
    // Every write publishes both objects (0d): no concurrent or earlier partial publish can leave one stale.
    s.objects.puts.length = 0
    await call(s.handler, ev('PATCH', `/api/admin/members/${OTHER_SUB}`, { body: { tierLimit: { maxTier: 'fast' } } }))
    expect(s.objects.puts.sort()).toEqual(['identity/blocks.json', 'identity/principals.json'])
  })
})

describe('service clients', () => {
  it('create returns the secret once with the token endpoint and scope; never in the audit, logs or list', async () => {
    const s = setup()
    const r = await call(s.handler, ev('POST', '/api/admin/service-clients', { body: { name: 'ci runner', description: 'CI', budget } }))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ client: { name: 'ci runner', description: 'CI', status: 'active', scope: 'llmar/invoke', budget }, tokenEndpoint: 'https://auth.example.com/oauth2/token', scope: 'llmar/invoke' })
    const secret = r.body.secret as string
    expect(JSON.stringify(s.console.audit)).not.toContain(secret)
    expect(JSON.stringify(s.logs)).not.toContain(secret)
    expect(JSON.stringify((await call(s.handler, ev('GET', '/api/admin/service-clients'))).body)).not.toContain(secret)
    expect(principals(s)[`client:${r.body.client.id}`]).toEqual({ group: 'service' })
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('rotate-secret, disable (block list), patch, delete; only console-created clients are reachable', async () => {
    const s = setup()
    const { body } = await call(s.handler, ev('POST', '/api/admin/service-clients', { body: { name: 'agent-x' } }))
    const base = `/api/admin/service-clients/${body.client.id}`
    const rot = await call(s.handler, ev('POST', `${base}/actions`, { body: { action: 'rotate-secret' } }))
    expect(rot.body.secret).not.toBe(body.secret)
    await call(s.handler, ev('POST', `${base}/actions`, { body: { action: 'disable' } }))
    expect(blocks(s).principals).toEqual([expect.objectContaining({ kind: 'client', id: body.client.id })])
    expect((await call(s.handler, ev('PATCH', base, { body: { tierLimit: { maxTier: 'fast' } } }))).body.tierLimit).toEqual({ maxTier: 'fast' })
    expect((await call(s.handler, ev('DELETE', base))).status).toBe(204)
    expect(s.clients.clients.has(body.client.id)).toBe(false)
    expect((await call(s.handler, ev('POST', '/api/admin/service-clients/cliclient/actions', { body: { action: 'rotate-secret' } }))).status).toBe(404)
    expect(s.console.audit.map((a) => a.action)).toEqual(['client.create', 'client.rotate', 'client.disable', 'client.update', 'client.delete'])
  })
})

describe('client ids with "+" (Cognito ClientIdType [\\w+]+)', () => {
  it('MEMBER keys, routes, principals.json, blocks and records accept a "+" in the client id', async () => {
    const s = setup()
    const id = 'ab+cd0123456789xyz'
    s.clients.createClient = async (name) => { s.clients.clients.set(id, { clientId: id, name, secret: 'sec' }); return { clientId: id, secret: 'sec' } }
    const r = await call(s.handler, ev('POST', '/api/admin/service-clients', { body: { name: 'plus' } }))
    expect(r.body.client.id).toBe(id)
    expect(principals(s)[`client:${id}`]).toEqual({ group: 'service' })
    const base = `/api/admin/service-clients/${encodeURIComponent(id)}`
    expect((await call(s.handler, ev('PATCH', base, { body: { tierLimit: { maxTier: 'fast' } } }))).status).toBe(200)
    expect((await call(s.handler, ev('POST', `${base}/actions`, { body: { action: 'disable' } }))).status).toBe(200)
    expect(blocks(s).principals).toEqual([expect.objectContaining({ kind: 'client', id })])
    s.usage.records.push({ ts: '2026-11-08T11:00:00.000Z', reqId: '44444444-4444-4444-8444-444444444444', principal: `client:${id}` })
    const rec = await call(s.handler, ev('GET', '/api/admin/records', { query: { caller: `client:${id}` } }))
    expect(rec.body.items.map((x: any) => x.reqId)).toEqual(['44444444-4444-4444-8444-444444444444'])
  })
})

describe('budgets and settings', () => {
  it('default budget: set, used by profiles without their own, listed per principal with spend, cleared with null', async () => {
    const s = setup()
    expect((await call(s.handler, ev('PUT', '/api/admin/budgets', { body: { default: budget } }))).body.default).toEqual(budget)
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).body.budget).toEqual({ ...budget, spentUsd: 0, month: '2026-11' })
    await call(s.handler, ev('PATCH', `/api/admin/members/${OTHER_SUB}`, { body: { budget: { monthlyUsd: 9, alertAt: 0.5, hardStop: false } } }))
    s.usage.spend.set(`user:${OTHER_SUB}#2026-11`, 2_000_000_000)
    expect((await call(s.handler, ev('GET', '/api/admin/budgets'))).body.perPrincipal).toEqual([
      { caller: { key: `user:${OTHER_SUB}`, kind: 'user', name: 'member2', email: 'cccccccc@example.com' }, budget: { monthlyUsd: 9, alertAt: 0.5, hardStop: false }, spentUsd: 2 },
    ])
    expect((await call(s.handler, ev('PUT', '/api/admin/budgets', { body: { default: { monthlyUsd: -1, alertAt: 0.5, hardStop: false } } }))).status).toBe(400)
    expect((await call(s.handler, ev('PUT', '/api/admin/budgets', { body: { default: null } }))).body).not.toHaveProperty('default')
  })
  it('settings: defaults, patch with validation, read-only facts', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/admin/settings'))).body).toMatchObject({ defaultBaseline: 'static', readOnly: { retentionDays: 90, refreshDays: 30, catalog: { region: 'ap-northeast-1' } }, identity: { state: 'pending' } })
    expect((await call(s.handler, ev('PATCH', '/api/admin/settings', { body: { defaultBaseline: 'standard' } }))).body).toMatchObject({ defaultBaseline: 'standard', readOnly: { retentionDays: 90 } })
    // Retention is a deploy setting (recordRetentionDays): read-only here.
    expect((await call(s.handler, ev('PATCH', '/api/admin/settings', { body: { retentionDays: 30 } }))).status).toBe(400)
    expect((await call(s.handler, ev('PATCH', '/api/admin/settings', { body: { other: 1 } }))).status).toBe(400)
    expect(s.console.audit.map((a) => a.action)).toEqual(['settings.change'])
  })
})
