// Core contract types (parent design.md §3, incl. approved additions C1–C5). Owned by @auto-router/core.
import type { Cap } from './cap.ts'
import type { Tier } from './policy.ts'
import type { Dialect, NormalizedUsage } from './pricing-types.ts'

export interface SessionKey { root: string; lineage: string; source: 'header' | 'cooperative' | 'fingerprint' }
export type LastTurn = 'user-text' | 'tool-result' | 'assistant' | 'other'

export interface RequestSummary {
  dialect: Dialect
  requestedModel: string
  session: SessionKey
  lastTurn: LastTurn
  previousResponseId?: string
  nonPortableState: string[]         // e.g. 'anthropic-thinking-signature', 'openai-encrypted-reasoning'
  prefix: { toolsHash: string; systemHash: string; blockHashes: string[]; estPromptTokens: number; messageCount: number }
  hints: { pin?: string; tier?: string; boundary?: 'compaction' | 'subagent-start' | 'task-start'; parentSession?: string; agentId?: string }
  receivedAt: number                 // epoch ms
  /** Follow-up 2026-11-04 (item 5): requested output cap (max_tokens / max_completion_tokens / max_output_tokens). */
  maxOutputTokens?: number
}

export type DecisionPoint =
  | 'pinned' | 'hard-lock-tool-loop' | 'hard-lock-response-chain' | 'hard-lock-state'
  | 'session-start' | 'subagent-start' | 'idle-expired' | 'compaction' | 'user-turn' | 'failover'
  | 'task-start' | 'prefix-reset'    // C2

export interface Decision {
  action: 'initialize' | 'retain' | 'switch' | 'pin'
  model: string                      // concrete Bedrock id to call
  point: DecisionPoint
  reason: string                     // '<code>: <text>'
  policyVersion: string
  mode: 'observe' | 'auto'
  wouldChoose?: string               // observe mode: what auto would have picked
  estimate?: { stayUsd: number; switchUsd: number; horizonCalls: number }
  /** Tier assessor hook (parent §3, 2026-11-04): present only when the assessor was consulted (or its result reused). */
  assessment?: Assessment
  /**
   * Observe mode, alias requests (admin console C3; 0d research §1.6): the model auto would be on for this lineage,
   * carried forward from the last free choice (break point, initialize or switch), and whether it moved on this call.
   */
  projected?: { model: string; switch: boolean }
}

// ---------- tier assessor hook (parent design.md §3, approved 2026-11-04; implementation in @auto-router/assessor) ----------
export interface TierAssessor {
  readonly id: string // e.g. 'assessor/v1@global.openai.gpt-6-luna'
  assess(card: unknown, signal: AbortSignal): Promise<AssessorResult> // card is opaque to core
}

export type AssessorResult =
  | { status: 'ok'; tier?: Tier; confidence: number; audit: Record<string, unknown>; latencyMs: number; costUsd?: number }
  | { status: 'unavailable'; reason: string; latencyMs: number }

/** What core passes into `extras.card(ctx)`: lineage state the caller cannot see. */
export interface CardContext {
  currentModel?: string
  currentTier?: Tier
  parentTier?: Tier
  compactions: number
  lineageKind: 'root' | 'subagent'
}

/**
 * Second argument of Engine.decide. `card` is called lazily, only when core consults the assessor. `cap` is the
 * caller's access cap (admin console 0.16): routing never chooses a model above `cap.maxTier`; a lineage already on
 * one keeps it through hard locks and moves at its next decision point. Pins are the caller's check (pinAllowedByCap).
 */
export interface DecideExtras { card?: (ctx: CardContext) => unknown; cap?: Cap }

/**
 * Outcome of one consultation. 'ok' and 'unavailable' come from the assessor; 'timeout' (assessorTimeoutMs hit,
 * signal aborted), 'error' (assess() or the card thunk threw / rejected) and 'invalid' (malformed result,
 * unknown tier) are set by core. Only 'ok' with a tier and confidence ≥ assessorMinConfidence is an opinion.
 */
export type AssessmentStatus = 'ok' | 'unavailable' | 'timeout' | 'error' | 'invalid'

export interface Assessment {
  assessorId: string
  status: AssessmentStatus
  tier?: Tier
  confidence?: number
  latencyMs: number
  /** True only when the assessor's tier changed the chosen model (assessorMode 'auto'). */
  applied: boolean
  /** The result was reused for the same (lineage, user turn); the assessor was not called again. */
  cached?: true
  /**
   * AssessorResult.costUsd of this consultation (parent §3 amendment, 2026-11-04), for router spend accounting.
   * Only on the decision that actually called the assessor: absent when `cached`, so spend is never counted twice.
   * The assessor's `audit` is deliberately not carried (it can quote untrusted prompt text; the assessor logs it).
   */
  costUsd?: number
  /**
   * The opinion was a downgrade from a tier not in assessorDowngradeFrom, so it was clamped to that tier
   * (auto: the lineage holds its tier; observe: audit only). `applied` is false.
   */
  guard?: 'assessor-downgrade-guarded'
}

/** SessionState.assessed: the last consultation of the lineage, keyed by user turn (see core design §12). */
export interface AssessedTurn {
  turnKey: string
  assessorId: string
  status: AssessmentStatus
  tier?: Tier
  confidence?: number
  latencyMs: number
  /** Spend of the consultation that produced this record (reported once, on the uncached decision). */
  costUsd?: number
}

/** One cached prefix on a model: the chain hash it ends at, its cached tokens and its last touch (write or read). */
export interface PrefixRecord { hash: string; tokens: number; touchMs: number }

export interface CacheState {
  model: string
  /** Most recent record (compat): equals prefixes[0] when `prefixes` is present. */
  cachedPrefixHash?: string
  cachedTokens: number
  /** Latest touch over all records, so `lastTouchMs + ttlMs` is when the whole entry goes cold. */
  lastTouchMs: number
  ttlMs: number
  /**
   * Follow-up 2026-11-04 (item 4): up to 4 records, most recently touched first. Absent ⇒ one record built
   * from cachedPrefixHash / cachedTokens / lastTouchMs.
   */
  prefixes?: PrefixRecord[]
}

export type MissReason = 'model_changed' | 'ttl_expired' | 'prefix_changed' | 'unknown'
export interface MissAttribution { reason: MissReason; expectedTokens: number; readTokens: number }

/** C4: what record() learned. */
export interface RecordResult {
  miss?: MissAttribution
  /** The gateway (or a fallback) served a different model than the decision named. */
  servedDiffers?: true
  /**
   * The lineage moved off `model` on this call (status < 400). `warmTokens` = the prefix tokens still warm on `model`
   * at receivedAt, i.e. what the lineage would have read had it stayed (cold-cache switch penalty, 0d research §1.2).
   */
  switchedFrom?: { model: string; warmTokens: number }
  /** Follow-up 2026-11-04 (item 3): previous_response_id arrived without router state (reason code chain-state-missing). */
  chainStateMissing?: true
}

export interface SessionState {
  key: SessionKey
  current?: string
  perModel: Record<string, CacheState>
  turns: number
  switches: number
  lastSeenMs: number
  lastPrefixHash?: string
  // C5 (optional so replay fixtures stay valid)
  calls?: number
  lastSwitchTurn?: number
  costSwitches?: number
  lastFailure?: { model: string; status: number; atMs: number }
  lastMiss?: MissAttribution & { atMs: number }
  // Follow-up 2026-11-04 (optional, backward compatible)
  /** Item 1: model/profile id → atMs of its last 429/5xx; pruned to failover.windowMs, bounded by the pool size. */
  failures?: Record<string, number>
  /** Model/profile id → status of its last 429/5xx (same keys as `failures`, pruned with it). Profile rotation is
   * decided from the failed model's own status; a missing entry (legacy state) rotates. */
  failureStatus?: Record<string, number>
  /** Item 5: the lineage was moved off `from` because of the context gate; cleared on 'gate-recover'. */
  gateForced?: { from: string; atMs: number }
  /** Item 6: set when the lineage is created ('subagent' iff it started at a subagent-start point). */
  kind?: 'root' | 'subagent'
  // Tier assessor hook (2026-11-04, optional)
  /** Compaction break points recorded on the lineage (CardContext.compactions). */
  compactions?: number
  /** Last assessor consultation, reused by decide() for the same user turn (any engine on the store). */
  assessed?: AssessedTurn
  /** Observe mode: Decision.projected.model of the last observe decision (cleared by an auto decision). */
  projected?: string
}

export interface StateStore {
  get(lineage: string): Promise<SessionState | undefined>
  put(state: SessionState): Promise<void>
  /**
   * Follow-up 2026-11-04 (item 2), optional: records (root, lineage). The answer must be stable per (root,
   * lineage): `rootSeen` = the root already had another lineage when this lineage was first noted;
   * `lineageSeen` = this lineage was noted before. decide() calls it only when the lineage has no state, which
   * includes retries and concurrent first calls; `rootSeen && root !== lineage` ⇒ 'subagent-start'.
   */
  noteRoot?(root: string, lineage: string): Promise<{ rootSeen: boolean; lineageSeen: boolean }>
  /**
   * Tier assessor hook (2026-11-04), optional and read-only: the first lineage noted under `root` (the parent of
   * the root's sub-agents), or undefined when unknown. decide() uses it only for CardContext.parentTier.
   */
  rootLineage?(root: string): Promise<string | undefined>
}

export interface RecordOutcome { servedModel: string; status: number; usage?: NormalizedUsage; responseId?: string }

export interface Engine {
  summarize(dialect: Dialect, body: unknown, headers: Record<string, string | undefined>, nowMs: number): RequestSummary
  decide(summary: RequestSummary, extras?: DecideExtras): Promise<Decision>
  record(summary: RequestSummary, decision: Decision, outcome: RecordOutcome): Promise<RecordResult>
}
