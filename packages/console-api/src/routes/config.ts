// Config state, drafts, versions, validation, activation and redelivery (design v1 §2.1, research 73 §1). Every
// activation is a new immutable version: one DynamoDB transaction writes the version and moves ACTIVE (conditional on
// the editor's baseVersion), then the document is delivered to S3 (`config/versions/<n>.json`, then
// `config/active.json`), where the router polls it. A failed delivery leaves ACTIVE undelivered; POST
// config/redeliver repeats it.
import type { ActivateResponse, ConfigState, ConfigVersionMeta, Page, RouterConfigState, SwapEffect, ValidateResponse } from '@auto-router/console-contract'
import { policySwapEffects, validatePolicy } from '@auto-router/core/policy'
import { hasAssessorAdapter } from '@auto-router/router'
import { changedSections, validateConfigDocument, versionNumber, versionString, type DocResult } from '../config-doc.ts'
import { HttpError, int, jsonBody, query, requireObject, str } from '../http.ts'
import type { ConfigDocument, StoredVersion } from '../local-types.ts'
import type { Deps } from '../ports.ts'
import type { Ctx, Handler } from '../app.ts'
import { audit, iso, stringField } from './common.ts'
import { BAKED_VERSION, effectiveConfig, freshStates, identityKeys, identityKeysMessage, reportedConfigs } from '../effective.ts'
import { packInfo, runningPacks } from './packs.ts'

const ACTIVE_KEY = 'config/active.json'
export const versionKey = (n: number) => `config/versions/${n}.json`
const view = (v: StoredVersion): ConfigVersionMeta & { document: ConfigDocument } => ({ ...v.meta, document: v.document })

/**
 * The configuration in force, as a version: the active console-written version (n ≥ 1), else the baked document
 * (config/baked.json, version 0-baked.<sha8>), else a legacy seeded v#0. 404 when none can be read.
 */
export async function activeVersion(deps: Deps): Promise<StoredVersion> {
  const eff = await effectiveConfig(deps)
  if (eff.active) return eff.active
  if (eff.baked) return { meta: { version: eff.baked.version, n: 0, author: 'cdk', createdAt: '', comment: 'deploy-time (baked) configuration', changed: [] }, document: eff.baked }
  const p = await deps.console.getActive()
  const v = p ? await deps.console.getVersion(p.n) : undefined
  if (!v) throw new HttpError(503, 'config-unavailable', 'no active configuration and the deploy-time configuration (config/baked.json) is unreadable')
  return v
}
/** The complete effective document (active ?? baked per section), undefined while a section is unknown. */
export async function activeDocument(deps: Deps): Promise<ConfigDocument | undefined> {
  return (await effectiveConfig(deps)).document
}

export async function validateDraft(deps: Deps, raw: unknown): Promise<DocResult> {
  const running = await runningPacks(deps)
  const r = validateConfigDocument(raw, { catalog: deps.catalog, packs: running.packs.map(packInfo), universe: new Set(deps.env.modelUniverse), hasAdapter: hasAssessorAdapter })
  r.warnings.push(...running.warnings)
  return r
}

/**
 * The router's state for the active version, from its latest config reports (17: C#config items), plus whether every
 * running task has the identity keys loaded (from the state lines, 0d-effective-config §7).
 */
export async function routerState(deps: Deps, active: StoredVersion): Promise<RouterConfigState> {
  const keys = await identityKeys(deps)
  const st = await configRouterState(deps, active)
  return { ...st, identityKeysLoaded: keys.loaded, identityKeys: keys }
}

async function configRouterState(deps: Deps, active: StoredVersion): Promise<RouterConfigState> {
  const reports = await deps.usage.configReports(50)
  const latest = reports[0]
  const outcome = (r: (typeof reports)[number]) => r.outcome ?? r.status
  const mine = reports.find((r) => r.configVersion === active.meta.version && (r.source ?? 'config') === 'config')
  if (mine && outcome(mine) === 'rejected') return { status: 'rejected', reportedVersion: active.meta.version, since: mine.ts, ...(mine.issues ? { issues: mine.issues } : {}) }
  if (mine && latest?.configVersion === active.meta.version) return { status: 'active', reportedVersion: active.meta.version, since: mine.ts }
  return { status: 'pending', ...(latest?.configVersion ? { reportedVersion: latest.configVersion } : {}) }
}


/**
 * Writes the ACTIVE version's document to S3 and marks it delivered. If ACTIVE moved while writing (a concurrent
 * activation), delivers the newer one too, so config/active.json never ends on an older version.
 */
export async function deliver(deps: Deps): Promise<{ n: number; delivered: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await activeVersion(deps)
    // The baked configuration is the router's own boot document: never written to config/active.json.
    if (v.meta.n === 0) return { n: 0, delivered: true }
    try {
      const body = `${JSON.stringify(v.document)}\n`
      await deps.objects.put(versionKey(v.meta.n), body)
      await deps.objects.put(ACTIVE_KEY, body)
    } catch (e) {
      deps.log({ kind: 'console-api-delivery-failed', n: v.meta.n, error: e instanceof Error ? e.name : 'unknown' })
      await deps.console.markDelivered(v.meta.n, false)
      return { n: v.meta.n, delivered: false }
    }
    if ((await deps.console.getActive())?.n === v.meta.n) { await deps.console.markDelivered(v.meta.n, true); return { n: v.meta.n, delivered: true } }
  }
  return { n: (await deps.console.getActive())?.n ?? 0, delivered: false }
}

const IDENTITY_RANK: Record<string, number> = { off: 0, observe: 1, require: 2 }

/**
 * Effects outside the policy (0d review): identity and assessor modes, compared on effective values (a section the
 * next document leaves out falls back to the baked one, as the router does).
 */
export function consoleEffects(prev: ConfigDocument, next: ConfigDocument, baked: ConfigDocument | undefined): SwapEffect[] {
  const out: SwapEffect[] = []
  const was = prev.identity?.mode
  const will = (next.identity ?? baked?.identity)?.mode
  if (was !== undefined && will !== undefined && was !== will) {
    const down = (IDENTITY_RANK[will] ?? 0) < (IDENTITY_RANK[was] ?? 0)
    out.push(down
      ? { effect: 'identity-weakened', severity: 'disruptive', detail: `identity ${was} → ${will}: ${will === 'off' ? 'the verified principal is no longer checked; blocks, budgets and tier limits stop binding' : 'requests without a valid identity token are served again; blocks, budgets and limits bind only callers that send one'}` }
      : { effect: 'identity-strengthened', severity: 'info', detail: `identity ${was} → ${will}` })
  }
  const aWas = prev.assessor?.mode
  const aWill = (next.assessor ?? baked?.assessor)?.mode
  if (aWas !== undefined && aWill !== undefined && aWas !== aWill) {
    out.push({ effect: 'assessor-mode', severity: aWas === 'auto' ? 'warn' : 'info', detail: `assessor ${aWas} → ${aWill}${aWas === 'auto' ? ': its opinions stop changing routing' : ''}` })
  }
  return out
}

/** core policySwapEffects(prev, next) (design 0.9) plus the console's own (identity, assessor); deps.swapEffects overrides core's (tests). */
function effectsOf(deps: Deps, prev: ConfigDocument | undefined, next: ConfigDocument, baked?: ConfigDocument): SwapEffect[] {
  if (!prev) return []
  return [...policyEffects(deps, prev, next), ...consoleEffects(prev, next, baked)]
}

function policyEffects(deps: Deps, prev: ConfigDocument, next: ConfigDocument): SwapEffect[] {
  if (deps.swapEffects) return deps.swapEffects(prev, next, deps.catalog)
  let before
  try { before = validatePolicy(prev.policy) } catch {
    // The active policy no longer validates (an older core or catalog): the effects cannot be computed, so the admin
    // must confirm the swap explicitly (0d review).
    return [{ effect: 'cannot-compare', severity: 'disruptive', detail: 'the active policy no longer validates against this console; the effects of the swap cannot be computed' }]
  }
  return policySwapEffects(before, validatePolicy(next.policy), deps.catalog)
}

function failValidation(r: Extract<DocResult, { ok: false }>): never {
  const code = r.issues.every((i) => i.code === 'universe') ? 'outside-universe' : 'validation-failed'
  throw new HttpError(422, code, 'the configuration is not valid', r.issues)
}

const activate: Handler = async (ctx) => {
  const { deps } = ctx
  const body = requireObject(jsonBody(ctx.event))
  const comment = stringField(body, 'comment', { max: 500 }) as string
  const base = typeof body.baseVersion === 'string' ? body.baseVersion : undefined
  if (base === undefined) throw new HttpError(400, 'bad-request', 'baseVersion: the active version you edited is required')
  const active = await activeVersion(deps)
  const pointer = await deps.console.getActive()
  // The editor's base is the version it showed: the active one, or the baked version while no console version is
  // active (a legacy ACTIVE "0-baked" pointer then still guards the transaction).
  const baseOk = active.meta.version === base || (active.meta.n === 0 && pointer?.version === base)
  if (!baseOk) throw new HttpError(409, 'config-version-moved', `version ${active.meta.version} was activated while you were editing`)
  const eff = await effectiveConfig(deps)
  const prevDoc = eff.document ?? active.document
  let rollbackOf: string | undefined
  if (body.rollbackOf !== undefined) {
    const n = versionNumber(body.rollbackOf)
    const bakedSha = typeof body.rollbackOf === 'string' ? BAKED_VERSION.exec(body.rollbackOf)?.[1]?.slice(1) : undefined
    // 0-baked.<sha8> → the seeded v#0#<sha8>; a number (legacy 0-baked included) → v#<n>.
    const old = bakedSha ? await deps.console.getBakedVersion(bakedSha) : n === undefined ? undefined : await deps.console.getVersion(n)
    if (!old || old.meta.version !== body.rollbackOf) throw new HttpError(404, 'not-found', 'rollbackOf: no such version')
    rollbackOf = old.meta.version
  }
  // Validated against the image the router runs now, also for a roll back (an old version may name a pack or a
  // model that is gone).
  const r = await validateDraft(deps, body.document)
  if (!r.ok) failValidation(r)
  // identity require with no signing keys loaded would answer 401 to every request (0d, C2 review).
  if (r.document.identity?.mode === 'require' && prevDoc.identity?.mode !== 'require') {
    const keys = await identityKeys(deps)
    if (!keys.loaded) {
      const message = identityKeysMessage(keys)
      throw new HttpError(422, 'identity-keys-not-loaded', `identity require refused: ${message}`,
        [{ path: '/identity/mode', message, code: 'identity', rule: 'identity-keys-not-loaded' }], keys.reason)
    }
  }
  const effects = effectsOf(deps, prevDoc, r.document, eff.baked)
  if (effects.some((e) => e.severity === 'disruptive') && body.confirmDisruptive !== true) {
    throw new HttpError(409, 'disruptive-unconfirmed', 'this activation moves running sessions: confirm it (confirmDisruptive)')
  }
  const n = Math.max(await deps.console.latestVersion(), active.meta.n) + 1
  const nowMs = deps.now()
  const version = versionString(n, nowMs)
  const document: ConfigDocument = { ...r.document, version }
  const v: StoredVersion = {
    meta: { version, n, author: ctx.caller.key, createdAt: iso(nowMs), comment, changed: changedSections(prevDoc, document), ...(rollbackOf ? { rollbackOf } : {}) },
    document,
  }
  if ((await deps.console.activate(v, pointer?.version)) === 'conflict') {
    throw new HttpError(409, 'config-version-moved', 'another version was activated at the same time; review it first')
  }
  await deps.console.deleteDraft()
  const d = await deliver(deps)
  const delivered = d.delivered && d.n === n
  await audit(ctx, {
    action: rollbackOf ? 'config.rollback' : 'config.activate', target: `config:${version}`,
    summary: `${rollbackOf ? `roll back to ${rollbackOf}` : 'activate'}: ${v.meta.changed.join(', ') || 'no change'}; ${comment}`,
    before: { version: active.meta.version, identity: prevDoc.identity?.mode, assessor: prevDoc.assessor?.mode },
    after: { version, changed: v.meta.changed, identity: (r.document.identity ?? eff.baked?.identity)?.mode, assessor: (r.document.assessor ?? eff.baked?.assessor)?.mode,
      ...(effects.length ? { effects: effects.map((e) => e.effect) } : {}) }, ...(delivered ? {} : { result: 'failed', errorCode: 'delivery-failed' }),
  })
  if (!delivered) throw new HttpError(502, 'delivery-failed', `version ${version} is active but was not delivered to the router; retry with POST /api/admin/config/redeliver`)
  const out: ActivateResponse = { version: v.meta }
  return { status: 201, body: { ...out, warnings: r.warnings } }
}

/** The config page state (also the answer of draft save/discard and redeliver, like the mock API). */
export async function configState(deps: Deps): Promise<ConfigState> {
  const active = await activeVersion(deps)
  const pointer = await deps.console.getActive()
  const draft = await deps.console.getDraft()
  const eff = await effectiveConfig(deps)
  return {
    effective: { ...eff.settings, sources: eff.sources, ...(eff.document ? { document: eff.document } : {}), ...(eff.baked ? { bakedVersion: eff.baked.version } : {}) },
    // What each running task really runs: its latest state line (≤ 15 min), not a scan of past config lines.
    reported: reportedConfigs(await freshStates(deps), eff.settings, deps.now()),
    active: view(active) as ConfigState['active'], ...(draft ? { draft: draft as ConfigState['draft'] } : {}),
    router: await routerState(deps, active),
    delivery: pointer && pointer.n >= 1 && pointer.delivered === false ? { state: 'notDelivered', errorCode: 'delivery-failed' } : { state: 'delivered' },
    universe: [...deps.env.modelUniverse],
    catalog: {
      region: deps.catalog.region, version: deps.catalog.version,
      models: deps.catalog.models.map((m) => ({ modelId: m.modelId, tier: m.tier as ConfigState['catalog']['models'][number]['tier'], dialects: [...m.dialects], contextWindow: m.contextWindow })),
    },
  }
}

export const configHandlers = {
  'admin.config.get': async ({ deps }: Ctx) => {
    const body = await configState(deps)
    return { body, headers: { etag: `"${body.active.version}"` } }
  },
  'admin.config.saveDraft': async (ctx: Ctx) => {
    const b = requireObject(jsonBody(ctx.event))
    requireObject(b.document, 'document')
    if (typeof b.baseVersion !== 'string' || versionNumber(b.baseVersion) === undefined) throw new HttpError(400, 'bad-request', 'baseVersion: a version string')
    // Drafts may be invalid (work in progress); validation happens on validate and activate.
    const draft = { document: b.document as ConfigDocument, author: ctx.caller.key, updatedAt: iso(ctx.deps.now()), baseVersion: b.baseVersion }
    await ctx.deps.console.putDraft(draft)
    await audit(ctx, { action: 'config.draft', target: 'config:draft', summary: `draft saved on ${b.baseVersion}` })
    return { body: await configState(ctx.deps) }
  },
  'admin.config.discardDraft': async (ctx: Ctx) => {
    await ctx.deps.console.deleteDraft()
    await audit(ctx, { action: 'config.discard', target: 'config:draft', summary: 'draft discarded' })
    return { body: await configState(ctx.deps) }
  },
  'admin.config.versions': async ({ event, deps }: Ctx) => {
    const sp = query(event)
    const limit = int(sp, 'limit', 50, 1, 200)
    const before = str(sp, 'before')
    const b = before === undefined ? undefined : versionNumber(before) ?? (/^\d{1,9}$/.test(before) ? Number(before) : undefined)
    if (before !== undefined && b === undefined) throw new HttpError(400, 'bad-request', 'before: a version')
    const items = await deps.console.listVersionMetas(limit + 1, b)
    const body: Page<ConfigVersionMeta> = items.length > limit ? { items: items.slice(0, limit), nextCursor: String(items[limit - 1]!.n) } : { items }
    return { body }
  },
  'admin.config.version': async ({ params, deps }: Ctx) => {
    const raw = params.version ?? ''
    const baked = BAKED_VERSION.exec(raw)?.[1]?.slice(1)
    if (baked) {
      const bv = await deps.console.getBakedVersion(baked)
      if (!bv) throw new HttpError(404, 'not-found', 'no such version')
      return { body: view(bv) }
    }
    const n = versionNumber(raw) ?? (/^\d{1,9}$/.test(raw) ? Number(raw) : undefined)
    const v = n === undefined ? undefined : await deps.console.getVersion(n)
    if (!v || (raw.includes('-') && v.meta.version !== raw)) throw new HttpError(404, 'not-found', 'no such version')
    return { body: view(v) }
  },
  'admin.config.validate': async ({ event, deps }: Ctx) => {
    const b = requireObject(jsonBody(event))
    await activeVersion(deps) // 503 config-unavailable when nothing can be compared against
    const r = await validateDraft(deps, b.document)
    const eff = await effectiveConfig(deps)
    const prev = eff.document
    const body: ValidateResponse & { warnings: unknown[] } = r.ok
      ? { ok: true, issues: [], effects: effectsOf(deps, prev, r.document, eff.baked), changed: changedSections(prev, r.document), warnings: r.warnings }
      : { ok: false, issues: r.issues, effects: [], changed: [], warnings: r.warnings }
    return { body }
  },
  'admin.config.activate': activate,
  'admin.config.redeliver': async (ctx: Ctx) => {
    const d = await deliver(ctx.deps)
    await audit(ctx, { action: 'config.redeliver', target: `config:${d.n}`, summary: `redeliver version ${d.n}`, ...(d.delivered ? {} : { result: 'failed', errorCode: 'delivery-failed' }) })
    if (!d.delivered) throw new HttpError(502, 'delivery-failed', `version ${d.n} could not be delivered`)
    return { body: await configState(ctx.deps) }
  },
} satisfies Record<string, Handler>
