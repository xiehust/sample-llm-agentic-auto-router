import { costOf, findModel, type Policy, type PriceCatalog } from './deps.ts'
import { hintBlind } from './policies/basic.ts'
import { corePolicy } from './policies/core.ts'
import type { Pools } from './pools.ts'
import type { TraceCall } from './schema.ts'
import { ProviderCacheSim, type SimConfig } from './sim.ts'

export interface GateGroup {
  turns: number
  /** realized cost of the turn plus the lineage's next turn (captures switch-back / fragmentation) */
  coreUsd: number
  blindUsd: number
  turnCalls: { p50: number; p90: number }
  promptTokens: { p50: number; p90: number }
}

export interface GateAnalysis {
  /** user turns whose hinted tier differed from core's current tier */
  hintedSwitches: number
  allowed: GateGroup
  blocked: GateGroup
  blockedByReason: Record<string, number>
  direction: Record<'down' | 'up', { allowed: number; blocked: number }>
}

const RANK = { fast: 0, standard: 1, frontier: 2 } as const
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
}

/**
 * Runs core (cooperative hints) and hint-blind side by side on the same trace, each with its own
 * simulator, and classifies every hinted switch request at a user turn as allowed or blocked by core.
 */
export async function gateAnalysis(trace: readonly TraceCall[], o: { catalog: PriceCatalog; pools: Pools; policy: Policy; sim?: SimConfig }): Promise<GateAnalysis> {
  const core = corePolicy({ name: 'core', policy: o.policy, catalog: o.catalog, hints: 'cooperative' })
  const blind = hintBlind
  const ctx = { catalog: o.catalog, pools: o.pools, resolve: () => { throw new Error('unused') } }
  const simCore = new ProviderCacheSim(o.sim)
  const simBlind = new ProviderCacheSim(o.sim)
  interface Turn { lineage: string; idx: number; calls: number; prompt: number; core: number; blind: number; req?: { dir: 'down' | 'up'; allowed: boolean; reason: string } }
  const turns: Turn[] = []
  const open = new Map<string, Turn>()
  const served = new Map<string, string>()
  const tierOf = (id: string) => findModel(o.catalog, id)!.tier
  for (const call of trace) {
    const cc = await core.choose(call, ctx)
    const bc = await blind.choose(call, ctx)
    const serve = (sim: ProviderCacheSim, id: string) => {
      const m = findModel(o.catalog, id)!
      const r = sim.serve(m, { lineage: call.lineage, ts: call.ts, segments: call.prefix.segments, promptTokens: call.promptTokens, outputTokens: call.outputTokens })
      return { usage: r.usage, usd: costOf(r.usage, m).total }
    }
    const rc = serve(simCore, cc.model)
    const rb = serve(simBlind, bc.model)
    await core.observe!(call, cc.model, rc.usage)
    if (call.lastTurn === 'user-text' || !open.has(call.lineage)) {
      const t: Turn = { lineage: call.lineage, idx: turns.length, calls: 0, prompt: call.promptTokens, core: 0, blind: 0 }
      const cur = served.get(call.lineage)
      const want = call.hints?.tier
      if (call.lastTurn === 'user-text' && cur && want && tierOf(cur) !== want) {
        const dir = RANK[want] < RANK[tierOf(cur)] ? 'down' : 'up'
        t.req = { dir, allowed: cc.action === 'switch', reason: (cc.reason ?? '').split(':')[0] ?? '' }
      }
      turns.push(t)
      open.set(call.lineage, t)
    }
    const t = open.get(call.lineage)!
    t.calls++
    t.core += rc.usd
    t.blind += rb.usd
    served.set(call.lineage, cc.model)
  }
  // pair each turn with the lineage's next turn
  const nextOf = new Map<number, Turn>()
  const lastByLineage = new Map<string, Turn>()
  for (const t of turns) {
    const prev = lastByLineage.get(t.lineage)
    if (prev) nextOf.set(prev.idx, t)
    lastByLineage.set(t.lineage, t)
  }
  const group = (ts: Turn[]): GateGroup => ({
    turns: ts.length,
    coreUsd: ts.reduce((n, t) => n + t.core + (nextOf.get(t.idx)?.core ?? 0), 0),
    blindUsd: ts.reduce((n, t) => n + t.blind + (nextOf.get(t.idx)?.blind ?? 0), 0),
    turnCalls: { p50: q(ts.map((t) => t.calls), 0.5), p90: q(ts.map((t) => t.calls), 0.9) },
    promptTokens: { p50: q(ts.map((t) => t.prompt), 0.5), p90: q(ts.map((t) => t.prompt), 0.9) },
  })
  const req = turns.filter((t) => t.req)
  const blockedByReason: Record<string, number> = {}
  const direction = { down: { allowed: 0, blocked: 0 }, up: { allowed: 0, blocked: 0 } }
  for (const t of req) {
    direction[t.req!.dir][t.req!.allowed ? 'allowed' : 'blocked']++
    if (!t.req!.allowed) blockedByReason[t.req!.reason] = (blockedByReason[t.req!.reason] ?? 0) + 1
  }
  return {
    hintedSwitches: req.length,
    allowed: group(req.filter((t) => t.req!.allowed)),
    blocked: group(req.filter((t) => !t.req!.allowed)),
    blockedByReason,
    direction,
  }
}
