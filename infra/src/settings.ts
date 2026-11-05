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
  desiredCount: number
  /** API Gateway stage throttling for the router API (account- and Region-wide quotas are shared). */
  throttle: { rate: number; burst: number }
  /** E2E-only router env (fault injection, idle timeout). Never set for a real deployment. */
  e2e?: { fault?: string; idleTimeoutMs?: number }
}

export class SettingsError extends Error {
  constructor(issues: string[]) {
    super(`invalid deploy settings:\n  - ${issues.join('\n  - ')}`)
    this.name = 'SettingsError'
  }
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
const AZ_ID_RE = /^[a-z]{2,6}\d-az\d+$/
const PREFIX_RE = /^[a-z][a-z0-9-]{1,14}$/

type Ctx = Pick<Node, 'tryGetContext'>

/**
 * Context keys: region and account (both required), azIds (comma list), prefix, tags (JSON object), policyFile,
 * catalogFile, routerDesiredCount, throttle ('<rate>,<burst>'). `-c account=env` explicitly opts in to the CLI
 * credentials' account (CDK_DEFAULT_ACCOUNT). policyFile falls back to ROUTER_POLICY_FILE.
 */
export function resolveSettings(node: Ctx, env: NodeJS.ProcessEnv, defaultPolicyFile: string): Settings {
  const issues: string[] = []
  const str = (k: string): string | undefined => {
    const v: unknown = node.tryGetContext(k)
    return v === undefined || v === null || v === '' ? undefined : String(v)
  }
  // Explicit only: a deploy never lands in whatever Region or account the shell happens to point at.
  const region = str('region') ?? ''
  if (!REGION_RE.test(region)) issues.push('region: required (-c region=<aws-region>)')
  const accountRaw = str('account') ?? ''
  const account = accountRaw === 'env' ? env.CDK_DEFAULT_ACCOUNT ?? '' : accountRaw
  if (!/^\d{12}$/.test(account)) {
    issues.push(accountRaw === 'env' ? 'account: -c account=env needs CDK_DEFAULT_ACCOUNT (run through the cdk CLI with credentials)'
      : 'account: required (-c account=<12-digit id>, or -c account=env to use the CLI credentials\' account)')
  }

  const azRaw = str('azIds')
  const azIds = (azRaw ? azRaw.split(',').map((s) => s.trim()).filter(Boolean) : [...(DEFAULT_AZ_IDS[region] ?? [])]) as string[]
  if (azIds.length !== 2) issues.push(`azIds: two AZ IDs required for ${region || 'the region'} (-c azIds=<id>,<id>; defaults exist for ${Object.keys(DEFAULT_AZ_IDS).join(', ')})`)
  for (const az of azIds) if (!AZ_ID_RE.test(az)) issues.push(`azIds: '${az}' is not an AZ ID (e.g. apse1-az1)`)

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
  tags = { Project: 'llm-auto-router', Purpose: 'mvp', ...tags }

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

  if (issues.length) throw new SettingsError(issues)
  const catalogFile = str('catalogFile')
  return {
    region, account, azIds: [azIds[0] as string, azIds[1] as string], prefix, tags,
    policyFile: str('policyFile') ?? env.ROUTER_POLICY_FILE ?? defaultPolicyFile,
    ...(catalogFile ? { catalogFile } : {}),
    desiredCount,
    throttle: { rate: rate as number, burst: burst as number },
    ...(e2eFault || e2eIdle ? { e2e: { ...(e2eFault ? { fault: e2eFault } : {}), ...(e2eIdle ? { idleTimeoutMs: Number(e2eIdle) } : {}) } } : {}),
  }
}
