// Acceptance: reproduce the parent design.md §1 break-even table (±1 step) from synthetic traces.
import { describe, expect, it } from 'vitest'
import { costOf } from './deps.ts'
import { ProviderCacheSim } from './sim.ts'
import { breakEvenCalls } from './synth.ts'
import { HAIKU, LUNA, model, OPUS, SOL, SONNET, TERRA } from './test-helpers.ts'

/** Warm steps after the switch needed to recoup it (0 = cheaper from the switch step; Infinity = never). */
function breakEven(from: string, to: string, context: number, maxSteps = 1000) {
  const dialect = from.includes('openai') ? 'openai-responses' : 'anthropic-messages'
  const calls = breakEvenCalls({ contextTokens: context, steps: maxSteps, dialect })
  const run = (target: string) => {
    const sim = new ProviderCacheSim()
    const a = model(from)
    return calls.map((c, i) => {
      const m = i === 0 ? a : model(target)
      return costOf(sim.serve(m, { lineage: c.lineage, ts: c.ts, segments: c.prefix.segments, promptTokens: c.promptTokens, outputTokens: c.outputTokens }).usage, m).total
    })
  }
  const stay = run(from)
  const sw = run(to)
  const extra = sw[1]! - stay[1]!
  let cs = 0
  let cw = 0
  for (let n = 1; n <= maxSteps; n++) {
    cs += stay[n]!
    cw += sw[n]!
    if (cw <= cs) return { steps: n - 1, extra }
  }
  return { steps: Infinity, extra }
}

describe('break-even of a first switch (parent §1; +1K new, 250 out per step)', () => {
  const cases: [string, string, string, number, number][] = [
    ['Opus 5.5 → Sonnet 5.5', OPUS, SONNET, 50_000, 11],
    ['Opus 5.5 → Sonnet 5.5', OPUS, SONNET, 150_000, 17],
    ['GPT-6.1 Sol → Terra', SOL, TERRA, 50_000, 11],
    ['GPT-6.1 Sol → Terra', SOL, TERRA, 150_000, 17],
    ['Opus 5.5 → Haiku 5.5', OPUS, HAIKU, 50_000, 0],
    ['Sonnet 5.5 → Haiku 5.5', SONNET, HAIKU, 50_000, 0],
    ['GPT-6.1 Sol → GPT-6 Luna', SOL, LUNA, 50_000, 0],
    ['GPT-6.1 Sol → GPT-6 Luna', SOL, LUNA, 150_000, 0],
    ['Opus 5.5 → Haiku 5.5 (long tier)', OPUS, HAIKU, 150_000, 2],
    ['Sonnet 5.5 → Haiku 5.5 (long tier)', SONNET, HAIKU, 150_000, 7],
  ]
  for (const [label, a, b, c, want] of cases) {
    it(`${label} at ${c / 1000}K: ${want} steps ±1`, () => {
      const { steps } = breakEven(a, b, c)
      expect(Math.abs(steps - want)).toBeLessThanOrEqual(1)
    })
  }
  for (const [c, extra] of [[50_000, 0.25], [150_000, 0.74]] as const) {
    it(`Sonnet 5.5 → Opus 5.5 at ${c / 1000}K: never recovered, +$${extra} one-time`, () => {
      const r = breakEven(SONNET, OPUS, c)
      expect(r.steps).toBe(Infinity)
      expect(r.extra).toBeCloseTo(extra, 2)
    })
  }
})
