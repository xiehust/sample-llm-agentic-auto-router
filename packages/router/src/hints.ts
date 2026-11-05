// Cooperative header hints and opt-in body hints (design §2.1 hints.ts, §2.5).
import type { IncomingHttpHeaders } from 'node:http'
import type { Dialect } from '@auto-router/pricing'
import { spliceTopLevel } from './body.ts'
import type { Hints } from './config.ts'

/** Request headers core may read. Everything else (credentials included) never reaches core. */
const CORE_HEADERS = [
  'x-router-session', 'x-router-parent-session', 'x-router-agent-id',
  'x-claude-code-session-id', 'x-session-id', 'x-claude-code-parent-agent-id',
  'anthropic-beta', 'anthropic-version', 'openai-beta',
] as const

const HINT_KEYS: Record<string, string> = { pin: 'x-router-pin', tier: 'x-router-tier', boundary: 'x-router-boundary' }
const MAX_HINT = 512

/**
 * Builds the header map core summarizes: the allowlisted names above plus `x-router-hint` unpacked into
 * x-router-pin / -tier / -boundary. Directly sent x-router-pin/-tier/-boundary and x-router-tenant are dropped:
 * on the gateway path the router cannot attribute them to a tenant (design §5.4).
 */
export function coreHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const name of CORE_HEADERS) {
    const v = headers[name]
    if (typeof v === 'string') out[name] = v
  }
  const hint = headers['x-router-hint']
  if (typeof hint === 'string' && hint.length <= MAX_HINT) {
    for (const part of hint.split(';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const target = HINT_KEYS[part.slice(0, eq).trim().toLowerCase()]
      const value = part.slice(eq + 1).trim()
      if (target && value && out[target] === undefined) out[target] = value
    }
  }
  return out
}

export interface BodyHintResult {
  body: Buffer
  applied: string[]
  /** Chat stream: the router asked for usage the client did not, so strip it from the client stream. */
  stripUsage: boolean
}

/** Opt-in top-level body edits. Never edits nested values in place (a top-level member may be replaced whole). */
export function applyBodyHints(dialect: Dialect, body: Buffer, json: Record<string, unknown>, hints: Hints): BodyHintResult {
  const applied: string[] = []
  let out = body
  let stripUsage = false
  if (dialect === 'openai-chat' && hints.chatIncludeUsage !== 'off' && json.stream === true) {
    const so = json.stream_options
    const asked = typeof so === 'object' && so !== null && (so as Record<string, unknown>).include_usage === true
    if (!asked) {
      const base = typeof so === 'object' && so !== null && !Array.isArray(so) ? so : {}
      out = spliceTopLevel(out, 'stream_options', JSON.stringify({ ...base, include_usage: true }))
      applied.push(`chatIncludeUsage:${hints.chatIncludeUsage}`)
      stripUsage = hints.chatIncludeUsage === 'inject-strip'
    }
  }
  if (dialect === 'anthropic-messages' && hints.claudeAutoCache && !body.includes('"cache_control"')) {
    out = spliceTopLevel(out, 'cache_control', '{"type":"ephemeral"}')
    applied.push('claudeAutoCache')
  }
  return { body: out, applied, stripUsage }
}
