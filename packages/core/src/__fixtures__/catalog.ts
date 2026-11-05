// Test catalog: ids match packages/pricing/data/catalog.ap-northeast-1.json; prices are Bedrock global
// prices (research A §2) so hand calculations stay simple. Not the real catalog on purpose: it adds a
// jp. Sonnet failover profile, a 200K Haiku window and an implicit-only Kimi to exercise those paths.
import type { ModelPrice, PriceCatalog } from '../pricing-types.ts'

const claudeCache = { mode: 'explicit', minTokens: 512, ttls: ['5m', '1h'], defaultTtl: '5m' } as const satisfies ModelPrice['cache']
const gptCache = { mode: 'both', minTokens: 1024, ttls: ['30m'], defaultTtl: '30m' } as const satisfies ModelPrice['cache']
const claude = (m: Omit<ModelPrice, 'family' | 'dialects' | 'cache'>): ModelPrice => ({
  ...m, family: 'claude', dialects: ['anthropic-messages'], cache: { ...claudeCache, ttls: [...claudeCache.ttls] },
})
const gpt = (m: Omit<ModelPrice, 'family' | 'dialects' | 'cache' | 'endpointScope'>): ModelPrice => ({
  ...m, family: 'gpt', endpointScope: 'global', dialects: ['openai-chat', 'openai-responses'], cache: { ...gptCache, ttls: [...gptCache.ttls] },
})

export const OPUS = 'global.anthropic.claude-opus-5-5'
export const SONNET = 'global.anthropic.claude-sonnet-5-5'
export const SONNET_JP = 'jp.anthropic.claude-sonnet-5-5'
export const HAIKU = 'global.anthropic.claude-haiku-5-5'
export const ASTRA = 'global.openai.gpt-6-astra'
export const SOL = 'global.openai.gpt-6.1-sol'
export const LUNA = 'global.openai.gpt-6-luna'
export const KIMI = 'global.moonshotai.kimi-k3'

export const fixtureCatalog: PriceCatalog = {
  version: 'fixture-2026-11-04',
  asOf: '2026-11-04',
  source: 'core test fixture (research A §2 global prices)',
  region: 'ap-northeast-1',
  models: [
    claude({ modelId: OPUS, tier: 'frontier', endpointScope: 'global', contextWindow: 1_000_000,
      price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: { '5m': 5, '1h': 8 } } }),
    claude({ modelId: SONNET, tier: 'standard', endpointScope: 'global', contextWindow: 1_000_000,
      price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: { '5m': 2.5, '1h': 4 } } }),
    claude({ modelId: SONNET_JP, tier: 'standard', endpointScope: 'geo', contextWindow: 1_000_000,
      price: { input: 2.2, output: 11, cacheRead: 0.11, cacheWrite: { '5m': 2.75, '1h': 4.4 } } }),
    claude({ modelId: HAIKU, tier: 'fast', endpointScope: 'global', contextWindow: 200_000,
      price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: { '5m': 0.125, '1h': 0.2 } },
      longContext: { aboveTokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: { '5m': 0.625, '1h': 1 } } } }),
    gpt({ modelId: ASTRA, tier: 'frontier', contextWindow: 1_050_000,
      price: { input: 10, output: 50, cacheRead: 1, cacheWrite: { '30m': 12.5 } },
      longContext: { aboveTokens: 272_000, price: { input: 20, output: 75, cacheRead: 2, cacheWrite: { '30m': 25 } } } }),
    gpt({ modelId: SOL, tier: 'standard', contextWindow: 1_000_000,
      price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: { '30m': 2.5 } },
      longContext: { aboveTokens: 272_000, price: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: { '30m': 5 } } } }),
    gpt({ modelId: LUNA, tier: 'fast', contextWindow: 1_050_000,
      price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: { '30m': 0.125 } },
      longContext: { aboveTokens: 272_000, price: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: { '30m': 0.25 } } } }),
    { modelId: KIMI, family: 'kimi', tier: 'standard', endpointScope: 'global', dialects: ['openai-chat', 'openai-responses'],
      contextWindow: 256_000, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: { '30m': 3.75 } },
      cache: { mode: 'implicit', minTokens: 256, ttls: ['30m'], defaultTtl: '30m' } },
  ],
}

export const priceOf = (id: string): ModelPrice => {
  const m = fixtureCatalog.models.find((x) => x.modelId === id)
  if (!m) throw new Error(`fixture: no ${id}`)
  return m
}
