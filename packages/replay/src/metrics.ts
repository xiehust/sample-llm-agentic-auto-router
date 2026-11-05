import { type CacheTtl, type CostBreakdown, costOf, type Dialect, type ModelPrice, type NormalizedUsage } from './deps.ts'
import type { TraceCall } from './schema.ts'
import type { SimResult } from './sim.ts'

export const COLD_WRITE_MIN_TOKENS = 1024

interface Mix { calls: number; costUsd: number }

export interface PolicyResult {
  policy: string
  meta?: Record<string, unknown>
  calls: number
  sessions: number
  lineages: number
  tokens: { prompt: number; cacheRead: number; cacheWrite: number; uncached: number; output: number }
  costUsd: { total: number; input: number; cacheRead: number; cacheWrite: number; output: number }
  deltaVsRecordedPct?: number
  sessionCostUsd: { p50: number; p90: number; max: number }
  hitRate: number
  warmCallShare: number
  switches: number
  switchesPer100Calls: number
  toolTurnSwitches: number
  coldWriteCalls: number
  coldWriteTokens: number
  coldWriteLostUsd: number
  tierMix: Record<string, Mix>
  modelMix: Record<string, Mix>
  decisionPoints?: Record<string, number>
  actions?: Record<string, number>
  /** share of hinted calls served at the hinted tier (cooperative intent), when the trace carries hints */
  intentAdherence?: number
  calibration?: Partial<Record<Dialect, { calls: number; simulatedHitRate: number; recordedHitRate: number; deltaPp: number }>>
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

const bump = (r: Record<string, Mix>, k: string, cost: number) => {
  const m = (r[k] ??= { calls: 0, costUsd: 0 })
  m.calls++
  m.costUsd += cost
}

export class PolicyMetrics {
  private calls = 0
  private readonly tok = { prompt: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, output: 0 }
  private readonly cost = { total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  private readonly perSession = new Map<string, number>()
  private readonly lastServed = new Map<string, string>()
  private warm = 0
  private hinted = 0
  private adhered = 0
  private switches = 0
  private toolTurnSwitches = 0
  private coldCalls = 0
  private coldTokens = 0
  private coldLost = 0
  private readonly tierMix: Record<string, Mix> = {}
  private readonly modelMix: Record<string, Mix> = {}
  private readonly points: Record<string, number> = {}
  private readonly actions: Record<string, number> = {}
  private readonly calib = new Map<Dialect, { calls: number; prompt: number; sim: number; rec: number }>()

  readonly policy: string
  constructor(policy: string) {
    this.policy = policy
  }

  add(call: TraceCall, model: ModelPrice, sim: SimResult, c: CostBreakdown, choice: { point?: string; action?: string }): void {
    const u = sim.usage
    this.calls++
    this.tok.prompt += u.promptTokens
    this.tok.cacheRead += u.cacheReadTokens
    this.tok.cacheWrite += sim.writeTokens
    this.tok.uncached += u.uncachedInputTokens
    this.tok.output += u.outputTokens
    this.cost.total += c.total
    this.cost.input += c.input
    this.cost.cacheRead += c.cacheRead
    this.cost.cacheWrite += c.cacheWrite
    this.cost.output += c.output
    this.perSession.set(call.session, (this.perSession.get(call.session) ?? 0) + c.total)
    if (u.promptTokens > 0 && u.cacheReadTokens >= 0.9 * u.promptTokens) this.warm++
    const prev = this.lastServed.get(call.lineage)
    if (prev !== undefined && prev !== model.modelId) {
      this.switches++
      if (call.lastTurn === 'tool-result') this.toolTurnSwitches++
    }
    this.lastServed.set(call.lineage, model.modelId)
    const cold = Math.max(0, sim.writeTokens - call.newTokens)
    if (cold > COLD_WRITE_MIN_TOKENS) {
      this.coldCalls++
      this.coldTokens += cold
      this.coldLost += lostOnCold(model, cold, u.promptTokens, sim.writeTtl)
    }
    if (call.hints?.tier) {
      this.hinted++
      if (model.tier === call.hints.tier) this.adhered++
    }
    bump(this.tierMix, model.tier, c.total)
    bump(this.modelMix, model.modelId, c.total)
    if (choice.point) this.points[choice.point] = (this.points[choice.point] ?? 0) + 1
    if (choice.action) this.actions[choice.action] = (this.actions[choice.action] ?? 0) + 1
    if (call.recorded) {
      const k = this.calib.get(call.dialect) ?? { calls: 0, prompt: 0, sim: 0, rec: 0 }
      k.calls++
      k.prompt += call.promptTokens
      k.sim += u.cacheReadTokens
      k.rec += call.recorded.cacheReadTokens
      this.calib.set(call.dialect, k)
    }
  }

  result(meta?: Record<string, unknown>): PolicyResult {
    const costs = [...this.perSession.values()]
    const r: PolicyResult = {
      policy: this.policy,
      calls: this.calls,
      sessions: this.perSession.size,
      lineages: this.lastServed.size,
      tokens: { ...this.tok },
      costUsd: { ...this.cost },
      sessionCostUsd: { p50: quantile(costs, 0.5), p90: quantile(costs, 0.9), max: costs.reduce((m, x) => (x > m ? x : m), 0) },
      hitRate: this.tok.prompt ? this.tok.cacheRead / this.tok.prompt : 0,
      warmCallShare: this.calls ? this.warm / this.calls : 0,
      switches: this.switches,
      switchesPer100Calls: this.calls ? (100 * this.switches) / this.calls : 0,
      toolTurnSwitches: this.toolTurnSwitches,
      coldWriteCalls: this.coldCalls,
      coldWriteTokens: this.coldTokens,
      coldWriteLostUsd: this.coldLost,
      tierMix: this.tierMix,
      modelMix: this.modelMix,
    }
    if (meta) r.meta = meta
    if (this.hinted) r.intentAdherence = this.adhered / this.hinted
    if (Object.keys(this.points).length) r.decisionPoints = { ...this.points }
    if (Object.keys(this.actions).length) r.actions = { ...this.actions }
    if (this.calib.size) {
      r.calibration = {}
      for (const [d, k] of this.calib) {
        const sim = k.prompt ? k.sim / k.prompt : 0
        const rec = k.prompt ? k.rec / k.prompt : 0
        r.calibration[d] = { calls: k.calls, simulatedHitRate: sim, recordedHitRate: rec, deltaPp: 100 * (sim - rec) }
      }
    }
    return r
  }
}

/** Extra paid because `tokens` were written instead of read (same price tier as the request). */
function lostOnCold(model: ModelPrice, tokens: number, promptTokens: number, ttl: CacheTtl | undefined): number {
  const base: NormalizedUsage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 0, promptTokens }
  const asWrite = ttl ? costOf({ ...base, cacheWriteTokens: { [ttl]: tokens } }, model).total : costOf({ ...base, uncachedInputTokens: tokens }, model).total
  const asRead = costOf({ ...base, cacheReadTokens: tokens }, model).total
  return Math.max(0, asWrite - asRead)
}
