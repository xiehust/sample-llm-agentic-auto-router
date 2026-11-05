import { describe, expect, it } from 'vitest'
import { output } from './__fixtures__/fixtures.ts'
import { mapTier, type MapOptions, type TierMapping } from './map.ts'
import type { PackRule } from './pack.ts'
import type { Assessment } from './validate.ts'

const rule = (id: string, tier: PackRule['tier'], auto = false, enabled = true): PackRule => ({ id, tier, enabled, auto, instruction: id })
const RULES: PackRule[] = [
  rule('explore-readonly', 'fast'),
  rule('mechanical-edit', 'fast'),
  rule('bounded-change', 'standard'),
  rule('deep-investigation', 'frontier'),
]
const map = (a: Assessment, opts?: MapOptions, rules = RULES): TierMapping => mapTier(a, rules, opts)
const pick = (m: TierMapping) => ({ tier: m.proposedTier, basis: m.basis, outcome: m.outcome })

describe('mapTier: design §7 table (first match wins)', () => {
  it.each<[string, Assessment, { tier?: string; basis: string[]; outcome: string }]>([
    // row 1
    ['1 low confidence beats everything', output(['deep-investigation'], { reasoning_depth: 'deep' }, 0.79), { tier: undefined, basis: ['low-confidence'], outcome: 'low-confidence' }],
    // row 2
    ['2 fast + frontier rules conflict', output(['explore-readonly', 'deep-investigation']), { tier: undefined, basis: ['conflict:fast+frontier'], outcome: 'conflict' }],
    // row 3
    ['3 frontier rule', output(['deep-investigation'], { reasoning_depth: 'routine' }), { tier: 'frontier', basis: ['deep-investigation'], outcome: 'frontier' }],
    ['3 deep fact alone', output([], { reasoning_depth: 'deep' }), { tier: 'frontier', basis: ['fact:deep'], outcome: 'frontier' }],
    ['3 prior failures ≥ 2', output(['bounded-change'], { reasoning_depth: 'routine', prior_failures: 2 }), { tier: 'frontier', basis: ['fact:prior-failures'], outcome: 'frontier' }],
    ['3 all frontier signals', output(['deep-investigation'], { reasoning_depth: 'deep', prior_failures: 3 }), { tier: 'frontier', basis: ['deep-investigation', 'fact:deep', 'fact:prior-failures'], outcome: 'frontier' }],
    ['3 fast rule with a deep fact upgrades', output(['explore-readonly'], { reasoning_depth: 'deep' }), { tier: 'frontier', basis: ['fact:deep'], outcome: 'frontier' }],
    // row 4
    ['4 standard rule', output(['bounded-change'], { reasoning_depth: 'routine', edits_code: true, scope: 'single-file' }), { tier: 'standard', basis: ['bounded-change'], outcome: 'standard' }],
    ['4 multi-file edit fact', output([], { edits_code: true, scope: 'multi-file', reasoning_depth: 'routine' }), { tier: 'standard', basis: ['fact:multi-file-edit'], outcome: 'standard' }],
    ['4 cross-module edit fact', output([], { edits_code: true, scope: 'cross-module', reasoning_depth: 'routine' }), { tier: 'standard', basis: ['fact:multi-file-edit'], outcome: 'standard' }],
    ['5 specified mechanical multi-file edit stays fast', output(['mechanical-edit'], { edits_code: true, scope: 'multi-file', reasoning_depth: 'routine' }), { tier: 'fast', basis: ['mechanical-edit'], outcome: 'fast' }],
    ['5 specified mechanical cross-module edit stays fast', output(['mechanical-edit'], { edits_code: true, scope: 'cross-module', reasoning_depth: 'routine' }), { tier: 'fast', basis: ['mechanical-edit'], outcome: 'fast' }],
    ['6 unspecified mechanical multi-file edit → no opinion', output(['mechanical-edit'], { edits_code: true, scope: 'multi-file', specification: 'partially', reasoning_depth: 'routine' }), { tier: undefined, basis: ['fast-unsettled'], outcome: 'fast-unsettled' }],
    ['4 fast + standard rule with S facts → standard', output(['mechanical-edit', 'bounded-change'], { edits_code: true, scope: 'multi-file', reasoning_depth: 'routine' }), { tier: 'standard', basis: ['bounded-change'], outcome: 'standard' }],
    ['4 one prior failure is not frontier', output(['bounded-change'], { reasoning_depth: 'routine', prior_failures: 1 }), { tier: 'standard', basis: ['bounded-change'], outcome: 'standard' }],
    // row 5
    ['5 fast lookup', output(['explore-readonly']), { tier: 'fast', basis: ['explore-readonly'], outcome: 'fast' }],
    ['5 fast mechanical single-file edit', output(['mechanical-edit'], { edits_code: true, scope: 'single-file', reasoning_depth: 'routine' }), { tier: 'fast', basis: ['mechanical-edit'], outcome: 'fast' }],
    ['5 two fast rules', output(['explore-readonly', 'mechanical-edit']), { tier: 'fast', basis: ['explore-readonly', 'mechanical-edit'], outcome: 'fast' }],
    ['5 read-only cross-module lookup stays fast', output(['explore-readonly'], { scope: 'cross-module' }), { tier: 'fast', basis: ['explore-readonly'], outcome: 'fast' }],
    // row 6
    ['6 fast rule, partially specified', output(['explore-readonly'], { specification: 'partially' }), { tier: undefined, basis: ['fast-unsettled'], outcome: 'fast-unsettled' }],
    ['6 fast rule, ambiguous', output(['mechanical-edit'], { specification: 'ambiguous' }), { tier: undefined, basis: ['fast-unsettled'], outcome: 'fast-unsettled' }],
    // row 7
    ['7 nothing matched', output([], { reasoning_depth: 'routine' }), { tier: undefined, basis: ['no-rule'], outcome: 'no-rule' }],
  ])('row %s', (_, a, expected) => {
    expect(pick(map(a))).toEqual(expected)
  })

  it('uses the threshold option (default 0.8, inclusive)', () => {
    expect(map(output(['explore-readonly'], {}, 0.8)).proposedTier).toBe('fast')
    expect(map(output(['explore-readonly'], {}, 0.6), { threshold: 0.5 }).proposedTier).toBe('fast')
    expect(map(output(['explore-readonly'], {}, 0.9), { threshold: 0.95 }).outcome).toBe('low-confidence')
  })

  it('ignores matches of disabled or unknown rules', () => {
    const rules = RULES.map((r) => (r.id === 'deep-investigation' ? { ...r, enabled: false } : r))
    const a = output(['deep-investigation'], { reasoning_depth: 'routine' })
    expect(map(a, {}, rules).outcome).toBe('no-rule')
  })
})

describe('mapTier: auto eligibility (basis ⊆ auto)', () => {
  const autoRules = (...ids: string[]) => RULES.map((r) => (ids.includes(r.id) ? { ...r, auto: true } : r))

  it('is false in the default observe configuration', () => {
    expect(map(output(['explore-readonly'])).autoEligible).toBe(false)
    expect(map(output([], { reasoning_depth: 'deep' })).autoEligible).toBe(false)
  })

  it('is true when every basis rule is auto', () => {
    expect(map(output(['explore-readonly']), {}, autoRules('explore-readonly')).autoEligible).toBe(true)
    // Two fast rules, only one auto → not eligible.
    expect(map(output(['explore-readonly', 'mechanical-edit']), {}, autoRules('explore-readonly')).autoEligible).toBe(false)
    expect(map(output(['explore-readonly', 'mechanical-edit']), {}, autoRules('explore-readonly', 'mechanical-edit')).autoEligible).toBe(true)
  })

  it('requires fact signals in autoFacts', () => {
    const a = output(['deep-investigation'], { reasoning_depth: 'deep' })
    expect(map(a, {}, autoRules('deep-investigation')).autoEligible).toBe(false)
    expect(map(a, { autoFacts: ['deep'] }, autoRules('deep-investigation')).autoEligible).toBe(true)
    expect(map(output([], { edits_code: true, scope: 'multi-file', reasoning_depth: 'routine' }), { autoFacts: ['multi-file-edit'] }).autoEligible).toBe(true)
    expect(map(output([], { prior_failures: 2 }), { autoFacts: ['deep'] }).autoEligible).toBe(false)
  })

  it('is never true without a proposed tier', () => {
    const all = autoRules(...RULES.map((r) => r.id))
    expect(map(output(['explore-readonly'], { specification: 'partially' }), { autoFacts: ['deep', 'prior-failures', 'multi-file-edit'] }, all).autoEligible).toBe(false)
    expect(map(output(['explore-readonly'], {}, 0.1), {}, all).autoEligible).toBe(false)
  })
})
