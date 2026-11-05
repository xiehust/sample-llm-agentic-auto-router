// Cost of serving the next H calls on one model (core design.md §5; parent §5).
// All per-token pricing goes through costOf; this module only decides how tokens split.
import { costOf, type CacheTtl, type ModelPrice, type NormalizedUsage } from './pricing-types.ts'

export interface CostInput {
  /** Tokens of the current prompt already warm on this model. */
  warmTokens: number
  /** Current prompt size (estPromptTokens). */
  promptTokens: number
  horizon: { calls: number; appendTokensPerCall: number; outputTokensPerCall: number }
  /** TTL the writes would use on this model. */
  writeTtl: CacheTtl
}

export interface CostEstimate { totalUsd: number; perCallUsd: number[] }

/**
 * call 0:      read W, write P − W, output O
 * call i ≥ 1:  prompt_i = P + i·D (D = append + output); read prompt_{i−1}, write D, output O
 * In-turn gaps are far below any TTL, so calls after the first are assumed warm.
 */
export function estimateCost(price: ModelPrice, input: CostInput): CostEstimate {
  const { calls, appendTokensPerCall, outputTokensPerCall: out } = input.horizon
  const P = Math.max(0, input.promptTokens)
  const D = appendTokensPerCall + out
  const perCallUsd: number[] = []
  let total = 0
  for (let i = 0; i < calls; i++) {
    const prompt = P + i * D
    const read = i === 0 ? Math.min(Math.max(0, input.warmTokens), P) : P + (i - 1) * D
    const usage = splitUsage(price, prompt, read, prompt - read, out, input.writeTtl)
    const c = costOf(usage, price).total
    perCallUsd.push(c)
    total += c
  }
  return { totalUsd: total, perCallUsd }
}

/** Maps (read, write) onto the model's cache behaviour before pricing. */
function splitUsage(price: ModelPrice, prompt: number, read: number, write: number, out: number, ttl: CacheTtl): NormalizedUsage {
  const base = { outputTokens: out, promptTokens: prompt }
  const { mode, minTokens } = price.cache
  if (mode === 'none' || prompt < minTokens) {
    return { ...base, uncachedInputTokens: prompt, cacheReadTokens: 0, cacheWriteTokens: {} }
  }
  if (mode === 'implicit') {
    // Implicit-only caching carries no write premium: new tokens bill at the base input price.
    return { ...base, uncachedInputTokens: write, cacheReadTokens: read, cacheWriteTokens: {} }
  }
  return { ...base, uncachedInputTokens: 0, cacheReadTokens: read, cacheWriteTokens: { [ttl]: write } }
}
