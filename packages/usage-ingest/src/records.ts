// One router line → one request record (usage table) + its rollup deltas (a3 §3, design v1 §2.3, 0d §1.10).
// Key layout:
//   record   pk P#<principal>            sk T#<ts>#<reqId>     gsi1 D#<yyyy-mm-dd> / <ts>#<reqId>   gsi2 S#<principal>#<session> / <ts>#<reqId>
//   rollups  pk U#<principal>#<yyyy-mm>  sk <dd>#<dialect>#<servedModel>#<baselineTier>
//            pk A#<yyyy-mm>              sk <dd>#<principal>#<dialect>#<servedModel>#<baselineTier>
//            pk B#<principal>#<yyyy-mm>  sk TOTAL                                    (budget spend, O(1))
//   config   pk C#config                 sk <ts>#<task>#<source>
// Rejected lines are records too (kind 'rejected', the error code in `reason`), so the record put is their
// idempotency key like any other request.
// <baselineTier> is the static baseline's tier ('-' when the line is not routable), so the tier matrix
// (baseline tier → served model's tier) is a rollup read. Money is integer nano-USD everywhere.
import type { Policy } from '@auto-router/core'
import { nano } from './savings.ts'
import type { PriceCatalog } from '@auto-router/pricing'
import { BASELINE_TAG, BASELINES, parseReason, tierOfPoolModel, type LineFigures } from './savings.ts'
import type { ConfigLine, Item, ItemKey, Principal, ResolvedConfig, RouterLine, TxAdd, TxPut } from './types.ts'

export const RECORD_SCHEMA = 1
export const ROLLUP_TTL_DAYS = 400
const DAY_S = 86_400

const ID_RE = /^[A-Za-z0-9_.:+@-]{1,128}$/

/** s2xx | s3xx | s4xx | s5xx | s499 (client closed), for the model/error lines (rejected lines: rej*). */
export function statusClass(status: number): string {
  if (status === 499) return 's499'
  const c = Math.floor(status / 100)
  return c >= 2 && c <= 5 ? `s${c}xx` : 'sOther'
}

/** `user:<sub>` | `client:<id>` | `none` (unattributed, or an id the key layout cannot carry). */
export function principalKey(p: Principal | undefined): string {
  if (!p || p.kind === 'none' || !p.id || !ID_RE.test(p.id)) return 'none'
  return `${p.kind}:${p.id}`
}

const safe = (s: string | undefined, fallback = '-'): string => (s && /^[A-Za-z0-9_.:/+-]{1,200}$/.test(s) ? s : fallback)

export interface TimeKeys { epochS: number; day: string; month: string; dd: string }
export function timeKeys(ts: string): TimeKeys {
  const ms = Date.parse(ts)
  const iso = new Date(ms).toISOString()
  return { epochS: Math.floor(ms / 1000), day: iso.slice(0, 10), month: iso.slice(0, 7), dd: iso.slice(8, 10) }
}

/** The counters one line adds to each of its rollup items. */
export function counters(line: RouterLine, f: LineFigures): Record<string, number> {
  const c: Record<string, number> = {}
  const add = (k: string, v: number | undefined): void => {
    if (v) c[k] = (c[k] ?? 0) + v
  }
  if (line.kind === 'rejected') {
    add('rej', 1)
    add(line.status === 401 || line.status === 403 || line.status === 429 ? `rej${line.status}` : 'rejOther', 1)
    return c
  }
  add('req', 1)
  if (line.kind === 'error' || line.status >= 500) add('err', 1)
  add(statusClass(line.status), 1)
  const u = line.usage
  if (u) {
    add('tUnc', u.uncachedInputTokens)
    add('tRead', u.cacheReadTokens)
    for (const [ttl, n] of Object.entries(u.cacheWriteTokens)) add(`tW${ttl}`, n)
    add('tOut', u.outputTokens)
    add('tReason', u.reasoningTokens)
    add('tPrompt', u.promptTokens)
  }
  add('spend', f.a)
  if (f.a !== undefined && line.costUsd) {
    // Per-class spend, each class rounded on its own: Σ classes may differ from `spend` by a few nano-USD.
    add('cIn', nano(line.costUsd.input))
    add('cRead', nano(line.costUsd.cacheRead))
    add('cWrite', nano(line.costUsd.cacheWrite))
    add('cOut', nano(line.costUsd.output))
    if (line.costUsd.tier === 'long') add('long', 1)
  }
  if (line.boundPartial) add('boundPartial', 1)
  add('asr', f.x)
  if (f.unmetered) {
    add('unm', 1)
    add('bound', f.bound)
  }
  if (f.excluded) add(`ex_${f.excluded}`, 1)
  if (f.costMismatch) add('costMismatch', 1)
  add('cnet', f.cNet)
  add('cold', f.coldOther)
  if (f.routingSwitch) add('sw', 1)
  if (f.otherSwitch) add('swOther', 1)
  if (line.miss) add('miss', 1)
  if (line.failover) add('fo', 1)
  // Savings: per baseline K, over the lines in K's set; S and X follow the same set so N_K = r_K − s_K − x_K.
  if (f.routable && f.a !== undefined && f.aStar !== undefined) {
    for (const k of BASELINES) {
      const t = BASELINE_TAG[k]
      const b = f.baselines[k]
      if (b?.b === undefined) {
        add(`ex_${b?.excluded ?? 'no-baseline'}_${t}`, 1)
        continue
      }
      add(`n_${t}`, 1)
      add(`b_${t}`, b.b)
      add(`r_${t}`, b.b - f.aStar)
      add(`s_${t}`, f.a - f.aStar)
      add(`x_${t}`, f.x)
    }
    const p = f.projection
    if (p && 'aHat' in p) {
      if (p.model !== line.servedModel) add('pdiff', 1)
      for (const k of BASELINES) {
        const b = f.baselines[k]?.b
        if (b === undefined) continue
        const t = BASELINE_TAG[k]
        add(`pn_${t}`, 1)
        add(`pb_${t}`, b)
        add(`pr_${t}`, b - p.aHat)
        add(`ps_${t}`, p.aPen - p.aHat)
        add(`px_${t}`, f.x)
        if (p.tier) {
          // projected tier matrix: (this cell's baseline tier) → projected tier
          add(`pmn_${t}_${p.tier}`, 1)
          add(`pmr_${t}_${p.tier}`, b - p.aHat)
        }
      }
    } else if (p) add('ex_projection-unpriced', 1)
  } else if (f.xInN && f.x) {
    for (const k of BASELINES) add(`x_${BASELINE_TAG[k]}`, f.x) // failed request: its consultation still counts against N
  }
  if (f.excluded === 'access-cap' && f.a !== undefined && f.aStar !== undefined) {
    const b = f.baselines.static?.b
    if (b !== undefined) {
      add('cap_n', 1)
      add('cap_a', f.a)
      add('cap_b', b)
      add('cap_r', b - f.aStar) // the cap's own row: a forced downgrade is not a routing saving (design 0.16)
    }
  }
  return c
}

export interface Built {
  put: TxPut
  adds: TxAdd[]
  principal: string
  month: string
}

/** Record + rollup deltas for a request line (model, error or rejected). */
export function buildRequest(line: RouterLine, f: LineFigures, resolved: ResolvedConfig | undefined, catalog: PriceCatalog,
  retentionDays: number): Built {
  const policy = resolved?.policy
  const t = timeKeys(line.ts)
  const principal = principalKey(line.principal)
  const routable = f.routable && f.baselines.static?.b !== undefined
  const baseTier = routable ? (f.baselines.static?.tier ?? '-') : '-'
  const cell = `${safe(line.dialect)}#${safe(line.servedModel)}#${baseTier}`
  const c = counters(line, f)
  const rollTtl = t.epochS + ROLLUP_TTL_DAYS * DAY_S
  const servedTier = servedTierOf(line, policy, catalog)
  const set = servedTier ? { servedTier } : undefined
  const adds: TxAdd[] = [
    { key: { pk: `U#${principal}#${t.month}`, sk: `${t.dd}#${cell}` }, add: c, ttl: rollTtl, ...(set ? { set } : {}) },
    { key: { pk: `A#${t.month}`, sk: `${t.dd}#${principal}#${cell}` }, add: c, ttl: rollTtl, ...(set ? { set } : {}) },
  ]
  if (principal !== 'none') {
    const spend = (c.spend ?? 0) + (c.asr ?? 0)
    const b: Record<string, number> = { req: c.req ?? 0, rej: c.rej ?? 0, spend: c.spend ?? 0, asr: c.asr ?? 0, bound: c.bound ?? 0 }
    if (spend !== 0 || b.req !== 0 || b.rej !== 0) adds.push({ key: { pk: `B#${principal}#${t.month}`, sk: 'TOTAL' }, add: dropZero(b), ttl: rollTtl })
  }
  const key = `${line.ts}#${line.reqId}`
  const item: Item & ItemKey = {
    pk: `P#${principal}`, sk: `T#${key}`, gsi1pk: `D#${t.day}`, gsi1sk: key,
    ...(line.session ? { gsi2pk: `S#${principal}#${line.session}`, gsi2sk: key } : {}),
    ttl: t.epochS + retentionDays * DAY_S,
    v: RECORD_SCHEMA,
    ...recordFields(line, f, resolved, catalog, principal),
  }
  return { put: { item }, adds, principal, month: t.month }
}

/** The served model's tier under the line's own policy (pool entry override), else its catalog tier. */
export function servedTierOf(line: RouterLine, policy: Policy | undefined, catalog: PriceCatalog): string | undefined {
  const m = line.servedModel
  if (!m) return undefined
  if (policy && line.dialect) return tierOfPoolModel(policy, catalog, line.dialect, m)
  return catalog.models.find((x) => x.modelId === m)?.tier
}

const dropZero = (r: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== 0))

function recordFields(line: RouterLine, f: LineFigures, resolved: ResolvedConfig | undefined, catalog: PriceCatalog, principal: string): Item {
  const policy = resolved?.policy
  const d = line.decision
  const a = line.assessor
  const served = line.servedModel
  const r: Item = {
    ts: line.ts, reqId: line.reqId, kind: line.kind, status: line.status, principal,
    principalGroup: line.principal?.group, identity: line.identity,
    dialect: line.dialect, requested: line.requested, session: line.session, lineage: line.lineage,
    configVersion: line.configVersion, catalogVersion: line.catalogVersion,
    servedModel: served,
    servedTier: servedTierOf(line, policy, catalog),
    servedDiffers: d && served && served !== d.model ? true : undefined,
    stream: line.stream, usage: line.usage, hitRate: line.hitRate,
    failover: line.failover, switchedFrom: line.switchedFrom,
    miss: line.miss ? { reason: line.miss.reason, expectedTokens: line.miss.expectedTokens, readTokens: line.miss.readTokens } : undefined,
    hints: line.hints, sanitized: line.sanitized, betaVeto: line.betaVeto,
    requestedLength: line.requestedLength, bodyBytes: line.bodyBytes,
    error: line.error, reason: line.reason, clientAborted: line.clientAborted,
    bodyReadMs: line.bodyReadMs, overheadMs: line.overheadMs, decideMs: line.decideMs, upstreamTtfbMs: line.upstreamTtfbMs,
    durationMs: line.durationMs,
  }
  if (d) {
    const reasonParsed = parseReason(d.reason)
    r.decision = { action: d.action, point: d.point, mode: d.mode, model: d.model, reason: d.reason, policyVersion: d.policyVersion,
      wouldChoose: d.wouldChoose, estimate: d.estimate, projected: d.projected, reasonParsed }
    // The cap's effect: the uncapped choice is not in the decision (only in the reason's free text), so `from` is absent.
    if (reasonParsed.accessCap) r.tierLimit = { to: d.model, maxTier: reasonParsed.accessCap }
  }
  if (a) {
    r.assessor = { id: a.id, autoRules: a.autoRules, called: a.called,
      tier: a.tier, proposedTier: a.proposedTier, confidence: a.confidence, basis: a.basis, outcome: a.outcome,
      guard: a.guard, applied: a.applied, latencyMs: a.latencyMs, status: a.status, mode: a.mode, cached: a.cached,
      packVersion: a.packVersion, costNano: f.x || undefined, threshold: resolved?.assessorThreshold }
  }
  const cu = line.costUsd
  const cost: Item = {
    cls: cu ? { input: nano(cu.input), cacheRead: nano(cu.cacheRead), cacheWrite: nano(cu.cacheWrite), output: nano(cu.output),
      total: nano(cu.total), tier: cu.tier } : undefined,
    a: f.a, aStar: f.aStar, x: f.x || undefined, cNet: f.cNet, coldOther: f.coldOther,
    excluded: f.excluded, unmetered: f.unmetered || undefined, bound: f.bound, boundPartial: line.boundPartial,
    routingSwitch: f.routingSwitch || undefined, costMismatch: f.costMismatch || undefined }
  if (Object.keys(f.baselines).length) {
    cost.b = Object.fromEntries(Object.entries(f.baselines).map(([k, b]) => [k, { model: b.model, tier: b.tier, nano: b.b, excluded: b.excluded }]))
  }
  if (f.projection) cost.projection = f.projection
  r.cost = cost
  return r
}

const CONFIG_FIELDS = ['source', 'outcome', 'attempted', 'from', 'configVersion', 'principalsVersion', 'policyVersion', 'mode', 'catalogVersion'] as const
const RESERVED = new Set(['pk', 'sk', 'ttl', 'v', 'ts', 'kind', 'task', 'issues', 'warnings', 'schemaVersion', ...CONFIG_FIELDS])
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/
const MAX_EXTRA_KEYS = 20
const MAX_EXTRA_JSON = 4000

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 300)) : undefined

/** A pass-through value (lineFields such as blocks etag, packs, drift; event details): JSON-safe and bounded. */
function bounded(v: unknown): unknown {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') return v.slice(0, 300)
  if (typeof v === 'object') {
    const json = JSON.stringify(v)
    return json.length <= MAX_EXTRA_JSON ? (JSON.parse(json) as unknown) : { truncated: true, bytes: json.length }
  }
  return undefined
}

/**
 * Router `kind: "config"` lines (design §2.3a), kept for the console ("Applying…" ends when every running task
 * reports the target; "config rejected"): the frozen fields plus bounded pass-through of any other key.
 */
export function buildConfig(line: ConfigLine, task: string, retentionDays: number): TxPut {
  const t = timeKeys(line.ts)
  // <source> in the sk: two lines from one task in the same millisecond (e.g. a config and a blocks watch) stay apart.
  const source = safe(typeof line.source === 'string' ? line.source : undefined)
  return { item: configFields({ pk: 'C#config', sk: `${line.ts}#${safe(task)}#${source}`, ttl: t.epochS + retentionDays * DAY_S, v: RECORD_SCHEMA,
    ts: line.ts, task: safe(task) }, line) }
}

/** Kept for a day: the console reads only fresh state items (0d effective-config §7: fresh = the last 15 min). */
export const STATE_TTL_S = DAY_S

/**
 * The router's state line (`kind: "config"`, source 'state', every 5 min and on every change; 0d effective-config
 * §7) as the task's one `C#state` item: sk = the task, `ts` in canonical ISO form so the store's `ts < :ts` condition
 * compares instants, TTL a day. `identityKeys` is normalized: the console's require gate reads it.
 */
export function buildState(line: ConfigLine, task: string): Item & ItemKey & { ts: string } {
  const t = timeKeys(line.ts)
  const ts = new Date(Date.parse(line.ts)).toISOString()
  const item = configFields({ pk: 'C#state', sk: safe(task), ttl: t.epochS + STATE_TTL_S, v: RECORD_SCHEMA, ts, task: safe(task) }, line)
  const keys = identityKeys(line.identityKeys)
  delete item.identityKeys // the pass-through copy: only the checked form is stored
  if (keys) item.identityKeys = keys
  return { ...item, ts }
}

/** `{ configured, loaded, kids, versions }` with its types checked; anything else is dropped (reads as not loaded). */
function identityKeys(v: unknown): Item | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.configured !== 'boolean' || typeof o.loaded !== 'boolean') return undefined
  const kids = typeof o.kids === 'number' && Number.isInteger(o.kids) && o.kids >= 0 && o.kids <= 1000 ? o.kids : undefined
  const versions: Record<string, string> = {}
  if (o.versions && typeof o.versions === 'object' && !Array.isArray(o.versions)) {
    for (const k of ['jwks', 'blocks', 'budgetBlocks'] as const) {
      const s = str((o.versions as Record<string, unknown>)[k])
      if (s !== undefined) versions[k] = s
    }
  }
  return { configured: o.configured, loaded: o.loaded, ...(kids === undefined ? {} : { kids }), versions }
}

function configFields(item: Item & ItemKey, line: ConfigLine): Item & ItemKey {
  for (const k of CONFIG_FIELDS) item[k] = str(line[k])
  item.issues = strList(line.issues)
  item.warnings = strList(line.warnings)
  let n = 0
  for (const [k, v] of Object.entries(line)) {
    if (RESERVED.has(k) || !KEY_RE.test(k) || n >= MAX_EXTRA_KEYS) continue
    const b = bounded(v)
    if (b !== undefined) {
      item[k] = b
      n += 1
    }
  }
  return item
}
