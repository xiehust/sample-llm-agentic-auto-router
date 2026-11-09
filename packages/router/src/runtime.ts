// Generation holder (admin console design 0.9, §2.1; 0d research §2; 73 A3). A generation is one immutable snapshot
// of everything a request needs from the runtime configuration: the document, the engine built for its policy,
// the assessor, the derived model sets and the principal file. A request takes `current()` once and uses that
// object to the end (invariant I1), so a swap never changes a request in flight (I2). Swapping builds a new Engine
// over the same StateStore: lineage state is policy-independent and is never migrated or flushed (I5).
import { createEngine, type Engine, type EngineOptions, type Policy, type StateStore } from '@auto-router/core'
import type { PriceCatalog } from '@auto-router/pricing'
import type { LogSink } from './account.ts'
import type { RouterAssessor } from './assessor.ts'
import { allowedModels } from './models.ts'
import { SECTIONS, validateConfigDocument, validatePrincipals, type ConfigDocument, type IdentityMode, type Principals, type Section, type SectionSource } from './settings.ts'

export interface Generation {
  readonly configVersion: string
  readonly seq: number
  /** Etag of identity/principals.json, or 'none' before one was read. */
  readonly principalsVersion: string
  readonly document: ConfigDocument
  readonly policy: Policy
  readonly engine: Engine
  readonly assessor?: RouterAssessor
  /** Concrete ids a client may pin under this policy (catalog ∩ pools, failover profiles, observe defaults). */
  readonly pinAllowed: ReadonlySet<string>
  readonly aliases: ReadonlySet<string>
  readonly principals: Principals
  /** Per section: from the active document, or the baked (deploy-time) value (0d-effective-config.md §1). */
  readonly sources: Readonly<Record<Section, SectionSource>>
}

/**
 * Builds the assessor for a document (C4 replaces the default with validateAssessorSettings + the preloaded packs).
 * `ok: false` rejects the document (image-dependent failures, design 0.9); warnings are logged, never rejections.
 */
export type AssessorBuilder = (doc: ConfigDocument) => { ok: true; assessor?: RouterAssessor; warnings?: string[] } | { ok: false; issues: string[] }

export interface RuntimeOptions {
  catalog: PriceCatalog
  store: StateStore
  sink: LogSink
  buildAssessor: AssessorBuilder
  now?: () => number
  /** Engine factory (tests wrap engines); default createEngine over `store` with the assessor's engineOptions. */
  engineFor?: (policy: Policy, assessor: RouterAssessor | undefined) => Engine
  engineOptions?: Partial<EngineOptions>
  /** Extra fields for `config` lines (C2: blocks etag; C4: packs, drift). */
  lineFields?: Array<(g: Generation) => Record<string, unknown>>
}

export type ApplyOutcome = 'applied' | 'rejected' | 'ignored'
export interface ApplyResult { outcome: ApplyOutcome; issues?: string[]; warnings?: string[] }

export interface RuntimeRef {
  current(): Generation
  /** Validates and activates a configuration document (parsed JSON or its text). Logs one `config` line unless a no-op. */
  applyDocument(raw: unknown): ApplyResult
  /** Replaces the principal file (parsed JSON or text) with etag `version`. Invalid: keeps the last good one. */
  applyPrincipals(raw: unknown, version: string): ApplyResult
  /** Writes a `config` line for the current generation (boot, or a source event such as an absent object). */
  log(source: string, outcome: string, extra?: Record<string, unknown>): void
}

const MAX_ISSUES = 20
const clip = (xs: string[] | undefined): string[] | undefined => xs && xs.length ? xs.slice(0, MAX_ISSUES).map((x) => x.slice(0, 300)) : undefined

function parse(raw: unknown): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  if (typeof raw !== 'string') return { ok: true, value: raw }
  try { return { ok: true, value: JSON.parse(raw) } } catch { return { ok: false, issues: ['document: invalid JSON'] } }
}

/** Groups named in the principal file that the generation's document does not define (those principals get no cap). */
function unknownGroups(g: Generation): string[] {
  return [...new Set([...g.principals.values()].flatMap((e) => (e.group && !g.document.access.groups[e.group] ? [e.group] : [])))]
}

/** Creates the holder with `boot` as generation 0. Throws when the boot document cannot be built (exit 1). */
export function createRuntime(boot: ConfigDocument, opts: RuntimeOptions): RuntimeRef {
  const now = opts.now ?? Date.now
  const engineFor = opts.engineFor ?? ((policy: Policy, a: RouterAssessor | undefined) =>
    createEngine({ policy, catalog: opts.catalog, store: opts.store, ...a?.engineOptions, ...opts.engineOptions }))

  const build = (doc: ConfigDocument, principals: Principals, principalsVersion: string, sources: Generation['sources']): { gen: Generation; warnings?: string[] } | { issues: string[] } => {
    const a = opts.buildAssessor(doc)
    if (!a.ok) return { issues: a.issues }
    let engine: Engine
    try { engine = engineFor(doc.policy, a.assessor) } catch (e) { return { issues: [`engine: ${(e as Error).message}`] } }
    const gen: Generation = {
      configVersion: doc.version, seq: doc.seq, principalsVersion, document: doc, policy: doc.policy, engine,
      ...(a.assessor ? { assessor: a.assessor } : {}),
      pinAllowed: allowedModels(doc.policy, opts.catalog), aliases: new Set(Object.keys(doc.policy.aliases)), principals, sources,
    }
    return { gen, ...(a.warnings?.length ? { warnings: a.warnings } : {}) }
  }

  const allBaked = Object.fromEntries(SECTIONS.map((k) => [k, 'baked'])) as Record<Section, SectionSource>
  const first = build(boot, new Map(), 'none', allBaked)
  if ('issues' in first) throw new Error(`boot configuration ${boot.version} rejected:\n  - ${first.issues.join('\n  - ')}`)
  let gen = first.gen

  const line = (g: Generation, source: string, outcome: string, extra: Record<string, unknown> = {}): void => {
    const fields: Record<string, unknown> = {}
    for (const f of opts.lineFields ?? []) Object.assign(fields, f(g))
    // What the router runs, codes and versions only (0d-effective-config.md §3): a section the document lacks is baked.
    const identityMode: IdentityMode = g.document.identity?.mode ?? boot.identity?.mode ?? 'off'
    const effective = { identityMode, assessorMode: g.assessor?.settings.mode ?? 'off', policyVersion: g.policy.version, mode: g.policy.mode }
    opts.sink(JSON.stringify({
      ts: new Date(now()).toISOString(), kind: 'config', source, outcome,
      configVersion: g.configVersion, principalsVersion: g.principalsVersion, policyVersion: g.policy.version, mode: g.policy.mode,
      catalogVersion: opts.catalog.version, effective, sources: g.sources, ...fields, ...extra,
    }))
  }

  return {
    current: () => gen,
    applyDocument(raw) {
      const p = parse(raw)
      const checked = p.ok ? validateConfigDocument(p.value, opts.catalog) : p
      if (!checked.ok) {
        const issues = clip(checked.issues)
        line(gen, 'config', 'rejected', { ...(issues ? { issues } : {}) })
        return { outcome: 'rejected', ...(issues ? { issues } : {}) }
      }
      const doc = checked.value
      if (doc.seq <= gen.seq) {
        // Equal: the same version again (no-op, silent). Lower: a stale read or an out-of-order write; never applied.
        if (doc.seq < gen.seq) line(gen, 'config', 'ignored', { attempted: doc.version, issues: ['version: not newer than the active one'] })
        return { outcome: 'ignored' }
      }
      const raw0 = (p.ok ? p.value : {}) as Record<string, unknown>
      const sources = Object.fromEntries(SECTIONS.map((k) => [k, raw0[k] !== undefined ? 'document' : 'baked'])) as Record<Section, SectionSource>
      const b = build(doc, gen.principals, gen.principalsVersion, sources)
      if ('issues' in b) {
        const issues = clip(b.issues)
        line(gen, 'config', 'rejected', { attempted: doc.version, ...(issues ? { issues } : {}) })
        return { outcome: 'rejected', ...(issues ? { issues } : {}) }
      }
      const from = gen.configVersion
      gen = b.gen
      const warnings = clip([...(b.warnings ?? []), ...unknownGroups(gen).map((g) => `unknown-group:${g}`)])
      line(gen, 'config', 'applied', { from, ...(warnings ? { warnings } : {}) })
      return { outcome: 'applied', ...(warnings ? { warnings } : {}) }
    },
    applyPrincipals(raw, version) {
      const p = parse(raw)
      const checked = p.ok ? validatePrincipals(p.value) : p
      if (!checked.ok) {
        const issues = clip(checked.issues)
        line(gen, 'principals', 'rejected', { attempted: version, ...(issues ? { issues } : {}) })
        return { outcome: 'rejected', ...(issues ? { issues } : {}) }
      }
      if (version === gen.principalsVersion) return { outcome: 'ignored' }
      gen = { ...gen, principals: checked.value, principalsVersion: version }
      // Groups the active document does not define: no cap for those principals (resolveCap), logged here.
      const unknown = unknownGroups(gen)
      // Skipped entries: code and count only (the details name principal ids; the console shows them on its side).
      const skipped = checked.warnings?.length ?? 0
      const codes = [...(skipped ? ['entry-invalid'] : []), ...unknown.map((g) => `unknown-group:${g}`)]
      line(gen, 'principals', 'applied', { principals: checked.value.size, ...(skipped ? { skipped } : {}), ...(codes.length ? { issues: codes } : {}) })
      return { outcome: 'applied' }
    },
    log: (source, outcome, extra) => line(gen, source, outcome, extra),
  }
}
