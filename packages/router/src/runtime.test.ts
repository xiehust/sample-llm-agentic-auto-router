// Generation holder, configuration document, principal file and S3 source (admin console C3; 0d research §2).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessCapError, createEngine, InMemoryStateStore, type Engine } from '@auto-router/core'
import { loadCatalog } from '@auto-router/pricing'
import { createRuntime, type AssessorBuilder, type RuntimeRef } from './runtime.ts'
import type { RouterDeps } from './server.ts'
import { BAKED_VERSION, bakedDocument, parseConfigVersion, resolveCap, validateConfigDocument, validatePrincipals } from './settings.ts'
import { createPoller, s3Fetcher, type FetchResult } from './source.ts'
import { fakeSigner, fixture, hopHeaders, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Script } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const SONNET = 'global.anthropic.claude-sonnet-5-5'
const OPUS = 'global.anthropic.claude-opus-5-5'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const noAssessor: AssessorBuilder = () => ({ ok: true })
const policyJson = (over: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(testPolicy())), ...over })
const doc = (n: number, over: Record<string, unknown> = {}) => ({ schemaVersion: 1, version: `${n}-20261108T010000Z`, policy: policyJson({ version: `c${n}` }), ...over })

function holder(opts: Partial<Parameters<typeof createRuntime>[1]> = {}) {
  const lines: Record<string, unknown>[] = []
  const rt = createRuntime(bakedDocument(testPolicy()), {
    catalog, store: new InMemoryStateStore(), sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>), buildAssessor: noAssessor,
    now: () => Date.parse('2026-11-08T01:00:00Z'), ...opts,
  })
  return { rt, lines }
}

describe('configuration document (settings.ts)', () => {
  it('orders versions by the integer n, never by string compare', () => {
    expect(parseConfigVersion('12-20261108T0100Z')).toBe(12)
    expect(parseConfigVersion(BAKED_VERSION)).toBe(0)
    for (const bad of ['', '012-x', '-1-x', 'v3', '3', '3-', 3, '3-a b']) expect(parseConfigVersion(bad)).toBeUndefined()
    expect(parseConfigVersion('10-a')! > parseConfigVersion('9-z')!).toBe(true)
  })

  it('accepts a full document and reports every issue of a bad one at once', () => {
    const ok = validateConfigDocument(doc(3, { identity: { mode: 'observe' }, access: { groups: { member: { maxTier: 'standard', allowPins: [OPUS] } } }, assessor: { mode: 'off' } }), catalog)
    expect(ok).toMatchObject({ ok: true, value: { seq: 3, version: '3-20261108T010000Z', access: { groups: { member: { maxTier: 'standard', allowPins: [OPUS] } } } } })
    const bad = validateConfigDocument({ schemaVersion: 2, version: 'x', policy: { version: '' }, identity: { mode: 'on' }, access: { groups: { guest: {}, member: { maxTier: 'ultra' } }, other: 1 }, extra: true }, catalog)
    expect(bad.ok).toBe(false)
    const issues = bad.ok ? [] : bad.issues
    for (const frag of ['extra: unknown field', 'schemaVersion', 'version:', 'policy.version', 'identity.mode', 'access.other', 'access.groups.guest', 'access.groups.member.maxTier']) {
      expect(issues.some((i) => i.includes(frag)), frag).toBe(true)
    }
  })

  it('checks the policy against the router catalog (a model the region does not offer is refused)', () => {
    const p = policyJson({ version: 'c4' })
    p.pools['anthropic-messages'].models.push({ model: 'global.anthropic.claude-nonexistent' })
    const r = validateConfigDocument({ schemaVersion: 1, version: '4-a', policy: p }, catalog)
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.issues).toEqual([expect.stringContaining("model 'global.anthropic.claude-nonexistent' not in catalog")])
  })

  it('opts.assessor: the console checks the assessor block in the same call (image packs passed in)', () => {
    const ctx = { catalog, packs: [{ name: 'v2.2', packVersion: 'assessor/v2.2+e2183dce2cb9', autoCapable: false }], hasAdapter: () => true }
    const block = { mode: 'observe', pack: 'v2.2', model: 'global.openai.gpt-6-luna', threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' }
    expect(validateConfigDocument(doc(3, { assessor: block }), catalog, { assessor: ctx })).toMatchObject({ ok: true, value: { assessor: block } })
    const bad = validateConfigDocument(doc(3, { assessor: { ...block, mode: 'auto', pack: 'v9' } }), catalog, { assessor: ctx })
    expect(bad.ok ? [] : bad.issues).toEqual([expect.stringMatching(/^assessor\.pack: pack-unknown: /)])
    const drift = validateConfigDocument(doc(3, { assessor: { ...block, packVersion: 'assessor/v2.2+000000000000' } }), catalog, { assessor: ctx })
    expect(drift).toMatchObject({ ok: true, warnings: [expect.stringMatching(/^assessor\.packVersion: pack-version-drift: /)] })
    // Without opts.assessor the block stays opaque (the router validates it in its AssessorBuilder).
    expect(validateConfigDocument(doc(3, { assessor: { mode: 'auto', pack: 'v9' } }), catalog).ok).toBe(true)
  })

  it('principals: validation, and cap precedence principal > group > none', () => {
    const p = validatePrincipals({ 'user:abc-1': { group: 'member' }, 'user:abc-2': { group: 'member', cap: { maxTier: 'fast' } }, 'client:svc9': { group: 'service' } })
    expect(p.ok).toBe(true)
    const principals = p.ok ? p.value : new Map()
    const access = { groups: { member: { maxTier: 'standard' as const } } }
    expect(resolveCap(access, principals, 'user:abc-1')).toEqual({ cap: { maxTier: 'standard' }, source: 'group' })
    expect(resolveCap(access, principals, 'user:abc-2')).toEqual({ cap: { maxTier: 'fast' }, source: 'principal' })
    expect(resolveCap(access, principals, 'client:svc9')).toEqual({ source: 'none', issue: 'unknown-group' })
    expect(resolveCap(access, principals, 'user:nobody')).toEqual({ source: 'none' })
    expect(resolveCap(access, principals, undefined)).toEqual({ source: 'none' })
    // Bad entries are skipped (one detail each), never the file; a non-object still rejects it.
    const bad = validatePrincipals({ 'admin@example': { group: 'member' }, 'user:x': { group: 'root', cap: { maxTier: 'x' }, note: 1 }, 'client:ab+cd': { group: 'service' }, 'user:ok': {} })
    expect(bad).toMatchObject({ ok: true, warnings: [expect.stringContaining('admin@example'), expect.stringMatching(/user:x\.note.*user:x\.group.*user:x\.cap\.maxTier/)] })
    expect([...(bad.ok ? bad.value.keys() : [])]).toEqual(['client:ab+cd', 'user:ok']) // '+' is a Cognito client id character
    expect(validatePrincipals([]).ok).toBe(false)
    expect(validatePrincipals('x').ok).toBe(false)
  })

  it('settings.ts and core/policy stay free of node: built-ins (the console SPA and Lambdas import them)', () => {
    const files = [new URL('./settings.ts', import.meta.url), ...['policy-public.ts', 'policy.ts', 'cap.ts', 'tiers.ts', 'pricing-types.ts', 'reason.ts', 'swap-effects.ts', 'warmth.ts'].map((f) => new URL(`../../core/src/${f}`, import.meta.url))]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const imports = [...src.matchAll(/^(?:import|export)\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)].filter((m) => !m[1]).map((m) => m[2] as string)
      for (const i of imports) {
        expect(i.startsWith('node:'), `${f.pathname}: ${i}`).toBe(false)
        // Value imports stay inside the browser-safe set (pricing-types re-exports costOf, pure arithmetic).
        expect(i.startsWith('./') || i === '@auto-router/core/policy' || i === '@auto-router/pricing', `${f.pathname}: ${i}`).toBe(true)
      }
    }
  })
})

describe('generation holder (runtime.ts)', () => {
  it('starts on the baked document; a newer document gets a new engine, an older one is ignored, the same one is a no-op', () => {
    const { rt, lines } = holder()
    const g0 = rt.current()
    expect(g0).toMatchObject({ configVersion: BAKED_VERSION, seq: 0, principalsVersion: 'none' })
    expect(rt.applyDocument(JSON.stringify(doc(2)))).toEqual({ outcome: 'applied' })
    const g2 = rt.current()
    expect(g2.configVersion).toBe('2-20261108T010000Z')
    expect(g2.engine).not.toBe(g0.engine)
    expect(g0.configVersion).toBe(BAKED_VERSION) // generations are immutable: in-flight requests keep theirs
    expect(rt.applyDocument(doc(2))).toEqual({ outcome: 'ignored' })
    expect(rt.applyDocument(doc(1))).toEqual({ outcome: 'ignored' })
    expect(rt.current()).toBe(g2)
    expect(lines.map((l) => [l.kind, l.source, l.outcome, l.configVersion])).toEqual([
      ['config', 'config', 'applied', '2-20261108T010000Z'],
      ['config', 'config', 'ignored', '2-20261108T010000Z'],
    ])
    expect(lines[0]).toMatchObject({ from: BAKED_VERSION, policyVersion: 'c2', catalogVersion: catalog.version, principalsVersion: 'none' })
    expect(lines[1]).toMatchObject({ attempted: '1-20261108T010000Z' })
  })

  it('a rejected document keeps the last good generation and logs the issues (bad JSON, invalid policy, assessor, engine)', () => {
    let rejectAssessor = false
    let throwEngine = false
    const { rt, lines } = holder({
      buildAssessor: () => (rejectAssessor ? { ok: false, issues: ['assessor.pack: unknown pack v9'] } : { ok: true }),
      engineFor: (policy) => { if (throwEngine) throw new TypeError('store lacks noteRoot'); return { policy } as unknown as Engine },
    })
    const g0 = rt.current()
    expect(rt.applyDocument('{not json')).toEqual({ outcome: 'rejected', issues: ['document: invalid JSON'] })
    expect(rt.applyDocument(doc(5, { policy: { version: 'c5' } })).outcome).toBe('rejected')
    rejectAssessor = true
    expect(rt.applyDocument(doc(6))).toEqual({ outcome: 'rejected', issues: ['assessor.pack: unknown pack v9'] })
    rejectAssessor = false
    throwEngine = true
    expect(rt.applyDocument(doc(7))).toEqual({ outcome: 'rejected', issues: ['engine: store lacks noteRoot'] })
    expect(rt.current()).toBe(g0)
    expect(lines.every((l) => l.outcome === 'rejected' && l.configVersion === BAKED_VERSION)).toBe(true)
    expect(lines.map((l) => l.attempted)).toEqual([undefined, undefined, '6-20261108T010000Z', '7-20261108T010000Z'])
    throwEngine = false
    expect(rt.applyDocument(doc(7)).outcome).toBe('applied') // nothing remembers a rejection: the same version applies once valid
  })

  it('assessor warnings are logged on apply, never a rejection; lineFields extend config lines', () => {
    const { rt, lines } = holder({ buildAssessor: () => ({ ok: true, warnings: ['drift: v2.2'] }), lineFields: [(g) => ({ blocksEtag: `e-${g.seq}` })] })
    expect(rt.applyDocument(doc(3))).toEqual({ outcome: 'applied', warnings: ['drift: v2.2'] })
    expect(lines[0]).toMatchObject({ outcome: 'applied', warnings: ['drift: v2.2'], blocksEtag: 'e-3' })
  })

  it('principals: applied into the same snapshot without a new engine; a broken file keeps the last good; bad entries are skipped; unknown groups are logged', () => {
    const { rt, lines } = holder()
    rt.applyDocument(doc(2, { access: { groups: { member: { maxTier: 'standard' } } } }))
    const engine = rt.current().engine
    expect(rt.applyPrincipals(JSON.stringify({ 'user:u1': { group: 'member' }, 'client:c1': { group: 'service' } }), '"etag-1"')).toEqual({ outcome: 'applied' })
    const g = rt.current()
    expect(g).toMatchObject({ principalsVersion: '"etag-1"', configVersion: '2-20261108T010000Z' })
    expect(g.engine).toBe(engine)
    expect(resolveCap(g.document.access, g.principals, 'user:u1').cap).toEqual({ maxTier: 'standard' })
    expect(rt.applyPrincipals('[1, 2]', '"etag-2"').outcome).toBe('rejected')
    expect(rt.current()).toBe(g)
    expect(rt.applyPrincipals({ 'user:u1': { group: 'member' }, 'user:u2': { group: 'nope' } }, '"etag-3"').outcome).toBe('applied')
    expect([...rt.current().principals.keys()]).toEqual(['user:u1'])
    expect(lines.slice(1).map((l) => [l.source, l.outcome, l.principalsVersion, l.issues, l.skipped])).toEqual([
      ['principals', 'applied', '"etag-1"', ['unknown-group:service'], undefined],
      ['principals', 'rejected', '"etag-1"', ['principals: object required'], undefined],
      ['principals', 'applied', '"etag-3"', ['entry-invalid'], 1],
    ])
    expect(JSON.stringify(lines.at(-1))).not.toContain('user:u2') // codes and counts only
    // A later document keeps the principal file.
    rt.applyDocument(doc(3))
    expect(rt.current().principalsVersion).toBe('"etag-3"')
  })
})

describe('S3 source (source.ts)', () => {
  it('s3Fetcher: signed GET with If-None-Match and the empty-payload hash; 200 / 304 / 404 / 403 / 5xx / too large / network', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const answers: Array<() => Response> = [
      () => new Response('{"a":1}', { status: 200, headers: { etag: '"e1"' } }),
      () => new Response(null, { status: 304 }),
      () => new Response('<Error/>', { status: 404 }),
      () => new Response('<Error/>', { status: 403 }),
      () => new Response('x', { status: 503 }),
      () => new Response('x', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }),
      () => { throw new TypeError('fetch failed') },
    ]
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> })
      return (answers.shift() as () => Response)()
    }) as unknown as typeof fetch
    const f = s3Fetcher({ bucket: 'llmar-config-test', region: 'ap-southeast-1', signer: fakeSigner, fetchImpl })
    const got: FetchResult[] = []
    for (let i = 0; i < 7; i++) got.push(await f('config/active.json', i === 1 ? '"e1"' : undefined))
    expect(got).toEqual([
      { status: 'ok', body: '{"a":1}', etag: '"e1"' }, { status: 'not-modified' }, { status: 'absent' },
      { status: 'error', code: 's3-403' }, { status: 'error', code: 's3-503' }, { status: 'error', code: 'too-large' }, { status: 'error', code: 'network' },
    ])
    expect(calls[0]?.url).toBe('https://llmar-config-test.s3.ap-southeast-1.amazonaws.com/config/active.json')
    expect(calls[0]?.headers).toMatchObject({ authorization: 'AWS4-HMAC-SHA256 FAKE-SIG', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' })
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()
    expect(calls[1]?.headers['if-none-match']).toBe('"e1"')
  })

  it('poller: passes the last etag, applies each new etag once, reports absence and errors once per streak', async () => {
    const seen: string[] = []
    const etags: Array<string | undefined> = []
    const script: FetchResult[] = [
      { status: 'absent' }, { status: 'absent' }, { status: 'ok', body: 'A', etag: '"1"' }, { status: 'not-modified' },
      { status: 'error', code: 'timeout' }, { status: 'error', code: 'timeout' }, { status: 'ok', body: 'A', etag: '"1"' }, { status: 'ok', body: 'B', etag: '"2"' },
    ]
    const p = createPoller(async (_k, etag) => { etags.push(etag); return script.shift() as FetchResult }, [{
      key: 'config/active.json', onObject: (b, e) => seen.push(`obj:${b}:${e}`), onAbsent: () => seen.push('absent'), onError: (c) => seen.push(`err:${c}`),
    }], 30_000)
    for (let i = 0; i < 8; i++) await p.pollOnce()
    expect(seen).toEqual(['absent', 'obj:A:"1"', 'err:timeout', 'obj:B:"2"'])
    expect(etags).toEqual([undefined, undefined, undefined, '"1"', '"1"', '"1"', '"1"', '"1"'])
  })
})

// ---------------------------------------------------------------- router + holder

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

function anthropicReply(): ReturnType<Script> {
  return { contentType: 'application/json', chunks: [fixture('anthropic-messages/nonstream-read.json')] }
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/v1/messages`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...hopHeaders(), ...headers },
})
const userTurn = (model: string) => ({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Fix the failing test in src/a.ts' }] })
const toolTurn = (model: string) => ({ model, max_tokens: 16, messages: [
  { role: 'user', content: 'Fix the failing test in src/a.ts' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'src/a.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'export const a = 1' }] },
] })

async function withHolder(script: Script = anthropicReply, deps: Partial<RouterDeps> = {}) {
  const fake = await startFakeBedrock(script)
  let rt: RuntimeRef | undefined
  const router = await startRouter(fake.url, { deps,
    runtime: ({ catalog: c, store, sink, policy }) => {
      rt = createRuntime(bakedDocument(policy), { catalog: c, store, sink, buildAssessor: noAssessor })
      return rt
    },
  })
  cleanups.push(fake.close, router.close)
  return { fake, router, rt: rt as RuntimeRef }
}

describe('router on the generation holder', () => {
  it('stamps configVersion and catalogVersion on model lines; a swap applies to the next request', async () => {
    const { router, rt, fake } = await withHolder()
    expect((await post(router.url, userTurn('auto'), { 'x-router-session': 's1' })).status).toBe(200)
    rt.applyDocument(doc(2, { policy: policyJson({ version: 'c2', pools: { ...policyJson().pools, 'anthropic-messages': { defaultTier: 'fast', models: policyJson().pools['anthropic-messages'].models } } }) }))
    expect((await post(router.url, userTurn('auto'), { 'x-router-session': 's2' })).status).toBe(200)
    await waitForLogs(router, 3)
    const models = router.logs.filter((l) => l.kind === 'model') as Array<Record<string, any>>
    expect(models.map((l) => [l.configVersion, l.catalogVersion, l.decision.policyVersion, l.servedModel])).toEqual([
      [BAKED_VERSION, catalog.version, 'router-test-v1', SONNET],
      ['2-20261108T010000Z', catalog.version, 'c2', HAIKU],
    ])
    expect(fake.requests.map((r) => r.json.model)).toEqual([SONNET, HAIKU])
  })

  it('an in-flight request finishes on its generation: decided and recorded on the old engine, logged with the old version', async () => {
    const fake = await startFakeBedrock(() => ({ ...anthropicReply(), headerDelayMs: 150 }))
    const calls: string[] = []
    let rt: RuntimeRef | undefined
    const router = await startRouter(fake.url, {
      runtime: ({ catalog: c, store, sink, policy }) => {
        rt = createRuntime(bakedDocument(policy), {
          catalog: c, store, sink, buildAssessor: noAssessor,
          engineFor: (pol) => {
            const e = createEngine({ policy: pol, catalog: c, store })
            return { ...e, decide: (s, x) => { calls.push(`decide:${pol.version}`); return e.decide(s, x) },
              record: (s, d, o) => { calls.push(`record:${pol.version}`); return e.record(s, d, o) } }
          },
        })
        return rt
      },
    })
    cleanups.push(fake.close, router.close)
    const pending = post(router.url, userTurn('auto'), { 'x-router-session': 's-flight' })
    while (fake.requests.length === 0) await new Promise((ok) => setTimeout(ok, 5)) // decided, upstream holds the headers
    expect((rt as RuntimeRef).applyDocument(doc(9)).outcome).toBe('applied')
    expect((await pending).status).toBe(200)
    await waitForLogs(router, 2)
    expect(calls).toEqual(['decide:router-test-v1', 'record:router-test-v1'])
    const line = router.logs.find((l) => l.kind === 'model') as Record<string, any>
    expect([line.configVersion, line.decision.policyVersion]).toEqual([BAKED_VERSION, 'router-test-v1'])
    expect((await post(router.url, userTurn('auto'), { 'x-router-session': 's-next' })).status).toBe(200)
    expect(calls.slice(2)).toEqual(['decide:c9', 'record:c9'])
  })

  it('a lineage hard-locked on a model the new policy removed keeps it (universe check), its next user turn moves; pins follow the new policy at once', async () => {
    const { router, rt, fake } = await withHolder()
    const h = { 'x-router-session': 'lock-1' }
    expect((await post(router.url, userTurn('auto'), h)).status).toBe(200) // session-start → Sonnet
    const p = policyJson({ version: 'c2' })
    p.pools['anthropic-messages'].models = p.pools['anthropic-messages'].models.filter((m: { model: string }) => m.model !== SONNET && m.model !== OPUS)
    expect(rt.applyDocument({ schemaVersion: 1, version: '2-a', policy: p }).outcome).toBe('applied')
    const tool = await post(router.url, toolTurn('auto'), h)
    expect(tool.status).toBe(200)
    expect(tool.headers.get('x-router-decision')).toBe('retain;hard-lock-tool-loop;auto')
    expect(tool.headers.get('x-router-model')).toBe(SONNET)
    const next = await post(router.url, { ...toolTurn('auto'), messages: [...toolTurn('auto').messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now also update the docs' }] }, h)
    expect(next.status).toBe(200)
    // The next non-locked decision moves it: 'ineligible' at a plain user turn, or a break point (here the fixture's
    // large cached prefix makes the short prompt read as a compaction); never a hard lock.
    expect(['ineligible', 'compaction']).toContain(next.headers.get('x-router-reason'))
    expect(next.headers.get('x-router-model')).toBe(HAIKU)
    const pin = await post(router.url, userTurn(OPUS), { 'x-router-session': 'pin-1' })
    expect(pin.status).toBe(400)
    expect(await pin.json()).toMatchObject({ code: 'pin-not-allowed' })
    expect(fake.requests.map((r) => r.json.model)).toEqual([SONNET, SONNET, HAIKU])
    await waitForLogs(router, 4)
    const lines = router.logs.filter((l) => l.kind === 'model') as Array<Record<string, any>>
    expect(lines[1]?.switchedFrom).toBeUndefined()
    expect(lines[2]?.switchedFrom).toMatchObject({ model: SONNET })
    expect(lines[2]?.switchedFrom.warmTokens).toBeGreaterThanOrEqual(0)
  })
})

describe('access caps at the router (design 0.3a, 0.16)', () => {
  const principalOf = (req: { headers: Record<string, unknown> }) => (typeof req.headers['x-test-principal'] === 'string' ? req.headers['x-test-principal'] as string : undefined)
  async function capped() {
    const h = await withHolder(anthropicReply, { principalOf: principalOf as RouterDeps['principalOf'] })
    expect(h.rt.applyDocument(doc(2, { access: { groups: { member: { maxTier: 'standard', allowPins: [OPUS] } } } })).outcome).toBe('applied')
    expect(h.rt.applyPrincipals({ 'user:m1': { group: 'member' }, 'user:m2': { group: 'member', cap: { maxTier: 'fast' } } }, '"p1"').outcome).toBe('applied')
    return h
  }
  const as = (p: string, s: string) => ({ 'x-test-principal': p, 'x-router-session': s })

  it('routing stays within the cap (access-cap on the reason); pins: allowPins above maxTier, otherwise 400 access-cap', async () => {
    const { router, fake } = await capped()
    const routed = await post(router.url, userTurn('auto:frontier'), as('user:m1', 'c1'))
    expect(routed.status).toBe(200)
    expect(routed.headers.get('x-router-model')).toBe(SONNET)
    const listed = await post(router.url, userTurn(OPUS), as('user:m1', 'c2'))
    expect(listed.status).toBe(200) // above maxTier but in allowPins
    const over = await post(router.url, userTurn(SONNET), as('user:m2', 'c3')) // m2's own cap: fast, no allowPins
    expect(over.status).toBe(400)
    expect(await over.json()).toMatchObject({ code: 'access-cap' })
    const notInPolicy = await post(router.url, userTurn('global.example.unknown'), as('user:m2', 'c4'))
    expect(await notInPolicy.json()).toMatchObject({ code: 'pin-not-allowed' }) // checked first
    const nobody = await post(router.url, userTurn('auto:frontier'), { 'x-router-session': 'c5' }) // unattributed: no cap
    expect(nobody.headers.get('x-router-model')).toBe(OPUS)
    await waitForLogs(router, 5)
    const lines = router.logs.filter((l) => l.kind === 'model') as Array<Record<string, any>>
    expect(lines[0]?.decision.reason).toMatch(/; access-cap:standard:frontier(;|$)/)
    expect(lines.filter((l) => l.reason === 'access-cap')).toHaveLength(1)
    expect(fake.requests.map((r) => r.json.model)).toEqual([SONNET, OPUS, OPUS])
  })

  it("core's AccessCapError is a 400 with its code, never a 5xx (the gateway fallback would bypass the router)", async () => {
    const fake = await startFakeBedrock(anthropicReply)
    let code: 'access-cap' | 'access-cap-context' = 'access-cap-context'
    const router = await startRouter(fake.url, {
      runtime: ({ catalog: c, store, sink, policy }) => createRuntime(bakedDocument(policy), {
        catalog: c, store, sink, buildAssessor: noAssessor,
        engineFor: (pol) => {
          const e = createEngine({ policy: pol, catalog: c, store })
          return { ...e, decide: async () => { throw new AccessCapError('anthropic-messages', code, 'test') } }
        },
      }),
    })
    cleanups.push(fake.close, router.close)
    for (const c of ['access-cap-context', 'access-cap'] as const) {
      code = c
      const r = await post(router.url, userTurn('auto'), { 'x-router-session': `cap-${c}` })
      expect(r.status).toBe(400)
      expect(await r.json()).toMatchObject({ code: c })
    }
    expect(fake.requests).toHaveLength(0)
    await waitForLogs(router, 2)
    expect(router.logs.map((l) => [l.status, l.reason, l.kind])).toEqual([[400, 'access-cap-context', 'model'], [400, 'access-cap', 'model']])
  })
})

describe('log fields: switchedFrom, decision.projected, usageMissing (0d §1.2/§1.6, design 0.3c)', () => {
  it('observe logs decision.projected next to wouldChoose', async () => {
    const { router, rt } = await withHolder()
    expect(rt.applyDocument(doc(2, { policy: policyJson({ version: 'c2', mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': 'global.openai.gpt-6.1-sol', 'openai-responses': 'global.openai.gpt-6.1-sol' } }) })).outcome).toBe('applied')
    expect((await post(router.url, userTurn('auto:fast'), { 'x-router-session': 'p1' })).status).toBe(200)
    await waitForLogs(router, 2)
    const line = router.logs.find((l) => l.kind === 'model') as Record<string, any>
    expect(line.decision).toMatchObject({ mode: 'observe', model: SONNET, wouldChoose: HAIKU, projected: { model: HAIKU, switch: false } })
  })

  it('a 2xx stream without any usage event logs usageMissing and costBoundUsd (no costUsd)', async () => {
    const sse = 'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const { router } = await withHolder(() => ({ contentType: 'text/event-stream', chunks: [sse] }))
    const body = { model: 'global.openai.gpt-6.1-sol', stream: true, max_completion_tokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }
    const r = await fetch(`${router.url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...hopHeaders() } })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    const line = router.logs.find((l) => l.kind === 'model') as Record<string, any>
    expect(line.usage).toBeUndefined()
    expect(line.costUsd).toBeUndefined()
    expect(line.usageMissing).toBe(true)
    expect(line.boundPartial).toBeUndefined()
    const sol = catalog.models.find((m) => m.modelId === 'global.openai.gpt-6.1-sol')!
    const inRate = Math.max(sol.price.input, ...Object.values(sol.price.cacheWrite).map(Number))
    expect(line.costBoundUsd).toBeGreaterThan((10_000 * inRate + 1000 * sol.price.output) / 1e6 * 0.9)
    expect(line.costBoundUsd).toBeLessThan((10_100 * inRate + 1000 * sol.price.output) / 1e6 * 1.1)
  })
})
