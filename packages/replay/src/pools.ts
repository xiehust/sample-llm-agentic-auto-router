import { type Dialect, findModel, type PriceCatalog } from './deps.ts'

export type Tier = 'frontier' | 'standard' | 'fast'
export type Pools = Record<Dialect, Record<Tier, string>>

/** Default per-dialect pools (task design §5; ids agreed with router-core). */
export const DEFAULT_POOLS: Pools = {
  'anthropic-messages': { frontier: 'global.anthropic.claude-opus-5-5', standard: 'global.anthropic.claude-sonnet-5-5', fast: 'global.anthropic.claude-haiku-5-5' },
  'openai-chat': { frontier: 'global.openai.gpt-6-astra', standard: 'global.openai.gpt-6.1-sol', fast: 'global.openai.gpt-6-luna' },
  'openai-responses': { frontier: 'global.openai.gpt-6-astra', standard: 'global.openai.gpt-6.1-sol', fast: 'global.openai.gpt-6-luna' },
}

/** Fallback for trace models with no catalog entry and no tier keyword (nearest current flagship). */
export const DEFAULT_FALLBACK: Record<Dialect, string> = {
  'anthropic-messages': 'global.anthropic.claude-opus-4-8',
  'openai-chat': 'global.openai.gpt-5.6-sol',
  'openai-responses': 'global.openai.gpt-5.6-sol',
}

export function validatePools(pools: Pools, catalog: PriceCatalog): void {
  for (const [dialect, tiers] of Object.entries(pools) as [Dialect, Record<Tier, string>][]) {
    for (const [tier, id] of Object.entries(tiers)) {
      const m = findModel(catalog, id)
      if (!m) throw new Error(`pools.${dialect}.${tier}: '${id}' not in catalog ${catalog.version}`)
      if (!m.dialects.includes(dialect)) throw new Error(`pools.${dialect}.${tier}: '${id}' does not serve ${dialect}`)
    }
  }
}

const TIER_KEYWORDS: [RegExp, Tier][] = [
  [/haiku|luna|nano|spark|flash|(^|[-.])mini($|[-.])/, 'fast'],
  [/sonnet|terra|kimi/, 'standard'],
  [/opus|fable|astra|mythos/, 'frontier'],
]

/**
 * Maps a raw trace model name to a catalog id: exact id → global.<vendor>.<name> → catalog id with that
 * prefix → tier keyword (pool) → dialect fallback. Returns the id and how it was resolved.
 */
export function resolveTraceModel(raw: string, dialect: Dialect, catalog: PriceCatalog, pools: Pools,
  fallback: Record<Dialect, string> = DEFAULT_FALLBACK): { id: string; via: string } {
  const serves = (id: string) => findModel(catalog, id)?.dialects.includes(dialect) === true
  if (serves(raw)) return { id: raw, via: 'exact' }
  const vendor = dialect === 'anthropic-messages' ? 'anthropic' : raw.startsWith('kimi') ? 'moonshotai' : 'openai'
  const direct = `global.${vendor}.${raw}`
  if (serves(direct)) return { id: direct, via: 'global-id' }
  const pref = catalog.models.find((m) => m.modelId.startsWith(direct) && m.modelId.startsWith('global.') && m.dialects.includes(dialect))
  if (pref) return { id: pref.modelId, via: 'prefix' }
  for (const [re, tier] of TIER_KEYWORDS) if (re.test(raw)) return { id: pools[dialect][tier], via: `keyword:${tier}` }
  return { id: fallback[dialect], via: 'fallback' }
}
