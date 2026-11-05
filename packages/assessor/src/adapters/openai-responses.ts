// OpenAI Responses on bedrock-runtime (default for Luna): strict json_schema output, store:false.
import { isObj, parseJsonText, SCHEMA_NAME, type ModelAdapter } from './types.ts'

export const openAiResponsesAdapter: ModelAdapter = {
  dialect: 'openai-responses',
  buildRequest({ model, system, user, schema, cfg }) {
    const body: Record<string, unknown> = {
      model,
      input: [{ role: 'developer', content: system }, { role: 'user', content: user }],
      text: { format: { type: 'json_schema', name: SCHEMA_NAME, strict: true, schema } },
      max_output_tokens: cfg.maxOutputTokens,
      store: false,
    }
    if (cfg.reasoningEffort !== null) body.reasoning = { effort: cfg.reasoningEffort }
    if (cfg.cache) body.prompt_cache_key = cfg.packVersion
    return { path: '/openai/v1/responses', body }
  },
  parse(body) {
    if (!isObj(body)) return { ok: false, reason: 'parse: response is not an object' }
    if (body.status !== 'completed') {
      const why = isObj(body.incomplete_details) && typeof body.incomplete_details.reason === 'string' ? ` (${body.incomplete_details.reason})` : ''
      return { ok: false, reason: `incomplete: status=${String(body.status)}${why}` }
    }
    const texts: string[] = []
    for (const item of Array.isArray(body.output) ? body.output : []) {
      if (!isObj(item) || item.type !== 'message') continue
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isObj(part)) continue
        if (part.type === 'refusal') return { ok: false, reason: 'refusal: model refused' }
        if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
      }
    }
    if (texts.length === 0) return { ok: false, reason: 'parse: no output_text' }
    return parseJsonText(texts.join(''))
  },
}
