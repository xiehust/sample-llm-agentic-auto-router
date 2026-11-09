// `@auto-router/router/settings`: pure validators shared by the router and the console (PRD R3 "validated with the
// router's own validators"): the runtime configuration document (design §2.1), the principal file and access caps
// (design 0.16), and the assessor block (73 §1.1 / A2). Browser-safe: no node: built-ins, only
// `@auto-router/core/policy` and `@auto-router/pricing` (runtime.test.ts checks the import graph).
//
// Image-dependent inputs (the packs the image bundles, the assessor adapter check) are passed in by the caller:
// router = what its image bundles; console = the manifest of the image ECS reports as running.
import { checkPolicyAgainstCatalog, PolicyError, validateCap, validatePolicy, type Cap, type Policy } from '@auto-router/core/policy'
import { findModel, type ModelPrice, type PriceCatalog } from '@auto-router/pricing'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ================================================================ assessor block (C4, 73)

export type AssessorMode = 'off' | 'observe' | 'auto'
export type AutoRules = 'pack' | 'all'

/** The assessor block of an active (observe | auto) configuration: every field present. */
export interface ActiveAssessorSettings {
  mode: 'observe' | 'auto'
  pack: string
  /** The pack's version when the settings were saved (the console fills it); compared against the running packs. */
  packVersion?: string
  model: string
  threshold: number
  timeoutMs: number
  autoRules: AutoRules
}
/**
 * The config document's assessor block (design §2.1): one shape; with mode 'off' the other fields are kept (so
 * off → observe restores them) and may also be absent (a bare `{ mode: 'off' }`).
 */
export type AssessorSettingsDoc = ActiveAssessorSettings | ({ mode: 'off' } & Partial<Omit<ActiveAssessorSettings, 'mode'>>)

/** A pack the caller can run: name, render version, and whether some enabled rule is auto:true. */
export interface PackInfo { name: string; packVersion: string; autoCapable: boolean }

export interface AssessorSettingsContext {
  catalog: PriceCatalog
  packs: readonly PackInfo[]
  /** True when the assessor has an adapter for this model (router/console: `selectAdapter` from the assessor). */
  hasAdapter: (price: ModelPrice) => boolean
  /**
   * Models the task role may invoke. Absent: not checked (the router's runtime path: IAM-universe membership is a
   * console check, design 0.9; a model outside it fails as assessor 'unavailable', never an outage).
   */
  invokableModels?: ReadonlySet<string>
  /** How invokableModels is described in messages (default "the policy's models"). */
  invokableLabel?: string
  /**
   * packVersion differs from the running pack: 'warn' (router: apply the bundled pack and report drift) or 'error'
   * (console: the admin must review the rules of the running image and re-save). Default 'warn'.
   */
  packVersionMismatch?: 'warn' | 'error'
  /**
   * Mode 'off': image-dependent findings (pack-unknown, model-not-in-catalog, model-no-adapter) on the kept fields
   * are 'warn' (router: an off assessor never builds, so they cannot break it) or 'error' (console: the block must
   * stay activatable). Default 'warn'.
   */
  offImageChecks?: 'warn' | 'error'
}

export type SettingsField = keyof AssessorSettingsDoc | 'document'
export type SettingsCode =
  | 'object-required' | 'unexpected-key' | 'mode-invalid' | 'pack-unknown' | 'pack-version-drift' | 'pack-version-invalid'
  | 'model-invalid' | 'model-not-in-catalog' | 'model-no-adapter' | 'model-not-invokable' | 'threshold-invalid'
  | 'timeout-invalid' | 'auto-rules-invalid' | 'auto-cannot-act'

/** One finding. `code` is stable (console i18n key `settings.<code>`); `message` is English detail for logs. */
export interface SettingsIssue { field: SettingsField; code: SettingsCode; message: string }

export type SettingsResult =
  | { ok: true; value: AssessorSettingsDoc; warnings: SettingsIssue[] }
  | { ok: false; issues: SettingsIssue[]; warnings: SettingsIssue[] }

export const ASSESSOR_LIMITS = { timeoutMinMs: 100, timeoutMaxMs: 10_000 } as const
const MODES: readonly AssessorMode[] = ['off', 'observe', 'auto']
const KEYS: ReadonlySet<string> = new Set(['mode', 'pack', 'packVersion', 'model', 'threshold', 'timeoutMs', 'autoRules'])
/** Bedrock model / inference-profile id shape (no spaces, bounded); the catalog check decides the rest. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const PACK_VERSION = /^[a-z0-9/._-]{1,60}\+[0-9a-f]{12}$/

const show = (v: unknown): string => (typeof v === 'string' ? `'${v.slice(0, 80)}'` : typeof v === 'number' ? String(v) : typeof v)

/** Findings that depend on the image the router runs (its packs, catalog and adapters). */
const IMAGE_CODES: ReadonlySet<SettingsCode> = new Set(['pack-unknown', 'model-not-in-catalog', 'model-no-adapter'])

/**
 * Validates the assessor block. Fields present are checked also when mode is off (a stored block stays valid for
 * off → observe); with mode off, absent fields are allowed and image-dependent findings follow `offImageChecks`.
 * Errors make `ok` false; warnings never do.
 */
export function validateAssessorSettings(raw: unknown, ctx: AssessorSettingsContext): SettingsResult {
  const issues: SettingsIssue[] = []
  const warnings: SettingsIssue[] = []
  if (!isObj(raw)) return { ok: false, issues: [{ field: 'document', code: 'object-required', message: 'assessor: object required' }], warnings }
  const off = raw.mode === 'off'
  const bad = (field: SettingsField, code: SettingsCode, message: string) => {
    const f = { field, code, message }
    if (off && IMAGE_CODES.has(code) && (ctx.offImageChecks ?? 'warn') === 'warn') warnings.push(f)
    else issues.push(f)
  }
  /** With mode off a field may be absent; otherwise it is required (and then checked). */
  const present = (k: keyof ActiveAssessorSettings): boolean => !(off && raw[k] === undefined)
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) bad('document', 'unexpected-key', `unexpected key ${k.slice(0, 40)}`)

  const mode = raw.mode
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) bad('mode', 'mode-invalid', `'off' | 'observe' | 'auto', got ${show(mode)}`)

  const packName = raw.pack
  const pack = typeof packName === 'string' ? ctx.packs.find((p) => p.name === packName) : undefined
  if (present('pack') && !pack) bad('pack', 'pack-unknown', `one of ${ctx.packs.map((p) => p.name).join(' | ') || '(none)'}, got ${show(packName)}`)

  const packVersion = raw.packVersion
  if (packVersion !== undefined) {
    if (typeof packVersion !== 'string' || !PACK_VERSION.test(packVersion)) bad('packVersion', 'pack-version-invalid', `'<pack id>+<12 hex>' required, got ${show(packVersion)}`)
    else if (pack && packVersion !== pack.packVersion) {
      const f: SettingsIssue = { field: 'packVersion', code: 'pack-version-drift', message: `pack ${pack.name} is ${pack.packVersion} here, the settings were saved for ${packVersion}` }
      if ((ctx.packVersionMismatch ?? 'warn') === 'error') issues.push(f)
      else warnings.push(f)
    }
  }

  const model = raw.model
  if (present('model')) {
    if (typeof model !== 'string' || !MODEL_ID.test(model)) bad('model', 'model-invalid', `model id required, got ${show(model)}`)
    else {
      const price = findModel(ctx.catalog, model)
      if (!price) bad('model', 'model-not-in-catalog', `'${model}' is not in the ${ctx.catalog.region} catalog`)
      else {
        if (!ctx.hasAdapter(price)) bad('model', 'model-no-adapter', `'${model}' has no assessor adapter (dialects ${price.dialects.join(', ')})`)
        if (ctx.invokableModels && !ctx.invokableModels.has(model)) {
          bad('model', 'model-not-invokable', `'${model}' is not one of ${ctx.invokableLabel ?? "the policy's models"} (the task role may invoke only those)`)
        }
      }
    }
  }

  const threshold = raw.threshold
  if (present('threshold') && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    bad('threshold', 'threshold-invalid', `number in [0, 1] required, got ${show(threshold)}`)
  }

  const timeoutMs = raw.timeoutMs
  const { timeoutMinMs: lo, timeoutMaxMs: hi } = ASSESSOR_LIMITS
  if (present('timeoutMs') && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < lo || timeoutMs > hi)) {
    bad('timeoutMs', 'timeout-invalid', `integer ${lo}..${hi} required, got ${show(timeoutMs)}`)
  }

  const autoRules = raw.autoRules
  if (present('autoRules') && autoRules !== 'pack' && autoRules !== 'all') bad('autoRules', 'auto-rules-invalid', `'pack' | 'all', got ${show(autoRules)}`)

  if (mode === 'auto' && autoRules === 'pack' && pack && !pack.autoCapable) {
    bad('autoRules', 'auto-cannot-act', `every rule of pack ${pack.name} is auto:false, so with autoRules 'pack' the assessor could never act; `
      + "use observe, or autoRules 'all' (every enabled rule and fact signal auto-eligible; experiment switch)")
  }

  if (issues.length > 0) return { ok: false, issues, warnings }
  // Only the known keys, in a fixed order; absent fields stay absent (mode off).
  const value: Record<string, unknown> = { mode }
  for (const k of ['pack', 'packVersion', 'model', 'threshold', 'timeoutMs', 'autoRules'] as const) if (raw[k] !== undefined) value[k] = raw[k]
  return { ok: true, value: value as AssessorSettingsDoc, warnings }
}

// ================================================================ configuration document and principals (C3, 0d)

export type { Cap } from '@auto-router/core/policy'
export const GROUPS = ['admin', 'member', 'service'] as const
export type GroupName = (typeof GROUPS)[number]
export type IdentityMode = 'off' | 'observe' | 'require'

/** Version of the CDK-baked policy when no document exists (seeded in the console table under the same name). */
export const BAKED_VERSION = '0-baked'

export interface ConfigDocument {
  schemaVersion: 1
  /** "<n>-<author-ts>" (n ≥ 1) or BAKED_VERSION. Ordered by `seq`, never by string compare. */
  version: string
  seq: number
  policy: Policy
  /** Opaque here; validated by the assessor builder (C4: validateAssessorSettings + the image's packs). */
  assessor?: Record<string, unknown>
  /** Identity settings (C2). Only `mode` is checked here; other fields pass through. */
  identity?: { mode: IdentityMode } & Record<string, unknown>
  access: { groups: Partial<Record<GroupName, Cap>> }
}

export type Checked<T> = { ok: true; value: T; warnings?: string[] } | { ok: false; issues: string[] }

const DOC_KEYS = ['schemaVersion', 'version', 'policy', 'assessor', 'identity', 'access']

/** `n` of "<n>-<suffix>" (n a non-negative integer without leading zeros), else undefined. */
export function parseConfigVersion(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^(0|[1-9]\d{0,15})-[A-Za-z0-9:._+-]{1,64}$/.exec(v)
  return m ? Number(m[1]) : undefined
}

/**
 * Validates a configuration document against the router's catalog: shape, version, policy (validatePolicy +
 * checkPolicyAgainstCatalog), identity mode and access caps, and the assessor block when `opts.assessor` gives the
 * packs to check it against. Every issue is reported. The result never depends on a previous document (design 0.9:
 * no diff-based rejection).
 */
export function validateConfigDocument(raw: unknown, catalog: PriceCatalog, opts: { assessor?: AssessorSettingsContext } = {}): Checked<ConfigDocument> {
  const issues: string[] = []
  const warnings: string[] = []
  if (!isObj(raw)) return { ok: false, issues: ['document: object required'] }
  for (const k of Object.keys(raw)) if (!DOC_KEYS.includes(k)) issues.push(`${k}: unknown field`)
  if (raw.schemaVersion !== 1) issues.push('schemaVersion: 1 required')
  const seq = parseConfigVersion(raw.version)
  if (seq === undefined) issues.push(`version: "<n>-<suffix>" required, got ${JSON.stringify(raw.version)?.slice(0, 80)}`)
  let policy: Policy | undefined
  try {
    policy = validatePolicy(raw.policy)
    checkPolicyAgainstCatalog(policy, catalog)
  } catch (e) {
    if (e instanceof PolicyError) issues.push(...e.issues.map((i) => `policy.${i}`))
    else issues.push(`policy: ${(e as Error).message}`)
  }
  let assessor: Record<string, unknown> | undefined
  if (raw.assessor !== undefined) {
    if (!isObj(raw.assessor)) issues.push('assessor: object required')
    else if (opts.assessor) {
      // With the caller's packs (console: the running image's manifest) the block is checked here too; the router
      // checks it in its AssessorBuilder with the packs it preloaded.
      const r = validateAssessorSettings(raw.assessor, opts.assessor)
      for (const w of r.warnings) warnings.push(`assessor.${w.field}: ${w.code}: ${w.message}`)
      if (r.ok) assessor = r.value as unknown as Record<string, unknown>
      else issues.push(...r.issues.map((i) => `assessor.${i.field}: ${i.code}: ${i.message}`))
    } else assessor = raw.assessor
  }
  let identity: ConfigDocument['identity']
  if (raw.identity !== undefined) {
    if (!isObj(raw.identity)) issues.push('identity: object required')
    else if (raw.identity.mode !== 'off' && raw.identity.mode !== 'observe' && raw.identity.mode !== 'require') issues.push(`identity.mode: 'off' | 'observe' | 'require'`)
    else identity = raw.identity as ConfigDocument['identity']
  }
  const access: ConfigDocument['access'] = { groups: {} }
  if (raw.access !== undefined) {
    if (!isObj(raw.access)) issues.push('access: object required')
    else {
      for (const k of Object.keys(raw.access)) if (k !== 'groups') issues.push(`access.${k}: unknown field (groups)`)
      const g = raw.access.groups
      if (g !== undefined && !isObj(g)) issues.push('access.groups: object required')
      else for (const [name, cap] of Object.entries(g ?? {})) {
        if (!(GROUPS as readonly string[]).includes(name)) { issues.push(`access.groups.${name}: unknown group (${GROUPS.join('|')})`); continue }
        const c = validateCap(cap, `access.groups.${name}`, issues)
        if (c) access.groups[name as GroupName] = c
      }
    }
  }
  if (issues.length > 0 || !policy || seq === undefined) return { ok: false, issues }
  const doc: ConfigDocument = { schemaVersion: 1, version: raw.version as string, seq, policy, access }
  if (assessor) doc.assessor = assessor
  if (identity) doc.identity = identity
  return { ok: true, value: doc, ...(warnings.length ? { warnings } : {}) }
}

/**
 * Legacy baked document (`"0-baked"`, policy only): routers without a config source in tests and harnesses. A deployed
 * router boots from bakedConfigDocument; `"0-baked"` stays a readable version for lines logged before it.
 */
export function bakedDocument(policy: Policy): ConfigDocument {
  return { schemaVersion: 1, version: BAKED_VERSION, seq: 0, policy, access: { groups: {} } }
}

// ---------------------------------------------------------------- the baked document (0d research 0d-effective-config.md)

/** A baked version: the legacy `"0-baked"`, or `"0-baked.<sha8>"` (content-addressed). */
export const BAKED_VERSION_RE = /^0-baked(\.[0-9a-f]{8})?$/
export const isBakedVersion = (v: string): boolean => BAKED_VERSION_RE.test(v)

/**
 * Deterministic JSON: object keys sorted at every level, arrays in order, no whitespace, `undefined` members dropped
 * (as JSON.stringify does). Input to the baked version hash, so the router and the deploy compute the same version.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/**
 * The router's ROUTER_ASSESSOR_* defaults (config.ts ASSESSOR_DEFAULTS; a test keeps them equal). Here so that the
 * deploy can derive the baked assessor block from the same env without importing the assessor package.
 */
export const ASSESSOR_ENV_DEFAULTS = { model: 'global.openai.gpt-6-luna', threshold: 0.8, pack: 'v2.2', timeoutMs: 5000, autoRules: 'pack' } as const

/** The router env keys the baked document reads (a subset of the task definition's environment). */
export type BakedEnv = Readonly<Partial<Record<
  'ROUTER_IDENTITY_MODE' | 'ROUTER_ASSESSOR_MODE' | 'ROUTER_ASSESSOR_MODEL' | 'ROUTER_ASSESSOR_THRESHOLD' | 'ROUTER_ASSESSOR_PACK'
  | 'ROUTER_ASSESSOR_TIMEOUT_MS' | 'ROUTER_ASSESSOR_AUTO_RULES', string | undefined>>>

const envNum = (raw: string | undefined, dflt: number): number => (raw === undefined || raw === '' ? dflt : Number(raw))

/**
 * The deploy-time assessor block, from the env exactly as config.ts reads it: `{ mode: 'off' }`, or every field with
 * the env defaults applied and `packVersion` of the bundled pack (from `packs`: the image's packs, or the committed
 * manifest at synth). Not validated here: the router validated the same env at boot (loadConfig).
 */
export function bakedAssessorBlock(env: BakedEnv, packs: readonly PackInfo[]): AssessorSettingsDoc {
  const mode = env.ROUTER_ASSESSOR_MODE || 'off'
  if (mode !== 'observe' && mode !== 'auto') return { mode: 'off' }
  const d = ASSESSOR_ENV_DEFAULTS
  const pack = env.ROUTER_ASSESSOR_PACK || d.pack
  const packVersion = packs.find((p) => p.name === pack)?.packVersion
  return {
    mode, pack, ...(packVersion ? { packVersion } : {}), model: env.ROUTER_ASSESSOR_MODEL || d.model,
    threshold: envNum(env.ROUTER_ASSESSOR_THRESHOLD, d.threshold), timeoutMs: envNum(env.ROUTER_ASSESSOR_TIMEOUT_MS, d.timeoutMs),
    autoRules: (env.ROUTER_ASSESSOR_AUTO_RULES || d.autoRules) as AutoRules,
  }
}

export interface BakedInputs {
  /** The validated deploy policy (validatePolicy of the CDK policy file: router config.policy / infra models.policy). */
  policy: Policy
  /** The router env as the deploy sets it (process.env in the router; the task definition's environment at synth). */
  env: BakedEnv
  /** The packs the image bundles (router: packInfos(config.packs); synth: the committed manifest's entries). */
  packs: readonly PackInfo[]
}

/**
 * The complete baked document (every section): what the router runs, section by section, when the active document is
 * absent or lacks that section. `version` = `"0-baked." + sha256Hex(canonicalJson(content))[:8]`, `sha256Hex` being the
 * caller's (node:crypto in the router and at synth; this module stays free of node: built-ins). The router builds
 * generation 0 from it; RouterStack stages the same document as config/baked.json, so both are identical by construction.
 */
export function bakedConfigDocument(inputs: BakedInputs, sha256Hex: (text: string) => string): ConfigDocument {
  const content = {
    schemaVersion: 1 as const,
    policy: inputs.policy,
    assessor: bakedAssessorBlock(inputs.env, inputs.packs) as unknown as Record<string, unknown>,
    identity: { mode: identityModeOf(inputs.env.ROUTER_IDENTITY_MODE) },
    access: { groups: {} },
  }
  const version = `0-baked.${sha256Hex(canonicalJson(content)).slice(0, 8)}`
  return { ...content, version, seq: 0 }
}

/** ROUTER_IDENTITY_MODE as the router reads it: unset or empty → 'off' (identity not configured). */
function identityModeOf(raw: string | undefined): IdentityMode {
  return raw === 'observe' || raw === 'require' ? raw : 'off'
}

/** Where each runtime section came from (config lines `sources`, console source badges). */
export type SectionSource = 'document' | 'baked'
export const SECTIONS = ['policy', 'identity', 'assessor', 'access'] as const
export type Section = (typeof SECTIONS)[number]

// ---------------------------------------------------------------- principals (identity/principals.json)

export interface PrincipalEntry { group?: GroupName; cap?: Cap }
/** Principal key "<kind>:<id>", kind user | client (the verified principal of C2). */
export type Principals = ReadonlyMap<string, PrincipalEntry>
// Cognito client ids are ClientIdType `[\w+]+` (1-128): '+' must be accepted, or a valid client could never be listed.
const PRINCIPAL_KEY = /^(user|client):[A-Za-z0-9._+-]{1,128}$/

/**
 * `{ "<kind>:<id>": { group?, cap? } }`. Only a non-object rejects the file; an invalid entry is skipped (counted in
 * `warnings`). A group missing from the active document's access.groups is not an error here (the document may
 * change independently): resolveCap reports it.
 */
export function validatePrincipals(raw: unknown): Checked<Principals> {
  if (!isObj(raw)) return { ok: false, issues: ['principals: object required'] }
  // A bad entry is skipped, never the file: one odd key must not freeze every other group and cap (the console
  // validates keys before writing, so a skip means a hand edit). `warnings` holds one detail per skipped entry.
  const out = new Map<string, PrincipalEntry>()
  const warnings: string[] = []
  for (const [key, v] of Object.entries(raw)) {
    const at = `principals.${key.slice(0, 140)}`
    const issues: string[] = []
    if (!PRINCIPAL_KEY.test(key)) issues.push(`${at}: key "<user|client>:<id>" required`)
    else if (!isObj(v)) issues.push(`${at}: object required`)
    else {
      for (const k of Object.keys(v)) if (k !== 'group' && k !== 'cap') issues.push(`${at}.${k}: unknown field (group | cap)`)
      const e: PrincipalEntry = {}
      if (v.group !== undefined) {
        if ((GROUPS as readonly unknown[]).includes(v.group)) e.group = v.group as GroupName
        else issues.push(`${at}.group: one of ${GROUPS.join('|')}`)
      }
      if (v.cap !== undefined) {
        const c = validateCap(v.cap, `${at}.cap`, issues)
        if (c) e.cap = c
      }
      if (issues.length === 0) out.set(key, e)
    }
    if (issues.length > 0) warnings.push(issues.join('; '))
  }
  return { ok: true, value: out, ...(warnings.length ? { warnings } : {}) }
}

export interface ResolvedCap { cap?: Cap; source: 'principal' | 'group' | 'none'; issue?: 'unknown-group' }

/**
 * Precedence principal > group > none (design 0.16). A principal without an entry, or with no cap and no group,
 * has no cap. A group that the document does not define gives no cap and the issue code 'unknown-group' (logged,
 * never a rejection).
 */
export function resolveCap(access: ConfigDocument['access'], principals: Principals, principal: string | undefined): ResolvedCap {
  if (principal === undefined) return { source: 'none' }
  const e = principals.get(principal)
  if (e?.cap) return { cap: e.cap, source: 'principal' }
  if (e?.group === undefined) return { source: 'none' }
  const g = access.groups[e.group]
  return g ? { cap: g, source: 'group' } : { source: 'none', issue: 'unknown-group' }
}
