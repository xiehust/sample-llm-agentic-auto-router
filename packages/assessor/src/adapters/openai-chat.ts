// OpenAI Chat Completions on bedrock-runtime: strict response_format json_schema (fallback for Responses).
import { isObj, parseJsonText, SCHEMA_NAME, type ModelAdapter } from './types.ts'

export const openAiChatAdapter: ModelAdapter = {
  dialect: 'openai-chat',
  buildRequest({ model, system, user, schema, cfg }) {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema } },
      max_completion_tokens: cfg.maxOutputTokens,
    }
    if (cfg.reasoningEffort !== null) body.reasoning_effort = cfg.reasoningEffort
    return { path: '/openai/v1/chat/completions', body }
  },
  parse(body) {
    if (!isObj(body) || !Array.isArray(body.choices)) return { ok: false, reason: 'parse: no choices' }
    const choice: unknown = body.choices[0]
    if (!isObj(choice) || !isObj(choice.message)) return { ok: false, reason: 'parse: no message' }
    const m = choice.message
    if (typeof m.refusal === 'string' && m.refusal !== '') return { ok: false, reason: 'refusal: model refused' }
    if (choice.finish_reason !== 'stop') return { ok: false, reason: `incomplete: finish_reason=${String(choice.finish_reason)}` }
    if (typeof m.content !== 'string' || m.content === '') return { ok: false, reason: 'parse: no content' }
    return parseJsonText(m.content)
  },
}
