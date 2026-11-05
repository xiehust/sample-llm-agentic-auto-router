// summarize(): request → RequestSummary (core design.md §3). Never throws on odd bodies.
import { chain, h, templateFamily } from '../hash.ts'
import type { Dialect } from '../pricing-types.ts'
import type { RequestSummary, SessionKey } from '../types.ts'
import { extractAnthropic } from './anthropic.ts'
import { isObj, type Extracted } from './extract.ts'
import { extractOpenAiChat } from './openai-chat.ts'
import { extractOpenAiResponses } from './openai-responses.ts'
import { blockTokens, defaultEstimateTokens } from './tokens.ts'

const TIER_HINTS = new Set(['fast', 'standard', 'frontier'])
const BOUNDARIES = new Set(['compaction', 'subagent-start', 'task-start'])

/**
 * Cache-breakpoint markers are request metadata, not prompt content: Anthropic `cache_control` and the
 * Bedrock GPT/Kimi `prompt_cache_breakpoint` content-part field. Clients move them forward every turn
 * (Claude Code marks only the newest message), so hashing them would break the chain on every request.
 */
const MARKER_KEYS = new Set(['cache_control', 'prompt_cache_breakpoint'])
const dropMarkers = (k: string, v: unknown): unknown => (MARKER_KEYS.has(k) ? undefined : v)

/** Canonical JSON of one chain block: insertion order, breakpoint markers removed. */
const json = (v: unknown): string => {
  const s = JSON.stringify(v) ?? 'null'
  // Only the few blocks that carry a marker pay for the second, replacer-based stringify.
  if (!s.includes('"cache_control"') && !s.includes('"prompt_cache_breakpoint"')) return s
  return JSON.stringify(v, dropMarkers) ?? 'null'
}

export interface SummarizeOptions { estimateTokens?: (text: string) => number }

export function summarize(
  dialect: Dialect,
  body: unknown,
  headers: Record<string, string | undefined>,
  nowMs: number,
  opts: SummarizeOptions = {},
): RequestSummary {
  const estimate = opts.estimateTokens ?? defaultEstimateTokens
  const b = isObj(body) ? body : {}
  const ex: Extracted =
    dialect === 'anthropic-messages' ? extractAnthropic(b) : dialect === 'openai-chat' ? extractOpenAiChat(b) : extractOpenAiResponses(b)

  // Prefix chain (M1): tools → system → [cache params] → one block per message. The cache-relevant params
  // (thinking, tool_choice, ...) invalidate the messages layer (research A §1.2), so they are hashed
  // between system and the first message: a change resets the message chain but keeps the template family.
  const toolsJson = json(ex.tools ?? null)
  const systemJson = json(ex.system ?? null)
  const toolsHash = chain(dialect, toolsJson)
  const systemHash = chain(toolsHash, systemJson)
  const blockHashes = new Array<string>(ex.messages.length + 2)
  blockHashes[0] = toolsHash
  blockHashes[1] = systemHash
  let tokens = (ex.tools == null ? 0 : estimate(toolsJson)) + (ex.system == null ? 0 : estimate(systemJson))
  let prev = chain(systemHash, json(ex.params))
  let firstUserJson = ''
  for (let i = 0; i < ex.messages.length; i++) {
    const m = ex.messages[i]
    const mj = json(m)
    if (i === ex.firstUserIndex) firstUserJson = mj
    prev = chain(prev, mj)
    blockHashes[i + 2] = prev
    tokens += blockTokens(m, mj, estimate)
  }

  const hd = lowerCase(headers)
  const hints: RequestSummary['hints'] = {}
  if (hd['x-router-pin']) hints.pin = hd['x-router-pin']
  const tier = hd['x-router-tier']?.toLowerCase()
  if (tier && TIER_HINTS.has(tier)) hints.tier = tier
  const boundary = hd['x-router-boundary']?.toLowerCase()
  if (boundary && BOUNDARIES.has(boundary)) hints.boundary = boundary as NonNullable<RequestSummary['hints']['boundary']>
  if (hd['x-router-parent-session']) hints.parentSession = hd['x-router-parent-session']
  // Claude Code names the parent agent of a sub-agent; it is a parent hint only (root/lineage unchanged).
  else if (hd['x-claude-code-parent-agent-id']) hints.parentSession = hd['x-claude-code-parent-agent-id']
  if (hd['x-router-agent-id']) hints.agentId = hd['x-router-agent-id']

  // Session key priority (R7, M4): cooperative > Claude Code > generic header > prompt_cache_key > fingerprint.
  let sessionId: string
  let source: SessionKey['source']
  if (hd['x-router-session']) {
    sessionId = hd['x-router-session']
    source = 'cooperative'
  } else if (hd['x-claude-code-session-id'] || hd['x-session-id']) {
    sessionId = (hd['x-claude-code-session-id'] || hd['x-session-id']) as string
    source = 'header'
  } else if (ex.promptCacheKey) {
    sessionId = ex.promptCacheKey
    source = 'header'
  } else {
    sessionId = `fp:${h([hd['x-router-tenant'] ?? '', toolsHash, systemHash, firstUserJson])}`
    source = 'fingerprint'
  }
  const family = templateFamily(toolsHash, systemHash)
  let lineage = hints.agentId ? `${sessionId}/a:${hints.agentId}` : `${sessionId}/t:${family}`
  // Headerless Responses chains: follow the response id (record() writes the alias).
  if (source === 'fingerprint' && ex.previousResponseId) lineage = `resp:${ex.previousResponseId}`

  const summary: RequestSummary = {
    dialect,
    requestedModel: typeof b.model === 'string' ? b.model : '',
    session: { root: hd['x-router-parent-session'] ?? sessionId, lineage, source },
    lastTurn: ex.lastTurn,
    nonPortableState: ex.nonPortableState,
    prefix: { toolsHash, systemHash, blockHashes, estPromptTokens: tokens, messageCount: ex.messages.length },
    hints,
    receivedAt: nowMs,
  }
  if (ex.previousResponseId) summary.previousResponseId = ex.previousResponseId
  if (ex.maxOutputTokens !== undefined) summary.maxOutputTokens = ex.maxOutputTokens
  return summary
}

/** Template family of a summary (12 hex), the key used by policy rules and logged on every decision. */
export function templateFamilyOf(summary: RequestSummary): string {
  return templateFamily(summary.prefix.toolsHash, summary.prefix.systemHash)
}

/**
 * Lower-cases names and trims values. Tolerates raw Node headers (`string[]` values, e.g. `set-cookie`,
 * are joined per RFC 9110) and drops anything else that is not a string, so summarize() never throws.
 */
function lowerCase(headers: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if (typeof headers !== 'object' || headers === null) return out
  for (const [k, raw] of Object.entries(headers) as Array<[string, unknown]>) {
    const v = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? raw.join(', ') : undefined
    if (v === undefined) continue
    const t = v.trim()
    if (t !== '') out[k.toLowerCase()] = t
  }
  return out
}
