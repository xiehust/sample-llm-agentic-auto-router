// Verified principal (admin console design v1 §0.1–0.2, 0.15; a3 research §2). The client re-sends its Cognito
// access token in an identity header (x-api-key by default); the gateway has already authenticated the request,
// and the router verifies the token again, in process, for attribution, blocks and budget stops. The principal's
// group and cap come from identity/principals.json in the runtime generation (runtime.ts, settings.ts), not from here.
//
// - RS256 only, node:crypto, keys from the pool's JWKS document (identity/jwks.json, never fetched at request time).
// - Checks: alg, kid, signature, iss, token_use=access, exp/iat/nbf with leeway, the invoke scope. No client allowlist
//   (the gateway is scope-only, design 0.4); client_id is used only to tell M2M tokens from user tokens.
// - Verified tokens are cached by the full token string (a signature is never trusted apart from its payload) until
//   exp; the cache is cleared whenever the key set changes.
// - Never logs, returns or throws token material: results carry codes and ids only.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { alertEmf } from './account.ts'
import type { Watch } from './source.ts'

export type IdentityMode = 'off' | 'observe' | 'require'
export const IDENTITY_MODES: readonly IdentityMode[] = ['off', 'observe', 'require']
/** Header names the router can read the token from (design 0.1; the fallback name is a3 §1.3). */
export const IDENTITY_HEADERS = ['x-api-key', 'x-router-identity'] as const
export type IdentityHeader = (typeof IDENTITY_HEADERS)[number]

export type PrincipalKind = 'user' | 'client'
/** Logged principal (design v1 §2.2): ids only, never a username, e-mail or token. */
export interface Principal { kind: PrincipalKind | 'none'; id?: string; group?: string }
/** `identity` log field (design v1 §2.2). */
export type IdentityStatus = 'verified' | 'missing' | `invalid:${VerifyCode}`

export type VerifyCode =
  | 'malformed' | 'alg' | 'kid-unknown' | 'signature' | 'expired' | 'not-yet-valid' | 'issuer' | 'token-use' | 'scope'
  | 'keys-unavailable'
export type VerifyResult =
  | { ok: true; kind: PrincipalKind; id: string; exp: number }
  | { ok: false; code: VerifyCode | 'missing' }

export const MAX_TOKEN_BYTES = 4096 // the gateway's header-value limit
export const DEFAULT_LEEWAY_S = 30
const MAX_KEYS = 10
const MIN_RSA_BITS = 2048
const SEGMENT = /^[A-Za-z0-9_-]+$/

/** One request's identity outcome. `ok: false` answers the request with `status` and `code` before the body is read. */
export type GateResult =
  | { ok: true; principal?: Principal; identity?: IdentityStatus }
  | { ok: false; status: 401 | 403 | 429; code: string; principal: Principal; identity: IdentityStatus }

export class IdentityDocError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'IdentityDocError'; this.code = code }
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function b64urlJson(segment: string): unknown {
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) } catch { return undefined }
}

/** Cognito `jwks.json` → kid → public key. Throws IdentityDocError on anything but 1..10 RSA (≥ 2048-bit) RS256 signing keys. */
export function parseJwks(doc: unknown): Map<string, KeyObject> {
  if (!obj(doc) || !Array.isArray(doc.keys)) throw new IdentityDocError('jwks-shape')
  if (doc.keys.length === 0 || doc.keys.length > MAX_KEYS) throw new IdentityDocError('jwks-key-count')
  const keys = new Map<string, KeyObject>()
  for (const k of doc.keys) {
    if (!obj(k) || typeof k.kid !== 'string' || !k.kid || k.kty !== 'RSA' || typeof k.n !== 'string' || typeof k.e !== 'string'
      || !SEGMENT.test(k.n) || !SEGMENT.test(k.e)) throw new IdentityDocError('jwks-key-shape')
    if (k.alg !== undefined && k.alg !== 'RS256') throw new IdentityDocError('jwks-key-alg')
    if (k.use !== undefined && k.use !== 'sig') throw new IdentityDocError('jwks-key-use')
    if (keys.has(k.kid)) throw new IdentityDocError('jwks-duplicate-kid')
    let key: KeyObject
    try { key = createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' }) } catch { throw new IdentityDocError('jwks-key-invalid') }
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    if (bits < MIN_RSA_BITS) throw new IdentityDocError('jwks-key-too-small')
    keys.set(k.kid, key)
  }
  return keys
}

/**
 * blocks.json / budget-blocks.json: `{ schemaVersion: 1, principals: [{ kind, id, month?, ... }] }` → `kind:id` → month
 * (undefined when the entry has none). Budget blocks carry the UTC month they were evaluated for ('yyyy-mm', usage-ingest).
 * A broken structure rejects the document (the last good one stays). A single bad entry (unknown kind, an id the
 * router never attributes, a malformed month) is skipped and counted, so one odd id cannot freeze every other block.
 */
export function parseBlockList(doc: unknown): { entries: Map<string, string | undefined>; skipped: number } {
  if (!obj(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.principals)) throw new IdentityDocError('blocks-shape')
  if (doc.principals.length > 100_000) throw new IdentityDocError('blocks-too-many')
  const entries = new Map<string, string | undefined>()
  let skipped = 0
  for (const p of doc.principals) {
    if (!obj(p) || (p.kind !== 'user' && p.kind !== 'client') || typeof p.id !== 'string' || !ID.test(p.id)
      || (p.month !== undefined && (typeof p.month !== 'string' || !MONTH.test(p.month)))) { skipped++; continue }
    entries.set(`${p.kind}:${p.id}`, p.month as string | undefined)
  }
  return { entries, skipped }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
/** UTC 'yyyy-mm' of a time. */
export const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

/**
 * Principal ids as the router attributes them: Cognito `sub` (a UUID) or `client_id` (Cognito ClientIdType `[\w+]+`,
 * 1-128). Keys `<kind>:<id>` need no encoding: none of these characters is ':' or a separator.
 */
const ID = /^[\w+-]{1,128}$/
export type IdentityObject = 'jwks' | 'blocks' | 'budgetBlocks'
/** What an applied document held: entries in force, and (block lists) entries skipped as invalid. */
export interface ApplyCount { count: number; skipped?: number }
/** Object keys in the config bucket (design v1 §2.1). principals.json belongs to the runtime generation (runtime.ts). */
export const IDENTITY_KEYS: Readonly<Record<IdentityObject, string>> = {
  jwks: 'identity/jwks.json', blocks: 'identity/blocks.json', budgetBlocks: 'identity/budget-blocks.json',
}

/**
 * Current identity documents. Each `apply*` validates first and swaps atomically, so a bad document never replaces
 * a good one (the caller keeps the last good state and logs the rejection).
 */
export class IdentityState {
  private keys = new Map<string, KeyObject>()
  private blocks = new Map<string, string | undefined>()
  private budget = new Map<string, string | undefined>()
  private readonly versions: Partial<Record<IdentityObject, string>> = {}
  /** Bumped on every key-set change; verifiers drop their caches when it moves. */
  keyGeneration = 0

  applyJwks(doc: unknown, version?: string): ApplyCount {
    const keys = parseJwks(doc)
    this.keys = keys
    this.keyGeneration++
    this.setVersion('jwks', version)
    return { count: keys.size }
  }
  applyBlocks(doc: unknown, version?: string): ApplyCount { return this.list('blocks', doc, version) }
  applyBudgetBlocks(doc: unknown, version?: string): ApplyCount { return this.list('budgetBlocks', doc, version) }
  apply(object: IdentityObject, doc: unknown, version?: string): ApplyCount {
    if (object === 'jwks') return this.applyJwks(doc, version)
    if (object === 'blocks') return this.applyBlocks(doc, version)
    return this.applyBudgetBlocks(doc, version)
  }

  key(kid: string): KeyObject | undefined { return this.keys.get(kid) }
  get hasKeys(): boolean { return this.keys.size > 0 }
  /** Signing keys loaded (count only: router state lines). */
  get keyCount(): number { return this.keys.size }
  blocked(key: string): boolean { return this.blocks.has(key) }
  /**
   * A budget stop applies in the month it was evaluated for only: at the UTC month rollover a stale entry stops
   * blocking even before ingest rewrites the file (an entry without a month always applies).
   */
  budgetBlocked(key: string, nowMs: number = Date.now()): boolean {
    if (!this.budget.has(key)) return false
    const month = this.budget.get(key)
    return month === undefined || month === utcMonth(nowMs)
  }
  /** Version of a loaded document (the source's ETag-derived id). */
  version(object: IdentityObject): string | undefined { return this.versions[object] }

  private list(object: 'blocks' | 'budgetBlocks', doc: unknown, version: string | undefined): ApplyCount {
    const { entries, skipped } = parseBlockList(doc)
    if (object === 'blocks') this.blocks = entries
    else this.budget = entries
    this.setVersion(object, version)
    return { count: entries.size, ...(skipped ? { skipped } : {}) }
  }

  private setVersion(object: IdentityObject, version: string | undefined): void {
    if (version === undefined) delete this.versions[object]
    else this.versions[object] = version
  }
}

export interface VerifierOptions {
  /** `https://cognito-idp.<region>.amazonaws.com/<poolId>` */
  issuer: string
  /** `<prefix>/invoke` */
  scope: string
  now?: () => number
  leewayS?: number
  /** Verified-token cache entries (default 10 000). */
  cacheSize?: number
}

export interface Verifier { verify(raw: string | string[] | undefined): VerifyResult }

/** RS256 Cognito access-token verifier over the keys in `state`. */
export function createVerifier(state: IdentityState, o: VerifierOptions): Verifier {
  const now = o.now ?? Date.now
  const leeway = o.leewayS ?? DEFAULT_LEEWAY_S
  const max = o.cacheSize ?? 10_000
  const cache = new Map<string, { kind: PrincipalKind; id: string; exp: number }>()
  let generation = state.keyGeneration

  function verify(raw: string | string[] | undefined): VerifyResult {
    if (raw === undefined || raw === '') return { ok: false, code: 'missing' }
    if (Array.isArray(raw)) return { ok: false, code: 'malformed' } // repeated header
    // Empty, whitespace-only or a bare "Bearer" (Claude Code when its apiKeyHelper fails) is missing, not malformed.
    let token = raw.trim()
    if (/^bearer(\s+|$)/i.test(token)) token = token.replace(/^bearer\s*/i, '').trim()
    if (!token) return { ok: false, code: 'missing' }
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES || /[\s,]/.test(token)) return { ok: false, code: 'malformed' } // node joins repeats with ', '
    const parts = token.split('.')
    if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return { ok: false, code: 'malformed' }
    const nowS = now() / 1000
    if (state.keyGeneration !== generation) { cache.clear(); generation = state.keyGeneration }
    const hit = cache.get(token)
    if (hit) {
      if (nowS > hit.exp + leeway) { cache.delete(token); return { ok: false, code: 'expired' } }
      return { ok: true, ...hit }
    }
    const [h, p, s] = parts as [string, string, string]
    const header = b64urlJson(h)
    if (!obj(header)) return { ok: false, code: 'malformed' }
    if (header.alg !== 'RS256') return { ok: false, code: 'alg' }
    if (!state.hasKeys) return { ok: false, code: 'keys-unavailable' }
    const key = typeof header.kid === 'string' ? state.key(header.kid) : undefined
    if (!key) return { ok: false, code: 'kid-unknown' }
    let good = false
    try { good = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')) } catch { good = false }
    if (!good) return { ok: false, code: 'signature' }
    const c = b64urlJson(p)
    if (!obj(c)) return { ok: false, code: 'malformed' }
    if (c.iss !== o.issuer) return { ok: false, code: 'issuer' }
    if (c.token_use !== 'access') return { ok: false, code: 'token-use' }
    if (typeof c.exp !== 'number' || nowS > c.exp + leeway) return { ok: false, code: 'expired' }
    if ((typeof c.iat === 'number' && c.iat > nowS + leeway) || (typeof c.nbf === 'number' && c.nbf > nowS + leeway)) return { ok: false, code: 'not-yet-valid' }
    if (typeof c.scope !== 'string' || !c.scope.split(' ').includes(o.scope)) return { ok: false, code: 'scope' }
    if (typeof c.sub !== 'string' || !ID.test(c.sub) || typeof c.client_id !== 'string' || !ID.test(c.client_id)) return { ok: false, code: 'malformed' }
    // Cognito M2M (client credentials) tokens: sub == client_id and no username. Everything else is a user token.
    const kind: PrincipalKind = c.username === undefined && c.sub === c.client_id ? 'client' : 'user'
    const entry = { kind, id: c.sub, exp: c.exp }
    if (cache.size >= max) cache.delete(cache.keys().next().value as string)
    cache.set(token, entry)
    return { ok: true, ...entry }
  }
  return { verify }
}

export interface GateOptions {
  state: IdentityState
  verifier: Verifier
  header?: IdentityHeader
  now?: () => number
}

export interface IdentityGate {
  readonly header: IdentityHeader
  /**
   * `mode` comes from the request's generation (the config document's identity.mode, else the env default), so
   * one request sees one mode (runtime.ts invariant I1).
   */
  check(headers: IncomingHttpHeaders, mode: IdentityMode): GateResult
}

/**
 * Per request, after hop auth and before the body:
 * - off: nothing is read or logged.
 * - observe: a verified principal is logged and its blocks apply (403 / 429); missing or invalid tokens are served
 *   and logged as `principal: { kind: 'none' }`.
 * - require: missing or invalid → 401 `identity-<code>` as well.
 * Every rejection is a 4xx: a 5xx would make the gateway fallback serve the caller without the router.
 */
export function createIdentityGate(o: GateOptions): IdentityGate {
  const header = o.header ?? 'x-api-key'
  return {
    header,
    check(headers, mode) {
      if (mode === 'off') return { ok: true }
      const v = o.verifier.verify(headers[header])
      if (!v.ok) {
        const identity: IdentityStatus = v.code === 'missing' ? 'missing' : `invalid:${v.code}`
        const principal: Principal = { kind: 'none' }
        if (mode === 'require') return { ok: false, status: 401, code: `identity-${v.code}`, principal, identity }
        return { ok: true, principal, identity }
      }
      const key = principalKey(v)
      const principal: Principal = { kind: v.kind, id: v.id }
      if (o.state.blocked(key)) return { ok: false, status: 403, code: 'identity-blocked', principal, identity: 'verified' }
      if (o.state.budgetBlocked(key, (o.now ?? Date.now)())) return { ok: false, status: 429, code: 'budget-exceeded', principal, identity: 'verified' }
      return { ok: true, principal, identity: 'verified' }
    },
  }
}

/** "<user|client>:<id>", the key of blocks, budget blocks and principals.json. */
export const principalKey = (p: { kind: PrincipalKind | 'none'; id?: string }): string => `${p.kind}:${p.id ?? ''}`

/** Short, log-safe version id derived from an ETag. */
export const versionOf = (etag: string): string => etag.replace(/[^0-9a-zA-Z]/g, '').slice(0, 16) || 'unknown'

/** `source` of an identity object's `config` line (design v1 §2.1 line contract; usage-ingest stores these). */
export const IDENTITY_SOURCE: Readonly<Record<IdentityObject, 'jwks' | 'blocks' | 'budget-blocks'>> = { jwks: 'jwks', blocks: 'blocks', budgetBlocks: 'budget-blocks' }

/**
 * Watches for the identity objects on the runtime poller (source.ts createPoller). A new version is validated and
 * swapped in atomically; a rejected one keeps the last good state (the poller remembers its ETag, so it is logged
 * once). An object that was never loaded is empty (lists) or missing (jwks: requests verify as keys-unavailable);
 * one that disappears after loading keeps its last good state, so deleting a block list never unblocks anyone.
 *
 * Logs `kind: "config"` lines like the runtime's (C3): `source` jwks | blocks | budget-blocks, `outcome` applied |
 * rejected | absent | error, the object's version and counts (never values). `context` adds the generation's fields
 * (configVersion). The console waits for `source: "jwks", outcome: "applied"` before it allows identity require.
 */
export function identityWatches(state: IdentityState, sink: (line: string) => void, now: () => number = Date.now,
  context: () => Record<string, unknown> = () => ({})): Watch[] {
  const log = (object: IdentityObject, outcome: 'applied' | 'rejected' | 'absent' | 'error', extra: Record<string, unknown> = {}) =>
    sink(JSON.stringify({ ts: new Date(now()).toISOString(), kind: 'config', source: IDENTITY_SOURCE[object], outcome, ...context(), ...extra }))
  return (Object.keys(IDENTITY_KEYS) as IdentityObject[]).map((object) => ({
    key: IDENTITY_KEYS[object],
    onObject(body: string, etag: string) {
      const version = versionOf(etag)
      let doc: unknown
      try { doc = JSON.parse(body) } catch { log(object, 'rejected', { attempted: version, issues: ['json'], ...lastGood(object) }); return }
      try {
        const r = state.apply(object, doc, version)
        log(object, 'applied', { version, count: r.count, ...(r.skipped ? { skipped: r.skipped, issues: ['entry-invalid'] } : {}) })
      } catch (e) {
        log(object, 'rejected', { attempted: version, issues: [e instanceof IdentityDocError ? e.code : 'invalid'], ...lastGood(object) })
      }
    },
    onAbsent() { log(object, 'absent', state.version(object) ? { keptLastGood: true, ...lastGood(object) } : {}) },
    onError(code: string) {
      // Never loaded (e.g. an S3 error at boot): blocks and budget stops are not enforced until the first good read,
      // and without jwks every token verifies as keys-unavailable. Alert loudly (EMF series identity-objects-unavailable).
      if (state.version(object) === undefined) {
        log(object, 'error', { code, loaded: false, alert: 'identity-objects-unavailable' })
        sink(JSON.stringify(alertEmf('identity-objects-unavailable', now())))
        process.stderr.write(`WARNING: identity object ${IDENTITY_KEYS[object]} could not be read (${code}); not enforced until it loads\n`)
      } else log(object, 'error', { code, ...lastGood(object) })
    },
  }))
  function lastGood(object: IdentityObject): Record<string, unknown> {
    const v = state.version(object)
    return v ? { version: v } : {}
  }
}
