import { assessorConfig, type AssessorMode } from './assess.ts'
import { decide } from './decide.ts'
import { checkPolicyAgainstCatalog, validatePolicy, type Policy, type Tier } from './policy.ts'
import type { ModelPrice, PriceCatalog } from './pricing-types.ts'
import { record } from './record.ts'
import { summarize } from './summarize/index.ts'
import type { Engine, StateStore, TierAssessor } from './types.ts'

export interface EngineOptions {
  policy: Policy
  catalog: PriceCatalog
  store: StateStore
  /** Clock for record() bookkeeping (lastSeenMs, failure time). decide() uses summary.receivedAt. */
  now?: () => number
  /** C1: pluggable token estimator; default ceil(chars / 4). */
  estimateTokens?: (text: string) => number
  /** Tier assessor hook (parent §3, core design §12). Consulted only when decide() gets `extras.card`. */
  assessor?: TierAssessor
  /** Default 'observe' (consult and audit, never change the decision). */
  assessorMode?: AssessorMode
  /** Hard bound on one consultation. Default 5000 (ASSESSOR_DEFAULTS.timeoutMs); must be > 0. */
  assessorTimeoutMs?: number
  /** Default 0.8; must be in [0, 1]. */
  assessorMinConfidence?: number
  /**
   * Tiers an assessor-driven downgrade may start from (default ['standard']: standard→fast allowed, frontier→*
   * guarded). Upgrades and client hint tiers are unaffected.
   */
  assessorDowngradeFrom?: readonly Tier[]
}

/**
 * Validates the policy (again, idempotent) and cross-checks it against the catalog (throws PolicyError), and
 * validates the assessor options (throws TypeError).
 */
export function createEngine(opts: EngineOptions): Engine {
  const policy = validatePolicy(opts.policy)
  checkPolicyAgainstCatalog(policy, opts.catalog)
  if (policy.sessionTier === 'root' && (typeof opts.store.noteRoot !== 'function' || typeof opts.store.rootLineage !== 'function')) {
    throw new TypeError("createEngine: policy.sessionTier 'root' needs a store with noteRoot() and rootLineage()")
  }
  const catalog: ReadonlyMap<string, ModelPrice> = new Map(opts.catalog.models.map((m) => [m.modelId, m]))
  const now = opts.now ?? Date.now
  const assessor = assessorConfig(opts)
  const ctx = { policy, catalog, store: opts.store, ...(assessor ? { assessor } : {}) }
  const sumOpts = opts.estimateTokens ? { estimateTokens: opts.estimateTokens } : {}
  return {
    summarize: (dialect, body, headers, nowMs) => summarize(dialect, body, headers, nowMs, sumOpts),
    decide: (summary, extras) => decide(ctx, summary, extras),
    record: (summary, decision, outcome) => record(ctx, summary, decision, outcome, now()),
  }
}
