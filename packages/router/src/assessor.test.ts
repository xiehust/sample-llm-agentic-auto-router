// Router ↔ tier assessor wiring (task 11-05-codex-deepswe-eval R2): real core engine, real createAssessor and pack
// v2.1, a fake bedrock-runtime that answers both the assessor call and the data-plane call.
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, InMemoryStateStore } from '@auto-router/core'
import { loadPack, packDirs, renderPrompt } from '@auto-router/assessor'
import { costOf, findModel, loadCatalog, normalizeUsage } from '@auto-router/pricing'
import { ASSESSOR_GRACE_MS, bedrockTransport, createRouterAssessor, requestCard, type AssessorAutoRules, type AssessorSettings } from './assessor.ts'
import { ASSESSOR_DEFAULTS, ConfigError, loadConfig } from './config.ts'
import { fakeSigner, fixture, hopHeaders, LUNA, startFakeBedrock, startRouter, testPolicy, waitForLogs, type Recorded, type Reply } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const pack = loadPack(packDirs['v2.1'])
const SOL = 'global.openai.gpt-6.1-sol'
const ASTRA = 'global.openai.gpt-6-astra'
const TASK = 'Where is the retry limit for the upload client configured? Just tell me the file and line.'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

// Assessor output for pack v2.1's four rules, and a Bedrock Responses body (usage copied from the pricing fixtures).
const RULE_IDS = ['explore-readonly', 'mechanical-edit', 'bounded-change', 'deep-investigation']
function output(matched: string[], facts: Record<string, unknown> = {}, confidence = 0.9) {
  return {
    rule_assessments: RULE_IDS.map((id) => ({ rule_id: id, matched: matched.includes(id), reason: matched.includes(id) ? 'fits' : 'does not fit' })),
    task_facts: { edits_code: false, scope: 'none', specification: 'fully-specified', reasoning_depth: 'lookup', prior_failures: 0, ...facts },
    confidence, reason: 'Short summary of the work.',
  }
}
const USAGE = { input_tokens: 3048, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 3046 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3053 }
const responsesBody = (text: string) => ({
  id: 'resp_SCRUBBED1', object: 'response', model: LUNA, status: 'completed', incomplete_details: null, store: false, usage: USAGE,
  output: [{ id: 'msg_SCRUBBED2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text }] }],
})

const isAssessorCall = (r: Recorded) => typeof r.json.prompt_cache_key === 'string' && r.json.prompt_cache_key.startsWith('assessor/')
const okData = (): Reply => ({ chunks: [fixture('openai-responses/nonstream-read.json')] })
const answer = (o: unknown): Reply => ({ chunks: [JSON.stringify(responsesBody(JSON.stringify(o)))] })
const FAST = output(['explore-readonly'])
const FRONTIER = output(['deep-investigation'], { reasoning_depth: 'deep', edits_code: true, scope: 'cross-module', specification: 'partially' })

type AssessorReply = (r: Recorded, index: number) => Reply
async function setup(opts: { mode?: 'off' | 'observe' | 'auto'; autoRules?: AssessorAutoRules; reply?: AssessorReply; timeoutMs?: number } = {}) {
  let n = 0
  const fake = await startFakeBedrock((r) => (isAssessorCall(r) ? (opts.reply ?? (() => answer(FAST)))(r, n++) : okData()))
  const settings: AssessorSettings = { mode: opts.mode === 'auto' ? 'auto' : 'observe', model: LUNA, threshold: 0.8, packName: 'v2.1', pack,
    timeoutMs: opts.timeoutMs ?? ASSESSOR_DEFAULTS.timeoutMs, autoRules: opts.autoRules ?? 'pack' }
  const assessor = opts.mode === 'off' ? undefined : createRouterAssessor(settings, { transport: bedrockTransport(fake.url, fakeSigner), catalog })
  const router = await startRouter(fake.url, { ...(assessor ? { deps: { assessor }, engineOptions: assessor.engineOptions } : {}) })
  cleanups.push(fake.close, router.close)
  const assessorCalls = () => fake.requests.filter(isAssessorCall)
  const dataCalls = () => fake.requests.filter((r) => !isAssessorCall(r))
  return { fake, router, assessor, assessorCalls, dataCalls }
}

const body = (input: unknown) => JSON.stringify({ model: 'auto', input, store: false })
const ask = (url: string, input: unknown = TASK, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/responses`, { method: 'POST', body: body(input), headers: { 'content-type': 'application/json', 'x-router-session': 'sess-1', ...hopHeaders(), ...headers } })
const lastLog = (logs: Record<string, unknown>[]) => logs.at(-1) as Record<string, any>

describe('router consults the tier assessor', () => {
  it('off: no assessor call, no assessor log', async () => {
    const { router, assessorCalls } = await setup({ mode: 'off' })
    expect((await ask(router.url)).status).toBe(200)
    await waitForLogs(router, 1)
    expect(assessorCalls()).toHaveLength(0)
    expect(lastLog(router.logs).assessor).toBeUndefined()
  })

  it('observe: one consultation at session start, logged with codes only, the decision unchanged', async () => {
    const { router, assessorCalls, dataCalls } = await setup({ mode: 'observe' })
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(assessorCalls()).toHaveLength(1)
    expect(assessorCalls()[0]?.path).toBe('/openai/v1/responses')
    expect(dataCalls()[0]?.json.model).toBe(SOL)
    const a = lastLog(router.logs).assessor
    expect(a).toMatchObject({ id: `assessor/v2.1@${LUNA}`, mode: 'observe', autoRules: 'pack', status: 'ok', proposedTier: 'fast',
      basis: ['explore-readonly'], outcome: 'fast', called: true, applied: false, confidence: 0.9 })
    expect(a.tier).toBeUndefined() // v2.1 rules are auto:false: withheld from core
    expect(a.packVersion).toBe(renderPrompt(pack, {}).packVersion) // research 73 A5: resolves basis rule text
    expect(a.latencyMs).toBeGreaterThanOrEqual(0)
    // No prompt text in any log line (request log or EMF).
    for (const l of router.lines) { expect(l).not.toContain('retry limit'); expect(l).not.toContain('Short summary') }
  })

  it('auto + autoRules pack: v2.1 cannot act (tier withheld), served model is the default', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'pack' })
    const res = await ask(router.url)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ mode: 'auto', autoRules: 'pack', proposedTier: 'fast', applied: false })
    expect(lastLog(router.logs).assessor.tier).toBeUndefined()
  })

  it('auto + autoRules all: a fast opinion acts at session start', async () => {
    const { router, dataCalls } = await setup({ mode: 'auto', autoRules: 'all' })
    const res = await ask(router.url)
    expect(res.headers.get('x-router-model')).toBe(LUNA)
    await waitForLogs(router, 1)
    expect(dataCalls()[0]?.json.model).toBe(LUNA)
    const log = lastLog(router.logs)
    expect(log.assessor).toMatchObject({ autoRules: 'all', tier: 'fast', proposedTier: 'fast', applied: true })
    expect(log.decision.reason).toMatch(/assessor\(0\.90\)/)
  })

  it('auto + all: frontier upgrades (rule + fact basis); the frontier guard then holds a later fast opinion', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'all', reply: (_r, i) => answer(i === 0 ? FRONTIER : FAST) })
    const first = await ask(router.url, 'The scheduler deadlocks under load across the queue and worker modules; find the root cause.')
    expect(first.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ tier: 'frontier', basis: ['deep-investigation', 'fact:deep'], applied: true })
    const second = await ask(router.url, [
      { role: 'user', content: 'The scheduler deadlocks under load across the queue and worker modules; find the root cause.' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found it: lock order in the worker.' }] },
      { role: 'user', content: 'Thanks. Now list the files under src/queue.' },
    ])
    expect(second.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 2)
    const log = lastLog(router.logs)
    expect(log.assessor).toMatchObject({ proposedTier: 'fast', guard: 'assessor-downgrade-guarded', applied: false })
    expect(log.decision.reason).toMatch(/assessor-downgrade-guarded frontier→fast/)
  })

  it('pins skip the consultation (x-router-hint pin=… and a concrete model id)', async () => {
    const { router, assessorCalls } = await setup({ mode: 'auto', autoRules: 'all' })
    const pinned = await ask(router.url, TASK, { 'x-router-hint': `pin=${SOL}` })
    expect(pinned.headers.get('x-router-model')).toBe(SOL)
    const concrete = await fetch(`${router.url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: ASTRA, input: TASK, store: false }),
      headers: { 'content-type': 'application/json', 'x-router-session': 'sess-2', ...hopHeaders() } })
    expect(concrete.headers.get('x-router-model')).toBe(ASTRA)
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(0)
    for (const l of router.logs) { expect(l.assessor).toBeUndefined(); expect((l.decision as any).point).toBe('pinned') }
  })

  it('is not consulted on tool-result turns (Codex mid-session)', async () => {
    const { router, assessorCalls } = await setup({ mode: 'auto', autoRules: 'all' })
    await ask(router.url)
    await ask(router.url, [
      { role: 'user', content: TASK },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.ts' },
    ])
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(1)
    expect(lastLog(router.logs).assessor).toBeUndefined()
  })
})

describe('failure tolerance', () => {
  it('assessor HTTP 500: the request still succeeds on the default tier; logged as unavailable', async () => {
    const { router } = await setup({ mode: 'auto', autoRules: 'all', reply: () => ({ status: 500, chunks: ['{"message":"boom"}'] }) })
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    await waitForLogs(router, 1)
    expect(lastLog(router.logs).assessor).toMatchObject({ status: 'unavailable', outcome: 'unavailable:http-500', called: true, applied: false })
    expect(router.lines.join('\n')).not.toContain('boom')
  })

  it('assessor slower than its deadline: the request waits at most timeout + grace, then proceeds', async () => {
    const timeoutMs = 150
    const { router } = await setup({ mode: 'auto', autoRules: 'all', timeoutMs, reply: () => ({ headerDelayMs: 2000, chunks: [JSON.stringify(responsesBody(JSON.stringify(FAST)))] }) })
    const t0 = Date.now()
    const res = await ask(router.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-router-model')).toBe(SOL)
    expect(Date.now() - t0).toBeLessThan(1500)
    await waitForLogs(router, 1)
    const log = lastLog(router.logs)
    expect(log.assessor.status).toMatch(/^(unavailable|timeout)$/)
    expect(log.assessor.outcome).toMatch(/^(unavailable:timeout|timeout)$/)
    expect(log.decideMs).toBeLessThan(timeoutMs + ASSESSOR_GRACE_MS + 300)
  })

  it('invalid model output is still priced (usage was billed)', async () => {
    const { router } = await setup({ mode: 'observe', reply: () => ({ chunks: [JSON.stringify(responsesBody('not json at all'))] }) })
    await ask(router.url)
    await waitForLogs(router, 1)
    const a = lastLog(router.logs).assessor
    expect(a.status).toBe('unavailable')
    expect(a.outcome).toMatch(/^unavailable:/)
    expect(a.costUsd).toBeGreaterThan(0)
  })
})

describe('cost accounting and timing', () => {
  it('prices the consultation with the catalog, once per user turn (a retry reuses it), and emits EMF metrics', async () => {
    const { router, assessorCalls } = await setup({ mode: 'observe' })
    await ask(router.url)
    await ask(router.url) // same history: same user turn
    await waitForLogs(router, 2)
    expect(assessorCalls()).toHaveLength(1)
    const expected = costOf(normalizeUsage('openai-responses', responsesBody('x')), findModel(catalog, LUNA)!).total
    const [first, retry] = router.logs as Array<Record<string, any>>
    expect(first!.assessor.costUsd).toBeCloseTo(expected, 12)
    expect(retry!.assessor).toMatchObject({ cached: true, packVersion: renderPrompt(pack, {}).packVersion })
    expect(retry!.assessor.costUsd).toBeUndefined()
    const emf = router.lines.map((l) => JSON.parse(l) as Record<string, any>).filter((o) => '_aws' in o)
    expect(emf[0]).toMatchObject({ AssessorConsults: 1 })
    expect(emf[0]!.AssessorCostUsd).toBeCloseTo(expected, 12)
    expect(emf[1]!.AssessorConsults).toBeUndefined()
  })

  it('logs router-side timing: bodyReadMs, decideMs (includes the assessor), overheadMs, upstreamTtfbMs, durationMs', async () => {
    const { router } = await setup({ mode: 'observe', reply: () => ({ headerDelayMs: 60, chunks: [JSON.stringify(responsesBody(JSON.stringify(FAST)))] }) })
    await ask(router.url)
    await waitForLogs(router, 1)
    const log = lastLog(router.logs)
    for (const k of ['bodyReadMs', 'decideMs', 'overheadMs', 'upstreamTtfbMs', 'durationMs']) expect(typeof log[k], k).toBe('number')
    expect(log.decideMs).toBeGreaterThanOrEqual(50)
    expect(log.overheadMs).toBeGreaterThanOrEqual(log.decideMs)
  })
})

describe('requestCard', () => {
  it('builds exactly the card the router sends at session start', async () => {
    const { assessorCalls } = await (async () => {
      const s = await setup({ mode: 'observe' })
      await ask(s.router.url)
      await waitForLogs(s.router, 1)
      return s
    })()
    const engine = createEngine({ policy: testPolicy(), catalog, store: new InMemoryStateStore() })
    const card = requestCard(engine, 'openai-responses', JSON.parse(body(TASK)), { 'x-router-session': 'sess-1' })
    const sent = assessorCalls()[0]!.json.input as Array<{ role: string; content: string }>
    expect(sent[1]?.content).toBe(renderPrompt(pack, card).user)
  })

  it('Codex-shaped first request: the router and requestCard agree, turn 0, prompt as latestUser, no firstUser', async () => {
    const PROMPT = 'Fix the off-by-one in pagination so the last page is not dropped.'
    const input = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox notes.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/testbed</cwd>\n  <shell>bash</shell>\n</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] },
    ]
    const s = await setup({ mode: 'observe' })
    await ask(s.router.url, input)
    await waitForLogs(s.router, 1)
    const engine = createEngine({ policy: testPolicy(), catalog, store: new InMemoryStateStore() })
    const card = requestCard(engine, 'openai-responses', JSON.parse(body(input)), { 'x-router-session': 'sess-1' })
    expect(card.latestUser.text).toBe(PROMPT)
    expect(card.stats.turnIndex).toBe(0)
    expect(card.firstUser).toBeUndefined()
    const sent = s.assessorCalls()[0]!.json.input as Array<{ role: string; content: string }>
    expect(sent[1]?.content).toBe(renderPrompt(pack, card).user)
  })
})

describe('config', () => {
  const base = { ROUTER_POLICY_JSON: JSON.stringify(testPolicy()), ROUTER_REGION: 'ap-northeast-1' }
  const issues = (env: Record<string, string>): string => {
    try { loadConfig(env); return '' } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as ConfigError).issues.join('\n') }
  }
  it('defaults to off', () => {
    expect(loadConfig(base).assessor).toEqual({ mode: 'off' })
  })
  it('preloads every bundled pack at boot, also when the assessor is off (research 73 A1)', () => {
    const packs = loadConfig(base).packs
    expect([...(packs?.keys() ?? [])]).toEqual(Object.keys(packDirs))
    expect(packs?.get('v2.1')?.packVersion).toBe(renderPrompt(pack, {}).packVersion)
  })
  it('observe with defaults: Luna, threshold 0.8, pack v2.2, 5000 ms, autoRules pack', () => {
    const a = loadConfig({ ...base, ROUTER_ASSESSOR_MODE: 'observe' }).assessor
    expect(a).toMatchObject({ mode: 'observe', model: LUNA, threshold: 0.8, packName: 'v2.2', timeoutMs: 5000, autoRules: 'pack' })
    if (a.mode !== 'off') expect(a.pack.id).toBe('assessor/v2.2')
  })
  it('refuses auto + autoRules pack when the pack has no auto rule; accepts auto + all', () => {
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'auto' })).toMatch(/could never act/)
    expect(loadConfig({ ...base, ROUTER_ASSESSOR_MODE: 'auto', ROUTER_ASSESSOR_AUTO_RULES: 'all' }).assessor).toMatchObject({ mode: 'auto', autoRules: 'all' })
  })
  it('validates every setting', () => {
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'on' })).toMatch(/ROUTER_ASSESSOR_MODE/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_THRESHOLD: '1.5' })).toMatch(/THRESHOLD/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_PACK: 'v9' })).toMatch(/ROUTER_ASSESSOR_PACK/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_AUTO_RULES: 'some' })).toMatch(/AUTO_RULES/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_TIMEOUT_MS: '50' })).toMatch(/TIMEOUT_MS/)
    expect(issues({ ...base, ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_MODEL: 'global.openai.no-such' })).toMatch(/not in the ap-northeast-1 catalog/)
    // In the catalog but not in the policy: the task role could not invoke it.
    const lunaless = testPolicy({ pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: SOL }] } } })
    expect(issues({ ...base, ROUTER_POLICY_JSON: JSON.stringify(lunaless), ROUTER_ASSESSOR_MODE: 'observe' })).toMatch(/not one of the policy's models/)
  })
})
