// TraceLab (uw-syfi/TraceLab, CC BY 4.0) → replay-trace/v1. Rows are untrusted: only JSON.parse'd and
// type-checked here; no field is ever executed, evaluated, or used as a path. Rules: task design §3.1.
import type { Dialect, LastTurn } from '../deps.ts'
import { totalTokens, truncateSegments } from '../prefix.ts'
import type { Marker, Segment, TraceCall } from '../schema.ts'
import { readJsonLines } from '../trace-io.ts'

export const TRACELAB_ATTRIBUTION =
  'Trace data: TraceLab (SyFI Lab, University of Washington), https://tracelab.cs.washington.edu, licensed CC BY 4.0 ' +
  '(https://creativecommons.org/licenses/by/4.0/). Changes: converted to replay-trace/v1 with reconstructed prefix identity.'

/**
 * True for sessions produced by this adapter (TraceLab ids are `claude:<uuid>` / `codex:<uuid>`). Lets the CLI
 * attach the CC BY attribution based on trace content, not only on the file name.
 */
export const isTraceLabSession = (session: string): boolean => /^(claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session)

/** Fields we read from a TraceLab round, after validation. */
export interface TlRound {
  order: number
  provider: 'claude' | 'codex'
  session: string
  roundIndex: number
  user: string
  model: string
  input: number
  prefix: number
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  uncached?: number
  firstInput: string | null
  inputEvents: number
  tools: number
  ts: number
}

export interface TlOptions {
  /** gap under which a Claude same-model miss is read as a prompt change (rule b) */
  rewriteGapMs?: number
  /** input drop ratio below which a drop is a compaction (else a rewrite) */
  compactionRatio?: number
  slackTokens?: number
}

const OUTPUT_EVENTS = new Set(['reasoning', 'text', 'tool_call'])
const INPUT_EVENTS = new Set(['user_message', 'tool_result'])
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length < 512 ? v : undefined)

/** Extracts one round; returns undefined (and a reason) for rows that lack required fields. */
export function parseRound(v: unknown, order: number): { round?: TlRound; skip?: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { skip: 'not-object' }
  const r = v as Record<string, unknown>
  const provider = r.provider === 'claude' || r.provider === 'codex' ? r.provider : undefined
  const session = str(r.session_id)
  const model = str(r.model)
  const input = num(r.input_tokens_total)
  const roundIndex = num(r.round_index)
  if (!provider || !session || !model || input === undefined || roundIndex === undefined) return { skip: 'missing-fields' }
  let ts: number | undefined
  let firstTs: number | undefined
  if (Array.isArray(r.timing_events)) {
    for (const e of r.timing_events) {
      if (typeof e !== 'object' || e === null) continue
      const ev = e as Record<string, unknown>
      const t = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN
      if (!Number.isFinite(t)) continue
      firstTs ??= t
      if (typeof ev.event_type === 'string' && OUTPUT_EVENTS.has(ev.event_type)) break
      if (typeof ev.event_type === 'string' && INPUT_EVENTS.has(ev.event_type)) ts = Math.max(ts ?? t, t)
    }
  }
  ts ??= firstTs
  if (ts === undefined) return { skip: 'no-timestamp' }
  const round: TlRound = {
    order, provider, session, roundIndex, user: str(r.user) ?? 'unknown', model, input,
    prefix: num(r.prefix_tokens) ?? 0, output: num(r.output_tokens) ?? 0,
    firstInput: typeof r.first_input_event_type === 'string' ? r.first_input_event_type : null,
    inputEvents: num(r.current_input_event_count) ?? 0,
    tools: Array.isArray(r.tools) ? r.tools.length : 0,
    ts,
  }
  const reasoning = num(r.reasoning_output_tokens)
  if (reasoning !== undefined) round.reasoning = reasoning
  if (provider === 'claude') {
    const cr = num(r.claude_cache_read_input_tokens)
    const cw = num(r.claude_cache_creation_input_tokens)
    const un = num(r.claude_uncached_input_tokens)
    if (cr !== undefined) round.cacheRead = cr
    if (cw !== undefined) round.cacheWrite = cw
    if (un !== undefined) round.uncached = un
  }
  return { round }
}

const family = (provider: string, model: string): string => {
  const m = /opus|sonnet|haiku|fable|mythos/.exec(model)
  return `${provider}:${m ? m[0] : 'other'}`
}
const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

export interface TlStats {
  rows: number
  skipped: Record<string, number>
  sessions: number
  markers: Record<string, number>
  templateMedians: Record<string, number>
}

/** Converts grouped rounds into calls (one lineage per session; TraceLab has no sub-agent lineages). */
export function convertRounds(rounds: TlRound[], o: TlOptions = {}): { calls: TraceCall[]; markers: Record<string, number>; templateMedians: Record<string, number> } {
  const rewriteGap = o.rewriteGapMs ?? 240_000
  const ratio = o.compactionRatio ?? 0.7
  const slack = o.slackTokens ?? 1024
  const bySession = new Map<string, TlRound[]>()
  for (const r of rounds) {
    let a = bySession.get(r.session)
    if (!a) bySession.set(r.session, (a = []))
    a.push(r)
  }
  const tplSamples = new Map<string, number[]>()
  for (const rs of bySession.values()) {
    rs.sort((a, b) => a.roundIndex - b.roundIndex || a.order - b.order)
    const r0 = rs[0]!
    if (r0.prefix > 0) {
      const k = family(r0.provider, r0.model)
      let a = tplSamples.get(k)
      if (!a) tplSamples.set(k, (a = []))
      a.push(r0.prefix)
    }
  }
  const templateMedians: Record<string, number> = {}
  for (const [k, xs] of tplSamples) templateMedians[k] = median(xs)!
  const markers: Record<string, number> = {}
  const calls: TraceCall[] = []
  for (const [session, rs] of bySession) {
    const r0 = rs[0]!
    const dialect: Dialect = r0.provider === 'claude' ? 'anthropic-messages' : 'openai-responses'
    const tplId = `tpl:${r0.provider}:${r0.user}`
    const tplTokens = r0.prefix > 0 ? r0.prefix : (templateMedians[family(r0.provider, r0.model)] ?? 0)
    let segs: Segment[] = []
    let k = 0
    let prev: TlRound | undefined
    let lastTs = -Infinity
    for (const [seq, r] of rs.entries()) {
      const mk: Marker[] = []
      const tpl = Math.min(tplTokens, r.input)
      const R = r.provider === 'claude' ? (r.cacheRead ?? r.prefix) : r.prefix
      let d: number
      if (!prev) {
        d = 0
        mk.push('session-start')
        segs = tpl > 0 ? [{ id: tplId, tokens: tpl }] : []
      } else {
        if (r.model !== prev.model) mk.push('model-change')
        if (r.input < prev.input) {
          d = Math.max(Math.min(R, r.input), tpl)
          mk.push(r.input < ratio * prev.input ? 'compaction' : 'rewrite')
        } else if (r.provider === 'claude' && r.model === prev.model && r.ts - prev.ts < rewriteGap && R < prev.input - slack) {
          d = Math.max(R, tpl)
          mk.push('rewrite')
        } else {
          d = prev.input
        }
        d = Math.min(d, prev.input, r.input)
        segs = truncateSegments(segs, d)
      }
      const have = totalTokens(segs)
      const add = r.input - have
      if (add > 0) {
        const last = segs[segs.length - 1]
        if (last && last.id.startsWith(`${session}:`) && have === d && prev && !mk.some((m) => m === 'compaction' || m === 'rewrite')) last.tokens += add
        else segs.push({ id: `${session}:s${k++}`, tokens: add })
      }
      for (const m of mk) markers[m] = (markers[m] ?? 0) + 1
      const ts = Math.max(r.ts, lastTs)
      lastTs = ts
      const lastTurn: LastTurn = r.firstInput === 'tool_result' ? 'tool-result' : r.firstInput === 'user_message' ? 'user-text' : 'other'
      const call: TraceCall = {
        v: 1, session, lineage: session, seq, ts, dialect, model: r.model,
        promptTokens: r.input, newTokens: prev ? r.input - Math.min(d, have) : r.input,
        outputTokens: r.output, lastTurn,
        prefix: { segments: segs.map((s) => ({ ...s })), templateTokens: tpl },
        appendedBlocks: r.inputEvents + (prev ? prev.tools + 1 : 0),
        recorded: r.provider === 'claude'
          ? { cacheReadTokens: r.cacheRead ?? 0, cacheWriteTokens: r.cacheWrite ?? 0, uncachedInputTokens: r.uncached ?? 0 }
          : { cacheReadTokens: Math.min(r.prefix, r.input), cacheWriteTokens: 0, uncachedInputTokens: Math.max(0, r.input - r.prefix) },
      }
      if (r.reasoning !== undefined) call.reasoningTokens = r.reasoning
      if (mk.length) call.markers = mk
      calls.push(call)
      prev = r
    }
  }
  calls.sort((a, b) => a.ts - b.ts || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0) || a.seq - b.seq)
  return { calls, markers, templateMedians }
}

/** Reads the raw TraceLab JSONL(.gz) and converts it. */
export async function convertTraceLab(path: string, o: TlOptions = {}): Promise<{ calls: TraceCall[]; stats: TlStats }> {
  const rounds: TlRound[] = []
  const skipped: Record<string, number> = {}
  let rows = 0
  for await (const { value } of readJsonLines(path)) {
    const { round, skip } = parseRound(value, rows++)
    if (round) rounds.push(round)
    else skipped[skip!] = (skipped[skip!] ?? 0) + 1
  }
  const { calls, markers, templateMedians } = convertRounds(rounds, o)
  return { calls, stats: { rows, skipped, sessions: new Set(rounds.map((r) => r.session)).size, markers, templateMedians } }
}
