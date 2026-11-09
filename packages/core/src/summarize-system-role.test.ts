// Claude Code 2.1 sends role-`system` messages inside `messages` (task 11-07-claude-code-harbor-eval; shapes from the
// 2.1.318 capture: the environment block after the first prompt, a background-task notification after a tool_result,
// a subagent's first request, the first request after a compaction). lastTurn skips them; nothing else changes.
import { describe, expect, it } from 'vitest'
import { OPUS, SONNET } from './__fixtures__/catalog.ts'
import { assistantToolUse, Conversation, Harness, SEC, T0, testPolicy, toolResult, userText } from './__fixtures__/traces.ts'
import { summarize } from './summarize/index.ts'
import type { AssessorResult, LastTurn, TierAssessor } from './types.ts'

const sys = (text: string): unknown => ({ role: 'system', content: text })
const ENV = sys('# Environment\nYou have been invoked in the following environment: (synthetic)')
const NOTE = sys('[SYSTEM NOTIFICATION - NOT USER INPUT] background task finished (synthetic)')
const H = { 'x-router-session': 'trial-1' }

function lastTurn(...messages: unknown[]): LastTurn {
  return summarize('anthropic-messages', new Conversation().push(...messages).body(), H, T0).lastTurn
}

/** The pre-fix rule (last message, whatever its role): the reference for bodies without system-role messages. */
function previousRule(messages: unknown[]): LastTurn {
  const m = messages.at(-1) as Record<string, unknown> | undefined
  if (!m || typeof m !== 'object') return 'other'
  if (m.role === 'assistant') return 'assistant'
  if (m.role !== 'user') return 'other'
  return Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === 'tool_result') ? 'tool-result' : 'user-text'
}

class Fake implements TierAssessor {
  readonly id = 'fake/v1'
  calls = 0
  async assess(): Promise<AssessorResult> { this.calls++; return { status: 'ok', tier: 'frontier', confidence: 0.95, audit: {}, latencyMs: 1 } }
}

describe('anthropic lastTurn skips role-system messages', () => {
  it('Claude Code 2.1 shapes: first request, notification after a tool_result, post-compaction, subagent first', () => {
    expect(lastTurn(userText('fix the test'), ENV)).toBe('user-text')
    expect(lastTurn(userText('fix the test'), ENV, assistantToolUse('t1', 'ls'), toolResult('t1', 'a.py'), NOTE)).toBe('tool-result')
    // after a compaction Claude Code keeps the last tool step: the user message carries the summary text and the tool_result
    const post = { role: 'user', content: [{ type: 'text', text: 'summary of the work so far' }, { type: 'tool_result', tool_use_id: 't9', content: 'ok' }] }
    expect(lastTurn(userText('fix the test'), ENV, assistantToolUse('t9', 'cat x'), post, NOTE)).toBe('tool-result')
    expect(lastTurn(userText('summary only'), sys('continue'))).toBe('user-text')
    expect(lastTurn(userText('look into the parser'), sys('deferred tools are now available'))).toBe('user-text')
    // an assistant message (prefill or a resumed turn) before a trailing system message: still the assistant's turn
    expect(lastTurn(userText('a'), { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] }, NOTE)).toBe('assistant')
  })

  it('only system-role messages, or none: other, as before', () => {
    expect(lastTurn(sys('a'), sys('b'))).toBe('other')
    expect(lastTurn()).toBe('other')
  })

  it('bodies without a system-role message: the same lastTurn as the previous rule', () => {
    const shapes: unknown[][] = [
      [userText('a')], [userText('a'), assistantToolUse('t', 'ls')], [userText('a'), assistantToolUse('t', 'ls'), toolResult('t', 'x')],
      [userText('a'), { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] }], [{ role: 'developer', content: 'x' }], ['junk'],
    ]
    for (const m of shapes) expect(lastTurn(...m)).toBe(previousRule(m))
  })

  it('system-role messages stay in the prefix chain and messageCount', () => {
    const a = summarize('anthropic-messages', new Conversation().push(userText('x')).body(), H, T0)
    const b = summarize('anthropic-messages', new Conversation().push(userText('x'), ENV).body(), H, T0)
    expect(b.prefix.messageCount).toBe(a.prefix.messageCount + 1)
    expect(b.prefix.blockHashes.length).toBe(a.prefix.blockHashes.length + 1)
    expect(b.prefix.blockHashes.slice(0, -1)).toEqual(a.prefix.blockHashes)
  })
})

describe('decisions on the Claude Code shapes', () => {
  it('first request consults and counts a user turn; the notification turn mid tool loop is hard-locked', async () => {
    const a = new Fake()
    const hz = new Harness(testPolicy({ userTurn: 'retain' }), { assessor: a, assessorMode: 'auto' }, { card: () => ({ v: 'card' }) })
    const conv = new Conversation().push(userText('fix the test'), ENV)
    const first = await hz.step('anthropic-messages', conv.body(), H)
    expect(first.summary.lastTurn).toBe('user-text')
    expect(first.decision).toMatchObject({ point: 'session-start', model: OPUS })
    expect(a.calls).toBe(1)
    expect((await hz.store.get(first.summary.session.lineage))!.turns).toBe(1)
    conv.push(assistantToolUse('t1', 'ls'), toolResult('t1', 'a.py'), NOTE)
    const note = await hz.step('anthropic-messages', conv.body(), H, { at: T0 + SEC })
    expect(note.summary.lastTurn).toBe('tool-result')
    expect(note.decision).toMatchObject({ point: 'hard-lock-tool-loop', action: 'retain', model: OPUS })
    expect(a.calls).toBe(1)
  })

  it('observe default policy: the first request is a user-text session start on the observe default', async () => {
    const hz = new Harness(testPolicy({ mode: 'observe', observeDefaults: { 'anthropic-messages': SONNET, 'openai-chat': 'global.openai.gpt-6.1-sol', 'openai-responses': 'global.openai.gpt-6.1-sol' } }))
    const s = await hz.step('anthropic-messages', new Conversation().push(userText('x'), ENV).body(), H)
    expect(s.summary.lastTurn).toBe('user-text')
    expect(s.decision).toMatchObject({ point: 'session-start', model: SONNET })
  })
})
