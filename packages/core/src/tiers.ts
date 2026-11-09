// Tier → model resolution over a policy pool (pure; also used by usage ingest for savings baselines, 0d §1.4).
import { tierRank, type Policy, type Tier } from './policy.ts'
import type { Dialect, ModelPrice, PriceCatalog } from './pricing-types.ts'

type Prices = PriceCatalog | ReadonlyMap<string, ModelPrice>
const priceOf = (c: Prices, id: string): ModelPrice | undefined => (c instanceof Map ? c.get(id) : (c as PriceCatalog).models.find((m) => m.modelId === id))

/**
 * The model decide() would pick for tier `t` with no gate or state: the first pool entry (pool ∩ catalog ∩ dialect)
 * of tier t, else the nearest higher tier, else the nearest lower. Undefined when the dialect has no usable pool.
 */
export function modelForTier(policy: Policy, catalog: Prices, dialect: Dialect, t: Tier): string | undefined {
  const cands: Array<{ model: string; tier: Tier }> = []
  for (const e of policy.pools[dialect]?.models ?? []) {
    const p = priceOf(catalog, e.model)
    if (p && p.dialects.includes(dialect)) cands.push({ model: e.model, tier: e.tier ?? p.tier })
  }
  const want = tierRank(t)
  for (let r = want; r <= 2; r++) { const c = cands.find((x) => tierRank(x.tier) === r); if (c) return c.model }
  for (let r = want - 1; r >= 0; r--) { const c = cands.find((x) => tierRank(x.tier) === r); if (c) return c.model }
  return undefined
}

/** Pool tier of a model in a dialect pool (a failover profile counts as its entry), else its catalog tier. */
export function tierOfPoolModel(policy: Policy, catalog: Prices, dialect: Dialect, model: string): Tier | undefined {
  const e = policy.pools[dialect]?.models.find((m) => m.model === model || m.failover?.includes(model))
  if (e) return e.tier ?? priceOf(catalog, e.model)?.tier ?? priceOf(catalog, model)?.tier
  return priceOf(catalog, model)?.tier
}
