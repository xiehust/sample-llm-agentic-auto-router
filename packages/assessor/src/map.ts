// Deterministic tier mapping (design §7) and auto-eligibility (§8). The model states facts and rule judgements;
// this pure function turns them into a tier or "no opinion". First matching row wins.
import type { Tier } from './contract.ts'
import type { PackRule } from './pack.ts'
import type { Assessment } from './validate.ts'

/** Fact signals that can support a tier on their own; recorded in `basis` as `fact:<name>`. */
export type FactSignal = 'deep' | 'prior-failures' | 'multi-file-edit'
export const FACT_SIGNALS: readonly FactSignal[] = ['deep', 'prior-failures', 'multi-file-edit']

export const DEFAULT_THRESHOLD = 0.8

export type MapOutcome = 'low-confidence' | 'conflict' | 'frontier' | 'standard' | 'fast' | 'fast-unsettled' | 'no-rule'

export interface TierMapping {
  proposedTier?: Tier
  /** Rule ids and `fact:*` signals that support `proposedTier`, or the single no-opinion code. */
  basis: string[]
  outcome: MapOutcome
  /** True only when a tier is proposed and every basis entry is auto-enabled (rule `auto` / `autoFacts`). */
  autoEligible: boolean
}

export interface MapOptions { threshold?: number; autoFacts?: readonly FactSignal[] }

export function mapTier(assessment: Assessment, rules: readonly PackRule[], opts: MapOptions = {}): TierMapping {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const byId = new Map(rules.filter((r) => r.enabled).map((r) => [r.id, r]))
  const matched = assessment.rule_assessments.filter((a) => a.matched && byId.has(a.rule_id)).map((a) => byId.get(a.rule_id) as PackRule)
  const ids = (tier: Tier) => matched.filter((r) => r.tier === tier).map((r) => r.id)
  const mFast = ids('fast')
  const mStd = ids('standard')
  const mFront = ids('frontier')
  const f = assessment.task_facts

  const none = (outcome: MapOutcome, code: string): TierMapping => ({ basis: [code], outcome, autoEligible: false })
  const tier = (t: Tier, basis: string[]): TierMapping => {
    const autoFacts = new Set(opts.autoFacts ?? [])
    const eligible = basis.every((b) => (b.startsWith('fact:') ? autoFacts.has(b.slice(5) as FactSignal) : byId.get(b)?.auto === true))
    return { proposedTier: t, basis, outcome: t, autoEligible: eligible }
  }

  // 1
  if (!(assessment.confidence >= threshold)) return none('low-confidence', 'low-confidence')
  // 2
  if (mFast.length > 0 && mFront.length > 0) return none('conflict', 'conflict:fast+frontier')
  // 3: F
  const fBasis = [...mFront]
  if (f.reasoning_depth === 'deep') fBasis.push('fact:deep')
  if (f.prior_failures >= 2) fBasis.push('fact:prior-failures')
  if (fBasis.length > 0) return tier('frontier', fBasis)
  // 4: S
  const sBasis = [...mStd]
  // A matched fast rule that is fully specified (e.g. "rename X everywhere") is not upgraded by edit breadth alone.
  if (mFast.length === 0 && f.edits_code && (f.scope === 'multi-file' || f.scope === 'cross-module')) sBasis.push('fact:multi-file-edit')
  if (sBasis.length > 0) return tier('standard', sBasis)
  // 5
  if (mFast.length > 0) {
    const settled = f.specification === 'fully-specified' && (f.reasoning_depth === 'lookup' || f.reasoning_depth === 'routine')
    // 6
    return settled ? tier('fast', mFast) : none('fast-unsettled', 'fast-unsettled')
  }
  // 7
  return none('no-rule', 'no-rule')
}
