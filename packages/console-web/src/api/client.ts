// The one way the SPA calls the console API (18-frontend-stack §2.6; contract design v1 §2.4). Same-origin /api
// paths, bearer access token, 15 s timeout, one forced refresh on 401, typed errors with the contract's codes.
// Never logs tokens or puts them in URLs.

import type { ApiErrorBody, ValidationIssue } from '@auto-router/console-contract'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | undefined
  readonly issues: ValidationIssue[]
  /** identity-keys-not-loaded: why Require was refused (an IdentityKeysReason). */
  readonly reason: string | undefined
  constructor(status: number, code: string, message: string, requestId?: string, issues: ValidationIssue[] = [], reason?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.issues = issues
    this.reason = reason
  }
  get forbidden() { return this.status === 403 }
  get notFound() { return this.status === 404 }
  get conflict() { return this.status === 409 || this.status === 412 }
}

/** No valid sign-in: the app shows the sign-in-expired state. */
export class SignInRequiredError extends Error {
  constructor() { super('sign-in required'); this.name = 'SignInRequiredError' }
}

export interface TokenSource {
  getAccessToken(force?: boolean): Promise<string | undefined>
}

export interface RequestOptions {
  body?: unknown
  signal?: AbortSignal
  ifMatch?: string
  timeoutMs?: number
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

const isErrorBody = (v: unknown): v is ApiErrorBody =>
  typeof v === 'object' && v !== null && typeof (v as ApiErrorBody).error === 'object' && typeof (v as ApiErrorBody).error?.code === 'string'

export class ApiClient {
  private readonly tokens: TokenSource
  private readonly fetchImpl: Fetch
  private readonly onSignInRequired: () => void

  constructor(tokens: TokenSource, opts: { fetch?: Fetch; onSignInRequired?: () => void } = {}) {
    this.tokens = tokens
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init))
    this.onSignInRequired = opts.onSignInRequired ?? (() => {})
  }

  get<T>(path: string, o?: RequestOptions) { return this.request<T>('GET', path, o) }
  post<T>(path: string, body?: unknown, o?: RequestOptions) { return this.request<T>('POST', path, { ...o, body }) }
  put<T>(path: string, body?: unknown, o?: RequestOptions) { return this.request<T>('PUT', path, { ...o, body }) }
  patch<T>(path: string, body?: unknown, o?: RequestOptions) { return this.request<T>('PATCH', path, { ...o, body }) }
  delete<T>(path: string, o?: RequestOptions) { return this.request<T>('DELETE', path, o) }

  async request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    if (!path.startsWith('/api/')) throw new Error(`not an API path: ${path}`)
    let res = await this.send(method, path, o, false)
    if (res.status === 401) res = await this.send(method, path, o, true)
    if (res.status === 401) {
      this.onSignInRequired()
      throw new SignInRequiredError()
    }
    const text = await res.text()
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
    if (!res.ok) {
      if (isErrorBody(body)) throw new ApiError(res.status, body.error.code, body.error.message, body.error.requestId, body.error.issues, body.error.reason)
      throw new ApiError(res.status, res.status >= 500 ? 'internal' : 'bad-request', `HTTP ${res.status}`)
    }
    return body as T
  }

  /** Raw text (CSV export) with the same auth and errors. */
  async text(path: string, o: RequestOptions = {}): Promise<string> {
    const res = await this.send('GET', path, o, false)
    if (res.status === 401) { this.onSignInRequired(); throw new SignInRequiredError() }
    if (!res.ok) throw new ApiError(res.status, 'internal', `HTTP ${res.status}`)
    return res.text()
  }

  private async send(method: string, path: string, o: RequestOptions, forceRefresh: boolean): Promise<Response> {
    const token = await this.tokens.getAccessToken(forceRefresh)
    if (!token) { this.onSignInRequired(); throw new SignInRequiredError() }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (o.body !== undefined) headers['content-type'] = 'application/json'
    if (o.ifMatch) headers['if-match'] = o.ifMatch
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 15_000)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    const init: RequestInit = { method, headers, signal, credentials: 'omit', cache: 'no-store', redirect: 'error' }
    if (o.body !== undefined) init.body = JSON.stringify(o.body)
    return this.fetchImpl(path, init)
  }
}
