// Console API contract (admin-console design v1 §2.4). Types only: console-api (handlers) and console-web (SPA and its
// mock API) both implement these shapes. Every route answers JSON; errors are ApiErrorBody with a stable code.
//
// Conventions
// - Money is list-price USD as a JSON number, unrounded (the API may round to 6 decimals). Never an invoice amount.
// - Days are UTC calendar days 'YYYY-MM-DD'; timestamps are ISO 8601 UTC strings.
// - A principal key is 'user:<sub>', 'client:<clientId>' or 'none' (unattributed). Members never receive another
//   principal's key, name or totals: /api/me/* derives the principal from the verified token.
// - No prompt, card or output text exists in any response. Ids, codes and numbers only (plus admin-visible
//   member names and e-mail addresses resolved from Cognito by the console API).

export type Tier = 'fast' | 'standard' | 'frontier'
export type Dialect = 'anthropic-messages' | 'openai-chat' | 'openai-responses'
export type CacheTtl = '5m' | '30m' | '1h' | '12h'
export type Role = 'admin' | 'member'
export type RouterMode = 'observe' | 'auto'
export type IdentityMode = 'off' | 'observe' | 'require'
export type PrincipalKind = 'user' | 'client' | 'none'
/** 'user:<sub>' | 'client:<clientId>' | 'none' */
export type PrincipalKey = string
export type StatusClass = '2xx' | '4xx' | '5xx' | '499'
export type Baseline = 'static' | 'standard' | 'frontier' | 'observe-default'
export type DecisionAction = 'initialize' | 'retain' | 'switch' | 'pin'
export type DecisionPoint =
  | 'pinned' | 'hard-lock-tool-loop' | 'hard-lock-response-chain' | 'hard-lock-state'
  | 'session-start' | 'subagent-start' | 'idle-expired' | 'compaction' | 'user-turn' | 'failover'
  | 'task-start' | 'prefix-reset'
export type MissReason = 'model_changed' | 'ttl_expired' | 'prefix_changed' | 'unknown'
export type AssessmentStatus = 'ok' | 'unavailable' | 'timeout' | 'error' | 'invalid'
export type RecordKind = 'model' | 'rejected' | 'error'

// ---------------------------------------------------------------------------------------------------- errors

export interface ApiErrorBody {
  error: {
    code: ErrorCode | (string & {})
    /** English developer text; the UI shows its own copy for known codes. */
    message: string
    /** The console API request id (for support), not a router reqId. */
    requestId?: string
    /** validation-failed: the issues; the UI lists them. */
    issues?: ValidationIssue[]
    /** A machine reason for some codes; identity-keys-not-loaded: an IdentityKeysReason. */
    reason?: string
  }
}

/** Stable error codes. Adding a code is compatible; renaming one is not. */
export type ErrorCode =
  | 'unauthorized'            // 401: missing / invalid token (normally the JWT authorizer answers first)
  | 'forbidden'               // 403: valid token, route needs another group
  | 'not-found'               // 404: also for another principal's reqId or session (ids cannot be probed)
  | 'bad-request'             // 400: malformed query or body
  | 'validation-failed'       // 422: config or settings document invalid (issues[])
  | 'config-version-moved'    // 409: optimistic lock: someone activated another version first
  | 'disruptive-unconfirmed'  // 409: activation moves sessions and confirmDisruptive was not set
  | 'outside-universe'        // 422: a model outside the deployment's allowed model universe
  | 'email-exists'            // 409
  | 'invite-failed'           // 502: Cognito refused (message carries the Cognito error code)
  | 'cannot-disable-self'     // 409
  | 'last-admin'              // 409: would leave no admin
  | 'not-disabled'            // 409: delete needs a disabled member / client
  | 'gateway-unavailable'     // 502: AgentCore control API error
  | 'metrics-unavailable'     // 502: CloudWatch error
  | 'delivery-failed'         // 502: writing config/active.json to S3 failed; admin.config.redeliver repeats it
  | 'identity-delivery-failed' // 502: writing identity/blocks.json or principals.json failed; admin.identity.republish
  | 'rate-limited'            // 429
  | 'internal'                // 500
  | 'identity-keys-not-loaded' // 422: identity require refused until every running task reports its signing keys (reason: IdentityKeysReason)
  | 'config-unavailable'      // 503: no active console version and config/baked.json unreadable, or ACTIVE names a missing version

export interface ValidationIssue {
  /** JSON pointer into the submitted document ('/policy/pools/openai-chat/models/0/model'), '' for the root. */
  path: string
  /** Validator text, English, shown verbatim as "Router detail". */
  message: string
  code?: 'schema' | 'catalog' | 'universe' | 'assessor' | 'access' | 'identity'
  /** The validator's specific code (e.g. validateAssessorSettings 'pack-version-drift'). */
  rule?: string
}

// ---------------------------------------------------------------------------------------------------- shared shapes

export interface CatalogRef { region: string; version: string }

export interface TokenClasses {
  uncached: number
  cacheRead: number
  cacheWrite: Partial<Record<CacheTtl, number>>
  output: number
  /** Of which reasoning (already inside output). */
  reasoning: number
}

export interface CostClasses { input: number; cacheRead: number; cacheWrite: number; output: number; total: number }

/** Per-principal tier limit (design 0.16). */
export interface Cap { maxTier?: Tier; allowPins?: string[] }

/** Spend against a budget = ΣA + ΣX (actual plus assessor cost) for the UTC month (design §2.3a). */
export interface Budget {
  monthlyUsd: number
  /** Soft alert at this fraction of monthlyUsd (0..1). */
  alertAt: number
  /** Router answers 429 budget-exceeded above the budget (bound: ingest delay + 30 s). */
  hardStop: boolean
}

export interface BudgetStatus extends Budget { spentUsd: number; month: string }

/** Admin views only: how a principal is shown. Members only ever see themselves ('You'). */
export interface CallerRef {
  key: PrincipalKey
  kind: PrincipalKind
  name?: string
  email?: string
  /** The member or client was deleted; records remain. */
  deleted?: true
}

export interface Page<T> { items: T[]; nextCursor?: string }

/** Whether the latest S3 object reached the router's bucket (config/active.json or identity/*.json, design §2.3a). */
export type DeliveryState = 'delivered' | 'pending' | 'notDelivered'
export interface Delivery { state: DeliveryState; at?: string; errorCode?: string }

/** Common range query: UTC days, inclusive. */
export interface DayRange { from: string; to: string }

// ---------------------------------------------------------------------------------------------------- /api/me/profile

// ---------------------------------------------------------------------------------------------------- effective config
// 0d-effective-config.md: per section, effective = active document ?? baked (config/baked.json). Never a guessed
// default: when the baked document cannot be read, a baked-sourced value is 'unknown' (value absent).

export type ConfigSectionName = 'policy' | 'identity' | 'assessor' | 'access'
export type SettingSource = 'document' | 'baked' | 'unknown'
/** One effective setting. `version`: the config version for 'document', the baked version ("0-baked.<sha8>") for 'baked'. */
export interface EffectiveSetting<T> { value?: T; source: SettingSource; version?: string }
export interface EffectiveSettings {
  identityMode: EffectiveSetting<IdentityMode>
  routerMode: EffectiveSetting<RouterMode>
  policyVersion: EffectiveSetting<string>
  assessorMode: EffectiveSetting<'off' | 'observe' | 'auto'>
  assessorPack: EffectiveSetting<string>
  assessorModel: EffectiveSetting<string>
}
/** The latest router `kind:"config"` line of one task: what it really runs (0d §3). */
export interface ReportedConfig {
  task: string
  at: string
  configVersion?: string
  effective?: { identityMode?: string; assessorMode?: string; policyVersion?: string; mode?: string }
  sources?: Partial<Record<ConfigSectionName, 'document' | 'baked'>>
  /** Every reported value equals the configured one; absent when not comparable (configured value unknown). */
  matches?: boolean
}

/** Why identity keys do not count as loaded, in this order: no state line ≤ 15 min; fewer reporting than running tasks
 * (or the running count unreadable); a task without identity configured; a task with identity but no keys loaded. */
export type IdentityKeysReason = 'no-fresh-task' | 'partial' | 'not-configured' | 'task-without-keys'
export interface IdentityKeysState {
  loaded: boolean
  /** Absent when loaded. */
  reason?: IdentityKeysReason
  /** Tasks with a state line in the last 15 min. */
  fresh: number
  /** ECS runningCount of the router service (absent when it could not be read). */
  running?: number
  /** Fresh tasks reporting identityKeys configured and loaded. */
  withKeys: number
  /** The first offending fresh task (not-configured / task-without-keys). */
  task?: string
}

export interface DeploymentInfo {
  prefix: string
  region: string
  /** Effective router mode ('unknown' when the baked document is unreadable and no document sets it). */
  mode: RouterMode | 'unknown'
  /** Effective identity mode; never a guessed 'off' (0d-effective-config). */
  identityMode: IdentityMode | 'unknown'
  /** Always set by console-api (optional until the mock API fills it). */
  effective?: EffectiveSettings
  catalog: CatalogRef
  retentionDays: number
  rollupDays: number
  defaultBaseline: Baseline
  /** Ingest lag behind the router; the UI shows "data delayed" above 300 s. */
  ingestLagSeconds?: number
  /** Latest record time ingested ("Records up to …"). */
  dataAsOf?: string
}

export interface Profile {
  principal: PrincipalKey
  username: string
  name?: string
  email?: string
  role: Role
  /** Raw Cognito groups from the token (admin, member). */
  groups: string[]
  budget?: BudgetStatus
  tierLimit?: Cap
  /** First request ever attributed to this caller; absent → first sign-in lands on Get started. */
  firstRequestAt?: string
  deployment: DeploymentInfo
}

// ---------------------------------------------------------------------------------------------------- usage

export type UsageDimension = 'model' | 'tier' | 'dialect' | 'day' | 'caller'

/** Query of GET /api/me/usage and /api/admin/usage. 'caller' dimension and filter: admin only (else 400). */
export interface UsageQuery extends DayRange {
  groupBy?: UsageDimension                // default 'model'
  /** Daily chart series dimension. */
  stackBy?: Exclude<UsageDimension, 'day'> // default 'model'
  caller?: PrincipalKey[]
  model?: string[]
  tier?: Tier[]
  dialect?: Dialect[]
  status?: StatusClass[]
}

export interface UsageRow {
  key: string
  /** Admin, caller dimension: display data for key. */
  caller?: CallerRef
  requests: number
  errors: number
  tokens: TokenClasses
  cost: CostClasses
  /** cache read ÷ prompt tokens; absent when no prompt tokens. */
  hitRate?: number
  longContextRequests: number
  unmetered: Unmetered
}

/** Calls whose stream ended before usage arrived: never part of cost (4f §1.3). */
export interface Unmetered { count: number; upperBoundUsd: number; partial: boolean }

export interface DailyPoint { day: string; series: string; costUsd: number; tokens: TokenClasses }

export interface UsageReport {
  range: DayRange
  catalog: CatalogRef
  groupBy: UsageDimension
  stackBy: Exclude<UsageDimension, 'day'>
  rows: UsageRow[]
  totals: UsageRow
  daily: DailyPoint[]
  /** Admin, caller dimension: display data for every caller key in rows/daily. */
  callers?: CallerRef[]
  dataAsOf?: string
}

// ---------------------------------------------------------------------------------------------------- savings
// GET /api/me/usage?view=savings and /api/admin/usage?view=savings (same route, design §2.4). Figures per 0d §1.

export interface SavingsQuery extends DayRange {
  view: 'savings'
  baseline?: Baseline       // default: deployment default
  groupBy?: Exclude<UsageDimension, 'tier' | 'day'>
  caller?: PrincipalKey[]
  dialect?: Dialect[]
}

export interface SavingsFigures {
  requests: number
  /** Actual list-price spend ΣA. */
  A: number
  /** Baseline ΣB_K. */
  B: number
  /** Routing effect ΣR = B − A*. */
  R: number
  /** Switch penalty ΣS = A − A* on routing switches. */
  S: number
  /** Assessor overhead ΣX. */
  X: number
  /** Net saving ΣN = B − A − X = R − S − X (signed). */
  N: number
  /** N ÷ B; absent when B = 0. */
  rate?: number
}

export interface SavingsRow extends SavingsFigures { key: string; caller?: CallerRef }

export interface TierMatrixCell { from: Tier; to: Tier; n: number; R: number }

export interface SavingsBlock {
  kpis: SavingsFigures
  matrix: TierMatrixCell[]
  daily: Array<{ day: string; N: number }>
  rows: SavingsRow[]
}

export interface SavingsReport extends SavingsBlock {
  range: DayRange
  catalog: CatalogRef
  baseline: Baseline
  mode: RouterMode
  /** Prompt-cache saving ΣCnet (separate KPI, not a routing effect). */
  promptCacheSaving: number
  /** A − A* on non-routing switches (failover, policy-forced, client). Informational; not in N. */
  otherColdCost: number
  /** Requests a tier limit forced down (design 0.16): not a routing saving. */
  capped: { requests: number; A: number; B: number }
  unmetered: Unmetered
  /** Observe mode only: repricing at decision.projected (indicative). */
  projected?: SavingsBlock & { differing: number }
  callers?: CallerRef[]
}

// ---------------------------------------------------------------------------------------------------- records

export interface RecordQuery {
  /** ISO timestamps (inclusive from, exclusive to). */
  from: string
  to: string
  caller?: PrincipalKey[]   // admin only
  session?: string
  dialect?: Dialect[]
  action?: DecisionAction[]
  point?: DecisionPoint[]
  model?: string[]
  tier?: Tier[]
  status?: StatusClass[]
  mode?: RouterMode
  assessor?: boolean
  failover?: boolean
  /** 'any' or a reason. */
  miss?: MissReason | 'any'
  wouldChooseDiffers?: boolean
  cursor?: string
  limit?: number            // default 50, max 200
}

/** One row of the Decisions list and the session timeline. */
export interface RecordSummary {
  ts: string
  reqId: string
  kind: RecordKind
  status: number
  caller?: CallerRef        // admin only
  session?: string
  lineage?: string
  dialect?: Dialect
  /** Known alias or model id, else 'other'. */
  requested?: string
  action?: DecisionAction
  point?: DecisionPoint
  mode?: RouterMode
  servedModel?: string
  tier?: Tier
  wouldChoose?: string
  promptTokens?: number
  outputTokens?: number
  costUsd?: number
  hitRate?: number
  /** Request-level error code ('identity-blocked', 'budget-exceeded', 'access-cap', 'pin-not-allowed', …). */
  errorCode?: string
  flags: {
    failover?: true
    miss?: MissReason
    assessor?: Tier | 'no-opinion'
    hint?: true
    aborted?: true
    unmetered?: true
    capped?: true
    switch?: true
  }
  /** Cache bar: read / write / uncached tokens. */
  bar?: { read: number; write: number; uncached: number }
}

/**
 * Query of GET …/records/{reqId}: both optional hints from the list row. A record whose ts or owner differs answers
 * 404, like an unknown one. `caller` is admin only (a member's own principal comes from the token).
 */
export interface RecordLookup { ts?: string; caller?: PrincipalKey }

export interface AssessorRecord {
  id: string
  mode: RouterMode
  autoRules: 'pack' | 'all'
  status: AssessmentStatus
  packVersion?: string
  tier?: Tier
  proposedTier?: Tier
  confidence?: number
  threshold?: number
  basis?: string[]
  outcome?: string
  latencyMs: number
  costUsd?: number
  called?: boolean
  applied: boolean
  cached?: true
  guard?: string
}

/** Full stored record (GET …/records/{reqId}): the router log line's fields plus ingest additions. */
export interface RecordDetail extends RecordSummary {
  identity?: 'verified' | 'missing' | `invalid:${string}`
  requestedLength?: number
  stream?: boolean
  bodyBytes?: number
  hints?: string[]
  sanitized?: string[]
  clientAborted?: boolean
  decision?: {
    action: DecisionAction
    point: DecisionPoint
    mode: RouterMode
    model: string
    /** Raw '<code>: <text>' (router detail, untranslated). */
    reason: string
    /** parseReason output stored by ingest (73 §3.1). */
    code?: string
    variant?: string
    source?: string
    reasonFlags?: string[]
    policyVersion: string
    wouldChoose?: string
    projected?: { model: string; switch: boolean }
    estimate?: { stayUsd: number; switchUsd: number; horizonCalls: number }
  }
  configVersion?: string
  catalogVersion?: string
  servedDiffers?: true
  switchedFrom?: { model: string; warmTokens: number }
  failoverDetail?: { from: string; to: string; status: number | string }
  tierLimit?: { from: string; to: string; maxTier?: Tier }
  usage?: {
    uncachedInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: Partial<Record<CacheTtl, number>>
    outputTokens: number
    reasoningTokens?: number
    promptTokens: number
  }
  cost?: CostClasses & { tier: 'base' | 'long' }
  unmeteredBound?: { upperBoundUsd: number; partial: boolean }
  missDetail?: { reason: MissReason; expectedTokens: number; readTokens: number }
  assessorDetail?: AssessorRecord
  timing?: { bodyReadMs?: number; decideMs?: number; overheadMs?: number; upstreamTtfbMs?: number; durationMs?: number }
}

/** kind is derived from the lineage's first decision point when known (design §2.3a), else absent. */
export interface SessionLineage { lineage: string; kind?: 'root' | 'subagent'; requests: number }

export interface SessionDetail {
  session: string
  caller?: CallerRef
  first: string
  last: string
  requests: number
  lineages: SessionLineage[]
  models: string[]
  switches: number
  misses: number
  failovers: number
  costUsd: number
  hitRate?: number
  /** Last request within the live window: new requests appear after the ingest delay. */
  live: boolean
  items: RecordSummary[]
}

export interface LatestResponse {
  /** The caller's latest request in the last 10 minutes. */
  record?: Pick<RecordSummary, 'ts' | 'reqId' | 'dialect' | 'requested' | 'servedModel' | 'status' | 'errorCode'>
}

// ---------------------------------------------------------------------------------------------------- /api/me/setup

export interface PoolView { dialect: Dialect; defaultTier: Tier; tiers: Array<{ tier: Tier; models: string[] }> }

/** `llmar configure --from` input (17's tools/llmar KEYS). No secrets: the cli client is public. */
export interface ConfigureJson {
  schemaVersion: 1
  region?: string
  cognitoDomain: string
  /** Explicit endpoints; llmar derives them from cognitoDomain when absent. */
  authorizeEndpoint?: string
  tokenEndpoint?: string
  revokeEndpoint?: string
  clientId: string
  scope: string
  /** 1–10 registered ports (1024–65535). */
  redirectPorts: number[]
  codexOauthPort?: number
  gatewayUrl?: string
  /** Header the identity token rides in (default x-api-key; null: none). */
  identityHeader?: string | null
  refreshDays?: number
}

export interface SetupInfo {
  gatewayUrl?: string
  inferenceUrl?: string
  cognitoDomain?: string
  tokenEndpoint?: string
  authorizeEndpoint?: string
  /** The public `cli` app client (no secret). */
  clientId?: string
  scope?: string
  /** Registered loopback callback ports of the `cli` client (http://127.0.0.1:<port>/callback). */
  redirectPorts?: number[]
  codexOauthPort?: number
  /** The non-secret block for `llmar configure --from '<json>'` (17 §3, 4f §6.3). */
  configureJson?: ConfigureJson
  mode: RouterMode | 'unknown'
  identityMode: IdentityMode | 'unknown'
  /** Always set by console-api (optional until the mock API fills it). */
  effective?: EffectiveSettings
  observeDefaults: Partial<Record<Dialect, string>>
  aliases: Record<string, Tier | 'default'>
  /** Filtered to the caller's tier limit. */
  pools: PoolView[]
  tierLimit?: Cap
  budget?: BudgetStatus
  refreshDays: number
  /** Request headers the gateway forwards (README "Endpoints and headers", incl. x-api-key). */
  forwardedHeaders?: string[]
  /** Names of values the deployment is missing (admin sees them; member sees a generic message). */
  missing?: string[]
}

// ---------------------------------------------------------------------------------------------------- members

export type MemberStatus = 'active' | 'invited' | 'disabled'

export interface Member {
  id: string                // Cognito sub
  username: string
  name?: string
  email: string
  role: Role
  status: MemberStatus
  mfa: 'enrolled' | 'not-enrolled'
  createdAt: string
  lastRequestAt?: string
  costThisMonthUsd: number
  budget?: Budget
  tierLimit?: Cap
  /** A change (disable, enable, role, limit) waits for the router's next poll. */
  applying?: true
}

/** GET /api/admin/members: the list plus the delivery state of identity/principals.json and blocks.json. */
export interface MembersResponse { items: Member[]; identity: Delivery }

export interface MemberDetail extends Member {
  history: Array<{ ts: string; status: MemberStatus | 'role'; by?: string; detail?: string }>
  sessions: Array<{ session: string; last: string; requests: number; costUsd: number }>
  budgetStatus?: BudgetStatus
}

export interface InviteRequest { email: string; name: string; role: Role; budget?: Budget; tierLimit?: Cap }
export interface MemberPatch { role?: Role; budget?: Budget | null; tierLimit?: Cap | null }
/** No reset-mfa: the user pool has MFA off (user decision 2026-11-08). */
export type MemberAction = 'resend-invite' | 'disable' | 'enable' | 'sign-out'
export interface ActionRequest<A extends string> { action: A }

// ---------------------------------------------------------------------------------------------------- service clients

export interface ServiceClient {
  id: string                // Cognito app client id
  name: string
  description?: string
  status: 'active' | 'disabled'
  createdAt: string
  lastUsedAt?: string
  costThisMonthUsd: number
  scope: string
  budget?: Budget
  tierLimit?: Cap
}

export interface CreateClientRequest { name: string; description?: string; budget?: Budget; tierLimit?: Cap }
export interface ClientsResponse { items: ServiceClient[]; identity: Delivery }

/** The secret is returned once, on create and on rotate, and never stored by the console. */
export interface ClientSecretResponse { client: ServiceClient; secret: string; tokenEndpoint: string; scope: string }
export interface ClientPatch { name?: string; description?: string; budget?: Budget | null; tierLimit?: Cap | null }
export type ClientAction = 'rotate-secret' | 'disable' | 'enable'

// ---------------------------------------------------------------------------------------------------- config

/** Principal groups for tier limits (design 0.16). Members are admin | member; service clients are service. */
export type GroupName = 'admin' | 'member' | 'service'

/** The assessor block when active: every field present (73 A1, router/settings ActiveAssessorSettings). */
export interface ActiveAssessorSettings {
  mode: 'observe' | 'auto'
  pack: string
  /** The pack's version when saved (the console fills it); checked against the running image's packs. */
  packVersion?: string
  model: string
  threshold: number
  timeoutMs: number
  autoRules: 'pack' | 'all'
}

/** One shape: with mode 'off' the other fields are kept (off → observe restores them) and may be absent. */
export type AssessorSettingsDoc = ActiveAssessorSettings | ({ mode: 'off' } & Partial<Omit<ActiveAssessorSettings, 'mode'>>)

/** Group defaults only; per-principal limits live in identity/principals.json (PrincipalEntry). */
export interface AccessBlock { groups: Partial<Record<GroupName, Cap>> }

/** identity/principals.json: "<kind>:<id>" → entry (written by the console, read by the router). */
export interface PrincipalEntry { group?: GroupName; cap?: Cap }

/**
 * config/active.json (design v1 §2.1; router/settings validateConfigDocument). `version` is "<n>-<compact ISO time>",
 * e.g. "3-20261108T031500Z" (the router rejects other forms); order versions by n, never by string compare.
 * `policy` is the router policy document (core PolicyInput).
 */
export interface ConfigDocument {
  schemaVersion: 1
  version: string
  policy: Record<string, unknown>
  assessor?: AssessorSettingsDoc
  identity?: { mode: IdentityMode }
  access: AccessBlock
}

export interface ConfigVersionMeta {
  version: string
  n: number
  author: string
  createdAt: string
  comment: string
  /** Top-level sections that differ from the previous version. */
  changed: string[]
  /** This version restored an older one. */
  rollbackOf?: string
}

export interface RouterConfigState {
  status: 'active' | 'pending' | 'rejected'
  /** Every running task reports the identity signing keys (JWKS) loaded; Require is refused until then. */
  identityKeysLoaded?: boolean
  /** How identityKeysLoaded was decided (0d-effective-config §7), from the router state lines. */
  identityKeys?: IdentityKeysState
  /** The version the router last reported (kind: "config" line). */
  reportedVersion?: string
  since?: string
  issues?: string[]
}

export interface CatalogModelView { modelId: string; tier: Tier; dialects: Dialect[]; contextWindow: number }

export interface ConfigState {
  active: ConfigVersionMeta & { document: ConfigDocument }
  draft?: { document: ConfigDocument; author: string; updatedAt: string; baseVersion: string }
  router: RouterConfigState
  /** config/active.json delivery (S3 put); notDelivered → admin.config.redeliver. */
  delivery: Delivery
  /** Allowed model universe (deploy parameter allowedModelUniverse). */
  universe: string[]
  catalog: CatalogRef & { models: CatalogModelView[] }
  /**
   * Effective configuration (0d-effective-config §4): per-section sources, the settings, and the complete effective
   * document a new draft starts from (absent while a section is unknown).
   */
  effective?: EffectiveSettings & { sources: Record<ConfigSectionName, SettingSource>; document?: ConfigDocument; bakedVersion?: string }
  /** Latest config line per router task (last 7 days), newest first. */
  reported?: ReportedConfig[]
}

export interface SaveDraftRequest { document: ConfigDocument; baseVersion: string }
export interface ValidateRequest { document: ConfigDocument }

export type SwapSeverity = 'info' | 'warn' | 'disruptive'

/**
 * core policySwapEffects(prev, next, catalog) (@auto-router/core/policy, design 0.9). 'disruptive' only for removals
 * that fail at once (alias, pool, pinnable model); activation then needs confirmDisruptive.
 */
export interface SwapEffect {
  effect:
    | 'mode' | 'pool-added' | 'pool-removed' | 'model-added' | 'model-removed' | 'pin-removed' | 'tier-remap' | 'default-tier'
    | 'rules' | 'alias-added' | 'alias-removed' | 'alias-retargeted' | 'observe-default' | 'failover' | 'user-turn'
    | 'session-tier' | 'portability-loosened' | 'portability-tightened' | 'tuning'
    /** console-api: the active policy no longer validates, so no diff can be computed (always disruptive). */
    | 'cannot-compare'
    /** console-api (0d review): the effective identity mode drops (require > observe > off): blocks, budgets and caps stop binding (disruptive). */
    | 'identity-weakened'
    /** console-api: the effective identity mode rises (info). */
    | 'identity-strengthened'
    /** console-api: the effective assessor mode changes (warn when leaving auto, info otherwise). */
    | 'assessor-mode'
    | (string & {})
  severity: SwapSeverity
  dialect?: Dialect
  model?: string
  /** English detail; the console renders its own copy from `effect` when it has one. */
  detail: string
  /** Console-side count of affected sessions or requests, when known. */
  affected?: number
}

export interface ValidateResponse { ok: boolean; issues: ValidationIssue[]; effects: SwapEffect[]; changed: string[] }

export interface ActivateRequest {
  document: ConfigDocument
  comment: string
  /** Optimistic lock: the active version the editor started from. */
  baseVersion: string
  confirmDisruptive?: boolean
  rollbackOf?: string
}

export interface ActivateResponse { version: ConfigVersionMeta }

// ---------------------------------------------------------------------------------------------------- packs

export interface PackRuleView { id: string; tier: Tier; enabled: boolean; auto: boolean; instruction: string }

/** One pack of the image manifest (73 §2.2). */
export interface PackEntry {
  name: string
  id: string
  packVersion: string
  card: string
  output: string
  mapping: Record<string, unknown>
  mappingSource: 'pack' | 'default'
  rules: PackRuleView[]
  autoCapable: boolean
  examples: { count: number; byTier: Partial<Record<Tier, number>> }
  systemChars: number
}

export interface PacksResponse {
  schemaVersion: 1
  default: string
  packs: PackEntry[]
  stats?: AssessorStats
}

export interface AssessorStats {
  range: DayRange
  consultations: number
  share: number
  byTier: Partial<Record<Tier | 'no-opinion', number>>
  unavailableRate: number
  appliedRate: number
  cachedShare: number
  latencyP50Ms: number
  latencyP95Ms: number
  costUsd: number
}

// ---------------------------------------------------------------------------------------------------- gateway

export interface GatewayInfo {
  url: string
  id: string
  status: string
  updatedAt?: string
  authorizer: { discoveryUrl: string; allowedScopes: string[] }
  targets: Array<{ name: string; role: 'router' | 'fallback'; detail: string; models?: string[] }>
  rules: Array<{ priority: number; match: string; target: string }>
  fallbackChain: string[]
  forwardedHeaders: string[]
  /** field → CDK parameter that changes it. */
  cdkParameters: Record<string, string>
}

// ---------------------------------------------------------------------------------------------------- health

export type HealthRange = '1h' | '6h' | '24h' | '7d'

export interface Series { t: string; v: number }

export interface HealthReport {
  range: HealthRange
  tasks: { running: number; desired: number }
  requestsPerMin: Series[]
  rate4xx: Series[]
  rate5xx: Series[]
  failovers: Series[]
  overheadP50: Series[]
  overheadP99: Series[]
  ttfbP50: Series[]
  ttfbP99: Series[]
  hitRate: Series[]
  switches: Series[]
  missesByReason: Partial<Record<MissReason, number>>
  assessor: { latencyP50Ms?: number; latencyP95Ms?: number; unavailableRate?: number }
  fallbackSigns: { router5xx: number; unhealthyTargets: number; tasksBelowDesired: boolean }
  config: { activeVersion: string; reportedVersion?: string; rejections: number }
  ingestLagSeconds?: number
  alarms: Array<{ name: string; state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA'; since: string }>
}

// ---------------------------------------------------------------------------------------------------- audit

export type AuditAction =
  | 'member.invite' | 'member.role' | 'member.disable' | 'member.enable' | 'member.signOut' | 'member.delete'
  | 'client.create' | 'client.rotate' | 'client.disable' | 'client.enable' | 'client.delete'
  | 'member.update' | 'client.update'
  | 'config.draft' | 'config.discard' | 'config.activate' | 'config.rollback' | 'config.rejected' | 'config.redeliver'
  | 'settings.change' | 'gateway.edit'

export interface AuditEntry {
  id: string
  ts: string
  actor: { kind: 'user' | 'router'; key?: PrincipalKey; name?: string }
  action: AuditAction
  target: string
  summary: string
  requestId: string
  result: 'succeeded' | 'failed'
  errorCode?: string
  before?: unknown
  after?: unknown
}

export interface AuditQuery extends DayRange { actor?: string; action?: AuditAction[]; target?: string; cursor?: string; limit?: number }

// ---------------------------------------------------------------------------------------------------- budgets and settings

export interface BudgetsResponse { default?: Budget; perPrincipal: Array<{ caller: CallerRef; budget: Budget; spentUsd: number }> }
export interface BudgetsPatch { default: Budget | null }

/** Deployment settings held by the console (not in the router config document). */
export interface DeploymentSettings {
  defaultBaseline: Baseline
  /** Read-only facts shown on Settings → Deployment (deploy parameters; a CDK deploy changes them). */
  readOnly: {
    /** Deploy parameter recordRetentionDays: TTL of request records (daily rollups are kept longer). */
    retentionDays: number
    refreshDays: number
    catalog: CatalogRef
    universe: string[]
  }
  identity: Delivery
}
/** Only console settings; deploy parameters (retention, refresh days, universe) are not patchable. */
export interface SettingsPatch { defaultBaseline?: Baseline }
