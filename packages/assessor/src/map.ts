// Deterministic tier mapping (design §7) and auto-eligibility (§8). The model states facts and rule judgements;
// this pure function turns them into a tier or "no opinion". First matching row wins.
import type { Tier } from './contract.ts'
import type { PackRule } from './pack.ts'
import type { Assessment, TaskFacts } from './validate.ts'

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

/**
 * Pack-level mapping parameters (pack.json `mapping`, optional). A pack without the block maps exactly as
 * DEFAULT_MAPPING, which is the mapping every pack used before the block existed (v1, v2, v2.1).
 */
export interface PackMapping {
  /** Fact signals that support frontier on their own (rule 3). */
  frontierFacts: ReadonlyArray<'deep' | 'prior-failures'>
  /** `prior-failures` fires at this many prior failures or more. */
  priorFailuresMin: number
  /** Fact signals that support standard on their own (rule 4). */
  standardFacts: ReadonlyArray<'multi-file-edit'>
  /** A matched fast rule settles as fast only with one of these specifications and reasoning depths (rule 5). */
  fastSpecifications: ReadonlyArray<TaskFacts['specification']>
  fastDepths: ReadonlyArray<TaskFacts['reasoning_depth']>
  /** A settled fast rule match wins over standard rules and standard facts (default false: standard wins). */
  fastBeatsStandard: boolean
}

export const DEFAULT_MAPPING: Readonly<PackMapping> = Object.freeze<PackMapping>({
  frontierFacts: ['deep', 'prior-failures'],
  priorFailuresMin: 2,
  standardFacts: ['multi-file-edit'],
  fastSpecifications: ['fully-specified'],
  fastDepths: ['lookup', 'routine'],
  fastBeatsStandard: false,
})

export interface MapOptions { threshold?: number; autoFacts?: readonly FactSignal[]; mapping?: Readonly<PackMapping> }

export function mapTier(assessment: Assessment, rules: readonly PackRule[], opts: MapOptions = {}): TierMapping {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const byId = new Map(rules.filter((r) => r.enabled).map((r) => [r.id, r]))
  const matched = assessment.rule_assessments.filter((a) => a.matched && byId.has(a.rule_id)).map((a) => byId.get(a.rule_id) as PackRule)
  const ids = (tier: Tier) => matched.filter((r) => r.tier === tier).map((r) => r.id)
  const mFast = ids('fast')
  const mStd = ids('standard')
  const mFront = ids('frontier')
  const f = assessment.task_facts
  const mp = opts.mapping ?? DEFAULT_MAPPING

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
  if (mp.frontierFacts.includes('deep') && f.reasoning_depth === 'deep') fBasis.push('fact:deep')
  if (mp.frontierFacts.includes('prior-failures') && f.prior_failures >= mp.priorFailuresMin) fBasis.push('fact:prior-failures')
  if (fBasis.length > 0) return tier('frontier', fBasis)
  const settled = mFast.length > 0 && mp.fastSpecifications.includes(f.specification) && mp.fastDepths.includes(f.reasoning_depth)
  // 3b (pack mapping only): a settled fast match outranks standard
  if (mp.fastBeatsStandard && settled) return tier('fast', mFast)
  // 4: S
  const sBasis = [...mStd]
  // A matched fast rule that is fully specified (e.g. "rename X everywhere") is not upgraded by edit breadth alone.
  if (mp.standardFacts.includes('multi-file-edit') && mFast.length === 0 && f.edits_code && (f.scope === 'multi-file' || f.scope === 'cross-module')) {
    sBasis.push('fact:multi-file-edit')
  }
  if (sBasis.length > 0) return tier('standard', sBasis)
  // 5
  if (mFast.length > 0) {
    // 6
    return settled ? tier('fast', mFast) : none('fast-unsettled', 'fast-unsettled')
  }
  // 7
  return none('no-rule', 'no-rule')
}
