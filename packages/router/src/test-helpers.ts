// Test-only helpers: a fake bedrock-runtime on 127.0.0.1 that replays the pricing fixtures, and a router
// started on 127.0.0.1:0 with a fake signer. Excluded from the build.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine, InMemoryStateStore, validatePolicy, type Engine, type EngineOptions, type PolicyInput } from '@auto-router/core'
import { loadCatalog } from '@auto-router/pricing'
import { DEFAULT_TIMEOUTS, type HopAuth, type Hints, type RouterConfig, type Timeouts } from './config.ts'
import type { Signer } from './forward.ts'
import { createRouter, type RouterDeps } from './server.ts'

export const fixtureDir = new URL('../../pricing/src/__fixtures__/', import.meta.url)
export const fixture = (path: string): string => readFileSync(new URL(path, fixtureDir), 'utf8')

export const TEST_ROLE_ARN = 'arn:aws:iam::000000000000:role/llmar-gateway-role'
export const TEST_GATEWAY_ARN = 'arn:aws:bedrock-agentcore:ap-northeast-1:000000000000:gateway/llmar-gw-abc123'
export const TEST_VPCE = 'vpce-0123456789abcdef0'
/** Headers API Gateway sets on the integration request (identity mapping) plus the gateway's x-amz-source-arn. */
export const hopHeaders = (role = 'llmar-gateway-role', gateway = TEST_GATEWAY_ARN, vpce = TEST_VPCE): Record<string, string> => ({
  'x-router-caller-arn': `arn:aws:sts::000000000000:assumed-role/${role}/gw-session`,
  'x-router-source-vpce': vpce,
  'x-amz-source-arn': gateway,
})

export const HAIKU = 'global.anthropic.claude-haiku-5-5'
export const HAIKU_JP = 'jp.anthropic.claude-haiku-5-5'
export const LUNA = 'global.openai.gpt-6-luna'

export function testPolicy(over: Partial<PolicyInput> = {}) {
  const openai = { defaultTier: 'standard' as const, models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' as const },
    { model: 'global.openai.gpt-6.1-sol', tier: 'standard' as const },
    { model: LUNA, tier: 'fast' as const },
  ] }
  return validatePolicy({
    schemaVersion: 1, version: 'router-test-v1', mode: 'auto',
    pools: {
      'anthropic-messages': { defaultTier: 'standard', models: [
        { model: 'global.anthropic.claude-opus-5-5' },
        { model: 'global.anthropic.claude-sonnet-5-5' },
        { model: HAIKU, failover: [HAIKU_JP] },
      ] },
      'openai-chat': openai,
      'openai-responses': openai,
    },
    ...over,
  })
}

export const fakeSigner: Signer = {
  async sign({ headers }) { return { ...headers, authorization: 'AWS4-HMAC-SHA256 FAKE-SIG', 'x-amz-date': '20261104T000000Z' } },
}

// ---------------------------------------------------------------- fake bedrock-runtime

export interface Recorded { path: string; headers: IncomingHttpHeaders; body: string; json: Record<string, unknown>; closedEarly: boolean }
export interface Reply {
  status?: number
  contentType?: string
  /** Written in order with `delayMs` between them. */
  chunks: string[]
  delayMs?: number
  /** Destroy the socket after this many chunks (mid-stream failure). */
  destroyAfter?: number
  /** Wait this long before sending the status line and headers. */
  headerDelayMs?: number
}
export type Script = (r: Recorded) => Reply

/** Splits a fixture into odd-sized chunks so frame boundaries never line up with network chunks. */
export function chop(text: string, size = 37): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

export async function startFakeBedrock(script: Script): Promise<{ url: URL; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res: ServerResponse) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(parts).toString('utf8')
      const rec: Recorded = { path: req.url ?? '', headers: req.headers, body, json: JSON.parse(body) as Record<string, unknown>, closedEarly: false }
      requests.push(rec)
      res.on('close', () => { if (!res.writableFinished) rec.closedEarly = true })
      const r = script(rec)
      if (r.headerDelayMs) await new Promise((ok) => setTimeout(ok, r.headerDelayMs))
      if (res.destroyed) return
      res.writeHead(r.status ?? 200, { 'content-type': r.contentType ?? 'application/json', 'x-amzn-requestid': 'req-SCRUBBED' })
      res.flushHeaders()
      for (let i = 0; i < r.chunks.length; i++) {
        if (r.destroyAfter !== undefined && i === r.destroyAfter) { res.destroy(); return }
        if (res.destroyed) return
        res.write(r.chunks[i])
        if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs))
      }
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}

// ---------------------------------------------------------------- router under test

export interface TestRouter { url: string; logs: Record<string, unknown>[]; lines: string[]; engine: Engine; close(): Promise<void> }

export async function startRouter(upstream: URL, opts: { hopAuth?: HopAuth; hints?: Partial<Hints>; policy?: ReturnType<typeof testPolicy>;
  maxBodyBytes?: number; fault?: RouterConfig['fault']; deps?: Partial<RouterDeps>; wrapEngine?: (e: Engine) => Engine; engineOptions?: Partial<EngineOptions>; timeouts?: Partial<Timeouts>; region?: string } = {}): Promise<TestRouter> {
  const policy = opts.policy ?? testPolicy()
  const region = opts.region ?? 'ap-northeast-1'
  const catalog = loadCatalog(region)
  const config: RouterConfig = {
    bind: '127.0.0.1', port: 0, maxBodyBytes: opts.maxBodyBytes ?? 16 * 1024 * 1024, region, upstream,
    hopAuth: opts.hopAuth ?? { kind: 'apigw-iam', gatewayRoleArn: TEST_ROLE_ARN, gatewayArn: TEST_GATEWAY_ARN, vpceId: TEST_VPCE },
    hints: { chatIncludeUsage: 'off', claudeAutoCache: false, claudeCacheTtl: 'keep', ...opts.hints },
    policy, catalog, fault: opts.fault ?? 'none', timeouts: { ...DEFAULT_TIMEOUTS, ...opts.timeouts },
  }
  const store = new InMemoryStateStore()
  const real = createEngine({ policy, catalog, store, ...opts.engineOptions })
  const engine = opts.wrapEngine ? opts.wrapEngine(real) : real
  const lines: string[] = []
  const logs: Record<string, unknown>[] = []
  const { server } = createRouter({
    config, engine, store, signer: fakeSigner, sleep: async () => undefined,
    sink: (l) => { lines.push(l); const o = JSON.parse(l) as Record<string, unknown>; if (!('_aws' in o)) logs.push(o) },
    ...opts.deps,
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`, logs, lines, engine,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}

/** Waits until the router has written `n` request logs (records happen after the response ends). */
export async function waitForLogs(r: TestRouter, n: number, timeoutMs = 3000): Promise<void> {
  const t = Date.now()
  while (r.logs.length < n) {
    if (Date.now() - t > timeoutMs) throw new Error(`expected ${n} logs, got ${r.logs.length}`)
    await new Promise((ok) => setTimeout(ok, 10))
  }
}
