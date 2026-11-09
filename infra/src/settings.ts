// Deploy-time settings (parent PRD N5, publishable): nothing about a particular deployment is baked into code.
// Every value comes from CDK context (-c key=value) or the environment; required ones fail fast at synth.
import type { Node } from 'constructs'

/**
 * Default subnet AZ IDs per Region for AgentCore Gateway managed private endpoints (two IDs from the documented
 * supported set). Regions not listed need `-c azIds=<id>,<id>`; see the AgentCore Gateway documentation on VPC
 * egress for the supported AZ IDs.
 */
export const DEFAULT_AZ_IDS: Readonly<Record<string, readonly [string, string]>> = {
  'ap-northeast-1': ['apne1-az1', 'apne1-az2'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2'],
}

export interface Settings {
  region: string
  /** The account the stack must deploy into (CDK refuses any other credentials' account). */
  account: string
  azIds: [string, string]
  /** Prefix for every physical name (and the Cognito domain), e.g. 'llmar' -> llmar-gw, llmar-router. */
  prefix: string
  /** Tags applied to every resource. Project and Purpose have neutral defaults; nothing personal is defaulted. */
  tags: Record<string, string>
  policyFile: string
  catalogFile?: string
  /**
   * allowedModelUniverse: the models the router task role may invoke, so the console can put them in a policy.
   * 'policy' (default) = the policy file's models; 'catalog' = every model in the region catalog; a list = the policy
   * file's models plus these ids. Catalog membership is checked in deployModels.
   */
  modelUniverse: 'policy' | 'catalog' | readonly string[]
  desiredCount: number
  /** API Gateway stage throttling for the router API (account- and Region-wide quotas are shared). */
  throttle: { rate: number; burst: number }
  /** E2E-only router env (fault injection, idle timeout). Never set for a real deployment. */
  e2e?: { fault?: string; idleTimeoutMs?: number }
  /**
   * Router tier assessor (ROUTER_ASSESSOR_*); absent = off. Unset fields keep the router's defaults (model
   * global.openai.gpt-6-luna, threshold 0.8, pack v2.2, 5000 ms, autoRules pack). Cross-checked by deployModels.
   */
  assessor?: AssessorDeploy
  /** Admin console identity (design v1 0.1–0.2): the router's env default mode; the config document overrides it. */
  identity: {
    mode: 'off' | 'observe' | 'require'
    /** 127.0.0.1 loopback ports registered on the cli app client (llmar login), and one for Codex gateway_oauth. */
    cliRedirectPorts: number[]
    codexOauthPort: number
    /** cli refresh-token lifetime in days (members sign in again after this). */
    cliRefreshDays: number
  }
}

export interface AssessorDeploy {
  mode: 'observe' | 'auto'
  model?: string
  threshold?: string
  pack?: string
  timeoutMs?: string
  autoRules?: 'pack' | 'all'
}

export class SettingsError extends Error {
  constructor(issues: string[]) {
    super(`invalid deploy settings:\n  - ${issues.join('\n  - ')}`)
    this.name = 'SettingsError'
  }
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
export const AZ_ID_RE = /^[a-z]{2,6}\d-az\d+$/
const PREFIX_RE = /^[a-z][a-z0-9-]{1,14}$/

export type Ctx = Pick<Node, 'tryGetContext'>

/** Context reader: unset, null and empty values all read as undefined. */
export const contextReader = (node: Ctx) => (k: string): string | undefined => {
  const v: unknown = node.tryGetContext(k)
  return v === undefined || v === null || v === '' ? undefined : String(v)
}

export interface CommonSettings { region: string; account: string; prefix: string; tags: Record<string, string> }

/**
 * Keys shared by every stack in this app: region and account (both required, explicit), prefix, and tags (a JSON
 * object merged over `defaultTags`). `-c account=env` explicitly opts in to the CLI credentials' account
 * (CDK_DEFAULT_ACCOUNT). Problems are appended to `issues`; the caller throws.
 */
export function resolveCommon(str: (k: string) => string | undefined, env: NodeJS.ProcessEnv,
  defaultTags: Record<string, string>, issues: string[]): CommonSettings {
  // Explicit only: a deploy never lands in whatever Region or account the shell happens to point at.
  const region = str('region') ?? ''
  if (!REGION_RE.test(region)) issues.push('region: required (-c region=<aws-region>)')
  const accountRaw = str('account') ?? ''
  const account = accountRaw === 'env' ? env.CDK_DEFAULT_ACCOUNT ?? '' : accountRaw
  if (!/^\d{12}$/.test(account)) {
    issues.push(accountRaw === 'env' ? 'account: -c account=env needs CDK_DEFAULT_ACCOUNT (run through the cdk CLI with credentials)'
      : 'account: required (-c account=<12-digit id>, or -c account=env to use the CLI credentials\' account)')
  }
  const prefix = str('prefix') ?? 'llmar'
  if (!PREFIX_RE.test(prefix)) issues.push(`prefix: '${prefix}' must match ${PREFIX_RE} (lower case, 2-15 chars)`)
  let tags: Record<string, string> = {}
  const tagsRaw = str('tags')
  if (tagsRaw) {
    try {
      const t: unknown = JSON.parse(tagsRaw)
      if (typeof t !== 'object' || t === null || Array.isArray(t) || !Object.values(t).every((v) => typeof v === 'string')) throw new Error('not an object of strings')
      tags = t as Record<string, string>
    } catch (e) { issues.push(`tags: JSON object of strings required (${(e as Error).message})`) }
  }
  return { region, account, prefix, tags: { ...defaultTags, ...tags } }
}

/**
 * Router stack context keys: the common ones (resolveCommon), azIds (comma list), policyFile, catalogFile,
 * allowedModelUniverse (policy | catalog | comma list of model ids, default policy),
 * routerDesiredCount, throttle ('<rate>,<burst>'), e2eFault, e2eIdleTimeoutMs, identity (identityMode, cliRedirectPorts,
 * codexOauthPort, cliRefreshDays), and the tier assessor: assessorMode
 * (off | observe | auto, default off), assessorModel, assessorThreshold, assessorPack, assessorTimeoutMs,
 * assessorAutoRules (pack | all). policyFile falls back to ROUTER_POLICY_FILE.
 */
export function resolveSettings(node: Ctx, env: NodeJS.ProcessEnv, defaultPolicyFile: string): Settings {
  const issues: string[] = []
  const str = contextReader(node)
  const { region, account, prefix, tags } = resolveCommon(str, env, { Project: 'llm-auto-router', Purpose: 'mvp' }, issues)

  const azRaw = str('azIds')
  const azIds = (azRaw ? azRaw.split(',').map((s) => s.trim()).filter(Boolean) : [...(DEFAULT_AZ_IDS[region] ?? [])]) as string[]
  if (azIds.length !== 2) issues.push(`azIds: two AZ IDs required for ${region || 'the region'} (-c azIds=<id>,<id>; defaults exist for ${Object.keys(DEFAULT_AZ_IDS).join(', ')})`)
  for (const az of azIds) if (!AZ_ID_RE.test(az)) issues.push(`azIds: '${az}' is not an AZ ID (e.g. apse1-az1)`)

  const desiredRaw = str('routerDesiredCount') ?? '0'
  const desiredCount = Number(desiredRaw)
  if (!Number.isInteger(desiredCount) || desiredCount < 0) issues.push('routerDesiredCount: non-negative integer required')

  const throttleRaw = str('throttle') ?? '20,40'
  const [rate, burst] = throttleRaw.split(',').map((x) => Number(x.trim()))
  if (!Number.isFinite(rate) || !Number.isInteger(burst) || (rate as number) <= 0 || (burst as number) <= 0) issues.push(`throttle: '<rate>,<burst>' with positive numbers required (default 20,40)`)

  const e2eFault = str('e2eFault')
  if (e2eFault && !/^(upstream-503-once(:[1-9]\d{0,3})?|router-503|pause-after-first-frame:\d{1,7})$/.test(e2eFault)) issues.push(`e2eFault: '${e2eFault}' is not a router fault`)
  const e2eIdle = str('e2eIdleTimeoutMs')
  if (e2eIdle && !/^\d{4,7}$/.test(e2eIdle)) issues.push('e2eIdleTimeoutMs: integer milliseconds required')

  const assessor = assessorDeploy(str, issues)
  const identity = identityDeploy(str, issues)
  const modelUniverse = modelUniverseDeploy(str('allowedModelUniverse'), issues)

  if (issues.length) throw new SettingsError(issues)
  const catalogFile = str('catalogFile')
  return {
    region, account, azIds: [azIds[0] as string, azIds[1] as string], prefix, tags,
    policyFile: str('policyFile') ?? env.ROUTER_POLICY_FILE ?? defaultPolicyFile,
    ...(catalogFile ? { catalogFile } : {}),
    modelUniverse,
    desiredCount,
    throttle: { rate: rate as number, burst: burst as number },
    ...(e2eFault || e2eIdle ? { e2e: { ...(e2eFault ? { fault: e2eFault } : {}), ...(e2eIdle ? { idleTimeoutMs: Number(e2eIdle) } : {}) } } : {}),
    ...(assessor ? { assessor } : {}),
    identity,
  }
}

const port = (v: string, k: string, issues: string[]): number => {
  const n = Number(v.trim())
  if (!Number.isInteger(n) || n < 1024 || n > 65535) issues.push(`${k}: port 1024-65535 required, got '${v}'`)
  return n
}

/** identityMode (off | observe | require, default observe), cliRedirectPorts (default 52817,52818,52819), codexOauthPort (52820), cliRefreshDays (30). */
function identityDeploy(str: (k: string) => string | undefined, issues: string[]): Settings['identity'] {
  const mode = str('identityMode') ?? 'observe'
  if (mode !== 'off' && mode !== 'observe' && mode !== 'require') issues.push(`identityMode: 'off' | 'observe' | 'require', got '${mode}'`)
  const cliRedirectPorts = (str('cliRedirectPorts') ?? '52817,52818,52819').split(',').map((v) => port(v, 'cliRedirectPorts', issues))
  if (cliRedirectPorts.length < 1 || cliRedirectPorts.length > 10) issues.push('cliRedirectPorts: 1 to 10 ports')
  const codexOauthPort = port(str('codexOauthPort') ?? '52820', 'codexOauthPort', issues)
  if (cliRedirectPorts.includes(codexOauthPort)) issues.push('codexOauthPort: must differ from cliRedirectPorts')
  const days = Number(str('cliRefreshDays') ?? '30')
  if (!Number.isInteger(days) || days < 1 || days > 3650) issues.push('cliRefreshDays: integer 1..3650')
  return { mode: mode as Settings['identity']['mode'], cliRedirectPorts: [...new Set(cliRedirectPorts)], codexOauthPort, cliRefreshDays: days }
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.:-]{2,127}$/

/** allowedModelUniverse: policy (default) | catalog | <model id>,<model id>,... (formats only; catalog checked later). */
function modelUniverseDeploy(raw: string | undefined, issues: string[]): Settings['modelUniverse'] {
  const v = raw?.trim() ?? 'policy'
  if (v === 'policy' || v === 'catalog') return v
  const ids = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]
  const bad = ids.filter((id) => !MODEL_ID_RE.test(id))
  if (!ids.length || bad.length) {
    issues.push(`allowedModelUniverse: 'policy' | 'catalog' | comma list of model ids${bad.length ? ` ('${bad.join("', '")}' is not a model id)` : ''}`)
    return 'policy'
  }
  return ids
}

/** Assessor context keys: formats only here; the model and pack are checked against policy and files in deployModels. */
function assessorDeploy(str: (k: string) => string | undefined, issues: string[]): AssessorDeploy | undefined {
  const mode = str('assessorMode') ?? 'off'
  const others = ['assessorModel', 'assessorThreshold', 'assessorPack', 'assessorTimeoutMs', 'assessorAutoRules'].filter((k) => str(k) !== undefined)
  if (mode === 'off') {
    if (others.length) issues.push(`${others.join(', ')}: set only with -c assessorMode=observe|auto`)
    return undefined
  }
  if (mode !== 'observe' && mode !== 'auto') { issues.push(`assessorMode: 'off' | 'observe' | 'auto', got '${mode}'`); return undefined }
  const out: AssessorDeploy = { mode }
  const model = str('assessorModel')
  if (model !== undefined) { if (MODEL_ID_RE.test(model)) out.model = model; else issues.push(`assessorModel: '${model}' is not a model id`) }
  const threshold = str('assessorThreshold')
  if (threshold !== undefined) { const n = Number(threshold); if (Number.isFinite(n) && n >= 0 && n <= 1) out.threshold = threshold; else issues.push('assessorThreshold: number in [0, 1] required') }
  const pack = str('assessorPack')
  if (pack !== undefined) { if (/^v\d+(\.\d+)?$/.test(pack)) out.pack = pack; else issues.push(`assessorPack: '${pack}' is not a pack name (e.g. v2.1)`) }
  const timeoutMs = str('assessorTimeoutMs')
  if (timeoutMs !== undefined) { const n = Number(timeoutMs); if (Number.isInteger(n) && n >= 100 && n <= 10_000) out.timeoutMs = timeoutMs; else issues.push('assessorTimeoutMs: integer 100..10000 required') }
  const autoRules = str('assessorAutoRules')
  if (autoRules !== undefined) { if (autoRules === 'pack' || autoRules === 'all') out.autoRules = autoRules; else issues.push(`assessorAutoRules: 'pack' | 'all', got '${autoRules}'`) }
  return out
}
