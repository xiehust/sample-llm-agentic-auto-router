// Mock implementations of the read models console-api serves from DynamoDB rollups and records: usage reports,
// savings (0d §1 figures), record lists and sessions. Pure functions over the mock dataset.

import type {
  Baseline, CallerRef, CostClasses, DailyPoint, Dialect, PrincipalKey, RecordQuery, RecordSummary, SavingsBlock, SavingsFigures, SavingsQuery,
  SavingsReport, SessionDetail, StatusClass, Tier, TokenClasses, UsageDimension, UsageQuery, UsageReport, UsageRow,
} from '@auto-router/console-contract'
import { daysBetween } from '@auto-router/console-contract'
import type { MockDb, StoredRecord } from './data.ts'

const emptyTokens = (): TokenClasses => ({ uncached: 0, cacheRead: 0, cacheWrite: {}, output: 0, reasoning: 0 })
const emptyCost = (): CostClasses => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 })

export const statusClass = (s: number): StatusClass => (s === 499 ? '499' : s >= 500 ? '5xx' : s >= 400 ? '4xx' : '2xx')

function row(key: string): UsageRow {
  return { key, requests: 0, errors: 0, tokens: emptyTokens(), cost: emptyCost(), longContextRequests: 0, unmetered: { count: 0, upperBoundUsd: 0, partial: false } }
}

function addTo(r: UsageRow, s: StoredRecord): void {
  const d = s.detail
  r.requests++
  if (d.status >= 400) r.errors++
  if (d.unmeteredBound) {
    r.unmetered.count++
    r.unmetered.upperBoundUsd += d.unmeteredBound.upperBoundUsd
    r.unmetered.partial ||= d.unmeteredBound.partial
  }
  const u = d.usage
  if (!u || !d.cost) return
  r.tokens.uncached += u.uncachedInputTokens
  r.tokens.cacheRead += u.cacheReadTokens
  for (const [ttl, v] of Object.entries(u.cacheWriteTokens) as Array<[keyof TokenClasses['cacheWrite'], number]>) r.tokens.cacheWrite[ttl] = (r.tokens.cacheWrite[ttl] ?? 0) + v
  r.tokens.output += u.outputTokens
  r.tokens.reasoning += u.reasoningTokens ?? 0
  r.cost.input += d.cost.input
  r.cost.cacheRead += d.cost.cacheRead
  r.cost.cacheWrite += d.cost.cacheWrite
  r.cost.output += d.cost.output
  r.cost.total += d.cost.total
  if (d.cost.tier === 'long') r.longContextRequests++
}

function finish(r: UsageRow): UsageRow {
  const prompt = r.tokens.uncached + r.tokens.cacheRead + Object.values(r.tokens.cacheWrite).reduce((a, b) => a + (b ?? 0), 0)
  if (prompt > 0) r.hitRate = r.tokens.cacheRead / prompt
  return r
}

export const dayOf = (ts: string) => ts.slice(0, 10)

function keyOf(s: StoredRecord, dim: UsageDimension): string {
  const d = s.detail
  switch (dim) {
    case 'model': return d.servedModel ?? '—'
    case 'tier': return d.tier ?? '—'
    case 'dialect': return d.dialect ?? '—'
    case 'day': return dayOf(d.ts)
    case 'caller': return s.p
  }
}

/** Records visible to the caller: a member sees only their own principal; an admin all. */
export function scope(db: MockDb, principal: PrincipalKey | undefined): StoredRecord[] {
  return principal === undefined ? db.records : db.records.filter((r) => r.p === principal)
}

export function inDays(rs: StoredRecord[], from: string, to: string): StoredRecord[] {
  return rs.filter((r) => { const d = dayOf(r.detail.ts); return d >= from && d <= to })
}

function filterUsage(rs: StoredRecord[], q: Pick<UsageQuery, 'caller' | 'model' | 'tier' | 'dialect' | 'status'>): StoredRecord[] {
  return rs.filter((r) => {
    const d = r.detail
    if (q.caller && !q.caller.includes(r.p)) return false
    if (q.model && !q.model.includes(d.servedModel ?? '')) return false
    if (q.tier && !q.tier.includes(d.tier as Tier)) return false
    if (q.dialect && !q.dialect.includes(d.dialect as Dialect)) return false
    if (q.status && !q.status.includes(statusClass(d.status))) return false
    return true
  })
}

export function callersOf(db: MockDb, keys: Iterable<string>): CallerRef[] {
  return [...new Set(keys)].map((k) => db.principals.get(k)?.caller ?? { key: k, kind: k === 'none' ? 'none' : k.startsWith('client:') ? 'client' : 'user', deleted: true })
}

export function usageReport(db: MockDb, principal: PrincipalKey | undefined, q: UsageQuery): UsageReport {
  const groupBy = q.groupBy ?? 'model'
  const stackBy = q.stackBy ?? 'model'
  const rs = filterUsage(inDays(scope(db, principal), q.from, q.to), q)
  const rows = new Map<string, UsageRow>()
  const totals = row('total')
  const daily = new Map<string, DailyPoint>()
  for (const s of rs) {
    const k = keyOf(s, groupBy)
    const r = rows.get(k) ?? row(k)
    rows.set(k, r)
    addTo(r, s)
    addTo(totals, s)
    const series = keyOf(s, stackBy)
    const dk = `${dayOf(s.detail.ts)}|${series}`
    const p = daily.get(dk) ?? { day: dayOf(s.detail.ts), series, costUsd: 0, tokens: emptyTokens() }
    daily.set(dk, p)
    if (s.detail.usage && s.detail.cost) {
      p.costUsd += s.detail.cost.total
      p.tokens.uncached += s.detail.usage.uncachedInputTokens
      p.tokens.cacheRead += s.detail.usage.cacheReadTokens
      for (const [ttl, v] of Object.entries(s.detail.usage.cacheWriteTokens) as Array<[keyof TokenClasses['cacheWrite'], number]>) p.tokens.cacheWrite[ttl] = (p.tokens.cacheWrite[ttl] ?? 0) + v
      p.tokens.output += s.detail.usage.outputTokens
      p.tokens.reasoning += s.detail.usage.reasoningTokens ?? 0
    }
  }
  const out: UsageReport = {
    range: { from: q.from, to: q.to }, catalog: { region: db.catalog.region, version: db.catalog.version }, groupBy, stackBy,
    rows: [...rows.values()].map(finish).sort((a, b) => (groupBy === 'day' ? a.key.localeCompare(b.key) : b.cost.total - a.cost.total)),
    totals: finish(totals),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day) || a.series.localeCompare(b.series)),
    dataAsOf: db.records.at(-1)?.detail.ts ?? new Date(db.now).toISOString(),
  }
  if (principal === undefined && (groupBy === 'caller' || stackBy === 'caller')) out.callers = callersOf(db, rs.map((r) => r.p))
  return out
}

// ---------------------------------------------------------------------------------------------------- savings

const zero = (): SavingsFigures => ({ requests: 0, A: 0, B: 0, R: 0, S: 0, X: 0, N: 0 })

function addSv(f: SavingsFigures, A: number, Astar: number, B: number, X: number): void {
  f.requests++
  f.A += A
  f.B += B
  f.R += B - Astar
  f.S += A - Astar
  f.X += X
  f.N += B - A - X
}

const rated = (f: SavingsFigures): SavingsFigures => (f.B > 0 ? { ...f, rate: f.N / f.B } : f)

function block(rs: StoredRecord[], baseline: Baseline, groupKey: (s: StoredRecord) => string, projected: boolean): SavingsBlock {
  const kpis = zero()
  const rows = new Map<string, SavingsFigures>()
  const matrix = new Map<string, { from: Tier; to: Tier; n: number; R: number }>()
  const daily = new Map<string, number>()
  for (const s of rs) {
    const sv = s.sv
    if (!sv || sv.capped) continue
    const A = projected ? (sv.projected?.A ?? sv.A) : sv.A
    const Astar = projected ? A : sv.Astar
    const B = sv.B[baseline]
    addSv(kpis, A, Astar, B, sv.X)
    const k = groupKey(s)
    const r = rows.get(k) ?? zero()
    rows.set(k, r)
    addSv(r, A, Astar, B, sv.X)
    const to = (projected ? sv.projected?.tier : s.detail.tier) ?? 'standard'
    const mk = `${sv.baseTier[baseline]}>${to}`
    const m = matrix.get(mk) ?? { from: sv.baseTier[baseline], to, n: 0, R: 0 }
    matrix.set(mk, m)
    m.n++
    m.R += B - Astar
    const day = dayOf(s.detail.ts)
    daily.set(day, (daily.get(day) ?? 0) + B - A - sv.X)
  }
  return {
    kpis: rated(kpis),
    matrix: [...matrix.values()],
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, N]) => ({ day, N })),
    rows: [...rows.entries()].map(([key, f]) => ({ key, ...rated(f) })).sort((a, b) => b.B - a.B),
  }
}

export function savingsReport(db: MockDb, principal: PrincipalKey | undefined, q: SavingsQuery): SavingsReport {
  const baseline = q.baseline ?? db.settings.defaultBaseline
  const groupBy = q.groupBy ?? 'model'
  const rs = filterUsage(inDays(scope(db, principal), q.from, q.to), { ...(q.caller ? { caller: q.caller } : {}), ...(q.dialect ? { dialect: q.dialect } : {}) })
  const gk = (s: StoredRecord) => (groupBy === 'caller' ? s.p : groupBy === 'dialect' ? (s.detail.dialect ?? '—') : (s.detail.servedModel ?? '—'))
  const actual = block(rs, baseline, gk, false)
  const mode = db.versions.at(-1)!.document.policy.mode as 'observe' | 'auto'
  const capped = { requests: 0, A: 0, B: 0 }
  let otherCold = 0
  let cache = 0
  const unmetered = { count: 0, upperBoundUsd: 0, partial: false }
  for (const s of rs) {
    if (s.detail.unmeteredBound) { unmetered.count++; unmetered.upperBoundUsd += s.detail.unmeteredBound.upperBoundUsd; unmetered.partial ||= s.detail.unmeteredBound.partial }
    if (!s.sv) continue
    otherCold += s.sv.otherCold
    cache += s.sv.Cnet
    if (s.sv.capped) { capped.requests++; capped.A += s.sv.A; capped.B += s.sv.B[baseline] }
  }
  const out: SavingsReport = {
    ...actual, range: { from: q.from, to: q.to }, catalog: { region: db.catalog.region, version: db.catalog.version }, baseline, mode,
    promptCacheSaving: cache, otherColdCost: otherCold, capped, unmetered,
  }
  const obs = rs.filter((s) => s.detail.mode === 'observe' && s.sv?.projected)
  if (obs.length > 0) {
    out.projected = { ...block(obs, baseline, gk, true), differing: obs.filter((s) => s.detail.wouldChoose !== s.detail.decision?.model || s.detail.wouldChoose !== s.detail.servedModel).length }
  }
  if (principal === undefined && groupBy === 'caller') out.callers = callersOf(db, rs.map((r) => r.p))
  return out
}

// ---------------------------------------------------------------------------------------------------- records

export function summaryOf(s: StoredRecord, admin: boolean): RecordSummary {
  const d = s.detail
  const out: RecordSummary = { ts: d.ts, reqId: d.reqId, kind: d.kind, status: d.status, flags: { ...d.flags } }
  for (const k of ['session', 'lineage', 'dialect', 'requested', 'action', 'point', 'mode', 'servedModel', 'tier', 'wouldChoose', 'promptTokens', 'outputTokens', 'costUsd', 'hitRate', 'errorCode', 'bar'] as const) {
    if (d[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = d[k]
  }
  if (admin) out.caller = d.caller ?? { key: 'none', kind: 'none' }
  return out
}

export function filterRecords(rs: StoredRecord[], q: RecordQuery): StoredRecord[] {
  return rs.filter((s) => {
    const d = s.detail
    if (d.ts < q.from || d.ts >= q.to) return false
    if (q.caller && !q.caller.includes(s.p)) return false
    if (q.session && d.session !== q.session) return false
    if (q.dialect && !q.dialect.includes(d.dialect as Dialect)) return false
    if (q.action && !q.action.includes(d.action as never)) return false
    if (q.point && !q.point.includes(d.point as never)) return false
    if (q.model && !q.model.includes(d.servedModel ?? '')) return false
    if (q.tier && !q.tier.includes(d.tier as Tier)) return false
    if (q.status && !q.status.includes(statusClass(d.status))) return false
    if (q.mode && d.mode !== q.mode) return false
    if (q.assessor !== undefined && (d.flags.assessor !== undefined) !== q.assessor) return false
    if (q.failover !== undefined && (d.flags.failover === true) !== q.failover) return false
    if (q.miss && (q.miss === 'any' ? !d.flags.miss : d.flags.miss !== q.miss)) return false
    if (q.wouldChooseDiffers !== undefined && ((d.wouldChoose !== undefined && d.wouldChoose !== d.servedModel) !== q.wouldChooseDiffers)) return false
    return true
  })
}

export function session(db: MockDb, rs: StoredRecord[], label: string, admin: boolean): SessionDetail | undefined {
  const items = rs.filter((s) => s.detail.session === label)
  if (items.length === 0) return undefined
  const lineages = new Map<string, { lineage: string; kind: 'root' | 'subagent'; requests: number }>()
  for (const s of items) {
    const l = s.detail.lineage ?? '—'
    const e = lineages.get(l) ?? { lineage: l, kind: lineages.size === 0 ? 'root' : 'subagent', requests: 0 }
    lineages.set(l, e)
    e.requests++
  }
  let read = 0
  let prompt = 0
  for (const s of items) { read += s.detail.usage?.cacheReadTokens ?? 0; prompt += s.detail.usage?.promptTokens ?? 0 }
  const first = items[0]!
  const last = items.at(-1)!
  const out: SessionDetail = {
    session: label, first: first.detail.ts, last: last.detail.ts, requests: items.length, lineages: [...lineages.values()],
    models: [...new Set(items.map((s) => s.detail.servedModel).filter((m): m is string => !!m))],
    switches: items.filter((s) => s.detail.action === 'switch').length,
    misses: items.filter((s) => s.detail.flags.miss).length,
    failovers: items.filter((s) => s.detail.flags.failover).length,
    costUsd: items.reduce((a, s) => a + (s.detail.costUsd ?? 0), 0),
    live: db.now - Date.parse(last.detail.ts) < 15 * 60_000,
    items: items.map((s) => summaryOf(s, admin)),
  }
  if (prompt > 0) out.hitRate = read / prompt
  if (admin) out.caller = first.detail.caller ?? { key: 'none', kind: 'none' }
  return out
}

export { daysBetween }
