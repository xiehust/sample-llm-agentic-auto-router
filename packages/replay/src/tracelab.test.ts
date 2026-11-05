import { describe, expect, it } from 'vitest'
import { convertRounds, isTraceLabSession, parseRound, type TlRound } from './adapters/tracelab.ts'
import { validateCall } from './schema.ts'

const T0 = Date.parse('2026-05-24T17:37:19.772Z')
let order = 0
const R = (i: number, dtSec: number, input: number, prefix: number, extra: Partial<TlRound> = {}): TlRound => ({
  order: order++, provider: 'claude', session: 'S', roundIndex: i, user: 'u1', model: 'claude-opus-4-7', input, prefix,
  output: 200, cacheRead: prefix, cacheWrite: input - prefix, uncached: 0, firstInput: 'tool_result', inputEvents: 1, tools: 1,
  ts: T0 + dtSec * 1000, ...extra,
})

describe('parseRound', () => {
  it('takes ts from the last input event before output and ignores junk', () => {
    const row = {
      provider: 'claude', session_id: 's', round_index: 3, model: 'claude-opus-4-7', input_tokens_total: 10, prefix_tokens: 4, output_tokens: 2,
      claude_cache_read_input_tokens: 4, first_input_event_type: 'tool_result', current_input_event_count: 2, tools: [{}], user: 'u',
      timing_events: [
        { event_type: 'tool_result', timestamp: '2026-05-31T14:18:50.000Z' },
        { event_type: 'tool_result', timestamp: '2026-05-31T14:18:52.000Z' },
        { event_type: 'text', timestamp: '2026-05-31T14:18:55.000Z' },
        { event_type: 'user_message', timestamp: '2026-05-31T14:19:59.000Z' },
      ],
    }
    expect(parseRound(row, 0).round).toMatchObject({ ts: Date.parse('2026-05-31T14:18:52.000Z'), input: 10, cacheRead: 4, tools: 1 })
    expect(parseRound({ provider: 'x' }, 1).skip).toBe('missing-fields')
    expect(parseRound(null, 2).skip).toBe('not-object')
    expect(parseRound({ ...row, timing_events: [] }, 3).skip).toBe('no-timestamp')
  })
})

describe('convertRounds (design §3.1)', () => {
  const rounds = [
    R(0, 0, 25_000, 17_000, { firstInput: 'user_message' }), // template hit 17K
    R(1, 3, 30_000, 25_000), // append
    R(2, 30, 34_000, 20_000), // claude miss within 240s → rewrite at 20K
    R(3, 1000, 36_000, 0), // expired gap → append-only
    R(4, 1003, 12_000, 9_000), // drop < 70% → compaction, shared 17K template capped
  ]
  const { calls, markers } = convertRounds(rounds)
  it('produces valid calls', () => calls.forEach((c, i) => validateCall(c, `call${i}`)))
  it('round 0: template segment + session segment', () => {
    expect(calls[0]!.prefix.segments).toEqual([{ id: 'tpl:claude:u1', tokens: 17_000 }, { id: 'S:s0', tokens: 8_000 }])
    expect(calls[0]!.markers).toEqual(['session-start'])
    expect(calls[0]!.lastTurn).toBe('user-text')
  })
  it('append extends the session segment', () => {
    expect(calls[1]!.prefix.segments).toEqual([{ id: 'tpl:claude:u1', tokens: 17_000 }, { id: 'S:s0', tokens: 13_000 }])
    expect(calls[1]!.newTokens).toBe(5_000)
  })
  it('in-TTL miss is a rewrite at the recorded read point', () => {
    expect(calls[2]!.markers).toEqual(['rewrite'])
    expect(calls[2]!.newTokens).toBe(14_000)
    expect(calls[2]!.prefix.segments.at(-1)).toEqual({ id: 'S:s1', tokens: 14_000 })
  })
  it('after an expired gap a miss is still append-only', () => {
    expect(calls[3]!.markers).toBeUndefined()
    expect(calls[3]!.newTokens).toBe(2_000)
  })
  it('a big drop is a compaction keeping the template', () => {
    expect(calls[4]!.markers).toEqual(['compaction'])
    expect(calls[4]!.prefix.segments[0]).toEqual({ id: 'tpl:claude:u1', tokens: 12_000 })
    expect(markers).toMatchObject({ 'session-start': 1, rewrite: 1, compaction: 1 })
  })
  it('recorded usage is carried for calibration', () => expect(calls[1]!.recorded).toEqual({ cacheReadTokens: 25_000, cacheWriteTokens: 5_000, uncachedInputTokens: 0 }))
  it('codex: dialect, no rewrite inference, recorded read = prefix', () => {
    const c = convertRounds([R(0, 0, 20_000, 0, { provider: 'codex', session: 'C', model: 'gpt-5.5' }), R(1, 5, 25_000, 1_000, { provider: 'codex', session: 'C', model: 'gpt-5.5' })]).calls
    expect(c[1]).toMatchObject({ dialect: 'openai-responses', newTokens: 5_000, recorded: { cacheReadTokens: 1_000, cacheWriteTokens: 0 } })
    expect(c[1]!.markers).toBeUndefined()
  })
})

describe('isTraceLabSession', () => {
  it('recognises TraceLab session ids only', () => {
    expect(isTraceLabSession('claude:f4b60bc0-eff2-74b3-a2b9-18e00467ed32')).toBe(true)
    expect(isTraceLabSession('codex:73d41a57-2ec9-3873-dc34-5aea9c7109ea')).toBe(true)
    expect(isTraceLabSession('syn0')).toBe(false)
    expect(isTraceLabSession('claude:not-a-uuid')).toBe(false)
  })
})
