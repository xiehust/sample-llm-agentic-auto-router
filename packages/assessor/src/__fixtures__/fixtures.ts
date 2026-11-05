// Test fixtures: hand-built RequestSummary values and Bedrock response bodies. The usage objects are copied from
// @auto-router/pricing's ap-northeast-1 fixtures (src/__fixtures__/*/nonstream-read.json, ids already scrubbed).
import type { RequestSummary } from '@auto-router/core'
import type { Dialect } from '@auto-router/pricing'
import type { Assessment } from '../validate.ts'

export function summaryOf(dialect: Dialect, over: Partial<RequestSummary> = {}): RequestSummary {
  return {
    dialect,
    requestedModel: 'auto',
    session: { root: 's1', lineage: 's1/t:abc', source: 'header' },
    lastTurn: 'user-text',
    nonPortableState: [],
    prefix: { toolsHash: 'tools-hash-1', systemHash: 'system-hash-1', blockHashes: [], estPromptTokens: 12345, messageCount: 1 },
    hints: {},
    receivedAt: 0,
    ...over,
  }
}

export const RULE_IDS = ['explore-readonly', 'mechanical-edit', 'bounded-change', 'deep-investigation'] as const

/** A valid output for the default pack's four rules. `matched` lists the rule ids judged as matching. */
export function output(matched: string[], facts: Partial<Assessment['task_facts']> = {}, confidence = 0.9): Assessment {
  return {
    rule_assessments: RULE_IDS.map((id) => ({ rule_id: id, matched: matched.includes(id), reason: matched.includes(id) ? 'fits' : 'does not fit' })),
    task_facts: { edits_code: false, scope: 'none', specification: 'fully-specified', reasoning_depth: 'lookup', prior_failures: 0, ...facts },
    confidence,
    reason: 'Short summary of the work.',
  }
}

export const RESPONSES_USAGE = {
  input_tokens: 3048,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 3046 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 3053,
}

export const CHAT_USAGE = {
  completion_tokens: 5,
  completion_tokens_details: { accepted_prediction_tokens: 0, audio_tokens: 0, reasoning_tokens: 0, rejected_prediction_tokens: 0 },
  prompt_tokens: 3048,
  prompt_tokens_details: { audio_tokens: 0, cache_write_tokens: 0, cached_tokens: 3046 },
  total_tokens: 3053,
}

export const MESSAGES_USAGE = {
  input_tokens: 11,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3169,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { thinking_tokens: 0 },
  service_tier: 'standard',
}

export function responsesBody(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_SCRUBBED1',
    object: 'response',
    model: 'global.openai.gpt-6-luna',
    status: 'completed',
    incomplete_details: null,
    output: [
      { id: 'rs_SCRUBBED', type: 'reasoning', summary: [] },
      { id: 'msg_SCRUBBED2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text }] },
    ],
    store: false,
    usage: RESPONSES_USAGE,
    ...over,
  }
}

export function chatBody(content: string | null, over: { finish_reason?: string; refusal?: string | null } = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-SCRUBBED1',
    object: 'chat.completion',
    model: 'global.openai.gpt-6-luna',
    choices: [{ index: 0, finish_reason: over.finish_reason ?? 'stop', message: { role: 'assistant', content, refusal: over.refusal ?? null, annotations: [] } }],
    usage: CHAT_USAGE,
  }
}

export function messagesBody(content: unknown[], stopReason = 'tool_use'): Record<string, unknown> {
  return {
    id: 'msg_SCRUBBED1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: MESSAGES_USAGE,
  }
}

export const toolUse = (input: unknown, name = 'record_tier_assessment') => ({ type: 'tool_use', id: 'toolu_SCRUBBED', name, input })
