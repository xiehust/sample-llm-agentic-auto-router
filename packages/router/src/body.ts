// Request body handling (design §2.1 body.ts, D2): bounded read, and byte-exact edits of top-level JSON members.
// The scanner only looks at ASCII structural bytes, so UTF-8 inside strings is never touched or re-encoded.
import type { IncomingMessage } from 'node:http'

export class BodyError extends Error {
  readonly status: 400 | 413
  constructor(status: 400 | 413, message: string) {
    super(message)
    this.name = 'BodyError'
    this.status = status
  }
}

/** Reads the whole body, failing with 413 as soon as it exceeds `maxBytes` (the rest is not buffered). */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyError(413, `body exceeds ${maxBytes} bytes`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw new BodyError(413, `body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/** Byte span of one top-level member: [keyStart, valueEnd) covers `"key" : value`. */
export interface MemberSpan { key: string; keyStart: number; valueStart: number; valueEnd: number }

const WS = new Set([0x20, 0x09, 0x0a, 0x0d])
const QUOTE = 0x22
const BACKSLASH = 0x5c

function skipWs(b: Uint8Array, i: number): number {
  while (i < b.length && WS.has(b[i] as number)) i++
  return i
}

function skipString(b: Uint8Array, i: number): number {
  // b[i] is the opening quote; returns the index just past the closing quote.
  for (i++; i < b.length; i++) {
    const c = b[i] as number
    if (c === BACKSLASH) i++
    else if (c === QUOTE) return i + 1
  }
  throw new BodyError(400, 'invalid JSON: unterminated string')
}

function skipValue(b: Uint8Array, i: number): number {
  const c = b[i]
  if (c === undefined) throw new BodyError(400, 'invalid JSON: value expected')
  if (c === QUOTE) return skipString(b, i)
  if (c === 0x7b || c === 0x5b) { // { or [
    let depth = 0
    for (; i < b.length; i++) {
      const x = b[i] as number
      if (x === QUOTE) { i = skipString(b, i) - 1; continue }
      if (x === 0x7b || x === 0x5b) depth++
      else if (x === 0x7d || x === 0x5d) { depth--; if (depth === 0) return i + 1 }
    }
    throw new BodyError(400, 'invalid JSON: unterminated container')
  }
  // number / true / false / null: runs until a delimiter
  const start = i
  while (i < b.length && !WS.has(b[i] as number) && b[i] !== 0x2c && b[i] !== 0x7d) i++
  if (i === start) throw new BodyError(400, 'invalid JSON: value expected')
  return i
}

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Lists the top-level members of a JSON object body, in order. Throws BodyError(400) if the body is not a
 * JSON object. Values are delimited, not validated; callers JSON.parse the body separately.
 */
export function topLevelMembers(b: Uint8Array): { members: MemberSpan[]; open: number; close: number } {
  let i = skipWs(b, 0)
  if (b[i] !== 0x7b) throw new BodyError(400, 'invalid JSON: top-level object expected')
  const open = i
  const members: MemberSpan[] = []
  i = skipWs(b, i + 1)
  if (b[i] === 0x7d) return { members, open, close: i }
  for (;;) {
    if (b[i] !== QUOTE) throw new BodyError(400, 'invalid JSON: member name expected')
    const keyStart = i
    const keyEnd = skipString(b, i)
    const key = JSON.parse(decoder.decode(b.subarray(keyStart, keyEnd))) as string
    i = skipWs(b, keyEnd)
    if (b[i] !== 0x3a) throw new BodyError(400, 'invalid JSON: colon expected')
    const valueStart = skipWs(b, i + 1)
    const valueEnd = skipValue(b, valueStart)
    members.push({ key, keyStart, valueStart, valueEnd })
    i = skipWs(b, valueEnd)
    if (b[i] === 0x2c) { i = skipWs(b, i + 1); continue }
    if (b[i] === 0x7d) return { members, open, close: i }
    throw new BodyError(400, 'invalid JSON: comma or closing brace expected')
  }
}

function only(b: Uint8Array, key: string): { span?: MemberSpan; open: number } {
  const { members, open } = topLevelMembers(b)
  const found = members.filter((m) => m.key === key)
  if (found.length > 1) throw new BodyError(400, `invalid request: duplicate top-level "${key}"`)
  return found[0] ? { span: found[0], open } : { open }
}

/**
 * Replaces the value of top-level `key` with `jsonValue` (already serialized JSON), or inserts
 * `"key":jsonValue,` right after the opening brace when absent. Every other byte is unchanged.
 */
export function spliceTopLevel(b: Buffer, key: string, jsonValue: string): Buffer {
  const { span, open } = only(b, key)
  const value = Buffer.from(jsonValue, 'utf8')
  if (span) return Buffer.concat([b.subarray(0, span.valueStart), value, b.subarray(span.valueEnd)])
  const { members } = topLevelMembers(b)
  const member = Buffer.from(`${JSON.stringify(key)}:${jsonValue}${members.length ? ',' : ''}`, 'utf8')
  return Buffer.concat([b.subarray(0, open + 1), member, b.subarray(open + 1)])
}

/**
 * Removes top-level `key` (and one adjoining comma) from a JSON object text when its value is exactly
 * `ifValue` (e.g. 'null'). Returns the input unchanged otherwise. Used on SSE data lines, so it takes a string.
 */
export function removeTopLevelKey(text: string, key: string, ifValue: string): string {
  const b = Buffer.from(text, 'utf8')
  let parsed
  try { parsed = topLevelMembers(b) } catch { return text }
  const idx = parsed.members.findIndex((m) => m.key === key)
  const m = parsed.members[idx]
  if (!m || b.subarray(m.valueStart, m.valueEnd).toString('utf8') !== ifValue) return text
  let start = m.keyStart
  let end = m.valueEnd
  const next = parsed.members[idx + 1]
  const prev = parsed.members[idx - 1]
  if (next) end = next.keyStart                 // drop `"key":v,` up to the next member
  else if (prev) start = prev.valueEnd          // last member: drop `,"key":v`
  return Buffer.concat([b.subarray(0, start), b.subarray(end)]).toString('utf8')
}
