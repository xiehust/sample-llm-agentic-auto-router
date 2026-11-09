// Injected storage and AWS ports (no SDK imports here). The AWS adapters implement them; memory.ts implements them
// with in-memory maps for tests and local development. Handlers see only these interfaces. Item layouts follow
// a3 §3 and 17's usage-ingest (records.ts): handlers read the stored fields, never table keys.
import type { PriceCatalog } from '@auto-router/pricing'
import type { AuditEntry, Budget, Cap, DeploymentSettings, GatewayInfo, HealthRange, HealthReport, Page, Role, SwapEffect } from '@auto-router/console-contract'
import type { PriceCatalog as Catalog } from '@auto-router/pricing'
import type { ConfigDocument, Delivery, StoredVersion } from './local-types.ts'

/** The `ACTIVE` pointer item of the console table. */
export interface ActivePointer { n: number; version: string; delivered: boolean }

export type PrincipalGroup = Role | 'service'

/**
 * Per-principal settings: `MEMBER#<kind:id>` items, flat (17's BudgetSource reads monthlyUsd / hardStop from them;
 * the default budget is `MEMBER#default`).
 */
export interface MemberSettings {
  key: string
  group: PrincipalGroup
  budget?: Budget
  cap?: Cap
  /** Service clients: display name and description (members' names live in Cognito). */
  name?: string
  description?: string
  disabled?: boolean
  createdAt: string
  updatedAt: string
}

export interface Draft { document: ConfigDocument; author: string; updatedAt: string; baseVersion: string }

export interface AuditQuery { from: string; to: string; actor?: string; actions?: string[]; target?: string; limit: number; cursor?: string }

export interface ConsoleStore {
  getActive(): Promise<ActivePointer | undefined>
  getVersion(n: number): Promise<StoredVersion | undefined>
  /** Newest first by n (never by string); `before` = only versions with n < before. Metadata only. */
  listVersionMetas(limit: number, before?: number): Promise<StoredVersion['meta'][]>
  /** Highest version number stored (0 when none). */
  latestVersion(): Promise<number>
  /**
   * One transaction: put version `v` (must not exist) and move ACTIVE to it, conditional on ACTIVE.version ===
   * expectVersion (undefined: no ACTIVE item may exist yet). 'conflict' when either condition fails.
   */
  activate(v: StoredVersion, expectVersion: string | undefined): Promise<'ok' | 'conflict'>
  /** CONFIG / v#0#<sha8>: the baked document, put if absent (idempotent, immutable; 0d §4.2). */
  seedBakedVersion(sha8: string, v: StoredVersion): Promise<void>
  getBakedVersion(sha8: string): Promise<StoredVersion | undefined>
  /** Sets ACTIVE.delivered for version n (no-op when ACTIVE moved on). */
  markDelivered(n: number, delivered: boolean): Promise<void>
  getDraft(): Promise<Draft | undefined>
  putDraft(d: Draft): Promise<void>
  deleteDraft(): Promise<void>
  appendAudit(e: AuditEntry): Promise<void>
  /** Newest first within [from, to) (ISO times). */
  listAudit(q: AuditQuery): Promise<Page<AuditEntry>>
  getMember(key: string): Promise<MemberSettings | undefined>
  putMember(m: MemberSettings): Promise<void>
  deleteMember(key: string): Promise<void>
  listMembers(): Promise<MemberSettings[]>
  getDefaultBudget(): Promise<Budget | undefined>
  putDefaultBudget(b: Budget | undefined): Promise<void>
  /** Delivery state of identity/principals.json + blocks.json (design §2.3a). */
  getIdentityDelivery(): Promise<Delivery | undefined>
  putIdentityDelivery(d: Delivery): Promise<void>
  getSettings(): Promise<Pick<DeploymentSettings, 'defaultBaseline'> | undefined>
  putSettings(s: Pick<DeploymentSettings, 'defaultBaseline'>): Promise<void>
}

/** A stored request record (17 records.ts `recordFields`), table keys removed. */
export type StoredRecord = Record<string, unknown> & { ts: string; reqId: string; principal: string; session?: string }

export interface RecordScan {
  /** ISO, inclusive / exclusive. */
  from: string
  to: string
  limit: number
  cursor?: string
  /** Applied while scanning (DynamoDB: a FilterExpression or a post-filter); pages may be short. */
  filter?: (r: StoredRecord) => boolean
}

/** One rollup item (17: U#/A# items). `baseTier` is the static baseline's tier ('-' when not routable). */
export interface RollupItem { day: string; principal: string; dialect: string; servedModel: string; baseTier: string; counters: Record<string, number> }

/** One router `kind: "config"` report (17: C#config items). */
export interface ConfigReport {
  ts: string
  task: string
  /** The router's `source` of the line (config | principals | blocks | jwks | boot …, design §2.3a). */
  source?: string
  /** applied | rejected | ignored | … (17 stores the router's `outcome`). */
  outcome?: string
  configVersion?: string
  principalsVersion?: string
  /** Legacy alias of outcome. */
  status?: string
  /** What the task really runs (0d §3): { identityMode, assessorMode, policyVersion, mode }. */
  effective?: Record<string, unknown>
  /** Per section 'document' | 'baked'. */
  sources?: Record<string, unknown>
  issues?: string[]
  packs?: Array<{ name: string; packVersion: string }>
  drift?: unknown
}

/** A router `source: "state"` line (periodic, every 5 min and on every change). */
export interface StateReport extends ConfigReport {
  identityKeys?: { configured?: boolean; loaded?: boolean; kids?: number; versions?: Record<string, unknown> }
}

export interface UsageStore {
  /**
   * One principal's records, newest first. The cursor is opaque; implementations must reject a cursor that does
   * not belong to this principal's partition (no cross-principal paging).
   */
  principalRecords(key: string, q: RecordScan): Promise<Page<StoredRecord>>
  /** All records (admin, by day index), newest first. */
  allRecords(q: RecordScan): Promise<Page<StoredRecord>>
  /**
   * A record by reqId; with `key`, only when it belongs to that principal. With `key` and `ts` (the record's own
   * timestamp, from a list row) this is one GetItem; otherwise a bounded filtered scan.
   */
  record(reqId: string, key?: string, ts?: string): Promise<StoredRecord | undefined>
  /** One session of one principal, oldest first (bounded). */
  session(key: string, label: string, limit: number): Promise<StoredRecord[]>
  /** Rollup items for days in [from, to] (inclusive); `key` absent = all principals (A# items). */
  rollups(from: string, to: string, key?: string): Promise<RollupItem[]>
  /** Month spend (nano-USD: spend + assessor) per principal (B# items). */
  monthSpend(keys: readonly string[], month: string): Promise<Map<string, number>>
  /** The router's latest config reports, newest first (bounded). */
  configReports(limit: number): Promise<ConfigReport[]>
  /** The latest state line of every task (17: C#state items, sk = task; 0d-effective-config §7). */
  stateReports(): Promise<StateReport[]>
}

/** The config/identity bucket and the packs archive (keys as in design §1; values JSON text). */
export interface ObjectStore {
  get(key: string): Promise<string | undefined>
  /** With ETag; `ifNoneMatch` equal to the current ETag → 'not-modified'. Undefined when the object is absent. */
  getObject(key: string, ifNoneMatch?: string): Promise<{ body: string; etag: string } | 'not-modified' | undefined>
  put(key: string, body: string): Promise<void>
}

export interface DirectoryUser {
  username: string
  sub: string
  email: string
  name?: string
  enabled: boolean
  /** Cognito UserStatus (FORCE_CHANGE_PASSWORD = invited). */
  status: string
  groups: Role[]
  /** TOTP enrolled. The user pool has MFA off (user decision 2026-11-08): always false; kept for the contract's display field. */
  mfa: boolean
  createdAt: string
}

export interface Directory {
  listUsers(): Promise<DirectoryUser[]>
  getUser(username: string): Promise<DirectoryUser | undefined>
  userBySub(sub: string): Promise<DirectoryUser | undefined>
  /** 'exists' when the e-mail is taken. */
  createUser(u: { email: string; name: string; role: Role }): Promise<DirectoryUser | 'exists'>
  resendInvite(username: string): Promise<void>
  setRole(username: string, role: Role): Promise<void>
  disable(username: string): Promise<void>
  enable(username: string): Promise<void>
  signOut(username: string): Promise<void>
  deleteUser(username: string): Promise<void>
}

/** Cognito app clients created by the console (client credentials, invoke scope). */
export interface ClientDirectory {
  createClient(name: string): Promise<{ clientId: string; secret: string }>
  /** New secret; the old one stops working (rotation semantics per adapter). */
  rotateSecret(clientId: string): Promise<{ secret: string }>
  deleteClient(clientId: string): Promise<void>
}

export interface GatewayReader { describe(): Promise<GatewayInfo> }
export interface MetricsReader { health(range: HealthRange): Promise<HealthReport> }
/** The router service's running task count (ECS DescribeServices runningCount); undefined when unreadable. */
export interface RouterTasks { runningCount(): Promise<number | undefined> }

/** Deployment values (Lambda environment, set by the ConsoleStack from RouterStack SSM parameters). */
export interface DeploymentEnv {
  prefix: string
  consoleScope: string
  region: string
  gatewayUrl?: string
  inferenceUrl?: string
  cognitoDomain?: string
  authorizeEndpoint?: string
  tokenEndpoint?: string
  revokeEndpoint?: string
  cliClientId?: string
  invokeScope?: string
  callbackPorts?: number[]
  codexOauthPort?: number
  /** `x-api-key` by default; null when the identity spike forces none (17 §3). */
  identityHeader?: string | null
  /** cli refresh-token lifetime (CDK). */
  refreshDays: number
  /** Models the task role may invoke (deploy parameter allowedModelUniverse). */
  modelUniverse: readonly string[]
  /** Record retention in days (deploy parameter recordRetentionDays; read-only in the console). Default 90. */
  retentionDays?: number
}

/** Overrides core policySwapEffects (tests); absent = core's. */
export type SwapEffects = (prev: ConfigDocument | undefined, next: ConfigDocument, catalog: Catalog) => SwapEffect[]

export interface Deps {
  console: ConsoleStore
  usage: UsageStore
  objects: ObjectStore
  directory: Directory
  clients: ClientDirectory
  gateway: GatewayReader
  metrics: MetricsReader
  tasks: RouterTasks
  catalog: PriceCatalog
  env: DeploymentEnv
  swapEffects?: SwapEffects
  now(): number
  uuid(): string
  /** Structured log sink (ids and codes only). */
  log(entry: Record<string, unknown>): void
}
