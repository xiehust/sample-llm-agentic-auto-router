import type { Dialect, LastTurn } from './deps.ts'

/** replay-trace/v1: one LLM call per JSONL line. See task design.md §2. */
export const MARKERS = ['compaction', 'rewrite', 'subagent-start', 'fork', 'model-change', 'session-start'] as const
export type Marker = (typeof MARKERS)[number]

export interface Segment {
  id: string
  tokens: number
}

export interface TraceCall {
  v: 1
  session: string
  lineage: string
  parentLineage?: string
  seq: number
  ts: number
  dialect: Dialect
  model: string
  promptTokens: number
  newTokens: number
  outputTokens: number
  reasoningTokens?: number
  lastTurn: LastTurn
  prefix: { segments: Segment[]; templateTokens: number }
  appendedBlocks?: number
  markers?: Marker[]
  recorded?: { cacheReadTokens: number; cacheWriteTokens: number; uncachedInputTokens: number }
  /** cooperative-harness intent for this call (additive, optional): desired tier of the current user turn */
  hints?: { tier?: 'frontier' | 'standard' | 'fast' }
}

export class TraceError extends Error {
  override name = 'TraceError'
}

const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const LAST_TURNS: readonly LastTurn[] = ['user-text', 'tool-result', 'assistant', 'other']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Validates one parsed line; throws TraceError naming every problem. Never evaluates anything. */
export function validateCall(v: unknown, where = 'call'): TraceCall {
  if (!isObj(v)) throw new TraceError(`${where}: not an object`)
  const e: string[] = []
  if (v.v !== 1) e.push('v: must be 1')
  for (const k of ['session', 'lineage', 'model'] as const) if (!isStr(v[k])) e.push(`${k}: non-empty string required`)
  if (v.parentLineage !== undefined && !isStr(v.parentLineage)) e.push('parentLineage: string')
  for (const k of ['seq', 'promptTokens', 'newTokens', 'outputTokens'] as const) if (!isCount(v[k])) e.push(`${k}: non-negative integer required`)
  if (v.reasoningTokens !== undefined && !isCount(v.reasoningTokens)) e.push('reasoningTokens: non-negative integer')
  if (v.appendedBlocks !== undefined && !isCount(v.appendedBlocks)) e.push('appendedBlocks: non-negative integer')
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) e.push('ts: finite epoch ms required')
  if (!DIALECTS.includes(v.dialect as Dialect)) e.push(`dialect: one of ${DIALECTS.join('|')}`)
  if (!LAST_TURNS.includes(v.lastTurn as LastTurn)) e.push(`lastTurn: one of ${LAST_TURNS.join('|')}`)
  const p = v.prefix
  if (!isObj(p) || !Array.isArray(p.segments) || !isCount(p.templateTokens)) {
    e.push('prefix: { segments[], templateTokens } required')
  } else {
    let sum = 0
    for (const [i, s] of p.segments.entries()) {
      if (!isObj(s) || !isStr(s.id) || !isCount(s.tokens) || s.tokens === 0) e.push(`prefix.segments[${i}]: { id, tokens>0 } required`)
      else sum += s.tokens
    }
    if (isCount(v.promptTokens) && sum !== v.promptTokens) e.push(`prefix.segments: sum ${sum} != promptTokens ${String(v.promptTokens)}`)
    if (isCount(v.newTokens) && isCount(v.promptTokens) && v.newTokens > v.promptTokens) e.push('newTokens: exceeds promptTokens')
  }
  if (v.markers !== undefined && (!Array.isArray(v.markers) || !v.markers.every((m) => MARKERS.includes(m as Marker)))) e.push('markers: unknown marker')
  if (v.recorded !== undefined) {
    const r = v.recorded
    if (!isObj(r) || !isCount(r.cacheReadTokens) || !isCount(r.cacheWriteTokens) || !isCount(r.uncachedInputTokens)) e.push('recorded: three non-negative integers required')
  }
  if (v.hints !== undefined) {
    const h = v.hints
    if (!isObj(h) || (h.tier !== undefined && !['frontier', 'standard', 'fast'].includes(h.tier as string))) e.push('hints: { tier?: frontier|standard|fast }')
  }
  if (e.length > 0) throw new TraceError(`${where}: ${e.join('; ')}`)
  return v as unknown as TraceCall
}
