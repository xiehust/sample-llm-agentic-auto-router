import { findModel, loadCatalog, type ModelPrice } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { chatBody, messagesBody, output, responsesBody, toolUse } from '../__fixtures__/fixtures.ts'
import { outputSchema } from '../schema.ts'
import {
  anthropicMessagesAdapter, BEDROCK_ANTHROPIC_VERSION, openAiChatAdapter, openAiResponsesAdapter, selectAdapter, type AdapterCfg,
} from './index.ts'

const catalog = loadCatalog()
const model = (id: string): ModelPrice => {
  const m = findModel(catalog, id)
  if (!m) throw new Error(`missing ${id}`)
  return m
}
const schema = outputSchema([{ id: 'explore-readonly' }])
const cfg: AdapterCfg = { maxOutputTokens: 800, reasoningEffort: 'none', cache: true, packVersion: 'assessor/v1+0123456789ab' }
const params = (m: string, c: AdapterCfg = cfg) => ({ model: m, system: 'SYSTEM', user: '<task_card>{}</task_card>', schema, cfg: c })
const valid = output(['explore-readonly'])

describe('golden request bodies', () => {
  it('OpenAI Responses', () => {
    expect(openAiResponsesAdapter.buildRequest(params('global.openai.gpt-6-luna'))).toEqual({
      path: '/openai/v1/responses',
      body: {
        model: 'global.openai.gpt-6-luna',
        input: [{ role: 'developer', content: 'SYSTEM' }, { role: 'user', content: '<task_card>{}</task_card>' }],
        text: { format: { type: 'json_schema', name: 'tier_assessment', strict: true, schema } },
        reasoning: { effort: 'none' },
        max_output_tokens: 800,
        store: false,
        prompt_cache_key: 'assessor/v1+0123456789ab',
      },
    })
    const off = openAiResponsesAdapter.buildRequest(params('m', { ...cfg, cache: false, reasoningEffort: null })).body as Record<string, unknown>
    expect(off).not.toHaveProperty('prompt_cache_key')
    expect(off).not.toHaveProperty('reasoning')
  })

  it('OpenAI Chat', () => {
    expect(openAiChatAdapter.buildRequest(params('global.openai.gpt-6-luna', { ...cfg, reasoningEffort: 'low' }))).toEqual({
      path: '/openai/v1/chat/completions',
      body: {
        model: 'global.openai.gpt-6-luna',
        messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: '<task_card>{}</task_card>' }],
        response_format: { type: 'json_schema', json_schema: { name: 'tier_assessment', strict: true, schema } },
        max_completion_tokens: 800,
        reasoning_effort: 'low',
      },
    })
  })

  it('Anthropic Messages with one forced tool', () => {
    expect(anthropicMessagesAdapter.buildRequest(params('global.anthropic.claude-haiku-5-5'))).toEqual({
      path: '/anthropic/v1/messages',
      body: {
        anthropic_version: BEDROCK_ANTHROPIC_VERSION,
        model: 'global.anthropic.claude-haiku-5-5',
        max_tokens: 800,
        system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: '<task_card>{}</task_card>' }],
        tools: [{ name: 'record_tier_assessment', description: 'Record the tier assessment of the task card.', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'record_tier_assessment' },
      },
    })
    expect(BEDROCK_ANTHROPIC_VERSION).toBe('bedrock-2023-05-31')
    const off = anthropicMessagesAdapter.buildRequest(params('m', { ...cfg, cache: false })).body as { system: unknown[] }
    expect(off.system).toEqual([{ type: 'text', text: 'SYSTEM' }])
  })
})

describe('OpenAI Responses parse', () => {
  const p = openAiResponsesAdapter.parse
  it('reads output_text JSON (skipping reasoning items)', () => {
    expect(p(responsesBody(JSON.stringify(valid)))).toEqual({ ok: true, raw: valid })
  })
  it('flags refusal, incomplete, missing text and non-JSON', () => {
    const refusal = responsesBody('', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] })
    expect(p(refusal)).toEqual({ ok: false, reason: 'refusal: model refused' })
    const incomplete = responsesBody('{"rule_', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    expect(p(incomplete)).toEqual({ ok: false, reason: 'incomplete: status=incomplete (max_output_tokens)' })
    expect(p(responsesBody('', { output: [] }))).toMatchObject({ ok: false, reason: 'parse: no output_text' })
    expect(p(responsesBody('not json'))).toMatchObject({ ok: false, reason: expect.stringMatching(/^parse:/) as unknown })
    expect(p('x')).toMatchObject({ ok: false })
  })
})

describe('OpenAI Chat parse', () => {
  const p = openAiChatAdapter.parse
  it('reads message content JSON', () => {
    expect(p(chatBody(JSON.stringify(valid)))).toEqual({ ok: true, raw: valid })
  })
  it('flags refusal, truncation, empty content and non-JSON', () => {
    expect(p(chatBody(null, { refusal: 'I cannot' }))).toEqual({ ok: false, reason: 'refusal: model refused' })
    expect(p(chatBody('{"rule_', { finish_reason: 'length' }))).toEqual({ ok: false, reason: 'incomplete: finish_reason=length' })
    expect(p(chatBody(null))).toMatchObject({ ok: false, reason: 'parse: no content' })
    expect(p(chatBody('```json\n{}\n```'))).toMatchObject({ ok: false, reason: expect.stringMatching(/^parse:/) as unknown })
    expect(p({ choices: [] })).toMatchObject({ ok: false })
  })
})

describe('Anthropic Messages parse', () => {
  const p = anthropicMessagesAdapter.parse
  it('reads the forced tool_use input', () => {
    expect(p(messagesBody([toolUse(valid)]))).toEqual({ ok: true, raw: valid })
  })
  it('flags missing or extra tool calls, other tools, truncation and refusal', () => {
    expect(p(messagesBody([{ type: 'text', text: JSON.stringify(valid) }], 'end_turn'))).toMatchObject({ ok: false, reason: 'parse: expected one tool_use block, got 0' })
    expect(p(messagesBody([toolUse(valid), toolUse(valid)]))).toMatchObject({ ok: false, reason: 'parse: expected one tool_use block, got 2' })
    expect(p(messagesBody([toolUse(valid, 'other_tool')]))).toMatchObject({ ok: false, reason: 'parse: tool_use names another tool' })
    expect(p(messagesBody([toolUse('string input')]))).toMatchObject({ ok: false, reason: 'parse: tool_use input is not an object' })
    expect(p(messagesBody([toolUse({})], 'max_tokens'))).toEqual({ ok: false, reason: 'incomplete: stop_reason=max_tokens' })
    expect(p(messagesBody([], 'refusal'))).toEqual({ ok: false, reason: 'refusal: model refused' })
  })
})

describe('selectAdapter', () => {
  it('uses Messages for Claude models and Responses by default for OpenAI-shape models', () => {
    expect(selectAdapter(model('global.anthropic.claude-haiku-5-5')).dialect).toBe('anthropic-messages')
    expect(selectAdapter(model('global.anthropic.claude-haiku-5-5'), 'chat').dialect).toBe('anthropic-messages')
    expect(selectAdapter(model('global.openai.gpt-6-luna')).dialect).toBe('openai-responses')
    expect(selectAdapter(model('global.openai.gpt-6-luna'), 'chat').dialect).toBe('openai-chat')
  })

  it('falls back to Chat when a model lacks Responses, and rejects an unsupported explicit api', () => {
    const chatOnly: ModelPrice = { ...model('global.openai.gpt-6-luna'), modelId: 'x.chat-only', dialects: ['openai-chat'] }
    expect(selectAdapter(chatOnly).dialect).toBe('openai-chat')
    expect(() => selectAdapter(chatOnly, 'responses')).toThrow(/does not support responses/)
    expect(() => selectAdapter({ ...chatOnly, dialects: [] })).toThrow(/does not support/)
  })
})
