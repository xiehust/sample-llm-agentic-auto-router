// Which concrete model ids the router may ever send upstream (review fix 5): catalog ∩ (pool models ∪ failover
// profiles ∪ observe defaults). Pins, decisions and failover targets outside this set are refused, and the task
// role's bedrock:InvokeModel* grants (infra/src/models.ts reads the same policy file) cover exactly these.
import type { Policy, Tier } from '@auto-router/core'
import type { Dialect, PriceCatalog } from '@auto-router/pricing'
import type { PoolModel } from './beta.ts'

export function allowedModels(policy: Policy, catalog: PriceCatalog): ReadonlySet<string> {
  const known = new Set(catalog.models.map((m) => m.modelId))
  const ids = new Set<string>()
  for (const pool of Object.values(policy.pools)) {
    for (const e of pool?.models ?? []) { ids.add(e.model); for (const f of e.failover ?? []) ids.add(f) }
  }
  for (const m of Object.values(policy.observeDefaults ?? {})) if (m) ids.add(m)
  return new Set([...ids].filter((id) => known.has(id)))
}

/** Pool models of one dialect with their effective tier (pool override, else catalog tier). */
export function poolTiers(policy: Policy, catalog: PriceCatalog, dialect: Dialect): PoolModel[] {
  const tierOf = (id: string): Tier | undefined => catalog.models.find((m) => m.modelId === id)?.tier as Tier | undefined
  return (policy.pools[dialect]?.models ?? []).flatMap((e) => {
    const tier = e.tier ?? tierOf(e.model)
    return tier ? [{ model: e.model, tier }] : []
  })
}
