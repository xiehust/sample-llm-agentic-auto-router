// Effective runtime configuration (0d-effective-config.md §1, §4). Per section, effective = active document ??
// baked document (config/baked.json, the deploy-time configuration RouterStack stages with the same function the
// router boots from). There is no other default: when baked.json cannot be read, a baked-sourced section is
// 'unknown' and its values are absent; the console never guesses 'off' or 'observe'.
import type { ConfigSectionName, EffectiveSetting, EffectiveSettings, IdentityKeysState, ReportedConfig, SettingSource } from '@auto-router/console-contract'
import { hasAssessorAdapter } from '@auto-router/router'
import { BAKED_VERSION_RE, SECTIONS as ROUTER_SECTIONS, validateConfigDocument } from '@auto-router/router/settings'
import { HttpError } from './http.ts'
import { packInfo, runningPacks } from './routes/packs.ts'
import type { ConfigDocument, StoredVersion } from './local-types.ts'
import type { ConfigReport, Deps, StateReport } from './ports.ts'

export const BAKED_KEY = 'config/baked.json'
export const SECTIONS: readonly ConfigSectionName[] = ROUTER_SECTIONS
/** "0-baked.<sha8>" (0d §2, router BAKED_VERSION_RE); the legacy "0-baked" is accepted too. Group 1 = sha8. */
export const BAKED_VERSION = BAKED_VERSION_RE
const RECENT_MS = 7 * 86_400_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Per ObjectStore: the last baked.json read (ETag, parsed document) and whether its version was seeded. */
const cache = new WeakMap<object, { etag: string; doc?: ConfigDocument; seeded: boolean }>()

/**
 * A baked document as RouterStack stages it: version 0-baked[.<sha8>], valid by the router's own
 * validateConfigDocument (assessor block checked against the running image's packs, 0d review). Otherwise undefined
 * (treated as unreadable).
 */
async function bakedOf(text: string, deps: Deps): Promise<ConfigDocument | undefined> {
  let v: unknown
  try { v = JSON.parse(text) } catch { return undefined }
  if (!isObj(v) || typeof v.version !== 'string' || !BAKED_VERSION.test(v.version)) return undefined
  // bakedConfigDocument returns the router's runtime `seq` too: not a document field (drafts start from this).
  const { seq: _, ...doc } = v
  const packs = (await runningPacks(deps)).packs.map(packInfo)
  const r = validateConfigDocument(doc, deps.catalog, { assessor: { catalog: deps.catalog, packs, hasAdapter: hasAssessorAdapter } })
  if (!r.ok) { deps.log({ kind: 'console-api-baked-invalid', issues: r.issues.length }); return undefined }
  return doc as unknown as ConfigDocument
}

/**
 * The baked document (cached by ETag), undefined when missing or unreadable. On first read and on every ETag
 * change, seeds the console table with it at CONFIG / v#0#<sha8> (conditional put: idempotent, immutable), the key
 * ingest resolves "0-baked.<sha8>" to (0d §5).
 */
export async function bakedDocument(deps: Deps): Promise<ConfigDocument | undefined> {
  const prev = cache.get(deps.objects)
  let r: Awaited<ReturnType<Deps['objects']['getObject']>>
  try {
    r = await deps.objects.getObject(BAKED_KEY, prev?.etag)
  } catch (e) {
    deps.log({ kind: 'console-api-baked-unreadable', error: e instanceof Error ? e.name : 'unknown' })
    return undefined
  }
  if (r === 'not-modified' && prev) return prev.doc
  if (r === undefined || r === 'not-modified') { cache.delete(deps.objects); return undefined }
  const doc = await bakedOf(r.body, deps)
  const entry = { etag: r.etag, ...(doc ? { doc } : {}), seeded: false }
  cache.set(deps.objects, entry)
  const sha8 = doc ? BAKED_VERSION.exec(doc.version)?.[1]?.slice(1) : undefined
  if (doc && sha8) {
    try {
      await deps.console.seedBakedVersion(sha8, { meta: { version: doc.version, n: 0, author: 'cdk', createdAt: '', comment: 'deploy-time (baked) configuration', changed: [] }, document: doc })
      entry.seeded = true
    } catch (e) {
      deps.log({ kind: 'console-api-baked-seed-failed', error: e instanceof Error ? e.name : 'unknown' })
    }
  }
  return doc
}

export interface Effective {
  /** The active console-written document (n ≥ 1); absent when only the baked configuration is in force. */
  active?: StoredVersion
  baked?: ConfigDocument
  sources: Record<ConfigSectionName, SettingSource>
  /** Section values (absent when unknown). */
  values: Partial<Pick<ConfigDocument, ConfigSectionName>>
  /** Complete effective document (every section known): what a new draft starts from. */
  document?: ConfigDocument
  settings: EffectiveSettings
}

export async function effectiveConfig(deps: Deps): Promise<Effective> {
  const pointer = await deps.console.getActive()
  const active = pointer && pointer.n >= 1 ? await deps.console.getVersion(pointer.n) : undefined
  // ACTIVE names a console version that cannot be read: never silently show the baked values instead (0d review).
  if (pointer && pointer.n >= 1 && !active) throw new HttpError(503, 'config-unavailable', `the active version ${pointer.version} cannot be read`)
  const baked = await bakedDocument(deps)
  const sources = {} as Record<ConfigSectionName, SettingSource>
  const versions = {} as Record<ConfigSectionName, string | undefined>
  const values: Effective['values'] = {}
  for (const s of SECTIONS) {
    const fromDoc = active?.document[s]
    if (fromDoc !== undefined) { sources[s] = 'document'; versions[s] = active?.meta.version; (values as Obj)[s] = fromDoc; continue }
    const fromBaked = baked?.[s]
    if (fromBaked !== undefined) { sources[s] = 'baked'; versions[s] = baked?.version; (values as Obj)[s] = fromBaked; continue }
    sources[s] = 'unknown'
  }
  const policy = values.policy as Obj | undefined
  const assessor = values.assessor as Obj | undefined
  const setting = <T>(s: ConfigSectionName, value: unknown): EffectiveSetting<T> => (sources[s] === 'unknown'
    ? { source: 'unknown' }
    : { ...(value !== undefined ? { value: value as T } : {}), source: sources[s], ...(versions[s] ? { version: versions[s] } : {}) })
  const settings: EffectiveSettings = {
    identityMode: setting('identity', (values.identity as Obj | undefined)?.mode),
    routerMode: setting('policy', policy?.mode),
    policyVersion: setting('policy', policy?.version),
    assessorMode: setting('assessor', assessor?.mode),
    assessorPack: setting('assessor', assessor?.pack),
    assessorModel: setting('assessor', assessor?.model),
  }
  const complete = SECTIONS.every((s) => sources[s] !== 'unknown')
  const document = complete
    ? { schemaVersion: 1 as const, version: active?.meta.version ?? baked?.version ?? '', ...(values as Pick<ConfigDocument, ConfigSectionName>) } as ConfigDocument
    : undefined
  return { ...(active ? { active } : {}), ...(baked ? { baked } : {}), sources, values, ...(document ? { document } : {}), settings }
}

/** The latest config line per router task (last 7 days), with whether it matches the configured settings (0d §4.4). */
export function reportedConfigs(reports: readonly ConfigReport[], settings: EffectiveSettings, nowMs: number): ReportedConfig[] {
  const seen = new Set<string>()
  const out: ReportedConfig[] = []
  for (const r of reports) {
    if (seen.has(r.task) || nowMs - Date.parse(r.ts) > RECENT_MS) continue
    seen.add(r.task)
    const eff = isObj(r.effective) ? r.effective : undefined
    const pairs: Array<[unknown, EffectiveSetting<unknown>]> = eff ? [
      [eff.identityMode, settings.identityMode], [eff.assessorMode, settings.assessorMode], [eff.policyVersion, settings.policyVersion], [eff.mode, settings.routerMode],
    ] : []
    const comparable = pairs.filter(([rep]) => rep !== undefined)
    const known = comparable.every(([, conf]) => conf.source !== 'unknown')
    out.push({
      task: r.task, at: r.ts, ...(r.configVersion ? { configVersion: r.configVersion } : {}),
      ...(eff ? { effective: Object.fromEntries(Object.entries(eff).filter(([, v]) => typeof v === 'string')) as ReportedConfig['effective'] } : {}),
      ...(isObj(r.sources) ? { sources: r.sources as ReportedConfig['sources'] } : {}),
      ...(comparable.length && known ? { matches: comparable.every(([rep, conf]) => rep === conf.value) } : {}),
    })
  }
  return out
}

/** A state line older than this does not count (3 × the router's 5-min STATE_INTERVAL_MS). */
export const STATE_FRESH_MS = 15 * 60_000

/** The router state lines that count now (one per task, ts ≥ now − 15 min). */
export async function freshStates(deps: Deps): Promise<StateReport[]> {
  const now = deps.now()
  return (await deps.usage.stateReports()).filter((r) => now - Date.parse(r.ts) <= STATE_FRESH_MS).sort((a, b) => (a.ts < b.ts ? 1 : -1))
}

/**
 * identityKeysLoaded (0d-effective-config §7): at least one fresh task, no fewer fresh than running tasks, and every
 * fresh task reports identity configured and its keys loaded. Anything unknown counts as not loaded.
 */
export function identityKeysState(fresh: readonly StateReport[], running: number | undefined): IdentityKeysState {
  const withKeys = fresh.filter((r) => r.identityKeys?.configured === true && r.identityKeys.loaded === true).length
  const base = { fresh: fresh.length, ...(running !== undefined ? { running } : {}), withKeys }
  if (fresh.length === 0) return { loaded: false, reason: 'no-fresh-task', ...base }
  if (running === undefined || fresh.length < running) return { loaded: false, reason: 'partial', ...base }
  // not-configured only when the task says so; an absent identityKeys (17 stores it only when well-formed) is "keys
  // not loaded", never a reason to allow.
  const unconfigured = fresh.find((r) => r.identityKeys?.configured === false)
  if (unconfigured) return { loaded: false, reason: 'not-configured', ...base, task: unconfigured.task }
  const noKeys = fresh.find((r) => r.identityKeys?.loaded !== true)
  if (noKeys) return { loaded: false, reason: 'task-without-keys', ...base, task: noKeys.task }
  return { loaded: true, ...base }
}

export async function identityKeys(deps: Deps): Promise<IdentityKeysState> {
  const [fresh, running] = await Promise.all([freshStates(deps), deps.tasks.runningCount().catch(() => undefined)])
  return identityKeysState(fresh, running)
}

/** English detail for a refusal (the UI renders its own copy from the reason). */
export function identityKeysMessage(k: IdentityKeysState): string {
  switch (k.reason) {
    case 'no-fresh-task': return 'no router task has reported its state in the last 15 minutes'
    case 'partial': return k.running === undefined ? `${k.fresh} task(s) report state, but the running task count cannot be read` : `${k.fresh} of ${k.running} running tasks report state`
    case 'not-configured': return `identity is not configured on task ${k.task ?? '?'} (deploy with identity)`
    case 'task-without-keys': return `task ${k.task ?? '?'} has not loaded the user pool signing keys (jwks)`
    default: return 'identity keys loaded on every running task'
  }
}
