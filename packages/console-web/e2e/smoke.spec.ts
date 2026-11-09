// Smoke: sign-in through the fake IdP (PKCE S256), member vs admin navigation and guards, every page in en and
// zh-CN with no CSP violation or console error and no serious/critical axe finding, language and theme
// persistence, sign-out (revoke + /logout).

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const IDP = 'http://127.0.0.1:4311'

function watch(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`))
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP ${e.violatedDirective} blocked ${e.blockedURI}`))
  })
  return problems
}

async function signIn(page: Page, user: 'ada' | 'mia' | 'noah', path = '/') {
  await page.goto(path)
  await page.waitForURL(/127\.0\.0\.1:4311\/oauth2\/authorize/)
  const q = new URL(page.url()).searchParams
  expect(q.get('code_challenge_method')).toBe('S256')
  expect(q.get('code_challenge')).toBeTruthy()
  expect(q.get('state')).toBeTruthy()
  expect(q.get('response_type')).toBe('code')
  expect(q.get('scope')).toContain('llmar/console')
  expect(q.get('lang')).toMatch(/^(en|zh-CN)$/)
  await page.locator(`a[data-user="${user}"]`).click()
  await page.waitForURL((u) => u.origin === 'http://127.0.0.1:4173' && !u.pathname.startsWith('/auth/'))
  await expect(page.locator('h1').first()).toBeVisible()
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes[0]?.target.join(' ')}`)
}

const MEMBER_PAGES = ['/', '/usage', '/savings', '/decisions', '/get-started', '/settings']
const ADMIN_PAGES = [...MEMBER_PAGES, '/settings/deployment', '/admin/members', '/admin/clients', '/admin/policy', '/admin/config/versions', '/admin/assessor', '/admin/gateway', '/admin/health', '/admin/audit']

test('serves the strict security headers', async ({ request }) => {
  const r = await request.get('/')
  const csp = r.headers()['content-security-policy'] ?? ''
  for (const d of ["script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", `connect-src 'self' ${IDP}`]) expect(csp).toContain(d)
  expect(r.headers()['x-frame-options']).toBe('DENY')
  expect(r.headers()['referrer-policy']).toBe('no-referrer')
})

test('member: sign-in, own pages, admin routes forbidden without fetching admin data', async ({ page }) => {
  test.setTimeout(180_000) // loops every page with an axe scan; slow on a loaded machine
  const problems = watch(page)
  const adminCalls: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/admin/')) adminCalls.push(r.url()) })
  await signIn(page, 'mia')
  const nav = page.getByRole('navigation')
  await expect(nav.getByRole('link', { name: 'Members' })).toHaveCount(0)
  for (const p of MEMBER_PAGES) {
    await page.goto(p)
    await expect(page.locator('h1').first()).toBeVisible()
    await expect(page.getByTestId('state-error')).toHaveCount(0)
    expect(await axe(page), p).toEqual([])
  }
  await page.goto('/admin/members')
  await expect(page.getByTestId('state-forbidden')).toBeVisible()
  expect(adminCalls).toEqual([])
  expect(problems).toEqual([])
})

test('member: another caller\'s record is not found', async ({ page }) => {
  watch(page)
  await signIn(page, 'noah')
  await page.goto('/decisions/r-00001-doesnotexist')
  await expect(page.getByTestId('state-not-found')).toBeVisible()
})

test('admin: every page renders in English and Chinese without errors', async ({ page }) => {
  test.setTimeout(240_000) // 28 page loads with an axe scan each
  const problems = watch(page)
  await signIn(page, 'ada')
  for (const lang of ['en', 'zh-CN'] as const) {
    if (lang === 'zh-CN') {
      await page.goto('/settings')
      await page.getByRole('button', { name: '简体中文' }).click()
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    }
    for (const p of ADMIN_PAGES) {
      await page.goto(p)
      await expect(page.locator('h1').first()).toBeVisible()
      await expect(page.getByTestId('state-error')).toHaveCount(0)
      await expect(page.getByTestId('state-forbidden')).toHaveCount(0)
      expect(await axe(page), `${lang} ${p}`).toEqual([])
    }
  }
  expect(problems).toEqual([])
})

test('language and theme persist across reloads; Cloudscape strings follow', async ({ page }) => {
  watch(page)
  await signIn(page, 'mia', '/settings')
  await page.getByRole('button', { name: '简体中文' }).click()
  await page.getByRole('button', { name: '深色' }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.locator('body')).toHaveClass(/awsui-dark-mode/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置')
  await page.goto('/decisions')
  await expect(page.getByRole('navigation').getByRole('link', { name: '路由决策' })).toBeVisible()
})

test('decision detail and session timeline from the list', async ({ page }) => {
  const problems = watch(page)
  await signIn(page, 'ada', '/decisions?range=30d')
  await page.locator('table a[href^="/decisions/"]').first().click()
  await expect(page).toHaveURL(/\/decisions\/[^?]+\?ts=[^&]+&caller=/)
  await expect(page.getByRole('heading', { level: 2, name: 'Request' })).toBeVisible()
  await page.getByRole('button', { name: 'Open session timeline' }).click()
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f]+\?caller=/)
  await expect(page.locator('.llmar-dot').first()).toBeVisible()
  expect(problems).toEqual([])
})

test('sign-out revokes the refresh token and lands on the signed-out page', async ({ page }) => {
  watch(page)
  const revoked: string[] = []
  page.on('request', (r) => { if (r.url().startsWith(`${IDP}/oauth2/revoke`)) revoked.push(r.method()) })
  await signIn(page, 'mia')
  await page.getByRole('button', { name: /Mia Member/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.waitForURL(/\/signed-out$/)
  await expect(page.getByTestId('signed-out')).toBeVisible()
  expect(revoked).toEqual(['POST'])
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('llmar.oidc.user')))).toEqual([])
})

test('sign out everywhere: the signed-out page says the llmar CLI was signed out too, once', async ({ page }) => {
  watch(page)
  await signIn(page, 'noah', '/settings')
  await page.getByRole('button', { name: 'Sign out everywhere' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
  await page.waitForURL(/\/signed-out$/)
  await expect(page.getByTestId('signed-out-everywhere')).toContainText('llmar login')
  await page.reload()
  await expect(page.getByTestId('signed-out')).toBeVisible()
  await expect(page.getByTestId('signed-out-everywhere')).toHaveCount(0)
})

test('promotion: the admin sees the sign-in hint, and the promoted member gets a sign-in banner until re-sign-in', async ({ browser }) => {
  const adminCtx = await browser.newContext()
  const admin = await adminCtx.newPage()
  watch(admin)
  await signIn(admin, 'ada', '/admin/members')
  const changeRole = async (to: 'Admin' | 'Member') => {
    await admin.getByRole('button', { name: 'Details: mia@example.com' }).click()
    await expect(admin.getByRole('menuitem', { name: 'Change role' })).toBeVisible()
    await expect(admin.getByRole('menuitem', { name: /MFA/ })).toHaveCount(0) // the pool has MFA off (user decision)
    await admin.getByRole('menuitem', { name: 'Change role' }).click()
    const dialog = admin.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Role' }).click()
    await dialog.getByRole('option', { name: to }).click()
    await dialog.getByRole('button', { name: 'Confirm' }).click()
  }
  await changeRole('Admin')
  await expect(admin.getByText('Mia Member must sign in again before the admin rights apply.', { exact: false })).toBeVisible()

  const memberCtx = await browser.newContext()
  const mia = await memberCtx.newPage()
  watch(mia)
  await signIn(mia, 'mia')
  await expect(mia.getByTestId('admin-sign-in')).toContainText('You are now an admin. Sign in again to use the admin pages.')

  await changeRole('Member')
  await adminCtx.close()
  await memberCtx.close()
})
