import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createIdentityGate, createVerifier, IdentityDocError, identityWatches, IdentityState, parseBlockList, parseJwks, type IdentityMode,
} from './identity.ts'
import { validatePrincipals } from './settings.ts'
import { ConfigError, loadConfig } from './config.ts'
import { testPolicy } from './test-helpers.ts'

const ISS = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TESTPOOL'
const SCOPE = 'llmar/invoke'
const NOW_S = 1_800_000_000

function keypair(bits = 2048) { return generateKeyPairSync('rsa', { modulusLength: bits }) }
const jwkOf = (k: KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' })
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

function jwt(key: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { kid: 'k1', alg: 'RS256' }): string {
  const h = b64(header)
  const p = b64(claims)
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`
}

const user = (over: Record<string, unknown> = {}) => ({
  sub: '11111111-2222-3333-4444-aaaabbbbcccc', iss: ISS, client_id: 'cliclient000000000000000000', token_use: 'access',
  scope: `openid ${SCOPE}`, username: 'u1', 'cognito:groups': ['member'], iat: NOW_S - 60, exp: NOW_S + 1740, ...over,
})
const m2m = (over: Record<string, unknown> = {}) => ({
  sub: 'm2mclient00000000000000000', client_id: 'm2mclient00000000000000000', iss: ISS, token_use: 'access', scope: SCOPE,
  iat: NOW_S - 60, exp: NOW_S + 3540, ...over,
})

const k1 = keypair()
const k2 = keypair()

function setup(opts: { now?: () => number; keys?: Array<[KeyObject, string]> } = {}) {
  const state = new IdentityState()
  state.applyJwks({ keys: (opts.keys ?? [[k1.publicKey, 'k1']]).map(([k, kid]) => jwkOf(k, kid)) }, 'v1')
  const verifier = createVerifier(state, { issuer: ISS, scope: SCOPE, now: opts.now ?? (() => NOW_S * 1000) })
  return { state, verifier }
}

describe('JWT verification (RS256, node:crypto)', () => {
  it('verifies a Cognito user access token and an M2M token; principal kind from sub/client_id/username', () => {
    const { verifier } = setup()
    expect(verifier.verify(jwt(k1.privateKey, user()))).toEqual({ ok: true, kind: 'user', id: user().sub, exp: user().exp })
    expect(verifier.verify(jwt(k1.privateKey, m2m()))).toEqual({ ok: true, kind: 'client', id: m2m().sub, exp: m2m().exp })
  })

  it('strips an optional Bearer prefix (Codex gateway_oauth sends "Bearer <t>"); empty, whitespace and bare Bearer are missing', () => {
    const { verifier } = setup()
    const t = jwt(k1.privateKey, user())
    expect(verifier.verify(`Bearer ${t}`)).toMatchObject({ ok: true })
    expect(verifier.verify(`bearer   ${t}  `)).toMatchObject({ ok: true })
    for (const v of [undefined, '', '   ', 'Bearer', 'Bearer   ', 'bearer']) expect(verifier.verify(v)).toEqual({ ok: false, code: 'missing' })
  })

  it('refuses malformed values: repeated headers, comma-joined repeats, wrong segment count or alphabet, oversize', () => {
    const { verifier } = setup()
    const t = jwt(k1.privateKey, user())
    for (const v of [[t, t], `${t}, ${t}`, 'a.b', 'a.b.c.d', 'a.b!.c', `x${'a'.repeat(4096)}.b.c`, 'Bearer a b.c.d']) {
      expect(verifier.verify(v as string | string[])).toEqual({ ok: false, code: 'malformed' })
    }
  })

  it('checks alg, kid, signature, issuer, token_use, scope and lifetime (30 s leeway)', () => {
    const { verifier } = setup()
    const code = (t: string) => (verifier.verify(t) as { code?: string }).code
    expect(code(jwt(k1.privateKey, user(), { kid: 'k1', alg: 'HS256' }))).toBe('alg')
    expect(code(jwt(k1.privateKey, user(), { kid: 'k1', alg: 'none' }))).toBe('alg')
    expect(code(jwt(k1.privateKey, user(), { kid: 'other', alg: 'RS256' }))).toBe('kid-unknown')
    expect(code(jwt(k2.privateKey, user()))).toBe('signature')
    expect(code(jwt(k1.privateKey, user({ iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_OTHER' })))).toBe('issuer')
    expect(code(jwt(k1.privateKey, user({ token_use: 'id' })))).toBe('token-use')
    expect(code(jwt(k1.privateKey, user({ scope: 'openid' })))).toBe('scope')
    expect(code(jwt(k1.privateKey, user({ scope: 'openid llmar/invoke-extra' })))).toBe('scope')
    expect(code(jwt(k1.privateKey, user({ exp: NOW_S - 31 })))).toBe('expired')
    expect(verifier.verify(jwt(k1.privateKey, user({ exp: NOW_S - 29 })))).toMatchObject({ ok: true })
    expect(code(jwt(k1.privateKey, user({ iat: NOW_S + 31 })))).toBe('not-yet-valid')
    expect(code(jwt(k1.privateKey, user({ nbf: NOW_S + 31 })))).toBe('not-yet-valid')
    expect(code(jwt(k1.privateKey, user({ sub: 'has space' })))).toBe('malformed')
  })

  it('a valid signature never vouches for another payload (the cache is keyed by the whole token)', () => {
    const { verifier } = setup()
    const good = jwt(k1.privateKey, user())
    expect(verifier.verify(good)).toMatchObject({ ok: true })
    const [h, , s] = good.split('.')
    const forged = `${h}.${b64(user({ sub: '99999999-2222-3333-4444-aaaabbbbcccc' }))}.${s}`
    expect(verifier.verify(forged)).toEqual({ ok: false, code: 'signature' })
  })

  it('cached tokens still expire; a key-set change clears the cache (rotation, removal)', () => {
    let nowMs = NOW_S * 1000
    const { state, verifier } = setup({ now: () => nowMs })
    const t = jwt(k1.privateKey, user({ exp: NOW_S + 100 }))
    expect(verifier.verify(t)).toMatchObject({ ok: true })
    nowMs = (NOW_S + 131) * 1000
    expect(verifier.verify(t)).toEqual({ ok: false, code: 'expired' })
    nowMs = NOW_S * 1000
    const t2 = jwt(k1.privateKey, user())
    expect(verifier.verify(t2)).toMatchObject({ ok: true })
    state.applyJwks({ keys: [jwkOf(k2.publicKey, 'k2')] }, 'v2') // k1 removed
    expect(verifier.verify(t2)).toEqual({ ok: false, code: 'kid-unknown' })
    expect(verifier.verify(jwt(k2.privateKey, user(), { kid: 'k2', alg: 'RS256' }))).toMatchObject({ ok: true })
  })

  it('no keys yet: keys-unavailable (never a 5xx path); malformed input is still reported first', () => {
    const state = new IdentityState()
    const verifier = createVerifier(state, { issuer: ISS, scope: SCOPE, now: () => NOW_S * 1000 })
    expect(verifier.verify(jwt(k1.privateKey, user()))).toEqual({ ok: false, code: 'keys-unavailable' })
    expect(verifier.verify('nope')).toEqual({ ok: false, code: 'malformed' })
  })

  it('stays within budget: well under 1 ms per uncached verify, microseconds when cached', () => {
    const { verifier } = setup()
    const tokens = Array.from({ length: 200 }, (_, i) => jwt(k1.privateKey, user({ jti: `j${i}` })))
    let t0 = performance.now()
    for (const t of tokens) verifier.verify(t)
    const uncached = (performance.now() - t0) / tokens.length
    t0 = performance.now()
    for (let i = 0; i < 20; i++) for (const t of tokens) verifier.verify(t)
    const cached = (performance.now() - t0) / (tokens.length * 20)
    expect(uncached).toBeLessThan(1)
    expect(cached).toBeLessThan(0.05)
  })
})

describe('identity documents', () => {
  it('jwks: RSA RS256 signing keys only, 1..10, at least 2048 bits, unique kids', () => {
    const ok = { keys: [jwkOf(k1.publicKey, 'a'), jwkOf(k2.publicKey, 'b')] }
    expect(parseJwks(ok).size).toBe(2)
    const small = keypair(1024)
    const bad: Array<[unknown, string]> = [
      [{}, 'jwks-shape'], [{ keys: [] }, 'jwks-key-count'], [{ keys: Array(11).fill(jwkOf(k1.publicKey, 'x')) }, 'jwks-key-count'],
      [{ keys: [{ ...jwkOf(k1.publicKey, 'a'), alg: 'RS512' }] }, 'jwks-key-alg'], [{ keys: [{ ...jwkOf(k1.publicKey, 'a'), use: 'enc' }] }, 'jwks-key-use'],
      [{ keys: [jwkOf(k1.publicKey, 'a'), jwkOf(k2.publicKey, 'a')] }, 'jwks-duplicate-kid'], [{ keys: [jwkOf(small.publicKey, 'a')] }, 'jwks-key-too-small'],
      [{ keys: [{ kty: 'EC', kid: 'a', n: 'x', e: 'y' }] }, 'jwks-key-shape'], [{ keys: [{ kty: 'RSA', kid: 'a', n: '!!', e: 'AQAB' }] }, 'jwks-key-shape'], [{ keys: [{ kty: 'RSA', kid: 'a', n: 'AQAB', e: 'AQAB' }] }, 'jwks-key-too-small'],
    ]
    for (const [doc, code] of bad) expect(() => parseJwks(doc), code).toThrow(expect.objectContaining({ code }))
  })

  it('a rejected document never replaces the last good one', () => {
    const { state, verifier } = setup()
    expect(() => state.applyJwks({ keys: [] }, 'bad')).toThrow(IdentityDocError)
    expect(state.version('jwks')).toBe('v1')
    expect(verifier.verify(jwt(k1.privateKey, user()))).toMatchObject({ ok: true })
    state.applyBlocks({ schemaVersion: 1, principals: [{ kind: 'user', id: 'abc' }] }, 'b1')
    expect(() => state.applyBlocks({ schemaVersion: 1 }, 'b2')).toThrow(IdentityDocError) // structure broken
    expect(state.blocked('user:abc')).toBe(true)
    expect(state.version('blocks')).toBe('b1')
  })

  it('block lists: shapes and limits', () => {
    const ok = parseBlockList({ schemaVersion: 1, principals: [{ kind: 'client', id: 'c1', reason: 'disabled', at: 'x' }] })
    expect([[...ok.entries], ok.skipped]).toEqual([[['client:c1', undefined]], 0])
    // Structure broken: the document is rejected (the last good one stays).
    for (const doc of [{}, [], { schemaVersion: 2, principals: [] }, { schemaVersion: 1, principals: 'x' }]) {
      expect(() => parseBlockList(doc)).toThrow(expect.objectContaining({ code: 'blocks-shape' }))
    }
  })

  it('block lists: one bad entry is skipped and counted, never freezing the rest; Cognito client ids may contain "+"', () => {
    const r = parseBlockList({ schemaVersion: 1, principals: [
      { kind: 'user', id: 'u1' }, { kind: 'client', id: 'abc+def' }, { kind: 'root', id: 'x' }, { kind: 'user' }, { kind: 'user', id: 'a b' },
      { kind: 'user', id: 'u2', month: '2026-13' }, { kind: 'user', id: 'x'.repeat(129) }, 'junk', { kind: 'user', id: 'u3', month: '2026-11' },
    ] })
    expect([...r.entries.keys()]).toEqual(['user:u1', 'client:abc+def', 'user:u3'])
    expect(r.skipped).toBe(6)
    const state = new IdentityState()
    expect(state.applyBlocks({ schemaVersion: 1, principals: [{ kind: 'user', id: 'u1' }, { kind: 'root', id: 'x' }] }, 'b1')).toEqual({ count: 1, skipped: 1 })
    expect(state.blocked('user:u1')).toBe(true)
    // An M2M token whose client id contains '+' verifies (sub == client_id), and its block applies.
    const { state: s2, verifier } = setup()
    s2.applyBlocks({ schemaVersion: 1, principals: [{ kind: 'client', id: 'abc+def' }] })
    const gate = createIdentityGate({ state: s2, verifier })
    expect(gate.check({ 'x-api-key': jwt(k1.privateKey, m2m({ sub: 'abc+def', client_id: 'abc+def' })) }, 'require'))
      .toMatchObject({ ok: false, status: 403, code: 'identity-blocked', principal: { kind: 'client', id: 'abc+def' } })
  })

  it('a block list with skipped entries is applied, and its config line says so (entry-invalid + skipped count)', () => {
    const state = new IdentityState()
    const lines: string[] = []
    const w = identityWatches(state, (l) => lines.push(l), () => 0).find((x) => x.key === 'identity/budget-blocks.json')!
    w.onObject(JSON.stringify({ schemaVersion: 1, principals: [{ kind: 'user', id: 'u1', month: '2026-11' }, { kind: 'user', id: 'bad id' }] }), '"bb1"')
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'config', source: 'budget-blocks', outcome: 'applied', version: 'bb1', count: 1, skipped: 1, issues: ['entry-invalid'] })
    expect(lines[0]).not.toContain('bad id')
  })

  it('principals.json keys accept Cognito client ids with "+" (settings.validatePrincipals)', () => {
    expect(validatePrincipals({ 'client:abc+def': { group: 'service' } })).toMatchObject({ ok: true })
    // A bad key is skipped (0d 8ccce0a), never the whole file.
    const bad = validatePrincipals({ 'client:a b': { group: 'service' } })
    expect(bad.ok).toBe(true)
    expect(bad.ok ? bad.value.size : -1).toBe(0)
  })

  it('poller watches: apply, reject (last good kept), absent before and after loading, errors; kind "config" lines carry no values', () => {
    const state = new IdentityState()
    const lines: string[] = []
    const w = Object.fromEntries(identityWatches(state, (l) => lines.push(l), () => 0, () => ({ configVersion: '3-test' })).map((x) => [x.key, x]))
    expect(Object.keys(w)).toEqual(['identity/jwks.json', 'identity/blocks.json', 'identity/budget-blocks.json'])
    const blocks = w['identity/blocks.json']!
    blocks.onAbsent?.()
    blocks.onObject(JSON.stringify({ schemaVersion: 1, principals: [{ kind: 'user', id: 'u1' }] }), '"etag-1"')
    blocks.onObject('{not json', '"etag-2"')
    blocks.onObject(JSON.stringify({ schemaVersion: 1, principals: 'not-a-list' }), '"etag-3"')
    blocks.onAbsent?.()
    blocks.onError?.('s3-403')
    expect(state.blocked('user:u1')).toBe(true)
    expect(state.version('blocks')).toBe('etag1')
    w['identity/jwks.json']!.onObject(JSON.stringify({ keys: [jwkOf(k1.publicKey, 'k1')] }), '"j1"')
    expect(state.hasKeys).toBe(true)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed.map((o) => [o.kind, o.source, o.outcome, o.version, o.count ?? o.issues ?? o.code ?? o.keptLastGood])).toEqual([
      ['config', 'blocks', 'absent', undefined, undefined],
      ['config', 'blocks', 'applied', 'etag1', 1],
      ['config', 'blocks', 'rejected', 'etag1', ['json']],
      ['config', 'blocks', 'rejected', 'etag1', ['blocks-shape']],
      ['config', 'blocks', 'absent', 'etag1', true],
      ['config', 'blocks', 'error', 'etag1', 's3-403'],
      ['config', 'jwks', 'applied', 'j1', 1],
    ])
    // The C3 contract: config lines with the C3 outcome vocabulary and the generation's configVersion; ingest's
    // subscription filter (kind model|error|rejected|config) sees them; the console waits for jwks/applied.
    for (const o of parsed) {
      expect(o.kind).toBe('config')
      expect(['applied', 'rejected', 'absent', 'error']).toContain(o.outcome)
      expect(['jwks', 'blocks', 'budget-blocks']).toContain(o.source)
      expect(o.configVersion).toBe('3-test')
      expect(o).not.toHaveProperty('object')
    }
    expect(parsed.filter((o) => o.source === 'jwks' && o.outcome === 'applied')).toHaveLength(1)
    expect(parsed[3]).toMatchObject({ attempted: 'etag3' })
    expect(lines.join('\n')).not.toMatch(/"n":|u1/)
  })
})

describe('budget stops at the month rollover', () => {
  it('apply only in the UTC month they were evaluated for (the shape usage-ingest writes); entries without a month always apply', () => {
    const state = new IdentityState()
    state.applyBudgetBlocks({ schemaVersion: 1, principals: [
      { kind: 'user', id: 'nov', reason: 'budget', month: '2026-11', at: '2026-11-08T03:00:00Z', limitUsd: 10 },
      { kind: 'user', id: 'oct', reason: 'budget', month: '2026-10', at: '2026-10-30T03:00:00Z' },
      { kind: 'client', id: 'nomonth' },
    ] })
    const nov = Date.UTC(2026, 10, 30, 23, 59, 59)
    const dec = Date.UTC(2026, 11, 1, 0, 0, 1)
    expect([state.budgetBlocked('user:nov', nov), state.budgetBlocked('user:oct', nov), state.budgetBlocked('client:nomonth', nov)]).toEqual([true, false, true])
    expect([state.budgetBlocked('user:nov', dec), state.budgetBlocked('client:nomonth', dec)]).toEqual([false, true])
    const { verifier } = setup()
    const gate = createIdentityGate({ state, verifier, now: () => dec })
    expect(gate.check({ 'x-api-key': jwt(k1.privateKey, user({ sub: 'nov' })) }, 'require')).toMatchObject({ ok: true })
  })

  it('an identity object that cannot be read before it ever loaded alerts loudly (EMF + stderr); later errors are a plain line', () => {
    const state = new IdentityState()
    const lines: string[] = []
    const w = identityWatches(state, (l) => lines.push(l), () => 0)
    const blocks = w.find((x) => x.key === 'identity/blocks.json')!
    const write = process.stderr.write
    let stderr = ''
    process.stderr.write = ((c: string) => { stderr += c; return true }) as typeof process.stderr.write
    try { blocks.onError?.('s3-403') } finally { process.stderr.write = write }
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ kind: 'config', source: 'blocks', outcome: 'error', loaded: false, alert: 'identity-objects-unavailable' }),
      expect.objectContaining({ AlertReason: 'identity-objects-unavailable', Alerts: 1 }),
    ])
    expect(stderr).toMatch(/identity\/blocks\.json could not be read \(s3-403\)/)
  })
})

describe('identity gate (modes, blocks, budget stops)', () => {
  function gate() {
    const { state, verifier } = setup()
    state.applyBlocks({ schemaVersion: 1, principals: [{ kind: 'user', id: 'blocked-user' }] })
    state.applyBudgetBlocks({ schemaVersion: 1, principals: [{ kind: 'client', id: m2m().sub }] })
    return createIdentityGate({ state, verifier, header: 'x-api-key' })
  }
  const h = (t?: string) => (t === undefined ? {} : { 'x-api-key': t })

  it('off reads nothing; observe serves missing/invalid and logs them; require answers 401 identity-<code>', () => {
    const g = gate()
    expect(g.check(h('garbage'), 'off')).toEqual({ ok: true })
    expect(g.check(h(), 'observe')).toEqual({ ok: true, principal: { kind: 'none' }, identity: 'missing' })
    expect(g.check(h('a.b.c'), 'observe')).toEqual({ ok: true, principal: { kind: 'none' }, identity: 'invalid:malformed' })
    expect(g.check(h(), 'require')).toEqual({ ok: false, status: 401, code: 'identity-missing', principal: { kind: 'none' }, identity: 'missing' })
    expect(g.check(h(jwt(k2.privateKey, user())), 'require')).toMatchObject({ ok: false, status: 401, code: 'identity-signature', identity: 'invalid:signature' })
  })

  it('verified principals (ids only); blocks apply in observe and require', () => {
    const g = gate()
    for (const mode of ['observe', 'require'] as IdentityMode[]) {
      expect(g.check(h(jwt(k1.privateKey, user())), mode)).toEqual({ ok: true, principal: { kind: 'user', id: user().sub }, identity: 'verified' })
      expect(g.check(h(jwt(k1.privateKey, user({ sub: 'blocked-user' }))), mode)).toEqual({
        ok: false, status: 403, code: 'identity-blocked', principal: { kind: 'user', id: 'blocked-user' }, identity: 'verified' })
      expect(g.check(h(jwt(k1.privateKey, m2m())), mode)).toEqual({
        ok: false, status: 429, code: 'budget-exceeded', principal: { kind: 'client', id: m2m().sub }, identity: 'verified' })
    }
  })

  it('reads the configured header only', () => {
    const { state, verifier } = setup()
    const g = createIdentityGate({ state, verifier, header: 'x-router-identity' })
    const t = jwt(k1.privateKey, user())
    expect(g.check({ 'x-api-key': t }, 'require')).toMatchObject({ ok: false, code: 'identity-missing' })
    expect(g.check({ 'x-router-identity': t }, 'require')).toMatchObject({ ok: true, identity: 'verified' })
  })
})

describe('identity settings (ROUTER_IDENTITY_*)', () => {
  const base = { ROUTER_POLICY_JSON: JSON.stringify(testPolicy()), ROUTER_REGION: 'ap-northeast-1' }
  const issues = (env: Record<string, string>): string[] => {
    try { loadConfig(env); return [] } catch (e) { return e instanceof ConfigError ? e.issues : [String(e)] }
  }
  const ok = { ...base, ROUTER_CONFIG_BUCKET: 'llmar-config-test', ROUTER_IDENTITY_ISSUER: ISS, ROUTER_IDENTITY_SCOPE: SCOPE }

  it('absent unless configured; with issuer, scope and the config bucket: env mode default off, header x-api-key', () => {
    expect(loadConfig(base).identity).toBeUndefined()
    expect(loadConfig(ok).identity).toEqual({ mode: 'off', header: 'x-api-key', issuer: ISS, scope: SCOPE })
    expect(loadConfig({ ...ok, ROUTER_IDENTITY_MODE: 'require', ROUTER_IDENTITY_HEADER: 'x-router-identity' }).identity)
      .toEqual({ mode: 'require', header: 'x-router-identity', issuer: ISS, scope: SCOPE })
  })

  it('refuses bad values, a pool in another region, and identity without the config bucket', () => {
    expect(issues({ ...ok, ROUTER_IDENTITY_MODE: 'strict' }).join()).toMatch(/ROUTER_IDENTITY_MODE/)
    expect(issues({ ...ok, ROUTER_IDENTITY_HEADER: 'authorization' }).join()).toMatch(/ROUTER_IDENTITY_HEADER/)
    expect(issues({ ...ok, ROUTER_IDENTITY_ISSUER: 'https://example.com/pool' }).join()).toMatch(/ROUTER_IDENTITY_ISSUER/)
    expect(issues({ ...ok, ROUTER_IDENTITY_ISSUER: ISS.replaceAll('ap-northeast-1', 'us-west-2') }).join()).toMatch(/pool region 'us-west-2'/)
    expect(issues({ ...ok, ROUTER_IDENTITY_SCOPE: 'invoke' }).join()).toMatch(/ROUTER_IDENTITY_SCOPE/)
    const { ROUTER_CONFIG_BUCKET: _, ...noBucket } = ok
    expect(issues(noBucket).join()).toMatch(/requires ROUTER_CONFIG_BUCKET/)
    expect(issues({ ...base, ROUTER_IDENTITY_MODE: 'observe' }).length).toBeGreaterThanOrEqual(3)
  })
})
