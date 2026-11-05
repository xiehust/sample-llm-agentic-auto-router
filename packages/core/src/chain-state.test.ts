// Follow-up 2026-11-04, item 3: previous_response_id without router state locks to the dialect default.
import { describe, expect, it } from 'vitest'
import { ASTRA, LUNA, SOL } from './__fixtures__/catalog.ts'
import { Harness, SEC, T0, testPolicy } from './__fixtures__/traces.ts'

const big = (tokens: number): string => `context ${'x'.repeat(tokens * 4)}`
const chained = (prev: string, model = 'auto', text = 'continue') => ({ model, previous_response_id: prev, input: [{ role: 'user', content: text }] })

describe('previous_response_id with no router state', () => {
  it.each([
    ['headerless', {}],
    ['with a session header', { 'x-session-id': 'new-sess' }],
  ])('%s: initialize on the dialect default, hard-lock-response-chain, no fresh decision', async (_n, hdr) => {
    const hz = new Harness(testPolicy({ rules: [{ id: 'big', when: { minPromptTokens: 10_000 }, tier: 'frontier' }] }))
    const s = await hz.step('openai-responses', chained('resp_unknown', 'auto', big(20_000)), { ...hdr, 'x-router-tier': 'fast' })
    expect(s.decision).toMatchObject({ action: 'initialize', model: SOL, point: 'hard-lock-response-chain' })
    expect(s.decision.reason).toMatch(/^chain-state-missing: previous_response_id resp_unknown has no router state, dialect default tier=standard → global\.openai\.gpt-6\.1-sol; /)
    expect(s.decision.estimate).toBeUndefined()
    expect(s.result.chainStateMissing).toBe(true)
    // the next call of the chain has state: an ordinary lock
    const next = await hz.step('openai-responses', chained('resp_unknown', 'auto', `${big(20_000)} more`), { ...hdr, 'x-router-tier': 'fast' }, { at: T0 + SEC })
    expect(next.decision).toMatchObject({ action: 'retain', model: SOL, point: 'hard-lock-response-chain' })
    expect(next.result.chainStateMissing).toBeUndefined()
  })

  it('a lineage without state still finds the chain through its resp: alias', async () => {
    const hz = new Harness()
    const r1 = await hz.step('openai-responses', { model: 'auto:fast', input: 'hi' }, {}, { responseId: 'resp_1' })
    expect(r1.decision.model).toBe(LUNA)
    // the client starts sending a session header mid-chain: new lineage, but the alias names the model
    const r2 = await hz.step('openai-responses', chained('resp_1'), { 'x-session-id': 'late' }, { at: T0 + SEC })
    expect(r2.summary.session.lineage).not.toBe('resp:resp_1')
    expect(r2.decision).toMatchObject({ action: 'retain', model: LUNA, point: 'hard-lock-response-chain', reason: expect.stringMatching(/^hard-lock: previous_response_id resp_1; /) })
  })

  it('observe mode: concrete ids are served as is, aliases get observeDefaults; wouldChoose is the dialect default', async () => {
    const hz = new Harness(testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': 'global.anthropic.claude-sonnet-5-5', 'openai-chat': SOL, 'openai-responses': LUNA } }))
    const concrete = await hz.step('openai-responses', chained('resp_x', ASTRA))
    expect(concrete.decision).toMatchObject({ mode: 'observe', model: ASTRA, wouldChoose: SOL, point: 'hard-lock-response-chain', reason: expect.stringMatching(/^chain-state-missing: /) })
    expect(concrete.result.chainStateMissing).toBe(true)
    const alias = await hz.step('openai-responses', chained('resp_y'), { 'x-session-id': 'o2' })
    expect(alias.decision).toMatchObject({ model: LUNA, wouldChoose: SOL, reason: expect.stringMatching(/^observe-default: chain-state-missing: /) })
    expect(alias.result.chainStateMissing).toBe(true)
  })
})
