import { UsageNotFoundError } from './errors.ts'
import type { CacheTtl, Dialect, NormalizedUsage, StreamUsageAccumulator } from './types.ts'

type Obj = Record<string, unknown>

/** Cache-write TTL attributed to OpenAI-shape writes when the response carries no TTL breakdown. */
export const OPENAI_DEFAULT_WRITE_TTL: CacheTtl = '30m'

/**
 * Normalizes the usage of a non-streaming response body (or any object carrying `usage`,
 * `response.usage` or `message.usage`). Throws UsageNotFoundError when no usage object exists.
 */
export function normalizeUsage(dialect: Dialect, responseBody: unknown): NormalizedUsage {
  const usage = findUsage(responseBody)
  if (!usage) throw new UsageNotFoundError(`${dialect}: response body has no usage object`)
  return dialect === 'anthropic-messages' ? fromAnthropic(usage) : fromOpenAi(dialect, usage)
}

/**
 * Accumulates usage from SSE events of a streaming response.
 * - anthropic-messages: `message_start.message.usage`, overlaid by every `message_delta.usage` (cumulative).
 * - openai-chat: the last chunk with a non-null `usage` (only sent with `stream_options.include_usage`).
 * - openai-responses: `response.completed` / `response.incomplete` / `response.failed` → `response.usage`.
 * `push` never throws; non-JSON data (e.g. `[DONE]`) is skipped.
 */
export function createStreamUsageAccumulator(dialect: Dialect): StreamUsageAccumulator {
  let merged: Obj | undefined
  return {
    push(event) {
      const parsed = parseJson(event.data)
      if (!parsed) return
      const type = typeof parsed.type === 'string' ? parsed.type : event.event
      if (dialect === 'anthropic-messages') {
        if (type === 'message_start') {
          const u = asObj(asObj(parsed.message)?.usage)
          if (u) merged = { ...u }
        } else if (type === 'message_delta') {
          // Counts are cumulative, but a delta may carry null for fields it does not report
          // (the Anthropic schema allows null input/cache counters); never let null erase the base.
          const u = asObj(parsed.usage)
          if (u) merged = { ...merged, ...withoutNulls(u) }
        }
      } else if (dialect === 'openai-chat') {
        const u = asObj(parsed.usage)
        if (u) merged = u
      } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        const u = asObj(asObj(parsed.response)?.usage)
        if (u) merged = u
      }
    },
    result() {
      if (!merged) return undefined
      return dialect === 'anthropic-messages' ? fromAnthropic(merged) : fromOpenAi(dialect, merged)
    },
  }
}

function fromAnthropic(u: Obj): NormalizedUsage {
  const uncached = num(u.input_tokens)
  const read = num(u.cache_read_input_tokens)
  const writeTotal = num(u.cache_creation_input_tokens)
  const split = asObj(u.cache_creation)
  const writes: Partial<Record<CacheTtl, number>> = {}
  if (split) {
    const w5 = num(split.ephemeral_5m_input_tokens)
    const w1 = num(split.ephemeral_1h_input_tokens)
    const rest = writeTotal - w5 - w1
    addWrite(writes, '5m', w5 + Math.max(0, rest))
    addWrite(writes, '1h', w1)
  } else {
    addWrite(writes, '5m', writeTotal)
  }
  const written = sumWrites(writes)
  const reasoning = asObj(u.output_tokens_details)?.thinking_tokens
  return withReasoning(
    {
      uncachedInputTokens: uncached,
      cacheReadTokens: read,
      cacheWriteTokens: writes,
      outputTokens: num(u.output_tokens),
      promptTokens: uncached + read + written,
    },
    reasoning,
  )
}

function fromOpenAi(dialect: Dialect, u: Obj): NormalizedUsage {
  const chat = dialect === 'openai-chat'
  const prompt = num(chat ? u.prompt_tokens : u.input_tokens)
  const inDetails = asObj(chat ? u.prompt_tokens_details : u.input_tokens_details)
  const outDetails = asObj(chat ? u.completion_tokens_details : u.output_tokens_details)
  const read = num(inDetails?.cached_tokens)
  const writeTotal = num(inDetails?.cache_write_tokens)
  const ttlSplit = asObj(u.cache_write_tokens_details) ?? asObj(inDetails?.cache_write_tokens_details)
  const writes: Partial<Record<CacheTtl, number>> = {}
  if (ttlSplit && (ttlSplit.ttl_30m_tokens !== undefined || ttlSplit.ttl_12h_tokens !== undefined)) {
    const w30 = num(ttlSplit.ttl_30m_tokens)
    const w12 = num(ttlSplit.ttl_12h_tokens)
    addWrite(writes, '30m', w30 + Math.max(0, writeTotal - w30 - w12))
    addWrite(writes, '12h', w12)
  } else {
    addWrite(writes, OPENAI_DEFAULT_WRITE_TTL, writeTotal)
  }
  const written = sumWrites(writes)
  const uncached = Math.max(0, prompt - read - written)
  return withReasoning(
    {
      uncachedInputTokens: uncached,
      cacheReadTokens: read,
      cacheWriteTokens: writes,
      outputTokens: num(chat ? u.completion_tokens : u.output_tokens),
      promptTokens: uncached + read + written,
    },
    outDetails?.reasoning_tokens,
  )
}

function findUsage(body: unknown): Obj | undefined {
  const b = asObj(body)
  if (!b) return undefined
  return asObj(b.usage) ?? asObj(asObj(b.response)?.usage) ?? asObj(asObj(b.message)?.usage)
}

function withReasoning(u: NormalizedUsage, reasoning: unknown): NormalizedUsage {
  if (typeof reasoning === 'number' && Number.isFinite(reasoning)) u.reasoningTokens = Math.max(0, reasoning)
  return u
}

function addWrite(w: Partial<Record<CacheTtl, number>>, ttl: CacheTtl, tokens: number): void {
  if (tokens > 0) w[ttl] = (w[ttl] ?? 0) + tokens
}

function sumWrites(w: Partial<Record<CacheTtl, number>>): number {
  let s = 0
  for (const v of Object.values(w)) s += v ?? 0
  return s
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function withoutNulls(o: Obj): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v
  return out
}

function asObj(v: unknown): Obj | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined
}

function parseJson(data: string): Obj | undefined {
  const t = data.trim()
  if (t === '' || t[0] !== '{') return undefined
  try {
    return asObj(JSON.parse(t))
  } catch {
    return undefined
  }
}
