// Model ids the stack grants, from the deploy's policy file validated against the deploy region's price catalog
// (the same checks the router runs at boot). The task role may invoke exactly the router's allowed models; the
// gateway role only the pinned fallback models.
import { readFileSync } from 'node:fs'
import { checkPolicyAgainstCatalog, validatePolicy, type Policy } from '@auto-router/core'
import { loadCatalog, validateCatalog, type PriceCatalog } from '@auto-router/pricing'
import { SettingsError, type Settings } from './settings.ts'

/** Shipped assessor prompt packs (one directory per pack name). */
export const ASSESSOR_PACKS_DIR = new URL('../../packages/assessor/prompts/assessor/', import.meta.url).pathname
/** The router's default assessor model and pack (packages/router/src/config.ts ASSESSOR_DEFAULTS). */
export const ASSESSOR_DEFAULT_MODEL = 'global.openai.gpt-6-luna'
export const ASSESSOR_DEFAULT_PACK = 'v2.2'

/** The router's shipped default policy (global profiles only). Deployments pass their own with -c policyFile=. */
export const DEFAULT_POLICY_FILE = new URL('../../packages/router/config/policy.default.json', import.meta.url).pathname

/** Gateway fallback (rule 5XX -> bedrock target): standard tier, global profiles. Must exist in the region catalog. */
export const FALLBACK = {
  messages: 'global.anthropic.claude-sonnet-5-5',
  openai: 'global.openai.gpt-6.1-sol',
} as const

export interface DeployModels {
  policy: Policy; catalog: PriceCatalog; routerModels: string[]; fallbackModels: string[]
  /** Models that can serve the Responses API (router pool, or the OpenAI fallback): they also need the default project. */
  routerResponsesModels: string[]; fallbackResponsesModels: string[]
}

/** Loads and cross-checks policy, catalog and fallback models for the deploy region; throws SettingsError. */
export function deployModels(s: Settings, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): DeployModels {
  const issues: string[] = []
  let catalog: PriceCatalog | undefined
  try {
    catalog = s.catalogFile ? validateCatalog(JSON.parse(read(s.catalogFile))) : loadCatalog(s.region)
    if (catalog.region !== s.region) issues.push(`catalogFile: catalog region '${catalog.region}' is not the deploy region '${s.region}'`)
  } catch (e) { issues.push(`catalog: ${(e as Error).message}`) }
  let policy: Policy | undefined
  try { policy = validatePolicy(JSON.parse(read(s.policyFile))) } catch (e) { issues.push(`policyFile ${s.policyFile}: ${(e as Error).message}`) }
  if (policy && catalog) {
    try { checkPolicyAgainstCatalog(policy, catalog) } catch (e) { issues.push(`policy vs ${s.region} catalog: ${(e as Error).message}`) }
    const known = new Set(catalog.models.map((m) => m.modelId))
    for (const m of Object.values(FALLBACK)) if (!known.has(m)) issues.push(`fallback model '${m}' is not in the ${s.region} catalog`)
  }
  if (issues.length || !policy || !catalog) throw new SettingsError(issues)
  const routerModels = modelUniverse(s.modelUniverse, policy, catalog, issues)
  // The default-project grant covers every router model that can serve the Responses API, so a console policy may
  // put any of them in its openai-responses pool (with the policy file's universe this is that pool's models).
  const resp = policy.pools['openai-responses']
  const responsesIds = new Set(catalog.models.filter((m) => m.dialects.includes('openai-responses')).map((m) => m.modelId))
  const responsesCapable = routerModels.filter((id) => responsesIds.has(id))
  const routerResponsesModels = [...new Set([...(resp ? resp.models.flatMap((e) => [e.model, ...(e.failover ?? [])]) : []),
    ...(policy.observeDefaults?.['openai-responses'] ? [policy.observeDefaults['openai-responses']] : []), ...responsesCapable])].sort()
  if (s.assessor) checkAssessor(s.assessor, catalog, routerModels, routerResponsesModels, read, issues)
  if (issues.length) throw new SettingsError(issues)
  return { policy, catalog, routerModels, fallbackModels: [...new Set(Object.values(FALLBACK))].sort(),
    routerResponsesModels, fallbackResponsesModels: [FALLBACK.openai] }
}

/**
 * The router's model universe (allowedModelUniverse): the policy file's models, plus every catalog model ('catalog')
 * or the listed ids. The task role's InvokeModel grants, ROUTER_MODEL_UNIVERSE and the console's allowed list are
 * this set, so a console policy can use any of these models without a deploy.
 */
function modelUniverse(u: Settings['modelUniverse'], policy: Policy, catalog: PriceCatalog, issues: string[]): string[] {
  const base = allowedModels(policy, catalog)
  if (u === 'policy') return base
  const known = new Set(catalog.models.map((m) => m.modelId))
  const extra = u === 'catalog' ? [...known] : u
  for (const id of extra) if (!known.has(id)) issues.push(`allowedModelUniverse: '${id}' is not in the ${catalog.region} catalog (use policy, catalog or a comma list of catalog model ids)`)
  return [...new Set([...base, ...extra.filter((id) => known.has(id))])].sort()
}

/**
 * The assessor calls its model with the router's task role, so it needs no grant of its own: its model must be one of
 * the router's models, and an OpenAI-shape model (the assessor uses Responses when the model supports it) must be
 * among the Responses pool models, which also carry the default-project statement. Auto mode with autoRules 'pack'
 * needs a pack with at least one enabled auto rule (the router refuses it at boot otherwise).
 */
function checkAssessor(a: NonNullable<Settings['assessor']>, catalog: PriceCatalog, routerModels: string[], responsesModels: string[],
  read: (p: string) => string, issues: string[]): void {
  const model = a.model ?? ASSESSOR_DEFAULT_MODEL
  const price = catalog.models.find((m) => m.modelId === model)
  if (!price) issues.push(`assessorModel '${model}' is not in the ${catalog.region} catalog`)
  else if (!routerModels.includes(model)) issues.push(`assessorModel '${model}' is not one of the router's policy models (the task role may invoke only those; no extra grant is made)`)
  else if (!price.dialects.includes('anthropic-messages') && price.dialects.includes('openai-responses') && !responsesModels.includes(model)) {
    issues.push(`assessorModel '${model}' calls the Responses API but is not in the policy's openai-responses pool (no default-project grant)`)
  }
  const pack = a.pack ?? ASSESSOR_DEFAULT_PACK
  let rules: unknown
  try { rules = JSON.parse(read(`${ASSESSOR_PACKS_DIR}${pack}/rules.json`)) } catch { issues.push(`assessorPack '${pack}': no shipped pack with that name`); return }
  const anyAuto = Array.isArray(rules) && rules.some((r) => typeof r === 'object' && r !== null && (r as Record<string, unknown>).enabled === true && (r as Record<string, unknown>).auto === true)
  if (a.mode === 'auto' && (a.autoRules ?? 'pack') === 'pack' && !anyAuto) {
    issues.push(`assessorMode=auto: every rule of pack ${pack} is auto:false, so with assessorAutoRules=pack the assessor could never act; use -c assessorAutoRules=all (experiment) or assessorMode=observe`)
  }
}

/** Same set as the router's allowedModels: catalog ∩ (pool models ∪ failover profiles ∪ observe defaults). */
export function allowedModels(policy: Policy, catalog: PriceCatalog): string[] {
  const known = new Set(catalog.models.map((m) => m.modelId))
  const ids = new Set<string>()
  for (const pool of Object.values(policy.pools)) for (const e of pool?.models ?? []) { ids.add(e.model); for (const f of e.failover ?? []) ids.add(f) }
  for (const m of Object.values(policy.observeDefaults ?? {})) if (m) ids.add(m)
  return [...ids].filter((id) => known.has(id)).sort()
}

/** `global.anthropic.claude-haiku-5-5` -> `anthropic.claude-haiku-5-5` (the foundation model behind a profile). */
export const baseModelId = (id: string): string => id.replace(/^(global|[a-z]{2,4})\.(?=[a-z]+\.)/, '')

export interface InvokeStatement { sid: string; resources: string[]; conditions?: Record<string, Record<string, string | string[]>> }

/**
 * bedrock:InvokeModel* statements following the documented cross-Region inference IAM patterns:
 * - global profiles: the profile in the deploy Region, the foundation model in that Region, and the global
 *   foundation model `arn:aws:bedrock:::foundation-model/<id>` with aws:RequestedRegion = "unspecified", each
 *   model statement tied to the profile ARNs with bedrock:InferenceProfileArn;
 * - geographic profiles: the profile, and the foundation model in any destination Region of that profile;
 * - in-Region models: the foundation model in the deploy Region.
 */
export function invokeStatements(ids: readonly string[], catalog: PriceCatalog, region: string, account: string): InvokeStatement[] {
  const scope = (id: string) => catalog.models.find((m) => m.modelId === id)?.endpointScope
  const profileArn = (id: string) => `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`
  const global = ids.filter((id) => scope(id) === 'global')
  const geo = ids.filter((id) => scope(id) === 'geo')
  const local = ids.filter((id) => scope(id) === 'in-region')
  const profiles = [...global, ...geo]
  const out: InvokeStatement[] = []
  if (profiles.length) {
    out.push({ sid: 'InferenceProfiles', resources: profiles.map(profileArn), conditions: { StringEquals: { 'aws:RequestedRegion': region } } })
    out.push({ sid: 'ProfileModelsInRegion', resources: [...new Set(profiles.map((id) => `arn:aws:bedrock:${region}::foundation-model/${baseModelId(id)}`))],
      conditions: { StringEquals: { 'aws:RequestedRegion': region, 'bedrock:InferenceProfileArn': profiles.map(profileArn) } } })
  }
  if (global.length) {
    out.push({ sid: 'GlobalProfileModels', resources: global.map((id) => `arn:aws:bedrock:::foundation-model/${baseModelId(id)}`),
      conditions: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': global.map(profileArn) } } })
  }
  if (geo.length) {
    out.push({ sid: 'GeoProfileModels', resources: [...new Set(geo.map((id) => `arn:aws:bedrock:*::foundation-model/${baseModelId(id)}`))],
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': geo.map(profileArn) } } })
  }
  if (local.length) out.push({ sid: 'InRegionModels', resources: local.map((id) => `arn:aws:bedrock:${region}::foundation-model/${id}`) })
  return out
}

/**
 * The Responses API on bedrock-runtime also authorizes bedrock:InvokeModel on the account's default project
 * (Bedrock User Guide, "Using the Responses API on the bedrock-runtime endpoint" > Permissions). The project
 * authorization carries bedrock:ModelArn (the inference profile the request named), which limits the grant to these
 * models. Stored-response management (GetInvoke/CancelInvoke/DeleteInvoke) is not granted: GET/DELETE are out of scope.
 */
export function responsesProjectStatement(ids: readonly string[], region: string, account: string): InvokeStatement | undefined {
  if (!ids.length) return undefined
  return {
    sid: 'ResponsesDefaultProject',
    resources: [`arn:aws:bedrock:${region}:${account}:project/*`],
    conditions: { StringEquals: { 'bedrock:ModelArn': ids.map((id) => `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`) } },
  }
}
