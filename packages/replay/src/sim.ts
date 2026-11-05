import type { CacheTtl, ModelPrice, NormalizedUsage } from './deps.ts'
import type { Segment } from './schema.ts'

/** Simulator knobs (task design §4). All optional; defaults follow the catalog's cache block. */
export interface SimConfig {
  /** modelId → TTL to write with (default: catalog defaultTtl). */
  ttlOverride?: Record<string, CacheTtl>
  /** Anthropic-style read lookback in content blocks (same lineage only); null/undefined = off. */
  lookbackBlocks?: number | null
  /** P(request lands on a non-primary shard) by endpoint scope, and shards per (model) domain. */
  scatter?: { global: number; geo: number; inRegion: number; shards: number }
  seed?: number
}

export const TTL_MS: Record<CacheTtl, number> = { '5m': 300_000, '1h': 3_600_000, '30m': 1_800_000, '12h': 43_200_000 }

export interface SimRequest {
  lineage: string
  ts: number
  segments: readonly Segment[]
  promptTokens: number
  outputTokens: number
  reasoningTokens?: number
  /** cumulative content-block index of this request within its lineage (for lookback) */
  blockIndex?: number
}

export interface SimResult {
  usage: NormalizedUsage
  shard: number
  readTokens: number
  writeTokens: number
  writeTtl?: CacheTtl
}

interface Entry {
  lastLen: number // tokens of the entry's last segment
  total: number
  expiresAt: number
  ttlMs: number
  lineage: string
  blockIndex: number | undefined
}

interface Node {
  entries: Entry[]
  children: Map<string, Node>
}

const newNode = (): Node => ({ entries: [], children: new Map() })

/** mulberry32: small deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Ground-truth provider prompt cache: exact-prefix entries per (model, shard), TTL from request start,
 * refreshed on hit, written for the full prompt (breakpoint at the end). Never visible to policies.
 */
export class ProviderCacheSim {
  private readonly domains = new Map<string, Node>()
  private readonly rng: () => number
  private calls = 0
  readonly config: SimConfig
  constructor(config: SimConfig = {}) {
    this.config = config
    this.rng = mulberry32(config.seed ?? 1)
  }

  serve(model: ModelPrice, req: SimRequest): SimResult {
    const now = req.ts
    if (++this.calls % 20_000 === 0) this.sweep(now)
    const shard = this.pickShard(model)
    const empty: NormalizedUsage = {
      uncachedInputTokens: req.promptTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: {},
      outputTokens: req.outputTokens,
      promptTokens: req.promptTokens,
      ...(req.reasoningTokens !== undefined ? { reasoningTokens: req.reasoningTokens } : {}),
    }
    if (model.cache.mode === 'none' || req.promptTokens < model.cache.minTokens || req.segments.length === 0) {
      return { usage: empty, shard, readTokens: 0, writeTokens: 0 }
    }
    const key = `${model.modelId}#${shard}`
    let root = this.domains.get(key)
    if (!root) this.domains.set(key, (root = newNode()))

    // --- read: longest live entry that is a prefix of the request
    let best: Entry | undefined
    let node: Node | undefined = root
    let prevLen = 0
    for (let i = 0; i < req.segments.length && node; i++) {
      const seg = req.segments[i]!
      const child: Node | undefined = node.children.get(`${prevLen}|${seg.id}`)
      if (!child) break
      child.entries = child.entries.filter((e) => e.expiresAt > now)
      for (const e of child.entries) {
        if (e.lastLen > seg.tokens) continue
        if (!this.lookbackOk(e, req)) continue
        if (!best || e.total > best.total) best = e
      }
      node = child
      prevLen = seg.tokens
    }
    let read = 0
    if (best && best.total >= model.cache.minTokens) {
      read = best.total
      best.expiresAt = now + best.ttlMs
    }

    // --- write: entry for the full prompt
    const ttl = this.config.ttlOverride?.[model.modelId] ?? model.cache.defaultTtl
    const ttlMs = TTL_MS[ttl]
    let at: Node = root
    prevLen = 0
    let total = 0
    for (const seg of req.segments) {
      const k = `${prevLen}|${seg.id}`
      let child: Node | undefined = at.children.get(k)
      if (!child) at.children.set(k, (child = newNode()))
      at = child
      prevLen = seg.tokens
      total += seg.tokens
    }
    const last = req.segments[req.segments.length - 1]!
    const existing = at.entries.find((e) => e.lastLen === last.tokens)
    if (existing) {
      existing.expiresAt = Math.max(existing.expiresAt, now + ttlMs)
      existing.lineage = req.lineage
      existing.blockIndex = req.blockIndex
    } else {
      at.entries.push({ lastLen: last.tokens, total, expiresAt: now + ttlMs, ttlMs, lineage: req.lineage, blockIndex: req.blockIndex })
    }
    const write = req.promptTokens - read
    const priced = model.price.cacheWrite[ttl] !== undefined
    const usage: NormalizedUsage = {
      ...empty,
      uncachedInputTokens: priced ? 0 : write,
      cacheReadTokens: read,
      cacheWriteTokens: priced && write > 0 ? { [ttl]: write } : {},
    }
    return priced ? { usage, shard, readTokens: read, writeTokens: write, writeTtl: ttl } : { usage, shard, readTokens: read, writeTokens: 0 }
  }

  private lookbackOk(e: Entry, req: SimRequest): boolean {
    const lb = this.config.lookbackBlocks
    if (lb === null || lb === undefined) return true
    if (e.lineage !== req.lineage || e.blockIndex === undefined || req.blockIndex === undefined) return true
    return req.blockIndex - e.blockIndex <= lb
  }

  private pickShard(model: ModelPrice): number {
    const sc = this.config.scatter
    if (!sc || sc.shards <= 1) return 0
    const p = model.endpointScope === 'global' ? sc.global : model.endpointScope === 'geo' ? sc.geo : sc.inRegion
    if (p <= 0) return 0
    return this.rng() < p ? 1 + Math.floor(this.rng() * (sc.shards - 1)) : 0
  }

  /** Drops expired entries and empty nodes. */
  sweep(now: number): void {
    const prune = (n: Node): boolean => {
      n.entries = n.entries.filter((e) => e.expiresAt > now)
      for (const [k, c] of n.children) if (prune(c)) n.children.delete(k)
      return n.entries.length === 0 && n.children.size === 0
    }
    for (const [k, root] of this.domains) if (prune(root)) this.domains.delete(k)
  }

  /** Live entry count (tests / diagnostics). */
  liveEntries(now: number): number {
    let n = 0
    const walk = (x: Node) => {
      n += x.entries.filter((e) => e.expiresAt > now).length
      for (const c of x.children.values()) walk(c)
    }
    for (const r of this.domains.values()) walk(r)
    return n
  }
}
