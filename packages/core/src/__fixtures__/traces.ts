// Synthetic agent-trace builders, a fake cache-faithful provider, and an engine harness for tests.
import { createEngine, type EngineOptions } from '../engine.ts'
import { validatePolicy, type Policy, type PolicyInput } from '../policy.ts'
import type { Dialect, NormalizedUsage } from '../pricing-types.ts'
import { InMemoryStateStore } from '../store-memory.ts'
import type { Decision, DecideExtras, Engine, RecordResult, RequestSummary } from '../types.ts'
import { ASTRA, fixtureCatalog, HAIKU, LUNA, OPUS, SOL, SONNET, SONNET_JP } from './catalog.ts'

export const T0 = Date.UTC(2026, 10, 4, 9, 0, 0)
export const SEC = 1000
export const MIN = 60 * SEC

/** Deterministic text of roughly `tokens` tokens under the default chars/4 estimator. */
export function filler(tokens: number, salt = 'ctx'): string {
  const unit = `${salt} lorem ipsum dolor sit amet `
  return unit.repeat(Math.ceil((tokens * 4) / unit.length)).slice(0, tokens * 4)
}

// ---------- Anthropic Messages ----------
export const TOOLS = [
  { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'Task', description: 'Launch a sub-agent', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
]
export const MAIN_SYSTEM = [{ type: 'text', text: `You are a coding agent.\n${filler(6000, 'main')}`, cache_control: { type: 'ephemeral' } }]
export const EXPLORE_SYSTEM = [{ type: 'text', text: `You are a read-only explore sub-agent.\n${filler(3000, 'explore')}` }]

export const userText = (text: string): unknown => ({ role: 'user', content: [{ type: 'text', text }] })
export const assistantText = (text: string): unknown => ({ role: 'assistant', content: [{ type: 'text', text }] })
export const assistantToolUse = (id: string, command: string): unknown => ({
  role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
})
export const toolResult = (id: string, text: string): unknown => ({
  role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }],
})
export const assistantThinking = (text: string): unknown => ({
  role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig-abc' }, { type: 'text', text }],
})

export function anthropicBody(messages: unknown[], opts: { model?: string; system?: unknown; tools?: unknown } = {}): Record<string, unknown> {
  return { model: opts.model ?? 'auto', max_tokens: 4096, system: opts.system ?? MAIN_SYSTEM, tools: opts.tools ?? TOOLS, messages: [...messages] }
}

/** A growing Anthropic conversation. */
export class Conversation {
  readonly messages: unknown[] = []
  constructor(readonly opts: { system?: unknown; tools?: unknown; model?: string } = {}) {}
  push(...m: unknown[]): this {
    this.messages.push(...m)
    return this
  }
  body(model = this.opts.model): Record<string, unknown> {
    return anthropicBody(this.messages, { ...this.opts, ...(model ? { model } : {}) })
  }
}

// ---------- usage ----------
export function usage(read: number, write: number, ttl: '5m' | '1h' | '30m' = '5m', out = 250): NormalizedUsage {
  return { uncachedInputTokens: 0, cacheReadTokens: read, cacheWriteTokens: write > 0 ? { [ttl]: write } : {}, outputTokens: out, promptTokens: read + write }
}

/**
 * Cache-faithful fake provider: per model, remembers prefix hash → tokens with a TTL refreshed on hit;
 * a request reads the longest cached prefix of its chain and writes the rest.
 */
export class FakeProvider {
  private readonly cache = new Map<string, Map<string, { tokens: number; at: number; ttlMs: number }>>()
  call(model: string, s: RequestSummary, ttlMs = 5 * MIN): NormalizedUsage {
    const m = this.cache.get(model) ?? new Map<string, { tokens: number; at: number; ttlMs: number }>()
    this.cache.set(model, m)
    const P = s.prefix.estPromptTokens
    const minTokens = fixtureCatalog.models.find((x) => x.modelId === model)?.cache.minTokens ?? 0
    if (P < minTokens) return { uncachedInputTokens: P, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 250, promptTokens: P }
    let read = 0
    const hashes = s.prefix.blockHashes
    for (let i = hashes.length - 1; i >= 0; i--) {
      const e = m.get(hashes[i] as string)
      if (e && s.receivedAt - e.at <= e.ttlMs) {
        read = Math.min(e.tokens, P)
        e.at = s.receivedAt
        break
      }
    }
    m.set(hashes[hashes.length - 1] as string, { tokens: P, at: s.receivedAt, ttlMs })
    const isGpt = model.includes('openai')
    return usage(read, P - read, isGpt ? '30m' : '5m')
  }
}

// ---------- policy + harness ----------
export function testPolicy(over: Partial<PolicyInput> = {}): Policy {
  const openai = {
    defaultTier: 'standard' as const,
    models: [{ model: ASTRA }, { model: SOL }, { model: LUNA }],
  }
  return validatePolicy({
    version: 'test-v1',
    mode: 'auto',
    pools: {
      'anthropic-messages': {
        defaultTier: 'standard',
        models: [{ model: OPUS }, { model: SONNET, failover: [SONNET_JP] }, { model: HAIKU }],
      },
      'openai-chat': structuredClone(openai),
      'openai-responses': structuredClone(openai),
    },
    ...over,
  })
}

export interface Step { summary: RequestSummary; decision: Decision; result: RecordResult }

export class Harness {
  readonly store = new InMemoryStateStore()
  readonly provider = new FakeProvider()
  readonly engine: Engine
  now = T0
  constructor(policy: Policy = testPolicy(), engineOpts: Partial<EngineOptions> = {}, readonly extras?: DecideExtras) {
    this.engine = createEngine({ policy, catalog: fixtureCatalog, store: this.store, now: () => this.now, ...engineOpts })
  }
  /** summarize → decide → (fake provider) → record. `at` advances the clock. */
  async step(
    dialect: Dialect,
    body: unknown,
    headers: Record<string, string | undefined> = {},
    o: { at?: number; status?: number; served?: string; usage?: NormalizedUsage | null; responseId?: string } = {},
  ): Promise<Step> {
    if (o.at !== undefined) this.now = o.at
    const summary = this.engine.summarize(dialect, body, headers, this.now)
    const decision = this.extras ? await this.engine.decide(summary, this.extras) : await this.engine.decide(summary)
    const served = o.served ?? decision.model
    const status = o.status ?? 200
    const u = o.usage === null ? undefined : (o.usage ?? (status < 400 ? this.provider.call(served, summary) : undefined))
    const outcome = { servedModel: served, status, ...(u ? { usage: u } : {}), ...(o.responseId ? { responseId: o.responseId } : {}) }
    const result = await this.engine.record(summary, decision, outcome)
    return { summary, decision, result }
  }
  /** Same as step but anthropic-messages with a Claude Code session header. */
  cc(body: unknown, extra: Record<string, string> = {}, o: Parameters<Harness['step']>[3] = {}): Promise<Step> {
    return this.step('anthropic-messages', body, { 'x-claude-code-session-id': 'sess-1', ...extra }, o)
  }
}
