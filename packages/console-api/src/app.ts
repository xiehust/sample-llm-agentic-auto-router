// Console API entry point: one Lambda handler for every route of the contract's ROUTES table (design v1 §2.4), so
// the SPA and the API cannot drift. Order per request: verified caller (401/403) → route (404/405) → live
// authorization from the caller's MEMBER item (403) → handler. Self routes take the principal from the caller only.
import { matchRoute, ROUTES, type RouteDef, type RouteId } from '@auto-router/console-contract'
import { authorize, callerOf, type Caller } from './auth.ts'
import { errorResult, HttpError, result, type HttpApiEvent, type HttpApiResult, type Reply } from './http.ts'
import type { Deps } from './ports.ts'
import { adminDataHandlers } from './routes/admin-data.ts'
import { configHandlers } from './routes/config.ts'
import { meHandlers } from './routes/me.ts'
import { memberHandlers } from './routes/members.ts'

export interface Ctx {
  event: HttpApiEvent
  caller: Caller
  route: RouteDef
  params: Record<string, string>
  deps: Deps
  requestId: string
}
export type Handler = (ctx: Ctx) => Promise<Reply>
export type HandlerId = RouteId

/** Every contract route has exactly one handler (a missing one is a type error). */
export const HANDLERS: Record<string, Handler> = { ...meHandlers, ...configHandlers, ...adminDataHandlers, ...memberHandlers }

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const PACKS_PREFIX = '/api/packs/'
/**
 * Contract matching; 405 when the path exists under another method. A packVersion holds a '/', which the client
 * sends as %2F; an unencoded one is accepted too (0c decision H).
 */
export function findRoute(method: string, path: string): { route: RouteDef; params: Record<string, string> } {
  const m = matchRoute(method, path) ?? (path.startsWith(PACKS_PREFIX) && path.length > PACKS_PREFIX.length
    ? matchRoute(method, `${PACKS_PREFIX}${encodeURIComponent(safeDecode(path.slice(PACKS_PREFIX.length)))}`) : undefined)
  if (m) return m
  if (METHODS.some((x) => x !== method && matchRoute(x, path))) throw new HttpError(405, 'bad-request', `${method} not allowed here`)
  throw new HttpError(404, 'not-found', 'no such route')
}
function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { throw new HttpError(404, 'not-found', 'no such route') }
}

export function createHandler(deps: Deps): (event: HttpApiEvent) => Promise<HttpApiResult> {
  for (const r of ROUTES as readonly RouteDef[]) if (!(r.id in HANDLERS)) throw new Error(`console-api: no handler for ${r.id}`)
  return async (event) => {
    const t0 = deps.now()
    const requestId = event.requestContext.requestId ?? deps.uuid()
    const method = event.requestContext.http.method.toUpperCase()
    let status = 500
    let routeId = '-'
    let principal: string | undefined
    try {
      const caller = callerOf(event, deps.env.consoleScope)
      principal = caller.key
      const { route, params } = findRoute(method, event.rawPath)
      routeId = route.id
      await authorize(route, caller, deps.console)
      const reply = await (HANDLERS[route.id] as Handler)({ event, caller, route, params, deps, requestId })
      const out = result(reply)
      status = out.statusCode
      return out
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; return errorResult(e, requestId) }
      deps.log({ kind: 'console-api-error', requestId, route: routeId, error: e instanceof Error ? e.name : 'unknown' })
      status = 500
      return errorResult(new HttpError(500, 'internal', 'internal error'), requestId)
    } finally {
      deps.log({ kind: 'console-api', requestId, method, route: routeId, status, ms: deps.now() - t0, ...(principal ? { principal } : {}) })
    }
  }
}
