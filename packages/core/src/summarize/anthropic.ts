// anthropic-messages extractor.
import type { LastTurn } from '../types.ts'
import { arr, count, isObj, type Extracted, type Obj } from './extract.ts'

export function extractAnthropic(body: Obj): Extracted {
  const messages = arr(body.messages)
  const tags = new Set<string>()
  let firstUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isObj(m)) continue
    if (m.role === 'user' && firstUserIndex < 0) firstUserIndex = i
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!isObj(part)) continue
        // Signed thinking and redacted thinking can only be replayed to a Claude model.
        if ((part.type === 'thinking' && typeof part.signature === 'string' && part.signature !== '') || part.type === 'redacted_thinking') {
          tags.add('anthropic-thinking-signature')
        }
      }
    }
  }
  const out: Extracted = {
    params: [body.tool_choice, body.thinking, body.output_config],
    tools: body.tools,
    system: body.system,
    messages,
    firstUserIndex,
    lastTurn: lastTurnOf(lastNonSystem(messages)),
    nonPortableState: [...tags],
  }
  const maxOut = count(body.max_tokens)
  if (maxOut !== undefined) out.maxOutputTokens = maxOut
  return out
}

/**
 * The last message that is not role `system`. Claude Code 2.1 sends mid-conversation system messages (the environment
 * block after the first prompt, background-task notifications, a subagent's first request, the request after a
 * compaction); they are not a turn, so the turn type comes from the message before them. Only lastTurn uses this:
 * system-role messages stay in the prefix chain, messageCount and turnKey (they are part of the cached prompt).
 */
function lastNonSystem(messages: unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!(isObj(m) && m.role === 'system')) return m
  }
  return undefined
}

function lastTurnOf(m: unknown): LastTurn {
  if (!isObj(m)) return 'other'
  if (m.role === 'assistant') return 'assistant'
  if (m.role !== 'user') return 'other'
  if (Array.isArray(m.content) && m.content.some((p) => isObj(p) && p.type === 'tool_result')) return 'tool-result'
  return 'user-text'
}
