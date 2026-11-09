// The runtime assessor (admin console C4, research 73 §1.2–1.3, A1–A6): 0d's AssessorBuilder seam. A config
// document's assessor block is validated against the packs preloaded at boot (validateAssessorSettings: the same
// validator the console uses) and turned into a RouterAssessor; an absent block keeps the env (deploy-time)
// assessor. Instances are reused across generations while the settings are unchanged, so a policy-only change keeps
// the same assessor (and core's per-turn reuse). Config lines carry the assessor settings, the image's packs and,
// when the document names a pack version the image does not bundle, the drift (warn and apply).
import type { BundledPack, PackName } from '@auto-router/assessor'
import type { PriceCatalog } from '@auto-router/pricing'
import type { Transport } from '@auto-router/assessor'
import { createRouterAssessor, type AssessorSettings, type RouterAssessor, type RouterAssessorConfig } from './assessor.ts'
import { hasAssessorAdapter, packInfos } from './config.ts'
import type { AssessorBuilder, Generation } from './runtime.ts'
import { validateAssessorSettings, type ConfigDocument } from './settings.ts'

export interface Drift { pack: string; expected: string; loaded: string }

export interface AssessorRuntime {
  build: AssessorBuilder
  /** `config` line fields (runtime lineFields): assessor settings, bundled packs, drift. */
  lineFields: (g: Generation) => Record<string, unknown>
  /** The env (deploy-time) assessor, built once at boot; used when a document has no assessor block. */
  readonly envAssessor: RouterAssessor | undefined
}

const key = (s: AssessorSettings): string => JSON.stringify([s.packName, s.model, s.threshold, s.timeoutMs, s.autoRules, s.mode])

export function settingsView(a: RouterAssessor | undefined): Record<string, unknown> {
  if (!a) return { mode: 'off' }
  const s = a.settings
  return { id: a.id.split('#', 1)[0], mode: s.mode, pack: s.packName, packVersion: a.packVersion, model: s.model, threshold: s.threshold, timeoutMs: s.timeoutMs, autoRules: s.autoRules }
}

export function createAssessorRuntime(o: {
  env: RouterAssessorConfig
  packs: ReadonlyMap<PackName, BundledPack>
  catalog: PriceCatalog
  transport: Transport
  /** How many distinct settings to keep built (oldest dropped); a swap back and forth reuses them. */
  maxCached?: number
}): AssessorRuntime {
  const infos = packInfos(o.packs)
  const cache = new Map<string, RouterAssessor>()
  const drifts = new WeakMap<ConfigDocument, Drift>()
  const max = o.maxCached ?? 8
  const instance = (s: AssessorSettings): RouterAssessor => {
    const k = key(s)
    let a = cache.get(k)
    if (!a) {
      a = createRouterAssessor(s, { transport: o.transport, catalog: o.catalog })
      cache.set(k, a)
      while (cache.size > max) { const first = cache.keys().next().value; if (first === undefined) break; cache.delete(first) }
    }
    return a
  }
  const envAssessor = o.env.mode === 'off' ? undefined : instance(o.env)

  const build: AssessorBuilder = (doc) => {
    if (doc.assessor === undefined) return { ok: true, ...(envAssessor ? { assessor: envAssessor } : {}) }
    // The router context: pack drift and stale fields of an off block warn (design 0.9: warn and apply); IAM
    // universe membership is the console's check (a model outside it fails as 'unavailable', never an outage).
    const r = validateAssessorSettings(doc.assessor, { catalog: o.catalog, packs: infos, hasAdapter: hasAssessorAdapter })
    const warnings = r.warnings.map((w) => `assessor.${w.field}: ${w.code}: ${w.message}`)
    if (!r.ok) return { ok: false, issues: r.issues.map((i) => `assessor.${i.field}: ${i.code}: ${i.message}`) }
    const v = r.value
    if (v.mode === 'off') return { ok: true, ...(warnings.length ? { warnings } : {}) }
    const bundled = o.packs.get(v.pack as PackName) as BundledPack // validated against infos
    if (v.packVersion !== undefined && v.packVersion !== bundled.packVersion) drifts.set(doc, { pack: bundled.name, expected: v.packVersion, loaded: bundled.packVersion })
    const assessor = instance({ mode: v.mode, model: v.model, threshold: v.threshold, packName: bundled.name, pack: bundled.pack, timeoutMs: v.timeoutMs, autoRules: v.autoRules })
    return { ok: true, assessor, ...(warnings.length ? { warnings } : {}) }
  }

  const packs = [...o.packs.values()].map((p) => ({ name: p.name, packVersion: p.packVersion }))
  const lineFields = (g: Generation): Record<string, unknown> => {
    const drift = drifts.get(g.document)
    return { assessor: settingsView(g.assessor), packs, ...(drift ? { drift } : {}) }
  }
  return { build, lineFields, envAssessor }
}
