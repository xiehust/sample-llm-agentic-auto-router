// Test fixtures: memory ports, a seeded version 0 (the CDK-baked policy), MEMBER items (the authorization source),
// the pack archive, callers, events and a stored record in 17's ingest shape.
import { readFileSync } from 'node:fs'
import { buildManifest } from '@auto-router/assessor'
import type { ConfigDocument, GatewayInfo, HealthReport, Role } from '@auto-router/console-contract'
import { loadCatalog } from '@auto-router/pricing'
import { createHandler } from './app.ts'
import type { HttpApiEvent } from './http.ts'
import {
  MemoryClientDirectory, MemoryConsoleStore, MemoryDirectory, MemoryObjectStore, MemoryUsageStore, StaticGateway, StaticMetrics, StaticTasks,
} from './memory.ts'
import type { Deps, StoredRecord } from './ports.ts'

export const SCOPE = 'llmar/console'
export const policy = JSON.parse(readFileSync(new URL('../../router/config/policy.default.json', import.meta.url), 'utf8')) as Record<string, unknown>
export const manifest = buildManifest()
export const v22 = manifest.packs.find((p) => p.name === 'v2.2')!
export const LUNA = 'global.openai.gpt-6-luna'
export const SOL = 'global.openai.gpt-6.1-sol'
export const UNIVERSE = ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5',
  'global.openai.gpt-6-astra', SOL, LUNA]

/** The deploy-time document as RouterStack stages it (config/baked.json). */
export const BAKED = '0-baked.0123abcd'
export function baseDocument(): ConfigDocument {
  return {
    schemaVersion: 1, version: BAKED, policy: structuredClone(policy),
    assessor: { mode: 'observe', pack: 'v2.2', packVersion: v22.packVersion, model: LUNA, threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' },
    identity: { mode: 'observe' }, access: { groups: { member: { maxTier: 'standard' } } },
  }
}

export const ADMIN_SUB = 'aaaaaaaa-0000-4000-8000-a00000000001'
export const MEMBER_SUB = 'bbbbbbbb-0000-4000-8000-a00000000002'
export const OTHER_SUB = 'cccccccc-0000-4000-8000-a00000000003'
export const NOW = Date.parse('2026-11-08T12:00:00.000Z')

const gateway: GatewayInfo = {
  url: 'https://gw.example.com', id: 'gw-1', status: 'READY', authorizer: { discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration', allowedScopes: ['llmar/invoke'] },
  targets: [], rules: [], fallbackChain: [], forwardedHeaders: ['x-api-key'], cdkParameters: {},
}
const health = (range: HealthReport['range']): HealthReport => ({
  range, tasks: { running: 2, desired: 2 }, requestsPerMin: [], rate4xx: [], rate5xx: [], failovers: [], overheadP50: [], overheadP99: [], ttfbP50: [],
  ttfbP99: [], hitRate: [], switches: [], missesByReason: {}, assessor: {}, fallbackSigns: { router5xx: 0, unhealthyTargets: 0, tasksBelowDesired: false },
  config: { activeVersion: BAKED, rejections: 0 }, alarms: [],
})

export function setup() {
  const console = new MemoryConsoleStore()
  const usage = new MemoryUsageStore()
  const objects = new MemoryObjectStore()
  const directory = new MemoryDirectory()
  const clients = new MemoryClientDirectory()
  const seed = (sub: string, username: string, role: Role) => {
    directory.add({ sub, username, groups: [role], name: username })
    console.members.set(`user:${sub}`, { key: `user:${sub}`, group: role, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' })
  }
  seed(ADMIN_SUB, 'admin1', 'admin')
  seed(MEMBER_SUB, 'member1', 'member')
  seed(OTHER_SUB, 'member2', 'member')
  // Deployed state: no console version active yet, the deploy-time document in config/baked.json.
  objects.objects.set('config/baked.json', JSON.stringify(baseDocument()))
  objects.objects.set('packs/current.json', JSON.stringify(manifest))
  for (const p of manifest.packs) objects.objects.set(`packs/${p.packVersion}.json`, JSON.stringify(p))
  let t = NOW
  let id = 0
  const logs: Record<string, unknown>[] = []
  const deps: Deps = {
    console, usage, objects, directory, clients, gateway: new StaticGateway(gateway), metrics: new StaticMetrics(health), tasks: new StaticTasks(1),
    catalog: loadCatalog('ap-northeast-1'),
    env: {
      prefix: 'llmar', consoleScope: SCOPE, region: 'ap-northeast-1', gatewayUrl: 'https://gw.example.com', cognitoDomain: 'https://auth.example.com',
      tokenEndpoint: 'https://auth.example.com/oauth2/token', cliClientId: 'cliclient', invokeScope: 'llmar/invoke', callbackPorts: [53682, 53683],
      refreshDays: 30, modelUniverse: UNIVERSE,
    },
    now: () => t,
    uuid: () => `00000000-0000-4000-8000-b${String(++id).padStart(11, '0')}`,
    log: (e) => { logs.push(e) },
  }
  const handler = createHandler(deps)
  return { deps, console, usage, objects, directory, clients, logs, handler, tick: (ms: number) => { t += ms } }
}
export type Setup = ReturnType<typeof setup>

export interface As { sub: string; username?: string; groups: Role[] | string[]; scopes?: string[]; tokenUse?: string }
export const ADMIN: As = { sub: ADMIN_SUB, username: 'admin1', groups: ['admin'] }
export const MEMBER: As = { sub: MEMBER_SUB, username: 'member1', groups: ['member'] }
export const OTHER: As = { sub: OTHER_SUB, username: 'member2', groups: ['member'] }

export function ev(method: string, path: string, opts: { as?: As | null; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): HttpApiEvent {
  const as = opts.as === undefined ? ADMIN : opts.as
  return {
    rawPath: path,
    headers: { ...opts.headers },
    ...(opts.query ? { queryStringParameters: opts.query } : {}),
    ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
    requestContext: {
      requestId: 'req-1', http: { method },
      ...(as ? {
        authorizer: { jwt: {
          claims: { sub: as.sub, ...(as.username !== undefined ? { username: as.username } : {}), token_use: as.tokenUse ?? 'access', 'cognito:groups': `[${as.groups.join(' ')}]` },
          scopes: as.scopes ?? [SCOPE],
        } },
      } : {}),
    },
  }
}

export async function call(h: Setup['handler'], e: HttpApiEvent) {
  const r = await h(e)
  return { status: r.statusCode, headers: r.headers, body: r.body ? (JSON.parse(r.body) as any) : undefined }
}

export const REQ_A = '11111111-1111-4111-8111-111111111111'
export const REQ_B = '22222222-2222-4222-8222-222222222222'

/** A stored record in 17's shape (usage-ingest records.ts recordFields). */
export function record(over: Partial<StoredRecord> & { reqId: string; principal: string }): StoredRecord {
  return {
    ts: '2026-11-08T11:59:00.000Z', kind: 'model', status: 200, principalGroup: 'member', identity: 'verified', dialect: 'openai-responses',
    requested: 'auto', session: '0123456789abcdef', lineage: 'aaaaaaaaaaaaaaaa', configVersion: '0-20261108T000000Z', catalogVersion: 'cv1',
    servedModel: SOL, servedTier: 'standard', stream: true,
    usage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: { '5m': 50 }, outputTokens: 40, promptTokens: 1050 }, hitRate: 900 / 1050,
    decision: { action: 'initialize', point: 'session-start', mode: 'observe', model: SOL, reason: 'observe-default: session-start: tier=fast via rule:r1 → x', policyVersion: 'p1', wouldChoose: LUNA },
    assessor: { tier: undefined, proposedTier: 'fast', confidence: 0.9, basis: ['explore-readonly'], outcome: 'fast', applied: false, latencyMs: 900, status: 'ok', mode: 'observe', packVersion: v22.packVersion, costNano: 400_000 },
    cost: { a: 2_500_000, aStar: 2_000_000, x: 400_000 },
    overheadMs: 3, decideMs: 2, upstreamTtfbMs: 400, durationMs: 1200,
    ...over,
  }
}

/** A fresh router state line for `task` with identity keys loaded (0d-effective-config §7). */
export function keysLoaded(s: Setup, task = 't1', over: Record<string, unknown> = {}): void {
  s.usage.states.set(task, { ts: new Date(NOW - 60_000).toISOString(), task, source: 'state', outcome: 'active', identityKeys: { configured: true, loaded: true, kids: 2 }, ...over })
}
