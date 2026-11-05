// Tier assessor hook (parent design.md §3). The interface is owned by @auto-router/core; this file only re-exports
// it so the assessor's shapes cannot drift (see contract.test.ts for the compile-time checks).
import type { Tier } from '@auto-router/core'

export type { AssessorResult, CardContext, DecideExtras, Tier, TierAssessor } from '@auto-router/core'

/** Ascending tier order (same as core's TIERS). */
export const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
