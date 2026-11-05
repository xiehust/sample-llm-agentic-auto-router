import type { TraceCall } from '../schema.ts'
import type { Choice, PolicyCtx, ReplayPolicy, Tier } from './types.ts'

export const recorded: ReplayPolicy = {
  name: 'recorded',
  choose: (call, ctx) => ({ model: ctx.resolve(call), reason: 'trace model' }),
}

export const alwaysTier = (name: string, tier: Tier): ReplayPolicy => ({
  name,
  choose: (call, ctx) => ({ model: ctx.pools[call.dialect][tier] }),
})

/** Cache-blind per-request stub classifier: tool follow-ups with little new context → fast, else frontier. */
export function classifierTier(call: TraceCall): Tier {
  return call.lastTurn === 'tool-result' && call.newTokens < 4000 ? 'fast' : 'frontier'
}

export const classifier: ReplayPolicy = {
  name: 'classifier',
  choose: (call, ctx) => ({ model: ctx.pools[call.dialect][classifierTier(call)] }),
}

/** Classifier once per lineage, then pinned. */
export function stickySession(): ReplayPolicy {
  const pinned = new Map<string, string>()
  return {
    name: 'sticky-session',
    choose(call: TraceCall, ctx: PolicyCtx): Choice {
      let m = pinned.get(call.lineage)
      if (!m) pinned.set(call.lineage, (m = ctx.pools[call.dialect][classifierTier(call)]))
      return { model: m }
    },
  }
}

/** Test policy: model `from` until the lineage's call index `atSeq`, then `to`. */
export function scripted(from: string, to: string, atSeq: number): ReplayPolicy {
  return { name: `scripted:${from}->${to}@${atSeq}`, choose: (call) => ({ model: call.seq >= atSeq ? to : from }) }
}

/**
 * Cache-blind policy with the same intent as core's costModeledSubagentFast: every request of a
 * sub-agent lineage → fast, main lineage → standard. Applied immediately, per request: no hard locks,
 * no cost gate, no hysteresis. Sub-agent identity comes from parentLineage / 'subagent-start' on the
 * lineage's first call (what a cooperative harness sends), remembered per lineage.
 */
export function intentBlind(): ReplayPolicy {
  const sub = new Set<string>()
  return {
    name: 'intent-blind',
    choose(call: TraceCall, ctx: PolicyCtx): Choice {
      if (call.parentLineage || call.markers?.includes('subagent-start')) sub.add(call.lineage)
      return { model: ctx.pools[call.dialect][sub.has(call.lineage) ? 'fast' : 'standard'] }
    },
  }
}

/**
 * Cache-blind counterpart for per-turn intent: serves the call's hinted tier (standard when unhinted)
 * on every request, so it switches at each user turn whose intent differs — no lock, gate or hysteresis.
 */
export const hintBlind: ReplayPolicy = {
  name: 'hint-blind',
  choose: (call, ctx) => ({ model: ctx.pools[call.dialect][call.hints?.tier ?? 'standard'] }),
}
