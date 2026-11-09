// Helpers shared by the route modules: ids, ranges, callers, audit writes, field validation.
import type { AuditAction, AuditEntry, Budget, CallerRef, Cap } from '@auto-router/console-contract'
import { HttpError } from '../http.ts'
import { capIssues } from '../config-doc.ts'
import type { Deps, MemberSettings } from '../ports.ts'
import type { Ctx } from '../app.ts'

export const REQ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** lineageLabel(): sha256(root)[:16]. */
export const SESSION_LABEL = /^[0-9a-f]{16}$/
export const PRINCIPAL_KEY = /^(user|client):[A-Za-z0-9_.:+@-]{1,128}$/
export const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const DAY_MS = 86_400_000
export const MAX_RANGE_DAYS = 92
export const iso = (ms: number) => new Date(ms).toISOString()
export const dayOf = (ms: number) => iso(ms).slice(0, 10)
export const monthOf = (ms: number) => iso(ms).slice(0, 7)
export const nanoToUsd = (n: number | undefined) => (n ?? 0) / 1e9

/** Malformed ids are "not found" too, so probing learns nothing about the id space. */
export function reqIdOf(ctx: Ctx): string {
  const id = ctx.params.reqId ?? ''
  if (!REQ_ID.test(id)) throw new HttpError(404, 'not-found', 'no such record')
  return id.toLowerCase()
}

/** Optional `?ts=<record ts>` (from a list row): lets the store fetch the record with one GetItem. */
export function tsOf(ctx: Ctx): string | undefined {
  const v = ctx.event.queryStringParameters?.ts
  if (v === undefined || v === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)) throw new HttpError(400, 'bad-request', 'ts: ISO timestamp (UTC) required')
  return v
}

/** A principal key from a query value: `user:<sub>`, `client:<id>` or `none`. */
export function principalKeyOf(v: string, name: string): string {
  if (v === 'none' || PRINCIPAL_KEY.test(v)) return v
  throw new HttpError(400, 'bad-request', `${name}: '<user|client>:<id>' or 'none' required`)
}

export function dayRange(from: string | undefined, to: string | undefined, nowMs: number, defaultDays: number): { from: string; to: string } {
  const t = to ?? dayOf(nowMs)
  const f = from ?? dayOf(Date.parse(`${t}T00:00:00Z`) - (defaultDays - 1) * DAY_MS)
  const a = Date.parse(`${f}T00:00:00Z`)
  const b = Date.parse(`${t}T00:00:00Z`)
  if (a > b) throw new HttpError(400, 'bad-request', 'from must not be after to')
  if ((b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) throw new HttpError(400, 'bad-request', `range at most ${MAX_RANGE_DAYS} days`)
  return { from: f, to: t }
}

/** Display data for principals (admin views). Members' names and e-mails from Cognito, clients' from MEMBER items. */
export async function callerRefs(deps: Deps, keys: Iterable<string>): Promise<Map<string, CallerRef>> {
  const wanted = new Set(keys)
  const out = new Map<string, CallerRef>()
  if (wanted.size === 0) return out
  const users = new Map((await deps.directory.listUsers()).map((u) => [`user:${u.sub}`, u]))
  const members = new Map((await deps.console.listMembers()).map((m) => [m.key, m]))
  for (const key of wanted) {
    if (key === 'none') { out.set(key, { key, kind: 'none' }); continue }
    const kind = key.startsWith('client:') ? 'client' : 'user'
    const u = users.get(key)
    const m = members.get(key)
    if (kind === 'user' && u) out.set(key, { key, kind, email: u.email, ...(u.name ? { name: u.name } : {}) })
    else if (kind === 'client' && m) out.set(key, { key, kind, ...(m.name ? { name: m.name } : {}) })
    else out.set(key, { key, kind, deleted: true })
  }
  return out
}

export async function audit(ctx: Ctx, e: { action: AuditAction; target: string; summary: string; result?: 'succeeded' | 'failed'; errorCode?: string; before?: unknown; after?: unknown }): Promise<void> {
  const entry = {
    id: ctx.deps.uuid(), ts: iso(ctx.deps.now()), actor: { kind: 'user' as const, key: ctx.caller.key }, action: e.action, target: e.target,
    summary: e.summary.slice(0, 300), requestId: ctx.requestId, result: e.result ?? 'succeeded',
    ...(e.errorCode ? { errorCode: e.errorCode } : {}), ...(e.before !== undefined ? { before: e.before } : {}), ...(e.after !== undefined ? { after: e.after } : {}),
  }
  await ctx.deps.console.appendAudit(entry as AuditEntry)
}

export function stringField(o: Record<string, unknown>, k: string, opts: { min?: number; max: number; optional?: boolean }): string | undefined {
  const v = o[k]
  if (v === undefined && opts.optional) return undefined
  if (typeof v !== 'string' || v.trim().length < (opts.min ?? 1) || v.length > opts.max) throw new HttpError(400, 'bad-request', `${k}: ${opts.min ?? 1}-${opts.max} characters required`)
  return v.trim()
}

export function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new HttpError(400, 'bad-request', `${k.slice(0, 40)}: unexpected key`)
}

/** Budget `{ monthlyUsd, alertAt, hardStop }`; null clears, undefined leaves unchanged. */
export function budgetOf(v: unknown, at: string): Budget | null | undefined {
  if (v === undefined || v === null) return v
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad-request', `${at}: object or null required`)
  const b = v as Record<string, unknown>
  onlyKeys(b, ['monthlyUsd', 'alertAt', 'hardStop'])
  if (typeof b.monthlyUsd !== 'number' || !Number.isFinite(b.monthlyUsd) || b.monthlyUsd <= 0 || b.monthlyUsd > 1_000_000) throw new HttpError(400, 'bad-request', `${at}.monthlyUsd: number in (0, 1000000]`)
  if (typeof b.alertAt !== 'number' || !(b.alertAt >= 0 && b.alertAt <= 1)) throw new HttpError(400, 'bad-request', `${at}.alertAt: number in [0, 1]`)
  if (typeof b.hardStop !== 'boolean') throw new HttpError(400, 'bad-request', `${at}.hardStop: boolean required`)
  return { monthlyUsd: b.monthlyUsd, alertAt: b.alertAt, hardStop: b.hardStop }
}

/** Tier limit; null clears, undefined leaves unchanged (pins are checked by the router against its policy). */
export function capOf(v: unknown, at: string): Cap | null | undefined {
  if (v === undefined || v === null) return v
  const issues = capIssues(v, at)
  if (issues.length) throw new HttpError(422, 'validation-failed', 'invalid tier limit', issues)
  return v as Cap
}

export function applyOptional<K extends 'budget' | 'cap'>(m: MemberSettings, k: K, v: MemberSettings[K] | null | undefined): void {
  if (v === null) delete m[k]
  else if (v !== undefined) m[k] = v
}
