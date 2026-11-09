// HTTP layer for API Gateway HTTP API (payload v2) events: JSON bodies, stable error bodies, query helpers. Routing
// uses the contract's ROUTES table (app.ts). The JWT authorizer has already verified the token; auth.ts reads it.
import { isDay, qBool, qList, qStr } from '@auto-router/console-contract'
import type { ApiErrorBody } from '@auto-router/console-contract'
import type { ApiErrorCode, Issue } from './local-types.ts'

/** The subset of an HTTP API payload-v2 event the handlers read. */
export interface HttpApiEvent {
  rawPath: string
  rawQueryString?: string
  headers?: Record<string, string | undefined>
  queryStringParameters?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
  requestContext: {
    requestId?: string
    http: { method: string }
    authorizer?: { jwt?: { claims?: Record<string, unknown>; scopes?: string[] | null } }
  }
}
export interface HttpApiResult { statusCode: number; headers: Record<string, string>; body: string }

export class HttpError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly issues?: Issue[]
  readonly reason?: string
  constructor(status: number, code: ApiErrorCode, message: string, issues?: Issue[], reason?: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    if (issues) this.issues = issues
    if (reason) this.reason = reason
  }
}

export const MAX_BODY_BYTES = 256 * 1024

export interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }

const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

export function errorResult(e: HttpError, requestId: string): HttpApiResult {
  const body: ApiErrorBody = { error: { code: e.code, message: e.message, requestId, ...(e.issues ? { issues: e.issues } : {}), ...(e.reason ? { reason: e.reason } : {}) } }
  return { statusCode: e.status, headers: { ...BASE_HEADERS }, body: JSON.stringify(body) }
}

export function result(r: Reply): HttpApiResult {
  const status = r.status ?? 200
  return { statusCode: status, headers: { ...BASE_HEADERS, ...r.headers }, body: r.body === undefined ? '' : JSON.stringify(r.body) }
}

/** The JSON body of a request (empty → undefined). */
export function jsonBody(event: HttpApiEvent): unknown {
  if (event.body === undefined || event.body === '') return undefined
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'bad-request', `body over ${MAX_BODY_BYTES} bytes`)
  try { return JSON.parse(text) as unknown } catch { throw new HttpError(400, 'bad-request', 'body is not valid JSON') }
}

export function requireObject(v: unknown, what = 'body'): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'bad-request', `${what}: JSON object required`)
  return v as Record<string, unknown>
}

export function header(event: HttpApiEvent, name: string): string | undefined {
  const h = event.headers ?? {}
  return h[name] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1]
}

// ---------------------------------------------------------------- query parameters (contract codec: lists are comma-separated)

export function query(event: HttpApiEvent): URLSearchParams {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(event.queryStringParameters ?? {})) if (v !== undefined) sp.set(k, v)
  return sp
}

export const str = (sp: URLSearchParams, k: string): string | undefined => qStr(sp, k)

export function list<T extends string>(sp: URLSearchParams, k: string, allowed?: readonly T[], max = 50): T[] | undefined {
  const v = qList(sp, k)
  if (v === undefined) return undefined
  if (v.length > max) throw new HttpError(400, 'bad-request', `${k}: at most ${max} values`)
  if (allowed) for (const x of v) if (!(allowed as readonly string[]).includes(x)) throw new HttpError(400, 'bad-request', `${k}: unknown value ${x.slice(0, 40)}`)
  return v as T[]
}

export function bool(sp: URLSearchParams, k: string): boolean | undefined {
  const raw = qStr(sp, k)
  const v = qBool(sp, k)
  if (raw !== undefined && v === undefined) throw new HttpError(400, 'bad-request', `${k}: true or false`)
  return v
}

export function day(sp: URLSearchParams, k: string, dflt?: string): string | undefined {
  const v = qStr(sp, k) ?? dflt
  if (v !== undefined && !isDay(v)) throw new HttpError(400, 'bad-request', `${k}: YYYY-MM-DD required`)
  return v
}

export function int(sp: URLSearchParams, k: string, dflt: number, min: number, max: number): number {
  const v = qStr(sp, k)
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'bad-request', `${k}: integer ${min}..${max} required`)
  return n
}

/** ISO timestamp parameter (records ranges). */
export function isoParam(sp: URLSearchParams, k: string, dflt: number): number {
  const v = qStr(sp, k)
  if (v === undefined) return dflt
  const t = Date.parse(v)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(t)) throw new HttpError(400, 'bad-request', `${k}: ISO timestamp required`)
  return t
}

/** Opaque pagination cursor (bounded; the store checks it belongs to the query's scope). */
export function cursor(sp: URLSearchParams): string | undefined {
  const v = qStr(sp, 'cursor')
  if (v !== undefined && !/^[A-Za-z0-9_-]{1,2048}$/.test(v)) throw new HttpError(400, 'bad-request', 'cursor: malformed')
  return v
}
