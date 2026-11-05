import { describe, expect, it } from 'vitest'
import { costOf } from './deps.ts'
import { ProviderCacheSim, type SimRequest } from './sim.ts'
import { HAIKU, LUNA, model, OPUS, SONNET } from './test-helpers.ts'

const req = (ts: number, chain: number, extra: Partial<SimRequest> = {}): SimRequest => ({
  lineage: 'L', ts, segments: [{ id: 'tpl', tokens: 10_000 }, { id: 'L:s0', tokens: chain }], promptTokens: 10_000 + chain, outputTokens: 100, ...extra,
})

describe('ProviderCacheSim', () => {
  it('cold write then warm read within TTL; refresh on hit extends life', () => {
    const sim = new ProviderCacheSim()
    const opus = model(OPUS)
    const a = sim.serve(opus, req(0, 5_000))
    expect(a.usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: { '5m': 15_000 }, uncachedInputTokens: 0 })
    const b = sim.serve(opus, req(299_999, 6_000))
    expect(b.usage).toMatchObject({ cacheReadTokens: 15_000, cacheWriteTokens: { '5m': 1_000 } })
    // b refreshed the 15K entry and wrote a 16K entry at t=299_999; both live until 599_999
    const c = sim.serve(opus, req(599_998, 7_000))
    expect(c.usage.cacheReadTokens).toBe(16_000)
  })
  it('hit refresh alone keeps an entry alive past its original TTL', () => {
    const sim = new ProviderCacheSim()
    const opus = model(OPUS)
    const branch = (ts: number, id: string): SimRequest => ({
      lineage: 'L', ts, segments: [{ id: 'tpl', tokens: 10_000 }, { id: 'L:s0', tokens: 5_000 }, { id, tokens: 1_000 }], promptTokens: 16_000, outputTokens: 1,
    })
    sim.serve(opus, req(0, 5_000)) // 15K entry, expires at 300_000
    expect(sim.serve(opus, branch(200_000, 'x')).usage.cacheReadTokens).toBe(15_000) // refresh → 500_000
    // a different branch only shares the 15K entry, so this read depends on the refresh
    expect(sim.serve(opus, branch(450_000, 'y')).usage.cacheReadTokens).toBe(15_000)
    expect(sim.serve(opus, branch(1_000_000, 'z')).usage.cacheReadTokens).toBe(0)
  })
  it('expires exactly at TTL (5m from request start)', () => {
    const sim = new ProviderCacheSim()
    sim.serve(model(OPUS), req(0, 5_000))
    expect(sim.serve(model(OPUS), req(300_000, 6_000)).usage.cacheReadTokens).toBe(0)
  })
  it('never shares across models', () => {
    const sim = new ProviderCacheSim()
    sim.serve(model(OPUS), req(0, 5_000))
    expect(sim.serve(model(SONNET), req(1_000, 6_000)).usage.cacheReadTokens).toBe(0)
  })
  it('fragmentation: A → B → A within TTL rewrites only what was appended meanwhile', () => {
    const sim = new ProviderCacheSim()
    sim.serve(model(OPUS), req(0, 5_000))
    sim.serve(model(SONNET), req(1_000, 6_000))
    const back = sim.serve(model(OPUS), req(2_000, 7_000))
    expect(back.usage.cacheReadTokens).toBe(15_000)
    expect(back.writeTokens).toBe(2_000)
  })
  it('below minTokens: no read, no write, all uncached', () => {
    const sim = new ProviderCacheSim()
    const r = sim.serve(model(OPUS), { lineage: 'L', ts: 0, segments: [{ id: 'x', tokens: 300 }], promptTokens: 300, outputTokens: 1 })
    expect(r.usage).toMatchObject({ uncachedInputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: {} })
  })
  it('GPT 30m TTL', () => {
    const sim = new ProviderCacheSim()
    sim.serve(model(LUNA), req(0, 5_000))
    expect(sim.serve(model(LUNA), req(1_799_000, 6_000)).usage.cacheReadTokens).toBe(15_000)
  })
  it('ttlOverride 1h is billed at the 1h write price and lives 1h', () => {
    const sim = new ProviderCacheSim({ ttlOverride: { [HAIKU]: '1h' } })
    const a = sim.serve(model(HAIKU), req(0, 5_000))
    expect(a.usage.cacheWriteTokens).toEqual({ '1h': 15_000 })
    expect(costOf(a.usage, model(HAIKU)).cacheWrite).toBeCloseTo((15_000 * 0.2) / 1e6, 12)
    expect(sim.serve(model(HAIKU), req(3_000_000, 6_000)).usage.cacheReadTokens).toBe(15_000)
  })
  it('lookback: same-lineage entry too many blocks back is not found', () => {
    const sim = new ProviderCacheSim({ lookbackBlocks: 20 })
    sim.serve(model(OPUS), req(0, 5_000, { blockIndex: 0 }))
    expect(sim.serve(model(OPUS), req(1_000, 6_000, { blockIndex: 21 })).usage.cacheReadTokens).toBe(0)
    expect(sim.serve(model(OPUS), req(2_000, 7_000, { blockIndex: 22 })).usage.cacheReadTokens).toBe(16_000)
  })
  it('scatter is deterministic per seed and lowers hits', () => {
    const run = (seed: number) => {
      const sim = new ProviderCacheSim({ scatter: { global: 0.5, geo: 0, inRegion: 0, shards: 4 }, seed })
      let read = 0
      for (let i = 0; i < 200; i++) read += sim.serve(model(OPUS), req(i * 1000, 1000 + i * 100)).usage.cacheReadTokens
      return read
    }
    expect(run(3)).toBe(run(3))
    const plain = new ProviderCacheSim()
    let full = 0
    for (let i = 0; i < 200; i++) full += plain.serve(model(OPUS), req(i * 1000, 1000 + i * 100)).usage.cacheReadTokens
    expect(run(3)).toBeLessThan(full)
  })
  it('sweep drops expired entries', () => {
    const sim = new ProviderCacheSim()
    sim.serve(model(OPUS), req(0, 5_000))
    expect(sim.liveEntries(1)).toBe(1)
    sim.sweep(400_000)
    expect(sim.liveEntries(400_000)).toBe(0)
  })
})
