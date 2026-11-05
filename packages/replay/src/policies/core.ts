import { BlockHasher } from '../prefix.ts'
import type { TraceCall } from '../schema.ts'
import { CORE_IS_STUB, createEngine, type Decision, type Engine, InMemoryStateStore, type Policy, type RequestSummary } from '../deps.ts'
import type { PriceCatalog } from '../deps.ts'
import type { Choice, ReplayPolicy } from './types.ts'

export interface CorePolicyOpts {
  name: string
  policy: Policy
  catalog: PriceCatalog
  hints: 'none' | 'cooperative'
  blockTokens?: number
  requestedModel?: string
}

/** Builds the RequestSummary a router would have produced for this call (summarize() is bypassed: no bodies). */
export function toSummary(call: TraceCall, hasher: BlockHasher, hints: 'none' | 'cooperative', requestedModel = 'auto'): RequestSummary {
  // Template family = the template (system + tools) segment id; without one, segment 0 is conversation
  // content whose id changes on rewrites, so it must not stand in for the template (design §2.1).
  const tpl = call.prefix.templateTokens > 0 ? (call.prefix.segments[0]?.id ?? 'none') : 'none'
  const h: RequestSummary['hints'] = {}
  if (hints === 'cooperative') {
    if (call.markers?.includes('compaction')) h.boundary = 'compaction'
    else if (call.markers?.includes('subagent-start')) h.boundary = 'subagent-start'
    if (call.parentLineage) h.parentSession = call.parentLineage
    if (call.hints?.tier) h.tier = call.hints.tier
  }
  return {
    dialect: call.dialect,
    requestedModel,
    session: { root: call.session, lineage: call.lineage, source: hints === 'cooperative' ? 'cooperative' : 'header' },
    lastTurn: call.lastTurn,
    nonPortableState: [],
    prefix: {
      toolsHash: `tools:${tpl}`,
      systemHash: `system:${tpl}`,
      blockHashes: hasher.hashes(call.lineage, call.prefix.segments),
      estPromptTokens: call.promptTokens,
      messageCount: call.seq + 1,
    },
    hints: h,
    receivedAt: call.ts,
  }
}

/** Wraps @auto-router/core Engine: decide → (replayer simulates) → record with simulated usage. */
export function corePolicy(opts: CorePolicyOpts): ReplayPolicy {
  let clock = 0
  const engine: Engine = createEngine({ policy: opts.policy, catalog: opts.catalog, store: new InMemoryStateStore(), now: () => clock })
  const hasher = new BlockHasher(opts.blockTokens ?? 4096)
  const pending = new Map<string, { summary: RequestSummary; decision: Decision }>()
  return {
    name: opts.name,
    async choose(call): Promise<Choice> {
      clock = call.ts
      const summary = toSummary(call, hasher, opts.hints, opts.requestedModel)
      const decision = await engine.decide(summary)
      pending.set(call.lineage, { summary, decision })
      return { model: decision.model, point: decision.point, action: decision.action, reason: decision.reason }
    },
    async observe(call, served, usage) {
      const p = pending.get(call.lineage)
      if (!p) return
      pending.delete(call.lineage)
      await engine.record(p.summary, p.decision, { servedModel: served, status: 200, usage })
    },
    meta: () => ({ corePolicyVersion: opts.policy.version, coreIsStub: CORE_IS_STUB, hints: opts.hints }),
  }
}
