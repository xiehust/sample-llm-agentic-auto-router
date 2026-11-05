// Single import point for the sibling packages (both real since integration on 2026-11-04).
export type { CacheTtl, CostBreakdown, Dialect, ModelPrice, NormalizedUsage, PriceCatalog } from '@auto-router/pricing'
export { costOf, findModel, loadCatalog, validateCatalog } from '@auto-router/pricing'

export type { Decision, DecisionPoint, Engine, LastTurn, Policy, RequestSummary, SessionState, StateStore } from '@auto-router/core'
export { createEngine, InMemoryStateStore, policyPresets } from '@auto-router/core'
/** Kept for report notes; true only while a stub engine was used. */
export const CORE_IS_STUB = false
