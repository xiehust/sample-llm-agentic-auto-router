// Contract types for @auto-router/pricing. Names and shapes follow the parent design.md §3;
// fields marked "additive" are optional extensions agreed with the parent task.

export type Dialect = 'anthropic-messages' | 'openai-chat' | 'openai-responses'
export type CacheTtl = '5m' | '1h' | '30m' | '12h'

export interface NormalizedUsage {
  uncachedInputTokens: number // billed at base input price
  cacheReadTokens: number
  cacheWriteTokens: Partial<Record<CacheTtl, number>> // by TTL
  outputTokens: number // billed output, reasoning included
  reasoningTokens?: number
  promptTokens: number // uncached + read + written (tier selection)
}

export interface UsdPerMTok {
  input: number
  output: number
  cacheRead: number
  cacheWrite: Partial<Record<CacheTtl, number>>
}

export interface ModelPrice {
  modelId: string // Bedrock model or inference profile id
  family: 'claude' | 'gpt' | 'kimi' | 'nova' | 'other'
  tier: 'frontier' | 'standard' | 'fast'
  dialects: Dialect[] // APIs that reach it on bedrock-runtime
  endpointScope: 'global' | 'geo' | 'in-region'
  contextWindow: number
  price: UsdPerMTok
  longContext?: { aboveTokens: number; price: UsdPerMTok } // whole request re-priced above threshold
  cache: { mode: 'explicit' | 'implicit' | 'both' | 'none'; minTokens: number; ttls: CacheTtl[]; defaultTtl: CacheTtl }
  /** additive: where the price came from (e.g. 'price-list:ap-northeast-1', 'model-card') */
  priceSource?: string
  /** additive: where contextWindow came from */
  contextWindowSource?: string
  /** additive: free-form caveats (per-dialect cache differences, quota burn rates, ...) */
  notes?: string
}

export interface PriceCatalog {
  version: string
  asOf: string
  source: string
  region: string
  models: ModelPrice[]
  /** additive: models seen in the region but deliberately left out, with the reason */
  excluded?: { modelId: string; reason: string }[]
}

export interface CostBreakdown {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
  tier: 'base' | 'long'
}

export interface StreamUsageAccumulator {
  push(event: { event?: string; data: string }): void
  result(): NormalizedUsage | undefined
}
