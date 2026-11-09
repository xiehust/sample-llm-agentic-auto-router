// Page renders in jsdom against the in-process mock API (real contract responses), in English and Chinese, for a
// member and an admin. Also covers React 19 + Cloudscape under jsdom.

import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiClient } from '../api/client.ts'
import { ApiCtx, createQueryClient } from '../api/hooks.ts'
import { FlashRoot } from '../app/flash.tsx'
import { RequireRole } from '../app/RequireRole.tsx'
import { AuthRoot } from '../auth/AuthContext.tsx'
import type { AuthSession } from '../auth/session.ts'
import { I18nRoot, loadLocale } from '../i18n/I18n.tsx'
import type { Locale } from '../i18n/locale.ts'
import { createTranslator, loadMessages, type MessageKey } from '../i18n/messages.ts'
import { PrefsRoot } from '../prefs/prefs.tsx'
import GetStarted from './GetStarted.tsx'
import Overview from './Overview.tsx'
import Savings from './Savings.tsx'
import Usage from './Usage.tsx'
import Assessor from './admin/Assessor.tsx'
import DeploymentSettings from './admin/DeploymentSettings.tsx'
import Gateway from './admin/Gateway.tsx'
import Members from './admin/Members.tsx'
import Policy from './admin/Policy.tsx'
import Versions from './admin/Versions.tsx'

// The mocks run as child processes on loopback (their file lookups need a Node environment, not jsdom): the default
// one, one whose deploy defaults (config/baked.json) are unreadable, and one with a router task reporting other settings.
interface Mock { child?: ChildProcess; apiUrl: string; idpUrl: string }
const mocks: Record<'default' | 'unknown' | 'mismatch', Mock> = { default: { apiUrl: '', idpUrl: '' }, unknown: { apiUrl: '', idpUrl: '' }, mismatch: { apiUrl: '', idpUrl: '' } }
const APP = 'http://127.0.0.1:5998'
const CLIENT = 'console-mock-client'

function startMock(m: Mock, ports: [string, string], extra: Record<string, string>): Promise<void> {
  m.child = spawn(process.execPath, ['mock/server.ts'], {
    cwd: process.cwd(), // the package directory (vitest runs per package)
    env: { ...process.env, MOCK_API_PORT: ports[0], MOCK_IDP_PORT: ports[1], MOCK_APP_ORIGINS: APP, ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not start')), 45_000) // the shared host is often loaded
    m.child?.stdout?.on('data', (b: Buffer) => {
      const r = /mock console API (\S+), fake IdP (\S+)/.exec(b.toString())
      if (r) { m.apiUrl = r[1] as string; m.idpUrl = r[2] as string; clearTimeout(timer); resolve() }
    })
    m.child?.on('exit', (code) => reject(new Error(`mock exited ${code}`)))
  })
}

beforeAll(async () => {
  await Promise.all([
    startMock(mocks.default, ['4410', '4411'], {}),
    startMock(mocks.unknown, ['4412', '4413'], { MOCK_EFFECTIVE: 'unknown', MOCK_REPORTED_MISMATCH: '1' }),
    // Also one router task without signing keys (Require refused, reason task-without-keys).
    startMock(mocks.mismatch, ['4414', '4415'], { MOCK_REPORTED_MISMATCH: '1', MOCK_KEYS: 'task-without-keys' }),
  ])
}, 60_000)
afterAll(() => { for (const m of Object.values(mocks)) m.child?.kill('SIGTERM') })

/** Auth code + PKCE against the fake IdP, as the SPA does. */
async function signIn(user: string, idpUrl: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: `${APP}/auth/callback`, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'openid llmar/console' })
  const page = await (await fetch(`${idpUrl}/oauth2/authorize?${q}`)).text()
  const href = new RegExp(`href="(/oauth2/approve\\?[^"]+user=${user})"`).exec(page)?.[1]?.replace(/&amp;/g, '&')
  const loc = new URL((await fetch(idpUrl + href, { redirect: 'manual' })).headers.get('location') as string)
  const tok = await fetch(`${idpUrl}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code: loc.searchParams.get('code') as string, redirect_uri: `${APP}/auth/callback`, code_verifier: verifier }) })
  return ((await tok.json()) as { access_token: string }).access_token
}

const USERS: Record<string, string> = { 'u-mia': 'mia', 'u-admin': 'ada' }

async function fakeSession(sub: string, groups: string[], m: Mock): Promise<AuthSession> {
  const token = await signIn(USERS[sub] as string, m.idpUrl)
  return {
    cfg: { schemaVersion: 1, region: 'r', issuer: 'http://127.0.0.1', cognitoDomain: 'http://127.0.0.1', clientId: 'c', scopes: ['openid'], apiBase: '/api', tokenStorage: 'memory' },
    claims: { sub, groups, scope: [] },
    role: groups.includes('admin') ? 'admin' : 'member',
    isExpired: false,
    subscribe: () => () => {},
    getAccessToken: async () => token,
    signIn: async () => {},
    signOut: async () => {},
  } as unknown as AuthSession
}

interface Fail { path: RegExp; status: number; code: string }
async function renderPage(Page: ComponentType, opts: { locale: Locale; sub: string; groups: string[]; path?: string; admin?: boolean; mock?: keyof typeof mocks; fail?: Fail }) {
  const m = mocks[opts.mock ?? 'default']
  const session = await fakeSession(opts.sub, opts.groups, m)
  const fail = opts.fail
  const api = new ApiClient(session, {
    fetch: (p, init) => fail && fail.path.test(p)
      ? Promise.resolve(new Response(JSON.stringify({ error: { code: fail.code, message: 'test', requestId: 'req-test' } }), { status: fail.status, headers: { 'content-type': 'application/json' } }))
      : fetch(m.apiUrl + p, init),
  })
  const i18n = await loadLocale(opts.locale)
  const el = opts.admin ? <RequireRole role="admin"><Page /></RequireRole> : <Page />
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [opts.path ?? '/'] })
  render(
    <PrefsRoot><I18nRoot initial={i18n}><QueryClientProvider client={createQueryClient()}><AuthRoot session={session}><FlashRoot><ApiCtx.Provider value={api}>
      <RouterProvider router={router} />
    </ApiCtx.Provider></FlashRoot></AuthRoot></QueryClientProvider></I18nRoot></PrefsRoot>,
  )
}

const cases: Array<{ name: string; Page: ComponentType; title: MessageKey; member: boolean; probe?: MessageKey }> = [
  { name: 'Overview', Page: Overview, title: 'overview.title', member: true, probe: 'overview.kpi.cost' },
  { name: 'Usage', Page: Usage, title: 'usage.title', member: true, probe: 'usage.col.requests' },
  { name: 'Savings', Page: Savings, title: 'savings.title', member: true, probe: 'savings.caption.sameUsage' },
  { name: 'Get started', Page: GetStarted, title: 'getStarted.title', member: true, probe: 'getStarted.step4.button' },
  { name: 'Members', Page: Members, title: 'members.title', member: false, probe: 'members.col.email' },
  { name: 'Routing policy', Page: Policy, title: 'policy.title', member: false, probe: 'policy.pools' },
]

describe.each(['en', 'zh-CN'] as Locale[])('pages in %s', (locale) => {
  for (const c of cases) {
    it(`${c.name} renders with live mock data`, async () => {
      const t = createTranslator(locale, await loadMessages(locale))
      await renderPage(c.Page, c.member ? { locale, sub: 'u-mia', groups: ['member'] } : { locale, sub: 'u-admin', groups: ['admin'], admin: true })
      await waitFor(() => expect(screen.getAllByText(t(c.probe ?? c.title), { exact: false }).length).toBeGreaterThan(0), { timeout: 8000 })
      expect(screen.getAllByRole('heading', { level: 1 })[0]?.textContent).toContain(t(c.title))
      expect(screen.queryByTestId('state-error')).toBeNull()
    })
  }
})

describe('guards', () => {
  it('a member opening an admin page sees Forbidden', async () => {
    await renderPage(Members, { locale: 'en', sub: 'u-mia', groups: ['member'], admin: true })
    expect(await screen.findByTestId('state-forbidden')).toBeTruthy()
  })
})

const ADMIN = { sub: 'u-admin', groups: ['admin'], admin: true }

describe.each(['en', 'zh-CN'] as Locale[])('effective configuration in %s (0d-effective-config)', (locale) => {
  it('Routing policy: each setting shows "from config v#n"', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN })
    await screen.findByText(t('ext.effective.title'), {}, { timeout: 8000 })
    expect(screen.getAllByText(t('ext.source.document', { n: '2' })).length).toBeGreaterThanOrEqual(6)
    expect(screen.queryByText(t('ext.effective.unknown'))).toBeNull()
  })

  it('Routing policy: unknown settings; reports cannot be compared', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN, mock: 'unknown' })
    await screen.findByText(t('ext.effective.unknown'), {}, { timeout: 8000 })
    // Policy is in the hand-written document; identity and assessor are unknown (never shown as 'off').
    expect(screen.getAllByText(t('ext.source.document', { n: '1' })).length).toBeGreaterThan(0)
    expect(screen.getAllByText(t('common.unknown')).length).toBeGreaterThanOrEqual(4)
    expect(screen.getAllByText(t('ext.reported.matches.unknown')).length).toBe(2)
    expect(screen.queryByText(t('ext.reported.mismatch', { count: 1 }))).toBeNull()
  })

  it('Routing policy: a router task reporting other settings is a warning', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Policy, { locale, ...ADMIN, mock: 'mismatch' })
    await screen.findByText(t('ext.reported.mismatch', { count: 1 }), {}, { timeout: 8000 })
    expect(document.body.textContent).toContain(t('ext.reported.differs', { field: t('settings.identity'), reported: 'off', configured: 'observe' }))
    expect(document.body.textContent).toContain('router/4d5e6f')
    expect(screen.getAllByText(t('ext.reported.matches.no')).length).toBe(1)
  })

  it('Deployment settings: the identity mode is unknown, no radio selected', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(DeploymentSettings, { locale, ...ADMIN, mock: 'unknown' })
    await waitFor(() => expect(screen.getAllByText(t('common.unknown')).length).toBeGreaterThan(0), { timeout: 8000 })
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false)
  })

  it('Assessor: the mode is unknown, not off', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(Assessor, { locale, ...ADMIN, mock: 'unknown' })
    await screen.findByText(t('assessor.title'), {}, { timeout: 8000 })
    await waitFor(() => expect(screen.getAllByText(t('common.unknown')).length).toBeGreaterThan(0))
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false)
  })

  it('Get started highlights placeholders and says how to replace them', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(GetStarted, { locale, sub: 'u-mia', groups: ['member'] })
    await screen.findByText(t('getStarted.step4.button'), {}, { timeout: 8000 })
    // No repository URL is configured in tests: the install step shows the CLI URL as a missing deployment value.
    const marks = document.querySelectorAll('mark[data-testid="placeholder"]')
    expect([...marks].some((m) => m.textContent?.includes('raw URL'))).toBe(true)
    expect(screen.getAllByText(t('ext.code.replace.title')).length).toBeGreaterThan(0)
    expect(screen.getByText(t('ext.getStarted.faq.title'))).toBeTruthy()
  })

  it('Get started: an unknown identity mode has its own text (the policy, and so the mode, is known)', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(GetStarted, { locale, sub: 'u-mia', groups: ['member'], mock: 'unknown' })
    await screen.findByText(t('ext.getStarted.step4.unknown'), {}, { timeout: 8000 })
    expect(screen.queryByText(t('ext.getStarted.models.unknown'))).toBeNull()
  })
})

// A config read that fails keeps the page's heading and shows an inline error state (0c: phase-2 404; 73's 503).
const CONFIG_PAGES: Array<{ name: string; Page: ComponentType; title: MessageKey; path: RegExp }> = [
  { name: 'Routing policy', Page: Policy, title: 'policy.title', path: /^\/api\/admin\/config(\?|$)/ },
  { name: 'Assessor', Page: Assessor, title: 'assessor.title', path: /^\/api\/admin\/config(\?|$)/ },
  { name: 'Versions', Page: Versions, title: 'config.versions', path: /^\/api\/admin\/config\/versions(\?|$)/ },
  { name: 'Deployment settings', Page: DeploymentSettings, title: 'settings.tab.deployment', path: /^\/api\/admin\/config(\?|$)/ },
  { name: 'Gateway', Page: Gateway, title: 'gateway.title', path: /^\/api\/admin\/gateway(\?|$)/ },
]

describe.each(['en', 'zh-CN'] as Locale[])('config pages when the config cannot be read (%s)', (locale) => {
  for (const c of CONFIG_PAGES) {
    for (const f of [{ status: 404, code: 'not-found' }, { status: 503, code: c.name === 'Gateway' ? 'gateway-unavailable' : 'config-unavailable' }]) {
      it(`${c.name}: ${f.status} ${f.code} keeps the h1 and shows state-error`, async () => {
        const t = createTranslator(locale, await loadMessages(locale))
        await renderPage(c.Page, { locale, ...ADMIN, fail: { path: c.path, ...f } })
        await screen.findByTestId('state-error', {}, { timeout: 8000 })
        expect(screen.getAllByRole('heading', { level: 1 })[0]?.textContent).toContain(t(c.title))
        expect(screen.queryByTestId('state-not-found')).toBeNull()
        if (c.name !== 'Gateway') expect(screen.getByTestId('state-error').textContent).toContain(t('ext.state.configUnavailable'))
      }, 40_000) // the Gateway 503 retries twice (1 s + 2 s backoff); the host is often loaded
    }
  }
})

describe('Deployment settings: default monthly budget', () => {
  it('Save is disabled until the budget changes, and while the change is invalid', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    await renderPage(DeploymentSettings, { locale: 'en', ...ADMIN })
    const save = await screen.findByTestId('budget-save', {}, { timeout: 8000 })
    const amount = await screen.findByLabelText(t('budget.monthly'), {}, { timeout: 8000 })
    await waitFor(() => expect((amount as HTMLInputElement).value).toBe('200'), { timeout: 8000 })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(amount, { target: { value: '250' } })
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(amount, { target: { value: '0' } })
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true))
    fireEvent.change(amount, { target: { value: '200' } })
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true))
  }, 30_000)
})

describe.each(['en', 'zh-CN'] as Locale[])('Deployment settings: signing keys per router task (%s)', (locale) => {
  it('shows n of m tasks with keys, and the Require option says why it is refused', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    await renderPage(DeploymentSettings, { locale, ...ADMIN, mock: 'mismatch' })
    const keys = await screen.findByTestId('identity-keys', {}, { timeout: 8000 })
    expect(keys.textContent).toContain(t('ext.identityKeys.count', { withKeys: 1, total: 2 }))
    const why = t('ext.identityKeys.reason.taskWithoutKeys', { task: 'router/4d5e6f' })
    await waitFor(() => expect(document.body.textContent).toContain(why))
    const require = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'require') as HTMLInputElement
    fireEvent.click(require)
    expect((await screen.findByTestId('require-blocked')).textContent).toBe(`${t('settings.identity.requireBlocked')} ${why}`)
  }, 30_000)
})
