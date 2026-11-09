// What activating `next` over `prev` does to running sessions (0d research §2.4). Pure; the console shows it before
// a config change and asks for confirmation of 'disruptive' items (design 0.9). The router never uses it: a swap
// is never rejected because of what it changes (determinism across tasks, rollback must always work).
import { DIALECTS, type Policy, type Tier } from './policy.ts'
import type { Dialect, ModelPrice, PriceCatalog } from './pricing-types.ts'

export type SwapSeverity = 'info' | 'warn' | 'disruptive'
export interface SwapEffect {
  effect:
    | 'mode' | 'pool-added' | 'pool-removed' | 'model-added' | 'model-removed' | 'pin-removed' | 'tier-remap' | 'default-tier'
    | 'rules' | 'alias-added' | 'alias-removed' | 'alias-retargeted' | 'observe-default' | 'failover' | 'user-turn'
    | 'session-tier' | 'portability-loosened' | 'portability-tightened' | 'tuning'
  severity: SwapSeverity
  dialect?: Dialect
  model?: string
  /** English detail for logs and the console's fallback text; the console renders its own copy from `effect`. */
  detail: string
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Effective tier of each pool model (entry override, else catalog tier). */
function tiers(p: Policy, d: Dialect, priceOf: (id: string) => ModelPrice | undefined): Map<string, Tier | undefined> {
  return new Map((p.pools[d]?.models ?? []).map((e) => [e.model, e.tier ?? priceOf(e.model)?.tier]))
}

/** Concrete ids a client may pin under a policy (pool models, failover profiles, observe defaults). */
function pinnable(p: Policy): Set<string> {
  const ids = new Set<string>()
  for (const pool of Object.values(p.pools)) for (const e of pool?.models ?? []) { ids.add(e.model); for (const f of e.failover ?? []) ids.add(f) }
  for (const m of Object.values(p.observeDefaults ?? {})) if (m) ids.add(m)
  return ids
}

/**
 * The effects of replacing `prev` with `next`, most severe first. Severity: 'disruptive' = requests that work today
 * fail at once (a removed alias, dialect pool or pinnable model); 'warn' = running lineages change model at their
 * next decision point (removed pool model, tier remap, looser portability); 'info' = applies to later decisions.
 * The console adds counts from recent records (active lineages per model, alias and pin usage).
 */
export function policySwapEffects(prev: Policy, next: Policy, catalog: PriceCatalog): SwapEffect[] {
  const byId = new Map(catalog.models.map((m) => [m.modelId, m]))
  const priceOf = (id: string): ModelPrice | undefined => byId.get(id)
  const out: SwapEffect[] = []
  const add = (e: SwapEffect): void => { out.push(e) }

  if (prev.mode !== next.mode) {
    add({ effect: 'mode', severity: 'info', detail: next.mode === 'auto'
      ? 'observe → auto: alias requests get auto choices at each lineage\'s next decision point; hard locks hold'
      : 'auto → observe: lineages keep their model until their next break point, then get the observe default' })
  }
  for (const d of DIALECTS) {
    const a = prev.pools[d]
    const b = next.pools[d]
    if (a && !b) { add({ effect: 'pool-removed', severity: 'disruptive', dialect: d, detail: `${d}: no pool, so alias requests (also hard-locked lineages) fail with 503 and go to the gateway fallback` }); continue }
    if (!a && b) { add({ effect: 'pool-added', severity: 'info', dialect: d, detail: `${d}: new pool` }); continue }
    if (!a || !b) continue
    const ta = tiers(prev, d, priceOf)
    const tb = tiers(next, d, priceOf)
    for (const [m, t] of ta) {
      if (!tb.has(m)) add({ effect: 'model-removed', severity: 'warn', dialect: d, model: m, detail: `${d}: ${m} leaves the pool; lineages on it hold through hard locks and move at their next user turn or break point` })
      else if (tb.get(m) !== t) add({ effect: 'tier-remap', severity: 'warn', dialect: d, model: m, detail: `${d}: ${m} ${t ?? '?'} → ${tb.get(m) ?? '?'}; lineages may switch at their next decision point (cold cache)` })
    }
    for (const m of tb.keys()) if (!ta.has(m)) add({ effect: 'model-added', severity: 'info', dialect: d, model: m, detail: `${d}: ${m} joins the pool` })
    if (a.defaultTier !== b.defaultTier) add({ effect: 'default-tier', severity: 'info', dialect: d, detail: `${d}: default tier ${a.defaultTier} → ${b.defaultTier}` })
    const fo = (p: Policy, m: string) => p.pools[d]?.models.find((e) => e.model === m)?.failover ?? []
    for (const m of ta.keys()) {
      if (tb.has(m) && !same(fo(prev, m), fo(next, m))) add({ effect: 'failover', severity: 'info', dialect: d, model: m, detail: `${d}: ${m} failover profiles ${fo(prev, m).join(',') || '-'} → ${fo(next, m).join(',') || '-'}` })
    }
    if (prev.observeDefaults?.[d] !== next.observeDefaults?.[d]) {
      add({ effect: 'observe-default', severity: 'info', dialect: d, detail: `${d}: observe default ${prev.observeDefaults?.[d] ?? '-'} → ${next.observeDefaults?.[d] ?? '-'}; lineages keep their model until their next break point` })
    }
  }
  const pa = pinnable(prev)
  const pb = pinnable(next)
  for (const m of pa) if (!pb.has(m)) add({ effect: 'pin-removed', severity: 'disruptive', model: m, detail: `${m} is no longer allowed: requests naming it get 400 pin-not-allowed at once` })
  for (const [k, v] of Object.entries(prev.aliases)) {
    if (!Object.hasOwn(next.aliases, k)) add({ effect: 'alias-removed', severity: 'disruptive', detail: `alias ${k} removed: requests using it get 400 at once` })
    else if (next.aliases[k] !== v) add({ effect: 'alias-retargeted', severity: 'info', detail: `alias ${k}: ${v} → ${next.aliases[k]}` })
  }
  for (const k of Object.keys(next.aliases)) if (!Object.hasOwn(prev.aliases, k)) add({ effect: 'alias-added', severity: 'info', detail: `alias ${k} → ${next.aliases[k]}` })
  if (!same(prev.rules, next.rules)) add({ effect: 'rules', severity: 'info', detail: 'routing rules changed (applied at each lineage\'s next decision point)' })
  if (prev.userTurn !== next.userTurn) add({ effect: 'user-turn', severity: 'info', detail: `userTurn ${prev.userTurn} → ${next.userTurn}` })
  if (prev.sessionTier !== next.sessionTier) add({ effect: 'session-tier', severity: 'info', detail: `sessionTier ${prev.sessionTier ?? 'off'} → ${next.sessionTier ?? 'off'}` })
  for (const tag of new Set([...Object.keys(prev.portability), ...Object.keys(next.portability)])) {
    const x = prev.portability[tag] ?? 'same-model'
    const y = next.portability[tag] ?? 'same-model'
    if (x === y) continue
    if (y === 'same-family') add({ effect: 'portability-loosened', severity: 'warn', detail: `${tag}: ${x} → ${y}; provider state may now move within a family` })
    else add({ effect: 'portability-tightened', severity: 'info', detail: `${tag}: ${x} → ${y}` })
  }
  const tuning = ['gate', 'cache', 'hysteresis', 'horizon', 'compaction', 'failover'] as const
  const changed = tuning.filter((k) => !same(prev[k], next[k]))
  if (changed.length) add({ effect: 'tuning', severity: 'info', detail: `${changed.join(', ')} changed (later decisions only)` })
  const rank: Record<SwapSeverity, number> = { disruptive: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}
