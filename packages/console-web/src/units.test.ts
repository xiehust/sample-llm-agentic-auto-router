import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, SignInRequiredError } from './api/client.ts'
import { navItems } from './app/Layout.tsx'
import { decodeAccessClaims, roleOf } from './auth/claims.ts'
import { safeReturnTo } from './auth/return-to.ts'
import { codeLabel } from './components/codes.ts'
import { csvCell, toCsv } from './components/csv.ts'
import { compact, lineDiff } from './components/diff.ts'
import { resolveRange } from './components/range.tsx'
import { ConfigError, parseRuntimeConfig } from './config/runtime-config.ts'
import { formatters } from './i18n/format.ts'
import { initialLocale } from './i18n/locale.ts'

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (p: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(p)}.sig`

describe('runtime config', () => {
  const ok = { schemaVersion: 1, region: 'r', issuer: 'https://cognito-idp.r.amazonaws.com/r_x', cognitoDomain: 'https://d.auth.r.amazoncognito.com/', clientId: 'c', scopes: ['openid', 'p/console'] }
  it('accepts a valid document and normalizes origins and defaults', () => {
    const c = parseRuntimeConfig(ok)
    expect(c.cognitoDomain).toBe('https://d.auth.r.amazoncognito.com')
    expect(c.apiBase).toBe('/api')
    expect(c.tokenStorage).toBe('session')
  })
  it('refuses http (except 127.0.0.1), cross-origin apiBase and bad scopes', () => {
    expect(() => parseRuntimeConfig({ ...ok, cognitoDomain: 'http://evil.example' })).toThrow(ConfigError)
    expect(() => parseRuntimeConfig({ ...ok, cognitoDomain: 'http://127.0.0.1:4311' })).not.toThrow()
    expect(() => parseRuntimeConfig({ ...ok, apiBase: '//evil.example/api' })).toThrow(/apiBase/)
    expect(() => parseRuntimeConfig({ ...ok, scopes: ['a b'] })).toThrow(/scopes/)
    expect(() => parseRuntimeConfig({ ...ok, tokenStorage: 'local' })).toThrow(/tokenStorage/)
  })
})

describe('return-to after sign-in', () => {
  it('keeps same-origin paths only', () => {
    expect(safeReturnTo('/decisions?range=30d#x')).toBe('/decisions?range=30d#x')
    for (const bad of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', 3, '/auth/callback', '/signed-out']) expect(safeReturnTo(bad)).toBe('/')
  })
})

describe('claims', () => {
  it('decodes groups and scope; admin wins; no group → no role', () => {
    const c = decodeAccessClaims(jwt({ sub: 's', 'cognito:groups': ['member', 'admin'], scope: 'openid p/console', exp: 1 }))!
    expect(c.groups).toEqual(['member', 'admin'])
    expect(roleOf(c.groups)).toBe('admin')
    expect(roleOf(['member'])).toBe('member')
    expect(roleOf([])).toBeUndefined()
    expect(decodeAccessClaims('garbage')).toBeUndefined()
  })
})

describe('API client', () => {
  const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  it('sends a bearer token on same-origin /api paths only and never in the URL', async () => {
    const fetch = vi.fn(async () => res(200, { ok: true }))
    const c = new ApiClient({ getAccessToken: async () => 'tok' }, { fetch })
    await c.get('/api/me/profile')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/me/profile')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(init.credentials).toBe('omit')
    await expect(c.get('https://evil.example/api/x')).rejects.toThrow(/not an API path/)
  })
  it('on 401 refreshes once and retries; a second 401 asks for sign-in', async () => {
    const tokens = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'old'))
    const onSignIn = vi.fn()
    const fetch = vi.fn().mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(200, { a: 1 }))
    const c = new ApiClient({ getAccessToken: tokens }, { fetch, onSignInRequired: onSignIn })
    expect(await c.get('/api/me/profile')).toEqual({ a: 1 })
    expect(tokens).toHaveBeenLastCalledWith(true)
    const fetch2 = vi.fn(async () => res(401))
    const c2 = new ApiClient({ getAccessToken: tokens }, { fetch: fetch2, onSignInRequired: onSignIn })
    await expect(c2.get('/api/me/profile')).rejects.toBeInstanceOf(SignInRequiredError)
    expect(onSignIn).toHaveBeenCalled()
  })
  it('maps contract error bodies to ApiError with code, request id and issues', async () => {
    const c = new ApiClient({ getAccessToken: async () => 't' }, { fetch: async () => res(422, { error: { code: 'validation-failed', message: 'm', requestId: 'r1', issues: [{ path: '/x', message: 'bad' }] } }) })
    const e = await c.post('/api/admin/config/activate', {}).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).code).toBe('validation-failed')
    expect((e as ApiError).requestId).toBe('r1')
    expect((e as ApiError).issues).toHaveLength(1)
    const f = new ApiClient({ getAccessToken: async () => 't' }, { fetch: async () => res(403, { message: 'Forbidden' }) })
    const g = await f.get('/api/admin/members').catch((x: unknown) => x)
    expect((g as ApiError).forbidden).toBe(true)
  })
  it('times out', async () => {
    const c = new ApiClient({ getAccessToken: async () => 't' }, { fetch: (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError')))) })
    await expect(c.get('/api/me/profile', { timeoutMs: 20 })).rejects.toThrow()
  })
})

describe('date ranges', () => {
  it('are stable within a day so query keys do not change every render', () => {
    const t0 = Date.parse('2026-11-08T10:00:00Z')
    for (const range of ['24h', '7d', '30d', 'thisMonth', 'lastMonth']) {
      const a = resolveRange(new URLSearchParams({ range }), t0)
      const b = resolveRange(new URLSearchParams({ range }), t0 + 61_000)
      expect(b, range).toEqual(a)
    }
  })
  it('resolve presets and custom days in UTC', () => {
    const t0 = Date.parse('2026-11-08T10:00:00Z')
    expect(resolveRange(new URLSearchParams(), t0)).toMatchObject({ key: '7d', from: '2026-11-02', to: '2026-11-08', toIso: '2026-11-09T00:00:00.000Z' })
    expect(resolveRange(new URLSearchParams({ range: 'lastMonth' }), t0)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' })
    expect(resolveRange(new URLSearchParams({ from: '2026-11-01', to: '2026-11-03' }), t0)).toMatchObject({ key: 'custom', toIso: '2026-11-04T00:00:00.000Z' })
    expect(resolveRange(new URLSearchParams({ from: '2026-11-05', to: '2026-11-01' }), t0).key).toBe('7d')
  })
})

describe('formatting', () => {
  it('en and zh-CN money, compact tokens and percent', () => {
    const en = formatters('en')
    const zh = formatters('zh-CN')
    expect(en.usd(1234.5)).toBe('$1,234.50')
    expect(zh.usd(1234.5)).toBe('US$1,234.50')
    expect(en.usdPrecise(0.00123)).toBe('$0.00123')
    expect(en.usdSigned(-2)).toBe('-$2.00')
    expect(en.usdSigned(2)).toBe('+$2.00')
    expect(zh.compact(45678)).toBe('4.6万')
    expect(en.percent(0.873)).toBe('87.3%')
    expect(en.day('2026-11-08')).toBe('Nov 8')
  })
  it('chooses zh-CN for Chinese browsers unless stored', () => {
    expect(initialLocale(undefined, ['zh-TW'])).toBe('zh-CN')
    expect(initialLocale(undefined, ['en-GB', 'fr'])).toBe('en')
    expect(initialLocale({ getItem: () => 'en' }, ['zh-CN'])).toBe('en')
  })
})

describe('CSV', () => {
  it('quotes and neutralizes spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(-1.5)).toBe('-1.5')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(toCsv(['meta'], ['h'], [[1]])).toBe('﻿# meta\r\nh\r\n1\r\n')
  })
})

describe('code labels (decision-codes.json)', () => {
  it('exact key, pattern, then fallback', () => {
    expect(codeLabel('decision.reason', 'upgrade', 'en').known).toBe(true)
    expect(codeLabel('assessor.outcome', 'unavailable:http-503', 'en').label).toMatch(/503/)
    const f = codeLabel('decision.reason', 'brand-new-code', 'zh-CN')
    expect(f.known).toBe(false)
    expect(f.label).toContain('brand-new-code')
  })
})

describe('diff', () => {
  it('marks added and removed lines and compacts context', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(d.map((x) => x.kind)).toEqual(['same', 'del', 'add', 'same'])
    expect(compact(lineDiff(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'X' : `l${i}`)).join('\n')), 1).filter((x) => x.text === '…')).toHaveLength(2)
  })
})

describe('navigation', () => {
  it('members get no admin items; admins get the grouped admin sections', () => {
    const t = ((k: string) => k) as never
    const flat = (items: ReturnType<typeof navItems>): string[] => items.flatMap((i) => ('href' in i ? [i.href] : 'items' in i ? flat(i.items as never) : []))
    expect(flat(navItems('member', t)).some((h) => h.startsWith('/admin'))).toBe(false)
    expect(flat(navItems('admin', t))).toEqual(expect.arrayContaining(['/admin/members', '/admin/policy', '/admin/audit', '/admin/health']))
  })
})

describe('signed-out-everywhere marker', () => {
  it('is read once', async () => {
    const { takeSignedOutEverywhere, SIGNED_OUT_EVERYWHERE_KEY } = await import('./auth/session.ts')
    sessionStorage.setItem(SIGNED_OUT_EVERYWHERE_KEY, '1')
    expect(takeSignedOutEverywhere()).toBe(true)
    expect(takeSignedOutEverywhere()).toBe(false)
  })
})
