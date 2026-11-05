// Host smoke test (implement.md step 5): runs the real entrypoint (src/main.ts) on 127.0.0.1 with the loopback-only
// test bypass, the real SigV4 signer (dummy env credentials, never real ones) and a fake bedrock-runtime on
// 127.0.0.1 that replays the pricing fixtures. No AWS calls, no non-loopback listener.
//   node packages/router/scripts/smoke.ts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chop, fixture, startFakeBedrock } from '../src/test-helpers.ts'

// Any bundled catalog region works offline; override with SMOKE_REGION.
const REGION = process.env.SMOKE_REGION ?? 'ap-southeast-1'

const cases = [
  { path: '/v1/messages', up: '/anthropic/v1/messages', fx: 'anthropic-messages', model: 'auto', extra: {} },
  { path: '/v1/chat/completions', up: '/openai/v1/chat/completions', fx: 'openai-chat', model: 'auto', extra: {} },
  { path: '/v1/responses', up: '/openai/v1/responses', fx: 'openai-responses', model: 'auto', extra: { store: false } },
]

const fake = await startFakeBedrock((r) => {
  const stream = r.json.stream === true
  const c = cases.find((x) => x.up === r.path)
  if (!c) return { status: 404, chunks: ['{}'] }
  if (!new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDSMOKETEST/\\d{8}/${REGION}/bedrock/aws4_request, SignedHeaders=.*host.*, Signature=[0-9a-f]{64}$`)
    .test(String(r.headers.authorization))) return { status: 403, chunks: ['{"message":"bad signature shape"}'] }
  const text = fixture(`${c.fx}/${stream ? 'stream-read.sse.txt' : 'nonstream-read.json'}`)
  return { contentType: stream ? 'text/event-stream' : 'application/json', chunks: stream ? chop(text) : [text], delayMs: stream ? 2 : 0 }
})

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: '/nonexistent',
  AWS_ACCESS_KEY_ID: 'AKIDSMOKETEST', AWS_SECRET_ACCESS_KEY: 'smoke-test-not-a-secret', AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
  ROUTER_REGION: REGION, ROUTER_BIND: '127.0.0.1', ROUTER_PORT: '0', ROUTER_INBOUND_TEST_BYPASS: '1', ROUTER_UPSTREAM_URL: fake.url.href,
  ROUTER_POLICY_FILE: new URL('../config/policy.default.json', import.meta.url).pathname,
  ROUTER_HINTS: '{"chatIncludeUsage":"inject-strip"}',
}
const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname], { env, stdio: ['ignore', 'pipe', 'inherit'] })
const logs: Record<string, unknown>[] = []
const port = await new Promise<number>((resolve, reject) => {
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (l) => {
    const o = JSON.parse(l) as Record<string, unknown>
    if (o.kind === 'boot') resolve(o.port as number)
    else if (!('_aws' in o)) logs.push(o)
  })
  child.on('exit', (code) => reject(new Error(`router exited ${code}`)))
})

let failed = 0
try {
  for (const c of cases) {
    for (const stream of [false, true]) {
      const body = JSON.stringify({ model: c.model, ...(c.fx === 'anthropic-messages' ? { max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
        : c.fx === 'openai-chat' ? { messages: [{ role: 'user', content: 'hi' }] } : { input: 'hi' }), ...c.extra, ...(stream ? { stream: true } : {}) })
      const res = await fetch(`http://127.0.0.1:${port}${c.path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } })
      const text = await res.text()
      const ok = res.status === 200 && text.length > 0 && !!res.headers.get('x-router-model')
      if (!ok) failed++
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.path} ${stream ? 'stream' : 'json  '} ${res.status} ${res.headers.get('x-router-decision')} -> ${res.headers.get('x-router-model')}`)
    }
  }
  await new Promise((ok) => setTimeout(ok, 200))
  const priced = logs.filter((l) => l.costUsd).length
  console.log(`logs: ${logs.length}, priced: ${priced}`)
  if (priced !== cases.length * 2) failed++
} finally {
  child.kill('SIGTERM')
  await fake.close()
}
process.exit(failed ? 1 : 0)
