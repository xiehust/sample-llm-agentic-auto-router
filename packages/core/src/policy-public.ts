// `@auto-router/core/policy`: the browser-safe subset of core (admin console design 0.6/C3). Policy and cap
// validation, tier helpers and decision-reason parsing, with no node: built-ins in the import graph
// (policy-public.test.ts checks it). The console SPA and Lambdas import this; the router imports `@auto-router/core`.
export type { LineageKind, Policy, PolicyInput, PolicyRule, PoolEntry, Portability, Tier } from './policy.ts'
export { checkPolicyAgainstCatalog, DEFAULT_ALIASES, DEFAULT_PORTABILITY, DIALECTS, POLICY_DEFAULTS, PolicyError, RETRYABLE_STATUS, tierRank, TIERS, validatePolicy } from './policy.ts'
export { pinAllowedByCap, tierWithinCap, validateCap, type Cap } from './cap.ts'
export { modelForTier, tierOfPoolModel } from './tiers.ts'
export { TTL_MS, writeTtlFor } from './warmth.ts'
export { parseReason, type ParsedReason, type ReasonPrefix } from './reason.ts'
export { policySwapEffects, type SwapEffect, type SwapSeverity } from './swap-effects.ts'
