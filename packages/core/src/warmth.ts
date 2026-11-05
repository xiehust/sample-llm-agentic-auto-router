// Per (lineage, model) cache warmth (core design.md §4; research C M2/M3).
import type { Policy } from './policy.ts'
import type { CacheTtl, ModelPrice } from './pricing-types.ts'
import type { CacheState, PrefixRecord, RequestSummary, SessionState } from './types.ts'

export const TTL_MS: Readonly<Record<CacheTtl, number>> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '12h': 12 * 60 * 60_000,
}

/** TTL the router assumes for writes on `model`: policy override, else catalog default, else 5m. */
export function writeTtlFor(policy: Policy, model: string, price: ModelPrice | undefined): CacheTtl {
  return policy.cache.writeTtl?.[model] ?? price?.cache.defaultTtl ?? '5m'
}

/** True once the entry is within the safety margin of its TTL end. */
export function isExpired(entry: CacheState, nowMs: number, marginMs: number): boolean {
  return nowMs > entry.lastTouchMs + entry.ttlMs - marginMs
}

/** Membership set over a summary's chain, built once per decide()/record(). */
export function blockSetOf(summary: RequestSummary): Set<string> {
  return new Set(summary.prefix.blockHashes)
}

/** Most records kept per (lineage, model). */
export const MAX_PREFIX_RECORDS = 4

/** The entry's prefix records, most recent first; a legacy entry without `prefixes` is one record. */
export function recordsOf(entry: CacheState): PrefixRecord[] {
  if (entry.prefixes) return entry.prefixes
  if (entry.cachedPrefixHash === undefined) return []
  return [{ hash: entry.cachedPrefixHash, tokens: entry.cachedTokens, touchMs: entry.lastTouchMs }]
}

/** A record is live until its own touch + the model's TTL − margin. */
export function isRecordLive(r: PrefixRecord, entry: CacheState, nowMs: number, marginMs: number): boolean {
  return nowMs <= r.touchMs + entry.ttlMs - marginMs
}

/** Largest live record (compaction baseline); falls back to cachedTokens for an entry without records. */
export function maxLiveTokens(entry: CacheState, nowMs: number, marginMs: number): number {
  const recs = recordsOf(entry)
  if (recs.length === 0) return entry.cachedTokens
  let max = 0
  for (const r of recs) if (r.tokens > max && isRecordLive(r, entry, nowMs, marginMs)) max = r.tokens
  return max
}

/**
 * Builds an entry from records (most recent first, capped at MAX_PREFIX_RECORDS). The compat fields mirror
 * records[0]; lastTouchMs is the latest touch over all records. Returns undefined when no record is left.
 */
export function entryFrom(model: string, records: PrefixRecord[], ttlMs: number): CacheState | undefined {
  const recs = records.slice(0, MAX_PREFIX_RECORDS)
  const first = recs[0]
  if (first === undefined) return undefined
  let last = first.touchMs
  for (const r of recs) if (r.touchMs > last) last = r.touchMs
  return { model, cachedPrefixHash: first.hash, cachedTokens: first.tokens, lastTouchMs: last, ttlMs, prefixes: recs }
}

/**
 * Tokens of this request's prefix expected to be warm on `model`: the largest live record whose hash is
 * in this request's chain, capped at the prompt. Zero when there is no entry, no record matches, every
 * matching record expired, or the prompt is below the cacheable minimum. A model visited earlier and still
 * within TTL keeps its old prefix warm, so switching back only pays for what was appended meanwhile
 * (fragmentation). Several records let a fork and its parent stay warm side by side.
 */
export function warmTokens(
  state: SessionState | undefined,
  model: string,
  summary: RequestSummary,
  nowMs: number,
  opts: { marginMs: number; minTokens: number; blocks: Set<string> },
): number {
  const entry = state?.perModel[model]
  if (!entry) return 0
  const est = summary.prefix.estPromptTokens
  if (est < opts.minTokens) return 0
  let best = 0
  for (const r of recordsOf(entry)) {
    if (r.tokens > best && opts.blocks.has(r.hash) && isRecordLive(r, entry, nowMs, opts.marginMs)) best = r.tokens
  }
  return Math.min(best, est)
}
