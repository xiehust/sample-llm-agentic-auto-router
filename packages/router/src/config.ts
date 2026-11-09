// Boot configuration (design §2.1 config.ts). Every problem is reported at once; the process exits 1 on any.
import { readFileSync } from 'node:fs'
import { checkPolicyAgainstCatalog, validatePolicy, type Policy } from '@auto-router/core'
import { DEFAULT_ASSESSOR_MODEL, defaultPackName, loadBundledPacks, manifestMismatches, readManifest, selectAdapter, type BundledPack, type PackName } from '@auto-router/assessor'
import { findModel, loadCatalog, validateCatalog, type ModelPrice, type PriceCatalog } from '@auto-router/pricing'
import type { RouterAssessorConfig } from './assessor.ts'
import { IDENTITY_HEADERS, IDENTITY_MODES, type IdentityHeader, type IdentityMode } from './identity.ts'
import { allowedModels } from './models.ts'
import { validateAssessorSettings, type PackInfo, type SettingsField } from './settings.ts'

export type HopAuth =
  | { kind: 'apigw-iam'; gatewayRoleArn: string; gatewayArn: string; vpceId: string }
  | { kind: 'test-bypass' }       // ROUTER_INBOUND_TEST_BYPASS=1, loopback bind only
  | { kind: 'reject' }            // unset or unknown: every model request is refused (fail-closed)

export type ChatIncludeUsage = 'off' | 'inject-strip' | 'inject'
export interface Hints { chatIncludeUsage: ChatIncludeUsage; claudeAutoCache: boolean; claudeCacheTtl: 'keep' }

/** E2E-only faults (ROUTER_FAULT_INJECT, honoured only with ROUTER_FAULT_INJECT_ALLOW=1). */
/** E2E faults. `upstream-503-once[:<n>]` answers 503 instead of the n-th upstream attempt (default 1) of the task's life. */
export type Fault = 'none' | 'upstream-503-once' | `upstream-503-once:${number}` | 'router-503' | `pause-after-first-frame:${number}`

export interface RouterConfig {
  bind: string
  port: number
  maxBodyBytes: number
  region: string
  /** https://bedrock-runtime.<region>.amazonaws.com unless overridden for local tests (loopback http only). */
  upstream: URL
  hopAuth: HopAuth
  hints: Hints
  policy: Policy
  catalog: PriceCatalog
  fault: Fault
  /** Per upstream attempt: time to response headers (stream / non-stream) and the idle gap allowed between body chunks. */
  timeouts: Timeouts
  /** Tier assessor (ROUTER_ASSESSOR_*); default off. */
  assessor: RouterAssessorConfig
  /**
   * Every pack bundled in the image, loaded and checked against the committed manifest at boot (research 73 A1), so
   * a runtime settings change (off → observe, another pack) never reads the filesystem. loadConfig always sets it;
   * optional for hand-built configs (tests, experiment harnesses), which then have no runtime pack choice.
   */
  packs?: ReadonlyMap<PackName, BundledPack>
  /**
   * ROUTER_MODEL_UNIVERSE: every model the task role may invoke (the deploy's IAM grant), which bounds what any
   * runtime configuration can name. Absent: the boot policy's models plus the assessor model.
   */
  modelUniverse?: ReadonlySet<string>
  /** ROUTER_CONFIG_BUCKET (+ ROUTER_CONFIG_POLL_MS, default 30000): runtime configuration in S3. Absent: boot policy only. */
  configSource?: { bucket: string; pollMs: number }
  /** Verified principal (ROUTER_IDENTITY_*); absent = off. Its objects are polled from configSource. */
  identity?: IdentityConfig
}

/**
 * Identity settings (admin console design v1 0.1–0.2). `mode` is the env default; the config document's
 * identity.mode overrides it per generation. identity/jwks.json, blocks.json and budget-blocks.json are read from
 * the config bucket with the runtime configuration, so identity needs ROUTER_CONFIG_BUCKET.
 */
export interface IdentityConfig {
  mode: IdentityMode
  header: IdentityHeader
  /** https://cognito-idp.<region>.amazonaws.com/<poolId> */
  issuer: string
  /** <prefix>/invoke */
  scope: string
}

export interface Timeouts { streamHeaderMs: number; nonStreamHeaderMs: number; idleMs: number; heartbeatMs: number; streamCapMs: number }
/**
 * heartbeatMs bridges the hop's 5-min idle timeout during upstream silence; streamCapMs is the hop's maximum stream
 * duration (API Gateway: 15 min), used to name a client close near it 'stream-duration-cap'.
 */
export const DEFAULT_TIMEOUTS: Timeouts = { streamHeaderMs: 60_000, nonStreamHeaderMs: 600_000, idleMs: 240_000, heartbeatMs: 60_000, streamCapMs: 900_000 }

export class ConfigError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`invalid router configuration:\n  - ${issues.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

export const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/
const GATEWAY_ARN = /^arn:aws:bedrock-agentcore:[a-z0-9-]+:\d{12}:gateway\/[\w-]+$/
const VPCE_ID = /^vpce-[0-9a-f]{8,17}$/

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, issues: string[], min = 1): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) issues.push(`${name}: integer >= ${min} required`)
  return n
}

function hints(raw: string | undefined, issues: string[]): Hints {
  const out: Hints = { chatIncludeUsage: 'off', claudeAutoCache: false, claudeCacheTtl: 'keep' }
  if (!raw) return out
  let v: unknown
  try { v = JSON.parse(raw) } catch { issues.push('ROUTER_HINTS: JSON object required'); return out }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) { issues.push('ROUTER_HINTS: JSON object required'); return out }
  const h = v as Record<string, unknown>
  for (const k of Object.keys(h)) if (!['chatIncludeUsage', 'claudeAutoCache', 'claudeCacheTtl'].includes(k)) issues.push(`ROUTER_HINTS.${k}: unknown hint`)
  if (h.chatIncludeUsage !== undefined) {
    if (h.chatIncludeUsage === 'off' || h.chatIncludeUsage === 'inject-strip' || h.chatIncludeUsage === 'inject') out.chatIncludeUsage = h.chatIncludeUsage
    else issues.push(`ROUTER_HINTS.chatIncludeUsage: 'off' | 'inject-strip' | 'inject'`)
  }
  if (h.claudeAutoCache !== undefined) {
    if (typeof h.claudeAutoCache === 'boolean') out.claudeAutoCache = h.claudeAutoCache
    else issues.push('ROUTER_HINTS.claudeAutoCache: boolean required')
  }
  if (h.claudeCacheTtl !== undefined && h.claudeCacheTtl !== 'keep') issues.push(`ROUTER_HINTS.claudeCacheTtl: only 'keep' is implemented`)
  return out
}

/**
 * Builds the configuration from the environment. `readFile` is injectable for tests.
 *
 * ROUTER_BIND (default 127.0.0.1), ROUTER_PORT (8080), ROUTER_MAX_BODY_BYTES (10 MiB), ROUTER_REGION (else AWS_REGION; required),
 * ROUTER_CATALOG_FILE | ROUTER_CATALOG_JSON (optional; a catalog for ROUTER_REGION, e.g. one you captured yourself),
 * ROUTER_UPSTREAM_URL (tests only: http on a loopback host), ROUTER_HOP_AUTH (apigw-iam), ROUTER_GATEWAY_ROLE_ARN,
 * ROUTER_GATEWAY_ARN, ROUTER_API_VPCE_ID, ROUTER_INBOUND_TEST_BYPASS, ROUTER_POLICY_FILE | ROUTER_POLICY_JSON, ROUTER_HINTS (JSON),
 * ROUTER_FAULT_INJECT + ROUTER_FAULT_INJECT_ALLOW=1, ROUTER_{STREAM,NONSTREAM}_HEADER_TIMEOUT_MS, ROUTER_STREAM_IDLE_TIMEOUT_MS,
 * ROUTER_ASSESSOR_{MODE,MODEL,THRESHOLD,PACK,TIMEOUT_MS,AUTO_RULES} (see assessorSettings), ROUTER_MODEL_UNIVERSE,
 * ROUTER_CONFIG_BUCKET, ROUTER_CONFIG_POLL_MS.
 */
export function loadConfig(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): RouterConfig {
  const issues: string[] = []
  const bind = env.ROUTER_BIND || '127.0.0.1'
  const port = int(env, 'ROUTER_PORT', 8080, issues, 0)
  // 10 MiB = the API Gateway REST payload cap on the hop (V9d); larger requests never reach the router anyway.
  const maxBodyBytes = int(env, 'ROUTER_MAX_BODY_BYTES', 10 * 1024 * 1024, issues)
  // No default region: the deployment chooses it (ROUTER_REGION, else the standard AWS_REGION / AWS_DEFAULT_REGION).
  const region = env.ROUTER_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || ''
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) issues.push('ROUTER_REGION (or AWS_REGION): AWS region required, e.g. ap-southeast-1')

  let upstream = new URL(`https://bedrock-runtime.${region}.amazonaws.com`)
  if (env.ROUTER_UPSTREAM_URL) {
    try {
      const u = new URL(env.ROUTER_UPSTREAM_URL)
      // Signed requests carry the task role's session token, so they only go to bedrock-runtime or to loopback.
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const bedrock = /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/.test(host)
      if ((u.protocol === 'https:' && (bedrock || LOOPBACK.has(host))) || (u.protocol === 'http:' && LOOPBACK.has(host))) upstream = u
      else issues.push('ROUTER_UPSTREAM_URL: https to bedrock-runtime.<region>.amazonaws.com, or a loopback host (tests)')
    } catch { issues.push('ROUTER_UPSTREAM_URL: URL required') }
  }

  let hopAuth: HopAuth = { kind: 'reject' }
  if (env.ROUTER_INBOUND_TEST_BYPASS === '1') {
    if (!LOOPBACK.has(bind)) issues.push('ROUTER_INBOUND_TEST_BYPASS=1 is refused unless ROUTER_BIND is a loopback address')
    if (env.ROUTER_HOP_AUTH) issues.push('ROUTER_INBOUND_TEST_BYPASS and ROUTER_HOP_AUTH are mutually exclusive')
    hopAuth = { kind: 'test-bypass' }
  } else if (env.ROUTER_HOP_AUTH === 'apigw-iam') {
    const gatewayRoleArn = env.ROUTER_GATEWAY_ROLE_ARN ?? ''
    const gatewayArn = env.ROUTER_GATEWAY_ARN ?? ''
    const vpceId = env.ROUTER_API_VPCE_ID ?? ''
    if (!ROLE_ARN.test(gatewayRoleArn)) issues.push('ROUTER_GATEWAY_ROLE_ARN: IAM role ARN required for apigw-iam')
    if (!GATEWAY_ARN.test(gatewayArn)) issues.push('ROUTER_GATEWAY_ARN: AgentCore gateway ARN required for apigw-iam')
    if (!VPCE_ID.test(vpceId)) issues.push('ROUTER_API_VPCE_ID: execute-api VPC endpoint id required for apigw-iam')
    hopAuth = { kind: 'apigw-iam', gatewayRoleArn, gatewayArn, vpceId }
  } else if (env.ROUTER_HOP_AUTH) {
    issues.push(`ROUTER_HOP_AUTH: unsupported '${env.ROUTER_HOP_AUTH}' (apigw-iam)`)
  }

  let policy: Policy | undefined
  try {
    const raw = env.ROUTER_POLICY_JSON ?? (env.ROUTER_POLICY_FILE ? readFile(env.ROUTER_POLICY_FILE) : undefined)
    if (raw === undefined) issues.push('ROUTER_POLICY_FILE or ROUTER_POLICY_JSON: required')
    else policy = validatePolicy(JSON.parse(raw))
  } catch (e) {
    issues.push(`policy: ${(e as Error).message}`)
  }

  let fault: Fault = 'none'
  if (env.ROUTER_FAULT_INJECT && env.ROUTER_FAULT_INJECT !== 'none') {
    if (env.ROUTER_FAULT_INJECT_ALLOW !== '1') issues.push('ROUTER_FAULT_INJECT requires ROUTER_FAULT_INJECT_ALLOW=1')
    else if (env.ROUTER_FAULT_INJECT === 'router-503') fault = env.ROUTER_FAULT_INJECT
    else if (/^upstream-503-once(:[1-9]\d{0,3})?$/.test(env.ROUTER_FAULT_INJECT)) fault = env.ROUTER_FAULT_INJECT as Fault
    else if (/^pause-after-first-frame:\d{1,7}$/.test(env.ROUTER_FAULT_INJECT)) fault = env.ROUTER_FAULT_INJECT as Fault
    else issues.push(`ROUTER_FAULT_INJECT: 'upstream-503-once[:<n>]' | 'router-503' | 'pause-after-first-frame:<ms>'`)
  }

  // 240 s idle stays below API Gateway's 300 s idle timeout for private endpoints, so the router reports it first.
  const timeouts: Timeouts = {
    streamHeaderMs: int(env, 'ROUTER_STREAM_HEADER_TIMEOUT_MS', DEFAULT_TIMEOUTS.streamHeaderMs, issues),
    nonStreamHeaderMs: int(env, 'ROUTER_NONSTREAM_HEADER_TIMEOUT_MS', DEFAULT_TIMEOUTS.nonStreamHeaderMs, issues),
    idleMs: int(env, 'ROUTER_STREAM_IDLE_TIMEOUT_MS', DEFAULT_TIMEOUTS.idleMs, issues),
    heartbeatMs: int(env, 'ROUTER_SSE_HEARTBEAT_MS', DEFAULT_TIMEOUTS.heartbeatMs, issues, 0),
    streamCapMs: int(env, 'ROUTER_STREAM_CAP_MS', DEFAULT_TIMEOUTS.streamCapMs, issues),
  }

  // Price catalog for this region: a bundled one, or ROUTER_CATALOG_FILE for a region you captured yourself.
  let catalog: PriceCatalog | undefined
  try {
    const raw = env.ROUTER_CATALOG_JSON ?? (env.ROUTER_CATALOG_FILE ? readFile(env.ROUTER_CATALOG_FILE) : undefined)
    if (raw !== undefined) {
      catalog = validateCatalog(JSON.parse(raw))
      if (catalog.region !== region) issues.push(`ROUTER_CATALOG_FILE/JSON: catalog region '${catalog.region}' is not ROUTER_REGION '${region}'`)
    } else if (region) {
      catalog = loadCatalog(region)
    }
  } catch (e) {
    issues.push(`catalog: ${(e as Error).message}`)
  }
  // Every pool, failover and observe-default model must exist in this region's catalog (core's own check).
  if (policy && catalog) {
    try { checkPolicyAgainstCatalog(policy, catalog) } catch (e) { issues.push(`policy vs ${region} catalog: ${(e as Error).message}`) }
  }

  const h = hints(env.ROUTER_HINTS, issues)
  const packs = bundledPacks(issues)
  let modelUniverse: Set<string> | undefined
  if (env.ROUTER_MODEL_UNIVERSE) {
    modelUniverse = new Set(env.ROUTER_MODEL_UNIVERSE.split(',').map((m) => m.trim()).filter(Boolean))
    if (catalog) for (const m of modelUniverse) if (!findModel(catalog, m)) issues.push(`ROUTER_MODEL_UNIVERSE: '${m}' is not in the ${catalog.region} catalog`)
  }
  const assessor = assessorSettings(env, policy, catalog, packs, issues, modelUniverse)
  if (modelUniverse && policy && catalog) {
    const missing = [...allowedModels(policy, catalog)].filter((m) => !modelUniverse?.has(m))
    if (missing.length) issues.push(`ROUTER_MODEL_UNIVERSE: must include the boot policy's models (missing ${missing.join(', ')})`)
  }
  let configSource: RouterConfig['configSource']
  if (env.ROUTER_CONFIG_BUCKET) {
    // S3 bucket naming rules (no dots: virtual-hosted HTTPS needs a single DNS label).
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.ROUTER_CONFIG_BUCKET)) issues.push('ROUTER_CONFIG_BUCKET: S3 bucket name (lowercase, digits, hyphens) required')
    const pollMs = int(env, 'ROUTER_CONFIG_POLL_MS', 30_000, issues, 5000)
    configSource = { bucket: env.ROUTER_CONFIG_BUCKET, pollMs }
  }
  const identity = identitySettings(env, region, configSource !== undefined, issues)
  if (issues.length || !policy || !catalog) throw new ConfigError(issues)
  return { bind, port, maxBodyBytes, region, upstream, hopAuth, hints: h, policy, catalog, fault, timeouts, assessor, packs,
    ...(modelUniverse ? { modelUniverse } : {}), ...(configSource ? { configSource } : {}), ...(identity ? { identity } : {}) }
}

const ISSUER = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/[a-z0-9-]+_[0-9A-Za-z]+$/
const SCOPE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/

/**
 * ROUTER_IDENTITY_MODE off | observe | require (default off; the config document overrides it),
 * ROUTER_IDENTITY_HEADER x-api-key | x-router-identity (default x-api-key), ROUTER_IDENTITY_ISSUER (the pool issuer in
 * ROUTER_REGION), ROUTER_IDENTITY_SCOPE (<prefix>/invoke). Issuer or scope set requires both and ROUTER_CONFIG_BUCKET;
 * so does a mode other than off. Returns undefined when identity is not configured at all.
 */
function identitySettings(env: NodeJS.ProcessEnv, region: string, hasSource: boolean, issues: string[]): IdentityConfig | undefined {
  const mode = (env.ROUTER_IDENTITY_MODE || 'off') as IdentityMode
  if (!IDENTITY_MODES.includes(mode)) { issues.push(`ROUTER_IDENTITY_MODE: ${IDENTITY_MODES.join(' | ')}, got '${String(mode)}'`); return undefined }
  const issuer = env.ROUTER_IDENTITY_ISSUER ?? ''
  const scope = env.ROUTER_IDENTITY_SCOPE ?? ''
  if (mode === 'off' && !issuer && !scope) return undefined
  const header = (env.ROUTER_IDENTITY_HEADER || 'x-api-key') as IdentityHeader
  if (!IDENTITY_HEADERS.includes(header)) issues.push(`ROUTER_IDENTITY_HEADER: ${IDENTITY_HEADERS.join(' | ')}, got '${String(header)}'`)
  const m = ISSUER.exec(issuer)
  if (!m) issues.push('ROUTER_IDENTITY_ISSUER: https://cognito-idp.<region>.amazonaws.com/<userPoolId> required')
  else if (region && m[1] !== region) issues.push(`ROUTER_IDENTITY_ISSUER: pool region '${m[1]}' is not ROUTER_REGION '${region}'`)
  if (!SCOPE.test(scope)) issues.push('ROUTER_IDENTITY_SCOPE: <resource-server>/<scope> required, e.g. llmar/invoke')
  if (!hasSource) issues.push('ROUTER_IDENTITY_*: requires ROUTER_CONFIG_BUCKET (identity/jwks.json and the block lists live there)')
  return { mode, header, issuer, scope }
}

export const ASSESSOR_DEFAULTS: { readonly model: string; readonly threshold: 0.8; readonly pack: PackName; readonly timeoutMs: 5000; readonly autoRules: 'pack' } =
  { model: DEFAULT_ASSESSOR_MODEL, threshold: 0.8, pack: defaultPackName, timeoutMs: 5000, autoRules: 'pack' }

/** The image's packs, verified against prompts/assessor/manifest.json (a mismatch is an image bug: exit 1). */
function bundledPacks(issues: string[]): ReadonlyMap<PackName, BundledPack> {
  try {
    const packs = loadBundledPacks()
    for (const m of manifestMismatches(packs, readManifest())) issues.push(`assessor packs: ${m}`)
    return packs
  } catch (e) {
    issues.push(`assessor packs: ${(e as Error).message}`)
    return new Map()
  }
}

/** What the settings validator needs to know about a bundled pack. */
export function packInfos(packs: ReadonlyMap<PackName, BundledPack>): PackInfo[] {
  return [...packs.values()].map((b) => ({ name: b.name, packVersion: b.packVersion, autoCapable: b.pack.rules.some((r) => r.enabled && r.auto) }))
}

/** The assessor has an adapter for this model (validateAssessorSettings' hasAdapter). */
export const hasAssessorAdapter = (price: ModelPrice): boolean => { try { selectAdapter(price); return true } catch { return false } }

const ENV_OF: Record<SettingsField, string> = {
  mode: 'ROUTER_ASSESSOR_MODE', pack: 'ROUTER_ASSESSOR_PACK', packVersion: 'ROUTER_ASSESSOR_PACK_VERSION', model: 'ROUTER_ASSESSOR_MODEL',
  threshold: 'ROUTER_ASSESSOR_THRESHOLD', timeoutMs: 'ROUTER_ASSESSOR_TIMEOUT_MS', autoRules: 'ROUTER_ASSESSOR_AUTO_RULES', document: 'ROUTER_ASSESSOR',
}
const num = (raw: string | undefined, dflt: number): number => (raw === undefined || raw === '' ? dflt : Number(raw))

/**
 * ROUTER_ASSESSOR_MODE off | observe | auto (default off). When not off, the settings go through
 * validateAssessorSettings (settings.ts, shared with the console):
 * - ROUTER_ASSESSOR_MODEL (default global.openai.gpt-6-luna): in the region catalog, with an adapter, and one of the
 *   models the task role may invoke (ROUTER_MODEL_UNIVERSE, else the policy's models; infra grants the same set).
 * - ROUTER_ASSESSOR_THRESHOLD in [0, 1] (default 0.8): the assessor's mapping threshold and core's minimum confidence.
 * - ROUTER_ASSESSOR_PACK (default v2.2, the assessor's defaultPackName): a pack bundled in the image.
 * - ROUTER_ASSESSOR_TIMEOUT_MS 100..10000 (default 5000): the assessor's call deadline; core's hard bound adds
 *   ASSESSOR_GRACE_MS (100). The default was 1500 until Codex-sized cards were measured at p50 ~1.5 s / p95 ~2.1 s.
 * - ROUTER_ASSESSOR_AUTO_RULES pack | all (default pack); see AssessorAutoRules. Auto mode with 'pack' and a pack
 *   whose rules are all `auto: false` could never act, so it is refused: use observe, or 'all' (experiment switch).
 */
function assessorSettings(env: NodeJS.ProcessEnv, policy: Policy | undefined, catalog: PriceCatalog | undefined,
  packs: ReadonlyMap<PackName, BundledPack>, issues: string[], universe?: ReadonlySet<string>): RouterAssessorConfig {
  const mode = env.ROUTER_ASSESSOR_MODE || 'off'
  if (mode === 'off') return { mode: 'off' }
  // Without a catalog (already an issue) the model cannot be checked; the other problems are reported on the next run.
  if (!catalog) return { mode: 'off' }
  const raw = {
    mode,
    pack: env.ROUTER_ASSESSOR_PACK || ASSESSOR_DEFAULTS.pack,
    model: env.ROUTER_ASSESSOR_MODEL || ASSESSOR_DEFAULTS.model,
    threshold: num(env.ROUTER_ASSESSOR_THRESHOLD, ASSESSOR_DEFAULTS.threshold),
    timeoutMs: num(env.ROUTER_ASSESSOR_TIMEOUT_MS, ASSESSOR_DEFAULTS.timeoutMs),
    autoRules: env.ROUTER_ASSESSOR_AUTO_RULES || ASSESSOR_DEFAULTS.autoRules,
  }
  // The task role may invoke the deploy's model universe (ROUTER_MODEL_UNIVERSE), else the boot policy's models.
  const invokable = universe ? { invokableModels: universe, invokableLabel: 'ROUTER_MODEL_UNIVERSE' } : policy ? { invokableModels: allowedModels(policy, catalog) } : {}
  const r = validateAssessorSettings(raw, { catalog, packs: packInfos(packs), hasAdapter: hasAssessorAdapter, ...invokable })
  if (!r.ok) {
    for (const i of r.issues) issues.push(`${ENV_OF[i.field]}: ${i.message}`)
    return { mode: 'off' }
  }
  const v = r.value
  if (v.mode === 'off') return { mode: 'off' } // not reached: mode off returned above
  const bundled = packs.get(v.pack as PackName) as BundledPack // validated against packInfos(packs)
  return { mode: v.mode, model: v.model, threshold: v.threshold, packName: bundled.name, pack: bundled.pack, timeoutMs: v.timeoutMs, autoRules: v.autoRules }
}
