import { templateFamilyOf } from '@auto-router/core'
import { costOf, findModel, loadCatalog, normalizeUsage, type ModelPrice } from '@auto-router/pricing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatBody, messagesBody, output, responsesBody, summaryOf, toolUse } from './__fixtures__/fixtures.ts'
import { createAssessor, precheck, scrub, type AssessorCallInfo, type AssessorConfig } from './assessor.ts'
import { buildCard, type TaskCard } from './card.ts'
import type { AssessorResult } from './contract.ts'
import { loadPack, renderPrompt, type Pack } from './pack.ts'
import { fakeTransport, type FakeStep } from './transport.ts'

const catalog = loadCatalog()
const LUNA = 'global.openai.gpt-6-luna'
const HAIKU = 'global.anthropic.claude-haiku-5-5'
const price = (id: string) => findModel(catalog, id) as ModelPrice
const signal = () => new AbortController().signal

const card: TaskCard = buildCard(summaryOf('anthropic-messages'), { messages: [{ role: 'user', content: 'where is the session timeout set?' }] })
const fastOut = output(['explore-readonly'])
const deepOut = output(['deep-investigation'], { reasoning_depth: 'deep', scope: 'cross-module', specification: 'ambiguous' })

const make = (steps: FakeStep[] | ((...a: never[]) => FakeStep), over: Partial<AssessorConfig> = {}) => {
  const transport = fakeTransport(steps as FakeStep[])
  return { transport, assessor: createAssessor({ transport, catalog, ...over }) }
}
const ok = (r: AssessorResult) => {
  expect(r.status).toBe('ok')
  return r as Extract<AssessorResult, { status: 'ok' }>
}
const unavailable = (r: AssessorResult) => {
  expect(r.status).toBe('unavailable')
  return r as Extract<AssessorResult, { status: 'unavailable' }>
}

afterEach(() => {
  vi.useRealTimers()
})

describe('valid results per adapter', () => {
  it('Luna on Responses (default): observe mode records the proposal, cost from costOf', async () => {
    const body = responsesBody(JSON.stringify(fastOut))
    const { transport, assessor } = make([{ body }])
    expect(assessor.id).toBe('assessor/v2.1@global.openai.gpt-6-luna')
    expect(assessor.dialect).toBe('openai-responses')
    const r = ok(await assessor.assess(card, signal()))
    expect(r.tier).toBeUndefined() // every rule is auto:false
    expect(r.confidence).toBe(0.9)
    expect(r.costUsd).toBe(costOf(normalizeUsage('openai-responses', body), price(LUNA)).total)
    expect(r.costUsd).toBeGreaterThan(0)
    expect(r.audit).toMatchObject({
      packVersion: assessor.packVersion,
      model: LUNA,
      dialect: 'openai-responses',
      matched: ['explore-readonly'],
      proposedTier: 'fast',
      basis: ['explore-readonly'],
      outcome: 'fast',
      autoEligible: false,
      facts: fastOut.task_facts,
      reason: fastOut.reason,
    })
    expect(r.audit.ruleAssessments).toHaveLength(4)
    expect(JSON.stringify(r.audit)).not.toContain('session timeout') // no card text in the audit

    expect(transport.calls).toHaveLength(1)
    const req = transport.calls[0]!
    expect(req.path).toBe('/openai/v1/responses')
    expect(req.headers['content-type']).toBe('application/json')
    const sent = JSON.parse(req.body) as Record<string, unknown>
    const prompt = renderPrompt(loadPack(), card)
    expect(sent).toMatchObject({ model: LUNA, store: false, prompt_cache_key: prompt.packVersion, reasoning: { effort: 'none' }, max_output_tokens: 800 })
    expect(sent.input).toEqual([{ role: 'developer', content: prompt.system }, { role: 'user', content: prompt.user }])
  })

  it('Luna on Chat Completions', async () => {
    const body = chatBody(JSON.stringify(deepOut))
    const { transport, assessor } = make([{ body }], { api: 'chat' })
    const r = ok(await assessor.assess(card, signal()))
    expect(transport.calls[0]!.path).toBe('/openai/v1/chat/completions')
    expect(r.audit).toMatchObject({ dialect: 'openai-chat', proposedTier: 'frontier', basis: ['deep-investigation', 'fact:deep'] })
    expect(r.costUsd).toBe(costOf(normalizeUsage('openai-chat', body), price(LUNA)).total)
  })

  it('Haiku 5.5 on Messages with the forced tool', async () => {
    const body = messagesBody([toolUse(fastOut)])
    const { transport, assessor } = make([{ body }], { model: HAIKU })
    expect(assessor.id).toBe('assessor/v2.1@global.anthropic.claude-haiku-5-5')
    const r = ok(await assessor.assess(card, signal()))
    expect(transport.calls[0]!.path).toBe('/anthropic/v1/messages')
    const sent = JSON.parse(transport.calls[0]!.body) as { tool_choice: unknown; system: unknown[] }
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'record_tier_assessment' })
    expect(r.audit).toMatchObject({ dialect: 'anthropic-messages', proposedTier: 'fast' })
    expect(r.costUsd).toBe(costOf(normalizeUsage('anthropic-messages', body), price(HAIKU)).total)
  })

  it('reports no opinion (ok, no tier) for low confidence', async () => {
    const { assessor } = make([{ body: responsesBody(JSON.stringify(output(['explore-readonly'], {}, 0.5))) }])
    const r = ok(await assessor.assess(card, signal()))
    expect(r.audit).toMatchObject({ outcome: 'low-confidence', basis: ['low-confidence'] })
    expect(r.audit).not.toHaveProperty('proposedTier')
    expect(r.confidence).toBe(0.5)
  })
})

describe('failures become unavailable, never exceptions', () => {
  it('invalid output (missing rule)', async () => {
    const bad = { ...fastOut, rule_assessments: fastOut.rule_assessments.slice(1) }
    const r = unavailable(await make([{ body: responsesBody(JSON.stringify(bad)) }]).assessor.assess(card, signal()))
    expect(r.reason).toMatch(/^invalid: rule_assessments: missing rule explore-readonly/)
  })

  it.each<[string, unknown, RegExp]>([
    ['refusal', chatBody(null, { refusal: 'no' }), /^refusal:/],
    ['truncated', chatBody('{"rule', { finish_reason: 'length' }), /^incomplete:/],
    ['non-JSON text', chatBody('hello'), /^parse:/],
  ])('%s', async (_, body, pattern) => {
    const r = unavailable(await make([{ body }], { api: 'chat' }).assessor.assess(card, signal()))
    expect(r.reason).toMatch(pattern)
  })

  it('non-JSON response body', async () => {
    const r = unavailable(await make([{ body: '<html>gateway error</html>' }]).assessor.assess(card, signal()))
    expect(r.reason).toBe('parse: response body is not JSON')
  })

  it.each([429, 500, 503, 403])('HTTP %i', async (status) => {
    const r = unavailable(await make([{ status, body: { message: 'throttled' } }]).assessor.assess(card, signal()))
    expect(r.reason).toBe(`http-${status}`)
  })

  it('transport error, with account ids and ARNs scrubbed from the reason', async () => {
    const err = new Error('AccessDenied for arn:aws:iam::123456789012:role/x in account 123456789012 (request req_ABC123)')
    const r = unavailable(await make([{ error: err }]).assessor.assess(card, signal()))
    expect(r.reason).toMatch(/^transport: /)
    expect(r.reason).not.toMatch(/\d{12}|arn:aws|req_ABC/)
  })

  it('malformed transport response', async () => {
    const transport = Object.assign(async () => undefined as never, { calls: [] })
    const r = unavailable(await createAssessor({ transport, catalog }).assess(card, signal()))
    expect(r.reason).toBe('transport: malformed response')
  })

  it('invalid card, without calling the model', async () => {
    const { transport, assessor } = make([{ body: responsesBody(JSON.stringify(fastOut)) }])
    expect(unavailable(await assessor.assess({ v: 'card/v0' }, signal())).reason).toMatch(/^card-invalid:/)
    expect(unavailable(await assessor.assess(undefined, signal())).reason).toMatch(/^card-invalid:/)
    expect(transport.calls).toHaveLength(0)
  })

  it('an internal error (hostile card object) is contained', async () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom') }, has() { throw new Error('boom') } })
    const r = unavailable(await make([{ body: {} }]).assessor.assess(hostile, signal()))
    expect(r.reason).toMatch(/^internal: /)
  })
})

describe('timeout and abort', () => {
  it('times out at 1.5 s by default and aborts the transport signal', async () => {
    vi.useFakeTimers()
    const { transport, assessor } = make([{ delayMs: 10_000, body: responsesBody(JSON.stringify(fastOut)) }], { now: () => Date.now() })
    const pending = assessor.assess(card, signal())
    await vi.advanceTimersByTimeAsync(1499)
    expect(transport.calls[0]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const r = unavailable(await pending)
    expect(r.reason).toBe('timeout: no response within 1500 ms')
    expect(r.latencyMs).toBe(1500)
    expect(transport.calls[0]!.signal.aborted).toBe(true)
  })

  it('times out even when the transport ignores the signal', async () => {
    vi.useFakeTimers()
    const transport = Object.assign(() => new Promise<never>(() => {}), { calls: [] })
    const pending = createAssessor({ transport, catalog, timeoutMs: 200 }).assess(card, signal())
    await vi.advanceTimersByTimeAsync(200)
    expect(unavailable(await pending).reason).toBe('timeout: no response within 200 ms')
  })

  it('reports a caller abort during the call', async () => {
    vi.useFakeTimers()
    const { transport, assessor } = make([{ delayMs: 1000, body: responsesBody(JSON.stringify(fastOut)) }])
    const ctl = new AbortController()
    const pending = assessor.assess(card, ctl.signal)
    await vi.advanceTimersByTimeAsync(100)
    ctl.abort()
    expect(unavailable(await pending).reason).toBe('aborted: caller')
    expect(transport.calls[0]!.signal.aborted).toBe(true)
  })

  it('does not call the model when the caller already aborted', async () => {
    const { transport, assessor } = make([{ body: responsesBody(JSON.stringify(fastOut)) }])
    const ctl = new AbortController()
    ctl.abort()
    expect(unavailable(await assessor.assess(card, ctl.signal)).reason).toBe('aborted: before start')
    expect(transport.calls).toHaveLength(0)
  })
})

describe('precheck', () => {
  const at = (text: string, turnIndex: number): TaskCard => ({ ...card, latestUser: { text, images: 0 }, stats: { ...card.stats, turnIndex } })

  it.each<[string, number, string | undefined]>([
    ['', 0, 'no-user-text'],
    ['   ', 3, 'no-user-text'],
    ['ok', 2, 'trivial-followup'],
    ['Thanks!', 1, 'trivial-followup'],
    ['ok, go on', 4, 'trivial-followup'],
    ['LGTM', 1, 'trivial-followup'],
    ['yes please continue', 1, 'trivial-followup'],
    ['ok', 0, undefined], // first turn: always assessed
    ['ok now fix the tests', 2, undefined],
    ['no', 2, undefined],
    ['continue with the migration plan', 2, undefined], // over 24 chars
  ])('%j at turn %i → %s', (text, turn, expected) => {
    expect(precheck(at(text, turn))).toBe(expected)
  })

  it('skips the model call and costs nothing', async () => {
    const { transport, assessor } = make([{ body: responsesBody(JSON.stringify(fastOut)) }])
    const r = ok(await assessor.assess(at('thanks', 3), signal()))
    expect(r).toMatchObject({ confidence: 0, costUsd: 0, audit: { skipped: 'trivial-followup', packVersion: assessor.packVersion } })
    expect(r.tier).toBeUndefined()
    expect(transport.calls).toHaveLength(0)
  })
})

describe('observe vs auto', () => {
  const withAuto = (ids: string[]): Pack => {
    const p = structuredClone(loadPack())
    for (const r of p.rules) r.auto = ids.includes(r.id)
    return p
  }

  it('withholds the tier until the basis rules are auto', async () => {
    const body = responsesBody(JSON.stringify(fastOut))
    expect(ok(await make([{ body }]).assessor.assess(card, signal())).tier).toBeUndefined()
    expect(ok(await make([{ body }], { pack: withAuto(['mechanical-edit']) }).assessor.assess(card, signal())).tier).toBeUndefined()
    const r = ok(await make([{ body }], { pack: withAuto(['explore-readonly']) }).assessor.assess(card, signal()))
    expect(r.tier).toBe('fast')
    expect(r.audit).toMatchObject({ autoEligible: true, proposedTier: 'fast' })
  })

  it('needs autoFacts for fact-based tiers', async () => {
    const body = responsesBody(JSON.stringify(deepOut))
    const pack = withAuto(['deep-investigation'])
    expect(ok(await make([{ body }], { pack }).assessor.assess(card, signal())).tier).toBeUndefined()
    expect(ok(await make([{ body }], { pack, autoFacts: ['deep'] }).assessor.assess(card, signal())).tier).toBe('frontier')
  })

  it('a rule edit changes the pack version reported in the audit', async () => {
    const p = structuredClone(loadPack())
    p.rules[0]!.instruction += ' Edited.'
    const a = make([{ body: {} }]).assessor
    const b = make([{ body: {} }], { pack: p }).assessor
    expect(b.packVersion).not.toBe(a.packVersion)
  })
})

describe('configuration', () => {
  it('rejects unknown models and bad options at creation time', () => {
    const transport = fakeTransport([{ body: {} }])
    expect(() => createAssessor({ transport, catalog, model: 'global.openai.not-a-model' })).toThrow(/not in the price catalog/)
    expect(() => createAssessor({ transport, catalog, threshold: 1.5 })).toThrow(/threshold/)
    expect(() => createAssessor({ transport, catalog, timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => createAssessor({ transport, catalog, autoFacts: ['bogus' as never] })).toThrow(/unknown auto fact/)
    expect(() => createAssessor({ transport, catalog, pack: { ...loadPack(), rules: [] , examples: [{ tier: 'fast', card, output: fastOut }] } })).toThrow(/invalid prompt pack/)
  })

  it('reports every call to onCall, including cost of invalid outputs; observer errors are swallowed', async () => {
    const calls: AssessorCallInfo[] = []
    const body = responsesBody(JSON.stringify({ nope: true }))
    const { assessor } = make([{ body }], { onCall: (i) => { calls.push(i); throw new Error('observer bug') } })
    const r = unavailable(await assessor.assess(card, signal()))
    expect(r.reason).toMatch(/^invalid:/)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ status: 'unavailable', called: true, costUsd: costOf(normalizeUsage('openai-responses', body), price(LUNA)).total })
  })

  it('builds cards with the configured role labels', () => {
    const s = summaryOf('anthropic-messages')
    const { assessor } = make([{ body: {} }], { roleLabels: { [templateFamilyOf(s)]: 'coding-agent' } })
    expect(assessor.card(s, { messages: [{ role: 'user', content: 'q' }] }).role).toEqual({ label: 'coding-agent' })
  })

  it('scrub bounds the reason length', () => {
    expect(scrub('x'.repeat(1000))).toHaveLength(300)
  })
})
