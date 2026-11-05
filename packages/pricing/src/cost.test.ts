import { describe, expect, it } from 'vitest'
import { findModel, loadCatalog } from './catalog.ts'
import { costOf } from './cost.ts'
import { PricingError } from './errors.ts'
import { readFixtureJson } from './test-helpers.ts'
import type { ModelPrice, NormalizedUsage } from './types.ts'
import { normalizeUsage } from './usage.ts'

const catalog = loadCatalog()
const model = (id: string): ModelPrice => {
  const m = findModel(catalog, id)
  if (!m) throw new Error(`missing ${id}`)
  return m
}
const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => {
  const base = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: {}, outputTokens: 0, ...u }
  const written = Object.values(base.cacheWriteTokens).reduce((a: number, b) => a + (b ?? 0), 0)
  return { promptTokens: base.uncachedInputTokens + base.cacheReadTokens + written, ...base }
}

// Hand calculations: tokens × USD/MTok ÷ 1e6, using the Tokyo catalog (2026-11-04.1).
describe('costOf', () => {
  it('Haiku 5.5 global at 150K prompt uses the >100K tier for the whole request', () => {
    const c = costOf(
      usage({ uncachedInputTokens: 2_000, cacheReadTokens: 140_000, cacheWriteTokens: { '5m': 8_000 }, outputTokens: 1_000 }),
      model('global.anthropic.claude-haiku-5-5'),
    )
    expect(c.tier).toBe('long')
    expect(c.input).toBeCloseTo(0.001, 12) // 2,000 × 0.50
    expect(c.cacheRead).toBeCloseTo(0.007, 12) // 140,000 × 0.05
    expect(c.cacheWrite).toBeCloseTo(0.005, 12) // 8,000 × 0.625
    expect(c.output).toBeCloseTo(0.0025, 12) // 1,000 × 2.50
    expect(c.total).toBeCloseTo(0.0155, 12)
  })

  it('Haiku 5.5: exactly 100,000 prompt tokens stays on the base tier; 100,001 is long', () => {
    const m = model('global.anthropic.claude-haiku-5-5')
    const base = costOf(usage({ uncachedInputTokens: 100_000 }), m)
    expect(base.tier).toBe('base')
    expect(base.total).toBeCloseTo(0.01, 12) // 100,000 × 0.10
    const long = costOf(usage({ uncachedInputTokens: 100_001 }), m)
    expect(long.tier).toBe('long')
    expect(long.total).toBeCloseTo(0.0500005, 12) // 100,001 × 0.50
  })

  it('jp. Haiku 5.5 long tier uses the +10% geo prices', () => {
    const c = costOf(usage({ uncachedInputTokens: 150_000, outputTokens: 1_000 }), model('jp.anthropic.claude-haiku-5-5'))
    expect(c.tier).toBe('long')
    expect(c.total).toBeCloseTo(150_000 * 0.55e-6 + 1_000 * 2.75e-6, 12)
  })

  it('GPT-6.1 Sol at 300K prompt uses the >272K tier (strictly greater; > vs >= at 272,000 is unverified)', () => {
    const c = costOf(
      usage({ uncachedInputTokens: 4_000, cacheReadTokens: 290_000, cacheWriteTokens: { '30m': 6_000 }, outputTokens: 2_000 }),
      model('global.openai.gpt-6.1-sol'),
    )
    expect(c.tier).toBe('long')
    expect(c.input).toBeCloseTo(0.016, 12) // 4,000 × 4
    expect(c.cacheRead).toBeCloseTo(0.058, 12) // 290,000 × 0.20
    expect(c.cacheWrite).toBeCloseTo(0.03, 12) // 6,000 × 5
    expect(c.output).toBeCloseTo(0.03, 12) // 2,000 × 15
    expect(c.total).toBeCloseTo(0.134, 12)
    expect(costOf(usage({ uncachedInputTokens: 272_000 }), model('global.openai.gpt-6.1-sol')).tier).toBe('base')
  })

  it('Opus 5.5 global with mixed 1h and 5m writes', () => {
    const c = costOf(
      usage({ uncachedInputTokens: 50, cacheReadTokens: 10_000, cacheWriteTokens: { '1h': 20_000, '5m': 5_000 }, outputTokens: 1_000 }),
      model('global.anthropic.claude-opus-5-5'),
    )
    expect(c.tier).toBe('base')
    expect(c.input).toBeCloseTo(0.0002, 12) // 50 × 4
    expect(c.cacheRead).toBeCloseTo(0.002, 12) // 10,000 × 0.20
    expect(c.cacheWrite).toBeCloseTo(0.185, 12) // 20,000 × 8 + 5,000 × 5
    expect(c.output).toBeCloseTo(0.02, 12) // 1,000 × 20
    expect(c.total).toBeCloseTo(0.2072, 12)
  })

  it('Sonnet 5.5 cache read is billed at 0.10/MTok (not Sonnet 5\'s 0.20)', () => {
    expect(costOf(usage({ cacheReadTokens: 1_000_000 }), model('global.anthropic.claude-sonnet-5-5')).total).toBeCloseTo(0.1, 12)
    expect(costOf(usage({ cacheReadTokens: 1_000_000 }), model('global.anthropic.claude-sonnet-5')).total).toBeCloseTo(0.2, 12)
  })

  it('a write TTL without a price falls back to the default TTL price', () => {
    const c = costOf(usage({ cacheWriteTokens: { '12h': 1_000 } }), model('global.moonshotai.kimi-k3'))
    expect(c.cacheWrite).toBeCloseTo(0.00375, 12) // 1,000 × 3.75 (30m)
  })

  it('throws PricingError when neither the TTL nor the default TTL has a price', () => {
    expect(() => costOf(usage({ cacheWriteTokens: { '5m': 100 } }), model('moonshotai.kimi-k2.5'))).toThrow(PricingError)
  })

  it('prices a real fixture end to end (Haiku 5.5 cache write)', () => {
    const u = normalizeUsage('anthropic-messages', readFixtureJson('anthropic-messages/nonstream-write.json'))
    const c = costOf(u, model('global.anthropic.claude-haiku-5-5'))
    expect(c.total).toBeCloseTo((11 * 0.1 + 3169 * 0.125 + 4 * 0.5) / 1e6, 15)
  })

  it('prices a real fixture end to end (GPT-6 Luna cache read via Responses)', () => {
    const u = normalizeUsage('openai-responses', readFixtureJson('openai-responses/nonstream-read.json'))
    const c = costOf(u, model('global.openai.gpt-6-luna'))
    expect(c.total).toBeCloseTo((2 * 0.1 + 3046 * 0.01 + 5 * 0.5) / 1e6, 15)
  })
})
