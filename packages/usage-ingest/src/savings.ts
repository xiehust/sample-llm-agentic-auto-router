// Per-line cost figures (0d §1.3–§1.7, design 0.11 / 0.3c / 0.16). Every figure is integer nano-USD, rounded once
// per component, so sums over records and rollups reconcile exactly and every identity holds in integers:
// R = B − A*, S = A − A*, N = B − A − X = R − S − X.
import { modelForTier, parseReason, tierOfPoolModel, type Policy, type Tier } from '@auto-router/core'
import { writeTtlFor } from '@auto-router/core/policy'
import { costOf, findModel, type CacheTtl, type Dialect, type ModelPrice, type NormalizedUsage, type PriceCatalog } from '@auto-router/pricing'
import type { RouterLine } from './types.ts'

export { modelForTier, parseReason, tierOfPoolModel, writeTtlFor }

export const BASELINES = ['static', 'tier:standard', 'tier:frontier', 'observe-default'] as const
export type BaselineKey = (typeof BASELINES)[number]
/** Short attribute suffix per baseline (rollup counters). */
export const BASELINE_TAG: Readonly<Record<BaselineKey, string>> = { static: 'st', 'tier:standard': 'ts', 'tier:frontier': 'tf', 'observe-default': 'od' }

/** Why a priced line is not part of the savings figures (its A stays in spend). */
export type Exclusion = 'pin' | 'no-decision' | 'unpriced' | 'catalog-mismatch' | 'policy-unknown' | 'access-cap'
export type BaselineExclusion = 'no-baseline' | 'baseline-infeasible'

export const nano = (usd: number): number => Math.round(usd * 1e9) || 0


const TTL_DESC: readonly CacheTtl[] = ['12h', '1h', '30m', '5m']
const sumWrites = (w: NormalizedUsage['cacheWriteTokens']): number => Object.values(w).reduce<number>((a, b) => a + (b ?? 0), 0)
const copy = (u: NormalizedUsage): NormalizedUsage => ({ ...u, cacheWriteTokens: { ...u.cacheWriteTokens } })

/** The same token classes as model `m` would bill them (promptTokens and outputTokens never change). */
export function reshape(u: NormalizedUsage, m: ModelPrice): NormalizedUsage {
  if (m.cache.mode === 'none' || u.promptTokens < m.cache.minTokens) {
    return { ...copy(u), uncachedInputTokens: u.promptTokens, cacheReadTokens: 0, cacheWriteTokens: {} }
  }
  if (m.cache.mode === 'implicit') {
    return { ...copy(u), uncachedInputTokens: u.uncachedInputTokens + sumWrites(u.cacheWriteTokens), cacheWriteTokens: {} }
  }
  return copy(u)
}

/** What the lineage would have read had it not switched: move up to `w` warm tokens into cache reads. */
export function warmAdj(u: NormalizedUsage, w: number): NormalizedUsage {
  const out = copy(u)
  let k = Math.max(0, Math.min(w, u.promptTokens) - u.cacheReadTokens)
  for (const ttl of TTL_DESC) {
    const have = out.cacheWriteTokens[ttl] ?? 0
    if (k === 0 || have === 0) continue
    const moved = Math.min(have, k)
    if (have - moved > 0) out.cacheWriteTokens[ttl] = have - moved
    else delete out.cacheWriteTokens[ttl]
    out.cacheReadTokens += moved
    k -= moved
  }
  const fromUncached = Math.min(out.uncachedInputTokens, k)
  out.uncachedInputTokens -= fromUncached
  out.cacheReadTokens += fromUncached
  return out
}

/** Projection only: a cold target writes what the line read. */
export function coldAdj(u: NormalizedUsage, ttl: CacheTtl): NormalizedUsage {
  const out = copy(u)
  out.cacheWriteTokens[ttl] = (out.cacheWriteTokens[ttl] ?? 0) + out.cacheReadTokens
  out.cacheReadTokens = 0
  return out
}

export const noCache = (u: NormalizedUsage): NormalizedUsage => ({ ...copy(u), uncachedInputTokens: u.promptTokens, cacheReadTokens: 0, cacheWriteTokens: {} })

const total = (u: NormalizedUsage, m: ModelPrice): number => costOf(u, m).total

export function baselineModel(k: BaselineKey, policy: Policy, catalog: PriceCatalog, dialect: Dialect, requested: string): string | undefined {
  if (k === 'observe-default') return policy.observeDefaults?.[dialect]
  if (k === 'tier:standard') return modelForTier(policy, catalog, dialect, 'standard')
  if (k === 'tier:frontier') return modelForTier(policy, catalog, dialect, 'frontier')
  const alias = policy.aliases[requested]
  if (alias === undefined) return undefined
  const t = alias === 'default' ? policy.pools[dialect]?.defaultTier : alias
  return t ? modelForTier(policy, catalog, dialect, t) : undefined
}

/** Reason code via core's parseReason (C3); 'ineligible' marks a policy-forced switch. */
export const reasonCode = (reason: string | undefined): string => parseReason(reason ?? '').code
/** A decision held below its tier by the caller's cap (design 0.16: `; access-cap:<tier>` in the reason). */
export const isAccessCapped = (reason: string | undefined): boolean => parseReason(reason ?? '').accessCap !== undefined

export interface BaselineFigure {
  model?: string
  tier?: Tier
  /** B_K, nano-USD (absent when excluded) */
  b?: number
  excluded?: BaselineExclusion
}

export interface LineFigures {
  /** usage + costUsd present */
  priced: boolean
  /** A = costUsd.total (nano) on priced lines */
  a?: number
  /** A* (nano) when the line is in the savings set or the cap row */
  aStar?: number
  /** X (nano): uncached assessor consultations */
  x: number
  /** X counts against N: routable lines and failed requests without usage (0d §1.3) */
  xInN: boolean
  /** global exclusion of a priced line (its A stays in spend) */
  excluded?: Exclusion
  /** no usage on a request that did not fail: 0.3c unmetered */
  unmetered: boolean
  /** costBoundUsd (nano) of an unmetered line */
  bound?: number
  routable: boolean
  routingSwitch: boolean
  otherSwitch: boolean
  baselines: Partial<Record<BaselineKey, BaselineFigure>>
  /** cold-cache cost of a non-routing switch (nano), informational */
  coldOther?: number
  /** prompt-cache saving net of the write premium (nano) */
  cNet?: number
  /** |A − costOf(u, P)| ≥ 1e-9 */
  costMismatch: boolean
  /** observe "projected if auto" (0d §1.6) */
  projection?: { model: string; tier?: Tier; switch: boolean; aHat: number; aPen: number } | { excluded: 'projection-unpriced' }
}

/**
 * All figures for one line. `policy` is the line's own policy (undefined: not resolvable), `catalog` the ingest's
 * bundled catalog (lines priced with another catalog version are excluded as catalog-mismatch).
 */
export function lineFigures(line: RouterLine, policy: Policy | undefined, catalog: PriceCatalog): LineFigures {
  const d = line.decision
  const a = line.assessor
  const x = a && !a.cached && typeof a.costUsd === 'number' ? nano(a.costUsd) : 0
  const f: LineFigures = { priced: false, x, xInN: false, unmetered: false, routable: false, routingSwitch: false, otherSwitch: false, baselines: {}, costMismatch: false }
  const u = line.usage
  if (!u) {
    if (line.status < 400) {
      f.unmetered = true
      if (typeof line.costBoundUsd === 'number') f.bound = nano(line.costBoundUsd)
    } else {
      f.xInN = true // a consultation before a failed call is still spend the routing caused
    }
    return f
  }
  if (!line.costUsd) {
    f.excluded = 'unpriced'
    return f
  }
  f.priced = true
  f.a = nano(line.costUsd.total)
  if (line.catalogVersion !== catalog.version) {
    f.excluded = 'catalog-mismatch'
    return f
  }
  const served = line.servedModel ? findModel(catalog, line.servedModel) : undefined
  if (!served) {
    f.excluded = 'unpriced'
    return f
  }
  f.costMismatch = Math.abs(line.costUsd.total - total(u, served)) >= 1e-9
  f.cNet = nano(total(noCache(u), served)) - f.a
  if (!d) f.excluded = 'no-decision'
  else if (d.action === 'pin') f.excluded = 'pin'
  else if (!policy || policy.version !== d.policyVersion) f.excluded = 'policy-unknown'
  else if (line.requested === undefined || policy.aliases[line.requested] === undefined) f.excluded = 'pin'
  else if (isAccessCapped(d.reason)) f.excluded = 'access-cap'

  const sw = line.switchedFrom
  f.routingSwitch = !!sw && !!d && d.mode === 'auto' && d.action === 'switch' && d.point !== 'failover' && !line.failover
    && line.servedModel === d.model && reasonCode(d.reason) !== 'ineligible'
  f.otherSwitch = !!sw && !f.routingSwitch
  if (f.otherSwitch && sw) f.coldOther = f.a - nano(total(reshape(warmAdj(u, sw.warmTokens), served), served))
  if (f.excluded && f.excluded !== 'access-cap') {
    f.routingSwitch = false
    return f
  }
  if (!policy || !line.dialect || !d || line.requested === undefined) return f

  // In the savings set (or the cap row): warm-equivalent usage, baselines.
  const uStar = f.routingSwitch && sw ? warmAdj(u, sw.warmTokens) : u
  f.aStar = nano(total(reshape(uStar, served), served))
  f.routable = f.excluded === undefined
  f.xInN = f.routable
  for (const k of BASELINES) {
    const id = baselineModel(k, policy, catalog, line.dialect, line.requested)
    const q = id ? findModel(catalog, id) : undefined
    if (!id || !q) {
      f.baselines[k] = { ...(id ? { model: id } : {}), excluded: 'no-baseline' }
      continue
    }
    const tier = tierOfPoolModel(policy, catalog, line.dialect, id)
    if (u.promptTokens > q.contextWindow) {
      f.baselines[k] = { model: id, ...(tier ? { tier } : {}), excluded: 'baseline-infeasible' }
      continue
    }
    f.baselines[k] = { model: id, ...(tier ? { tier } : {}), b: nano(total(reshape(uStar, q), q)) }
  }

  if (f.routable && d.mode === 'observe' && d.projected) {
    const m = findModel(catalog, d.projected.model)
    if (!m) f.projection = { excluded: 'projection-unpriced' }
    else {
      const aHat = nano(total(reshape(u, m), m))
      const aPen = d.projected.switch ? nano(total(reshape(coldAdj(u, writeTtlFor(policy, m.modelId, m)), m), m)) : aHat
      const tier = tierOfPoolModel(policy, catalog, line.dialect, m.modelId)
      f.projection = { model: m.modelId, ...(tier ? { tier } : {}), switch: d.projected.switch, aHat, aPen }
    }
  }
  return f
}
