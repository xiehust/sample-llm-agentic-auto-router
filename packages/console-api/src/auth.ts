// Caller identity from the HTTP API JWT authorizer's claims (a3 §4.3, design v1 §2.4). The authorizer has verified
// signature, issuer, expiry and client; this module re-checks the claims the routes depend on and never trusts a
// request parameter for identity. Every route then authorizes from the caller's live MEMBER item (authorize()).
import type { RouteDef, Role } from '@auto-router/console-contract'
import { HttpError, type HttpApiEvent } from './http.ts'

const ROLES: readonly Role[] = ['admin', 'member']

export interface Caller {
  /** `user:<sub>` */
  key: string
  sub: string
  /** Cognito username (the `username` claim), needed for Admin* calls on the caller. */
  username: string
  /** Groups from the token (UI hints; admin routes re-check them live). */
  groups: Role[]
  /** admin when the token claims admin, else member (undefined: no console group). */
  role: Role | undefined
}

/**
 * `cognito:groups` arrives as an array, a JSON array string, or (HTTP API flattening) `[admin member]`; any other
 * shape gives no groups. Unknown group names are dropped.
 */
export function parseGroups(v: unknown): Role[] {
  let items: unknown[] = []
  if (Array.isArray(v)) items = v
  else if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('[') && s.includes('"')) {
      try { const j = JSON.parse(s) as unknown; if (Array.isArray(j)) items = j } catch { items = [] }
    } else items = s.replace(/^\[|\]$/g, '').split(/[\s,]+/)
  }
  const out = new Set<Role>()
  for (const i of items) if (typeof i === 'string' && (ROLES as readonly string[]).includes(i)) out.add(i as Role)
  return [...out]
}

const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The caller of a console request. 401 when the claims are missing or not a console user access token. */
export function callerOf(event: HttpApiEvent, consoleScope: string): Caller {
  const jwt = event.requestContext.authorizer?.jwt
  const claims = jwt?.claims
  if (!claims) throw new HttpError(401, 'unauthorized', 'no verified token')
  if (claims.token_use !== 'access') throw new HttpError(401, 'unauthorized', 'an access token is required')
  const scopes = Array.isArray(jwt.scopes) ? jwt.scopes : typeof claims.scope === 'string' ? claims.scope.split(' ') : []
  if (!scopes.includes(consoleScope)) throw new HttpError(403, 'forbidden', 'the console scope is required')
  const sub = claims.sub
  // Console users only: a client-credentials token has sub = client id and no username; it never gets the console
  // scope (a3 §4.1), and is refused here as a second line.
  if (typeof sub !== 'string' || !SUB.test(sub) || typeof claims.username !== 'string' || claims.username === '') {
    throw new HttpError(401, 'unauthorized', 'a user token is required')
  }
  const groups = parseGroups(claims['cognito:groups'])
  const id = sub.toLowerCase()
  return { key: `user:${id}`, sub: id, username: claims.username, groups, role: groups.includes('admin') ? 'admin' : groups.includes('member') ? 'member' : undefined }
}

/** The live authorization source: the caller's MEMBER#<kind:id> item (design v1 0.16; 0d review of C7). */
export interface MemberLookup { getMember(key: string): Promise<{ group: string; disabled?: boolean } | undefined> }

/**
 * The route's group check, per request, from the live MEMBER item: the token's `cognito:groups` claim is only a
 * pre-filter, because a demoted or disabled admin keeps a valid access token (the JWT authorizer does not see
 * AdminUserGlobalSignOut) for up to its lifetime. 'self' routes need an active admin or member; 'admin' routes an
 * active admin. A user without a MEMBER item has no console access (the deployment seeds the first admin's).
 */
export async function authorize(route: RouteDef, c: Caller, members: MemberLookup): Promise<void> {
  if (c.role === undefined) throw new HttpError(403, 'forbidden', 'no console role')
  if (route.access === 'admin' && c.role !== 'admin') throw new HttpError(403, 'forbidden', 'admin only')
  const m = await members.getMember(c.key)
  if (!m || m.disabled === true) throw new HttpError(403, 'forbidden', 'account not active')
  if (route.access === 'admin' ? m.group !== 'admin' : m.group !== 'admin' && m.group !== 'member') throw new HttpError(403, 'forbidden', 'admin only')
}
