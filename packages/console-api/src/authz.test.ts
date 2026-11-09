// Authorization on every route (design v1 §2.4 / §4): anonymous 401, wrong scope 403, members never reach admin
// routes or another principal's data, and every route authorizes from the live MEMBER item (0d, C7 review).
import { pathOf, ROUTES, type RouteDef } from '@auto-router/console-contract'
import { describe, expect, it } from 'vitest'
import { HANDLERS } from './app.ts'
import { parseGroups } from './auth.ts'
import { ADMIN, call, ev, MEMBER, MEMBER_SUB, OTHER, OTHER_SUB, record, REQ_A, REQ_B, setup, v22 } from './test-fixtures.ts'

const sample: Record<string, string> = { reqId: REQ_A, label: '0123456789abcdef', id: MEMBER_SUB, version: '0-20261108T000000Z', packVersion: v22.packVersion }
const concrete = (r: RouteDef) => pathOf(r.path, Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map(([, k]) => [k as string, sample[k as string] ?? 'x'])))

describe('route table', () => {
  it('every contract route has exactly one handler, and no handler is outside the contract', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(ROUTES.map((r) => r.id).sort())
  })
})

describe('every route', () => {
  for (const r of ROUTES as readonly RouteDef[]) {
    const path = concrete(r)
    it(`${r.id}: anonymous 401, wrong scope 403, ID token 401, no group 403${r.access === 'admin' ? ', member 403' : ''}; no side effects`, async () => {
      const s = setup()
      expect((await call(s.handler, ev(r.method, path, { as: null }))).status).toBe(401)
      expect((await call(s.handler, ev(r.method, path, { as: { ...ADMIN, scopes: ['llmar/invoke'] } }))).status).toBe(403)
      expect((await call(s.handler, ev(r.method, path, { as: { ...ADMIN, tokenUse: 'id' } }))).status).toBe(401)
      expect((await call(s.handler, ev(r.method, path, { as: { ...MEMBER, groups: [] } }))).status).toBe(403)
      if (r.access === 'admin') {
        const res = await call(s.handler, ev(r.method, path, { as: MEMBER, body: { action: 'disable', document: {}, comment: 'x', baseVersion: 'x' } }))
        expect(res).toMatchObject({ status: 403, body: { error: { code: 'forbidden', requestId: 'req-1' } } })
      }
      expect(s.console.audit).toEqual([])
      expect(s.objects.puts).toEqual([])
      expect(s.directory.calls).toEqual([])
    })
  }
})

describe('live authorization (MEMBER item)', () => {
  it('a demoted admin gets 403 with the same token', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/admin/members'))).status).toBe(200)
    s.console.members.get(`user:${ADMIN.sub}`)!.group = 'member' // demoted; the token still claims admin
    expect((await call(s.handler, ev('GET', '/api/admin/members'))).status).toBe(403)
    expect((await call(s.handler, ev('GET', '/api/me/profile'))).status).toBe(200) // still an active member
  })
  it('a disabled member gets 403 on self routes with the same token', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).status).toBe(200)
    s.console.members.get(`user:${MEMBER_SUB}`)!.disabled = true
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).status).toBe(403)
  })
  it('a member whose token claims admin, and a user without a MEMBER item, get 403', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/admin/members', { as: { ...MEMBER, groups: ['admin', 'member'] } }))).status).toBe(403)
    s.console.members.delete(`user:${OTHER_SUB}`)
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: OTHER }))).status).toBe(403)
  })
  it('a disable through the API takes effect on the next request (no cache)', async () => {
    const s = setup()
    await call(s.handler, ev('POST', `/api/admin/members/${MEMBER_SUB}/actions`, { body: { action: 'disable' } }))
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: MEMBER }))).status).toBe(403)
  })
})

describe('caller checks and routing', () => {
  it('a client-credentials token (no username, sub = client id) is refused', async () => {
    const s = setup()
    expect((await call(s.handler, ev('GET', '/api/me/profile', { as: { sub: 'svcclient', groups: ['admin'] } }))).status).toBe(401)
  })
  it('unknown route 404, wrong method 405, both with the error body', async () => {
    const s = setup()
    expect(await call(s.handler, ev('GET', '/api/nope'))).toMatchObject({ status: 404, body: { error: { code: 'not-found' } } })
    expect(await call(s.handler, ev('DELETE', '/api/me/profile'))).toMatchObject({ status: 405, body: { error: { code: 'bad-request' } } })
  })
  it('parseGroups accepts array, JSON and flattened shapes', () => {
    expect(parseGroups(['admin', 'x'])).toEqual(['admin'])
    expect(parseGroups('["member","admin"]')).toEqual(['member', 'admin'])
    expect(parseGroups('[admin member]')).toEqual(['admin', 'member'])
    expect(parseGroups('member')).toEqual(['member'])
    expect(parseGroups(7)).toEqual([])
  })
})

describe('member isolation', () => {
  const seed = (s: ReturnType<typeof setup>) => {
    s.usage.records.push(record({ reqId: REQ_A, principal: `user:${MEMBER_SUB}` }), record({ reqId: REQ_B, principal: `user:${OTHER_SUB}`, session: 'fedcba9876543210', ts: '2026-11-08T11:58:00.000Z' }))
  }
  it('own records and sessions are readable; another member’s are 404', async () => {
    const s = setup(); seed(s)
    expect((await call(s.handler, ev('GET', `/api/me/records/${REQ_A}`, { as: MEMBER }))).status).toBe(200)
    expect((await call(s.handler, ev('GET', `/api/me/records/${REQ_B}`, { as: MEMBER }))).status).toBe(404)
    expect((await call(s.handler, ev('GET', '/api/me/records/not-a-uuid', { as: MEMBER }))).status).toBe(404)
    expect((await call(s.handler, ev('GET', '/api/me/sessions/0123456789abcdef', { as: MEMBER }))).status).toBe(200)
    expect((await call(s.handler, ev('GET', '/api/me/sessions/fedcba9876543210', { as: MEMBER }))).status).toBe(404)
    const list = await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER }))
    expect(list.body.items.map((r: any) => r.reqId)).toEqual([REQ_A])
    expect(list.body.items[0]).not.toHaveProperty('caller')
  })
  it('a member cannot select a caller', async () => {
    const s = setup(); seed(s)
    expect((await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER, query: { caller: `user:${OTHER_SUB}` } }))).status).toBe(400)
    expect((await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { caller: `user:${OTHER_SUB}` } }))).status).toBe(400)
    expect((await call(s.handler, ev('GET', '/api/me/usage', { as: MEMBER, query: { groupBy: 'caller' } }))).status).toBe(400)
  })
  it('a pagination cursor from another principal is refused', async () => {
    const s = setup()
    for (let i = 0; i < 3; i++) s.usage.records.push(record({ reqId: `3333333${i}-3333-4333-8333-333333333333`, principal: `user:${OTHER_SUB}`, ts: `2026-11-08T11:5${i}:00.000Z` }))
    const other = await call(s.handler, ev('GET', '/api/me/records', { as: OTHER, query: { limit: '1' } }))
    expect(other.body.nextCursor).toBeDefined()
    expect((await call(s.handler, ev('GET', '/api/me/records', { as: MEMBER, query: { cursor: other.body.nextCursor } }))).status).toBe(400)
  })
  it('admins see every principal, with caller refs; admin.session needs ?caller=', async () => {
    const s = setup(); seed(s)
    const all = await call(s.handler, ev('GET', '/api/admin/records'))
    expect(all.body.items.map((r: any) => r.caller.key)).toEqual([`user:${MEMBER_SUB}`, `user:${OTHER_SUB}`])
    expect(all.body.items[0].caller).toMatchObject({ kind: 'user', name: 'member1' })
    const one = await call(s.handler, ev('GET', '/api/admin/records', { query: { caller: `user:${OTHER_SUB}` } }))
    expect(one.body.items.map((r: any) => r.reqId)).toEqual([REQ_B])
    expect((await call(s.handler, ev('GET', `/api/admin/records/${REQ_B}`))).status).toBe(200)
    expect((await call(s.handler, ev('GET', '/api/admin/sessions/fedcba9876543210'))).status).toBe(400)
    expect((await call(s.handler, ev('GET', '/api/admin/sessions/fedcba9876543210', { query: { caller: `user:${OTHER_SUB}` } }))).status).toBe(200)
  })
})
