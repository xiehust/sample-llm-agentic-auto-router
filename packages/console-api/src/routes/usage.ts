// GET /api/me/usage and /api/admin/usage (also `view=savings`), and the records list query, shared by both scopes.
// Self scope: the principal is the caller; the caller dimension and filter are admin only (400 otherwise).
import type { Baseline, RecordQuery, StatusClass, Tier, UsageDimension } from '@auto-router/console-contract'
import { HttpError, bool, cursor, day, int, isoParam, list, query, str } from '../http.ts'
import { recordFilter } from '../records.ts'
import { savingsReport, servedTier, usageReport } from '../report.ts'
import type { Ctx } from '../app.ts'
import type { RecordScan } from '../ports.ts'
import { effectiveConfig } from '../effective.ts'
import { callerRefs, dayRange, principalKeyOf } from './common.ts'

const DIMS: readonly UsageDimension[] = ['model', 'tier', 'dialect', 'day', 'caller']
const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const DIALECTS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const
const STATUS: readonly StatusClass[] = ['2xx', '4xx', '5xx', '499']
const BASELINES: readonly Baseline[] = ['static', 'standard', 'frontier', 'observe-default']

export async function usage(ctx: Ctx, scope: 'self' | 'admin') {
  const { deps } = ctx
  const sp = query(ctx.event)
  const r = dayRange(day(sp, 'from'), day(sp, 'to'), deps.now(), 30)
  const callers = list<string>(sp, 'caller')?.map((k) => principalKeyOf(k, 'caller'))
  if (scope === 'self' && callers) throw new HttpError(400, 'bad-request', 'caller: admin only')
  if (list(sp, 'status', STATUS)) throw new HttpError(400, 'bad-request', 'status: not available for daily rollups yet (use Decisions)')
  const f = { ...(callers ? { callers } : {}), models: list<string>(sp, 'model'), tiers: list(sp, 'tier', TIERS), dialects: list(sp, 'dialect', DIALECTS) }
  // Self: the caller's U# items; admin: the A# items (all principals, incl. 'none').
  const items = await deps.usage.rollups(r.from, r.to, scope === 'self' ? ctx.caller.key : undefined)
  const filtered = items.filter((it) => (!f.callers || f.callers.includes(it.principal)) && (!f.models || f.models.includes(it.servedModel))
    && (!f.tiers || f.tiers.includes(servedTier(deps.catalog, it.servedModel) as Tier)) && (!f.dialects || f.dialects.includes(it.dialect as never)))
  const refs = scope === 'admin' ? await callerRefs(deps, new Set(filtered.map((it) => it.principal))) : undefined

  if (str(sp, 'view') === 'savings') {
    const baseline = (str(sp, 'baseline') ?? (await deps.console.getSettings())?.defaultBaseline ?? 'static') as Baseline
    if (!BASELINES.includes(baseline)) throw new HttpError(400, 'bad-request', `baseline: one of ${BASELINES.join('|')}`)
    const groupBy = (str(sp, 'groupBy') ?? 'model') as 'model' | 'dialect' | 'caller'
    if (!['model', 'dialect', 'caller'].includes(groupBy) || (groupBy === 'caller' && scope === 'self')) throw new HttpError(400, 'bad-request', 'groupBy: model | dialect | caller (admin)')
    const eff = await effectiveConfig(deps)
    const policy = (eff.values.policy ?? {}) as { mode?: 'observe' | 'auto'; observeDefaults?: Record<string, string> }
    // The effective mode; when unknown, the data decides (projection counters exist only for observe-mode lines).
    const mode = policy.mode ?? (filtered.some((it) => Object.keys(it.counters).some((k) => k.startsWith('pn_'))) ? 'observe' : 'auto')
    return savingsReport(filtered, {
      from: r.from, to: r.to, baseline, groupBy, mode, catalog: deps.catalog,
      observeDefaultTier: (d) => { const m = policy.observeDefaults?.[d]; return m ? servedTier(deps.catalog, m) : '-' },
      ...(refs ? { callers: refs } : {}),
    })
  }
  const groupBy = (str(sp, 'groupBy') ?? 'model') as UsageDimension
  const stackBy = (str(sp, 'stackBy') ?? 'model') as Exclude<UsageDimension, 'day'>
  if (!DIMS.includes(groupBy) || !DIMS.includes(stackBy) || stackBy === ('day' as string)) throw new HttpError(400, 'bad-request', 'groupBy / stackBy: model | tier | dialect | day | caller')
  if (scope === 'self' && (groupBy === 'caller' || stackBy === 'caller')) throw new HttpError(400, 'bad-request', 'caller dimension: admin only')
  return usageReport(filtered, { from: r.from, to: r.to, groupBy, stackBy, catalog: deps.catalog, ...(refs ? { callers: refs } : {}) })
}

const DAY_MS = 86_400_000
/** RecordQuery from the query string. `caller` only in admin scope. */
export function recordQuery(ctx: Ctx, scope: 'self' | 'admin'): { scan: RecordScan; callers?: string[] } {
  const sp = query(ctx.event)
  const now = ctx.deps.now()
  const to = isoParam(sp, 'to', now + 60_000)
  const from = isoParam(sp, 'from', to - 7 * DAY_MS)
  if (from > to) throw new HttpError(400, 'bad-request', 'from must not be after to')
  if (to - from > 92 * DAY_MS) throw new HttpError(400, 'bad-request', 'range at most 92 days')
  const callers = list<string>(sp, 'caller')?.map((k) => principalKeyOf(k, 'caller'))
  if (scope === 'self' && callers) throw new HttpError(400, 'bad-request', 'caller: admin only')
  const miss = str(sp, 'miss')
  if (miss !== undefined && !['any', 'model_changed', 'ttl_expired', 'prefix_changed', 'unknown'].includes(miss)) throw new HttpError(400, 'bad-request', 'miss: any or a miss reason')
  const mode = str(sp, 'mode')
  if (mode !== undefined && mode !== 'observe' && mode !== 'auto') throw new HttpError(400, 'bad-request', 'mode: observe | auto')
  const session = str(sp, 'session')
  if (session !== undefined && !/^[0-9a-f]{16}$/.test(session)) throw new HttpError(400, 'bad-request', 'session: a session label')
  const q: Omit<RecordQuery, 'from' | 'to' | 'cursor' | 'limit' | 'caller'> = {
    ...(session ? { session } : {}),
    dialect: list(sp, 'dialect', DIALECTS) as RecordQuery['dialect'], action: list(sp, 'action', ['initialize', 'retain', 'switch', 'pin'] as const),
    point: list(sp, 'point') as RecordQuery['point'], model: list<string>(sp, 'model'), tier: list(sp, 'tier', TIERS), status: list(sp, 'status', STATUS),
    ...(mode ? { mode: mode as 'observe' | 'auto' } : {}), assessor: bool(sp, 'assessor'), failover: bool(sp, 'failover'),
    ...(miss ? { miss: miss as RecordQuery['miss'] } : {}), wouldChooseDiffers: bool(sp, 'wouldChooseDiffers'),
  }
  for (const k of Object.keys(q) as Array<keyof typeof q>) if (q[k] === undefined) delete q[k]
  const filter = recordFilter(q)
  const c = cursor(sp)
  const scan: RecordScan = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: int(sp, 'limit', 50, 1, 200), ...(c ? { cursor: c } : {}), ...(filter ? { filter } : {}) }
  return { scan, ...(callers ? { callers } : {}) }
}
