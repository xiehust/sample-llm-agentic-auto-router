import { describe, expect, it } from 'vitest'
import {
  anthropicBody, assistantThinking, assistantToolUse, EXPLORE_SYSTEM, filler, MAIN_SYSTEM, T0, toolResult, userText,
} from './__fixtures__/traces.ts'
import { summarize, templateFamilyOf } from './summarize/index.ts'
import { MEDIA_TOKENS } from './summarize/tokens.ts'

const A = 'anthropic-messages' as const

describe('summarize: anthropic-messages', () => {
  it('lastTurn, chain shape, tokens', () => {
    const msgs = [userText('fix the bug'), assistantToolUse('t1', 'ls'), toolResult('t1', 'a.ts b.ts')]
    const s = summarize(A, anthropicBody(msgs), {}, T0)
    expect(s.lastTurn).toBe('tool-result')
    expect(s.prefix.blockHashes).toHaveLength(msgs.length + 2)
    expect(s.prefix.blockHashes[0]).toBe(s.prefix.toolsHash)
    expect(s.prefix.blockHashes[1]).toBe(s.prefix.systemHash)
    expect(s.prefix.messageCount).toBe(3)
    expect(s.prefix.toolsHash).toMatch(/^[0-9a-f]{16}$/)
    expect(s.prefix.estPromptTokens).toBeGreaterThan(6000)
    expect(s.receivedAt).toBe(T0)
    expect(s.requestedModel).toBe('auto')

    expect(summarize(A, anthropicBody([userText('hi')]), {}, T0).lastTurn).toBe('user-text')
    expect(summarize(A, anthropicBody([userText('hi'), { role: 'assistant', content: '{' }]), {}, T0).lastTurn).toBe('assistant')
    expect(summarize(A, anthropicBody([]), {}, T0).lastTurn).toBe('other')
  })

  it('appending a message extends the chain (prefix property)', () => {
    const a = summarize(A, anthropicBody([userText('one')]), {}, T0)
    const b = summarize(A, anthropicBody([userText('one'), assistantToolUse('t', 'x'), toolResult('t', 'y')]), {}, T0)
    expect(b.prefix.blockHashes.slice(0, a.prefix.blockHashes.length)).toEqual(a.prefix.blockHashes)
  })

  it('cache-relevant params reset the message chain but keep tools/system (and the family)', () => {
    const base = anthropicBody([userText('one')])
    const s1 = summarize(A, base, {}, T0)
    const s2 = summarize(A, { ...base, thinking: { type: 'enabled', budget_tokens: 2000 } }, {}, T0)
    expect(s2.prefix.toolsHash).toBe(s1.prefix.toolsHash)
    expect(s2.prefix.systemHash).toBe(s1.prefix.systemHash)
    expect(s2.prefix.blockHashes[2]).not.toBe(s1.prefix.blockHashes[2])
    expect(templateFamilyOf(s2)).toBe(templateFamilyOf(s1))
    expect(summarize(A, { ...base, tool_choice: { type: 'any' } }, {}, T0).prefix.blockHashes[2]).not.toBe(s1.prefix.blockHashes[2])
    // max_tokens is not cache-relevant
    expect(summarize(A, { ...base, max_tokens: 1 }, {}, T0).prefix.blockHashes).toEqual(s1.prefix.blockHashes)
    // Insertion order is kept on purpose: reordered keys really do miss at the provider.
    const reordered = { ...base, messages: [{ content: [{ type: 'text', text: 'one' }], role: 'user' }] }
    expect(summarize(A, reordered, {}, T0).prefix.blockHashes[2]).not.toBe(s1.prefix.blockHashes[2])
  })

  it('moving cache breakpoints (cache_control) do not break the chain', () => {
    // Claude Code style: only the newest message carries cache_control; the TTL inside it may change too.
    const bp = (msgs: Array<[string, string]>, ttl?: string) => anthropicBody(msgs.map(([role, text], i) => ({
      role, content: [{ type: 'text', text, ...(i === msgs.length - 1 ? { cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } } : {}) }],
    })))
    const t1 = summarize(A, bp([['user', 'one']]), {}, T0)
    const t2 = summarize(A, bp([['user', 'one'], ['assistant', 'ok'], ['user', 'two']], '1h'), {}, T0)
    expect(t2.prefix.blockHashes.slice(0, t1.prefix.blockHashes.length)).toEqual(t1.prefix.blockHashes)
    // markers on system/tools do not change the template family either
    const sys = summarize(A, anthropicBody([userText('one')], { system: [{ type: 'text', text: 'S' }] }), {}, T0)
    const sysBp = summarize(A, anthropicBody([userText('one')], { system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }] }), {}, T0)
    expect(templateFamilyOf(sysBp)).toBe(templateFamilyOf(sys))
    // real content changes still do
    expect(summarize(A, bp([['user', 'ONE']]), {}, T0).prefix.blockHashes[2]).not.toBe(t1.prefix.blockHashes[2])
  })

  it('thinking signatures and redacted thinking are non-portable state', () => {
    const s = summarize(A, anthropicBody([userText('q'), assistantThinking('a'), userText('more')]), {}, T0)
    expect(s.nonPortableState).toEqual(['anthropic-thinking-signature'])
    const r = summarize(A, anthropicBody([userText('q'), { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }, userText('m')]), {}, T0)
    expect(r.nonPortableState).toEqual(['anthropic-thinking-signature'])
    // unsigned thinking blocks are portable
    const u = summarize(A, anthropicBody([userText('q'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }]), {}, T0)
    expect(u.nonPortableState).toEqual([])
  })

  it('base64 media counts as a flat token cost', () => {
    const data = 'A'.repeat(400_000)
    const img = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'what is this' }] }
    const withImg = summarize(A, anthropicBody([img], { system: 'sys', tools: [] }), {}, T0)
    const noImg = summarize(A, anthropicBody([{ role: 'user', content: [{ type: 'text', text: 'what is this' }] }], { system: 'sys', tools: [] }), {}, T0)
    const delta = withImg.prefix.estPromptTokens - noImg.prefix.estPromptTokens
    expect(delta).toBeGreaterThan(MEDIA_TOKENS)
    expect(delta).toBeLessThan(MEDIA_TOKENS + 40)
    // nested inside a tool_result too
    const nested = toolResult('t', 'x') as { content: Array<Record<string, unknown>> }
    nested.content[0]!.content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]
    expect(summarize(A, anthropicBody([nested], { system: 'sys', tools: [] }), {}, T0).prefix.estPromptTokens).toBeLessThan(MEDIA_TOKENS + 100)
  })

  it('uses a pluggable estimator', () => {
    const s = summarize(A, anthropicBody([userText('x')]), {}, T0, { estimateTokens: () => 7 })
    expect(s.prefix.estPromptTokens).toBe(21) // tools + system + 1 message
  })

  it('never throws on odd bodies', () => {
    for (const body of [null, 42, 'str', [], { messages: 'nope', system: 5 }, { messages: [null, 3, { role: 'user', content: 7 }] }]) {
      const s = summarize(A, body, {}, T0)
      expect(s.prefix.blockHashes.length).toBeGreaterThanOrEqual(2)
      expect(s.requestedModel).toBe('')
    }
  })

  it('never throws on raw Node headers (string[] values, non-strings, missing object)', () => {
    const raw = { 'X-Session-Id': ['s1', 's2'], 'set-cookie': ['a=1'], 'x-num': 5, 'x-router-tier': ['fast'] } as unknown as Record<string, string>
    const s = summarize(A, anthropicBody([userText('hi')]), raw, T0)
    expect(s.session).toMatchObject({ root: 's1, s2', source: 'header' })
    expect(s.hints.tier).toBe('fast')
    expect(summarize(A, anthropicBody([userText('hi')]), undefined as unknown as Record<string, string>, T0).session.source).toBe('fingerprint')
  })
})

describe('summarize: openai-chat', () => {
  const chat = (messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: 'auto', messages: [{ role: 'system', content: 'be brief' }, { role: 'developer', content: 'dev' }, ...messages], ...extra,
  })
  it('lastTurn per role; leading system/developer messages form the system layer', () => {
    expect(summarize('openai-chat', chat([{ role: 'user', content: 'hi' }]), {}, T0).lastTurn).toBe('user-text')
    expect(summarize('openai-chat', chat([{ role: 'tool', tool_call_id: '1', content: 'x' }]), {}, T0).lastTurn).toBe('tool-result')
    expect(summarize('openai-chat', chat([{ role: 'function', name: 'f', content: 'x' }]), {}, T0).lastTurn).toBe('tool-result')
    expect(summarize('openai-chat', chat([{ role: 'assistant', content: 'x' }]), {}, T0).lastTurn).toBe('assistant')
    expect(summarize('openai-chat', chat([{ role: 'system', content: 'late' }]), {}, T0).lastTurn).toBe('other')
    const s = summarize('openai-chat', chat([{ role: 'user', content: 'hi' }]), {}, T0)
    expect(s.prefix.messageCount).toBe(1)
    const other = summarize('openai-chat', { ...chat([{ role: 'user', content: 'hi' }]), messages: [{ role: 'system', content: 'different' }, { role: 'user', content: 'hi' }] }, {}, T0)
    expect(other.prefix.systemHash).not.toBe(s.prefix.systemHash)
  })
  it('kimi reasoning_content tag, prompt_cache_key session', () => {
    const s = summarize('openai-chat', chat([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning_content: 'because' }, { role: 'user', content: 'q2' }], { prompt_cache_key: 'pck-1' }), {}, T0)
    expect(s.nonPortableState).toEqual(['kimi-reasoning-content'])
    expect(s.session).toMatchObject({ source: 'header', root: 'pck-1' })
    expect(s.session.lineage.startsWith('pck-1/t:')).toBe(true)
  })
  it('moving prompt_cache_breakpoint markers (Bedrock GPT/Kimi) do not break the chain', () => {
    const part = (text: string, bp: boolean) => ({ type: 'text', text, ...(bp ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}) })
    const a = summarize('openai-chat', chat([{ role: 'user', content: [part('q', true)] }]), {}, T0)
    const b = summarize('openai-chat', chat([{ role: 'user', content: [part('q', false)] }, { role: 'assistant', content: 'a' }, { role: 'user', content: [part('q2', true)] }]), {}, T0)
    expect(b.prefix.blockHashes.slice(0, a.prefix.blockHashes.length)).toEqual(a.prefix.blockHashes)
  })
  it('reasoning_effort is cache-relevant', () => {
    const a = summarize('openai-chat', chat([{ role: 'user', content: 'q' }]), {}, T0)
    const b = summarize('openai-chat', chat([{ role: 'user', content: 'q' }], { reasoning_effort: 'high' }), {}, T0)
    expect(a.prefix.blockHashes[2]).not.toBe(b.prefix.blockHashes[2])
    expect(a.prefix.systemHash).toBe(b.prefix.systemHash)
  })
})

describe('summarize: openai-responses', () => {
  it('lastTurn, previous_response_id, encrypted reasoning, instructions', () => {
    expect(summarize('openai-responses', { model: 'auto', input: 'hello' }, {}, T0).lastTurn).toBe('user-text')
    const items = [
      { role: 'user', content: 'q' },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAA...' },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ]
    const s = summarize('openai-responses', { model: 'auto', instructions: 'be nice', input: items, previous_response_id: 'resp_9' }, {}, T0)
    expect(s.lastTurn).toBe('tool-result')
    expect(s.previousResponseId).toBe('resp_9')
    expect(s.nonPortableState).toEqual(['openai-encrypted-reasoning'])
    expect(summarize('openai-responses', { input: [{ type: 'custom_tool_call_output', call_id: 'x', output: 'y' }] }, {}, T0).lastTurn).toBe('tool-result')
    expect(summarize('openai-responses', { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] }, {}, T0).lastTurn).toBe('user-text')
    expect(summarize('openai-responses', { input: [{ type: 'message', role: 'assistant', content: [] }] }, {}, T0).lastTurn).toBe('other')
    const i2 = summarize('openai-responses', { model: 'auto', instructions: 'other', input: items }, {}, T0)
    expect(i2.prefix.systemHash).not.toBe(s.prefix.systemHash)
  })
  it('headerless chain uses resp: lineage; with a header it keeps the session lineage', () => {
    const s = summarize('openai-responses', { input: [{ role: 'user', content: 'q' }], previous_response_id: 'resp_1' }, {}, T0)
    expect(s.session.lineage).toBe('resp:resp_1')
    expect(s.session.source).toBe('fingerprint')
    const h = summarize('openai-responses', { input: [{ role: 'user', content: 'q' }], previous_response_id: 'resp_1' }, { 'x-session-id': 'S' }, T0)
    expect(h.session.lineage.startsWith('S/t:')).toBe(true)
  })
})

describe('summarize: session key, lineage and hints (scenarios 5, 6, 20)', () => {
  const body = anthropicBody([userText('hello')])
  it('header precedence: x-router-session > x-claude-code-session-id > x-session-id > fingerprint', () => {
    const all = { 'X-Router-Session': 'coop', 'x-claude-code-session-id': 'cc', 'x-session-id': 'gen' }
    expect(summarize(A, body, all, T0).session).toMatchObject({ root: 'coop', source: 'cooperative' })
    expect(summarize(A, body, { 'x-claude-code-session-id': 'cc', 'x-session-id': 'gen' }, T0).session).toMatchObject({ root: 'cc', source: 'header' })
    expect(summarize(A, body, { 'x-session-id': 'gen' }, T0).session).toMatchObject({ root: 'gen', source: 'header' })
    const fp = summarize(A, body, {}, T0).session
    expect(fp.source).toBe('fingerprint')
    expect(fp.root).toMatch(/^fp:[0-9a-f]{16}$/)
    // tenant separates otherwise identical fingerprints; the same request fingerprints identically
    expect(summarize(A, body, { 'x-router-tenant': 't2' }, T0).session.root).not.toBe(fp.root)
    expect(summarize(A, anthropicBody([userText('hello'), assistantToolUse('t', 'x')]), {}, T0).session.root).toBe(fp.root)
    // prompt_cache_key is ignored on Anthropic bodies
    expect(summarize(A, { ...body, prompt_cache_key: 'k' }, {}, T0).session.source).toBe('fingerprint')
  })

  it('hints parse and invalid values are dropped', () => {
    const s = summarize(A, body, {
      'x-router-pin': SONNET_ID, 'x-router-tier': 'Frontier', 'x-router-boundary': 'compaction',
      'x-router-parent-session': 'parent', 'x-router-agent-id': 'explore', 'x-claude-code-session-id': 'child',
    }, T0)
    expect(s.hints).toEqual({ pin: SONNET_ID, tier: 'frontier', boundary: 'compaction', parentSession: 'parent', agentId: 'explore' })
    expect(s.session).toEqual({ root: 'parent', lineage: 'child/a:explore', source: 'header' })
    expect(summarize(A, body, { 'x-router-tier': 'mega', 'x-router-boundary': 'later', 'x-router-pin': '  ' }, T0).hints).toEqual({})
  })

  it('scenario 5: sub-agent with the same session header but a different system gets its own lineage', () => {
    const hdr = { 'x-claude-code-session-id': 'sess' }
    const main = summarize(A, anthropicBody([userText('task')], { system: MAIN_SYSTEM }), hdr, T0)
    const sub = summarize(A, anthropicBody([userText('explore src/')], { system: EXPLORE_SYSTEM }), hdr, T0)
    expect(sub.session.root).toBe(main.session.root)
    expect(sub.session.lineage).not.toBe(main.session.lineage)
    expect(main.session.lineage).toBe(`sess/t:${templateFamilyOf(main)}`)
  })

  it('scenario 6: a fork (same tools and system) shares the parent lineage and extends its chain', () => {
    const hdr = { 'x-claude-code-session-id': 'sess' }
    const hist = [userText('task'), assistantToolUse('t1', 'ls'), toolResult('t1', 'ok')]
    const parent = summarize(A, anthropicBody(hist), hdr, T0)
    const fork = summarize(A, anthropicBody([...hist, userText('summarize the conversation so far')]), hdr, T0)
    expect(fork.session.lineage).toBe(parent.session.lineage)
    expect(fork.prefix.blockHashes).toEqual(expect.arrayContaining(parent.prefix.blockHashes))
  })
})

const SONNET_ID = 'global.anthropic.claude-sonnet-5-5'

describe.skipIf(process.env.CORE_SKIP_PERF === '1')('summarize performance (scenario 22)', () => {
  it('1 MB body: p50 < 10 ms over 20 runs', () => {
    const messages: unknown[] = [userText(filler(2000, 'task'))]
    for (let i = 0; messages.length < 400; i++) {
      messages.push(assistantToolUse(`t${i}`, `cat src/file${i}.ts`))
      messages.push(toolResult(`t${i}`, filler(1200, `f${i}`)))
    }
    // Claude Code marks the newest message; that block takes the marker-stripping path.
    const last = messages[messages.length - 1] as { content: Array<Record<string, unknown>> }
    last.content[0]!.cache_control = { type: 'ephemeral' }
    const body = JSON.parse(JSON.stringify(anthropicBody(messages))) as unknown
    const size = JSON.stringify(body).length
    expect(size).toBeGreaterThan(1_000_000)
    expect(size).toBeLessThan(1_200_000)
    for (let i = 0; i < 5; i++) summarize(A, body, { 'x-claude-code-session-id': 's' }, T0) // warm-up
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      summarize(A, body, { 'x-claude-code-session-id': 's' }, T0)
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const p50 = times[10] as number
    console.log(`summarize 1 MB (${(size / 1e6).toFixed(2)} MB, ${messages.length} msgs): p50=${p50.toFixed(2)} ms max=${times[19]!.toFixed(2)} ms`)
    expect(p50).toBeLessThan(10)
  })
})
