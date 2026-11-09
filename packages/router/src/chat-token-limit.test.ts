// openai-chat to a GPT model: max_tokens -> max_completion_tokens per attempt (bedrock-compat.ts chatTokenLimit).
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog } from '@auto-router/pricing'
import { chatTokenLimit, isGptModel } from './bedrock-compat.ts'
import { fixture, hopHeaders, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Recorded, type Reply } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const SOL = 'global.openai.gpt-6.1-sol'
const LUNA = 'global.openai.gpt-6-luna'
const KIMI = 'global.moonshotai.kimi-k3'
const buf = (s: string) => Buffer.from(s, 'utf8')

describe('chatTokenLimit (bytes)', () => {
  // Odd spacing, a non-ASCII string and nested objects: only the edited member's bytes may change.
  const tail = ' "messages" : [ {"role":"user","content":"héllo ☕ \\"max_tokens\\":1"} ],\n  "metadata":{"max_tokens":7}'

  it('renames max_tokens (key bytes only; the value bytes as sent) for a GPT target', () => {
    const raw = `{"model":"${SOL}",  "max_tokens" :  0016 ,${tail}}`
    const r = chatTokenLimit(buf(raw), SOL, catalog)
    expect(r.edits).toEqual(['max_tokens->max_completion_tokens'])
    expect(r.body.toString('utf8')).toBe(`{"model":"${SOL}",  "max_completion_tokens" :  0016 ,${tail}}`)
  })

  it('drops max_tokens when max_completion_tokens is present (first, middle and last position)', () => {
    const cases: Array<[string, string]> = [
      [`{"max_tokens":9, "model":"${SOL}","max_completion_tokens":16}`, `{"model":"${SOL}","max_completion_tokens":16}`],
      [`{"model":"${SOL}","max_tokens":9 ,${tail},"max_completion_tokens":16}`, `{"model":"${SOL}",${tail.trimStart()},"max_completion_tokens":16}`], // only whitespace between members goes with it
      [`{"model":"${SOL}","max_completion_tokens":16,"max_tokens":9}`, `{"model":"${SOL}","max_completion_tokens":16}`],
    ]
    for (const [raw, want] of cases) {
      const r = chatTokenLimit(buf(raw), SOL, catalog)
      expect(r.edits, raw).toEqual(['max_tokens-dropped'])
      expect(r.body.toString('utf8'), raw).toBe(want)
      expect(JSON.parse(r.body.toString('utf8')).max_completion_tokens).toBe(16)
    }
  })

  it('no change: neither key, only max_completion_tokens, a non-GPT target, or duplicate members', () => {
    for (const [raw, model] of [
      [`{"model":"${SOL}",${tail}}`, SOL],
      [`{"model":"${SOL}","max_completion_tokens":16,${tail}}`, SOL],
      [`{"model":"${KIMI}","max_tokens":16,${tail}}`, KIMI],
      [`{"model":"${SOL}","max_tokens":16,"max_tokens":32}`, SOL],
    ] as const) {
      const b = buf(raw)
      const r = chatTokenLimit(b, model, catalog)
      expect(r.edits, raw).toEqual([])
      expect(r.body, raw).toBe(b) // the same buffer: byte-identical
    }
  })

  it('GPT detection: the catalog family first; ids outside the catalog by their openai.gpt- shape', () => {
    expect(isGptModel(catalog, SOL)).toBe(true)
    expect(isGptModel(catalog, KIMI)).toBe(false)
    expect(isGptModel(catalog, 'global.anthropic.claude-haiku-5-5')).toBe(false)
    expect(isGptModel(catalog, 'jp.openai.gpt-7-sol')).toBe(true)
    expect(isGptModel(catalog, 'openai.gpt-7-sol')).toBe(true)
    expect(isGptModel(catalog, 'global.example.openai-gpt-like')).toBe(false)
  })
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

/** Chat pools with a cross-family failover both ways: SOL -> KIMI, KIMI -> LUNA. */
const crossFamily = () => {
  const chat = { defaultTier: 'standard' as const, models: [
    { model: 'global.openai.gpt-6-astra', tier: 'frontier' as const },
    { model: SOL, tier: 'standard' as const, failover: [KIMI] },
    { model: KIMI, tier: 'fast' as const, failover: [LUNA] },
    { model: LUNA, tier: 'fast' as const },
  ] }
  return testPolicy({ pools: { ...testPolicy().pools, 'openai-chat': chat } as ReturnType<typeof testPolicy>['pools'] })
}

async function setup(script: (r: Recorded, n: number) => Reply) {
  let n = 0
  const fake = await startFakeBedrock((r) => script(r, ++n))
  const router = await startRouter(fake.url, { policy: crossFamily() })
  cleanups.push(fake.close, router.close)
  return { fake, router }
}
const chatCall = (url: string, body: Record<string, unknown>) => fetch(`${url}/v1/chat/completions`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...hopHeaders() } })
const msgs = [{ role: 'user', content: 'hi' }]

describe('chatTokenLimit in the request path', () => {
  it('non-streaming: a GPT target gets max_completion_tokens; logged as a code; the rest of the body as sent', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-chat/nonstream-read.json')] }))
    const r = await chatCall(router.url, { model: SOL, max_tokens: 16, messages: msgs, temperature: 0.2 })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"model":"${SOL}","max_completion_tokens":16,"messages":[{"role":"user","content":"hi"}],"temperature":0.2}`)
    expect(router.logs[0]).toMatchObject({ kind: 'model', servedModel: SOL, bodyEdits: ['max_tokens->max_completion_tokens'] })
  })

  it('streaming: the same edit; both keys present → max_tokens dropped', async () => {
    const { fake, router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [fixture('openai-chat/stream-read.sse.txt')] }))
    const r = await chatCall(router.url, { model: SOL, stream: true, max_tokens: 99, max_completion_tokens: 16, messages: msgs })
    expect(r.status).toBe(200)
    await r.text()
    await waitForLogs(router, 1)
    const sent = fake.requests[0]?.json as Record<string, unknown>
    expect(sent).not.toHaveProperty('max_tokens')
    expect(sent.max_completion_tokens).toBe(16)
    expect(router.logs[0]?.bodyEdits).toEqual(['max_tokens-dropped'])
  })

  it('a non-GPT Chat target keeps max_tokens (byte-identical but for the model); no bodyEdits field', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-chat/kimi-k3-nonstream-read.json')] }))
    await (await chatCall(router.url, { model: KIMI, max_tokens: 16, messages: msgs })).text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"model":"${KIMI}","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`)
    expect(router.logs[0]).not.toHaveProperty('bodyEdits')
  })

  it('failover across families: each attempt gets the body for its own model; the served attempt\'s edits are logged', async () => {
    const throttled = (r: Recorded, n: number): Reply => n === 1 ? { status: 429, chunks: ['{"message":"slow down"}'] }
      : { chunks: [fixture(String(r.json.model).includes('kimi') ? 'openai-chat/kimi-k3-nonstream-read.json' : 'openai-chat/nonstream-read.json')] }
    // GPT first, then Kimi: the retry goes with max_tokens again.
    const a = await setup(throttled)
    await (await chatCall(a.router.url, { model: SOL, max_tokens: 16, messages: msgs })).text()
    await waitForLogs(a.router, 1)
    expect(a.fake.requests.map((x) => [x.json.model, 'max_tokens' in x.json, 'max_completion_tokens' in x.json])).toEqual([[SOL, false, true], [KIMI, true, false]])
    expect(a.router.logs[0]).toMatchObject({ servedModel: KIMI, failover: { from: SOL, to: KIMI, status: 429 } })
    expect(a.router.logs[0]).not.toHaveProperty('bodyEdits')
    // Kimi first, then GPT: the retry is renamed.
    const b = await setup(throttled)
    await (await chatCall(b.router.url, { model: KIMI, max_tokens: 16, messages: msgs })).text()
    await waitForLogs(b.router, 1)
    expect(b.fake.requests.map((x) => [x.json.model, 'max_tokens' in x.json, 'max_completion_tokens' in x.json])).toEqual([[KIMI, true, false], [LUNA, false, true]])
    expect(b.router.logs[0]).toMatchObject({ servedModel: LUNA, bodyEdits: ['max_tokens->max_completion_tokens'] })
  })

  it('Responses to a GPT model is never edited (only openai-chat is)', async () => {
    const { fake, router } = await setup(() => ({ chunks: [fixture('openai-responses/nonstream-read.json')] }))
    await (await fetch(`${router.url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: SOL, max_tokens: 16, input: 'hi' }),
      headers: { 'content-type': 'application/json', ...hopHeaders() } })).text()
    await waitForLogs(router, 1)
    expect(fake.requests[0]?.body).toBe(`{"model":"${SOL}","max_tokens":16,"input":"hi"}`)
    expect(router.logs[0]).not.toHaveProperty('bodyEdits')
  })
})
