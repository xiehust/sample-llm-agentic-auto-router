// @auto-router/core public API (parent design.md §3 + core design.md §8).
export type {
  AssessedTurn, Assessment, AssessmentStatus, AssessorResult, CacheState, CardContext, Decision, DecideExtras, DecisionPoint, Engine,
  LastTurn, MissAttribution, MissReason, PrefixRecord, RecordOutcome, RecordResult, RequestSummary, SessionKey, SessionState, StateStore,
  TierAssessor,
} from './types.ts'
export { ASSESSOR_DEFAULTS, type AssessorMode } from './assess.ts'
export type { LineageKind, Policy, PolicyInput, PolicyRule, PoolEntry, Portability, Tier } from './policy.ts'
export { checkPolicyAgainstCatalog, DEFAULT_ALIASES, DEFAULT_PORTABILITY, POLICY_DEFAULTS, PolicyError, RETRYABLE_STATUS, validatePolicy } from './policy.ts'
export { createEngine, type EngineOptions } from './engine.ts'
export { NoEligibleModelError } from './decide.ts'
export { InMemoryStateStore } from './store-memory.ts'
export { templateFamilyOf } from './summarize/index.ts'
export { defaultEstimateTokens } from './summarize/tokens.ts'
export { estimateCost, type CostEstimate, type CostInput } from './cost.ts'
export { policyPresets } from './presets.ts'
