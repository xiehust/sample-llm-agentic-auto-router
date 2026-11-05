import { costOf, type Dialect, findModel, type PriceCatalog } from './deps.ts'
import { PolicyMetrics, type PolicyResult } from './metrics.ts'
import { DEFAULT_FALLBACK, type Pools, resolveTraceModel, validatePools } from './pools.ts'
import type { ReplayPolicy } from './policies/types.ts'
import type { TraceCall } from './schema.ts'
import { ProviderCacheSim, type SimConfig } from './sim.ts'

export interface ReplayOptions {
  catalog: PriceCatalog
  pools: Pools
  sim?: SimConfig
  fallback?: Record<Dialect, string>
  filter?: (call: TraceCall) => boolean
  /** progress callback every N calls */
  onProgress?: (calls: number) => void
}

export interface ReplayRun {
  results: PolicyResult[]
  modelMap: Record<string, string>
  trace: { calls: number; sessions: number; lineages: number; firstTs?: number; lastTs?: number }
}

/** Replays a time-ordered call stream once, feeding every policy its own simulator and metrics. */
export async function runReplay(calls: Iterable<TraceCall> | AsyncIterable<TraceCall>, policies: ReplayPolicy[], opts: ReplayOptions): Promise<ReplayRun> {
  validatePools(opts.pools, opts.catalog)
  const fallback = opts.fallback ?? DEFAULT_FALLBACK
  const modelMap: Record<string, string> = {}
  const resolved = new Map<string, string>()
  const resolve = (c: TraceCall) => {
    const k = `${c.dialect}|${c.model}`
    let id = resolved.get(k)
    if (!id) {
      const r = resolveTraceModel(c.model, c.dialect, opts.catalog, opts.pools, fallback)
      resolved.set(k, (id = r.id))
      modelMap[`${c.dialect}:${c.model}`] = `${r.id} (${r.via})`
    }
    return id
  }
  const ctx = { catalog: opts.catalog, pools: opts.pools, resolve }
  const lanes = policies.map((p) => ({ p, sim: new ProviderCacheSim(opts.sim), m: new PolicyMetrics(p.name) }))
  const blocks = new Map<string, number>()
  const sessions = new Set<string>()
  let n = 0
  let firstTs: number | undefined
  let lastTs: number | undefined
  for await (const call of calls) {
    if (opts.filter && !opts.filter(call)) continue
    if (lastTs !== undefined && call.ts < lastTs) throw new Error(`trace not time-ordered at ${call.lineage}#${call.seq}`)
    n++
    firstTs ??= call.ts
    lastTs = call.ts
    sessions.add(call.session)
    const blockIndex = (blocks.get(call.lineage) ?? 0) + (call.appendedBlocks ?? 0)
    blocks.set(call.lineage, blockIndex)
    const visible: TraceCall = call.recorded ? { ...call, recorded: undefined } : call
    for (const lane of lanes) {
      const choice = await lane.p.choose(visible, ctx)
      const model = findModel(opts.catalog, choice.model)
      if (!model) throw new Error(`${lane.p.name}: chose '${choice.model}', not in catalog`)
      if (!model.dialects.includes(call.dialect)) throw new Error(`${lane.p.name}: '${model.modelId}' does not serve ${call.dialect}`)
      const sim = lane.sim.serve(model, {
        lineage: call.lineage,
        ts: call.ts,
        segments: call.prefix.segments,
        promptTokens: call.promptTokens,
        outputTokens: call.outputTokens,
        ...(call.reasoningTokens !== undefined ? { reasoningTokens: call.reasoningTokens } : {}),
        blockIndex,
      })
      const cost = costOf(sim.usage, model)
      lane.m.add(call, model, sim, cost, choice)
      await lane.p.observe?.(visible, model.modelId, sim.usage)
    }
    if (opts.onProgress && n % 50_000 === 0) opts.onProgress(n)
  }
  const results = lanes.map((l) => l.m.result(l.p.meta?.()))
  const base = results.find((r) => r.policy === 'recorded')
  if (base && base.costUsd.total > 0) for (const r of results) r.deltaVsRecordedPct = (100 * (r.costUsd.total - base.costUsd.total)) / base.costUsd.total
  return { results, modelMap, trace: { calls: n, sessions: sessions.size, lineages: blocks.size, ...(firstTs !== undefined ? { firstTs, lastTs } : {}) } }
}
