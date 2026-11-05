// openai-responses extractor.
import type { LastTurn } from '../types.ts'
import { arr, count, isObj, str, type Extracted, type Obj } from './extract.ts'

const SYSTEM_ROLES = new Set(['system', 'developer'])

export function extractOpenAiResponses(body: Obj): Extracted {
  // A string input is one user message.
  const all: unknown[] = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : arr(body.input)
  let lead = 0
  while (lead < all.length && isObj(all[lead]) && SYSTEM_ROLES.has((all[lead] as Obj).role as string)) lead++
  const messages = all.slice(lead)

  const tags = new Set<string>()
  let firstUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isObj(m)) continue
    if (m.role === 'user' && firstUserIndex < 0) firstUserIndex = i
    if (m.type === 'reasoning' && typeof m.encrypted_content === 'string' && m.encrypted_content !== '') tags.add('openai-encrypted-reasoning')
  }
  const out: Extracted = {
    params: [body.tool_choice, body.parallel_tool_calls, body.text, body.reasoning],
    tools: body.tools,
    // System layer: `instructions` plus leading system/developer items.
    system: [body.instructions ?? null, ...all.slice(0, lead)],
    messages,
    firstUserIndex,
    lastTurn: typeof body.input === 'string' ? 'user-text' : lastTurnOf(messages[messages.length - 1]),
    nonPortableState: [...tags],
  }
  const prev = str(body.previous_response_id)
  if (prev) out.previousResponseId = prev
  const key = str(body.prompt_cache_key)
  if (key) out.promptCacheKey = key
  const maxOut = count(body.max_output_tokens)
  if (maxOut !== undefined) out.maxOutputTokens = maxOut
  return out
}

function lastTurnOf(m: unknown): LastTurn {
  if (!isObj(m)) return 'other'
  if (typeof m.type === 'string' && m.type.endsWith('_call_output')) return 'tool-result'
  if (m.role === 'user' && (m.type === undefined || m.type === 'message')) return 'user-text'
  return 'other'
}
