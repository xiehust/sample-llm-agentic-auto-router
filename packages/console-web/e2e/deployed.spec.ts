// Checks the deployed console end to end in a browser (admin console C9 E2E; 0c runs it, no AWS API calls).
//
// Run (from packages/console-web):
//   pnpm exec playwright install chromium-headless-shell   # once per machine: Playwright 1.65 runs headless Chromium
//                                                           # from this separate download
//   pnpm e2e:deployed
//
// Env (required):
//   CONSOLE_URL                        https://<distribution> (http://127.0.0.1:<port> only for local dry runs)
//   CONSOLE_E2E_ADMIN_USER             admin username (17's E2E driver creates it)
//   CONSOLE_E2E_ADMIN_PASSWORD_FILE    file holding the admin password, mode 0600
//   CONSOLE_E2E_MEMBER_USER            member username
//   CONSOLE_E2E_MEMBER_PASSWORD_FILE   file holding the member password, mode 0600
// Env (optional):
//   CONSOLE_E2E_GATEWAY_URL            expected Get started gateway URL (else: must be an https URL)
//   CONSOLE_E2E_CLI_CLIENT_ID          expected cli app client id (else: must be non-empty)
//   CONSOLE_E2E_REDIRECT_PORTS         expected registered ports, e.g. 48951,48952,48953 (else: at least one)
//   CONSOLE_E2E_EXPECT_RECORDS         'admin' (default) | 'both' | 'none': who must see Decisions rows (after 17's c3)
//   CONSOLE_E2E_SHOTS                  screenshot directory (default e2e/deployed-shots, gitignored)
//   CONSOLE_E2E_API_URL                raw execute-api URL: the anonymous 401 checks also run against it
//   CONSOLE_E2E_COGNITO_DOMAIN         expected managed-login origin (else it must be https://<x>.auth.<region>.amazoncognito.com)
//   CONSOLE_E2E_REQUIRE_ISOLATION=1    the foreign-record/session 404 checks fail instead of skipping when no foreign
//                                      record exists (set it on the final run, ingest on, after 17's client phase)
//   CONSOLE_E2E_SIGN_OUT_EVERYWHERE=1  also run "Sign out everywhere" as the member (revokes the member's llmar CLI
//                                      sign-in too, so run it last)
//
// Passwords are read from files only, never from env, and are never printed. A typing failure is re-thrown without
// Playwright's message (which could quote the value), and the config keeps traces, videos and failure screenshots off.
// Never run with DEBUG=pw:api (Playwright then logs fill() values); the spec refuses to start if it is set.
// Access and refresh tokens are read into memory only to call the API and to prove revocation; never printed.

import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CONSOLE_URL = (process.env.CONSOLE_URL ?? '').trim().replace(/\/$/, '')
const ORIGIN = (() => { try { return new URL(CONSOLE_URL).origin } catch { return '' } })()
const SHOTS = process.env.CONSOLE_E2E_SHOTS ?? join(process.cwd(), 'e2e', 'deployed-shots')
const EXPECT_RECORDS = (process.env.CONSOLE_E2E_EXPECT_RECORDS ?? 'admin') as 'admin' | 'both' | 'none'

interface Account { user: string; password: string }

function account(kind: 'ADMIN' | 'MEMBER'): Account {
  const user = process.env[`CONSOLE_E2E_${kind}_USER`]
  const file = process.env[`CONSOLE_E2E_${kind}_PASSWORD_FILE`]
  if (!user || !file) throw new Error(`set CONSOLE_E2E_${kind}_USER and CONSOLE_E2E_${kind}_PASSWORD_FILE`)
  const st = statSync(file)
  if ((st.mode & 0o077) !== 0) throw new Error(`${kind.toLowerCase()} password file must be mode 0600 (group/other have access)`)
  const password = readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  if (!password) throw new Error(`${kind.toLowerCase()} password file is empty`)
  return { user, password }
}

/** Isolation checks that skipped for lack of data (printed once at the end; fatal with REQUIRE_ISOLATION). */
const skippedIsolation: string[] = []
const REQUIRE_ISOLATION = process.env.CONSOLE_E2E_REQUIRE_ISOLATION === '1'

/** Records of callers other than the test member, captured in the admin test (the describe is serial). */
let foreign: Array<{ reqId: string; ts: string; session?: string; caller: string }> = []

test.beforeAll(() => {
  if (/pw:api|pw:\*|^\*$/.test(process.env.DEBUG ?? '')) throw new Error('unset DEBUG: with pw:api Playwright logs typed values')
  if (!CONSOLE_URL || !ORIGIN) throw new Error('set CONSOLE_URL to the console origin, e.g. https://d111111abcdef8.cloudfront.net')
  const u = new URL(CONSOLE_URL)
  if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1') throw new Error('CONSOLE_URL must be https (http only for 127.0.0.1 dry runs)')
  mkdirSync(SHOTS, { recursive: true })
})

/** Console errors and CSP violations on the console origin, and console API answers >= 400. */
function watch(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const at = m.location().url
    if (at && !at.startsWith(ORIGIN)) return // managed login's own pages
    if (/^Failed to load resource/.test(m.text())) return // counted from responses below, with the URL
    problems.push(`console: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`))
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (u.origin === ORIGIN && u.pathname.startsWith('/api/') && r.status() >= 400) problems.push(`api ${r.request().method()} ${u.pathname} -> ${r.status()}`)
  })
  void page.addInitScript((origin: string) => {
    document.addEventListener('securitypolicyviolation', (e) => {
      if (location.origin === origin) console.error(`CSP ${e.violatedDirective} blocked ${e.blockedURI}`)
    })
  }, ORIGIN)
  return problems
}

/** Types into a field without letting Playwright's error text carry the value. */
async function typeSecret(page: Page, selector: string, value: string, what: string) {
  try {
    await page.locator(selector).first().fill(value, { timeout: 20_000 })
  } catch {
    throw new Error(`could not enter the ${what} on the sign-in page (${new URL(page.url()).pathname})`)
  }
}

const USERNAME = 'input[name="username"], input[autocomplete="username"], input[type="email"]'
const PASSWORD = 'input[type="password"]'

/**
 * SPA → Cognito managed login (v2) → back. Managed login may ask for the username and the password on one page or
 * in two steps; both work. Anything else (new password required, an error) fails with the page's heading.
 */
async function signIn(page: Page, a: Account, path = '/', lang: 'en' | 'zh-CN' = 'en') {
  await page.goto(path)
  await page.waitForURL((u) => u.origin !== ORIGIN, { timeout: 30_000 })
  const q = new URL(page.url()).searchParams
  expect(q.get('response_type')).toBe('code')
  expect(q.get('code_challenge_method')).toBe('S256')
  expect(q.get('code_challenge')).toBeTruthy()
  expect(q.get('state')).toBeTruthy()
  expect(q.get('lang')).toBe(lang)
  await page.locator(USERNAME).first().waitFor({ timeout: 30_000 })
  if (lang === 'zh-CN') expect(await page.locator('body').innerText(), 'managed login is in Chinese').toMatch(/[一-鿿]/)
  await typeSecret(page, USERNAME, a.user, 'username')
  if (!(await page.locator(PASSWORD).first().isVisible())) {
    await page.locator('button[type="submit"], input[type="submit"]').first().click()
    await page.locator(PASSWORD).first().waitFor({ timeout: 20_000 })
  }
  await typeSecret(page, PASSWORD, a.password, 'password')
  await page.locator('button[type="submit"], input[type="submit"]').first().click()
  try {
    await page.waitForURL((u) => u.origin === ORIGIN && !u.pathname.startsWith('/auth/'), { timeout: 45_000 })
  } catch {
    const heading = (await page.locator('h1, h2').first().textContent().catch(() => null))?.trim().slice(0, 120)
    throw new Error(`sign-in did not return to the console (still at ${new URL(page.url()).origin}${new URL(page.url()).pathname}; page says: ${heading ?? '?'})`)
  }
  await expect(page.locator('h1').first()).toBeVisible()
}

async function newSession(browser: Browser, lang: 'en' | 'zh-CN'): Promise<{ ctx: BrowserContext; page: Page; problems: string[] }> {
  const ctx = await browser.newContext({ locale: lang, baseURL: CONSOLE_URL })
  const page = await ctx.newPage()
  return { ctx, page, problems: watch(page) }
}

const MEMBER_PAGES = ['/', '/usage', '/savings', '/decisions', '/get-started', '/settings']
const ADMIN_ONLY = ['/settings/deployment', '/admin/members', '/admin/clients', '/admin/policy', '/admin/config/versions', '/admin/assessor', '/admin/gateway', '/admin/health', '/admin/audit']
const ADMIN_PAGES = [...MEMBER_PAGES, ...ADMIN_ONLY]
const SHOT_PAGES: Array<[string, string]> = [['overview', '/'], ['decisions', '/decisions'], ['savings', '/savings'], ['policy', '/admin/policy']]

/**
 * Screenshots go into the docs: mask the top-nav user menu (the signed-in user's name) and every caller name
 * (data-pii, components/values.tsx). The user menu must exist, so a changed shell fails instead of leaking.
 */
async function shoot(page: Page, file: string, userLabel: string) {
  await expect(page.getByTestId('state-loading')).toHaveCount(0, { timeout: 30_000 })
  const userMenu = page.locator('#top-nav').getByRole('button', { name: userLabel, exact: true })
  await expect(userMenu, 'top-nav user menu found for masking').toHaveCount(1)
  await page.screenshot({ path: join(SHOTS, file), fullPage: true, mask: [userMenu, page.locator('[data-pii]')], maskColor: '#5f6b7a' })
}

/** The user menu's label: profile name, else username (Layout.tsx). */
async function userLabel(page: Page): Promise<string> {
  const p = (await (await page.request.get(`${CONSOLE_URL}/api/me/profile`, { headers: { authorization: `Bearer ${await accessToken(page)}` } })).json()) as { name?: string; username: string }
  return p.name ?? p.username
}

async function visitAll(page: Page, paths: string[]) {
  for (const p of paths) {
    await page.goto(p)
    await expect(page.locator('h1').first(), p).toBeVisible()
    await expect(page.getByTestId('state-loading'), `${p} finished loading`).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('state-forbidden'), p).toHaveCount(0)
    await expect.soft(page.getByTestId('state-error'), `${p} shows no error state`).toHaveCount(0)
  }
}

test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  console.log(`isolation checks skipped: ${skippedIsolation.length ? skippedIsolation.join('; ') : 'none'}`)
})

/** The access token of the signed-in user (oidc-client-ts user in sessionStorage), into memory only. */
async function accessToken(page: Page): Promise<string> {
  const t = await page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? ''
      if (!k.startsWith('llmar.oidc.user:')) continue
      try { return (JSON.parse(sessionStorage.getItem(k) ?? '{}') as { access_token?: string }).access_token } catch { return undefined }
    }
    return undefined
  })
  if (!t) throw new Error('no access token in sessionStorage (tokenStorage memory?): the API isolation checks need tokenStorage session')
  return t
}

const errorCode = async (r: { json(): Promise<unknown> }) => {
  try { return ((await r.json()) as { error?: { code?: string } }).error?.code } catch { return undefined }
}

/** Counts (never values) of stored tokens: JWTs, or access/id/refresh token fields, in session- and localStorage. */
async function storedTokens(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const v = store.getItem(store.key(i) ?? '') ?? ''
        if (/"(access_token|id_token|refresh_token)"\s*:\s*"[^"]+"/.test(v) || /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/.test(v)) n++
      }
    }
    return n
  })
}

test('admin, English: managed login, admin navigation, every page clean, screenshots', async ({ browser }) => {
  const { ctx, page, problems } = await newSession(browser, 'en')
  await signIn(page, account('ADMIN'), '/', 'en')
  // Records of every caller (admin.records), for the member's 404 checks later.
  const token = await accessToken(page)
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const to = new Date(Date.now() + 60_000).toISOString()
  const recs = await ctx.request.get(`${CONSOLE_URL}/api/admin/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`, { headers: { authorization: `Bearer ${token}` }, failOnStatusCode: false })
  expect(recs.status(), 'GET /api/admin/records as admin').toBe(200)
  foreign = ((await recs.json()) as { items: Array<{ reqId: string; ts: string; session?: string; caller?: { key: string } }> }).items
    .map((r) => ({ reqId: r.reqId, ts: r.ts, caller: r.caller?.key ?? 'none', ...(r.session ? { session: r.session } : {}) }))
  const nav = page.getByRole('navigation')
  for (const label of ['Members', 'Routing policy', 'Audit log']) await expect(nav.getByRole('link', { name: label })).toBeVisible()
  await visitAll(page, ADMIN_PAGES)
  const label = await userLabel(page)
  for (const [name, path] of SHOT_PAGES) {
    await page.goto(path)
    await shoot(page, `${name}.en.png`, label)
  }
  expect(problems).toEqual([])
  await ctx.close()
})

test('admin, Chinese: managed login in zh-CN, every page clean, screenshots', async ({ browser }) => {
  const { ctx, page, problems } = await newSession(browser, 'zh-CN')
  await signIn(page, account('ADMIN'), '/', 'zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('navigation').getByRole('link', { name: '成员' })).toBeVisible()
  await visitAll(page, ADMIN_PAGES)
  const label = await userLabel(page)
  for (const [name, path] of SHOT_PAGES) {
    await page.goto(path)
    await shoot(page, `${name}.zh-CN.png`, label)
  }
  expect(problems).toEqual([])
  await ctx.close()
})

test('member: own pages only; admin deep links are Forbidden with no /api/admin calls', async ({ browser }) => {
  const { ctx, page, problems } = await newSession(browser, 'en')
  const adminCalls: string[] = []
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin === ORIGIN && u.pathname.startsWith('/api/admin/')) adminCalls.push(u.pathname) })
  await signIn(page, account('MEMBER'), '/', 'en')
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Members' })).toHaveCount(0)
  await visitAll(page, MEMBER_PAGES)
  for (const p of ADMIN_ONLY) {
    await page.goto(p)
    await expect(page.getByTestId('state-forbidden'), p).toBeVisible()
  }
  expect(adminCalls).toEqual([])
  expect(problems).toEqual([])
  await ctx.close()
})

test('member API isolation: admin routes 403 forbidden, caller filter 400', async ({ browser }) => {
  const { ctx, page } = await newSession(browser, 'en')
  await signIn(page, account('MEMBER'), '/', 'en')
  const auth = { authorization: `Bearer ${await accessToken(page)}` }
  // admin.members.list, admin.config.activate (ROUTES access 'admin'): the API's group check, not the SPA guard.
  const members = await ctx.request.get(`${CONSOLE_URL}/api/admin/members`, { headers: auth, failOnStatusCode: false })
  expect(members.status(), 'GET /api/admin/members as member').toBe(403)
  expect(await errorCode(members)).toBe('forbidden')
  const activate = await ctx.request.post(`${CONSOLE_URL}/api/admin/config/activate`, { headers: { ...auth, 'content-type': 'application/json' }, data: {}, failOnStatusCode: false })
  expect(activate.status(), 'POST /api/admin/config/activate as member').toBe(403)
  expect(await errorCode(activate)).toBe('forbidden')
  // me.usage: the caller dimension is admin only (400 bad-request), with an otherwise valid query.
  const day = new Date().toISOString().slice(0, 10)
  const other = foreign[0]?.caller ?? 'user:00000000-0000-0000-0000-000000000000'
  const usage = await ctx.request.get(`${CONSOLE_URL}/api/me/usage?from=${day}&to=${day}&caller=${encodeURIComponent(other)}`, { headers: auth, failOnStatusCode: false })
  expect(usage.status(), 'GET /api/me/usage?caller=<another> as member').toBe(400)
  expect(await errorCode(usage)).toBe('bad-request')
  await ctx.close()
})

test("member API isolation: another caller's record and session answer 404", async ({ browser }) => {
  const { ctx, page } = await newSession(browser, 'en')
  await signIn(page, account('MEMBER'), '/', 'en')
  const auth = { authorization: `Bearer ${await accessToken(page)}` }
  const me = (await (await ctx.request.get(`${CONSOLE_URL}/api/me/profile`, { headers: auth })).json()) as { principal: string }
  const rec = foreign.find((r) => r.caller !== me.principal)
  const sess = foreign.find((r) => r.caller !== me.principal && r.session)
  const missing = [!rec && 'foreign record 404', !sess && 'foreign session 404'].filter((x): x is string => !!x)
  if (missing.length) {
    const reason = `no record of another caller in the last 7 days (ingest off, or only this member's traffic): ${missing.join(', ')} not checked`
    if (REQUIRE_ISOLATION) throw new Error(`CONSOLE_E2E_REQUIRE_ISOLATION=1: ${reason}`)
    skippedIsolation.push(...missing)
    console.log(`SKIPPED (isolation): ${reason}`)
    test.skip(true, reason)
  }
  // me.record (with and without the ts hint) and me.session: another principal's ids are 404, never 403.
  for (const path of [`/api/me/records/${encodeURIComponent(rec!.reqId)}`, `/api/me/records/${encodeURIComponent(rec!.reqId)}?ts=${encodeURIComponent(rec!.ts)}`, `/api/me/sessions/${encodeURIComponent(sess!.session!)}`]) {
    const r = await ctx.request.get(`${CONSOLE_URL}${path}`, { headers: auth, failOnStatusCode: false })
    expect(r.status(), `GET ${path.split('?')[0]?.replace(/[^/]+$/, '<id>')} as member`).toBe(404)
    expect(await errorCode(r)).toBe('not-found')
  }
  await ctx.close()
})

test('anonymous calls get 401 through CloudFront and the raw API URL', async ({ playwright }) => {
  const api = process.env.CONSOLE_E2E_API_URL?.replace(/\/$/, '')
  if (api) {
    const u = new URL(api)
    if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1') throw new Error('CONSOLE_E2E_API_URL must be https (http only for 127.0.0.1 dry runs)')
  }
  const anon = await playwright.request.newContext()
  for (const base of [CONSOLE_URL, ...(api ? [api] : [])]) {
    for (const path of ['/api/me/profile', '/api/admin/members']) {
      const r = await anon.get(`${base}${path}`, { failOnStatusCode: false })
      expect(r.status(), `anonymous GET ${path} via ${base === CONSOLE_URL ? 'CloudFront' : 'execute-api'}`).toBe(401)
    }
  }
  if (!api) test.info().annotations.push({ type: 'note', description: 'CONSOLE_E2E_API_URL unset: execute-api 401 not checked' })
  await anon.dispose()
})

test("Get started shows this deployment's gateway URL, cli client and redirect ports", async ({ browser }) => {
  const { ctx, page, problems } = await newSession(browser, 'en')
  await signIn(page, account('MEMBER'), '/', 'en')
  const setupResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me/setup' && r.status() === 200)
  await page.goto('/get-started')
  const setup = (await (await setupResponse).json()) as { gatewayUrl?: string; clientId?: string; redirectPorts?: number[]; configureJson?: { redirectPorts?: number[]; clientId?: string } }
  const wantGateway = process.env.CONSOLE_E2E_GATEWAY_URL
  const wantClient = process.env.CONSOLE_E2E_CLI_CLIENT_ID
  const wantPorts = process.env.CONSOLE_E2E_REDIRECT_PORTS?.split(',').map((p) => Number(p.trim())).filter(Boolean)
  expect(setup.gatewayUrl, 'gatewayUrl').toMatch(/^https:\/\//)
  if (wantGateway) expect(setup.gatewayUrl).toBe(wantGateway.replace(/\/$/, ''))
  expect(setup.clientId, 'cli client id').toBeTruthy()
  if (wantClient) expect(setup.clientId).toBe(wantClient)
  expect(setup.redirectPorts?.length, 'redirect ports').toBeGreaterThan(0)
  if (wantPorts?.length) expect(setup.redirectPorts).toEqual(wantPorts)
  expect(setup.configureJson?.redirectPorts).toEqual(setup.redirectPorts)
  // …and the page shows them: the values panel and the `llmar configure` snippet.
  const main = page.locator('main')
  await expect(main.getByText(setup.gatewayUrl as string, { exact: true }).first()).toBeVisible()
  await expect(main.getByText(setup.clientId as string, { exact: true }).first()).toBeVisible()
  const configure = await page.locator('pre[aria-label="2. Configure it for this deployment"]').innerText()
  for (const port of setup.redirectPorts ?? []) expect(configure).toContain(String(port))
  await expect(page.locator('pre').filter({ hasText: '<inference URL>' })).toHaveCount(0)
  expect(problems).toEqual([])
  await ctx.close()
})

test('Decisions lists records after the client phase', async ({ browser }) => {
  test.skip(EXPECT_RECORDS === 'none', 'CONSOLE_E2E_EXPECT_RECORDS=none')
  const who: Array<'ADMIN' | 'MEMBER'> = EXPECT_RECORDS === 'both' ? ['ADMIN', 'MEMBER'] : ['ADMIN']
  for (const kind of who) {
    const { ctx, page, problems } = await newSession(browser, 'en')
    await signIn(page, account(kind), '/decisions', 'en')
    await expect(page.getByTestId('state-empty'), `${kind.toLowerCase()} sees records`).toHaveCount(0)
    await expect(page.locator('table a[href^="/decisions/"]').first(), `${kind.toLowerCase()} sees a decision row`).toBeVisible()
    await page.locator('table a[href^="/decisions/"]').first().click()
    await expect(page.getByRole('heading', { level: 2, name: 'Request' })).toBeVisible()
    expect(problems).toEqual([])
    await ctx.close()
  }
})

test('language switch persists across reloads', async ({ browser }) => {
  const { ctx, page, problems } = await newSession(browser, 'en')
  await signIn(page, account('MEMBER'), '/settings', 'en')
  await page.getByRole('button', { name: '简体中文' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置')
  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(problems).toEqual([])
  await ctx.close()
})

/** The oidc-client-ts user in sessionStorage (tokenStorage 'session'); undefined in memory mode. */
async function refreshToken(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? ''
      if (!k.startsWith('llmar.oidc.user:')) continue
      try { return (JSON.parse(sessionStorage.getItem(k) ?? '{}') as { refresh_token?: string }).refresh_token } catch { return undefined }
    }
    return undefined
  })
}

/** The refresh token only ever goes to the deployment's managed-login domain (pinned before sending). */
function pinnedCognito(domain: string): string {
  const want = process.env.CONSOLE_E2E_COGNITO_DOMAIN?.replace(/\/$/, '')
  let u: URL
  try { u = new URL(domain) } catch { throw new Error('config.json cognitoDomain is not a URL: not sending the refresh token') }
  if (want) {
    if (u.origin !== new URL(want).origin) throw new Error('config.json cognitoDomain differs from CONSOLE_E2E_COGNITO_DOMAIN: not sending the refresh token')
    return u.origin
  }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(u.hostname)) {
    throw new Error('config.json cognitoDomain is not https://<x>.auth.<region>.amazoncognito.com (set CONSOLE_E2E_COGNITO_DOMAIN for a custom domain): not sending the refresh token')
  }
  return u.origin
}

async function refreshWorks(request: APIRequestContext, cognitoDomain: string, clientId: string, token: string): Promise<number> {
  const r = await request.post(`${pinnedCognito(cognitoDomain)}/oauth2/token`, { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: token }, failOnStatusCode: false })
  return r.status()
}

test('sign-out revokes the refresh token and clears the session', async ({ browser, request }) => {
  const { ctx, page, problems } = await newSession(browser, 'en')
  const cfg = (await (await request.get(`${CONSOLE_URL}/config.json`)).json()) as { cognitoDomain: string; clientId: string }
  const profileResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me/profile' && r.status() === 200)
  await signIn(page, account('MEMBER'), '/', 'en')
  const profile = (await (await profileResponse).json()) as { name?: string; username: string }
  const token = await refreshToken(page)
  const revokes: number[] = []
  page.on('response', (r) => { if (r.url().startsWith(`${cfg.cognitoDomain}/oauth2/revoke`)) revokes.push(r.status()) })
  await page.locator('#top-nav').getByRole('button', { name: profile.name ?? profile.username }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.waitForURL((u) => u.origin === ORIGIN && u.pathname === '/signed-out', { timeout: 45_000 })
  await expect(page.getByTestId('signed-out')).toBeVisible()
  expect(revokes, 'POST /oauth2/revoke answered 200').toEqual([200])
  expect(await refreshToken(page), 'no tokens left in sessionStorage').toBeUndefined()
  expect(await storedTokens(page), 'no access, ID or refresh token in session- or localStorage').toBe(0)
  if (token) expect(await refreshWorks(request, cfg.cognitoDomain, cfg.clientId, token), 'the old refresh token no longer works').toBe(400)
  else test.info().annotations.push({ type: 'note', description: 'tokenStorage memory: refresh-token replay not checked' })
  expect(problems).toEqual([])
  await ctx.close()
})

test('sign out everywhere (opt-in): signed-out page, no stored tokens, the old refresh token is dead', async ({ browser, request }) => {
  test.skip(process.env.CONSOLE_E2E_SIGN_OUT_EVERYWHERE !== '1', "CONSOLE_E2E_SIGN_OUT_EVERYWHERE unset (it also revokes the member's llmar CLI sign-in)")
  const { ctx, page, problems } = await newSession(browser, 'en')
  const cfg = (await (await request.get(`${CONSOLE_URL}/config.json`)).json()) as { cognitoDomain: string; clientId: string }
  await signIn(page, account('MEMBER'), '/settings', 'en')
  const token = await refreshToken(page)
  await page.getByRole('button', { name: 'Sign out everywhere' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
  await page.waitForURL((u) => u.origin === ORIGIN && u.pathname === '/signed-out', { timeout: 45_000 })
  await expect(page.getByTestId('signed-out-everywhere')).toBeVisible()
  expect(await storedTokens(page), 'no access, ID or refresh token in session- or localStorage').toBe(0)
  if (token) expect(await refreshWorks(request, cfg.cognitoDomain, cfg.clientId, token), 'the old refresh token no longer works').toBe(400)
  expect(problems).toEqual([])
  await ctx.close()
})
