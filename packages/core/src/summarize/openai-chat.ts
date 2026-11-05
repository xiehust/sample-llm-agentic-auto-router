// openai-chat (Chat Completions) extractor.
import type { LastTurn } from '../types.ts'
import { arr, count, isObj, str, type Extracted, type Obj } from './extract.ts'

const SYSTEM_ROLES = new Set(['system', 'developer'])

export function extractOpenAiChat(body: Obj): Extracted {
  const all = arr(body.messages)
  // Leading system/developer messages form the system layer; everything after is a chain block.
  let lead = 0
  while (lead < all.length && isObj(all[lead]) && SYSTEM_ROLES.has((all[lead] as Obj).role as string)) lead++
  const system = all.slice(0, lead)
  const messages = all.slice(lead)

  const tags = new Set<string>()
  let firstUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isObj(m)) continue
    if (m.role === 'user' && firstUserIndex < 0) firstUserIndex = i
    if (m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content !== '') tags.add('kimi-reasoning-content')
  }
  const out: Extracted = {
    params: [body.tool_choice, body.parallel_tool_calls, body.response_format, body.reasoning_effort],
    tools: body.tools ?? body.functions,
    system,
    messages,
    firstUserIndex,
    lastTurn: lastTurnOf(messages[messages.length - 1]),
    nonPortableState: [...tags],
  }
  const key = str(body.prompt_cache_key)
  if (key) out.promptCacheKey = key
  const maxOut = count(body.max_completion_tokens, body.max_tokens)
  if (maxOut !== undefined) out.maxOutputTokens = maxOut
  return out
}

function lastTurnOf(m: unknown): LastTurn {
  if (!isObj(m)) return 'other'
  switch (m.role) {
    case 'tool':
    case 'function':
      return 'tool-result'
    case 'user':
      return 'user-text'
    case 'assistant':
      return 'assistant'
    default:
      return 'other'
  }
}
