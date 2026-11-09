// Config-document validation for the mock API, behind an interface. The production validators are
// `validateConfigDocument` (@auto-router/router/settings, with opts.assessor from the image manifest) and core's
// `policySwapEffects(prev, next, catalog)` (@auto-router/core/policy). They are in the C3/C4 branches, not yet on
// this branch's base, so `interimValidator` stands in: the router's own validatePolicy and checkPolicyAgainstCatalog,
// plus the document checks those modules make (version form, identity mode, group caps, assessor block). When C3/C4
// merge, `routerValidator` replaces it and the interim code goes.

import type { ConfigDocument, GroupName, SwapEffect, Tier, ValidationIssue } from '@auto-router/console-contract'
import { checkPolicyAgainstCatalog, PolicyError, validatePolicy, type Policy } from '@auto-router/core'
import type { PriceCatalog } from '@auto-router/pricing'

export interface DocumentValidator {
  validate(doc: unknown): ValidationIssue[]
  effects(prev: ConfigDocument, next: ConfigDocument): SwapEffect[]
}

export interface ValidationContext {
  catalog: PriceCatalog
  universe: readonly string[]
  packs: ReadonlyArray<{ name: string; packVersion: string; autoCapable: boolean }>
}

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const GROUPS: readonly GroupName[] = ['admin', 'member', 'service']
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const VERSION = /^(0|[1-9]\d{0,15})-[A-Za-z0-9:._+-]{1,64}$/

export function interimValidator(ctx: ValidationContext): DocumentValidator {
  return {
    validate(doc) {
      const issues: ValidationIssue[] = []
      const add = (path: string, message: string, code: ValidationIssue['code'], rule?: string) => issues.push(rule ? { path, message, code, rule } : { path, message, code })
      if (!isObj(doc)) return [{ path: '', message: 'document: object required', code: 'schema' }]
      for (const k of Object.keys(doc)) if (!['schemaVersion', 'version', 'policy', 'assessor', 'identity', 'access'].includes(k)) add(`/${k}`, `${k}: unknown field`, 'schema')
      if (doc.schemaVersion !== 1) add('/schemaVersion', 'schemaVersion: 1 required', 'schema')
      if (typeof doc.version !== 'string' || !VERSION.test(doc.version)) add('/version', `version: "<n>-<suffix>" required, got ${JSON.stringify(doc.version)?.slice(0, 80)}`, 'schema')
      let policy: Policy | undefined
      try { policy = validatePolicy(doc.policy) } catch (e) {
        for (const m of e instanceof PolicyError ? e.issues : [(e as Error).message]) add('/policy', m, 'schema')
      }
      if (policy) {
        try { checkPolicyAgainstCatalog(policy, ctx.catalog) } catch (e) {
          for (const m of e instanceof PolicyError ? e.issues : [(e as Error).message]) add('/policy', m, 'catalog')
        }
        for (const [d, pool] of Object.entries(policy.pools)) {
          pool?.models.forEach((m, i) => {
            if (!ctx.universe.includes(m.model)) add(`/policy/pools/${d}/models/${i}/model`, `model '${m.model}' is outside the allowed model universe`, 'universe')
          })
        }
      }
      const id = doc.identity
      if (id !== undefined && (!isObj(id) || !['off', 'observe', 'require'].includes(id.mode as string))) add('/identity/mode', "identity.mode: 'off' | 'observe' | 'require'", 'identity')
      const acc = doc.access
      if (!isObj(acc) || !isObj(acc.groups)) add('/access', 'access.groups: object required', 'access')
      else {
        for (const [g, cap] of Object.entries(acc.groups)) {
          if (!GROUPS.includes(g as GroupName)) { add(`/access/groups/${g}`, `access.groups.${g}: unknown group`, 'access'); continue }
          if (!isObj(cap)) { add(`/access/groups/${g}`, 'cap: object required', 'access'); continue }
          if (cap.maxTier !== undefined && !TIERS.includes(cap.maxTier as Tier)) add(`/access/groups/${g}/maxTier`, 'maxTier: fast | standard | frontier', 'access')
          if (cap.allowPins !== undefined && (!Array.isArray(cap.allowPins) || !cap.allowPins.every((p) => typeof p === 'string'))) add(`/access/groups/${g}/allowPins`, 'allowPins: list of model ids', 'access')
        }
      }
      const a = doc.assessor
      if (a !== undefined) {
        if (!isObj(a) || !['off', 'observe', 'auto'].includes(a.mode as string)) add('/assessor/mode', "assessor.mode: 'off' | 'observe' | 'auto'", 'assessor', 'mode-invalid')
        else {
          const off = a.mode === 'off'
          const present = (k: string) => !(off && a[k] === undefined)
          const pack = ctx.packs.find((p) => p.name === a.pack)
          if (present('pack') && !pack) add('/assessor/pack', `pack: one of ${ctx.packs.map((p) => p.name).join(' | ')}`, 'assessor', 'pack-unknown')
          if (pack && typeof a.packVersion === 'string' && a.packVersion !== pack.packVersion) {
            add('/assessor/packVersion', `pack ${pack.name} is ${pack.packVersion} in the running image, the settings were saved for ${a.packVersion}`, 'assessor', 'pack-version-drift')
          }
          if (present('model') && !ctx.catalog.models.some((m) => m.modelId === a.model)) add('/assessor/model', `model '${String(a.model)}' is not in the ${ctx.catalog.region} catalog`, 'assessor', 'model-not-in-catalog')
          if (present('threshold') && (typeof a.threshold !== 'number' || a.threshold < 0 || a.threshold > 1)) add('/assessor/threshold', 'threshold: number in [0, 1]', 'assessor', 'threshold-invalid')
          if (present('timeoutMs') && (typeof a.timeoutMs !== 'number' || !Number.isInteger(a.timeoutMs) || a.timeoutMs < 100 || a.timeoutMs > 30_000)) add('/assessor/timeoutMs', 'timeoutMs: integer 100..30000', 'assessor', 'timeout-invalid')
          if (present('autoRules') && a.autoRules !== 'pack' && a.autoRules !== 'all') add('/assessor/autoRules', "autoRules: 'pack' | 'all'", 'assessor', 'auto-rules-invalid')
          if (a.mode === 'auto' && a.autoRules === 'pack' && pack && !pack.autoCapable) add('/assessor/autoRules', `every rule of pack ${pack.name} is auto:false, so with autoRules 'pack' the assessor could never act`, 'assessor', 'auto-cannot-act')
        }
      }
      return issues
    },
    effects: interimSwapEffects,
  }
}

const TOP = ['policy', 'assessor', 'identity', 'access'] as const

export function changedSections(prev: ConfigDocument, next: ConfigDocument): string[] {
  return TOP.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))
}

/** Stand-in for core policySwapEffects: same shape and severity rule (disruptive only for removals that fail at once). */
function interimSwapEffects(prev: ConfigDocument, next: ConfigDocument): SwapEffect[] {
  // console-api: an active policy that no longer validates (e.g. a model left the catalog) cannot be diffed.
  try { validatePolicy(prev.policy) } catch (e) {
    return [{ effect: 'cannot-compare', severity: 'disruptive', detail: `the active policy no longer validates: ${(e as Error).message.split('\n')[0]}` }]
  }
  const out: SwapEffect[] = []
  type P = { mode?: string; pools?: Record<string, { defaultTier?: string; models?: Array<{ model: string }> }>; aliases?: Record<string, string> }
  const pp = prev.policy as P
  const np = next.policy as P
  if (pp.mode !== np.mode) out.push({ effect: 'mode', severity: 'warn', detail: `mode ${pp.mode} -> ${np.mode}: lineages move at their next break point` })
  for (const [d, pool] of Object.entries(pp.pools ?? {})) {
    const nextPool = np.pools?.[d]
    if (!nextPool) { out.push({ effect: 'pool-removed', severity: 'disruptive', dialect: d as never, detail: `${d}: pool removed; its requests fail at once` }); continue }
    const nextModels = new Set((nextPool.models ?? []).map((m) => m.model))
    for (const m of pool.models ?? []) {
      if (!nextModels.has(m.model)) out.push({ effect: 'model-removed', severity: 'disruptive', dialect: d as never, model: m.model, detail: `${d}: ${m.model} removed; its pins fail at once with 400 pin-not-allowed` })
    }
    for (const m of nextPool.models ?? []) if (!(pool.models ?? []).some((x) => x.model === m.model)) out.push({ effect: 'model-added', severity: 'info', dialect: d as never, model: m.model, detail: `${d}: ${m.model} added` })
    if (pool.defaultTier !== nextPool.defaultTier) out.push({ effect: 'default-tier', severity: 'info', dialect: d as never, detail: `${d}: default tier ${pool.defaultTier} -> ${nextPool.defaultTier}; new lineages` })
  }
  for (const a of Object.keys(pp.aliases ?? {})) if (!(a in (np.aliases ?? {}))) out.push({ effect: 'alias-removed', severity: 'disruptive', detail: `alias ${a} removed; requests using it fail at once` })
  return out
}
