// Mock console API implementing the contract (design v1 §2.4, @auto-router/console-contract) over the mock dataset.
// Authorization mirrors production: a JWT check like the HTTP API authorizer (signature, expiry, token_use, scope,
// client) answering 401/403 itself, then the route table's group check (403 forbidden), then self-scoping by the
// token's sub (another principal's ids → 404). Bound to 127.0.0.1 by server.ts.

import type {
  ActivateRequest, ApiErrorBody, AuditQuery, Baseline, BudgetsPatch, BudgetStatus, Cap, ClientPatch, ConfigDocument, ConfigSectionName, ConfigState, CreateClientRequest, DeploymentSettings, ReportedConfig, RouterMode, SettingSource,
  DeploymentInfo, Dialect, HealthRange, HealthReport, InviteRequest, Member, MemberDetail, MemberPatch, PrincipalKey, Profile, RecordQuery, Role,
  SaveDraftRequest, SavingsQuery, Series, SettingsPatch, SetupInfo, StatusClass, Tier, UsageDimension, UsageQuery, ValidateRequest,
} from '@auto-router/console-contract'
import { allowed, isDay, matchRoute, qBool, qList, qStr } from '@auto-router/console-contract'
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { filterRecords, savingsReport, scope, session, summaryOf, usageReport } from './aggregate.ts'
import { configVersion, PREFIX, REGION, rng, type MockDb } from './data.ts'
import { MOCK_ACCOUNTS } from './idp.ts'
import type { JwtKey } from './jwt.ts'
import { changedSections, interimValidator } from './validate.ts'

export interface ApiOptions {
  db: MockDb
  key: JwtKey
  issuer: string
  clientId: string
  scope: string
  /** Served at /config.json (mock mode). */
  runtimeConfig: Record<string, unknown>
  idp: { revokeAllFor(sub: string): void }
  latencyMs?: number
  /** Test knob: the next identity publish fails (502 identity-delivery-failed) until republished. */
  failIdentityDeliveryOnce?: boolean
}

/** console-api's English fallback for identity-keys-not-loaded (73); the UI keys off error.reason, not this text. */
function keysText(k: MockDb['identityKeys']): string {
  const why = k.reason === 'no-fresh-task' ? 'no router task has reported its state in the last 15 minutes'
    : k.reason === 'partial' ? (k.running === undefined ? `${k.fresh} task(s) report state, but the running task count cannot be read` : `${k.fresh} of ${k.running} running tasks report state`)
    : k.reason === 'not-configured' ? `identity is not configured on task ${k.task} (deploy with identity)`
    : `task ${k.task} has not loaded the user pool signing keys (jwks)`
  return `identity require refused: ${why}`
}

/** No console version can be served (MockDb.configFailure). */
function configFailure(db: MockDb): void {
  if (db.configFailure === 404) throw new HttpError(404, 'not-found', 'no active config version')
  if (db.configFailure === 503) throw new HttpError(503, 'config-unavailable', 'no active console version and config/baked.json unreadable')
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: ApiErrorBody['error']['issues'] | undefined
  readonly reason: string | undefined
  constructor(status: number, code: string, message: string, issues?: ApiErrorBody['error']['issues'], reason?: string) {
    super(message)
    this.status = status
    this.code = code
    this.issues = issues
    this.reason = reason
  }
}

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const DIALECTS: readonly Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const BASELINES: readonly Baseline[] = ['static', 'standard', 'frontier', 'observe-default']
const STATUS: readonly StatusClass[] = ['2xx', '4xx', '5xx', '499']
const APPLY_MS = 35_000

interface Caller { sub: string; key: PrincipalKey; role: Role; name: string }

function listOf<T extends string>(sp: URLSearchParams, k: string, allowedValues?: readonly T[]): T[] | undefined {
  const v = qList(sp, k)
  if (v && allowedValues && !v.every((x) => (allowedValues as readonly string[]).includes(x))) throw new HttpError(400, 'bad-request', `invalid ${k}`)
  return v as T[] | undefined
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) throw new HttpError(413, 'bad-request', 'body too large'); chunks.push(c as Buffer) }
  if (n === 0) return undefined
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'bad-request', 'invalid JSON body') }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A JSON object body typed as T (shape checks follow per handler); 400 otherwise. */
function asBody<T>(v: unknown): T {
  if (!isObj(v)) throw new HttpError(400, 'bad-request', 'a JSON object body is required')
  return v as T
}

export function createApi(o: ApiOptions) {
  const { db } = o
  const failConfig = () => configFailure(db)
  const keysMessage = () => keysText(db.identityKeys)
  const keysIssue = () => ({ path: '/identity/mode', message: keysMessage(), code: 'identity' as const, rule: 'identity-keys-not-loaded' })
  const applying = new Map<string, number>()
  const validator = interimValidator({ catalog: db.catalog, universe: db.universe, packs: db.packs.packs })
  /**
   * The role is read per request from the member table (active ∧ role), never from the token's cognito:groups
   * claim: a demoted or disabled admin loses admin routes at once with the same token (0d review; C6 does the same).
   * The claim only has to say the caller is in some console group.
   */
  const roleOf = (sub: string, groups: unknown): Role | undefined => {
    const g = Array.isArray(groups) ? groups : []
    if (!g.includes('admin') && !g.includes('member')) return undefined
    const m = db.members.find((x) => x.id === sub)
    return m && m.status === 'active' ? m.role : undefined
  }

  function authenticate(req: IncomingMessage): { claims: Record<string, unknown> } | { status: 401 | 403 } {
    const h = req.headers.authorization
    const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(h) : null
    const claims = m ? o.key.verify(m[1] as string) : undefined
    if (!claims || claims.iss !== o.issuer || claims.token_use !== 'access' || claims.client_id !== o.clientId) return { status: 401 }
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
    if (!scopes.includes(o.scope)) return { status: 403 }
    return { claims }
  }

  const active = () => db.versions.at(-1)!
  const mode = () => (active().document.policy.mode as 'observe' | 'auto') ?? 'observe'

  /**
   * 0d-effective-config §1/§4: per section, effective = active document ?? baked; a baked-sourced value is 'unknown'
   * when config/baked.json cannot be read. Never a guessed default.
   */
  function effective(): NonNullable<ConfigState['effective']> {
    const a = active()
    const baked = db.bakedReadable ? db.baked : undefined
    const fromBaked = a.n === 0 // the active document is the baked one itself
    const pick = <K extends ConfigSectionName>(k: K): { doc?: ConfigDocument; setting: { source: SettingSource; version?: string } } => {
      if (!fromBaked && a.document[k] !== undefined) return { doc: a.document, setting: { source: 'document', version: a.version } }
      if (baked) return { doc: baked, setting: { source: 'baked', version: baked.version } }
      return { setting: { source: 'unknown' } }
    }
    const pol = pick('policy'); const idn = pick('identity'); const asr = pick('assessor'); const acc = pick('access')
    const policy = pol.doc?.policy as { mode?: RouterMode; version?: string } | undefined
    const assessor = asr.doc?.assessor
    const val = <T,>(s: { source: SettingSource; version?: string }, v: T | undefined) => (v === undefined || s.source === 'unknown' ? { ...s } : { ...s, value: v })
    const sources = { policy: pol.setting.source, identity: idn.setting.source, assessor: asr.setting.source, access: acc.setting.source }
    const out: NonNullable<ConfigState['effective']> = {
      identityMode: val(idn.setting, idn.doc?.identity?.mode),
      routerMode: val(pol.setting, policy?.mode),
      policyVersion: val(pol.setting, policy?.version),
      assessorMode: val(asr.setting, assessor?.mode),
      assessorPack: val(asr.setting, assessor && 'pack' in assessor ? assessor.pack : undefined),
      assessorModel: val(asr.setting, assessor && 'model' in assessor ? assessor.model : undefined),
      sources,
      ...(baked ? { bakedVersion: baked.version } : {}),
    }
    if (Object.values(sources).every((x) => x !== 'unknown')) {
      out.document = { ...(fromBaked ? baked! : a.document), policy: pol.doc!.policy, assessor: asr.doc!.assessor!, identity: idn.doc!.identity!, access: acc.doc!.access }
    }
    return out
  }

  /** Latest config line per router task: what the tasks really run (0d §3). */
  function reported(eff: NonNullable<ConfigState['effective']>): ReportedConfig[] {
    const at = new Date(Date.now() - 20_000).toISOString()
    const runs = { identityMode: eff.identityMode.value, assessorMode: eff.assessorMode.value, policyVersion: eff.policyVersion.value, mode: eff.routerMode.value }
    const comparable = Object.values(eff.sources).every((x) => x !== 'unknown')
    const sources = Object.fromEntries(Object.entries(eff.sources).filter(([, v]) => v !== 'unknown')) as ReportedConfig['sources']
    const task = (id: string, e: ReportedConfig['effective'], cv: string): ReportedConfig => ({
      task: id, at, configVersion: cv, effective: e, ...(sources ? { sources } : {}),
      ...(comparable ? { matches: JSON.stringify(e) === JSON.stringify(runs) } : {}),
    })
    const out = [task('router/1a2b3c', runs, active().version)]
    out.push(db.reportedMismatch
      ? task('router/4d5e6f', { ...runs, policyVersion: 'policy-old', identityMode: 'off' }, '1-20260101T000000Z')
      : task('router/4d5e6f', runs, active().version))
    return out
  }
  const month = () => new Date(db.now).toISOString().slice(0, 7)
  const today = () => new Date(db.now).toISOString().slice(0, 10)

  function effectiveModes(): Pick<DeploymentInfo, 'mode' | 'identityMode' | 'effective'> {
    const e = effective()
    const { sources: _s, document: _d, bakedVersion: _b, ...settings } = e
    return { mode: e.routerMode.value ?? 'unknown', identityMode: e.identityMode.value ?? 'unknown', effective: settings }
  }

  function deployment(): DeploymentInfo {
    return {
      prefix: PREFIX, region: REGION, ...effectiveModes(), catalog: { region: db.catalog.region, version: db.catalog.version },
      retentionDays: db.settings.retentionDays, rollupDays: 400, defaultBaseline: db.settings.defaultBaseline, ingestLagSeconds: 45,
      dataAsOf: db.records.at(-1)?.detail.ts ?? new Date(db.now).toISOString(),
    }
  }

  /** Budget spend = ΣA + ΣX for the UTC month: actual cost plus (uncached) assessor cost (design §2.3a). */
  function spent(key: PrincipalKey): number {
    const m = month()
    return db.records.filter((r) => r.p === key && r.detail.ts.startsWith(m))
      .reduce((s, r) => s + (r.detail.costUsd ?? 0) + (r.detail.assessorDetail && !r.detail.assessorDetail.cached ? r.detail.assessorDetail.costUsd ?? 0 : 0), 0)
  }

  let failIdentityOnce = o.failIdentityDeliveryOnce === true
  /** Regenerates identity/*.json; a failed put is audited, answers 502 and leaves the state notDelivered. */
  function publishIdentity(c: Caller, what: string): void {
    if (failIdentityOnce) {
      failIdentityOnce = false
      db.identityDelivery = { state: 'notDelivered', at: new Date().toISOString(), errorCode: 'AccessDenied' }
      db.audit.push({ id: randomUUID(), ts: new Date().toISOString(), actor: { kind: 'user', key: c.key, name: c.name }, action: 'member.update', target: 'identity', summary: `identity publish failed after ${what}`, requestId: `req-${randomBytes(4).toString('hex')}`, result: 'failed', errorCode: 'identity-delivery-failed' })
      throw new HttpError(502, 'identity-delivery-failed', 'the change is saved, but identity/*.json could not be written; republish')
    }
    db.identityDelivery = { state: 'delivered', at: new Date().toISOString() }
  }

  /** identity/principals.json first (per-principal cap), then the principal's group default (design 0.16). */
  function capFor(key: PrincipalKey, role: Role): Cap | undefined {
    const e = db.principalEntries.get(key)
    return e?.cap ?? active().document.access.groups[e?.group ?? role]
  }

  function syncPrincipal(key: PrincipalKey, group: 'admin' | 'member' | 'service', cap: Cap | undefined) {
    db.principalEntries.set(key, cap ? { group, cap } : { group })
  }

  function memberView(m: Member): Member {
    const t = applying.get(m.id)
    const v: Member = { ...m, costThisMonthUsd: spent(`user:${m.id}`) }
    if (t !== undefined && Date.now() - t < APPLY_MS) v.applying = true
    else delete v.applying
    return v
  }

  function audit(c: Caller, action: Parameters<typeof db.audit.push>[0]['action'], target: string, summary: string, extra: { before?: unknown; after?: unknown } = {}) {
    db.audit.push({ id: randomUUID(), ts: new Date().toISOString(), actor: { kind: 'user', key: c.key, name: c.name }, action, target, summary, requestId: `req-${randomBytes(4).toString('hex')}`, result: 'succeeded', ...extra })
  }

  // ---------------------------------------------------------------- query parsing
  function dayRange(sp: URLSearchParams) {
    const from = qStr(sp, 'from')
    const to = qStr(sp, 'to')
    if (!isDay(from) || !isDay(to) || from > to) throw new HttpError(400, 'bad-request', 'from and to must be UTC days, from <= to')
    return { from, to }
  }

  function usageQuery(sp: URLSearchParams, admin: boolean): UsageQuery {
    const q: UsageQuery = { ...dayRange(sp) }
    const dims: readonly UsageDimension[] = admin ? ['model', 'tier', 'dialect', 'day', 'caller'] : ['model', 'tier', 'dialect', 'day']
    const g = qStr(sp, 'groupBy'); if (g) { if (!(dims as readonly string[]).includes(g)) throw new HttpError(400, 'bad-request', 'invalid groupBy'); q.groupBy = g as UsageDimension }
    const s = qStr(sp, 'stackBy'); if (s) { if (!(dims as readonly string[]).includes(s) || s === 'day') throw new HttpError(400, 'bad-request', 'invalid stackBy'); q.stackBy = s as UsageQuery['stackBy'] & string }
    const caller = qList(sp, 'caller'); if (caller) { if (!admin) throw new HttpError(400, 'bad-request', 'caller filter is admin only'); q.caller = caller }
    const model = qList(sp, 'model'); if (model) q.model = model
    const tier = listOf(sp, 'tier', TIERS); if (tier) q.tier = tier
    const dialect = listOf(sp, 'dialect', DIALECTS); if (dialect) q.dialect = dialect
    const status = listOf(sp, 'status', STATUS); if (status) q.status = status
    return q
  }

  function savingsQuery(sp: URLSearchParams, admin: boolean): SavingsQuery {
    const q: SavingsQuery = { view: 'savings', ...dayRange(sp) }
    const b = qStr(sp, 'baseline'); if (b) { if (!(BASELINES as readonly string[]).includes(b)) throw new HttpError(400, 'bad-request', 'invalid baseline'); q.baseline = b as Baseline }
    const g = qStr(sp, 'groupBy'); if (g) { if (!['model', 'dialect', ...(admin ? ['caller'] : [])].includes(g)) throw new HttpError(400, 'bad-request', 'invalid groupBy'); q.groupBy = g as SavingsQuery['groupBy'] & string }
    const caller = qList(sp, 'caller'); if (caller) { if (!admin) throw new HttpError(400, 'bad-request', 'caller filter is admin only'); q.caller = caller }
    const dialect = listOf(sp, 'dialect', DIALECTS); if (dialect) q.dialect = dialect
    return q
  }

  function recordQuery(sp: URLSearchParams, admin: boolean): RecordQuery {
    const from = qStr(sp, 'from'); const to = qStr(sp, 'to')
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new HttpError(400, 'bad-request', 'from and to must be ISO timestamps')
    const q: RecordQuery = { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
    const caller = qList(sp, 'caller'); if (caller) { if (!admin) throw new HttpError(400, 'bad-request', 'caller filter is admin only'); q.caller = caller }
    const sess = qStr(sp, 'session'); if (sess) q.session = sess
    const dialect = listOf(sp, 'dialect', DIALECTS); if (dialect) q.dialect = dialect
    const action = qList(sp, 'action'); if (action) q.action = action as RecordQuery['action'] & string[]
    const point = qList(sp, 'point'); if (point) q.point = point as RecordQuery['point'] & string[]
    const model = qList(sp, 'model'); if (model) q.model = model
    const tier = listOf(sp, 'tier', TIERS); if (tier) q.tier = tier
    const status = listOf(sp, 'status', STATUS); if (status) q.status = status
    const md = qStr(sp, 'mode'); if (md) { if (md !== 'observe' && md !== 'auto') throw new HttpError(400, 'bad-request', 'invalid mode'); q.mode = md }
    for (const k of ['assessor', 'failover', 'wouldChooseDiffers'] as const) { const b = qBool(sp, k); if (b !== undefined) q[k] = b }
    const miss = qStr(sp, 'miss'); if (miss) q.miss = miss as RecordQuery['miss'] & string
    const cursor = qStr(sp, 'cursor'); if (cursor) q.cursor = cursor
    const limit = Number(qStr(sp, 'limit') ?? 50)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'bad-request', 'limit must be 1..200')
    q.limit = limit
    return q
  }

  function page<T>(items: T[], cursor: string | undefined, limit: number) {
    const start = cursor ? Number(cursor) : 0
    if (!Number.isInteger(start) || start < 0) throw new HttpError(400, 'bad-request', 'invalid cursor')
    const slice = items.slice(start, start + limit)
    return start + limit < items.length ? { items: slice, nextCursor: String(start + limit) } : { items: slice }
  }

  // ---------------------------------------------------------------- config helpers
  function configState(): ConfigState {
    const a = active()
    const age = Date.now() - Date.parse(a.createdAt)
    const router = db.router.reportedVersion === a.version || age > 4000 ? { ...db.router, status: db.router.status === 'rejected' ? 'rejected' as const : 'active' as const, reportedVersion: db.router.status === 'rejected' ? db.router.reportedVersion : a.version } : { status: 'pending' as const, reportedVersion: db.router.reportedVersion }
    const s: ConfigState = {
      active: a, router: { ...(router as ConfigState['router']), identityKeysLoaded: db.identityKeys.loaded, identityKeys: db.identityKeys }, delivery: db.configDelivery, universe: db.universe,
      effective: effective(), reported: reported(effective()),
      catalog: { region: db.catalog.region, version: db.catalog.version, models: db.catalog.models.map((m) => ({ modelId: m.modelId, tier: m.tier as Tier, dialects: m.dialects as Dialect[], contextWindow: m.contextWindow })) },
    }
    if (db.draft) s.draft = db.draft
    return s
  }

  // ---------------------------------------------------------------- handlers
  async function dispatch(id: string, params: Record<string, string>, sp: URLSearchParams, req: IncomingMessage, c: Caller): Promise<[number, unknown]> {
    const admin = id.startsWith('admin.')
    const own = admin ? undefined : c.key
    const account = MOCK_ACCOUNTS.find((a) => a.sub === c.sub)
    switch (id) {
      case 'me.profile': {
        const m = db.members.find((x) => x.id === c.sub)
        const p: Profile = { principal: c.key, username: account?.username ?? c.sub, role: c.role, groups: account?.groups ?? [], deployment: deployment() }
        if (account) { p.name = account.name; p.email = account.email }
        if (m?.budget) p.budget = { ...m.budget, spentUsd: spent(c.key), month: month() } satisfies BudgetStatus
        const cap = capFor(c.key, c.role); if (cap) p.tierLimit = cap
        const first = db.records.find((r) => r.p === c.key); if (first) p.firstRequestAt = first.detail.ts
        return [200, p]
      }
      case 'me.usage': case 'admin.usage': {
        if (qStr(sp, 'view') === 'savings') return [200, savingsReport(db, own, savingsQuery(sp, admin))]
        if (qStr(sp, 'view') && qStr(sp, 'view') !== 'usage') throw new HttpError(400, 'bad-request', 'invalid view')
        return [200, usageReport(db, own, usageQuery(sp, admin))]
      }
      case 'me.records': case 'admin.records': {
        const q = recordQuery(sp, admin)
        const rs = filterRecords(scope(db, own), q).reverse()
        return [200, page(rs.map((r) => summaryOf(r, admin)), q.cursor, q.limit ?? 50)]
      }
      case 'me.record': case 'admin.record': {
        const ts = qStr(sp, 'ts')
        const who = qStr(sp, 'caller')
        if (who && !admin) throw new HttpError(400, 'bad-request', 'caller is admin only')
        if (ts && Number.isNaN(Date.parse(ts))) throw new HttpError(400, 'bad-request', 'ts must be an ISO timestamp')
        const r = scope(db, own).find((x) => x.detail.reqId === params.reqId && (!ts || x.detail.ts === ts) && (!who || x.p === who))
        if (!r) throw new HttpError(404, 'not-found', 'record not found')
        const d = { ...r.detail }
        if (!admin) delete d.caller
        else d.caller ??= { key: 'none', kind: 'none' }
        return [200, d]
      }
      case 'me.session': case 'admin.session': {
        let pool = scope(db, own)
        if (admin) {
          const who = qStr(sp, 'caller')
          if (!who) throw new HttpError(400, 'bad-request', 'caller=<kind:id> is required (a session label is unique per caller)')
          pool = pool.filter((r) => r.p === who)
        }
        const s = session(db, pool, params.label as string, admin)
        if (!s) throw new HttpError(404, 'not-found', 'session not found')
        return [200, s]
      }
      case 'me.latest': {
        const since = new Date(db.now - 10 * 60_000).toISOString()
        const r = [...scope(db, c.key)].reverse().find((x) => x.detail.ts >= since)
        return [200, r ? { record: { ts: r.detail.ts, reqId: r.detail.reqId, dialect: r.detail.dialect, requested: r.detail.requested, servedModel: r.detail.servedModel, status: r.detail.status } } : {}]
      }
      case 'me.setup': {
        const doc = active().document
        const pol = doc.policy as { pools: Record<Dialect, { defaultTier: Tier; models: Array<{ model: string; tier?: Tier }> }>; aliases?: Record<string, Tier | 'default'>; observeDefaults?: Partial<Record<Dialect, string>> }
        const cap = capFor(c.key, c.role)
        const max = cap?.maxTier ? TIERS.indexOf(cap.maxTier) : 2
        const tierOf = (m: { model: string; tier?: Tier }) => m.tier ?? (db.catalog.models.find((x) => x.modelId === m.model)?.tier as Tier)
        const domain = `https://${PREFIX}-mock.auth.${REGION}.amazoncognito.com`
        const s: SetupInfo = {
          gatewayUrl: db.gateway.url, inferenceUrl: `${db.gateway.url}/inference`, cognitoDomain: domain, tokenEndpoint: `${domain}/oauth2/token`,
          authorizeEndpoint: `${domain}/oauth2/authorize`, clientId: 'cli-mock-client-id', scope: `${PREFIX}/invoke`, redirectPorts: [48951, 48952, 48953], codexOauthPort: 48954,
          configureJson: { schemaVersion: 1, region: REGION, cognitoDomain: domain, clientId: 'cli-mock-client-id', scope: `${PREFIX}/invoke`, redirectPorts: [48951, 48952, 48953], codexOauthPort: 48954, gatewayUrl: db.gateway.url, identityHeader: 'x-api-key', refreshDays: 30 },
          ...effectiveModes(), observeDefaults: pol.observeDefaults ?? {},
          aliases: pol.aliases ?? { auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard', 'auto:frontier': 'frontier' },
          pools: (Object.entries(pol.pools) as Array<[Dialect, { defaultTier: Tier; models: Array<{ model: string; tier?: Tier }> }]>).map(([dialect, p]) => ({
            dialect, defaultTier: p.defaultTier,
            tiers: TIERS.filter((t) => TIERS.indexOf(t) <= max).map((t) => ({ tier: t, models: p.models.filter((m) => tierOf(m) === t).map((m) => m.model) })),
          })),
          refreshDays: 30, forwardedHeaders: db.gateway.forwardedHeaders,
        }
        if (cap) s.tierLimit = cap
        const m = db.members.find((x) => x.id === c.sub)
        if (m?.budget) s.budget = { ...m.budget, spentUsd: spent(c.key), month: month() }
        return [200, s]
      }
      case 'me.signOutEverywhere': {
        o.idp.revokeAllFor(c.sub)
        audit(c, 'member.signOut', account?.email ?? c.sub, 'Signed out everywhere (self)')
        return [200, { ok: true }]
      }
      case 'packs.get': {
        const p = db.packs.packs.find((x) => x.packVersion === params.packVersion)
        if (!p) throw new HttpError(404, 'not-found', 'pack version not in the archive')
        return [200, p]
      }
      // ---- members
      case 'admin.members.list': return [200, { items: db.members.map(memberView), identity: db.identityDelivery }]
      case 'admin.members.get': {
        const m = db.members.find((x) => x.id === params.id)
        if (!m) throw new HttpError(404, 'not-found', 'member not found')
        const sessions = new Map<string, { session: string; last: string; requests: number; costUsd: number }>()
        for (const r of db.records.filter((x) => x.p === `user:${m.id}`)) {
          const s = sessions.get(r.detail.session ?? '') ?? { session: r.detail.session ?? '', last: r.detail.ts, requests: 0, costUsd: 0 }
          sessions.set(s.session, s); s.last = r.detail.ts; s.requests++; s.costUsd += r.detail.costUsd ?? 0
        }
        const d: MemberDetail = { ...memberView(m), history: db.memberHistory.get(m.id) ?? [], sessions: [...sessions.values()].reverse().slice(0, 10) }
        if (m.budget) d.budgetStatus = { ...m.budget, spentUsd: spent(`user:${m.id}`), month: month() }
        return [200, d]
      }
      case 'admin.members.invite': {
        const b = asBody<InviteRequest>(await readJson(req))
        if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(b.email) || typeof b.name !== 'string' || !b.name.trim() || (b.role !== 'admin' && b.role !== 'member')) {
          throw new HttpError(400, 'bad-request', 'email, name and role are required')
        }
        if (db.members.some((m) => m.email.toLowerCase() === b.email.toLowerCase())) throw new HttpError(409, 'email-exists', 'a user with this e-mail exists')
        const id = `u-${randomBytes(4).toString('hex')}`
        const m: Member = { id, username: b.email.split('@')[0] as string, name: b.name.trim(), email: b.email, role: b.role, status: 'invited', mfa: 'not-enrolled', createdAt: new Date().toISOString(), costThisMonthUsd: 0 }
        if (b.budget) m.budget = b.budget
        if (b.tierLimit) m.tierLimit = b.tierLimit
        db.members.push(m)
        syncPrincipal(`user:${id}`, m.role, m.tierLimit)
        db.memberHistory.set(id, [{ ts: m.createdAt, status: 'invited', by: c.name }])
        audit(c, 'member.invite', b.email, `Invited ${m.name} (${m.role})`)
        publishIdentity(c, 'invite')
        return [201, memberView(m)]
      }
      case 'admin.members.patch': {
        const m = db.members.find((x) => x.id === params.id)
        if (!m) throw new HttpError(404, 'not-found', 'member not found')
        const b = asBody<MemberPatch>(await readJson(req))
        if (b.role !== undefined) {
          if (b.role !== 'admin' && b.role !== 'member') throw new HttpError(400, 'bad-request', 'invalid role')
          if (m.role === 'admin' && b.role === 'member' && db.members.filter((x) => x.role === 'admin' && x.status !== 'disabled').length <= 1) throw new HttpError(409, 'last-admin', 'cannot remove the last admin')
          const before = m.role
          m.role = b.role
          db.memberHistory.get(m.id)?.push({ ts: new Date().toISOString(), status: 'role', by: c.name, detail: `${before} -> ${b.role}` })
          audit(c, 'member.role', m.email, `Role ${before} -> ${b.role}`, { before, after: b.role })
        }
        if (b.budget !== undefined) { if (b.budget === null) delete m.budget; else m.budget = b.budget }
        if (b.tierLimit !== undefined) { if (b.tierLimit === null) delete m.tierLimit; else m.tierLimit = b.tierLimit }
        if (b.budget !== undefined || b.tierLimit !== undefined) audit(c, 'member.update', m.email, 'Budget or tier limit changed')
        syncPrincipal(`user:${m.id}`, m.role, m.tierLimit)
        applying.set(m.id, Date.now())
        publishIdentity(c, 'member change')
        return [200, memberView(m)]
      }
      case 'admin.members.action': {
        const m = db.members.find((x) => x.id === params.id)
        if (!m) throw new HttpError(404, 'not-found', 'member not found')
        const b = (await readJson(req)) as { action?: string } | undefined
        const now = new Date().toISOString()
        switch (b?.action) {
          case 'disable':
            if (m.id === c.sub) throw new HttpError(409, 'cannot-disable-self', 'you cannot disable yourself')
            if (m.role === 'admin' && db.members.filter((x) => x.role === 'admin' && x.status !== 'disabled').length <= 1) throw new HttpError(409, 'last-admin', 'cannot disable the last admin')
            m.status = 'disabled'; o.idp.revokeAllFor(m.id); applying.set(m.id, Date.now())
            db.memberHistory.get(m.id)?.push({ ts: now, status: 'disabled', by: c.name }); audit(c, 'member.disable', m.email, `Disabled ${m.name}`)
            break
          case 'enable':
            m.status = 'active'; applying.set(m.id, Date.now())
            db.memberHistory.get(m.id)?.push({ ts: now, status: 'active', by: c.name }); audit(c, 'member.enable', m.email, `Enabled ${m.name}`)
            break
          case 'sign-out': o.idp.revokeAllFor(m.id); audit(c, 'member.signOut', m.email, `Signed ${m.name} out everywhere`); break
          case 'resend-invite':
            if (m.status !== 'invited') throw new HttpError(409, 'bad-request', 'only invited members get a new invite')
            audit(c, 'member.invite', m.email, `Re-sent the invite to ${m.name}`)
            break
          default: throw new HttpError(400, 'bad-request', 'unknown action')
        }
        if (b.action === 'disable' || b.action === 'enable') publishIdentity(c, b.action)
        return [200, memberView(m)]
      }
      case 'admin.members.delete': {
        const i = db.members.findIndex((x) => x.id === params.id)
        if (i < 0) throw new HttpError(404, 'not-found', 'member not found')
        const m = db.members[i]!
        if (m.status !== 'disabled') throw new HttpError(409, 'not-disabled', 'disable the member first')
        db.members.splice(i, 1)
        const p = db.principals.get(`user:${m.id}`); if (p) p.caller = { ...p.caller, deleted: true }
        audit(c, 'member.delete', m.email, `Deleted ${m.name}`)
        return [204, undefined]
      }
      // ---- service clients
      case 'admin.clients.list': return [200, { items: db.clients.map((x) => ({ ...x, costThisMonthUsd: spent(`client:${x.id}`) })), identity: db.identityDelivery }]
      case 'admin.clients.create': {
        const b = asBody<CreateClientRequest>(await readJson(req))
        if (typeof b.name !== 'string' || !/^[A-Za-z0-9 ._-]{1,64}$/.test(b.name)) throw new HttpError(400, 'bad-request', 'name is required (letters, digits, space . _ -)')
        const client = { id: `c-${randomBytes(6).toString('hex')}`, name: b.name, status: 'active' as const, createdAt: new Date().toISOString(), costThisMonthUsd: 0, scope: `${PREFIX}/invoke`, ...(b.description ? { description: b.description } : {}), ...(b.budget ? { budget: b.budget } : {}), ...(b.tierLimit ? { tierLimit: b.tierLimit } : {}) }
        db.clients.push(client)
        const p = `client:${client.id}`
        syncPrincipal(p, 'service', client.tierLimit)
        db.principals.set(p, { key: p, caller: { key: p, kind: 'client', name: client.name } })
        audit(c, 'client.create', client.name, `Created service client ${client.name}`)
        return [201, { client, secret: randomBytes(32).toString('base64url'), tokenEndpoint: `https://${PREFIX}-mock.auth.${REGION}.amazoncognito.com/oauth2/token`, scope: client.scope }]
      }
      case 'admin.clients.patch': {
        const x = db.clients.find((y) => y.id === params.id)
        if (!x) throw new HttpError(404, 'not-found', 'client not found')
        const b = asBody<ClientPatch>(await readJson(req))
        if (typeof b.name === 'string') x.name = b.name
        if (typeof b.description === 'string') x.description = b.description
        if (b.budget !== undefined) { if (b.budget === null) delete x.budget; else x.budget = b.budget }
        if (b.tierLimit !== undefined) { if (b.tierLimit === null) delete x.tierLimit; else x.tierLimit = b.tierLimit }
        syncPrincipal(`client:${x.id}`, 'service', x.tierLimit)
        audit(c, 'client.update', x.name, 'Service client changed')
        return [200, x]
      }
      case 'admin.clients.action': {
        const x = db.clients.find((y) => y.id === params.id)
        if (!x) throw new HttpError(404, 'not-found', 'client not found')
        const b = (await readJson(req)) as { action?: string } | undefined
        if (b?.action === 'rotate-secret') {
          audit(c, 'client.rotate', x.name, `Rotated the secret of ${x.name}`)
          return [200, { client: x, secret: randomBytes(32).toString('base64url'), tokenEndpoint: `https://${PREFIX}-mock.auth.${REGION}.amazoncognito.com/oauth2/token`, scope: x.scope }]
        }
        if (b?.action === 'disable') { x.status = 'disabled'; audit(c, 'client.disable', x.name, `Disabled ${x.name}`); return [200, x] }
        if (b?.action === 'enable') { x.status = 'active'; audit(c, 'client.enable', x.name, `Enabled ${x.name}`); return [200, x] }
        throw new HttpError(400, 'bad-request', 'unknown action')
      }
      case 'admin.clients.delete': {
        const i = db.clients.findIndex((y) => y.id === params.id)
        if (i < 0) throw new HttpError(404, 'not-found', 'client not found')
        if (db.clients[i]!.status !== 'disabled') throw new HttpError(409, 'not-disabled', 'disable the client first')
        const [x] = db.clients.splice(i, 1)
        audit(c, 'client.delete', x!.name, `Deleted ${x!.name}`)
        return [204, undefined]
      }
      // ---- config
      case 'admin.config.get': failConfig(); return [200, configState()]
      case 'admin.config.saveDraft': {
        const b = asBody<SaveDraftRequest>(await readJson(req))
        if (!isObj(b.document) || typeof b.baseVersion !== 'string') throw new HttpError(400, 'bad-request', 'document and baseVersion are required')
        db.draft = { document: b.document as ConfigDocument, author: c.name, updatedAt: new Date().toISOString(), baseVersion: b.baseVersion }
        audit(c, 'config.draft', 'config draft', 'Saved a draft')
        return [200, configState()]
      }
      case 'admin.config.discardDraft': {
        if (db.draft) audit(c, 'config.discard', 'config draft', 'Discarded the draft')
        delete db.draft
        return [200, configState()]
      }
      case 'admin.config.redeliver': {
        audit(c, 'config.redeliver', `config ${active().version}`, `Re-delivered ${active().version}`)
        db.router = { status: 'pending', ...(db.router.reportedVersion ? { reportedVersion: db.router.reportedVersion } : {}) }
        db.configDelivery = { state: 'delivered', at: new Date().toISOString() }
        return [200, configState()]
      }
      case 'admin.identity.republish': {
        publishIdentity(c, 'republish')
        audit(c, 'member.update', 'identity', 'Republished identity/blocks.json and principals.json')
        return [200, { identity: db.identityDelivery }]
      }
      case 'admin.config.versions': failConfig(); return [200, { items: [...db.versions].reverse().map(({ document: _d, ...meta }) => meta) }]
      case 'admin.config.version': {
        const v = db.versions.find((x) => x.version === params.version)
        if (!v) throw new HttpError(404, 'not-found', 'version not found')
        const { document, ...meta } = v
        return [200, { meta, document }]
      }
      case 'admin.config.validate': {
        const b = asBody<ValidateRequest>(await readJson(req))
        const issues = validator.validate(b.document)
        const doc = b.document as ConfigDocument
        return [200, { ok: issues.length === 0, issues, effects: issues.length ? [] : validator.effects(active().document, doc), changed: issues.length ? [] : changedSections(active().document, doc) }]
      }
      case 'admin.config.activate': {
        const b = asBody<ActivateRequest>(await readJson(req))
        if (typeof b.comment !== 'string' || !b.comment.trim()) throw new HttpError(400, 'bad-request', 'a comment is required')
        if (b.baseVersion !== active().version) throw new HttpError(409, 'config-version-moved', `version ${active().version} was activated while you were editing`)
        const n = active().n + 1
        const version = configVersion(n, Date.now())
        // The editor's document carries the version it started from; activation stamps the new one.
        const issues = validator.validate({ ...b.document, version })
        if (b.document.identity?.mode === 'require' && active().document.identity?.mode !== 'require' && !db.identityKeys.loaded) {
          // 73: its own code, the reason beside the issue.
          throw new HttpError(422, 'identity-keys-not-loaded', keysMessage(), [keysIssue()], db.identityKeys.reason)
        }
        if (issues.length) throw new HttpError(422, 'validation-failed', 'the document is invalid', issues)
        const effects = validator.effects(active().document, b.document)
        if (effects.some((e) => e.severity === 'disruptive') && !b.confirmDisruptive) throw new HttpError(409, 'disruptive-unconfirmed', 'this change makes requests fail at once; confirm it')
        const document: ConfigDocument = { ...b.document, version }
        const meta = { version, n, author: c.name, createdAt: new Date().toISOString(), comment: b.comment.trim(), changed: changedSections(active().document, document), ...(b.rollbackOf ? { rollbackOf: b.rollbackOf } : {}) }
        db.versions.push({ ...meta, document })
        delete db.draft
        db.router = { status: 'pending', ...(db.router.reportedVersion ? { reportedVersion: db.router.reportedVersion } : {}) }
        audit(c, b.rollbackOf ? 'config.rollback' : 'config.activate', `config ${version}`, b.rollbackOf ? `Rolled back to ${b.rollbackOf} as ${version}` : `Activated ${version}`)
        return [200, { version: meta }]
      }
      case 'admin.assessor.packs': {
        const rs = db.records.filter((r) => r.detail.ts.slice(0, 10) >= new Date(db.now - 7 * 86_400_000).toISOString().slice(0, 10))
        const consulted = rs.filter((r) => r.detail.assessorDetail)
        const lat = consulted.map((r) => r.detail.assessorDetail!.latencyMs).sort((a, b) => a - b)
        const byTier: Record<string, number> = {}
        for (const r of consulted) { const t = r.detail.assessorDetail!.tier ?? 'no-opinion'; byTier[t] = (byTier[t] ?? 0) + 1 }
        const pct = (q: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]! : 0
        return [200, {
          ...db.packs,
          stats: {
            range: { from: new Date(db.now - 7 * 86_400_000).toISOString().slice(0, 10), to: today() }, consultations: consulted.length,
            share: rs.length ? consulted.length / rs.length : 0, byTier,
            unavailableRate: consulted.length ? consulted.filter((r) => r.detail.assessorDetail!.status !== 'ok').length / consulted.length : 0,
            appliedRate: 0, cachedShare: 0, latencyP50Ms: pct(0.5), latencyP95Ms: pct(0.95),
            costUsd: consulted.reduce((s, r) => s + (r.detail.assessorDetail!.costUsd ?? 0), 0),
          },
        }]
      }
      case 'admin.gateway': return [200, db.gateway]
      case 'admin.audit': {
        const q: AuditQuery = { ...dayRange(sp) }
        const actor = qStr(sp, 'actor'); const action = qList(sp, 'action'); const target = qStr(sp, 'target')
        const items = [...db.audit].reverse().filter((e) => {
          const d = e.ts.slice(0, 10)
          if (d < q.from || d > q.to) return false
          if (actor && !(e.actor.name ?? e.actor.kind).toLowerCase().includes(actor.toLowerCase())) return false
          if (action && !action.includes(e.action)) return false
          if (target && !e.target.toLowerCase().includes(target.toLowerCase())) return false
          return true
        })
        return [200, page(items, qStr(sp, 'cursor'), Number(qStr(sp, 'limit') ?? 50))]
      }
      case 'admin.health': {
        const range = (qStr(sp, 'range') ?? '24h') as HealthRange
        if (!['1h', '6h', '24h', '7d'].includes(range)) throw new HttpError(400, 'bad-request', 'invalid range')
        return [200, health(range)]
      }
      case 'admin.budgets.get': {
        const per = [
          ...db.members.filter((m) => m.budget).map((m) => ({ caller: db.principals.get(`user:${m.id}`)?.caller ?? { key: `user:${m.id}`, kind: 'user' as const, name: m.name }, budget: m.budget!, spentUsd: spent(`user:${m.id}`) })),
          ...db.clients.filter((x) => x.budget).map((x) => ({ caller: { key: `client:${x.id}`, kind: 'client' as const, name: x.name }, budget: x.budget!, spentUsd: spent(`client:${x.id}`) })),
        ]
        return [200, db.defaultBudget ? { default: db.defaultBudget, perPrincipal: per } : { perPrincipal: per }]
      }
      case 'admin.budgets.put': {
        const b = asBody<BudgetsPatch>(await readJson(req))
        if (!('default' in b)) throw new HttpError(400, 'bad-request', 'default is required (a budget or null)')
        if (b.default === null) delete db.defaultBudget
        else if (isObj(b.default) && typeof b.default.monthlyUsd === 'number' && b.default.monthlyUsd > 0) db.defaultBudget = b.default
        else throw new HttpError(400, 'bad-request', 'invalid budget')
        audit(c, 'settings.change', 'default budget', 'Default budget changed')
        return [200, { ok: true }]
      }
      case 'admin.settings.get': return [200, settingsView()]
      case 'admin.settings.patch': {
        const b = asBody<SettingsPatch>(await readJson(req))
        if ('retentionDays' in b) throw new HttpError(400, 'bad-request', 'retentionDays is the deploy parameter recordRetentionDays; change it with a CDK deploy')
        if (b.defaultBaseline !== undefined) {
          if (!BASELINES.includes(b.defaultBaseline)) throw new HttpError(422, 'validation-failed', 'invalid baseline', [{ path: '/defaultBaseline', message: 'unknown baseline' }])
          db.settings.defaultBaseline = b.defaultBaseline
        }
        audit(c, 'settings.change', 'deployment settings', 'Deployment settings changed', { after: b })
        return [200, settingsView()]
      }
    }
    throw new HttpError(404, 'not-found', 'route not found')
  }

  function settingsView(): DeploymentSettings {
    return {
      defaultBaseline: db.settings.defaultBaseline,
      readOnly: { retentionDays: db.settings.retentionDays, refreshDays: 30, catalog: { region: db.catalog.region, version: db.catalog.version }, universe: db.universe },
      identity: db.identityDelivery,
    }
  }

  function health(range: HealthRange): HealthReport {
    const steps = { '1h': [60, 60_000], '6h': [72, 300_000], '24h': [96, 900_000], '7d': [168, 3600_000] }[range] as [number, number]
    const r = rng(7)
    const series = (base: number, amp: number): Series[] => Array.from({ length: steps[0] }, (_, i) => ({
      t: new Date(db.now - (steps[0] - 1 - i) * steps[1]).toISOString(), v: Math.max(0, base + amp * Math.sin(i / 6) + (r() - 0.5) * amp * 0.6),
    }))
    return {
      range, tasks: { running: 2, desired: 2 },
      requestsPerMin: series(14, 6), rate4xx: series(0.012, 0.006), rate5xx: series(0.002, 0.002), failovers: series(0.3, 0.3),
      overheadP50: series(4, 1), overheadP99: series(11, 3), ttfbP50: series(900, 200), ttfbP99: series(3100, 700), hitRate: series(0.86, 0.04), switches: series(0.5, 0.4),
      missesByReason: { ttl_expired: 12, model_changed: 3, prefix_changed: 2 },
      assessor: { latencyP50Ms: 610, latencyP95Ms: 1180, unavailableRate: 0.05 },
      fallbackSigns: { router5xx: 2, unhealthyTargets: 0, tasksBelowDesired: false },
      config: { activeVersion: active().version, ...(db.router.reportedVersion ? { reportedVersion: db.router.reportedVersion } : {}), rejections: 0 },
      ingestLagSeconds: 45,
      alarms: [{ name: `${PREFIX}-router-5xx`, state: 'OK', since: new Date(db.now - 86_400_000).toISOString() }],
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (o.latencyMs) await new Promise((r) => setTimeout(r, o.latencyMs))
    if (req.method === 'GET' && url.pathname === '/config.json') return send(res, 200, o.runtimeConfig)
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { message: 'Not Found' })
    // 1. The JWT authorizer (production: API Gateway answers these, with its own bodies).
    const auth = authenticate(req)
    if ('status' in auth) return send(res, auth.status, { message: auth.status === 401 ? 'Unauthorized' : 'Forbidden' }, auth.status === 401 ? { 'www-authenticate': 'Bearer' } : {})
    const requestId = `req-${randomBytes(6).toString('hex')}`
    try {
      const m = matchRoute(req.method ?? 'GET', url.pathname)
      if (!m) throw new HttpError(404, 'not-found', 'route not found')
      // 2. The group check per route.
      const sub = auth.claims.sub as string
      const role = roleOf(sub, auth.claims['cognito:groups'])
      if (!allowed(m.route, role)) throw new HttpError(403, 'forbidden', 'this route needs another group')
      const account = MOCK_ACCOUNTS.find((a) => a.sub === sub)
      const caller: Caller = { sub, key: `user:${sub}`, role: role as Role, name: account?.name ?? sub }
      const [status, body] = await dispatch(m.route.id, m.params, url.searchParams, req, caller)
      send(res, status, body)
    } catch (e) {
      if (e instanceof HttpError) {
        const body: ApiErrorBody = { error: { code: e.code, message: e.message, requestId } }
        if (e.issues) body.error.issues = e.issues
        if (e.reason) body.error.reason = e.reason
        return send(res, e.status, body)
      }
      send(res, 500, { error: { code: 'internal', message: 'internal error', requestId } } satisfies ApiErrorBody)
    }
  }

  return { handle }
}
