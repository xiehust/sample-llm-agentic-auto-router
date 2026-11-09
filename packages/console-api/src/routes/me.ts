// Self routes: the caller's own data. The principal always comes from the verified token (ctx.caller), never from
// a parameter, and another principal's record or session is 404 (ids cannot be probed).
import type {
  Budget, BudgetStatus, Cap, ConfigureJson, LatestResponse, PoolView, Profile, SetupInfo, Tier,
} from '@auto-router/console-contract'
import { HttpError } from '../http.ts'
import { detailOf, sessionOf, summaryOf } from '../records.ts'
import type { ConfigDocument } from '../local-types.ts'
import type { Deps, MemberSettings } from '../ports.ts'
import type { Ctx, Handler } from '../app.ts'
import { effectiveConfig } from '../effective.ts'
import { audit, monthOf, nanoToUsd, reqIdOf, SESSION_LABEL, tsOf } from './common.ts'
import { archivedPack, PACK_VERSION } from './packs.ts'
import { recordQuery, usage } from './usage.ts'

const TIER_RANK: Record<Tier, number> = { fast: 0, standard: 1, frontier: 2 }
export const LIVE_WINDOW_MS = 10 * 60_000
export const ROLLUP_DAYS = 400
export const DEFAULT_RETENTION_DAYS = 90

/** The router's view of a principal: cap (principal override > group default > none) and budget (own > default). */
export async function effectiveAccess(deps: Deps, m: MemberSettings | undefined, access: ConfigDocument['access'] | undefined): Promise<{ cap?: Cap; budget?: Budget }> {
  const cap = m?.cap ?? (m ? access?.groups[m.group] : undefined)
  const budget = m?.budget ?? (await deps.console.getDefaultBudget())
  return { ...(cap ? { cap } : {}), ...(budget ? { budget } : {}) }
}

export async function budgetStatus(deps: Deps, key: string, budget: Budget | undefined): Promise<BudgetStatus | undefined> {
  if (!budget) return undefined
  const month = monthOf(deps.now())
  const spent = (await deps.usage.monthSpend([key], month)).get(key) ?? 0
  return { ...budget, spentUsd: nanoToUsd(spent), month }
}

/** The `llmar configure` block; absent while a required value is missing. */
export function configureJson(env: Deps['env']): { json?: ConfigureJson; missing: string[] } {
  const required: Record<string, unknown> = { cognitoDomain: env.cognitoDomain, cliClientId: env.cliClientId, invokeScope: env.invokeScope, gatewayUrl: env.gatewayUrl }
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
  if (!env.callbackPorts?.length) missing.push('callbackPorts')
  if (missing.length) return { missing }
  return {
    missing,
    json: {
      schemaVersion: 1, region: env.region, cognitoDomain: env.cognitoDomain as string, clientId: env.cliClientId as string, scope: env.invokeScope as string,
      redirectPorts: [...(env.callbackPorts ?? [])], gatewayUrl: env.gatewayUrl as string,
      identityHeader: env.identityHeader === undefined ? 'x-api-key' : env.identityHeader, refreshDays: env.refreshDays,
      ...(env.authorizeEndpoint ? { authorizeEndpoint: env.authorizeEndpoint } : {}), ...(env.tokenEndpoint ? { tokenEndpoint: env.tokenEndpoint } : {}),
      ...(env.revokeEndpoint ? { revokeEndpoint: env.revokeEndpoint } : {}), ...(env.codexOauthPort ? { codexOauthPort: env.codexOauthPort } : {}),
    },
  }
}

type PolicyView = { mode?: 'observe' | 'auto'; aliases?: Record<string, Tier | 'default'>; observeDefaults?: Record<string, string>
  pools?: Record<string, { defaultTier?: Tier; models?: Array<{ model: string; tier?: Tier }> }> }

/** Pools as tiers → models, filtered to the caller's tier limit (pins listed in allowPins stay visible). */
export function poolViews(deps: Deps, policy: PolicyView, cap: Cap | undefined): PoolView[] {
  const max = cap?.maxTier ? TIER_RANK[cap.maxTier] : 2
  const pins = new Set(cap?.allowPins ?? [])
  return Object.entries(policy.pools ?? {}).map(([dialect, pool]) => {
    const byTier = new Map<Tier, string[]>()
    for (const e of pool.models ?? []) {
      const tier = (e.tier ?? deps.catalog.models.find((m) => m.modelId === e.model)?.tier) as Tier | undefined
      if (!tier || (TIER_RANK[tier] > max && !pins.has(e.model))) continue
      byTier.set(tier, [...(byTier.get(tier) ?? []), e.model])
    }
    const tiers = (['fast', 'standard', 'frontier'] as const).filter((t) => byTier.has(t)).map((t) => ({ tier: t, models: byTier.get(t) as string[] }))
    return { dialect: dialect as PoolView['dialect'], defaultTier: pool.defaultTier ?? 'standard', tiers }
  })
}

const profile: Handler = async ({ caller, deps }) => {
  const m = await deps.console.getMember(caller.key)
  const eff = await effectiveConfig(deps)
  const access = await effectiveAccess(deps, m, eff.values.access)
  const u = await deps.directory.userBySub(caller.sub)
  const settings = await deps.console.getSettings()
  const budget = await budgetStatus(deps, caller.key, access.budget)
  const body: Profile = {
    principal: caller.key, username: caller.username, ...(u?.name ? { name: u.name } : {}), ...(u?.email ? { email: u.email } : {}),
    role: m?.group === 'admin' ? 'admin' : 'member', groups: caller.groups, ...(budget ? { budget } : {}), ...(access.cap ? { tierLimit: access.cap } : {}),
    deployment: {
      // Effective values (0d-effective-config): document ?? baked, else 'unknown'; never a guessed default.
      prefix: deps.env.prefix, region: deps.env.region, mode: eff.settings.routerMode.value ?? 'unknown', identityMode: eff.settings.identityMode.value ?? 'unknown',
      effective: eff.settings,
      catalog: { region: deps.catalog.region, version: deps.catalog.version }, retentionDays: deps.env.retentionDays ?? DEFAULT_RETENTION_DAYS,
      rollupDays: ROLLUP_DAYS, defaultBaseline: settings?.defaultBaseline ?? 'static',
    },
  }
  return { body }
}

const setup: Handler = async (ctx) => {
  const { deps } = ctx
  const env = deps.env
  const eff = await effectiveConfig(deps)
  const access = await effectiveAccess(deps, await deps.console.getMember(ctx.caller.key), eff.values.access)
  const policy = (eff.values.policy ?? {}) as PolicyView
  const cj = configureJson(env)
  const budget = await budgetStatus(deps, ctx.caller.key, access.budget)
  const body: SetupInfo = {
    ...(env.gatewayUrl ? { gatewayUrl: env.gatewayUrl } : {}), ...(env.inferenceUrl ? { inferenceUrl: env.inferenceUrl } : {}),
    ...(env.cognitoDomain ? { cognitoDomain: env.cognitoDomain } : {}), ...(env.tokenEndpoint ? { tokenEndpoint: env.tokenEndpoint } : {}),
    ...(env.authorizeEndpoint ? { authorizeEndpoint: env.authorizeEndpoint } : {}), ...(env.cliClientId ? { clientId: env.cliClientId } : {}),
    ...(env.invokeScope ? { scope: env.invokeScope } : {}), ...(env.callbackPorts ? { redirectPorts: [...env.callbackPorts] } : {}),
    ...(env.codexOauthPort ? { codexOauthPort: env.codexOauthPort } : {}), ...(cj.json ? { configureJson: cj.json } : {}),
    mode: eff.settings.routerMode.value ?? 'unknown', identityMode: eff.settings.identityMode.value ?? 'unknown', effective: eff.settings, observeDefaults: { ...(policy.observeDefaults ?? {}) },
    aliases: { ...(policy.aliases ?? {}) }, pools: poolViews(deps, policy, access.cap), ...(access.cap ? { tierLimit: access.cap } : {}),
    ...(budget ? { budget } : {}), refreshDays: env.refreshDays,
    // Members learn only that something is missing; admins see the names (4f §4.6).
    ...(cj.missing.length ? { missing: ctx.caller.role === 'admin' ? cj.missing : ['deployment'] } : {}),
  }
  return { body }
}

export const meHandlers = {
  'me.profile': profile,
  'me.usage': async (ctx: Ctx) => ({ body: await usage(ctx, 'self') }),
  'me.records': async (ctx: Ctx) => {
    const { scan } = recordQuery(ctx, 'self')
    const p = await ctx.deps.usage.principalRecords(ctx.caller.key, scan)
    return { body: { items: p.items.map((r) => summaryOf(r)), ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}) } }
  },
  'me.record': async (ctx: Ctx) => {
    const rec = await ctx.deps.usage.record(reqIdOf(ctx), ctx.caller.key, tsOf(ctx))
    if (!rec) throw new HttpError(404, 'not-found', 'no such record')
    return { body: detailOf(rec) }
  },
  'me.session': async ({ params, caller, deps }: Ctx) => {
    const label = params.label ?? ''
    const items = SESSION_LABEL.test(label) ? await deps.usage.session(caller.key, label, 2000) : []
    if (items.length === 0) throw new HttpError(404, 'not-found', 'no such session')
    return { body: sessionOf(label, items, deps.now(), LIVE_WINDOW_MS) }
  },
  'me.latest': async ({ caller, deps }: Ctx) => {
    const now = deps.now()
    const p = await deps.usage.principalRecords(caller.key, { from: new Date(now - LIVE_WINDOW_MS).toISOString(), to: new Date(now + 60_000).toISOString(), limit: 1 })
    const r = p.items[0]
    const body: LatestResponse = {}
    if (r) {
      const s = summaryOf(r)
      body.record = { ts: s.ts, reqId: s.reqId, status: s.status, ...(s.dialect ? { dialect: s.dialect } : {}), ...(s.requested ? { requested: s.requested } : {}),
        ...(s.servedModel ? { servedModel: s.servedModel } : {}), ...(s.errorCode ? { errorCode: s.errorCode } : {}) }
    }
    return { body }
  },
  'me.setup': setup,
  // Revokes the caller's refresh tokens (console session and `llmar`); issued access tokens run out on their own.
  'me.signOutEverywhere': async (ctx: Ctx) => {
    await ctx.deps.directory.signOut(ctx.caller.username)
    await audit(ctx, { action: 'member.signOut', target: ctx.caller.key, summary: 'signed out everywhere (self)' })
    return { status: 204 }
  },
  'packs.get': async ({ params, deps }: Ctx) => {
    // The contract decodes path parameters once; a client (or a proxy) that encoded twice still resolves.
    let pv = params.packVersion ?? ''
    if (/%[0-9a-f]{2}/i.test(pv)) { try { pv = decodeURIComponent(pv) } catch { throw new HttpError(404, 'not-found', 'no such pack version') } }
    if (!PACK_VERSION.test(pv)) throw new HttpError(404, 'not-found', 'no such pack version')
    const entry = await archivedPack(deps, pv)
    if (!entry) throw new HttpError(404, 'not-found', 'no such pack version')
    // Archive entries are immutable: let the browser keep them.
    return { body: entry, headers: { 'cache-control': 'private, max-age=86400, immutable' } }
  },
} satisfies Record<string, Handler>
