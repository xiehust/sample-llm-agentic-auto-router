// Local mock stack for development and the Playwright smoke: the console API on 127.0.0.1:4310 (also serving
// /config.json) and a fake Cognito IdP on 127.0.0.1:4311. Loopback only; nothing here talks to AWS.
//
//   pnpm --filter @auto-router/console-web mock          # then `CONSOLE_MOCK=1 pnpm dev` (or `pnpm dev:mock`)
//
// Env: MOCK_API_PORT, MOCK_IDP_PORT, MOCK_APP_ORIGINS (comma list of SPA origins allowed as redirect targets),
// MOCK_TOKEN_TTL (access token seconds, default 900), MOCK_LATENCY_MS, MOCK_TOKEN_STORAGE (session | memory).

import { createServer, type Server } from 'node:http'
import { createApi } from './api.ts'
import type { IdentityKeysReason } from '@auto-router/console-contract'
import { buildDb, KEY_STATES, PREFIX } from './data.ts'
import { createIdp } from './idp.ts'
import { JwtKey } from './jwt.ts'

export const HOST = '127.0.0.1'
export const MOCK_CLIENT_ID = 'console-mock-client'

export interface MockStack {
  api: Server; idp: Server; apiUrl: string; idpUrl: string; close(): Promise<void>
  /** Tests only: an access token with these claim overrides, signed by this process's key. */
  mint(overrides: Record<string, unknown>): string
}

export interface MockOptions {
  apiPort?: number; idpPort?: number; appOrigins?: string[]; tokenTtlS?: number; latencyMs?: number; tokenStorage?: 'session' | 'memory'
  /** Next identity publish fails (502 identity-delivery-failed). */
  failIdentityDeliveryOnce?: boolean
  /** The router has not reported its signing keys (Require refused): same as identityKeys 'task-without-keys'. */
  identityKeysUnloaded?: boolean
  /** Signing-key evidence: why Require is refused (73's IdentityKeysReason); default all tasks loaded. */
  identityKeys?: IdentityKeysReason
  /** Username/password sign-in form (dry runs of e2e/deployed.spec.ts). */
  formPassword?: string
  /** Effective-config demo: console versions (default), baked only, or a partial document with baked.json unreadable. */
  effective?: 'document' | 'baked' | 'unknown'
  /** One router task reports an older policy and identity mode (mismatch warning). */
  reportedMismatch?: boolean
  /** GET /api/admin/config and the versions list fail: 404 (phase-2 API, no active doc) or 503 config-unavailable. */
  configFailure?: 404 | 503
}

export async function startMock(opts: MockOptions = {}): Promise<MockStack> {
  const key = new JwtKey()
  const idpPort = opts.idpPort ?? 4311
  const issuer = `http://${HOST}:${idpPort}`
  const appOrigins = opts.appOrigins ?? ['http://127.0.0.1:5173', 'http://127.0.0.1:4173']
  const scope = `${PREFIX}/console`
  const idp = createIdp({
    issuer, clientId: MOCK_CLIENT_ID, scope, key, accessTtlS: opts.tokenTtlS ?? 900, ...(opts.formPassword !== undefined ? { formPassword: opts.formPassword } : {}),
    callbackUrls: appOrigins.map((o) => `${o}/auth/callback`), logoutUrls: appOrigins.map((o) => `${o}/signed-out`),
  })
  const db = buildDb(Date.now(), opts.effective ?? 'document')
  if (opts.reportedMismatch) db.reportedMismatch = true
  if (opts.configFailure) db.configFailure = opts.configFailure
  const keys = opts.identityKeys ?? (opts.identityKeysUnloaded ? 'task-without-keys' : undefined)
  if (keys) db.identityKeys = KEY_STATES[keys]
  const api = createApi({
    db, key, issuer, clientId: MOCK_CLIENT_ID, scope, idp, latencyMs: opts.latencyMs ?? 0, failIdentityDeliveryOnce: opts.failIdentityDeliveryOnce === true,
    runtimeConfig: { schemaVersion: 1, region: 'ap-southeast-1', issuer, cognitoDomain: issuer, clientId: MOCK_CLIENT_ID, scopes: ['openid', scope], apiBase: '/api', tokenStorage: opts.tokenStorage ?? 'session' },
  })
  const listen = (s: Server, port: number) => new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, HOST, () => resolve()) })
  const idpServer = createServer((req, res) => { void idp.handle(req, res).catch(() => { res.writeHead(500); res.end() }) })
  const apiServer = createServer((req, res) => { void api.handle(req, res).catch(() => { res.writeHead(500); res.end() }) })
  await listen(idpServer, idpPort)
  await listen(apiServer, opts.apiPort ?? 4310)
  const port = (s: Server) => (s.address() as { port: number }).port
  return {
    api: apiServer, idp: idpServer, apiUrl: `http://${HOST}:${port(apiServer)}`, idpUrl: `http://${HOST}:${port(idpServer)}`,
    mint: (overrides) => {
      const iat = Math.floor(Date.now() / 1000)
      return key.sign({ sub: 'u-admin', 'cognito:groups': ['admin'], iss: issuer, client_id: MOCK_CLIENT_ID, token_use: 'access', scope: `openid ${scope}`, iat, exp: iat + 300, ...overrides })
    },
    close: () => Promise.all([apiServer, idpServer].map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env
  const stack = await startMock({
    apiPort: Number(env.MOCK_API_PORT ?? 4310), idpPort: Number(env.MOCK_IDP_PORT ?? 4311),
    ...(env.MOCK_APP_ORIGINS ? { appOrigins: env.MOCK_APP_ORIGINS.split(',') } : {}),
    ...(env.MOCK_TOKEN_TTL ? { tokenTtlS: Number(env.MOCK_TOKEN_TTL) } : {}),
    ...(env.MOCK_LATENCY_MS ? { latencyMs: Number(env.MOCK_LATENCY_MS) } : {}),
    ...(env.MOCK_TOKEN_STORAGE === 'memory' ? { tokenStorage: 'memory' as const } : {}),
    failIdentityDeliveryOnce: env.MOCK_FAIL_IDENTITY_DELIVERY === '1',
    identityKeysUnloaded: env.MOCK_KEYS_UNLOADED === '1',
    ...(env.MOCK_KEYS && env.MOCK_KEYS in KEY_STATES && env.MOCK_KEYS !== 'loaded' ? { identityKeys: env.MOCK_KEYS as IdentityKeysReason } : {}),
    ...(env.MOCK_EFFECTIVE === 'baked' || env.MOCK_EFFECTIVE === 'unknown' ? { effective: env.MOCK_EFFECTIVE } : {}),
    reportedMismatch: env.MOCK_REPORTED_MISMATCH === '1',
    ...(env.MOCK_CONFIG_FAILURE === '404' || env.MOCK_CONFIG_FAILURE === '503' ? { configFailure: Number(env.MOCK_CONFIG_FAILURE) as 404 | 503 } : {}),
    ...(env.MOCK_FORM_PASSWORD_FILE ? { formPassword: (await import('node:fs')).readFileSync(env.MOCK_FORM_PASSWORD_FILE, 'utf8').trim() } : {}),
  })
  console.log(`mock console API ${stack.apiUrl}, fake IdP ${stack.idpUrl} (loopback only)`)
  const stop = () => { void stack.close().then(() => process.exit(0)) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
