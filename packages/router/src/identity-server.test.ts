import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createIdentityGate, createVerifier, IdentityState, type IdentityMode } from './identity.ts'
import { createRuntime } from './runtime.ts'
import { bakedDocument } from './settings.ts'
import { fixture, HAIKU, hopHeaders, startFakeBedrock, startRouter, testPolicy, type TestRouter } from './test-helpers.ts'

const ISS = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TESTPOOL'
const SCOPE = 'llmar/invoke'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwt(key: KeyObject, claims: Record<string, unknown>, kid = 'k1'): string {
  const h = b64({ kid, alg: 'RS256' })
  const p = b64(claims)
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`
}
const nowS = () => Math.floor(Date.now() / 1000)
const SUB = '11111111-2222-3333-4444-aaaabbbbcccc'
const userToken = (over: Record<string, unknown> = {}) => jwt(privateKey, {
  sub: SUB, iss: ISS, client_id: 'cliclient000000000000000000', token_use: 'access', scope: `openid ${SCOPE}`, username: 'u1',
  iat: nowS() - 10, exp: nowS() + 1800, ...over })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

const OPUS = 'global.anthropic.claude-opus-5-5'
/** Request lines only (the runtime's `config` lines share the sink). */
const reqs = (r: TestRouter) => r.logs.filter((l) => l.kind !== 'config')
async function waitForLogs(r: TestRouter, n: number): Promise<void> {
  const t = Date.now()
  while (reqs(r).length < n) {
    if (Date.now() - t > 3000) throw new Error(`expected ${n} request logs, got ${reqs(r).length}`)
    await new Promise((ok) => setTimeout(ok, 10))
  }
}
const policyJson = () => JSON.parse(JSON.stringify(testPolicy())) as Record<string, unknown>

/**
 * A router on a runtime generation whose document sets identity.mode (and a member cap), with principals.json
 * mapping SUB to the member group: the mode, group and cap all come from the generation (design v1 §2.1).
 */
async function setup(mode: IdentityMode, keys = true) {
  const state = new IdentityState()
  if (keys) state.applyJwks({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })
  state.applyBlocks({ schemaVersion: 1, principals: [{ kind: 'user', id: 'blocked-user' }] })
  state.applyBudgetBlocks({ schemaVersion: 1, principals: [{ kind: 'user', id: 'over-budget' }] })
  const identity = createIdentityGate({ state, verifier: createVerifier(state, { issuer: ISS, scope: SCOPE }) })
  const text = fixture('anthropic-messages/nonstream-read.json')
  const fake = await startFakeBedrock(() => ({ chunks: [text] }))
  const router = await startRouter(fake.url, {
    deps: { identity },
    runtime: ({ catalog, store, sink }) => {
      const rt = createRuntime(bakedDocument(testPolicy()), { catalog, store, sink, buildAssessor: () => ({ ok: true }) })
      rt.applyDocument({ schemaVersion: 1, version: '1-test', policy: policyJson(), identity: { mode }, access: { groups: { member: { maxTier: 'standard' } } } })
      rt.applyPrincipals({ [`user:${SUB}`]: { group: 'member' } }, '"p1"')
      return rt
    },
  })
  cleanups.push(fake.close, router.close)
  return { fake, router }
}

const body = JSON.stringify({ model: HAIKU, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/messages`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...hopHeaders(), ...headers } })

describe('identity gate in the request pipeline', () => {
  it('require: missing or invalid → 401 identity-<code> before the body or any upstream call; the line is kind rejected', async () => {
    const { fake, router } = await setup('require')
    const r1 = await post(router.url)
    expect(r1.status).toBe(401)
    expect(await r1.json()).toEqual({ error: 'unauthorized', code: 'identity-missing' })
    const r2 = await post(router.url, { 'x-api-key': userToken({ exp: nowS() - 3600 }) })
    expect(await r2.json()).toEqual({ error: 'unauthorized', code: 'identity-expired' })
    await waitForLogs(router, 2)
    expect(fake.requests).toHaveLength(0)
    expect(reqs(router)[0]).toMatchObject({ kind: 'rejected', status: 401, reason: 'identity-missing', identity: 'missing', principal: { kind: 'none' }, configVersion: '1-test' })
    expect(reqs(router)[1]).toMatchObject({ kind: 'rejected', status: 401, identity: 'invalid:expired' })
    expect(reqs(router)[0]).not.toHaveProperty('bodyBytes')
  })

  it('verified: served and attributed (principal ids and group only); the token never reaches logs or upstream', async () => {
    const { fake, router } = await setup('require')
    const t = userToken()
    const r = await post(router.url, { 'x-api-key': t, authorization: `Bearer ${t}` })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    expect(reqs(router)[0]).toMatchObject({ kind: 'model', status: 200, identity: 'verified', principal: { kind: 'user', id: SUB, group: 'member' } })
    const [, payload, sig] = t.split('.')
    for (const part of [t, payload, sig] as string[]) {
      expect(router.lines.join('\n')).not.toContain(part)
      expect(JSON.stringify(fake.requests.map((x) => x.headers))).not.toContain(part)
    }
    expect(JSON.stringify(reqs(router)[0])).not.toMatch(/u1|username/)
  })

  it('blocked → 403 identity-blocked, budget stop → 429 budget-exceeded, in observe as in require; never 5xx', async () => {
    for (const mode of ['observe', 'require'] as const) {
      const { fake, router } = await setup(mode)
      const b = await post(router.url, { 'x-api-key': userToken({ sub: 'blocked-user' }) })
      expect([b.status, await b.json()]).toEqual([403, { error: 'forbidden', code: 'identity-blocked' }])
      const q = await post(router.url, { 'x-api-key': userToken({ sub: 'over-budget' }) })
      expect([q.status, await q.json()]).toEqual([429, { error: 'budget exceeded', code: 'budget-exceeded' }])
      expect(fake.requests).toHaveLength(0)
      await waitForLogs(router, 2)
      expect(reqs(router).map((l) => [l.status, l.reason, (l.principal as { id?: string }).id])).toEqual([[403, 'identity-blocked', 'blocked-user'], [429, 'budget-exceeded', 'over-budget']])
    }
  })

  it('observe: missing or invalid tokens are served and logged as principal none', async () => {
    const { fake, router } = await setup('observe')
    const r = await post(router.url, { 'x-api-key': 'not-a-token' })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    expect(fake.requests).toHaveLength(1)
    expect(reqs(router)[0]).toMatchObject({ kind: 'model', identity: 'invalid:malformed', principal: { kind: 'none' } })
  })

  it('off: no identity fields at all', async () => {
    const { router } = await setup('off')
    await (await post(router.url, { 'x-api-key': userToken() })).text()
    await waitForLogs(router, 1)
    expect(reqs(router)[0]).not.toHaveProperty('principal')
    expect(reqs(router)[0]).not.toHaveProperty('identity')
  })

  it("the verified principal selects the cap: principals.json group 'member' → maxTier standard; an unverified caller gets none", async () => {
    const { fake, router } = await setup('observe')
    const pin = JSON.stringify({ model: OPUS, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    const send = (h: Record<string, string>) => fetch(`${router.url}/v1/messages`, { method: 'POST', body: pin,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...hopHeaders(), ...h } })
    const capped = await send({ 'x-api-key': userToken() })
    expect([capped.status, (await capped.json() as { code: string }).code]).toEqual([400, 'access-cap'])
    const anon = await send({})
    expect(anon.status).toBe(200)
    await anon.text()
    expect(fake.requests).toHaveLength(1)
  })

  it("model discovery (the gateway's GET /v1/models) carries no client token and is never gated", async () => {
    const { router } = await setup('require')
    const r = await fetch(`${router.url}/v1/models`, { headers: hopHeaders() })
    expect(r.status).toBe(200)
  })

  it('require with no keys loaded: 401 identity-keys-unavailable plus an alert EMF document (rejected lines get no request metrics)', async () => {
    const { router } = await setup('require', false)
    const r = await post(router.url, { 'x-api-key': userToken() })
    expect([r.status, (await r.json() as { code: string }).code]).toEqual([401, 'identity-keys-unavailable'])
    await waitForLogs(router, 1)
    const emf = router.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => '_aws' in o)
    expect(emf).toEqual([expect.objectContaining({ AlertReason: 'identity-keys-unavailable', Alerts: 1 })])
    expect(emf[0]).not.toHaveProperty('Requests')
  })

  it('Expect: 100-continue: the identity check runs before the body is invited', async () => {
    const { fake, router } = await setup('require')
    const u = new URL(router.url)
    const status = await new Promise<number>((ok, fail) => {
      const req = httpRequest({ host: u.hostname, port: u.port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', expect: '100-continue', 'content-length': Buffer.byteLength(body), ...hopHeaders() } })
      req.on('continue', () => fail(new Error('body was invited')))
      req.on('response', (res) => { res.resume(); ok(res.statusCode ?? 0) })
      req.on('error', fail)
    })
    expect(status).toBe(401)
    expect(fake.requests).toHaveLength(0)
    await waitForLogs(router, 1)
    expect(reqs(router)[0]).toMatchObject({ kind: 'rejected', status: 401, reason: 'identity-missing', configVersion: '1-test' })
  })
})
