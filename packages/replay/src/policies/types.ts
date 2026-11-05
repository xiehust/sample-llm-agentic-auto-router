import type { NormalizedUsage, PriceCatalog } from '../deps.ts'
import type { Pools, Tier } from '../pools.ts'
import type { TraceCall } from '../schema.ts'

export interface Choice {
  model: string
  point?: string
  action?: string
  reason?: string
}

export interface PolicyCtx {
  catalog: PriceCatalog
  pools: Pools
  /** raw trace model → catalog id (the `recorded` mapping) */
  resolve(call: TraceCall): string
}

/** A routing policy sees only router-visible data: the call (minus `recorded`) and its own outcomes. */
export interface ReplayPolicy {
  readonly name: string
  choose(call: TraceCall, ctx: PolicyCtx): Choice | Promise<Choice>
  observe?(call: TraceCall, served: string, usage: NormalizedUsage): void | Promise<void>
  /** extra report metadata (e.g. core policy version) */
  meta?(): Record<string, unknown>
}

export type { Tier }
