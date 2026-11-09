// Inputs (router log lines, design v1 §2.2) and the ports the ingest core needs. No AWS types here: the adapters in
// dynamo.ts / s3.ts implement the ports, tests use in-memory fakes.
import type { Policy, Tier } from '@auto-router/core'
import type { CostBreakdown, Dialect, NormalizedUsage } from '@auto-router/pricing'

export interface Principal {
  kind: 'user' | 'client' | 'none'
  id?: string
  group?: string
  client?: string
  reason?: string
}

export interface DecisionLine {
  action: string
  point: string
  mode: 'observe' | 'auto'
  model: string
  reason: string
  policyVersion: string
  wouldChoose?: string
  estimate?: Record<string, number>
  projected?: { model: string; switch: boolean }
}

export interface AssessorLine {
  id?: string
  mode?: string
  autoRules?: string
  status?: string
  tier?: Tier
  proposedTier?: Tier
  confidence?: number
  basis?: string[]
  outcome?: string
  latencyMs?: number
  costUsd?: number
  called?: boolean
  applied?: boolean
  cached?: boolean
  guard?: string
  packVersion?: string
}

/** A request line: `kind` model | error | rejected (router account.ts RequestLog, plus the C2/C3 additions). */
export interface RouterLine {
  schemaVersion?: number
  ts: string
  reqId: string
  kind: 'model' | 'error' | 'rejected'
  status: number
  dialect?: Dialect
  requested?: string
  lineage?: string
  session?: string
  principal?: Principal
  identity?: string
  configVersion?: string
  catalogVersion?: string
  decision?: DecisionLine
  servedModel?: string
  stream?: boolean
  usage?: NormalizedUsage
  costUsd?: CostBreakdown
  /** design 0.3c: no usage event at all; `costBoundUsd` is an approximate upper bound, never spend. */
  usageMissing?: boolean
  costBoundUsd?: number
  boundPartial?: boolean
  hitRate?: number
  miss?: { reason?: string; expectedTokens?: number; readTokens?: number }
  hints?: string[]
  sanitized?: string[]
  requestedLength?: number
  bodyBytes?: number
  bodyReadMs?: number
  betaVeto?: string
  failover?: { from: string; to: string; status: number | string }
  switchedFrom?: { model: string; warmTokens: number }
  assessor?: AssessorLine
  error?: string
  reason?: string
  overheadMs?: number
  decideMs?: number
  upstreamTtfbMs?: number
  durationMs?: number
  clientAborted?: boolean
}

/**
 * `kind: "config"` (router runtime.ts): one per boot, activation, rejection, ignored/absent/error event of the config
 * document or the principal file; `source` boot | config | principals, and a3's identity watches jwks | blocks |
 * budget-blocks (any source string is accepted). Extra keys are C2/C4 lineFields (blocks etag, packs, drift) and event details
 * (code, origin, principals); ingest passes them through, bounded.
 */
export interface ConfigLine {
  kind: 'config'
  ts: string
  source?: string
  outcome?: string
  attempted?: string
  from?: string
  configVersion?: string
  principalsVersion?: string
  policyVersion?: string
  mode?: string
  catalogVersion?: string
  issues?: string[]
  warnings?: string[]
  [extra: string]: unknown
}

/** A stored item: plain JSON values only (the adapter marshals them). */
export type Item = Record<string, unknown>

export interface ItemKey { pk: string; sk: string }

export interface TxPut { item: Item & ItemKey }
/** ADD `add` counters; SET `set` attributes (last writer wins); `ttl` set once (if_not_exists). */
export interface TxAdd { key: ItemKey; add: Record<string, number>; ttl: number; set?: Record<string, string> }

/** `duplicates`: indexes into `puts` whose item already existed (the request was ingested before). */
export type TxOutcome = { ok: true } | { ok: false; duplicates: number[]; retryable: boolean }

export interface UsageStore {
  /** One atomic write: every put is conditional on the item not existing; every add is an ADD of counters. */
  transact(puts: TxPut[], adds: TxAdd[]): Promise<TxOutcome>
  /** Counter items by key (missing items are absent from the map), keyed by `pk|sk`. */
  getCounters(keys: ItemKey[]): Promise<Map<string, Record<string, number>>>
  /** Puts a latest-only item (string `ts`) unless the stored one has the same or a later `ts`: a late or re-delivered
   * line never rolls it back. */
  putLatest(item: Item & ItemKey & { ts: string }): Promise<'written' | 'stale'>
}

/** The configuration document a line ran under, reduced to what ingest needs. */
export interface ResolvedConfig {
  policy: Policy
  /** The document's assessor threshold (shown with a record's assessor detail). */
  assessorThreshold?: number
}

/** Resolves the configuration a line was decided under: by `configVersion` (deployed), or by policy version (tests). */
export interface PolicySource {
  get(configVersion: string | undefined, policyVersion: string): Promise<ResolvedConfig | undefined>
}

/** Budget settings as the console stores them (`console` table, MEMBER#<kind:id> and MEMBER#default). */
export interface BudgetSetting {
  /** Monthly list-price limit in USD; null = explicitly no budget (overrides the default). */
  monthlyUsd?: number | null
  hardStop?: boolean
}

export interface BudgetSource {
  get(principals: string[]): Promise<{ members: Map<string, BudgetSetting>; fallback?: BudgetSetting }>
}

export interface BudgetBlock {
  kind: 'user' | 'client'
  id: string
  reason: 'budget'
  month: string
  at: string
  spentUsd: number
  limitUsd: number
}

/** `identity/budget-blocks.json`: same top-level shape as `identity/blocks.json` (a3 §2), plus `month` per entry. */
export interface BudgetBlocksDoc {
  schemaVersion: 1
  generatedAt: string
  principals: BudgetBlock[]
}

export interface BlocksStore {
  read(): Promise<{ doc: BudgetBlocksDoc; etag: string } | undefined>
  /** Conditional write: `etag` given → If-Match, absent → If-None-Match "*". 'conflict' when the condition failed. */
  write(doc: BudgetBlocksDoc, etag: string | undefined): Promise<'ok' | 'conflict'>
}
