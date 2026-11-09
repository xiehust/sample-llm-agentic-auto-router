// Mock end-to-end, router side (4f, design-harness §5.4): the REAL router (createRouter, policy.experiment-cc or
// $LLMAR_E2E_POLICY, Bedrock compatibility, core with sessionTier) behind a loopback shim that plays the gateway, in
// front of a scripted fake bedrock-runtime /anthropic/v1/messages, with a fake tier assessor. The shim enforces the
// gateway's rules as deployed (infra/src/stack.ts): only body model `auto` / `auto:*` reaches the router (RouteAuto);
// anything else, and any router 5xx, goes to the fallback, which here answers 403 without router headers (the real
// one is the Bedrock connector: no sanitizing, no Opus); only REQUEST_HEADERS / RESPONSE_HEADERS (read from stack.ts)
// cross it. Then API Gateway's part: /inference stripped, identity headers set. Every gateway decision is logged.
// Loopback only, no AWS, no credentials. Run with node (type stripping), from anywhere:
//   node experiments/claude-code-harbor/e2e/mock_router.ts <logs.jsonl> <bedrock.jsonl> <assessor tier> [<assessor.jsonl> [<gateway.jsonl>]]
// Prints {"port": N} once listening.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine, InMemoryStateStore, validatePolicy, type AssessorResult, type TierAssessor } from '../../../packages/core/src/index.ts'
import { loadCatalog } from '../../../packages/pricing/src/index.ts'
import { buildCard } from '../../../packages/assessor/src/index.ts'
import { createRouter, DEFAULT_TIMEOUTS, type RouterConfig, type Signer } from '../../../packages/router/src/index.ts'

const [logsPath, bedrockPath, tier, assessorPath, gatewayPath] = process.argv.slice(2) as [string, string, 'fast' | 'standard' | 'frontier', string | undefined, string | undefined]
const REGION = 'ap-southeast-1'
const ACCT = '0'.repeat(12)   // a placeholder account, built at run time (N5: no 12-digit runs in committed files)
const ROLE = `arn:aws:iam::${ACCT}:role/llmar-gateway-role`
const GW = `arn:aws:bedrock-agentcore:ap-southeast-1:${ACCT}:gateway/llmar-gw-mock`
const VPCE = 'vpce-0123456789abcdef0'
// The gateway's header allowlists, read from the stack (not imported: that would load aws-cdk-lib).
const STACK = readFileSync(new URL('../../../infra/src/stack.ts', import.meta.url), 'utf8')
const listOf = (name: string): string[] => {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(STACK)
  if (!m) throw new Error(`stack.ts: ${name} not found`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
const GW_REQUEST_HEADERS = listOf('REQUEST_HEADERS')
const GW_RESPONSE_HEADERS = listOf('RESPONSE_HEADERS')
const gwLog = (o: object) => { if (gatewayPath) appendFileSync(gatewayPath, JSON.stringify({ at: Date.now(), ...o }) + '\n') }

// ---------------------------------------------------------------- fake bedrock-runtime (scripted Claude Code session)
type Body = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }>; system?: Array<{ text?: string }> }
const compacted = new Set<string>()
const sse = (events: object[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
function reply(model: string, block: object, stop: string, inputTokens: number): string {
  const usage = { input_tokens: 3, cache_read_input_tokens: inputTokens, cache_creation_input_tokens: 400,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 }, output_tokens: 1 }
  const isTool = (block as { type: string }).type === 'tool_use'
  const start = isTool ? { ...block, input: {} } : { type: 'text', text: '' }
  const delta = isTool ? { type: 'input_json_delta', partial_json: JSON.stringify((block as { input: unknown }).input) } : { type: 'text_delta', text: (block as { text: string }).text }
  return sse([{ type: 'message_start', message: { id: `msg_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage } },
    { type: 'content_block_start', index: 0, content_block: start }, { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 30 } }, { type: 'message_stop' }])
}
function script(b: Body, model: string): string {
  const sys = (b.system ?? []).at(-1)?.text ?? ''
  const last = JSON.stringify(b.messages?.at(-1) ?? {})
  const sessionKey = String(((b.metadata as { user_id?: string } | undefined)?.user_id) ?? '')
  if (!b.tools || /You are (a file search specialist|a software architect|an agent for Claude Code)/.test(sys.trim().slice(0, 80))) {
    return reply(model, { type: 'text', text: 'Found it.' }, 'end_turn', 2000)
  }
  if (last.includes('Respond with TEXT ONLY')) { compacted.add(sessionKey); return reply(model, { type: 'text', text: 'Summary of the work so far.' }, 'end_turn', 2000) }
  if (compacted.has(sessionKey)) return reply(model, { type: 'text', text: 'Done.' }, 'end_turn', 2000)
  const used = new Set<string>()
  for (const m of b.messages ?? []) if (m.role === 'assistant' && Array.isArray(m.content)) for (const c of m.content as Array<{ type: string; id?: string }>) if (c.type === 'tool_use' && c.id) used.add(c.id)
  const steps: Array<[string, string, object]> = [
    ['b1', 'Bash', { command: 'ls', description: 'List files' }],
    ['a1', 'Agent', { description: 'Find code', prompt: 'Find where add is defined.', subagent_type: 'Explore' }],
    ['a2', 'Agent', { description: 'Check tests', prompt: 'Check whether tests exist.', subagent_type: 'general-purpose' }],
    ['a3', 'Agent', { description: 'Plan the fix', prompt: 'Plan how to fix add.', subagent_type: 'Plan' }],
    ['b2', 'Bash', { command: 'cat calc.py', description: 'Show file' }],
  ]
  for (const [id, name, input] of steps) {
    if (!used.has(id)) return reply(model, { type: 'tool_use', id, name, input }, 'tool_use', id === 'b2' ? 995_000 : 3000)
  }
  return reply(model, { type: 'text', text: 'Done.' }, 'end_turn', 3000)
}
const bedrock = createServer((req, res) => {
  const parts: Buffer[] = []
  req.on('data', (c: Buffer) => parts.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(parts).toString('utf8')
    const b = JSON.parse(raw) as Body
    const model = String(b.model)
    appendFileSync(bedrockPath, JSON.stringify({ path: req.url, model, beta: req.headers['anthropic-beta'] ?? null, user_id: (b.metadata as { user_id?: string } | undefined)?.user_id ?? null }) + '\n')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-amzn-requestid': 'req-mock' })
    res.end(script(b, model))
  })
})

// ---------------------------------------------------------------- the real router, gateway shim in front
const assessor: TierAssessor = { id: `fake/v1@${tier}`, assess: async (): Promise<AssessorResult> => {
  if (assessorPath) appendFileSync(assessorPath, JSON.stringify({ at: Date.now(), tier }) + '\n')
  return { status: 'ok', tier, confidence: 0.95, audit: {}, latencyMs: 1 }
} }
const policyFile = process.env.LLMAR_E2E_POLICY ?? 'policy.experiment-cc.ap-southeast-1.json'
const policy = validatePolicy(JSON.parse(readFileSync(new URL(`../../../packages/router/config/${policyFile}`, import.meta.url), 'utf8')))
const catalog = loadCatalog(REGION)
const store = new InMemoryStateStore()
const assessorMode = (process.env.LLMAR_E2E_ASSESSOR_MODE ?? 'auto') as 'auto' | 'observe' | 'off'
const engine = createEngine({ policy, catalog, store, assessor, assessorMode, assessorDowngradeFrom: ['standard', 'frontier'] })
const fakeSigner: Signer = { async sign({ headers }) { return { ...headers, authorization: 'AWS4-HMAC-SHA256 FAKE', 'x-amz-date': '20261107T000000Z' } } }

bedrock.listen(0, '127.0.0.1', () => {
  const upstream = new URL(`http://127.0.0.1:${(bedrock.address() as AddressInfo).port}`)
  const config: RouterConfig = {
    bind: '127.0.0.1', port: 0, maxBodyBytes: 10 * 1024 * 1024, region: REGION, upstream,
    hopAuth: { kind: 'apigw-iam', gatewayRoleArn: ROLE, gatewayArn: GW, vpceId: VPCE },
    hints: { chatIncludeUsage: 'off', claudeAutoCache: false, claudeCacheTtl: 'keep' },
    policy, catalog, fault: 'none', timeouts: { ...DEFAULT_TIMEOUTS }, assessor: { mode: 'off' },
  }
  const router = createRouter({ config, engine, store, signer: fakeSigner, card: (s, b, ctx) => buildCard(s, b, ctx),
    sink: (line: string) => { if (!line.includes('"_aws"')) appendFileSync(logsPath, line + '\n') } })
  // API Gateway → NLB → router: /inference stripped, the identity headers set, the client's authorization dropped.
  const apigw = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.url = (req.url ?? '/').replace(/^\/inference/, '')
    Object.assign(req.headers, { 'x-router-caller-arn': `arn:aws:sts::${ACCT}:assumed-role/llmar-gateway-role/gw`, 'x-router-source-vpce': VPCE, 'x-amz-source-arn': GW })
    delete req.headers.authorization
    void router.handle(req, res)
  })
  apigw.listen(0, '127.0.0.1')
  // AgentCore gateway: RouteAuto (auto / auto:* → router), else the fallback; a router 5xx falls back too.
  const fallback = (res: ServerResponse, why: string, model: string, session: unknown) => {
    gwLog({ routed: false, why, model, session: typeof session === 'string' ? session : null })
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'mock gateway fallback: not served by the router' }))
  }
  const gw = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(parts)
      let model = ''
      try { model = String((JSON.parse(raw.toString('utf8')) as { model?: unknown }).model ?? '') } catch { model = '' }
      if (req.method === 'POST' && !(model === 'auto' || model.startsWith('auto:'))) { fallback(res, 'model-not-auto', model.slice(0, 80), req.headers['x-router-session']); return }
      const headers: Record<string, string> = { 'content-type': String(req.headers['content-type'] ?? 'application/json'), 'content-length': String(raw.length) }
      for (const h of GW_REQUEST_HEADERS) { const v = req.headers[h]; if (typeof v === 'string') headers[h] = v }
      const port = (apigw.address() as AddressInfo).port
      const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
        if ((r.statusCode ?? 502) >= 500) { r.resume(); fallback(res, `router-${r.statusCode}`, model, headers['x-router-session']); return }
        const out: Record<string, string> = {}
        for (const h of ['content-type', ...GW_RESPONSE_HEADERS]) { const v = r.headers[h]; if (typeof v === 'string') out[h] = v }
        gwLog({ routed: true, session: headers['x-router-session'] ?? null, model, hint: headers['x-router-hint'] ?? null, status: r.statusCode, served: out['x-router-model'] ?? null })
        res.writeHead(r.statusCode ?? 502, out)
        r.pipe(res)
      })
      up.on('error', () => fallback(res, 'router-unreachable', model, headers['x-router-session']))
      up.end(raw)
    })
  })
  gw.listen(0, '127.0.0.1', () => { process.stdout.write(JSON.stringify({ port: (gw.address() as AddressInfo).port }) + '\n') })
})
