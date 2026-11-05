import { describe, expect, it } from 'vitest'
import { BodyError, removeTopLevelKey, spliceTopLevel, topLevelMembers } from './body.ts'

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
const ws = (r: () => number) => pick(r, ['', '', ' ', '\n', '\t', '  \r\n '])
const STRINGS = ['', 'ping', 'café ☕', 'quote " and \\ backslash', '\u0000\u001f', '日本語', 'model', '"model":"x"', '{', '}', ',']

/** Serializes with random whitespace and random escape styles, so the bytes are not JSON.stringify's. */
function str(r: () => number, s: string): string {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (ch === '"' || ch === '\\') out += `\\${ch}`
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, '0')}`
    else if (cp < 0x80 && r() < 0.1) out += `\\u${cp.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}
function value(r: () => number, depth: number): string {
  const k = depth > 2 ? Math.floor(r() * 4) : Math.floor(r() * 6)
  switch (k) {
    case 0: return pick(r, ['0', '-1.5e3', '42', '3.14'])
    case 1: return pick(r, ['true', 'false', 'null'])
    case 2:
    case 3: return str(r, pick(r, STRINGS))
    case 4: return `[${ws(r)}${Array.from({ length: Math.floor(r() * 3) }, () => value(r, depth + 1)).join(`${ws(r)},${ws(r)}`)}${ws(r)}]`
    default: return obj(r, depth + 1, false)
  }
}
function obj(r: () => number, depth: number, withModel: boolean | 'escaped'): string {
  const keys = new Set<string>()
  const n = Math.floor(r() * 5)
  while (keys.size < n) keys.add(pick(r, ['messages', 'max_tokens', 'stream', 'system', 'tools', 'model', 'meta', 'x']))
  if (depth === 0) keys.delete('model')
  const members = [...keys].map((k) => `${str(r, k)}${ws(r)}:${ws(r)}${value(r, depth + 1)}`)
  if (withModel) {
    const key = withModel === 'escaped' ? '"mod\\u0065l"' : '"model"'
    members.splice(Math.floor(r() * (members.length + 1)), 0, `${key}${ws(r)}:${ws(r)}${str(r, pick(r, ['auto', 'router/auto', 'café']))}`)
  }
  return `{${ws(r)}${members.join(`${ws(r)},${ws(r)}`)}${ws(r)}}`
}

describe('spliceTopLevel (property)', () => {
  it('changes only the top-level model value span, across 2000 random bodies', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed)
      const text = obj(r, 0, seed % 7 === 0 ? 'escaped' : true)
      const input = Buffer.from(text, 'utf8')
      const before = JSON.parse(text) as Record<string, unknown>
      const span = topLevelMembers(input).members.find((m) => m.key === 'model')
      if (!span) throw new Error(`seed ${seed}: no model span`)
      const out = spliceTopLevel(input, 'model', JSON.stringify('global.anthropic.claude-haiku-5-5'))
      const after = JSON.parse(out.toString('utf8')) as Record<string, unknown>
      expect(after.model, `seed ${seed}`).toBe('global.anthropic.claude-haiku-5-5')
      expect({ ...after, model: before.model }, `seed ${seed}`).toEqual(before)
      expect(out.subarray(0, span.valueStart).equals(input.subarray(0, span.valueStart)), `seed ${seed} prefix`).toBe(true)
      const tail = input.length - span.valueEnd
      expect(out.subarray(out.length - tail).equals(input.subarray(span.valueEnd)), `seed ${seed} suffix`).toBe(true)
    }
  })

  it('inserts model when absent, leaving every other byte in place', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed)
      const text = obj(r, 0, false)
      const out = spliceTopLevel(Buffer.from(text), 'model', '"auto"').toString('utf8')
      const parsed = JSON.parse(out) as Record<string, unknown>
      expect(parsed.model).toBe('auto')
      const open = text.indexOf('{')
      expect(out.slice(0, open + 1)).toBe(text.slice(0, open + 1))
      expect(out.endsWith(text.slice(open + 1))).toBe(true)
    }
  })

  it('never touches nested model keys or model text inside strings', () => {
    const text = '{"messages":[{"model":"keep","content":"\\"model\\":\\"keep\\""}],"model" : "auto","meta":{"model":"keep"}}'
    const out = spliceTopLevel(Buffer.from(text), 'model', '"x"').toString()
    expect(out).toBe('{"messages":[{"model":"keep","content":"\\"model\\":\\"keep\\""}],"model" : "x","meta":{"model":"keep"}}')
  })

  it('rejects duplicate top-level model, non-objects and malformed JSON with 400', () => {
    for (const bad of ['{"model":"a","model":"b"}', '[1]', '"x"', '{"model":', '{"a":1 "b":2}', '{"a":"unterminated}']) {
      expect(() => spliceTopLevel(Buffer.from(bad), 'model', '"x"'), bad).toThrow(BodyError)
    }
  })
})

describe('removeTopLevelKey', () => {
  it('removes a null member from any position and keeps the rest byte-identical', () => {
    expect(removeTopLevelKey('{"a":1,"usage":null,"b":2}', 'usage', 'null')).toBe('{"a":1,"b":2}')
    expect(removeTopLevelKey('{"a":1,"usage":null}', 'usage', 'null')).toBe('{"a":1}')
    expect(removeTopLevelKey('{"usage":null,"b":2}', 'usage', 'null')).toBe('{"b":2}')
    expect(removeTopLevelKey('{"usage":null}', 'usage', 'null')).toBe('{}')
  })
  it('keeps non-null values, nested keys and non-JSON text unchanged', () => {
    for (const t of ['{"usage":{"x":1}}', '{"a":{"usage":null}}', 'not json', '[DONE]']) expect(removeTopLevelKey(t, 'usage', 'null')).toBe(t)
  })
})
