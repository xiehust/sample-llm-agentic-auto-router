import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Engine, RecordOutcome } from '@auto-router/core'
import { RETRYABLE_STATUS as CORE_RETRYABLE_STATUS } from '@auto-router/core'
import { buildCard } from '@auto-router/assessor'
import { costOf, createStreamUsageAccumulator, findModel, loadCatalog, normalizeUsage, parseSse, type Dialect } from '@auto-router/pricing'
import { RETRYABLE_STATUS } from './index.ts'
import {
  chop, fixture, HAIKU, HAIKU_JP, hopHeaders, LUNA, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Reply, type Script,
} from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')

/** Wraps an engine so every record() outcome is captured. */
function capturing(outcomes: RecordOutcome[]) {
  return (e: Engine): Engine => ({ ...e, record: (s, d, o) => { outcomes.push(o); return e.record(s, d, o) } })
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

async function setup(script: Script, opts: Parameters<typeof startRouter>[1] = {}) {
  const fake = await startFakeBedrock(script)
  const router = await startRouter(fake.url, opts)
  cleanups.push(fake.close, router.close)
  return { fake, router }
}

/** Test policy that also rotates profiles on 503 (the default rotates on 429 only). */
const rotate503 = () => testPolicy({ failover: { profileRotateOn: [429, 503] } })

const PATHS: Record<Dialect, string> = { 'anthropic-messages': '/v1/messages', 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses' }
const FIX: Record<Dialect, string> = { 'anthropic-messages': 'anthropic-messages', 'openai-chat': 'openai-chat', 'openai-responses': 'openai-responses' }
const MODEL: Record<Dialect, string> = { 'anthropic-messages': HAIKU, 'openai-chat': LUNA, 'openai-responses': LUNA }

function requestBody(dialect: Dialect, model: string, stream: boolean): string {
  // Odd spacing, key order and escapes: the forwarded body must keep them.
  const extra = stream ? (dialect === 'openai-chat' ? ', "stream":true, "stream_options":{"include_usage":true}' : ', "stream":true') : ''
  if (dialect === 'anthropic-messages') return `{ "max_tokens":16,"model" :  "${model}", "messages":[{"role":"user","content":"caf\\u00e9 ☕"}]${extra}}`
  if (dialect === 'openai-chat') return `{"messages":[{"role":"user","content":"hi"}],  "model":"${model}"${extra}}`
  return `{"input":"hi","model":"${model}" ,"store":false${extra}}`
}

function post(url: string, path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...hopHeaders(), ...headers } })
}

function expectedUsage(dialect: Dialect, text: string, stream: boolean) {
  if (!stream) return normalizeUsage(dialect, JSON.parse(text))
  const acc = createStreamUsageAccumulator(dialect)
  for (const e of parseSse(text)) acc.push(e)
  return acc.result()
}

describe('router pipeline against a fake bedrock-runtime', () => {
  for (const dialect of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const) {
    for (const stream of [false, true]) {
      it(`${dialect} ${stream ? 'stream' : 'non-stream'}: bytes in and out unchanged, usage and cost from pricing`, async () => {
        const text = fixture(`${FIX[dialect]}/${stream ? 'stream-read.sse.txt' : 'nonstream-read.json'}`)
        const { fake, router } = await setup(() => ({
          contentType: stream ? 'text/event-stream' : 'application/json', chunks: stream ? chop(text) : [text], delayMs: stream ? 1 : 0,
        }))
        const sent = requestBody(dialect, MODEL[dialect], stream)
        const res = await post(router.url, PATHS[dialect], sent, dialect === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {})
        expect(res.status).toBe(200)
        expect(await res.text()).toBe(text)
        expect(res.headers.get('x-router-decision')).toBe('pin;pinned;auto')
        expect(res.headers.get('x-router-model')).toBe(MODEL[dialect])
        expect(res.headers.get('x-router-reason')).toBeTruthy()
        const up = fake.requests[0]
        expect(up?.path).toBe(dialect === 'anthropic-messages' ? '/anthropic/v1/messages' : `/openai${PATHS[dialect]}`)
        expect(up?.body).toBe(sent) // pinned: the splice wrote the same model, so every byte is identical
        expect(up?.headers.authorization).toBe('AWS4-HMAC-SHA256 FAKE-SIG')
        await waitForLogs(router, 1)
        const log = router.logs[0] as Record<string, any>
        const usage = expectedUsage(dialect, text, stream)
        expect(log.usage).toEqual(usage)
        expect(log.costUsd).toEqual(costOf(usage as NonNullable<typeof usage>, findModel(catalog, MODEL[dialect]) as NonNullable<ReturnType<typeof findModel>>))
        expect(log).toMatchObject({ kind: 'model', status: 200, dialect, servedModel: MODEL[dialect], stream })
        expect(log.overheadMs).toBeGreaterThanOrEqual(0)
        expect(router.lines.some((l) => l.includes('"Namespace":"LlmAutoRouter"'))).toBe(true)
      })
    }
  }

  it('routes an alias: only the model value changes, and the decision is recorded', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup(() => ({ chunks: [text] }))
    const sent = requestBody('anthropic-messages', 'auto', false)
    const res = await post(router.url, '/v1/messages', sent, { 'x-router-session': 'sess-1' })
    expect(res.status).toBe(200)
    const model = res.headers.get('x-router-model') as string
    expect(fake.requests[0]?.body).toBe(sent.replace('"auto"', JSON.stringify(model)))
    expect(res.headers.get('x-router-decision')).toMatch(/^initialize;session-start;auto$/)
    await waitForLogs(router, 1)
    expect(router.logs[0]?.lineage).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(router.logs)).not.toContain('sess-1')
  })

  it('chatIncludeUsage inject-strip: upstream gets include_usage, client sees no usage, cost is still logged', async () => {
    const text = fixture('openai-chat/stream-read.sse.txt')
    const { fake, router } = await setup(() => ({ contentType: 'text/event-stream', chunks: chop(text, 53) }), { hints: { chatIncludeUsage: 'inject-strip' } })
    const res = await post(router.url, '/v1/chat/completions', `{"model":"${LUNA}","stream":true,"messages":[]}`)
    const body = await res.text()
    expect(fake.requests[0]?.json.stream_options).toEqual({ include_usage: true })
    expect(body).not.toContain('"usage"')
    expect(body).toContain('data: [DONE]')
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ hints: ['chatIncludeUsage:inject-strip'] })
    expect(router.logs[0]?.usage).toEqual(expectedUsage('openai-chat', text, true))
  })

  it('fails over once to the next profile on 429 before the first byte (separate per-profile quotas)', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup((r) => (r.json.model === HAIKU ? { status: 429, chunks: ['{"message":"throttled"}'] } : { chunks: [text] }))
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(HAIKU_JP)
    expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU, HAIKU_JP])
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ servedModel: HAIKU_JP, failover: { from: HAIKU, to: HAIKU_JP, status: 429 } })
  })

  it('returns the last upstream status when the 429 retry fails too', async () => {
    const { fake, router } = await setup(() => ({ status: 429, chunks: ['{"message":"throttled"}'] }))
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))
    expect(res.status).toBe(429)
    expect(fake.requests).toHaveLength(2)
  })

  it('does not retry another profile on a 5xx or a network error by default (the gateway fallback takes it)', async () => {
    for (const status of [500, 503]) {
      const { fake, router } = await setup(() => ({ status, chunks: ['{"message":"busy"}'] }))
      const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))
      expect(res.status).toBe(status)
      expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU])
      await waitForLogs(router, 1)
      expect(router.logs[0]?.failover).toBeUndefined()
    }
    // policy.failover.profileRotateOn opts a 5xx back in
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup((r) => (r.json.model === HAIKU ? { status: 503, chunks: ['{"message":"busy"}'] } : { chunks: [text] }), { policy: rotate503() })
    expect((await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))).headers.get('x-router-model')).toBe(HAIKU_JP)
    expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU, HAIKU_JP])
  })

  it('never retries after the first byte; a mid-stream failure cuts the client connection', async () => {
    const text = fixture('anthropic-messages/stream-read.sse.txt')
    const outcomes: RecordOutcome[] = []
    const { fake, router } = await setup(() => ({ contentType: 'text/event-stream', chunks: chop(text, 64), destroyAfter: 6, delayMs: 10 }),
      { wrapEngine: capturing(outcomes) })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, true))
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
    expect(fake.requests).toHaveLength(1)
    await waitForLogs(router, 1)
    // Recorded as an upstream error so core arms failover; partial usage is still logged and priced.
    expect(router.logs[0]).toMatchObject({ status: 502, reason: 'mid-stream', servedModel: HAIKU })
    expect(router.logs[0]?.error).toBeTruthy()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ servedModel: HAIKU, status: 502 })
    expect(router.lines.some((l) => l.includes('"UpstreamErrors":1'))).toBe(true)
  })

  it('a client abort cancels the upstream request', async () => {
    const slow: Reply = { contentType: 'text/event-stream', chunks: Array.from({ length: 200 }, (_, i) => `data: {"i":${i}}\n\n`), delayMs: 20 }
    const { fake, router } = await setup(() => slow)
    const ac = new AbortController()
    const res = await fetch(router.url + '/v1/messages', {
      method: 'POST', body: requestBody('anthropic-messages', HAIKU, true), headers: hopHeaders(), signal: ac.signal,
    })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    ac.abort()
    await waitForLogs(router, 1)
    expect(router.logs[0]?.clientAborted).toBe(true)
    await new Promise((ok) => setTimeout(ok, 50))
    expect(fake.requests[0]?.closedEarly).toBe(true)
  })

  it('a client abort after the forward records and prices the usage seen so far', async () => {
    const text = fixture('anthropic-messages/stream-read.sse.txt')
    const cut = text.indexOf('event: content_block_delta')
    // message_start (with usage) first, then a slow tail the client never waits for.
    const slow: Reply = { contentType: 'text/event-stream', chunks: [text.slice(0, cut), ...Array.from({ length: 100 }, () => ': keep-alive\n\n')], delayMs: 30 }
    const outcomes: RecordOutcome[] = []
    const { router } = await setup(() => slow, { wrapEngine: capturing(outcomes) })
    const ac = new AbortController()
    const res = await fetch(router.url + '/v1/messages', {
      method: 'POST', body: requestBody('anthropic-messages', HAIKU, true), headers: hopHeaders(), signal: ac.signal,
    })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let seen = ''
    while (!seen.includes('message_start')) seen += new TextDecoder().decode((await reader.read()).value)
    await new Promise((ok) => setTimeout(ok, 50))
    ac.abort()
    await waitForLogs(router, 1)
    const log = router.logs[0] as Record<string, any>
    expect(log).toMatchObject({ status: 499, reason: 'client-abort', clientAborted: true })
    expect(log.usage?.promptTokens).toBeGreaterThan(0)
    expect(log.costUsd?.total).toBeGreaterThan(0)
    expect(outcomes[0]).toMatchObject({ servedModel: HAIKU, status: 200 })
    expect(outcomes[0]?.usage?.promptTokens).toBe(log.usage.promptTokens)
  })

  it('a client that leaves before the forward never triggers an upstream call', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup(() => ({ chunks: [text] }), {
      wrapEngine: (e) => ({ ...e, decide: (async (s: Parameters<typeof e.decide>[0]) => { await new Promise((ok) => setTimeout(ok, 150)); return e.decide(s) }) as typeof e.decide }),
    })
    const ac = new AbortController()
    const pending = fetch(router.url + '/v1/messages', { method: 'POST', body: requestBody('anthropic-messages', HAIKU, false), headers: hopHeaders(), signal: ac.signal }).catch(() => undefined)
    setTimeout(() => ac.abort(), 30)
    await pending
    await waitForLogs(router, 1)
    expect(fake.requests).toHaveLength(0)
    expect(router.logs[0]).toMatchObject({ status: 499, clientAborted: true, reason: 'client-aborted' })
  })

  it('refuses concrete model ids outside the policy (body model or x-router-hint pin) with 400 pin-not-allowed', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup(() => ({ chunks: [text] }))
    for (const [body, headers] of [
      ['{"model":"auto\\u0001\\u00e9\\u2603","max_tokens":1,"messages":[]}', {}],
      ['{"model":"global.anthropic.claude-opus-4-8","max_tokens":1,"messages":[]}', {}],       // in the catalog, not in the policy
      [requestBody('anthropic-messages', 'auto', false), { 'x-router-hint': 'pin=arn:aws:bedrock:other' }],
    ] as const) {
      const res = await post(router.url, '/v1/messages', body, headers)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'model not allowed', code: 'pin-not-allowed' })
    }
    expect(fake.requests).toHaveLength(0)
    await waitForLogs(router, 3)
    expect(router.logs.map((l) => l.reason)).toEqual(['pin-not-allowed', 'pin-not-allowed', 'pin-not-allowed'])
    expect(router.logs[0]).toMatchObject({ requested: 'other', requestedLength: 7 })
    expect(router.lines.join('\n')).not.toContain('claude-opus-4-8')
    // A pin inside the policy goes through.
    const ok = await post(router.url, '/v1/messages', requestBody('anthropic-messages', 'auto', false), { 'x-router-hint': `pin=${HAIKU_JP}` })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-router-model')).toBe(HAIKU_JP)
  })

  it("Claude Code's default betas leave the routed model alone (Sonnet 5.5 stays Sonnet 5.5)", async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup(() => ({ chunks: [text] }))
    const betas = 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', 'auto', false), { 'anthropic-beta': betas })
    expect(res.headers.get('x-router-model')).toBe('global.anthropic.claude-sonnet-5-5')
    expect(fake.requests[0]?.headers['anthropic-beta']).toBe(betas)
    await waitForLogs(router, 1)
    expect(router.logs[0]?.betaVeto).toBeUndefined()
  })

  it('a beta known to be rejected moves an auto initialize up a tier, never down; observe never changes the model', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const betaTable = { 'sonnet-rejects-*': ['*.anthropic.claude-sonnet-*'] }
    const { router } = await setup(() => ({ chunks: [text] }), { deps: { betaTable } })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', 'auto', false), { 'anthropic-beta': 'sonnet-rejects-1' })
    expect(res.headers.get('x-router-model')).toBe('global.anthropic.claude-opus-5-5')
    expect(res.headers.get('x-router-reason')).toBe('beta-incompatible')
    const observe = testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': 'global.anthropic.claude-sonnet-5-5', 'openai-chat': LUNA, 'openai-responses': LUNA } })
    const o = await setup(() => ({ chunks: [text] }), { deps: { betaTable }, policy: observe })
    const r2 = await post(o.router.url, '/v1/messages', requestBody('anthropic-messages', 'auto', false), { 'anthropic-beta': 'sonnet-rejects-1' })
    expect(r2.headers.get('x-router-model')).toBe('global.anthropic.claude-sonnet-5-5')
  })

  it('never logs or forwards credentials and cookies', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup(() => ({ chunks: [text] }))
    const secrets = { authorization: 'Bearer SENTINEL-AUTH', 'x-amz-security-token': 'SENTINEL-TOKEN', 'x-api-key': 'SENTINEL-KEY', cookie: 'c=SENTINEL-COOKIE' }
    await (await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false), secrets)).text()
    await (await post(router.url, '/v1/messages', '{bad', secrets)).text()
    await fetch(router.url + '/v1/messages', { method: 'POST', body: '{}', headers: secrets })
    await waitForLogs(router, 3)
    expect(router.lines.join('\n')).not.toMatch(/SENTINEL/)
    expect(JSON.stringify(fake.requests.map((r) => r.headers))).not.toMatch(/SENTINEL/)
  })
})

describe('router edges', () => {
  it("uses core's retryable set (the one policy validation of profileRotateOn checks against)", () => {
    expect(RETRYABLE_STATUS).toBe(CORE_RETRYABLE_STATUS)
  })

  it('rejects requests without the gateway identity (403) and never calls upstream', async () => {
    const { fake, router } = await setup(() => ({ chunks: ['{}'] }))
    for (const h of [{}, hopHeaders('someone-else')]) {
      const res = await fetch(router.url + '/v1/messages', { method: 'POST', body: '{"model":"auto"}', headers: h })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
    expect(fake.requests).toHaveLength(0)
    await waitForLogs(router, 2)
    expect(router.logs.map((l) => l.reason)).toEqual(['caller-missing', 'principal-not-gateway'])
  })

  it('answers model discovery (GET /v1/models) behind hop auth, in a shape valid for OpenAI and Anthropic clients', async () => {
    const { fake, router } = await setup(() => ({ chunks: ['{}'] }))
    expect((await fetch(router.url + '/v1/models')).status).toBe(403)
    const res = await fetch(router.url + '/v1/models', { headers: hopHeaders() })
    expect(res.status).toBe(200)
    const list = await res.json() as { object: string; data: Array<Record<string, unknown>>; has_more: boolean; first_id: string; last_id: string }
    expect(list).toMatchObject({ object: 'list', has_more: false, first_id: 'auto', last_id: 'auto:standard' })
    expect(list.data.map((m) => m.id)).toEqual(['auto', 'auto:fast', 'auto:frontier', 'auto:standard'])
    for (const m of list.data) expect(Object.keys(m).sort()).toEqual(['created', 'created_at', 'display_name', 'id', 'object', 'owned_by', 'type'])
    expect(fake.requests).toHaveLength(0)
    const anthropic = await import('@anthropic-ai/sdk')
    const openai = await import('openai')
    // Both SDKs parse the list (no network beyond 127.0.0.1; their auth headers are ignored by the test bypass).
    const bypass = await setup(() => ({ chunks: ['{}'] }), { hopAuth: { kind: 'test-bypass' } })
    const a = new anthropic.default({ apiKey: 'unused', baseURL: bypass.router.url, maxRetries: 0 })
    const o = new openai.default({ apiKey: 'unused', baseURL: `${bypass.router.url}/v1`, maxRetries: 0 })
    const aIds: string[] = []
    for await (const m of a.models.list()) aIds.push(m.id)
    const oIds: string[] = []
    for await (const m of o.models.list()) oIds.push(m.id)
    expect(aIds).toEqual(list.data.map((m) => m.id))
    expect(oIds).toEqual(list.data.map((m) => m.id))
  })

  it('fails closed when hop auth is unconfigured', async () => {
    const { router } = await setup(() => ({ chunks: ['{}'] }), { hopAuth: { kind: 'reject' } })
    expect((await post(router.url, '/v1/messages', '{"model":"auto"}')).status).toBe(403)
  })

  it('serves /healthz without auth, 404s everything else, 400s bad JSON, 413s big bodies', async () => {
    const { router } = await setup(() => ({ chunks: ['{}'] }), { maxBodyBytes: 1024 })
    expect(await (await fetch(router.url + '/healthz')).text()).toBe('ok')
    expect((await fetch(router.url + '/v1/responses/resp_1', { headers: hopHeaders() })).status).toBe(404)
    expect((await post(router.url, '/v1/models', '{}')).status).toBe(404)
    expect((await post(router.url, '/v1/messages', '{"model":')).status).toBe(400)
    expect((await post(router.url, '/v1/messages', '[1,2]')).status).toBe(400)
    expect((await post(router.url, '/v1/messages', '{"model":"a","model":"b"}')).status).toBe(400)
    expect((await post(router.url, '/v1/messages', JSON.stringify({ model: 'auto', x: 'y'.repeat(2048) }))).status).toBe(413)
  })

  it('returns 503 when core finds no eligible model (the gateway fallback takes over)', async () => {
    const policy = testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: HAIKU }] } } })
    const { fake, router } = await setup(() => ({ chunks: ['{}'] }), { policy })
    const res = await post(router.url, '/v1/responses', '{"model":"auto","input":"hi"}')
    expect(res.status).toBe(503)
    expect(fake.requests).toHaveLength(0)
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ kind: 'error', reason: 'decide-failed' })
  })

  it('fault injection: router-503 answers 503 without calling upstream; upstream-503-once exercises failover', async () => {
    // Default policy: the injected 503 is not retried on another profile (it goes back to the gateway).
    const d = await setup(() => ({ chunks: ['{}'] }), { fault: 'upstream-503-once' })
    expect((await post(d.router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))).status).toBe(503)
    expect(d.fake.requests).toHaveLength(0)
    const { fake, router } = await setup(() => ({ chunks: ['{}'] }), { fault: 'router-503' })
    expect((await post(router.url, '/v1/messages', '{"model":"auto"}')).status).toBe(503)
    expect(fake.requests).toHaveLength(0)
    const text = fixture('anthropic-messages/nonstream-read.json')
    const s2 = await setup(() => ({ chunks: [text] }), { fault: 'upstream-503-once', policy: rotate503() })
    const res = await post(s2.router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))
    expect(res.headers.get('x-router-model')).toBe(HAIKU_JP)
    expect(s2.fake.requests.map((r) => r.json.model)).toEqual([HAIKU_JP])
  })

  it('fault injection: upstream-503-once:2 lets the first upstream attempt through and fails the second', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup(() => ({ chunks: [text] }), { fault: 'upstream-503-once:2', policy: rotate503() })
    const body = requestBody('anthropic-messages', HAIKU, false)
    expect((await post(router.url, '/v1/messages', body)).headers.get('x-router-model')).toBe(HAIKU)
    // Second attempt is the faulted one: the router fails over to the jp. profile.
    expect((await post(router.url, '/v1/messages', body)).headers.get('x-router-model')).toBe(HAIKU_JP)
    expect((await post(router.url, '/v1/messages', body)).status).toBe(200) // fires once only
    expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU, HAIKU_JP, expect.any(String)])
  })

  it('passes core\'s CardContext through to the card builder (real core assessor hook + buildCard)', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const cards: Array<Record<string, any>> = []
    const assessor = { id: 'fake-assessor', assess: async (card: unknown) => { cards.push(card as Record<string, any>); return { status: 'unavailable' as const, reason: 'test', latencyMs: 0 } } }
    const { router } = await setup(() => ({ chunks: [text] }), {
      deps: { card: (summary, body, ctx) => buildCard(summary, body, ctx) },
      engineOptions: { assessor, assessorMode: 'observe' },
    })
    const turn = (content: string) => post(router.url, '/v1/messages',
      JSON.stringify({ model: 'auto', max_tokens: 16, messages: [{ role: 'user', content }] }), { 'x-router-session': 'card-sess' })
    expect((await turn('first task')).status).toBe(200)
    const second = await turn('second, unrelated task')
    expect(second.status).toBe(200)
    expect(cards.length).toBeGreaterThanOrEqual(2)
    // Fields that only come from CardContext: compactions and lineage kind on every card, the current model later.
    for (const c of cards) { expect(c.stats.compactions).toBe(0); expect(c.lineage.kind).toBe('root') }
    expect(cards.at(-1)?.current?.model).toBe(second.headers.get('x-router-model'))
    expect(cards.at(-1)?.current?.tier).toBeDefined()
  })

})

describe('review fixes (2026-11-04)', () => {
  const nonstream = () => fixture('anthropic-messages/nonstream-read.json')

  it('records the failed profile before the retry, so the next decide() starts on the failover profile', async () => {
    const outcomes: RecordOutcome[] = []
    // A tiny reply whose usage matches the tiny prompts (fixture usage would look like a 3k-token cached prefix).
    const small = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    const { fake, router } = await setup((r) => (r.json.model === HAIKU ? { status: 503, chunks: ['{"message":"busy"}'] } : { chunks: [small] }),
      { wrapEngine: capturing(outcomes), policy: rotate503() })
    const one = [{ role: 'user', content: 'one' }]
    const turn = (messages: unknown[]) => post(router.url, '/v1/messages',
      JSON.stringify({ model: 'auto:fast', max_tokens: 16, messages }), { 'x-router-session': 'fo-sess' })
    expect((await turn(one)).headers.get('x-router-model')).toBe(HAIKU_JP)
    expect(outcomes.map((o) => [o.servedModel, o.status])).toEqual([[HAIKU, 503], [HAIKU_JP, 200]])
    // Next user turn of the same conversation (prefix grows, so no compaction break point).
    const second = await turn([...one, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'two' }])
    expect(second.headers.get('x-router-model')).toBe(HAIKU_JP)
    expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU, HAIKU_JP, HAIKU_JP]) // no second try on the failed profile
  })

  it('global-only profiles (empty failover lists): no router retry; core fails over cross-model to a same-tier sibling', async () => {
    const SONNET55 = 'global.anthropic.claude-sonnet-5-5'
    const SONNET5 = 'global.anthropic.claude-sonnet-5'
    const policy = testPolicy({ pools: { 'anthropic-messages': { defaultTier: 'standard', models: [{ model: SONNET55 }, { model: SONNET5 }] },
      'openai-chat': { defaultTier: 'fast', models: [{ model: LUNA }] }, 'openai-responses': { defaultTier: 'fast', models: [{ model: LUNA }] } } })
    const small = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    const { fake, router } = await setup((r) => (r.json.model === SONNET55 ? { status: 503, chunks: ['{"message":"busy"}'] } : { chunks: [small] }),
      { policy, region: 'ap-southeast-1' })
    const one = [{ role: 'user', content: 'one' }]
    const turn = (messages: unknown[]) => post(router.url, '/v1/messages', JSON.stringify({ model: 'auto', max_tokens: 16, messages }), { 'x-router-session': 'sib' })
    expect((await turn(one)).status).toBe(503) // no failover profile: the gateway fallback rule takes it
    expect(fake.requests.map((r) => r.json.model)).toEqual([SONNET55])
    const second = await turn([...one, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'two' }])
    expect(second.status).toBe(200)
    expect(second.headers.get('x-router-model')).toBe(SONNET5)
    expect(second.headers.get('x-router-decision')).toMatch(/;failover;auto$/)
  })

  it('never rotates profiles inside a previous_response_id chain', async () => {
    const policy = testPolicy({ pools: {
      'openai-responses': { defaultTier: 'fast', models: [{ model: LUNA, tier: 'fast', failover: ['global.openai.gpt-5.6-luna'] }] },
    }, failover: { profileRotateOn: [429, 503] } })
    const { fake, router } = await setup(() => ({ status: 503, chunks: ['{"message":"busy"}'] }), { policy })
    const res = await post(router.url, '/v1/responses', JSON.stringify({ model: LUNA, input: 'hi', previous_response_id: 'resp_1' }))
    expect(res.status).toBe(503)
    expect(fake.requests).toHaveLength(1)
    // Without a chain the same request fails over.
    const free = await post(router.url, '/v1/responses', JSON.stringify({ model: LUNA, input: 'hi' }))
    expect(free.headers.get('x-router-model')).toBe('global.openai.gpt-5.6-luna')
  })

  it('a header timeout uses up the one deadline: 502 upstream-timeout, no retry (the gateway fallback serves it)', async () => {
    const { fake, router } = await setup((r) => (r.json.model === HAIKU ? { headerDelayMs: 400, chunks: [nonstream()] } : { chunks: [nonstream()] }),
      { timeouts: { nonStreamHeaderMs: 100 } })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))
    expect(res.status).toBe(502)
    expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU])
    await waitForLogs(router, 1)
    expect(router.logs[0]?.reason).toBe('upstream-timeout')
  })

  it('a header timeout with no failover target returns 502 (the gateway fallback serves it)', async () => {
    const { router } = await setup(() => ({ headerDelayMs: 400, contentType: 'text/event-stream', chunks: ['data: {}\n\n'] }), { timeouts: { streamHeaderMs: 100 } })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', 'global.anthropic.claude-sonnet-5-5', true))
    expect(res.status).toBe(502)
    await waitForLogs(router, 1)
    expect(router.logs[0]?.reason).toBe('upstream-timeout')
  })

  it('a stream that goes idle after the first byte is cut and recorded as mid-stream (no retry)', async () => {
    const text = fixture('anthropic-messages/stream-read.sse.txt')
    const outcomes: RecordOutcome[] = []
    const { fake, router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [text.slice(0, 200), text.slice(200)], delayMs: 500 }),
      { timeouts: { idleMs: 100 }, wrapEngine: capturing(outcomes) })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, true))
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ status: 502, reason: 'mid-stream', error: 'idle-timeout' })
    expect(outcomes.map((o) => o.status)).toEqual([502])
    expect(fake.requests).toHaveLength(1)
  })

  it('rejects any duplicate top-level key with 400', async () => {
    const { fake, router } = await setup(() => ({ chunks: ['{}'] }))
    const res = await post(router.url, '/v1/messages', '{"max_tokens":1,"messages":[],"max_tokens":9,"model":"auto"}')
    expect(res.status).toBe(400)
    expect(fake.requests).toHaveLength(0)
  })

  it('a non-stream client abort is logged as 499 client-abort', async () => {
    const text = nonstream()
    const { router } = await setup(() => ({ chunks: [text.slice(0, 50), text.slice(50)], delayMs: 300 }))
    const url = new URL(router.url)
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', ...hopHeaders() } })
      // Non-stream responses are buffered, so headers only go out with the body: the client hangs up while waiting.
      req.on('error', () => resolve())
      req.end(requestBody('anthropic-messages', HAIKU, false))
      setTimeout(() => { req.destroy(); resolve() }, 100)
    })
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ status: 499, reason: 'client-abort', clientAborted: true })
  })

  it('403 closes the connection; Expect: 100-continue is authenticated before the body is invited', async () => {
    const { router } = await setup(() => ({ chunks: [nonstream()] }))
    const res = await fetch(router.url + '/v1/messages', { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect(res.headers.get('connection')).toBe('close')
    const url = new URL(router.url)
    const expect100 = (headers: Record<string, string>) => new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
      let continued = false
      const req = httpRequest({ host: url.hostname, port: url.port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', expect: '100-continue', ...headers } })
      req.on('continue', () => { continued = true; req.end(requestBody('anthropic-messages', HAIKU, false)) })
      req.on('response', (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode ?? 0, continued })) })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(await expect100({})).toEqual({ status: 403, continued: false })
    expect(await expect100(hopHeaders())).toEqual({ status: 200, continued: true })
  })

  it('a handler crash still writes a normal request log and EMF (status 500, Reason internal)', async () => {
    // The beta-veto store lookup sits outside every local try: a throwing store is an unhandled router bug.
    const store = { get: async () => { throw new TypeError('store down') }, put: async () => undefined }
    const { fake, router } = await setup(() => ({ chunks: ['{}'] }), { deps: { store } })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', 'auto', false), { 'anthropic-beta': 'x-beta' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal error' })
    expect(fake.requests).toHaveLength(0)
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ kind: 'error', status: 500, reason: 'internal', error: 'TypeError', dialect: 'anthropic-messages' })
    expect(router.logs[0]?.reqId).toMatch(/^[0-9a-f-]{36}$/)
    const doc = router.lines.map((l) => JSON.parse(l)).find((o) => '_aws' in o)
    expect(doc).toMatchObject({ StatusClass: '5xx', Reason: 'internal', Status: 500 })
    expect(router.logs).toHaveLength(1) // exactly one log line for the request
  })

  it('truncates decision.reason in logs to 200 characters', async () => {
    const { router } = await setup(() => ({ chunks: [nonstream()] }), {
      wrapEngine: (e) => ({ ...e, decide: (async (s: Parameters<typeof e.decide>[0]) => ({ ...(await e.decide(s)), reason: `pinned: ${'x'.repeat(500)}` })) as typeof e.decide }),
    })
    await (await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))).text()
    await waitForLogs(router, 1)
    expect((router.logs[0] as any).decision.reason).toHaveLength(200)
  })
})

describe('SSE heartbeat and stream duration cap', () => {
  const text = fixture('anthropic-messages/stream-read.sse.txt')
  const boundary = text.indexOf('\n\n') + 2 // end of the first complete frame
  const strip = (b: string) => b.split(': keepalive\n\n').join('')

  it('writes heartbeats during upstream silence, only between frames; the other bytes stay exact and usage is unchanged', async () => {
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [text.slice(0, boundary), text.slice(boundary)], delayMs: 330 }),
      { timeouts: { heartbeatMs: 50, idleMs: 2000 } })
    const body = await (await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, true))).text()
    const beats = body.split(': keepalive\n\n').length - 1
    expect(beats).toBeGreaterThanOrEqual(3)
    expect(strip(body)).toBe(text)
    // Every heartbeat sits right after a complete frame.
    let i = -1
    while ((i = body.indexOf(': keepalive\n\n', i + 1)) >= 0) expect(body.slice(Math.max(0, i - 2), i)).toBe('\n\n')
    await waitForLogs(router, 1)
    expect(router.logs[0]?.heartbeats).toBe(beats)
    expect(router.logs[0]?.usage).toEqual(expectedUsage('anthropic-messages', text, true))
  })

  it('never writes a heartbeat while the client stream is mid-frame', async () => {
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [text.slice(0, boundary + 10), text.slice(boundary + 10)], delayMs: 330 }),
      { timeouts: { heartbeatMs: 50, idleMs: 2000 } })
    const body = await (await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, true))).text()
    // The 330 s-style gap after the mid-frame chunk gets no heartbeat; any heartbeat comes only after the last frame
    // (the fake waits once more before closing), i.e. at a boundary.
    const first = body.indexOf(': keepalive\n\n')
    expect(first === -1 || first >= text.length).toBe(true)
    expect(strip(body)).toBe(text)
  })

  it('inject-strip streams get heartbeats too, and usage parsing ignores them', async () => {
    const chat = fixture('openai-chat/stream-read.sse.txt')
    const cut = chat.indexOf('\n\n') + 2
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [chat.slice(0, cut), chat.slice(cut)], delayMs: 330 }),
      { hints: { chatIncludeUsage: 'inject-strip' }, timeouts: { heartbeatMs: 50, idleMs: 2000 } })
    const body = await (await post(router.url, '/v1/chat/completions', `{"model":"${LUNA}","stream":true,"messages":[]}`)).text()
    expect(body).toContain(': keepalive\n\n')
    expect(strip(body)).not.toContain('"usage"')
    await waitForLogs(router, 1)
    expect(router.logs[0]?.usage).toEqual(expectedUsage('openai-chat', chat, true))
  })

  it('heartbeatMs 0 turns them off; non-stream responses never get them', async () => {
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [text.slice(0, boundary), text.slice(boundary)], delayMs: 200 }),
      { timeouts: { heartbeatMs: 0, idleMs: 2000 } })
    expect(await (await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, true))).text()).toBe(text)
  })

  it('names a client close near the stream cap stream-duration-cap (priced), distinct from a user abort', async () => {
    const slow: Reply = { contentType: 'text/event-stream', chunks: [text.slice(0, boundary), ...Array.from({ length: 40 }, () => ': upstream\n\n')], delayMs: 25 }
    const run = async (abortAfterMs: number) => {
      const { router } = await setup(() => slow, { timeouts: { streamCapMs: 400, heartbeatMs: 0 } })
      const ac = new AbortController()
      const res = await fetch(router.url + '/v1/messages', { method: 'POST', body: requestBody('anthropic-messages', HAIKU, true), headers: hopHeaders(), signal: ac.signal })
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      await new Promise((ok) => setTimeout(ok, abortAfterMs))
      ac.abort()
      await waitForLogs(router, 1)
      return router.logs[0] as Record<string, any>
    }
    const capped = await run(420)
    expect(capped).toMatchObject({ status: 499, reason: 'stream-duration-cap', clientAborted: true })
    expect(capped.costUsd?.total).toBeGreaterThan(0)
    expect(await run(20)).toMatchObject({ status: 499, reason: 'client-abort' })
  })
})

describe('hop session token (x-amz-security-token)', () => {
  it('logs absent / redacted / other, never the value, and alerts in EMF on other', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { router } = await setup(() => ({ chunks: [text] }))
    const send = (h: Record<string, string>) => post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false), h).then((r) => r.text())
    await send({})
    await send({ 'x-amz-security-token': 'redacted' })
    await send({ 'x-amz-security-token': 'SENTINEL-SESSION-TOKEN' })
    await waitForLogs(router, 3)
    expect(router.logs.map((l) => l.hopToken)).toEqual(['absent', 'redacted', 'other'])
    expect(router.lines.join('\n')).not.toContain('SENTINEL-SESSION-TOKEN')
    const docs = router.lines.map((l) => JSON.parse(l)).filter((o) => '_aws' in o)
    expect(docs.map((d) => d.AlertReason)).toEqual([undefined, undefined, 'hop-token-unexpected'])
    expect(docs[2]).toMatchObject({ Alerts: 1 })
    expect(docs[2]._aws.CloudWatchMetrics.at(-1)).toEqual({ Namespace: 'LlmAutoRouter', Dimensions: [['AlertReason']], Metrics: [{ Name: 'Alerts', Unit: 'Count' }] })
  })
})

describe('EMF', () => {
  it('counts UpstreamErrors only for statuses that came from upstream', async () => {
    const { emf } = await import('./account.ts')
    const names = (log: Parameters<typeof emf>[0]) => (emf(log, 0)._aws as any).CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name)
    const base = { ts: '', reqId: 'r', kind: 'model' as const }
    expect(names({ ...base, status: 503, servedModel: HAIKU })).toContain('UpstreamErrors')
    expect(names({ ...base, status: 400 })).not.toContain('UpstreamErrors')            // router: invalid JSON
    expect(names({ ...base, status: 413 })).not.toContain('UpstreamErrors')            // router: body too large
    expect(names({ ...base, status: 499, servedModel: HAIKU, clientAborted: true })).not.toContain('UpstreamErrors')
  })

  it('adds StatusClass/Reason and MissReason dimensions with bounded values; raw status stays a property', async () => {
    const { emf, reasonDimension } = await import('./account.ts')
    const doc = emf({ ts: '', reqId: 'r', kind: 'model', status: 502, servedModel: HAIKU, reason: 'mid-stream', dialect: 'anthropic-messages',
      miss: { reason: 'ttl_expired', expectedTokens: 10, readTokens: 0 } }, 0) as Record<string, any>
    const dirs = doc._aws.CloudWatchMetrics as Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }>
    expect(dirs.map((d) => d.Dimensions)).toEqual([[['Dialect', 'ServedModel'], ['Mode']], [['StatusClass'], ['StatusClass', 'Reason']], [['MissReason']]])
    expect(dirs[1]?.Metrics.map((m) => m.Name)).toEqual(['Requests', 'UpstreamErrors'])
    expect(doc).toMatchObject({ StatusClass: '5xx', Reason: 'mid-stream', MissReason: 'ttl_expired', Status: 502 })
    expect(reasonDimension('fault-inject:router-503')).toBe('fault-inject')
    expect(reasonDimension('Some Free Text!')).toBe('other')
    expect(reasonDimension(undefined)).toBe('none')
  })

  it('bounds the ServedModel dimension to known ids; the raw id stays a truncated property', async () => {
    const { emf } = await import('./account.ts')
    const known = new Set([HAIKU])
    const base = { ts: '', reqId: 'r', kind: 'model' as const, status: 200 }
    expect(emf({ ...base, servedModel: HAIKU }, 0, known)).toMatchObject({ ServedModel: HAIKU, ServedModelId: HAIKU })
    const odd = emf({ ...base, servedModel: `evil-${'z'.repeat(300)}` }, 0, known) as Record<string, string>
    expect(odd.ServedModel).toBe('other')
    expect(odd.ServedModelId).toHaveLength(128)
  })
})

describe('header deadline across attempts', () => {
  it('one deadline covers the first try and the failover retry (never longer than the gateway first-byte timeout)', async () => {
    const text = fixture('anthropic-messages/nonstream-read.json')
    const { fake, router } = await setup((r) => (r.json.model === HAIKU ? { headerDelayMs: 80, status: 503, chunks: ['{"message":"busy"}'] } : { headerDelayMs: 200, chunks: [text] }),
      { timeouts: { nonStreamHeaderMs: 150 }, policy: rotate503() })
    const res = await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))
    expect(res.status).toBe(502) // per-attempt deadlines would have served jp at ~280 ms
    expect(fake.requests.map((r) => r.json.model)).toEqual([HAIKU, HAIKU_JP])
    await waitForLogs(router, 1)
    expect(router.logs[0]?.reason).toBe('upstream-timeout')
  })

  it('no retry once the deadline has passed', async () => {
    const { fake, router } = await setup(() => ({ headerDelayMs: 200, status: 503, chunks: ['{"message":"busy"}'] }), { timeouts: { nonStreamHeaderMs: 100 } })
    expect((await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, false))).status).toBe(502)
    expect(fake.requests).toHaveLength(1)
  })
})

describe('fault pause-after-first-frame (E2E only)', () => {
  it('pauses after the first frame with heartbeats flowing, then relays the rest unchanged; every log line is stamped', async () => {
    const text = fixture('anthropic-messages/stream-read.sse.txt')
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: chop(text, 64), delayMs: 1 }),
      { fault: 'pause-after-first-frame:300', timeouts: { heartbeatMs: 50, idleMs: 2000 } })
    const t0 = Date.now()
    const body = await (await post(router.url, '/v1/messages', requestBody('anthropic-messages', HAIKU, true))).text()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
    expect(body.split(': keepalive\n\n').join('')).toBe(text)
    expect(body.split(': keepalive\n\n').length - 1).toBeGreaterThanOrEqual(4)
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ fault: 'pause-after-first-frame:300', status: 200 })
  })

  it('is refused without ROUTER_FAULT_INJECT_ALLOW=1 and validated', async () => {
    const { loadConfig, ConfigError } = await import('./config.ts')
    const env = { ROUTER_POLICY_JSON: JSON.stringify(testPolicy()), ROUTER_REGION: 'ap-northeast-1' }
    expect(() => loadConfig({ ...env, ROUTER_FAULT_INJECT: 'pause-after-first-frame:330000' })).toThrow(ConfigError)
    expect(loadConfig({ ...env, ROUTER_FAULT_INJECT: 'pause-after-first-frame:330000', ROUTER_FAULT_INJECT_ALLOW: '1' }).fault).toBe('pause-after-first-frame:330000')
    expect(() => loadConfig({ ...env, ROUTER_FAULT_INJECT: 'pause-after-first-frame:abc', ROUTER_FAULT_INJECT_ALLOW: '1' })).toThrow(/pause-after-first-frame/)
  })
})
