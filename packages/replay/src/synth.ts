import type { Dialect } from './deps.ts'
import type { Marker, Segment, TraceCall } from './schema.ts'
import { mulberry32 } from './sim.ts'

/** Break-even scenario (design §7): warm-up at `contextTokens`, then `steps` calls of +newTokens. */
export function breakEvenCalls(o: { contextTokens: number; steps: number; newTokens?: number; outputTokens?: number; gapMs?: number; dialect?: Dialect; model?: string; t0?: number; lineage?: string }): TraceCall[] {
  const newTokens = o.newTokens ?? 1000
  const out = o.outputTokens ?? 250
  const gap = o.gapMs ?? 1000
  const lineage = o.lineage ?? 'be'
  const tpl = 'tpl:be'
  const tplTokens = Math.min(20_000, o.contextTokens)
  const calls: TraceCall[] = []
  for (let i = 0; i <= o.steps; i++) {
    const prompt = o.contextTokens + i * newTokens
    const segs: Segment[] = [{ id: tpl, tokens: tplTokens }]
    if (prompt > tplTokens) segs.push({ id: `${lineage}:s0`, tokens: prompt - tplTokens })
    calls.push({
      v: 1, session: lineage, lineage, seq: i, ts: (o.t0 ?? 1_700_000_000_000) + i * gap,
      dialect: o.dialect ?? 'anthropic-messages', model: o.model ?? 'synthetic',
      promptTokens: prompt, newTokens: i === 0 ? prompt : newTokens, outputTokens: out,
      lastTurn: i === 0 ? 'user-text' : 'tool-result',
      prefix: { segments: segs, templateTokens: tplTokens },
      ...(i === 0 ? { markers: ['session-start'] as Marker[] } : {}),
    })
  }
  return calls
}

/**
 * Generator parameters, each taken from research C §3 (task 11-04-llm-auto-router/research/C-inference-cache-routing.md)
 * and the TraceLab conversion. See SYNTH_SOURCES for citations; realized statistics are checked by synthStats().
 */
export interface AgentSynthOpts {
  sessions?: number
  seed?: number
  dialect?: Dialect
  model?: string
  /** P(a main-lineage tool step spawns a sub-agent). Sweep: 0.04 / 0.08 / 0.16. */
  subagentProb?: number
  /** Cross-turn human idle: 'default' (median 172 s, p90 20.6 min) or 'heavy' (median 10 min, p90 60 min). */
  idle?: 'default' | 'heavy'
  templateTokens?: number
  subTemplateTokens?: number
  /** Main-lineage context above which the harness compacts. Tuned so ~8–10% of sessions compact. */
  compactAboveTokens?: number
  /** Share of user turns whose cooperative intent is `turnTiers.alt` (others `turnTiers.main`); 0 = no hints. Separate PRNG, so trace shape is unchanged. */
  altTurnShare?: number
  /** Tier pair for per-turn hints; default main 'standard', alt 'fast'. */
  turnTiers?: { main: 'frontier' | 'standard' | 'fast'; alt: 'frontier' | 'standard' | 'fast' }
}

export const SYNTH_SOURCES: Record<string, string> = {
  intraTurnGap: 'lognormal, median 1.2 s, p95 37 s — Copilot traces (arXiv 2608.00101): KV idle between LLM calls within a turn',
  crossTurnGap: 'lognormal, median 172 s (Copilot cross-turn KV idle), p90 20.6 min (TraceLab human pause p90, arXiv 2606.30560)',
  heavyIdle: 'sweep variant: median 10 min, p90 60 min (heavy human-in-the-loop; assumption, beyond both cited p90s)',
  callsPerTurn: 'geometric, mean 6.6 calls per user turn — Copilot',
  turnsPerSession: 'lognormal calls/session median 15, mean 40.6 — Copilot; realized via turns ≈ calls/6.6',
  appendPerStep: 'median ~860 tokens/step incl. previous output (TraceLab); 96% lognormal(median 560, σ 0.7) + 4% large reads lognormal(median 12K, σ 1.0) for the p99 tail',
  outputPerStep: 'lognormal median 220 tokens (TraceLab 184–252)',
  initialContext: 'first user turn attaches lognormal(median 25K, σ 0.8) so median context lands in 68–126K (Copilot 68K, TraceLab 116–126K)',
  template: 'main system+tools 13K (TraceLab claude:opus template median 12,978); sub-agent template 9K (assumption)',
  compaction: 'at >compactAboveTokens the harness runs a cache-safe fork (summary ≤20K output) and restarts from template + 27% of the context — Copilot: median compaction removes 72.8%; 7.8% (Copilot) / 9.7% (TraceLab) of sessions compact',
  subagent: 'sub-agent = new lineage with its own template, task prompt 1–4K, its own tool loop (mean 6.6 calls), returns a 1–2K summary to the parent (Anthropic context-engineering post)',
}

const lognormal = (rnd: () => number, median: number, sigma: number): number => {
  const u1 = Math.max(rnd(), 1e-12)
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd())
  return median * Math.exp(sigma * z)
}
const geometric = (rnd: () => number, mean: number): number => Math.max(1, Math.ceil(Math.log(Math.max(rnd(), 1e-12)) / Math.log(1 - 1 / mean)))

/**
 * Agent-like sessions on research-derived distributions (SYNTH_SOURCES): user turns, tool loops,
 * cross-turn idle, compaction via a cache-safe fork, and sub-agents with their own template and
 * parentLineage. Deterministic per seed; output is globally time-sorted.
 */
export function agentSessions(o: AgentSynthOpts = {}): TraceCall[] {
  const rnd = mulberry32(o.seed ?? 7)
  const intentRnd = mulberry32((o.seed ?? 7) ^ 0x5eed)
  const altShare = o.altTurnShare ?? 0
  const pair = o.turnTiers ?? { main: 'standard', alt: 'fast' }
  const dialect = o.dialect ?? 'anthropic-messages'
  const model = o.model ?? 'claude-opus-4-8'
  const tplTokens = o.templateTokens ?? 13_000
  const subTpl = o.subTemplateTokens ?? 9_000
  const compactAt = o.compactAboveTokens ?? 260_000
  const subP = o.subagentProb ?? 0.08
  const idleMedian = o.idle === 'heavy' ? 600_000 : 172_000
  const idleSigma = o.idle === 'heavy' ? Math.log(6) / 1.2816 : Math.log(1236 / 172) / 1.2816
  const intraSigma = Math.log(30 / 1.2) / 1.645 // p95 37 s realized once sub-agent runs are included
  const ms = (x: number) => Math.round(x)
  const tok = (x: number) => Math.max(1, Math.round(x))
  const append = () => (rnd() < 0.04 ? lognormal(rnd, 12_000, 1.0) : lognormal(rnd, 560, 0.7)) // + previous output ≈ 860 appended
  const out = () => Math.min(8_000, lognormal(rnd, 220, 0.8))
  const intra = () => Math.min(600_000, lognormal(rnd, 1_200, intraSigma))
  const all: TraceCall[] = []
  for (let s = 0; s < (o.sessions ?? 20); s++) {
    const session = `syn${s}`
    let t = 1_700_000_000_000 + s * 7_919_000
    const main = new LineageBuilder(session, session, dialect, model, { id: 'tpl:main', tokens: tplTokens })
    const calls = Math.max(2, Math.round(lognormal(rnd, 15, 1.41)))
    const turns = Math.max(1, Math.round(calls / 6.6))
    for (let turn = 0; turn < turns; turn++) {
      main.tier = altShare > 0 ? (intentRnd() < altShare ? pair.alt : pair.main) : undefined
      all.push(main.call(t, tok(turn === 0 ? lognormal(rnd, 25_000, 0.8) : lognormal(rnd, 600, 1.0)), 'user-text', tok(out())))
      const loop = geometric(rnd, 6.6) - 1
      for (let k = 0; k < loop; k++) {
        t += ms(intra())
        if (main.prompt > compactAt) {
          all.push(main.call(t, 500, 'other', tok(Math.min(20_000, 0.1 * main.prompt)))) // cache-safe fork (harness side call)
          t += ms(intra())
          main.compact(Math.round(0.272 * (main.prompt - tplTokens)))
          all.push(main.call(t, 0, 'other', tok(out()), ['compaction']))
          continue
        }
        all.push(main.call(t, tok(append()), 'tool-result', tok(out())))
        if (rnd() < subP) {
          const sub = new LineageBuilder(session, `${session}/sub${turn}.${k}`, dialect, model, { id: 'tpl:sub', tokens: subTpl }, session)
          let ts = t + ms(intra())
          all.push(sub.call(ts, tok(1000 + rnd() * 3000), 'user-text', tok(out()), ['subagent-start']))
          for (let j = geometric(rnd, 6.6) - 1; j > 0; j--) {
            ts += ms(intra())
            all.push(sub.call(ts, tok(append()), 'tool-result', tok(out())))
          }
          t = ts + ms(intra())
          all.push(main.call(t, tok(1000 + rnd() * 1000), 'tool-result', tok(out()))) // sub-agent summary returns
        }
      }
      t += ms(Math.min(86_400_000, lognormal(rnd, idleMedian, idleSigma)))
    }
  }
  return all.sort((a, b) => a.ts - b.ts || a.lineage.localeCompare(b.lineage) || a.seq - b.seq)
}

/** Realized statistics of a generated trace, reported next to the cited targets. */
export function synthStats(calls: readonly TraceCall[]): Record<string, number> {
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
  }
  const byLineage = new Map<string, TraceCall[]>()
  for (const c of calls) {
    let a = byLineage.get(c.lineage)
    if (!a) byLineage.set(c.lineage, (a = []))
    a.push(c)
  }
  const intra: number[] = []
  const cross: number[] = []
  for (const cs of byLineage.values()) {
    for (let i = 1; i < cs.length; i++) {
      const c = cs[i]!
      if (c.lastTurn === 'tool-result') intra.push(c.ts - cs[i - 1]!.ts)
      else if (c.lastTurn === 'user-text') cross.push(c.ts - cs[i - 1]!.ts)
    }
  }
  const sessions = new Set(calls.map((c) => c.session))
  const compacted = new Set(calls.filter((c) => c.markers?.includes('compaction')).map((c) => c.session))
  const mainTool = calls.filter((c) => c.lineage === c.session && c.lastTurn === 'tool-result').length
  const subStarts = calls.filter((c) => c.markers?.includes('subagent-start')).length
  const steps = calls.filter((c) => c.seq > 0 && !c.markers?.includes('compaction'))
  return {
    calls: calls.length,
    sessions: sessions.size,
    medianPromptTokens: q(calls.map((c) => c.promptTokens), 0.5),
    medianIntraTurnGapS: q(intra, 0.5) / 1000,
    p95IntraTurnGapS: q(intra, 0.95) / 1000,
    medianCrossTurnGapS: q(cross, 0.5) / 1000,
    p90CrossTurnGapMin: q(cross, 0.9) / 60_000,
    medianAppendTokens: q(steps.map((c) => c.newTokens), 0.5),
    medianOutputTokens: q(calls.map((c) => c.outputTokens), 0.5),
    compactedSessionShare: compacted.size / Math.max(1, sessions.size),
    subagentShareOfToolSteps: subStarts / Math.max(1, mainTool),
    subagentCallShare: calls.filter((c) => c.lineage !== c.session).length / Math.max(1, calls.length),
  }
}

class LineageBuilder {
  private segs: Segment[]
  private seq = 0
  private k = 0
  private lastOut = 0
  /** intent hint stamped on this lineage's calls (per user turn) */
  tier: 'frontier' | 'standard' | 'fast' | undefined
  readonly session: string
  readonly lineage: string
  readonly dialect: Dialect
  readonly model: string
  private readonly tpl: Segment
  readonly parent: string | undefined
  constructor(session: string, lineage: string, dialect: Dialect, model: string, tpl: Segment, parent?: string) {
    this.session = session
    this.lineage = lineage
    this.dialect = dialect
    this.model = model
    this.tpl = tpl
    this.parent = parent
    this.segs = [{ ...tpl }]
  }
  get prompt(): number {
    return this.segs.reduce((n, s) => n + s.tokens, 0)
  }
  compact(keep: number): void {
    this.segs = [{ ...this.tpl }, { id: `${this.lineage}:c${this.k++}`, tokens: keep }]
    this.lastOut = 0
  }
  call(ts: number, added: number, lastTurn: TraceCall['lastTurn'], out: number, markers: Marker[] = []): TraceCall {
    const grow = (this.seq === 0 ? 0 : this.lastOut) + added
    const last = this.segs[this.segs.length - 1]!
    if (grow > 0) {
      if (last.id.startsWith(this.lineage + ':')) last.tokens += grow
      else this.segs.push({ id: `${this.lineage}:s${this.k++}`, tokens: grow })
    }
    const promptTokens = this.prompt
    const isFirst = this.seq === 0
    const c: TraceCall = {
      v: 1, session: this.session, lineage: this.lineage, seq: this.seq++, ts, dialect: this.dialect, model: this.model,
      promptTokens, newTokens: isFirst || markers.includes('compaction') ? promptTokens - (markers.includes('compaction') ? this.tpl.tokens : 0) : grow,
      outputTokens: out, lastTurn,
      prefix: { segments: this.segs.map((s) => ({ ...s })), templateTokens: this.tpl.tokens },
      ...(isFirst && this.parent ? { parentLineage: this.parent } : {}),
      ...(this.tier ? { hints: { tier: this.tier } } : {}),
      ...(isFirst || markers.length ? { markers: isFirst ? (['session-start', ...markers] as Marker[]) : markers } : {}),
    }
    this.lastOut = out
    return c
  }
}
