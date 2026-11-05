import { describe, expect, it } from 'vitest'
import { applyBodyHints, coreHeaders } from './hints.ts'

const H = { chatIncludeUsage: 'inject-strip', claudeAutoCache: false, claudeCacheTtl: 'keep' } as const

describe('coreHeaders', () => {
  it('unpacks x-router-hint and keeps only allowlisted names', () => {
    const out = coreHeaders({
      'x-router-hint': 'pin=global.openai.gpt-6-luna; tier=fast ;boundary=compaction;bogus=1',
      'x-router-session': 's1', authorization: 'Bearer secret', 'x-router-tenant': 't1', 'x-router-tier': 'frontier',
    })
    expect(out).toEqual({ 'x-router-session': 's1', 'x-router-pin': 'global.openai.gpt-6-luna', 'x-router-tier': 'fast', 'x-router-boundary': 'compaction' })
  })
  it('ignores oversized hints', () => {
    expect(coreHeaders({ 'x-router-hint': `tier=${'x'.repeat(600)}` })).toEqual({})
  })
})

describe('applyBodyHints', () => {
  const chat = (o: Record<string, unknown>) => { const b = Buffer.from(JSON.stringify(o)); return [b, o] as const }
  it('injects include_usage on chat streams without it, and asks to strip', () => {
    const [b, j] = chat({ model: 'auto', stream: true, messages: [] })
    const r = applyBodyHints('openai-chat', b, j, H)
    expect(JSON.parse(r.body.toString())).toEqual({ stream_options: { include_usage: true }, model: 'auto', stream: true, messages: [] })
    expect(r).toMatchObject({ applied: ['chatIncludeUsage:inject-strip'], stripUsage: true })
  })
  it('replaces stream_options whole when it exists without include_usage', () => {
    const [b, j] = chat({ model: 'auto', stream: true, stream_options: { include_obfuscation: false } })
    expect(JSON.parse(applyBodyHints('openai-chat', b, j, H).body.toString()).stream_options).toEqual({ include_obfuscation: false, include_usage: true })
  })
  it('leaves clients that asked for usage, non-streams and other dialects alone', () => {
    for (const [d, o] of [['openai-chat', { stream: true, stream_options: { include_usage: true } }], ['openai-chat', { stream: false }],
      ['openai-responses', { stream: true }]] as const) {
      const [b, j] = chat(o)
      const r = applyBodyHints(d, b, j, H)
      expect(r.body.equals(b)).toBe(true)
      expect(r.stripUsage).toBe(false)
    }
    const [b, j] = chat({ stream: true })
    expect(applyBodyHints('openai-chat', b, j, { ...H, chatIncludeUsage: 'inject' }).stripUsage).toBe(false)
    expect(applyBodyHints('openai-chat', b, j, { ...H, chatIncludeUsage: 'off' }).body.equals(b)).toBe(true)
  })
  it('adds top-level cache_control for Messages only when none exists anywhere', () => {
    const on = { ...H, claudeAutoCache: true }
    const [b, j] = chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    expect(JSON.parse(applyBodyHints('anthropic-messages', b, j, on).body.toString()).cache_control).toEqual({ type: 'ephemeral' })
    const [b2, j2] = chat({ system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] })
    expect(applyBodyHints('anthropic-messages', b2, j2, on).body.equals(b2)).toBe(true)
  })
})
