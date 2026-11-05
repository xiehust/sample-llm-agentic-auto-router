// Adapter selection (design §5): Claude models use Messages; others use config.api ?? 'responses'.
import type { ModelPrice } from '@auto-router/pricing'
import { anthropicMessagesAdapter } from './anthropic-messages.ts'
import { openAiChatAdapter } from './openai-chat.ts'
import { openAiResponsesAdapter } from './openai-responses.ts'
import type { ModelAdapter } from './types.ts'

export type OpenAiApi = 'responses' | 'chat'

/**
 * Picks the adapter for a catalog model. With no `api`, a model that lacks Responses but has Chat uses Chat.
 * Throws (configuration time) when the model has no dialect the assessor supports or `api` names one it lacks.
 */
export function selectAdapter(model: ModelPrice, api?: OpenAiApi): ModelAdapter {
  if (model.dialects.includes('anthropic-messages')) return anthropicMessagesAdapter
  const has = (a: OpenAiApi) => model.dialects.includes(a === 'responses' ? 'openai-responses' : 'openai-chat')
  const chosen: OpenAiApi | undefined = api ?? (has('responses') ? 'responses' : has('chat') ? 'chat' : undefined)
  if (!chosen || !has(chosen)) {
    throw new Error(`assessor: model ${model.modelId} does not support ${chosen ?? 'a supported API'} (dialects: ${model.dialects.join(', ')})`)
  }
  return chosen === 'responses' ? openAiResponsesAdapter : openAiChatAdapter
}

export { anthropicMessagesAdapter, BEDROCK_ANTHROPIC_VERSION } from './anthropic-messages.ts'
export { openAiChatAdapter } from './openai-chat.ts'
export { openAiResponsesAdapter } from './openai-responses.ts'
export type { AdapterCfg, BuildParams, ModelAdapter, ParseResult } from './types.ts'
export { SCHEMA_NAME, TOOL_NAME } from './types.ts'
