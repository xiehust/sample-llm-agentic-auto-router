import { readFileSync } from 'node:fs'
import { loadCatalog } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'
import { TEST_GATEWAY_ARN, TEST_ROLE_ARN, TEST_VPCE, testPolicy } from './test-helpers.ts'

const POLICY = JSON.stringify(testPolicy())
const base = { ROUTER_POLICY_JSON: POLICY, ROUTER_REGION: 'ap-northeast-1' }
const issues = (env: Record<string, string>): string[] => {
  try { loadConfig(env); return [] } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as ConfigError).issues }
}

describe('loadConfig', () => {
  it('defaults to a loopback bind, fail-closed hop auth, no hints, real Bedrock upstream', () => {
    const c = loadConfig(base)
    expect(c.bind).toBe('127.0.0.1')
    expect(c.port).toBe(8080)
    expect(c.hopAuth).toEqual({ kind: 'reject' })
    expect(c.hints).toEqual({ chatIncludeUsage: 'off', claudeAutoCache: false, claudeCacheTtl: 'keep' })
    expect(c.upstream.href).toBe('https://bedrock-runtime.ap-northeast-1.amazonaws.com/')
    expect(c.maxBodyBytes).toBe(10 * 1024 * 1024)
    expect(c.timeouts).toEqual({ streamHeaderMs: 60_000, nonStreamHeaderMs: 600_000, idleMs: 240_000, heartbeatMs: 60_000, streamCapMs: 900_000 })
    expect(loadConfig({ ...base, ROUTER_SSE_HEARTBEAT_MS: '0' }).timeouts.heartbeatMs).toBe(0)
  })

  it('refuses the test bypass on any non-loopback bind', () => {
    expect(issues({ ...base, ROUTER_INBOUND_TEST_BYPASS: '1', ROUTER_BIND: '0.0.0.0' }).join()).toMatch(/BYPASS.*loopback/)
    expect(loadConfig({ ...base, ROUTER_INBOUND_TEST_BYPASS: '1' }).hopAuth).toEqual({ kind: 'test-bypass' })
    expect(issues({ ...base, ROUTER_INBOUND_TEST_BYPASS: '1', ROUTER_HOP_AUTH: 'apigw-iam' }).join()).toMatch(/mutually exclusive/)
  })

  it('requires both ARNs and the VPC endpoint for apigw-iam, and rejects unknown or retired hop auth', () => {
    expect(issues({ ...base, ROUTER_HOP_AUTH: 'apigw-iam' })).toHaveLength(3)
    const c = loadConfig({ ...base, ROUTER_HOP_AUTH: 'apigw-iam', ROUTER_GATEWAY_ROLE_ARN: TEST_ROLE_ARN, ROUTER_GATEWAY_ARN: TEST_GATEWAY_ARN, ROUTER_API_VPCE_ID: TEST_VPCE })
    expect(c.hopAuth).toEqual({ kind: 'apigw-iam', gatewayRoleArn: TEST_ROLE_ARN, gatewayArn: TEST_GATEWAY_ARN, vpceId: TEST_VPCE })
    expect(issues({ ...base, ROUTER_HOP_AUTH: 'api-key' }).join()).toMatch(/unsupported/)
    expect(issues({ ...base, ROUTER_HOP_AUTH: 'lattice-iam' }).join()).toMatch(/unsupported/)
    expect(issues({ ...base, ROUTER_HOP_AUTH: 'apigw-iam', ROUTER_GATEWAY_ROLE_ARN: TEST_ROLE_ARN, ROUTER_GATEWAY_ARN: TEST_GATEWAY_ARN, ROUTER_API_VPCE_ID: 'vpce-x' }).join()).toMatch(/VPCE/)
  })

  it('allows plain http upstream only on loopback hosts', () => {
    expect(loadConfig({ ...base, ROUTER_UPSTREAM_URL: 'http://127.0.0.1:9999' }).upstream.port).toBe('9999')
    expect(issues({ ...base, ROUTER_UPSTREAM_URL: 'http://10.0.0.5:80' }).join()).toMatch(/loopback/)
    // Signed requests (with the task session token) never leave for an arbitrary https host.
    expect(issues({ ...base, ROUTER_UPSTREAM_URL: 'https://example.com' }).join()).toMatch(/bedrock-runtime/)
    expect(loadConfig({ ...base, ROUTER_UPSTREAM_URL: 'https://bedrock-runtime.us-west-2.amazonaws.com' }).upstream.hostname).toBe('bedrock-runtime.us-west-2.amazonaws.com')
  })

  it('validates hints, the policy and fault injection, listing every issue', () => {
    const got = issues({ ROUTER_HINTS: '{"chatIncludeUsage":"always","nope":1}', ROUTER_FAULT_INJECT: 'router-503', ROUTER_PORT: 'x' })
    expect(got.join('\n')).toMatch(/chatIncludeUsage/)
    expect(got.join('\n')).toMatch(/nope: unknown hint/)
    expect(got.join('\n')).toMatch(/FAULT_INJECT_ALLOW/)
    expect(got.join('\n')).toMatch(/ROUTER_PORT/)
    expect(got.join('\n')).toMatch(/POLICY/)
    expect(loadConfig({ ...base, ROUTER_FAULT_INJECT: 'router-503', ROUTER_FAULT_INJECT_ALLOW: '1' }).fault).toBe('router-503')
    expect(loadConfig({ ...base, ROUTER_FAULT_INJECT: 'upstream-503-once:2', ROUTER_FAULT_INJECT_ALLOW: '1' }).fault).toBe('upstream-503-once:2')
    expect(() => loadConfig({ ...base, ROUTER_FAULT_INJECT: 'upstream-503-once:0', ROUTER_FAULT_INJECT_ALLOW: '1' })).toThrow(/ROUTER_FAULT_INJECT/)
    expect(loadConfig({ ...base, ROUTER_HINTS: '{"chatIncludeUsage":"inject-strip"}' }).hints.chatIncludeUsage).toBe('inject-strip')
  })
})

describe('region, catalog and policy (publishable: no built-in region)', () => {
  const read = (f: string) => readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8')
  const DEFAULT = read('policy.default.json')

  it('requires a region: ROUTER_REGION, else AWS_REGION / AWS_DEFAULT_REGION', () => {
    expect(issues({ ROUTER_POLICY_JSON: DEFAULT }).join()).toMatch(/ROUTER_REGION \(or AWS_REGION\): AWS region required/)
    expect(loadConfig({ ROUTER_POLICY_JSON: DEFAULT, AWS_REGION: 'ap-southeast-1' }).region).toBe('ap-southeast-1')
    expect(loadConfig({ ROUTER_POLICY_JSON: DEFAULT, AWS_DEFAULT_REGION: 'ap-southeast-1' }).upstream.href).toBe('https://bedrock-runtime.ap-southeast-1.amazonaws.com/')
    expect(loadConfig({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: 'ap-southeast-1', AWS_REGION: 'ap-northeast-1' }).region).toBe('ap-southeast-1')
  })

  it('selects the bundled catalog of the region, and fails fast for a region without one', () => {
    for (const r of ['ap-northeast-1', 'ap-southeast-1']) expect(loadConfig({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: r }).catalog.region).toBe(r)
    expect(issues({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: 'eu-west-9' }).join()).toMatch(/no bundled price catalog for region 'eu-west-9'/)
  })

  it('accepts ROUTER_CATALOG_FILE for a self-captured region only when its region matches', () => {
    const sg = JSON.stringify({ ...loadCatalog('ap-southeast-1'), region: 'eu-west-9' })
    const files: Record<string, string> = { '/cat.json': sg }
    const c = loadConfig({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: 'eu-west-9', ROUTER_CATALOG_FILE: '/cat.json' }, (f) => files[f] as string)
    expect(c.catalog.region).toBe('eu-west-9')
    try { loadConfig({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: 'ap-southeast-1', ROUTER_CATALOG_FILE: '/cat.json' }, (f) => files[f] as string); expect.unreachable() }
    catch (e) { expect((e as ConfigError).issues.join()).toMatch(/catalog region 'eu-west-9' is not ROUTER_REGION 'ap-southeast-1'/)
    expect(loadConfig({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: 'eu-west-9', ROUTER_CATALOG_JSON: sg }).catalog.region).toBe('eu-west-9') }
    files['/bad.json'] = '{"region":"x"}'
    expect(() => loadConfig({ ROUTER_POLICY_JSON: DEFAULT, ROUTER_REGION: 'ap-southeast-1', ROUTER_CATALOG_FILE: '/bad.json' }, (f) => files[f] as string)).toThrow(/catalog/)
  })

  it('validates the policy against the region catalog: the Tokyo example (jp. failovers) is refused in Singapore', () => {
    const tokyo = read('policy.example.ap-northeast-1.json')
    expect(loadConfig({ ROUTER_POLICY_JSON: tokyo, ROUTER_REGION: 'ap-northeast-1' }).policy.pools['anthropic-messages']?.models[0]?.failover).toEqual(['jp.anthropic.claude-opus-5-5'])
    try { loadConfig({ ROUTER_POLICY_JSON: tokyo, ROUTER_REGION: 'ap-southeast-1' }); expect.unreachable() }
    catch (e) { expect((e as ConfigError).issues.join()).toMatch(/policy vs ap-southeast-1 catalog:.*jp\.anthropic\.claude-opus-5-5' not in catalog/s) }
  })
})

describe('shipped default policy (config/policy.default.json)', () => {
  it('loads, is observe mode, and serves the gateway fallback models for alias requests', async () => {
    const raw = readFileSync(new URL('../config/policy.default.json', import.meta.url), 'utf8')
    const c = loadConfig({ ROUTER_POLICY_JSON: raw, ROUTER_REGION: 'ap-southeast-1' })
    expect(raw).not.toMatch(/"(jp|us|eu|apac)\./) // global profiles only; region-specific failovers live in the examples
    const { createEngine, InMemoryStateStore } = await import('@auto-router/core')
    expect(() => createEngine({ policy: c.policy, catalog: c.catalog, store: new InMemoryStateStore() })).not.toThrow()
    expect(c.policy.mode).toBe('observe')
    expect(c.policy.observeDefaults).toEqual({
      'anthropic-messages': 'global.anthropic.claude-sonnet-5-5', 'openai-chat': 'global.openai.gpt-6.1-sol', 'openai-responses': 'global.openai.gpt-6.1-sol',
    })
  })
})
