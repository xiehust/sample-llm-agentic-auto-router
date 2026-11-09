// The baked document (0d research 0d-effective-config.md): one function for the router's generation 0 and the deploy's
// config/baked.json; config lines report effective settings and their sources (codes and versions only).
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryStateStore } from '@auto-router/core'
import { createAssessorRuntime, settingsView } from './assessor-runtime.ts'
import { ASSESSOR_DEFAULTS, loadConfig, packInfos } from './config.ts'
import { createRuntime } from './runtime.ts'
import {
  ASSESSOR_ENV_DEFAULTS, bakedAssessorBlock, bakedConfigDocument, bakedDocument, canonicalJson, isBakedVersion, parseConfigVersion,
  validateConfigDocument, type BakedEnv,
} from './settings.ts'
import { testPolicy } from './test-helpers.ts'

const sha = (t: string): string => createHash('sha256').update(t).digest('hex')
/** The env RouterStack sets for the current deploy (infra defaults: identity observe, assessor observe, pack/model defaults). */
const DEPLOY_ENV = {
  ROUTER_POLICY_JSON: JSON.stringify(testPolicy()), ROUTER_REGION: 'ap-northeast-1', ROUTER_CONFIG_BUCKET: 'llmar-config-test',
  ROUTER_IDENTITY_MODE: 'observe', ROUTER_IDENTITY_HEADER: 'x-api-key', ROUTER_IDENTITY_ISSUER: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_Example1',
  ROUTER_IDENTITY_SCOPE: 'llmar/invoke', ROUTER_ASSESSOR_MODE: 'observe',
}

describe('canonicalJson', () => {
  it('sorts keys at every level, keeps array order, drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([undefined, null, 'x'])).toBe('[null,null,"x"]')
    expect(canonicalJson('s')).toBe('"s"')
  })
})

describe('bakedAssessorBlock', () => {
  const packs = [{ name: 'v2.2', packVersion: 'assessor/v2.2+e2183dce2cb9', autoCapable: false }]
  it('off unless the env mode is observe or auto; otherwise every field, with the router defaults and the bundled packVersion', () => {
    expect(bakedAssessorBlock({}, packs)).toEqual({ mode: 'off' })
    expect(bakedAssessorBlock({ ROUTER_ASSESSOR_MODE: 'off', ROUTER_ASSESSOR_PACK: 'v1' }, packs)).toEqual({ mode: 'off' })
    expect(bakedAssessorBlock({ ROUTER_ASSESSOR_MODE: 'observe' }, packs)).toEqual({
      mode: 'observe', pack: 'v2.2', packVersion: 'assessor/v2.2+e2183dce2cb9', model: 'global.openai.gpt-6-luna', threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' })
    expect(bakedAssessorBlock({ ROUTER_ASSESSOR_MODE: 'auto', ROUTER_ASSESSOR_THRESHOLD: '0.9', ROUTER_ASSESSOR_TIMEOUT_MS: '3000', ROUTER_ASSESSOR_AUTO_RULES: 'all', ROUTER_ASSESSOR_PACK: 'v9' }, packs))
      .toEqual({ mode: 'auto', pack: 'v9', model: 'global.openai.gpt-6-luna', threshold: 0.9, timeoutMs: 3000, autoRules: 'all' }) // unknown pack: no packVersion
  })
  it('its defaults equal the router\'s ASSESSOR_DEFAULTS', () => {
    expect({ ...ASSESSOR_ENV_DEFAULTS }).toEqual({ ...ASSESSOR_DEFAULTS })
  })
})

describe('bakedConfigDocument', () => {
  const config = loadConfig(DEPLOY_ENV)
  const packs = packInfos(config.packs ?? new Map())
  const doc = bakedConfigDocument({ policy: config.policy, env: DEPLOY_ENV, packs }, sha)

  it('is a complete, valid document with a content-addressed 0-baked.<sha8> version (n = 0)', () => {
    expect(doc.version).toMatch(/^0-baked\.[0-9a-f]{8}$/)
    expect(parseConfigVersion(doc.version)).toBe(0)
    expect(isBakedVersion(doc.version)).toBe(true)
    expect(isBakedVersion('0-baked')).toBe(true) // legacy lines stay readable
    expect(isBakedVersion('1-baked')).toBe(false)
    expect(doc).toMatchObject({ schemaVersion: 1, seq: 0, identity: { mode: 'observe' }, access: { groups: {} },
      assessor: { mode: 'observe', pack: 'v2.2', model: 'global.openai.gpt-6-luna', threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' } })
    const { seq: _s, ...stored } = doc
    expect(validateConfigDocument(stored, config.catalog)).toMatchObject({ ok: true, value: { version: doc.version } })
  })

  it('the version depends on the content only (key order is irrelevant); any section change gives a new version', () => {
    const reverse = (v: unknown): unknown => (Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse((v as Record<string, unknown>)[k])])) : v)
    const reordered = reverse(config.policy) as typeof config.policy
    expect(Object.keys(reordered)).toEqual(Object.keys(config.policy).reverse())
    expect(bakedConfigDocument({ policy: reordered, env: DEPLOY_ENV, packs }, sha).version).toBe(doc.version)
    const variants: BakedEnv[] = [{ ...DEPLOY_ENV, ROUTER_IDENTITY_MODE: 'require' }, { ...DEPLOY_ENV, ROUTER_ASSESSOR_MODE: 'off' }, { ...DEPLOY_ENV, ROUTER_ASSESSOR_THRESHOLD: '0.85' }]
    for (const env of variants) expect(bakedConfigDocument({ policy: config.policy, env, packs }, sha).version).not.toBe(doc.version)
    expect(bakedConfigDocument({ policy: { ...config.policy, version: 'other' }, env: DEPLOY_ENV, packs }, sha).version).not.toBe(doc.version)
  })

  it('identity not configured → off', () => {
    expect(bakedConfigDocument({ policy: config.policy, env: {}, packs }, sha).identity).toEqual({ mode: 'off' })
  })
})

describe('generation 0 from the baked document', () => {
  const config = loadConfig(DEPLOY_ENV)
  const packs = config.packs ?? new Map()
  const assessors = createAssessorRuntime({ env: config.assessor, packs, catalog: config.catalog,
    transport: async () => { throw new Error('no upstream in tests') } })
  const runtimeOf = (boot: Parameters<typeof createRuntime>[0], lines: Record<string, unknown>[]) => createRuntime(boot, {
    catalog: config.catalog, store: new InMemoryStateStore(), sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    buildAssessor: assessors.build, lineFields: [assessors.lineFields] })

  it('behaves exactly like the legacy boot for the deploy env: same policy, identity observe, assessor observe/v2.2/luna, no caps', () => {
    const legacy = runtimeOf(bakedDocument(config.policy), []).current()
    const g = runtimeOf(bakedConfigDocument({ policy: config.policy, env: DEPLOY_ENV, packs: packInfos(packs) }, sha), []).current()
    expect(g.policy).toEqual(legacy.policy)
    expect([...g.pinAllowed].sort()).toEqual([...legacy.pinAllowed].sort())
    expect([...g.aliases].sort()).toEqual([...legacy.aliases].sort())
    // Identity: the server's mode for a generation is document.identity.mode ?? env mode.
    expect(g.document.identity?.mode ?? config.identity?.mode).toBe(legacy.document.identity?.mode ?? config.identity?.mode)
    expect(g.document.identity?.mode).toBe('observe')
    // Assessor: the very same instance (same settings key), so core's consultation id and reuse are unchanged.
    expect(g.assessor).toBe(legacy.assessor)
    expect(settingsView(g.assessor)).toMatchObject({ mode: 'observe', pack: 'v2.2', model: 'global.openai.gpt-6-luna', threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' })
    expect(g.document.access).toEqual({ groups: {} })
    expect(g.engine).not.toBe(legacy.engine) // separate runtimes; same inputs
  })

  it('config lines carry effective settings and per-section sources (codes and versions only)', () => {
    const lines: Record<string, unknown>[] = []
    const baked = bakedConfigDocument({ policy: config.policy, env: DEPLOY_ENV, packs: packInfos(packs) }, sha)
    const rt = runtimeOf(baked, lines)
    rt.log('boot', 'active')
    expect(lines[0]).toMatchObject({
      configVersion: baked.version,
      effective: { identityMode: 'observe', assessorMode: 'observe', policyVersion: config.policy.version, mode: config.policy.mode },
      sources: { policy: 'baked', identity: 'baked', assessor: 'baked', access: 'baked' },
    })
    // A document with a policy only: the other sections stay baked, and say so.
    const policy = JSON.parse(JSON.stringify(config.policy)) as Record<string, unknown>
    expect(rt.applyDocument({ schemaVersion: 1, version: '1-a', policy: { ...policy, version: 'c1' } }).outcome).toBe('applied')
    expect(lines.at(-1)).toMatchObject({
      configVersion: '1-a', effective: { identityMode: 'observe', assessorMode: 'observe', policyVersion: 'c1' },
      sources: { policy: 'document', identity: 'baked', assessor: 'baked', access: 'baked' },
    })
    // A full document overrides each section.
    expect(rt.applyDocument({ schemaVersion: 1, version: '2-a', policy: { ...policy, version: 'c2' }, identity: { mode: 'require' }, assessor: { mode: 'off' }, access: { groups: {} } }).outcome).toBe('applied')
    expect(lines.at(-1)).toMatchObject({
      effective: { identityMode: 'require', assessorMode: 'off', policyVersion: 'c2' },
      sources: { policy: 'document', identity: 'document', assessor: 'document', access: 'document' },
    })
    for (const l of lines) {
      const values = [...Object.values(l.effective as object), ...Object.values(l.sources as object)]
      expect(values.every((v) => typeof v === 'string' && v.length <= 80)).toBe(true)
    }
  })
})
