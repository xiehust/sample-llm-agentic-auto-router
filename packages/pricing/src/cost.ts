import { PricingError } from './errors.ts'
import type { CacheTtl, CostBreakdown, ModelPrice, NormalizedUsage, UsdPerMTok } from './types.ts'

const PER_TOKEN = 1 / 1_000_000

/**
 * Prices one request. The long-context tier applies to the whole request when
 * `usage.promptTokens > price.longContext.aboveTokens` (strictly greater). Results are unrounded USD.
 * A write TTL without a price falls back to the model's default TTL price; if that is missing too,
 * PricingError is thrown.
 */
export function costOf(usage: NormalizedUsage, price: ModelPrice): CostBreakdown {
  const long = price.longContext !== undefined && usage.promptTokens > price.longContext.aboveTokens
  const p: UsdPerMTok = long && price.longContext ? price.longContext.price : price.price
  const input = usage.uncachedInputTokens * p.input * PER_TOKEN
  const cacheRead = usage.cacheReadTokens * p.cacheRead * PER_TOKEN
  let cacheWrite = 0
  for (const [ttl, tokens] of Object.entries(usage.cacheWriteTokens) as [CacheTtl, number | undefined][]) {
    if (!tokens) continue
    const rate = p.cacheWrite[ttl] ?? p.cacheWrite[price.cache.defaultTtl]
    if (rate === undefined) {
      throw new PricingError(`${price.modelId}: no cache-write price for ttl '${ttl}' (or default '${price.cache.defaultTtl}')`)
    }
    cacheWrite += tokens * rate * PER_TOKEN
  }
  const output = usage.outputTokens * p.output * PER_TOKEN
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output, tier: long ? 'long' : 'base' }
}
