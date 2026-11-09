// Members (Cognito users), service clients (console-created app clients), budgets and tier limits (design v1
// 0.15–0.16, 4f §4.7–4.8). The console table's MEMBER#<kind:id> items are the source of truth for the router's view
// and for console authorization; every change rewrites identity/principals.json (`{ "<kind>:<id>": { group, cap? } }`)
// and, for disable / enable / delete, identity/blocks.json (`{ schemaVersion, etag, principals: [{ kind, id,
// reason, at }] }`). The router polls both (≈ 30 s). Secrets are returned once and never logged or audited.
import type {
  Budget, BudgetsResponse, ClientSecretResponse, Member, MemberDetail, MemberStatus, Role, ServiceClient,
} from '@auto-router/console-contract'
import { HttpError, jsonBody, requireObject } from '../http.ts'
import type { Deps, DirectoryUser, MemberSettings } from '../ports.ts'
import type { Ctx, Handler } from '../app.ts'
import { applyOptional, audit, budgetOf, capOf, iso, monthOf, nanoToUsd, onlyKeys, stringField, SUB } from './common.ts'
import { budgetStatus } from './me.ts'

export const PRINCIPALS_KEY = 'identity/principals.json'
export const BLOCKS_KEY = 'identity/blocks.json'
/** Cognito ClientIdType is `[\w+]+`; the router accepts `[\w+-]{1,128}` (a3). */
const CLIENT_ID = /^[\w+-]{1,128}$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/
const ROLES: readonly Role[] = ['admin', 'member']

// ---------------------------------------------------------------- identity objects

/** `{ "<kind>:<id>": { group, cap? } }` from every MEMBER item (design §2.1). */
export function principalsDocument(members: readonly MemberSettings[]): Record<string, { group: string; cap?: MemberSettings['cap'] }> {
  const out: Record<string, { group: string; cap?: MemberSettings['cap'] }> = {}
  for (const m of [...members].sort((a, b) => (a.key < b.key ? -1 : 1))) out[m.key] = { group: m.group, ...(m.cap ? { cap: m.cap } : {}) }
  return out
}

export function blocksDocument(members: readonly MemberSettings[], etag: string) {
  const principals = members.filter((m) => m.disabled).sort((a, b) => (a.key < b.key ? -1 : 1)).map((m) => {
    const i = m.key.indexOf(':')
    return { kind: m.key.slice(0, i), id: m.key.slice(i + 1), reason: 'disabled' as const, at: m.updatedAt }
  })
  return { schemaVersion: 1 as const, etag, principals }
}

/**
 * Rewrites the identity objects from the table. Re-reads after writing and repeats when another admin changed the
 * table meanwhile, so the objects end on the latest state.
 */
export async function publishIdentity(deps: Deps, which: { principals?: boolean; blocks?: boolean }): Promise<void> {
  let last = ''
  for (let i = 0; i < 3; i++) {
    const members = await deps.console.listMembers()
    const snapshot = JSON.stringify(members)
    if (snapshot === last) return
    if (which.principals) await deps.objects.put(PRINCIPALS_KEY, `${JSON.stringify(principalsDocument(members))}\n`)
    if (which.blocks) await deps.objects.put(BLOCKS_KEY, `${JSON.stringify(blocksDocument(members, deps.uuid()))}\n`)
    last = snapshot
  }
}

/**
 * Publishes the identity objects, records the delivery state, then audits the action. A failed S3 put is audited as
 * failed and answers 502 identity-delivery-failed (the table change stands; admin.identity.republish repeats the
 * publish), design §2.3a.
 */
export async function publishAndAudit(ctx: Ctx, which: { principals?: boolean; blocks?: boolean }, e: Parameters<typeof audit>[1]): Promise<void> {
  const { deps } = ctx
  const at = iso(deps.now())
  // Every write rewrites both objects from the table (0d review): a failed or concurrent earlier publish can never
  // leave one stale while the state says delivered. `which` only documents what the action changed.
  void which
  try {
    await publishIdentity(deps, { principals: true, blocks: true })
  } catch (err) {
    deps.log({ kind: 'console-api-identity-delivery-failed', requestId: ctx.requestId, error: err instanceof Error ? err.name : 'unknown' })
    await deps.console.putIdentityDelivery({ state: 'notDelivered', at, errorCode: 'identity-delivery-failed' })
    await audit(ctx, { ...e, result: 'failed', errorCode: 'identity-delivery-failed' })
    throw new HttpError(502, 'identity-delivery-failed', 'the change is saved but the router identity files were not written; retry with POST /api/admin/identity/republish')
  }
  await deps.console.putIdentityDelivery({ state: 'delivered', at })
  await audit(ctx, e)
}

// ---------------------------------------------------------------- members

const userKey = (u: DirectoryUser) => `user:${u.sub.toLowerCase()}`

async function userOf(deps: Deps, id: string | undefined): Promise<DirectoryUser> {
  if (!id || !SUB.test(id)) throw new HttpError(404, 'not-found', 'no such member')
  const u = await deps.directory.userBySub(id.toLowerCase())
  if (!u) throw new HttpError(404, 'not-found', 'no such member')
  return u
}

function statusOf(u: DirectoryUser, m: MemberSettings | undefined): MemberStatus {
  if (!u.enabled || m?.disabled) return 'disabled'
  return u.status === 'FORCE_CHANGE_PASSWORD' ? 'invited' : 'active'
}

function memberView(u: DirectoryUser, m: MemberSettings | undefined, spentNano: number | undefined): Member {
  return {
    id: u.sub, username: u.username, ...(u.name ? { name: u.name } : {}), email: u.email,
    role: m?.group === 'admin' ? 'admin' : m?.group === 'member' ? 'member' : u.groups.includes('admin') ? 'admin' : 'member',
    status: statusOf(u, m), mfa: u.mfa ? 'enrolled' : 'not-enrolled', createdAt: u.createdAt, costThisMonthUsd: nanoToUsd(spentNano),
    ...(m?.budget ? { budget: m.budget } : {}), ...(m?.cap ? { tierLimit: m.cap } : {}),
  }
}

async function spentThisMonth(deps: Deps, keys: string[]): Promise<Map<string, number>> {
  return keys.length ? deps.usage.monthSpend(keys, monthOf(deps.now())) : new Map()
}

function notSelf(ctx: Ctx, u: DirectoryUser): void {
  if (u.sub.toLowerCase() === ctx.caller.sub) throw new HttpError(409, 'cannot-disable-self', 'you cannot do this to your own account')
}

/** Refuses when `u` is the last active admin (by MEMBER items, the authorization source). */
async function notLastAdmin(deps: Deps, u: DirectoryUser): Promise<void> {
  const members = await deps.console.listMembers()
  const target = members.find((m) => m.key === userKey(u))
  if (target?.group !== 'admin') return
  if (members.filter((m) => m.group === 'admin' && !m.disabled).length <= 1) throw new HttpError(409, 'last-admin', 'the last admin cannot be removed, demoted or disabled')
}

async function settingsFor(deps: Deps, u: DirectoryUser): Promise<MemberSettings> {
  const now = iso(deps.now())
  return (await deps.console.getMember(userKey(u))) ?? { key: userKey(u), group: u.groups.includes('admin') ? 'admin' : 'member', createdAt: now, updatedAt: now }
}

async function detail(deps: Deps, u: DirectoryUser): Promise<MemberDetail> {
  const key = userKey(u)
  const m = await deps.console.getMember(key)
  const spent = await spentThisMonth(deps, [key])
  const now = deps.now()
  const history = (await deps.console.listAudit({ from: '1970-01-01T00:00:00.000Z', to: iso(now + 1), target: key, limit: 50 })).items
    .map((e) => ({ ts: e.ts, status: e.action === 'member.disable' ? 'disabled' as const : e.action === 'member.enable' ? 'active' as const : e.action === 'member.invite' ? 'invited' as const : 'role' as const,
      ...(e.actor.key ? { by: e.actor.key } : {}), detail: e.summary }))
  // Recent sessions from this month's records (bounded).
  const recs = (await deps.usage.principalRecords(key, { from: `${monthOf(now)}-01T00:00:00.000Z`, to: iso(now + 60_000), limit: 500 })).items
  const sessions = new Map<string, { session: string; last: string; requests: number; costUsd: number }>()
  for (const r of recs) {
    if (!r.session) continue
    const s = sessions.get(r.session) ?? { session: r.session, last: r.ts, requests: 0, costUsd: 0 }
    s.requests += 1
    s.costUsd += nanoToUsd(((r.cost as { a?: number } | undefined)?.a) ?? 0)
    if (r.ts > s.last) s.last = r.ts
    sessions.set(r.session, s)
  }
  const bs = await budgetStatus(deps, key, m?.budget)
  return { ...memberView(u, m, spent.get(key)), history, sessions: [...sessions.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 20), ...(bs ? { budgetStatus: bs } : {}) }
}

const memberAction: Handler = async (ctx) => {
  const { deps } = ctx
  const u = await userOf(deps, ctx.params.id)
  const b = requireObject(jsonBody(ctx.event))
  onlyKeys(b, ['action'])
  const m = await settingsFor(deps, u)
  const now = iso(deps.now())
  const target = userKey(u)
  switch (b.action) {
    case 'disable':
      notSelf(ctx, u)
      await notLastAdmin(deps, u)
      await deps.console.putMember({ ...m, disabled: true, updatedAt: now }) // console access ends at once (authorize)
      await deps.directory.disable(u.username)
      await deps.directory.signOut(u.username) // revokes refresh tokens: llmar must sign in again after enable
      await publishAndAudit(ctx, { blocks: true, principals: true }, { action: 'member.disable', target, summary: 'disabled; refresh tokens revoked' })
      break
    case 'enable':
      await deps.directory.enable(u.username)
      await deps.console.putMember({ ...m, disabled: false, updatedAt: now })
      await publishAndAudit(ctx, { blocks: true, principals: true }, { action: 'member.enable', target, summary: 'enabled' })
      break
    case 'resend-invite':
      if (u.status !== 'FORCE_CHANGE_PASSWORD') throw new HttpError(400, 'bad-request', 'the member has already set a password')
      await deps.directory.resendInvite(u.username)
      await audit(ctx, { action: 'member.invite', target, summary: 'invite re-sent' })
      break
    case 'sign-out':
      await deps.directory.signOut(u.username)
      await audit(ctx, { action: 'member.signOut', target, summary: 'refresh tokens revoked' })
      break
    default:
      throw new HttpError(400, 'bad-request', 'action: resend-invite | disable | enable | sign-out')
  }
  return { body: await detail(deps, (await deps.directory.getUser(u.username)) ?? u) }
}

// ---------------------------------------------------------------- service clients

async function clientSettings(deps: Deps, id: string | undefined): Promise<MemberSettings> {
  // Only clients the console created (a MEMBER item of group service) are reachable: never agent / cli / console.
  if (!id || !CLIENT_ID.test(id)) throw new HttpError(404, 'not-found', 'no such service client')
  const m = await deps.console.getMember(`client:${id}`)
  if (!m || m.group !== 'service') throw new HttpError(404, 'not-found', 'no such service client')
  return m
}

const clientView = (deps: Deps, m: MemberSettings, spentNano?: number): ServiceClient => ({
  id: m.key.slice('client:'.length), name: m.name ?? '', ...(m.description ? { description: m.description } : {}), status: m.disabled ? 'disabled' : 'active',
  createdAt: m.createdAt, costThisMonthUsd: nanoToUsd(spentNano), scope: deps.env.invokeScope ?? '',
  ...(m.budget ? { budget: m.budget } : {}), ...(m.cap ? { tierLimit: m.cap } : {}),
})
const secretResponse = (deps: Deps, m: MemberSettings, secret: string): ClientSecretResponse => ({
  client: clientView(deps, m), secret, tokenEndpoint: deps.env.tokenEndpoint ?? '', scope: deps.env.invokeScope ?? '',
})

// ---------------------------------------------------------------- handlers

export const memberHandlers: Record<string, Handler> = {
  'admin.members.list': async ({ deps }: Ctx) => {
    const users = await deps.directory.listUsers()
    const settings = new Map((await deps.console.listMembers()).map((m) => [m.key, m]))
    const spent = await spentThisMonth(deps, users.map(userKey))
    const identity = (await deps.console.getIdentityDelivery()) ?? { state: 'pending' }
    return { body: { items: users.map((u) => memberView(u, settings.get(userKey(u)), spent.get(userKey(u)))), identity } }
  },
  /** Repeats the identity publish after a failed S3 put (design §2.3a). */
  'admin.identity.republish': async (ctx: Ctx) => {
    await publishAndAudit(ctx, { principals: true, blocks: true }, { action: 'config.redeliver', target: 'identity', summary: 'republish identity/principals.json and identity/blocks.json' })
    return { body: { identity: (await ctx.deps.console.getIdentityDelivery()) ?? { state: 'pending' } } }
  },
  'admin.members.invite': async (ctx: Ctx) => {
    const { deps } = ctx
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['email', 'name', 'role', 'budget', 'tierLimit'])
    const email = (stringField(b, 'email', { max: 254 }) as string).toLowerCase()
    if (!EMAIL.test(email)) throw new HttpError(400, 'bad-request', 'email: an e-mail address is required')
    const name = stringField(b, 'name', { max: 100 }) as string
    if (!ROLES.includes(b.role as Role)) throw new HttpError(400, 'bad-request', "role: 'admin' | 'member'")
    const role = b.role as Role
    const budget = budgetOf(b.budget, 'budget') ?? undefined
    const cap = capOf(b.tierLimit, '/tierLimit') ?? undefined
    let u: DirectoryUser | 'exists'
    try { u = await deps.directory.createUser({ email, name, role }) } catch (e) {
      throw new HttpError(502, 'invite-failed', `Cognito refused the invite (${e instanceof Error ? e.name : 'error'})`)
    }
    if (u === 'exists') throw new HttpError(409, 'email-exists', 'a user with this e-mail exists')
    const now = iso(deps.now())
    const m: MemberSettings = { key: userKey(u), group: role, createdAt: now, updatedAt: now, ...(budget ? { budget } : {}), ...(cap ? { cap } : {}) }
    await deps.console.putMember(m)
    // The e-mail is the member's identifier in the directory; the audit keeps the principal id only.
    await publishAndAudit(ctx, { principals: true }, { action: 'member.invite', target: m.key, summary: `invited as ${role}`, after: { role, budget, tierLimit: cap } })
    return { status: 201, body: memberView(u, m, 0) }
  },
  'admin.members.get': async ({ params, deps }: Ctx) => ({ body: await detail(deps, await userOf(deps, params.id)) }),
  'admin.members.patch': async (ctx: Ctx) => {
    const { deps } = ctx
    const u = await userOf(deps, ctx.params.id)
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['role', 'budget', 'tierLimit'])
    const before = await settingsFor(deps, u)
    const m: MemberSettings = { ...before, updatedAt: iso(deps.now()) }
    let roleChanged = false
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role as Role)) throw new HttpError(400, 'bad-request', "role: 'admin' | 'member'")
      if (b.role !== before.group) {
        notSelf(ctx, u)
        if (b.role !== 'admin') await notLastAdmin(deps, u)
        m.group = b.role as Role
        roleChanged = true
      }
    }
    applyOptional(m, 'budget', budgetOf(b.budget, 'budget'))
    applyOptional(m, 'cap', capOf(b.tierLimit, '/tierLimit'))
    await deps.console.putMember(m) // first: console authorization follows the item at once
    if (roleChanged) await deps.directory.setRole(u.username, m.group as Role) // the token claim follows at its next refresh
    await publishAndAudit(ctx, { principals: true }, { action: roleChanged ? 'member.role' : 'member.update', target: m.key, summary: `updated ${Object.keys(b).join(', ')}`,
      before: { role: before.group, budget: before.budget, tierLimit: before.cap }, after: { role: m.group, budget: m.budget, tierLimit: m.cap } })
    return { body: await detail(deps, (await deps.directory.getUser(u.username)) ?? u) }
  },
  'admin.members.action': memberAction,
  'admin.members.delete': async (ctx: Ctx) => {
    const { deps } = ctx
    const u = await userOf(deps, ctx.params.id)
    notSelf(ctx, u)
    const m = await deps.console.getMember(userKey(u))
    if (u.enabled && !m?.disabled) throw new HttpError(409, 'not-disabled', 'disable the member before deleting')
    await deps.directory.deleteUser(u.username)
    await deps.console.deleteMember(userKey(u))
    await publishAndAudit(ctx, { principals: true, blocks: true }, { action: 'member.delete', target: userKey(u), summary: 'deleted; records remain' })
    return { status: 204 }
  },
  'admin.clients.list': async ({ deps }: Ctx) => {
    const clients = (await deps.console.listMembers()).filter((m) => m.group === 'service')
    const spent = await spentThisMonth(deps, clients.map((m) => m.key))
    const identity = (await deps.console.getIdentityDelivery()) ?? { state: 'pending' }
    return { body: { items: clients.map((m) => clientView(deps, m, spent.get(m.key))), identity } }
  },
  'admin.clients.create': async (ctx: Ctx) => {
    const { deps } = ctx
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['name', 'description', 'budget', 'tierLimit'])
    const name = stringField(b, 'name', { max: 64 }) as string
    if (!/^[A-Za-z0-9 ._-]+$/.test(name)) throw new HttpError(400, 'bad-request', 'name: letters, digits, space, . _ -')
    const description = stringField(b, 'description', { max: 200, optional: true })
    const budget = budgetOf(b.budget, 'budget') ?? undefined
    const cap = capOf(b.tierLimit, '/tierLimit') ?? undefined
    const { clientId, secret } = await deps.clients.createClient(name)
    const now = iso(deps.now())
    const m: MemberSettings = { key: `client:${clientId}`, group: 'service', name, createdAt: now, updatedAt: now,
      ...(description ? { description } : {}), ...(budget ? { budget } : {}), ...(cap ? { cap } : {}) }
    await deps.console.putMember(m)
    await publishAndAudit(ctx, { principals: true }, { action: 'client.create', target: m.key, summary: `created ${name}`, after: { name, budget, tierLimit: cap } })
    return { status: 201, body: secretResponse(deps, m, secret) }
  },
  'admin.clients.patch': async (ctx: Ctx) => {
    const { deps } = ctx
    const before = await clientSettings(deps, ctx.params.id)
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['name', 'description', 'budget', 'tierLimit'])
    const m: MemberSettings = { ...before, updatedAt: iso(deps.now()) }
    const name = stringField(b, 'name', { max: 64, optional: true })
    if (name !== undefined) m.name = name
    const description = stringField(b, 'description', { max: 200, optional: true })
    if (description !== undefined) m.description = description
    applyOptional(m, 'budget', budgetOf(b.budget, 'budget'))
    applyOptional(m, 'cap', capOf(b.tierLimit, '/tierLimit'))
    await deps.console.putMember(m)
    await publishAndAudit(ctx, { principals: true }, { action: 'client.update', target: m.key, summary: `updated ${Object.keys(b).join(', ')}`,
      before: { name: before.name, budget: before.budget, tierLimit: before.cap }, after: { name: m.name, budget: m.budget, tierLimit: m.cap } })
    return { body: clientView(deps, m) }
  },
  'admin.clients.action': async (ctx: Ctx) => {
    const { deps } = ctx
    const m = await clientSettings(deps, ctx.params.id)
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['action'])
    const now = iso(deps.now())
    switch (b.action) {
      case 'rotate-secret': {
        const { secret } = await deps.clients.rotateSecret(m.key.slice('client:'.length))
        await audit(ctx, { action: 'client.rotate', target: m.key, summary: 'secret rotated' })
        return { body: secretResponse(deps, m, secret) }
      }
      case 'disable':
      case 'enable': {
        const next = { ...m, disabled: b.action === 'disable', updatedAt: now }
        await deps.console.putMember(next)
        await publishAndAudit(ctx, { blocks: true }, { action: b.action === 'disable' ? 'client.disable' : 'client.enable', target: m.key, summary: b.action === 'disable' ? 'disabled (router block list)' : 'enabled' })
        return { body: clientView(deps, next) }
      }
      default:
        throw new HttpError(400, 'bad-request', 'action: rotate-secret | disable | enable')
    }
  },
  'admin.clients.delete': async (ctx: Ctx) => {
    const { deps } = ctx
    const m = await clientSettings(deps, ctx.params.id)
    if (!m.disabled) throw new HttpError(409, 'not-disabled', 'disable the service client before deleting')
    await deps.clients.deleteClient(m.key.slice('client:'.length))
    await deps.console.deleteMember(m.key)
    await publishAndAudit(ctx, { principals: true, blocks: true }, { action: 'client.delete', target: m.key, summary: 'deleted; records remain' })
    return { status: 204 }
  },
  'admin.budgets.get': async ({ deps }: Ctx) => {
    const def = await deps.console.getDefaultBudget()
    const members = (await deps.console.listMembers()).filter((m) => m.budget)
    const spent = await spentThisMonth(deps, members.map((m) => m.key))
    const users = new Map((await deps.directory.listUsers()).map((u) => [userKey(u), u]))
    const body: BudgetsResponse = {
      ...(def ? { default: def } : {}),
      perPrincipal: members.map((m) => {
        const u = users.get(m.key)
        const kind = m.key.startsWith('client:') ? 'client' as const : 'user' as const
        const name = kind === 'client' ? m.name : u?.name
        return { caller: { key: m.key, kind, ...(name ? { name } : {}), ...(u?.email ? { email: u.email } : {}) }, budget: m.budget as Budget, spentUsd: nanoToUsd(spent.get(m.key)) }
      }),
    }
    return { body }
  },
  'admin.budgets.put': async (ctx: Ctx) => {
    const { deps } = ctx
    const b = requireObject(jsonBody(ctx.event))
    onlyKeys(b, ['default'])
    if (!('default' in b)) throw new HttpError(400, 'bad-request', 'default: a budget or null')
    const before = await deps.console.getDefaultBudget()
    const next = budgetOf(b.default, 'default') ?? undefined
    await deps.console.putDefaultBudget(next)
    await audit(ctx, { action: 'settings.change', target: 'settings:budgets', summary: next ? 'default budget set' : 'default budget cleared', before: before ?? null, after: next ?? null })
    return (memberHandlers['admin.budgets.get'] as Handler)(ctx)
  },
}
