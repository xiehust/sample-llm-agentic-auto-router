import { describe, expect, it } from 'vitest'
import { UsageNotFoundError } from './errors.ts'
import { parseSse } from './sse.ts'
import { readFixtureJson, readFixtureText } from './test-helpers.ts'
import type { Dialect, NormalizedUsage } from './types.ts'
import { createStreamUsageAccumulator, normalizeUsage } from './usage.ts'

function fromStream(dialect: Dialect, file: string): NormalizedUsage | undefined {
  const acc = createStreamUsageAccumulator(dialect)
  for (const ev of parseSse(readFixtureText(file))) acc.push(ev)
  return acc.result()
}

// Real ap-northeast-1 responses captured 2026-11-04 (see task scripts/capture_fixtures.py).
describe('anthropic-messages fixtures (global.anthropic.claude-haiku-5-5)', () => {
  const d = 'anthropic-messages' as const
  it('non-stream cache write (5m)', () => {
    expect(normalizeUsage(d, readFixtureJson('anthropic-messages/nonstream-write.json'))).toEqual({
      uncachedInputTokens: 11,
      cacheReadTokens: 0,
      cacheWriteTokens: { '5m': 3169 },
      outputTokens: 4,
      reasoningTokens: 0,
      promptTokens: 3180,
    })
  })
  it('non-stream cache write (1h) splits by ephemeral_1h_input_tokens', () => {
    const u = normalizeUsage(d, readFixtureJson('anthropic-messages/nonstream-write-1h.json'))
    expect(u.cacheWriteTokens).toEqual({ '1h': 3169 })
    expect(u.promptTokens).toBe(3180)
  })
  it('non-stream cache read', () => {
    expect(normalizeUsage(d, readFixtureJson('anthropic-messages/nonstream-read.json'))).toEqual({
      uncachedInputTokens: 11,
      cacheReadTokens: 3169,
      cacheWriteTokens: {},
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3180,
    })
  })
  it('stream cache read: message_start + message_delta', () => {
    expect(fromStream(d, 'anthropic-messages/stream-read.sse.txt')).toEqual({
      uncachedInputTokens: 11,
      cacheReadTokens: 3169,
      cacheWriteTokens: {},
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3180,
    })
  })
  it('stream cache write keeps the TTL split from message_start', () => {
    expect(fromStream(d, 'anthropic-messages/stream-write.sse.txt')).toEqual({
      uncachedInputTokens: 11,
      cacheReadTokens: 0,
      cacheWriteTokens: { '5m': 3169 },
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3180,
    })
  })
})

describe.each([
  ['openai-chat', 'global.openai.gpt-6-luna'],
  ['openai-responses', 'global.openai.gpt-6-luna'],
] as const)('%s fixtures (%s)', (d, _model) => {
  it('non-stream cache write: input includes the written tokens', () => {
    expect(normalizeUsage(d, readFixtureJson(`${d}/nonstream-write.json`))).toEqual({
      uncachedInputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: { '30m': 3046 },
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3048,
    })
  })
  it('non-stream cache read', () => {
    expect(normalizeUsage(d, readFixtureJson(`${d}/nonstream-read.json`))).toEqual({
      uncachedInputTokens: 2,
      cacheReadTokens: 3046,
      cacheWriteTokens: {},
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3048,
    })
  })
  it('stream cache read', () => {
    expect(fromStream(d, `${d}/stream-read.sse.txt`)).toEqual({
      uncachedInputTokens: 2,
      cacheReadTokens: 3046,
      cacheWriteTokens: {},
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3048,
    })
  })
  it('stream cache write', () => {
    expect(fromStream(d, `${d}/stream-write.sse.txt`)).toEqual({
      uncachedInputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: { '30m': 3158 },
      outputTokens: 5,
      reasoningTokens: 0,
      promptTokens: 3160,
    })
  })
})

describe('openai-chat stream without stream_options.include_usage', () => {
  it('Bedrock sends no usage at all, so result() is undefined', () => {
    const text = readFixtureText('openai-chat/stream-no-include-usage.sse.txt')
    expect(text).not.toContain('"usage"')
    expect(fromStream('openai-chat', 'openai-chat/stream-no-include-usage.sse.txt')).toBeUndefined()
  })
})

describe('synthetic edge cases', () => {
  it('throws UsageNotFoundError when there is no usage object', () => {
    expect(() => normalizeUsage('anthropic-messages', { id: 'x' })).toThrow(UsageNotFoundError)
    expect(() => normalizeUsage('openai-chat', null)).toThrow(UsageNotFoundError)
    expect(() => normalizeUsage('openai-responses', { usage: 'nope' })).toThrow(UsageNotFoundError)
  })

  it('accepts a Responses stream event object (response.usage)', () => {
    const u = normalizeUsage('openai-responses', {
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } },
    })
    expect(u).toMatchObject({ uncachedInputTokens: 6, cacheReadTokens: 4, outputTokens: 3, promptTokens: 10 })
  })

  it('treats null and missing counters as 0', () => {
    expect(
      normalizeUsage('anthropic-messages', {
        usage: { input_tokens: 7, output_tokens: null, cache_read_input_tokens: null },
      }),
    ).toEqual({ uncachedInputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 0, promptTokens: 7 })
    expect(normalizeUsage('openai-chat', { usage: { prompt_tokens: 9 } })).toEqual({
      uncachedInputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: {},
      outputTokens: 0,
      promptTokens: 9,
    })
  })

  it('anthropic: write total without split goes to 5m; leftover beyond the split goes to 5m', () => {
    expect(normalizeUsage('anthropic-messages', { usage: { cache_creation_input_tokens: 100 } }).cacheWriteTokens).toEqual({
      '5m': 100,
    })
    expect(
      normalizeUsage('anthropic-messages', {
        usage: {
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 60 },
        },
      }).cacheWriteTokens,
    ).toEqual({ '5m': 40, '1h': 60 })
  })

  it('openai: uses a ttl_30m/ttl_12h breakdown when present', () => {
    const u = normalizeUsage('openai-responses', {
      usage: {
        input_tokens: 5000,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 3000 },
        cache_write_tokens_details: { ttl_30m_tokens: 1000, ttl_12h_tokens: 2000 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    })
    expect(u).toEqual({
      uncachedInputTokens: 1000,
      cacheReadTokens: 1000,
      cacheWriteTokens: { '30m': 1000, '12h': 2000 },
      outputTokens: 10,
      reasoningTokens: 4,
      promptTokens: 5000,
    })
  })

  it('openai: inconsistent counters clamp uncached to 0', () => {
    const u = normalizeUsage('openai-chat', {
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 50 } },
    })
    expect(u.uncachedInputTokens).toBe(0)
    expect(u.promptTokens).toBe(130)
  })

  it('stream accumulators ignore malformed data, [DONE], pings and unrelated events', () => {
    const acc = createStreamUsageAccumulator('anthropic-messages')
    expect(acc.result()).toBeUndefined()
    acc.push({ event: 'ping', data: '{"type":"ping"}' })
    acc.push({ data: 'not json' })
    acc.push({ data: '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}' })
    acc.push({ data: '{"type":"message_delta","usage":{"output_tokens":42}}' })
    acc.push({ data: '{broken' })
    expect(acc.result()).toEqual({ uncachedInputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 42, promptTokens: 3 })

    const chat = createStreamUsageAccumulator('openai-chat')
    chat.push({ data: '{"choices":[],"usage":null}' })
    chat.push({ data: '[DONE]' })
    expect(chat.result()).toBeUndefined()

    const resp = createStreamUsageAccumulator('openai-responses')
    resp.push({ data: '{"type":"response.created","response":{"usage":null}}' })
    expect(resp.result()).toBeUndefined()
    resp.push({ data: '{"type":"response.incomplete","response":{"usage":{"input_tokens":5,"output_tokens":2}}}' })
    expect(resp.result()).toMatchObject({ uncachedInputTokens: 5, outputTokens: 2 })
  })

  it('anthropic: null counters in message_delta do not erase message_start values', () => {
    const acc = createStreamUsageAccumulator('anthropic-messages')
    acc.push({
      data: JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 11,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 3000,
            cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
            output_tokens: 1,
          },
        },
      }),
    })
    acc.push({
      data: JSON.stringify({
        type: 'message_delta',
        usage: { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null, output_tokens: 9 },
      }),
    })
    expect(acc.result()).toEqual({
      uncachedInputTokens: 11,
      cacheReadTokens: 500,
      cacheWriteTokens: { '5m': 1000, '1h': 2000 },
      outputTokens: 9,
      promptTokens: 3511,
    })
  })

  it('uses the SSE event name when data has no type', () => {
    const acc = createStreamUsageAccumulator('anthropic-messages')
    acc.push({ event: 'message_start', data: '{"message":{"usage":{"input_tokens":1}}}' })
    expect(acc.result()?.uncachedInputTokens).toBe(1)
  })
})

describe('parseSse', () => {
  it('splits events, joins multi-line data, ignores comments', () => {
    expect(parseSse(': comment\nevent: a\ndata: {"x":\ndata: 1}\n\ndata: [DONE]\n')).toEqual([
      { event: 'a', data: '{"x":\n1}' },
      { data: '[DONE]' },
    ])
  })
  it('handles CRLF and a missing trailing blank line', () => {
    expect(parseSse('data: one\r\n\r\ndata:two')).toEqual([{ data: 'one' }, { data: 'two' }])
  })
})

// Kimi K3 on Chat Completions (global.moonshotai.kimi-k3, ap-northeast-1, 2026-11-04): same OpenAI usage
// shape as GPT (no Moonshot top-level `cached_tokens`). The read covers more than the explicit write because
// K3's implicit breakpoint also caches through the end of the latest message.
describe('openai-chat Kimi K3 fixtures', () => {
  it('non-stream cache write', () => {
    expect(normalizeUsage('openai-chat', readFixtureJson('openai-chat/kimi-k3-nonstream-write.json'))).toEqual({
      uncachedInputTokens: 21,
      cacheReadTokens: 0,
      cacheWriteTokens: { '30m': 3158 },
      outputTokens: 10,
      reasoningTokens: 0,
      promptTokens: 3179,
    })
  })
  it('non-stream and stream cache read', () => {
    const expected = {
      uncachedInputTokens: 7,
      cacheReadTokens: 3172,
      cacheWriteTokens: {},
      outputTokens: 10,
      reasoningTokens: 0,
      promptTokens: 3179,
    }
    expect(normalizeUsage('openai-chat', readFixtureJson('openai-chat/kimi-k3-nonstream-read.json'))).toEqual(expected)
    expect(fromStream('openai-chat', 'openai-chat/kimi-k3-stream-read.sse.txt')).toEqual(expected)
  })
})
