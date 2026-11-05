import { describe, expect, it } from 'vitest'
import { HAIKU, KIMI, OPUS, priceOf, SONNET } from './__fixtures__/catalog.ts'
import { Conversation, Harness, MIN, SEC, T0, testPolicy, userText, assistantText } from './__fixtures__/traces.ts'
import { estimateCost } from './cost.ts'
import { costOf } from './pricing-types.ts'

const D = 1250 // append 1000 + output 250 per call
const horizon = (calls: number) => ({ calls, appendTokensPerCall: 1000, outputTokensPerCall: 250 })

/** Smallest H at which a cold switch to `to` costs less than staying warm on `from` (no hysteresis). */
function breakEven(from: string, to: string, context: number, maxH = 200): number | undefined {
  for (let H = 1; H <= maxH; H++) {
    const stay = estimateCost(priceOf(from), { warmTokens: context - D, promptTokens: context, horizon: horizon(H), writeTtl: '5m' }).totalUsd
    const sw = estimateCost(priceOf(to), { warmTokens: 0, promptTokens: context, horizon: horizon(H), writeTtl: '5m' }).totalUsd
    if (sw < stay) return H
  }
  return undefined
}

describe('estimateCost', () => {
  it('matches a hand calculation (Opus, 50K, 48.75K warm, 2 calls)', () => {
    const e = estimateCost(priceOf(OPUS), { warmTokens: 48_750, promptTokens: 50_000, horizon: horizon(2), writeTtl: '5m' })
    // call 0: read 48,750×0.2 + write 1,250×5 + out 250×20 = 9,750 + 6,250 + 5,000 = $0.021
    // call 1: read 50,000×0.2 + write 1,250×5 + out 5,000 = 10,000 + 6,250 + 5,000 = $0.02125
    expect(e.perCallUsd[0]).toBeCloseTo(0.021, 9)
    expect(e.perCallUsd[1]).toBeCloseTo(0.02125, 9)
    expect(e.totalUsd).toBeCloseTo(0.04225, 9)
  })

  it('prices each call through costOf, including the long-context tier', () => {
    // Haiku at 150K is above the 100K threshold: the whole request is re-priced.
    const e = estimateCost(priceOf(HAIKU), { warmTokens: 0, promptTokens: 150_000, horizon: horizon(1), writeTtl: '5m' })
    const direct = costOf({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: { '5m': 150_000 }, outputTokens: 250, promptTokens: 150_000 }, priceOf(HAIKU))
    expect(direct.tier).toBe('long')
    expect(e.totalUsd).toBeCloseTo(direct.total, 12)
    expect(e.totalUsd).toBeCloseTo((150_000 * 0.625 + 250 * 2.5) / 1e6, 12)
  })

  it('implicit-only caches bill new tokens at the input price; prompts below minTokens are uncached', () => {
    const k = estimateCost(priceOf(KIMI), { warmTokens: 0, promptTokens: 10_000, horizon: horizon(1), writeTtl: '30m' })
    expect(k.totalUsd).toBeCloseTo((10_000 * 3 + 250 * 15) / 1e6, 12)
    const tiny = estimateCost(priceOf(SONNET), { warmTokens: 400, promptTokens: 400, horizon: horizon(1), writeTtl: '5m' })
    expect(tiny.totalUsd).toBeCloseTo((400 * 2 + 250 * 10) / 1e6, 12)
  })
})

describe('break-even table, parent design §1 (scenario 19)', () => {
  it('Opus 5.5 → Sonnet 5.5 at 50K breaks even at ≈ 11 calls', () => {
    const h = breakEven(OPUS, SONNET, 50_000)
    expect(h).toBeGreaterThanOrEqual(10)
    expect(h).toBeLessThanOrEqual(12)
  })
  it('Opus 5.5 → Sonnet 5.5 at 150K breaks even at ≈ 17 calls', () => {
    const h = breakEven(OPUS, SONNET, 150_000)
    expect(h).toBeGreaterThanOrEqual(16)
    expect(h).toBeLessThanOrEqual(18)
  })
  it('down to Haiku: cheaper from the first call at 50K; 2–7 calls at 150K (long tier)', () => {
    expect(breakEven(OPUS, HAIKU, 50_000)).toBe(1)
    expect(breakEven(SONNET, HAIKU, 50_000)).toBe(1)
    const h = breakEven(OPUS, HAIKU, 150_000)
    expect(h).toBeGreaterThanOrEqual(2)
    expect(h).toBeLessThanOrEqual(7)
  })
  it('up (Sonnet → Opus) is never recovered; one-time cost ≈ $0.25 at 50K', () => {
    expect(breakEven(SONNET, OPUS, 50_000)).toBeUndefined()
    const first = (m: string, warm: number) => estimateCost(priceOf(m), { warmTokens: warm, promptTokens: 50_000, horizon: horizon(1), writeTtl: '5m' }).totalUsd
    // cold write on Opus vs a warm call on Sonnet, ignoring the per-call price gap afterwards
    expect(first(OPUS, 0) - first(SONNET, 50_000 - D)).toBeCloseTo(0.25, 1)
  })
})

describe('switch-back within TTL is priced with fragmentation only (scenario 13)', () => {
  it('a model visited earlier keeps its old prefix warm; only the appended part is cold', async () => {
    const hz = new Harness(testPolicy({ hysteresis: { minTurnsBeforeSwitch: 0 }, horizon: { calls: 5 } }))
    const conv = new Conversation().push(userText(`start ${'x'.repeat(200_000)}`)) // ≈ 56K tokens
    const s1 = await hz.cc(conv.body(), {}, { at: T0 })
    expect(s1.decision.model).toBe(SONNET)
    // turn 2: upgrade to Opus (cold write there); Sonnet stays warm until its TTL
    conv.push(assistantText('ok'), userText('think harder'))
    const s2 = await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 20 * SEC })
    expect(s2.decision).toMatchObject({ action: 'switch', model: OPUS })
    // turn 3: back to the default tier. Sonnet's cached prefix (turn 1) is in this request's chain.
    const before = await hz.store.get(s2.summary.session.lineage)
    expect(before!.perModel[SONNET]!.cachedTokens).toBe(s1.summary.prefix.estPromptTokens)
    conv.push(assistantText('done'), userText('thanks, carry on'))
    const s3 = await hz.cc(conv.body(), {}, { at: T0 + 40 * SEC })
    const P = s3.summary.prefix.estPromptTokens
    const warmSwitch = estimateCost(priceOf(SONNET), { warmTokens: s1.summary.prefix.estPromptTokens, promptTokens: P, horizon: horizon(5), writeTtl: '5m' }).totalUsd
    const coldSwitch = estimateCost(priceOf(SONNET), { warmTokens: 0, promptTokens: P, horizon: horizon(5), writeTtl: '5m' }).totalUsd
    expect(s3.decision.estimate!.switchUsd).toBeCloseTo(warmSwitch, 12)
    expect(s3.decision.estimate!.switchUsd).toBeLessThan(coldSwitch)
    // With fragmentation pricing the short-horizon switch-back passes; a cold switch would not.
    expect(s3.decision).toMatchObject({ action: 'switch', model: SONNET, point: 'user-turn' })
    expect(s3.decision.reason).toMatch(/^downgrade: /)
    expect(s3.decision.estimate!.stayUsd - coldSwitch).toBeLessThan(0.02)
  })

  it('the old prefix is cold again after its TTL', async () => {
    const hz = new Harness(testPolicy({ hysteresis: { minTurnsBeforeSwitch: 0 }, horizon: { calls: 5 } }))
    const conv = new Conversation().push(userText(`start ${'x'.repeat(200_000)}`))
    await hz.cc(conv.body(), {}, { at: T0 })
    conv.push(assistantText('ok'), userText('think harder'))
    await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 20 * SEC })
    // Opus stays warm with keep-alive traffic while Sonnet's 5m entry lapses.
    for (let i = 1; i <= 3; i++) {
      conv.push(assistantText(`step ${i}`), userText(`next ${i}`))
      await hz.cc(conv.body(), { 'x-router-tier': 'frontier' }, { at: T0 + 20 * SEC + i * 2 * MIN })
    }
    conv.push(assistantText('done'), userText('thanks'))
    const s = await hz.cc(conv.body(), {}, { at: T0 + 20 * SEC + 7 * MIN })
    expect(s.decision.estimate!.switchUsd).toBeCloseTo(
      estimateCost(priceOf(SONNET), { warmTokens: 0, promptTokens: s.summary.prefix.estPromptTokens, horizon: horizon(5), writeTtl: '5m' }).totalUsd, 12)
    expect(s.decision.reason).toMatch(/^downgrade-rejected:cost: /)
  })
})

describe('gate calibration, follow-up item 8 (Sonnet 5.5 → Haiku 5.5, long tier)', () => {
  // A user-turn downgrade: the stay side is warm except the turn's append (≈2K), the target is cold.
  const at = (P: number, H: number, ttl: '5m' | '1h') => {
    const hz = { calls: H, appendTokensPerCall: 1000, outputTokensPerCall: 250 }
    const stay = estimateCost(priceOf(SONNET), { warmTokens: P - 2000, promptTokens: P, horizon: hz, writeTtl: ttl }).totalUsd
    const sw = estimateCost(priceOf(HAIKU), { warmTokens: 0, promptTokens: P, horizon: hz, writeTtl: ttl }).totalUsd
    return { stay, sw, saving: stay - sw, need: Math.max(0.02, 0.2 * sw) }
  }
  const firstH = (P: number, ttl: '5m' | '1h', withHysteresis: boolean): number | undefined => {
    for (let H = 1; H <= 200; H++) {
      const r = at(P, H, ttl)
      if (withHysteresis ? r.saving > r.need : r.saving > 0) return H
    }
    return undefined
  }

  it('150K, 1h, H=15: saving $0.064 vs $0.058 needed (passes by $0.007); the long tier prices the whole request', () => {
    const r = at(150_000, 15, '1h')
    expect(r.stay).toBeCloseTo(0.3517, 4)
    expect(r.sw).toBeCloseTo(0.2876, 4)
    expect(r.saving).toBeGreaterThan(r.need)
    // first call on Haiku: 150K written at the long-tier 1h price ($1.00/M) + 250 output at $2.50/M
    expect(estimateCost(priceOf(HAIKU), { warmTokens: 0, promptTokens: 150_000, horizon: horizon(1), writeTtl: '1h' }).totalUsd).toBeCloseTo(0.150625, 9)
  })

  it('break-even horizons: raw 8 (5m) / 11 (1h); with k=1.2 and minUsd 10 / 15 — all ≤ the remaining calls seen in replay (p50 ≈ 47)', () => {
    expect([firstH(150_000, '5m', false), firstH(150_000, '1h', false)]).toEqual([8, 11])
    expect([firstH(150_000, '5m', true), firstH(150_000, '1h', true)]).toEqual([10, 15])
    // at 188K and 1h the margin, not the horizon, rejects H=15
    const r = at(188_000, 15, '1h')
    expect(r.saving).toBeGreaterThan(0)
    expect(r.saving).toBeLessThan(r.need)
  })
})
