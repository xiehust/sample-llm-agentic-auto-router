import { describe, expect, it } from 'vitest'
import { SseFramer, stripChatUsage } from './stream.ts'
import { fixture } from './test-helpers.ts'

const enc = new TextEncoder()

describe('SseFramer', () => {
  it('yields the same frames for every split point, including inside multi-byte characters', () => {
    const text = `event: a\ndata: {"t":"café ☕"}\n\ndata: [DONE]\n\n`
    const whole = new SseFramer().push(enc.encode(text))
    const bytes = enc.encode(text)
    for (let i = 1; i < bytes.length; i++) {
      const f = new SseFramer()
      const got = [...f.push(bytes.subarray(0, i)), ...f.push(bytes.subarray(i)), ...f.end()]
      expect(got, `split ${i}`).toEqual(whole)
    }
    expect(whole.map((f) => f.raw).join('')).toBe(text)
    expect(whole[0]).toMatchObject({ event: 'a', data: '{"t":"café ☕"}' })
  })

  it('flushes a trailing frame without a blank line at end of stream', () => {
    const f = new SseFramer()
    expect(f.push(enc.encode('data: x\n'))).toEqual([])
    expect(f.end()).toEqual([{ data: 'x', raw: 'data: x\n' }])
  })
})

describe('stripChatUsage', () => {
  it('turns an include_usage stream into the shape of a stream without it', () => {
    const withUsage = fixture('openai-chat/stream-read.sse.txt')
    const without = fixture('openai-chat/stream-no-include-usage.sse.txt')
    const f = new SseFramer()
    const frames = [...f.push(enc.encode(withUsage)), ...f.end()]
    const out = frames.map(stripChatUsage).filter((x): x is string => x !== undefined)
    const plain = new SseFramer()
    const expected = [...plain.push(enc.encode(without)), ...plain.end()]
    expect(out).toHaveLength(expected.length)
    expect(out.join('')).not.toMatch(/"usage"/)
    // Same member names, in the same order, frame by frame (values such as created/obfuscation differ per call).
    const keys = (raw: string) => raw.startsWith('data: {') ? Object.keys(JSON.parse(raw.slice(6))) : raw.trim()
    expect(out.map(keys)).toEqual(expected.map((e) => keys(e.raw)))
    // Every kept frame is the original minus exactly `,"usage":null`.
    const kept = frames.filter((x) => stripChatUsage(x) !== undefined)
    kept.forEach((x, i) => expect(out[i]).toBe(x.raw.replace(',"usage":null', '')))
  })

  it('keeps each data line prefix as sent (data: or data:)', () => {
    expect(stripChatUsage({ data: '{"a":1}', raw: 'data:{"a":1}\n\n' })).toBe('data:{"a":1}\n\n')
    expect(stripChatUsage({ data: '{"a":1,"usage":null}', raw: 'data:{"a":1,"usage":null}\r\n\r\n' })).toBe('data:{"a":1}\r\n\r\n')
    expect(stripChatUsage({ data: '{"usage":null,"a":1}', raw: 'data: {"usage":null,"a":1}\n\n' })).toBe('data: {"a":1}\n\n')
  })
})
