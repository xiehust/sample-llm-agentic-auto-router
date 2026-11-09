// A fake Cognito managed-login IdP for local development and the Playwright smoke (127.0.0.1 only). It implements
// the subset the SPA uses: /oauth2/authorize (auth code + PKCE S256 only), /oauth2/token (authorization_code and
// refresh_token with rotation), /oauth2/revoke and /logout. The sign-in page lists mock accounts; there are no
// passwords because nothing here is reachable beyond loopback and no real identity exists.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JwtKey } from './jwt.ts'

export interface MockAccount { sub: string; username: string; name: string; email: string; groups: string[] }

export const MOCK_ACCOUNTS: readonly MockAccount[] = [
  { sub: 'u-admin', username: 'ada', name: 'Ada Admin', email: 'ada@example.com', groups: ['admin'] },
  { sub: 'u-mia', username: 'mia', name: 'Mia Member', email: 'mia@example.com', groups: ['member'] },
  { sub: 'u-noah', username: 'noah', name: 'Noah Member', email: 'noah@example.com', groups: ['member'] },
  { sub: 'u-nogroup', username: 'nogroup', name: 'No Group', email: 'nogroup@example.com', groups: [] },
]

export interface IdpOptions {
  issuer: string
  clientId: string
  scope: string
  /** Exact registered redirect URIs (callback and sign-out), as Cognito requires. */
  callbackUrls: string[]
  logoutUrls: string[]
  accessTtlS: number
  key: JwtKey
  now?: () => number
  /**
   * Dry runs of e2e/deployed.spec.ts: a username/password form like managed login (username, then password, two
   * steps) instead of the account list. Every mock account accepts this password.
   */
  formPassword?: string
}

interface PendingAuth { redirectUri: string; state: string; challenge: string; scope: string; nonce?: string; lang?: string }
interface IssuedCode extends PendingAuth { account: MockAccount; exp: number }

/** form-action covers the redirect after a form POST, so it must allow the app origins the sign-in returns to. */
const htmlFor = (formTargets: string) => (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTargets}`,
    'cache-control': 'no-store',
  })
  res.end(`<!doctype html><meta charset="utf-8"><title>Mock sign-in</title><body style="font:16px system-ui;margin:3rem">${body}</body>`)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) { n += (c as Buffer).length; if (n > 16_384) throw new Error('body too large'); chunks.push(c as Buffer) }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export function createIdp(o: IdpOptions) {
  const now = o.now ?? Date.now
  const pending = new Map<string, PendingAuth>()
  const codes = new Map<string, IssuedCode>()
  const refresh = new Map<string, { account: MockAccount; scope: string; validUntil: number; revoked: boolean }>()
  const origins = new Set(o.callbackUrls.map((u) => new URL(u).origin))
  const html = htmlFor([...origins].join(' '))
  const stats = { lastAuthorize: undefined as Record<string, string> | undefined, refreshes: 0, revokes: 0 }

  function tokens(account: MockAccount, scope: string, nonce?: string) {
    const iat = Math.floor(now() / 1000)
    const jti = randomUUID()
    const access = o.key.sign({
      sub: account.sub, 'cognito:groups': account.groups, iss: o.issuer, client_id: o.clientId, origin_jti: jti, jti,
      token_use: 'access', scope, auth_time: iat, iat, exp: iat + o.accessTtlS, username: account.username,
    })
    const id = o.key.sign({
      sub: account.sub, 'cognito:groups': account.groups, iss: o.issuer, aud: o.clientId, token_use: 'id', auth_time: iat, iat,
      exp: iat + o.accessTtlS, 'cognito:username': account.username, email: account.email, name: account.name, ...(nonce ? { nonce } : {}),
    })
    const rt = randomBytes(24).toString('base64url')
    refresh.set(rt, { account, scope, validUntil: now() + 8 * 3600_000, revoked: false })
    return { access_token: access, id_token: id, refresh_token: rt, token_type: 'Bearer', expires_in: o.accessTtlS }
  }

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    if (origin && origins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-methods', 'POST')
      res.setHeader('access-control-allow-headers', 'content-type')
    }
  }

  const json = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
    cors(req, res)
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', o.issuer)
    if (req.method === 'OPTIONS') { cors(req, res); res.writeHead(204); res.end(); return }

    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const q = url.searchParams
      stats.lastAuthorize = Object.fromEntries(q)
      const redirectUri = q.get('redirect_uri') ?? ''
      if (q.get('client_id') !== o.clientId || !o.callbackUrls.includes(redirectUri)) return html(res, 400, '<p>redirect_mismatch</p>')
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return html(res, 400, '<p>invalid_request: auth code with PKCE S256 required</p>')
      }
      const scope = q.get('scope') ?? ''
      if (!scope.split(' ').includes(o.scope)) return html(res, 400, '<p>invalid_scope</p>')
      const sid = randomBytes(12).toString('base64url')
      const p: PendingAuth = { redirectUri, state: q.get('state') ?? '', challenge: q.get('code_challenge') ?? '', scope }
      const nonce = q.get('nonce'); if (nonce) p.nonce = nonce
      const lang = q.get('lang'); if (lang) p.lang = lang
      pending.set(sid, p)
      const zh = lang === 'zh-CN'
      if (o.formPassword !== undefined) {
        return html(res, 200, `<h1>${zh ? '登录' : 'Sign in'}</h1><form method="post" action="/oauth2/form"><input type="hidden" name="sid" value="${sid}">`
          + `<label>${zh ? '用户名' : 'Username'} <input name="username" autocomplete="username"></label> <button type="submit">${zh ? '下一步' : 'Next'}</button></form>`)
      }
      const items = MOCK_ACCOUNTS.map((a) =>
        `<li><a href="/oauth2/approve?sid=${sid}&amp;user=${encodeURIComponent(a.username)}" data-user="${esc(a.username)}">${esc(a.name)}</a> (${esc(a.groups.join(', ') || (zh ? '无组' : 'no group'))})</li>`).join('')
      return html(res, 200, `<h1>${zh ? '模拟登录' : 'Mock sign-in'}</h1><p>${zh ? '本地测试身份提供方。选择一个账号：' : 'Local test identity provider. Choose an account:'}</p><ul>${items}</ul>`)
    }

    if (req.method === 'GET' && url.pathname === '/oauth2/approve') {
      const p = pending.get(url.searchParams.get('sid') ?? '')
      const account = MOCK_ACCOUNTS.find((a) => a.username === url.searchParams.get('user'))
      if (!p || !account) return html(res, 400, '<p>unknown sign-in request</p>')
      pending.delete(url.searchParams.get('sid') ?? '')
      const code = randomBytes(18).toString('base64url')
      codes.set(code, { ...p, account, exp: now() + 120_000 })
      const to = new URL(p.redirectUri)
      to.searchParams.set('code', code)
      to.searchParams.set('state', p.state)
      res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/form' && o.formPassword !== undefined) {
      let f: URLSearchParams
      try { f = await readForm(req) } catch { return html(res, 400, '<p>bad form</p>') }
      const sid = f.get('sid') ?? ''
      const p = pending.get(sid)
      const account = MOCK_ACCOUNTS.find((a) => a.username === f.get('username'))
      if (!p) return html(res, 400, '<p>unknown sign-in request</p>')
      if (!f.has('password')) {
        return html(res, 200, `<h1>${p.lang === 'zh-CN' ? '登录' : 'Sign in'}</h1><form method="post" action="/oauth2/form"><input type="hidden" name="sid" value="${sid}">`
          + `<input type="hidden" name="username" value="${esc(f.get('username') ?? '')}"><label>${p.lang === 'zh-CN' ? '密码' : 'Password'} <input type="password" name="password" autocomplete="current-password"></label>`
          + ` <button type="submit">${p.lang === 'zh-CN' ? '登录' : 'Sign in'}</button></form>`)
      }
      if (!account || f.get('password') !== o.formPassword) return html(res, 401, '<p>Incorrect username or password.</p>')
      pending.delete(sid)
      const code = randomBytes(18).toString('base64url')
      codes.set(code, { ...p, account, exp: now() + 120_000 })
      const to = new URL(p.redirectUri)
      to.searchParams.set('code', code)
      to.searchParams.set('state', p.state)
      res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      let f: URLSearchParams
      try { f = await readForm(req) } catch { return json(req, res, 400, { error: 'invalid_request' }) }
      if (f.get('client_id') !== o.clientId) return json(req, res, 400, { error: 'invalid_client' })
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') ?? '')
        codes.delete(f.get('code') ?? '')
        if (!c || c.exp < now() || c.redirectUri !== f.get('redirect_uri')) return json(req, res, 400, { error: 'invalid_grant' })
        const verifier = f.get('code_verifier') ?? ''
        if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json(req, res, 400, { error: 'invalid_grant' })
        return json(req, res, 200, tokens(c.account, c.scope, c.nonce))
      }
      if (f.get('grant_type') === 'refresh_token') {
        const rt = f.get('refresh_token') ?? ''
        const r = refresh.get(rt)
        if (!r || r.revoked || r.validUntil < now()) return json(req, res, 400, { error: 'invalid_grant' })
        r.revoked = true // rotation, no grace period
        stats.refreshes++
        const t = tokens(r.account, r.scope)
        const next = refresh.get(t.refresh_token)
        if (next) next.validUntil = r.validUntil // rotation keeps the original window
        return json(req, res, 200, t)
      }
      return json(req, res, 400, { error: 'unsupported_grant_type' })
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
      let f: URLSearchParams
      try { f = await readForm(req) } catch { return json(req, res, 400, { error: 'invalid_request' }) }
      const r = refresh.get(f.get('token') ?? '')
      if (r) r.revoked = true
      stats.revokes++
      cors(req, res); res.writeHead(200); res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/logout') {
      const to = url.searchParams.get('logout_uri') ?? ''
      if (url.searchParams.get('client_id') !== o.clientId || !o.logoutUrls.includes(to)) return html(res, 400, '<p>invalid logout_uri</p>')
      res.writeHead(302, { location: to, 'cache-control': 'no-store' })
      res.end()
      return
    }

    html(res, 404, '<p>not found</p>')
  }

  return { handle, stats, revokeAllFor: (sub: string) => { for (const r of refresh.values()) if (r.account.sub === sub) r.revoked = true } }
}
