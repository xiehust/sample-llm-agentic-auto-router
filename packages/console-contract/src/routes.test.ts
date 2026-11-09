import { describe, expect, it } from 'vitest'
import { allowed, daysBetween, isDay, matchRoute, pathOf, ROUTES, toQuery } from './index.ts'

describe('route table', () => {
  it('has unique ids and unique method+path pairs', () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length)
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length)
  })

  it('keeps every /api/admin route admin-only and every /api/me route self-scoped', () => {
    for (const r of ROUTES) {
      if (r.path.startsWith('/api/admin/')) expect(r.access, r.id).toBe('admin')
      else expect(r.access, r.id).toBe('self')
    }
  })

  it('never takes a principal id on self routes', () => {
    for (const r of ROUTES.filter((x) => x.access === 'self')) expect(r.path, r.id).not.toMatch(/:(id|principal|sub|caller)\b/)
  })

  it('marks every non-GET route as mutating, except validate', () => {
    for (const r of ROUTES) {
      if (r.method === 'GET' || r.id === 'admin.config.validate') continue
      expect('mutates' in r && r.mutates, r.id).toBe(true)
    }
  })

  it('matches templates, decodes parameters and rejects empty segments', () => {
    expect(matchRoute('GET', '/api/me/records/abc%2F1')?.params).toEqual({ reqId: 'abc/1' })
    expect(matchRoute('GET', '/api/me/records/')).toBeUndefined()
    expect(matchRoute('POST', '/api/me/profile')).toBeUndefined()
    expect(matchRoute('GET', '/api/me/records/%E0%A4%A')).toBeUndefined()
    expect(matchRoute('POST', '/api/admin/members/u1/actions')?.route.id).toBe('admin.members.action')
  })

  it('builds paths and refuses missing parameters', () => {
    expect(pathOf('/api/me/sessions/:label', { label: 'a b' })).toBe('/api/me/sessions/a%20b')
    expect(() => pathOf('/api/me/sessions/:label')).toThrow(/missing path parameter/)
  })

  it('allows self routes to both roles and admin routes to admins only', () => {
    const me = ROUTES.find((r) => r.id === 'me.usage')!
    const adm = ROUTES.find((r) => r.id === 'admin.usage')!
    expect([allowed(me, 'member'), allowed(me, 'admin'), allowed(me, undefined)]).toEqual([true, true, false])
    expect([allowed(adm, 'member'), allowed(adm, 'admin')]).toEqual([false, true])
  })
})

describe('query helpers', () => {
  it('encodes arrays as comma lists and drops empties', () => {
    expect(toQuery({ from: '2026-11-01', model: ['a', 'b'], tier: [], x: undefined, y: '', f: false })).toBe('?from=2026-11-01&model=a%2Cb&f=false')
  })
  it('validates days and enumerates ranges', () => {
    expect([isDay('2026-02-29'), isDay('2028-02-29'), isDay('2026-13-01'), isDay('x')]).toEqual([false, true, false, false])
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    expect(daysBetween('2026-11-02', '2026-11-01')).toEqual([])
  })
})
