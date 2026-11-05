// Anthropic Messages on bedrock-runtime (Haiku 5.5 and other Claude lite models): one forced tool whose input schema
// is the output contract.
import { isObj, TOOL_NAME, type ModelAdapter } from './types.ts'

/** Bedrock Messages API version, sent in the body. Unverified until the smoke test (design §5). */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31'

export const anthropicMessagesAdapter: ModelAdapter = {
  dialect: 'anthropic-messages',
  buildRequest({ model, system, user, schema, cfg }) {
    const systemBlock: Record<string, unknown> = { type: 'text', text: system }
    if (cfg.cache) systemBlock.cache_control = { type: 'ephemeral' }
    const body = {
      anthropic_version: BEDROCK_ANTHROPIC_VERSION,
      model,
      max_tokens: cfg.maxOutputTokens,
      system: [systemBlock],
      messages: [{ role: 'user', content: user }],
      tools: [{ name: TOOL_NAME, description: 'Record the tier assessment of the task card.', input_schema: schema }],
      tool_choice: { type: 'tool', name: TOOL_NAME },
    }
    return { path: '/anthropic/v1/messages', body }
  },
  parse(body) {
    if (!isObj(body)) return { ok: false, reason: 'parse: response is not an object' }
    if (body.stop_reason === 'refusal') return { ok: false, reason: 'refusal: model refused' }
    if (body.stop_reason === 'max_tokens') return { ok: false, reason: 'incomplete: stop_reason=max_tokens' }
    const uses = (Array.isArray(body.content) ? body.content : []).filter((b: unknown) => isObj(b) && b.type === 'tool_use')
    if (uses.length !== 1) return { ok: false, reason: `parse: expected one tool_use block, got ${uses.length}` }
    const use = uses[0] as Record<string, unknown>
    if (use.name !== TOOL_NAME) return { ok: false, reason: 'parse: tool_use names another tool' }
    if (!isObj(use.input)) return { ok: false, reason: 'parse: tool_use input is not an object' }
    return { ok: true, raw: use.input }
  },
}
