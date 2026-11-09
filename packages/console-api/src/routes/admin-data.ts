// Admin read routes (usage, records, sessions, packs, gateway, health, audit) and deployment settings.
import type { AuditAction, Baseline, DeploymentSettings, HealthRange, PacksResponse, Page, RecordSummary } from '@auto-router/console-contract'
import { HttpError, cursor, day, int, jsonBody, list, query, requireObject, str } from '../http.ts'
import { detailOf, sessionOf, summaryOf } from '../records.ts'
import type { Ctx, Handler } from '../app.ts'
import { audit, callerRefs, dayRange, onlyKeys, principalKeyOf, reqIdOf, SESSION_LABEL, tsOf } from './common.ts'
import { DEFAULT_RETENTION_DAYS, LIVE_WINDOW_MS } from './me.ts'
import { currentManifest, runningPacks } from './packs.ts'
import { recordQuery, usage } from './usage.ts'

const HEALTH: readonly HealthRange[] = ['1h', '6h', '24h', '7d']
const BASELINES: readonly Baseline[] = ['static', 'standard', 'frontier', 'observe-default']
const AUDIT_ACTION = /^[a-z]+\.[A-Za-z-]+$/

export const adminDataHandlers: Record<string, Handler> = {
  'admin.usage': async (ctx: Ctx) => ({ body: await usage(ctx, 'admin') }),
  'admin.records': async (ctx: Ctx) => {
    const { scan, callers } = recordQuery(ctx, 'admin')
    const { deps } = ctx
    // One caller: that principal's partition (exact pages). Several or none: the day index, filtered.
    const page = callers?.length === 1
      ? await deps.usage.principalRecords(callers[0] as string, scan)
      : await deps.usage.allRecords(callers ? { ...scan, filter: (r) => callers.includes(r.principal) && (!scan.filter || scan.filter(r)) } : scan)
    const refs = await callerRefs(deps, new Set(page.items.map((r) => r.principal)))
    const body: Page<RecordSummary> = { items: page.items.map((r) => summaryOf(r, refs.get(r.principal))), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    return { body }
  },
  'admin.record': async (ctx: Ctx) => {
    const caller = str(query(ctx.event), 'caller')
    const rec = await ctx.deps.usage.record(reqIdOf(ctx), caller === undefined ? undefined : principalKeyOf(caller, 'caller'), tsOf(ctx))
    if (!rec) throw new HttpError(404, 'not-found', 'no such record')
    return { body: detailOf(rec, (await callerRefs(ctx.deps, [rec.principal])).get(rec.principal)) }
  },
  'admin.session': async ({ event, params, deps }: Ctx) => {
    const label = params.label ?? ''
    const caller = str(query(event), 'caller')
    if (caller === undefined) throw new HttpError(400, 'bad-request', 'caller: required (sessions are stored per principal)')
    const key = principalKeyOf(caller, 'caller')
    const items = SESSION_LABEL.test(label) ? await deps.usage.session(key, label, 2000) : []
    if (items.length === 0) throw new HttpError(404, 'not-found', 'no such session')
    return { body: sessionOf(label, items, deps.now(), LIVE_WINDOW_MS, (await callerRefs(deps, [key])).get(key)) }
  },
  'admin.assessor.packs': async ({ deps }: Ctx) => {
    const running = await runningPacks(deps)
    const current = await currentManifest(deps)
    const drift = (await deps.usage.configReports(20)).find((r) => r.drift !== undefined)?.drift
    const body: PacksResponse & { source: string; warnings: unknown[]; drift?: unknown } = {
      schemaVersion: 1, default: current?.default ?? '', packs: running.packs, source: running.source, warnings: running.warnings, ...(drift !== undefined ? { drift } : {}),
    }
    return { body }
  },
  'admin.gateway': async ({ deps }: Ctx) => {
    try { return { body: await deps.gateway.describe() } } catch (e) {
      throw new HttpError(502, 'gateway-unavailable', `could not read the gateway (${e instanceof Error ? e.name : 'error'})`)
    }
  },
  'admin.health': async ({ event, deps }: Ctx) => {
    const range = (str(query(event), 'range') ?? '1h') as HealthRange
    if (!HEALTH.includes(range)) throw new HttpError(400, 'bad-request', `range: one of ${HEALTH.join('|')}`)
    try { return { body: await deps.metrics.health(range) } } catch (e) {
      throw new HttpError(502, 'metrics-unavailable', `metrics are not available (${e instanceof Error ? e.name : 'error'})`)
    }
  },
  'admin.audit': async ({ event, deps }: Ctx) => {
    const sp = query(event)
    const r = dayRange(day(sp, 'from'), day(sp, 'to'), deps.now(), 30)
    const actions = list<string>(sp, 'action')
    if (actions?.some((a) => !AUDIT_ACTION.test(a))) throw new HttpError(400, 'bad-request', 'action: <area>.<verb>')
    const actor = str(sp, 'actor')
    if (actor !== undefined && actor !== 'router') principalKeyOf(actor, 'actor')
    const target = str(sp, 'target')
    if (target !== undefined && target.length > 200) throw new HttpError(400, 'bad-request', 'target: at most 200 characters')
    const c = cursor(sp)
    const page = await deps.console.listAudit({
      from: `${r.from}T00:00:00.000Z`, to: new Date(Date.parse(`${r.to}T00:00:00Z`) + 86_400_000).toISOString(), limit: int(sp, 'limit', 100, 1, 500),
      ...(actor ? { actor } : {}), ...(actions ? { actions: actions as AuditAction[] } : {}), ...(target ? { target } : {}), ...(c ? { cursor: c } : {}),
    })
    return { body: page }
  },
  'admin.settings.get': async ({ deps }: Ctx) => {
    const s = await deps.console.getSettings()
    const body: DeploymentSettings = {
      // Retention is a deploy setting (recordRetentionDays, 0c decision): shown, not editable here.
      defaultBaseline: s?.defaultBaseline ?? 'static',
      readOnly: { retentionDays: deps.env.retentionDays ?? DEFAULT_RETENTION_DAYS, refreshDays: deps.env.refreshDays, catalog: { region: deps.catalog.region, version: deps.catalog.version }, universe: [...deps.env.modelUniverse] },
      identity: (await deps.console.getIdentityDelivery()) ?? { state: 'pending' },
    }
    return { body }
  },
  'admin.settings.patch': async (ctx: Ctx) => {
    const { deps } = ctx
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['retentionDays', 'defaultBaseline'])
    if (b.retentionDays !== undefined) throw new HttpError(400, 'bad-request', 'retentionDays is a deploy setting (recordRetentionDays): change it with a CDK deploy')
    const before = { defaultBaseline: (await deps.console.getSettings())?.defaultBaseline ?? ('static' as Baseline) }
    const next = { ...before }
    if (b.defaultBaseline !== undefined) {
      if (!BASELINES.includes(b.defaultBaseline as Baseline)) throw new HttpError(400, 'bad-request', `defaultBaseline: one of ${BASELINES.join('|')}`)
      next.defaultBaseline = b.defaultBaseline as Baseline
    }
    await deps.console.putSettings(next)
    await audit(ctx, { action: 'settings.change', target: 'settings:deployment', summary: `changed ${Object.keys(b).join(', ') || 'nothing'}`, before, after: next })
    return (adminDataHandlers['admin.settings.get'] as Handler)(ctx)
  },
}
