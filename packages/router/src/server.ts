// Request pipeline (design §2.2): inbound check -> route -> summarize/decide -> beta veto -> body hints + model
// splice -> SigV4 forward (+ failover) -> relay -> record + log.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Cap, CardContext, Decision, Engine, RequestSummary, StateStore } from '@auto-router/core'
import { AccessCapError, pinAllowedByCap, RETRYABLE_STATUS, tierOfPoolModel, tierWithinCap } from '@auto-router/core'
import type { RouterAssessor } from './assessor.ts'
import { costBound, costFor, emit, hitRate, hopTokenOf, lineageLabel, loggedHeaders, stdoutSink, type LogSink, type RequestLog } from './account.ts'
import { betaVeto, parseBetas, type BetaTable } from './beta.ts'
import { chatTokenLimit, sanitizeMetadata, stripBetas } from './bedrock-compat.ts'
import { BodyError, readBody, spliceTopLevel, topLevelMembers } from './body.ts'
import type { RouterConfig } from './config.ts'
import { failoverTargets, jitterMs } from './failover.ts'
import { forward, upstreamHeaders, type Signer } from './forward.ts'
import { applyBodyHints, coreHeaders } from './hints.ts'
import { principalKey, type IdentityGate, type IdentityMode } from './identity.ts'
import { createInboundCheck, type InboundCheck } from './inbound.ts'
import { allowedModels, poolTiers } from './models.ts'
import { routeOf } from './routes.ts'
import { createRuntime, type Generation, type RuntimeRef } from './runtime.ts'
import { bakedDocument, resolveCap } from './settings.ts'
import { relay } from './stream.ts'

/**
 * Tier-assessor seam (parent design §3): core calls `extras.card(ctx)` lazily, only when it consults the assessor,
 * and passes the CardContext (current/parent tier, compactions, lineage kind). Wire `buildCard` from
 * @auto-router/assessor: `card: (summary, body, ctx) => buildCard(summary, body, ctx)`.
 */
export type CardBuilder = (summary: RequestSummary, body: unknown, ctx: CardContext) => unknown

export interface RouterDeps {
  config: RouterConfig
  /**
   * Generation holder (runtime.ts). Every request takes `runtime.current()` once and uses it to the end. Without it,
   * the router runs one fixed generation built from `config.policy`, `engine` and `assessor` (tests, no config source).
   */
  runtime?: RuntimeRef
  /** Engine for the fixed generation (ignored when `runtime` is given). */
  engine?: Engine
  store: StateStore
  signer: Signer
  inbound?: InboundCheck
  sink?: LogSink
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  card?: CardBuilder
  /**
   * Tier assessor of the fixed generation (createRouterAssessor; ignored when `runtime` is given: the generation
   * carries its own). Supplies the card builder (unless `card` is given) and logs each consultation. The engine must
   * have been created with its `engineOptions`.
   */
  assessor?: RouterAssessor
  betaTable?: BetaTable
  /**
   * The request's verified principal key "<user|client>:<id>" (C2 identity), or undefined when unattributed. It
   * selects the access cap (design 0.16: principals.json, then the group default). Never a client-asserted header.
   */
  principalOf?: (req: IncomingMessage) => string | undefined
  /**
   * Identity gate (identity.ts): verifies the client's token from the identity header and applies blocks and budget
   * stops. Its verified principal selects the cap (principalOf is then ignored). Absent: identity off.
   */
  identity?: IdentityGate
}

export interface Router { server: Server; handle(req: IncomingMessage, res: ServerResponse, slot?: LogSlot): Promise<void> }

/** Lets the server wrapper log a request whose handler threw (review fix 11). */
export interface LogSlot {
  log?: RequestLog
  emitted?: boolean
  /** The generation an earlier check of this request used (Expect: 100-continue), so the request keeps it (I1). */
  gen?: Generation
}

function json(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) { res.destroy(); return }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(close ? { connection: 'close' } : {}) })
  res.end(text)
}

/** 403: answer, then drop the connection after a short grace so an unauthenticated peer cannot keep it. */
function forbid(res: ServerResponse): void {
  json(res, 403, { error: 'forbidden' }, true)
  setTimeout(() => res.socket?.destroy(), 250).unref()
}

const MAX_REASON = 200
const IDENTITY_ERROR: Record<401 | 403 | 429, string> = { 401: 'unauthorized', 403: 'forbidden', 429: 'budget exceeded' }

/**
 * Model discovery answer (the gateway calls GET <endpoint>/v1/models when it creates an inference provider target).
 * One list that is valid as both the OpenAI shape (object/data/id/owned_by/created) and the Anthropic shape
 * (data/id/type/display_name/created_at/has_more/first_id/last_id). It lists the router aliases only.
 */
export function modelList(aliases: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  const created = Math.floor(nowMs / 1000)
  const createdAt = new Date(created * 1000).toISOString()
  const data = Object.keys(aliases).sort().map((id) => ({ id, object: 'model', type: 'model', created, created_at: createdAt, display_name: id, owned_by: 'llm-auto-router' }))
  return { object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
}

const reasonCode = (reason: string): string => reason.split(':', 1)[0]?.trim() || 'unknown'

/**
 * Response header values come from core and, for pins, from the client (body `model` or `x-router-pin`).
 * node:http throws on control or non-Latin-1 characters, which would only surface after the upstream call, so
 * anything outside visible ASCII is replaced.
 */
const headerSafe = (v: string, max = 256): string => v.slice(0, max).replace(/[^\x20-\x7e]/g, '?')

export function createRouter(deps: RouterDeps): Router {
  const { config, store, signer } = deps
  const inbound = deps.inbound ?? createInboundCheck(config.hopAuth)
  const sink = deps.sink ?? stdoutSink
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // upstream-503-once[:<n>]: the n-th upstream attempt of this process (first tries and failovers alike) gets a 503.
  const faultAt = config.fault.startsWith('upstream-503-once') ? Number(config.fault.split(':')[1] ?? 1) : 0
  let upstreamAttempts = 0
  const pauseMs = config.fault.startsWith('pause-after-first-frame:') ? Number(config.fault.split(':')[1]) : 0
  const runtime: RuntimeRef = deps.runtime ?? fixedRuntime(deps, sink)
  // Every model a decision may name under any accepted configuration (I4: the IAM grant). Decisions, failover
  // targets and the EMF ServedModel bound use it; client-supplied concrete ids use the generation's pinAllowed.
  const universe = config.modelUniverse ?? defaultUniverse(config, runtime.current())
  /** Identity mode of a generation: the document's identity.mode, else the env default (off without identity). */
  const identityMode = (g: Generation): IdentityMode => g.document.identity?.mode ?? config.identity?.mode ?? 'off'

  async function handle(req: IncomingMessage, res: ServerResponse, slot: LogSlot = {}): Promise<void> {
    const t0 = now()
    const route = routeOf(req.method, req.url)
    if (route.kind === 'health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
    const log: RequestLog = { ts: new Date(t0).toISOString(), reqId: randomUUID(), kind: 'rejected', status: 0 }
    slot.log = log
    if (config.fault !== 'none') log.fault = config.fault // E2E fault revisions stamp every line
    const finish = (status: number, body?: unknown) => {
      log.status = status
      log.durationMs = now() - t0
      if (body !== undefined) json(res, status, body)
      slot.emitted = true
      emit(sink, log, now(), universe)
    }
    if (route.kind === 'not-found') { log.reason = 'not-found'; finish(404, { error: 'not found' }); return }
    log.hopToken = hopTokenOf(req.headers['x-amz-security-token'])
    // Registered before the first await: a client that leaves while the body is read or core decides must not
    // trigger (and pay for) an upstream call.
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })

    // 1. Hop authentication, before the body is read.
    const auth = inbound(req.headers, { discovery: route.kind === 'models' })
    if (auth.sourceArn) log.sourceArn = auth.sourceArn
    if (!auth.ok) { log.reason = auth.reason; req.resume(); forbid(res); finish(403); return }
    // One generation for the whole request (I1): decide, beta veto, model checks, failover, record and the log line.
    const gen = slot.gen ?? runtime.current()
    if (route.kind === 'models') { req.resume(); log.reason = 'models'; finish(200, modelList(gen.policy.aliases, now())); return }
    const { engine } = gen
    const assessor = gen.assessor
    const known = (id: string) => gen.aliases.has(id) || gen.pinAllowed.has(id)
    // 1b. Verified principal, before the body (model discovery above carries no client token). The mode is the
    // generation's (document over env). Rejections are 401/403/429, never 5xx (the gateway fallback would serve it).
    let principal = deps.principalOf?.(req)
    if (deps.identity) {
      const id = deps.identity.check(req.headers, identityMode(gen))
      principal = id.principal?.id !== undefined ? principalKey(id.principal) : undefined
      if (id.principal) {
        const group = principal !== undefined ? gen.principals.get(principal)?.group : undefined
        log.principal = { ...id.principal, ...(group ? { group } : {}) }
      }
      if (id.identity) log.identity = id.identity
      if (!id.ok) { log.configVersion = gen.configVersion; log.reason = id.code; req.resume(); finish(id.status, { error: IDENTITY_ERROR[id.status], code: id.code }); return }
    }
    const resolved = resolveCap(gen.document.access, gen.principals, principal)
    const cap: Cap | undefined = resolved.cap?.maxTier !== undefined || resolved.cap?.allowPins?.length ? resolved.cap : undefined
    log.configVersion = gen.configVersion
    log.catalogVersion = config.catalog.version
    log.kind = 'model'
    log.dialect = route.dialect
    log.headers = loggedHeaders(req.headers)
    if (config.fault === 'router-503') { log.reason = 'fault-inject:router-503'; req.resume(); finish(503, { error: 'router unavailable' }); return }

    // 2. Body.
    let raw: Buffer
    let body: Record<string, unknown>
    try {
      raw = await readBody(req, config.maxBodyBytes)
      log.bodyBytes = raw.length
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BodyError(400, 'JSON object required')
      // JSON.parse keeps the last duplicate while other parsers keep the first: refuse any duplicate top-level key.
      const names = topLevelMembers(raw).members.map((m) => m.key)
      if (new Set(names).size !== names.length) throw new BodyError(400, 'duplicate top-level key')
      body = parsed as Record<string, unknown>
    } catch (e) {
      const status = e instanceof BodyError ? e.status : 400
      log.reason = status === 413 ? 'body-too-large' : 'invalid-json'
      if (status === 413) res.setHeader('connection', 'close')
      finish(status, { error: status === 413 ? 'request body too large' : 'invalid JSON body' })
      return
    }
    const tBody = now()
    log.bodyReadMs = tBody - t0
    const stream = body.stream === true
    log.stream = stream
    if (typeof body.model === 'string') {
      log.requested = known(body.model) ? body.model : 'other'
      log.requestedLength = body.model.length
    }

    // 3. Decide.
    let summary: RequestSummary
    let decision: Decision
    try {
      summary = engine.summarize(route.dialect, body, coreHeaders(req.headers), tBody)
      log.lineage = lineageLabel(summary.session.lineage)
      log.session = lineageLabel(summary.session.root)
      // Concrete ids (body model or x-router-hint pin) are limited to the policy's models (review fix 5).
      const pin = summary.hints.pin
      if ((!gen.aliases.has(summary.requestedModel) && !gen.pinAllowed.has(summary.requestedModel)) || (pin !== undefined && !gen.pinAllowed.has(pin))) {
        log.reason = 'pin-not-allowed'
        finish(400, { error: 'model not allowed', code: 'pin-not-allowed' })
        return
      }
      // Pins against the caller's cap (design 0.3a/0.16): checked at once (access semantics), after pin-not-allowed.
      const pinned = pin ?? (gen.aliases.has(summary.requestedModel) ? undefined : summary.requestedModel)
      if (cap && pinned !== undefined && !pinAllowedByCap(cap, pinned, tierOfPoolModel(gen.policy, config.catalog, route.dialect, pinned))) {
        log.reason = 'access-cap'
        finish(400, { error: `model above your tier limit (${cap.maxTier})`, code: 'access-cap' })
        return
      }
      const tDecide = now()
      const card = deps.card ?? assessor?.card
      const extras = card || cap
        ? { ...(card ? { card: (ctx: CardContext) => card(summary, body, ctx) } : {}), ...(cap ? { cap } : {}) }
        : undefined
      if (assessor) {
        // Consultation happens inside decide() (core bounds it); the trace collects its structured audit fields.
        const { value, trace } = await assessor.traced(() => engine.decide(summary, extras))
        decision = value
        const a = assessor.logOf(decision, trace)
        if (a) log.assessor = a
      } else {
        decision = await engine.decide(summary, extras)
      }
      log.decideMs = now() - tDecide // includes the assessor consultation, if any
    } catch (e) {
      if (e instanceof AccessCapError) {
        // Never 5xx: the gateway fallback would serve the request without the router (design 0.15/0.16).
        log.reason = e.code
        finish(400, { error: e.code === 'access-cap' ? `no model within your tier limit (${cap?.maxTier})` : `no model within your tier limit (${cap?.maxTier}) fits this request`, code: e.code })
        return
      }
      log.kind = 'error'
      log.error = (e as Error).name
      log.reason = 'decide-failed'
      finish(503, { error: 'no eligible model' }) // 5xx: the gateway fallback rule serves the request
      return
    }

    // 4. Beta veto (Messages only): deny list, never in observe mode, never to a lower tier.
    // Bedrock compatibility (bedrock-compat.ts): betas Bedrock rejects are dropped from the header before the veto
    // sees them, so the veto and the upstream request use the same list.
    const betaHeader = typeof req.headers['anthropic-beta'] === 'string' ? req.headers['anthropic-beta'] : undefined
    const compat = route.dialect === 'anthropic-messages' ? stripBetas(betaHeader) : { header: betaHeader, stripped: [] as string[] }
    const sanitized: string[] = compat.stripped.map((b) => `beta:${b}`)
    if (route.dialect === 'anthropic-messages') {
      const betas = parseBetas(compat.header)
      if (betas.length) {
        const current = (await store.get(summary.session.lineage))?.current
        // A veto moves up a tier, never above the caller's cap.
        const pool = poolTiers(gen.policy, config.catalog, route.dialect).filter((m) => tierWithinCap(cap, m.tier))
        const v = betaVeto(decision, betas, { ...(current ? { current } : {}), pool }, deps.betaTable)
        decision = v.decision
        if (v.vetoed) log.betaVeto = v.vetoed
      }
    }
    // Defensive: core returns pool models, allowed pins, or a hard-locked lineage's current model, which an earlier
    // generation may have chosen (I3), so the bound is the universe, not this generation's policy.
    if (!universe.has(decision.model)) {
      log.reason = 'pin-not-allowed'
      finish(400, { error: 'model not allowed', code: 'pin-not-allowed' })
      return
    }
    log.decision = {
      action: decision.action, point: decision.point, mode: decision.mode, model: decision.model, reason: decision.reason.slice(0, MAX_REASON),
      policyVersion: decision.policyVersion,
      ...(decision.wouldChoose ? { wouldChoose: decision.wouldChoose } : {}), ...(decision.estimate ? { estimate: decision.estimate } : {}),
      ...(decision.projected ? { projected: decision.projected } : {}),
    }

    // 5. Opt-in hints, then the model splice.
    let baseBody: Buffer
    let stripUsage = false
    try {
      const h = applyBodyHints(route.dialect, raw, body, config.hints)
      stripUsage = h.stripUsage
      if (h.applied.length) log.hints = h.applied
      let b = h.body
      if (route.dialect === 'anthropic-messages') {
        const m = sanitizeMetadata(b, body)
        if (m.edited) { b = m.body; sanitized.unshift('user_id') }
      }
      if (sanitized.length) log.sanitized = sanitized
      baseBody = b
    } catch (e) {
      log.reason = 'invalid-json'
      finish(e instanceof BodyError ? e.status : 400, { error: e instanceof BodyError ? e.message : 'invalid JSON body' })
      return
    }

    // The body for one attempt's model: the model splice, then the per-model Chat edit (a failover to another family
    // gets its own body). The edits of the attempt that is relayed are logged.
    const bodyFor = (model: string): { body: Buffer; edits: string[] } => {
      const b = spliceTopLevel(baseBody, 'model', JSON.stringify(model))
      return route.dialect === 'openai-chat' ? chatTokenLimit(b, model, config.catalog) : { body: b, edits: [] }
    }
    let first: { body: Buffer; edits: string[] }
    try {
      first = bodyFor(decision.model)
    } catch (e) {
      log.reason = 'invalid-json'
      finish(e instanceof BodyError ? e.status : 400, { error: e instanceof BodyError ? e.message : 'invalid JSON body' })
      return
    }
    let edits = first.edits

    // 7. Forward, with one failover before any byte reaches the client.
    if (abort.signal.aborted) { log.clientAborted = true; log.reason = 'client-aborted'; finish(499); res.destroy(); return }
    const headers = upstreamHeaders(req.headers)
    if (compat.stripped.length) {
      if (compat.header === undefined) delete headers['anthropic-beta']
      else headers['anthropic-beta'] = compat.header
    }
    const headerMs = stream ? config.timeouts.streamHeaderMs : config.timeouts.nonStreamHeaderMs
    // One header deadline for ALL attempts (first try + failover): the gateway's first-byte timeout (610 s) must
    // never fire before the router answers. Cleared once the attempt we relay has its headers.
    const deadline = new AbortController()
    const deadlineTimer = setTimeout(() => deadline.abort(), headerMs)
    const attempt = async (b: Buffer): Promise<Response | { network: string }> => {
      if (faultAt && ++upstreamAttempts === faultAt) { return new Response('{"message":"fault-inject"}', { status: 503, headers: { 'content-type': 'application/json' } }) }
      if (deadline.signal.aborted) return { network: 'timeout' }
      try {
        return await forward({ upstream: config.upstream, path: route.upstreamPath, body: b, headers, signer,
          signal: AbortSignal.any([abort.signal, deadline.signal]), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
      } catch (e) {
        if (abort.signal.aborted) return { network: 'aborted' }
        return { network: deadline.signal.aborted ? 'timeout' : 'network' }
      }
    }
    const tUp = now()
    log.overheadMs = tUp - tBody
    let served = decision.model
    let up = await attempt(first.body)
    const failed = (r: Response | { network: string }) => !(r instanceof Response) || RETRYABLE_STATUS.has(r.status)
    // No profile rotation inside a Responses chain (core: failover-chain-locked).
    const chainLocked = summary.previousResponseId !== undefined || decision.point === 'hard-lock-response-chain'
    // Same-model profile retry only for policy.failover.profileRotateOn (default 429; a network error counts as 502):
    // a 5xx on global. is very likely shared by the geo profile, so it goes to core / the gateway fallback instead.
    const rotatable = (r: Response | { network: string }) => gen.policy.failover.profileRotateOn.includes(r instanceof Response ? r.status : 502)
    if (failed(up) && rotatable(up) && !abort.signal.aborted && !deadline.signal.aborted && !chainLocked) {
      const to = failoverTargets(gen.policy, route.dialect, decision.model).find((m) => universe.has(m))
      if (to) {
        const status = up instanceof Response ? up.status : up.network
        if (up instanceof Response) await up.body?.cancel().catch(() => undefined)
        // Core learns about the failed profile first, so the final record() and the next decide() see it.
        await record(engine, summary, decision, decision.model, typeof status === 'number' ? status : 502)
        await sleep(jitterMs())
        log.failover = { from: decision.model, to, status }
        served = to
        const next = bodyFor(to) // same members as the first body: it cannot newly fail to parse
        edits = next.edits
        up = await attempt(next.body)
      }
    }
    clearTimeout(deadlineTimer) // headers arrived (or every attempt failed): the body is governed by the idle timeout
    log.servedModel = served
    if (edits.length) log.bodyEdits = edits
    if (!(up instanceof Response)) {
      log.reason = `upstream-${up.network}`
      if (up.network === 'aborted') { log.clientAborted = true; finish(499); res.destroy(); return }
      finish(502, { error: 'upstream unavailable' })
      await record(engine, summary, decision, served, 502)
      return
    }
    log.upstreamTtfbMs = now() - tUp

    // 6 + 8. Decision headers, then the upstream status and content-type, then the body.
    const tHead = now()
    const ctype = up.headers.get('content-type') ?? 'application/json'
    res.writeHead(up.status, {
      'content-type': ctype,
      ...(ctype.includes('text/event-stream') ? { 'cache-control': 'no-cache' } : {}),
      'x-router-decision': headerSafe(`${decision.action};${decision.point};${decision.mode}`),
      'x-router-model': headerSafe(served),
      'x-router-reason': headerSafe(reasonCode(decision.reason)),
    })
    log.overheadMs += now() - tHead
    const r = await relay(up, res, { dialect: route.dialect, stream: stream && ctype.includes('text/event-stream'), stripUsage, now, idleMs: config.timeouts.idleMs, heartbeatMs: config.timeouts.heartbeatMs,
      ...(pauseMs ? { pauseAfterFirstFrameMs: pauseMs } : {}) })
    if (r.heartbeats) log.heartbeats = r.heartbeats
    // Partial calls still cost money: the usage seen so far is logged, priced and recorded.
    // - mid-stream upstream failure: recorded to core as 502 so failover sees it (core skips cache bookkeeping);
    // - client abort: recorded with the upstream status and the partial usage (cache writes did happen).
    let status = up.status
    if (r.clientAborted) {
      log.clientAborted = true
      // A close near the hop's maximum stream duration is the hop cutting the stream, not the user leaving.
      const cap = config.timeouts.streamCapMs
      log.reason = stream && now() - t0 >= cap - Math.min(10_000, cap / 10) ? 'stream-duration-cap' : 'client-abort'
      abort.abort()
    }
    else if (r.error) { log.error = r.error; log.reason = 'mid-stream'; status = 502 }
    log.usage = r.usage
    log.costUsd = costFor(config.catalog, served, r.usage)
    log.hitRate = hitRate(r.usage)
    if (r.usage === undefined && up.status < 400) {
      // No usage event at all (0.3c): the call was billed but its size is unknown, so log an approximate bound.
      log.usageMissing = true
      const b = costBound(config.catalog, served, summary)
      if (b) { log.costBoundUsd = b.usd; if (b.partial) log.boundPartial = true }
    }
    const rec = await record(engine, summary, decision, served, status, r.usage, r.responseId)
    if (rec?.miss) log.miss = rec.miss
    if (rec?.switchedFrom) log.switchedFrom = rec.switchedFrom
    finish(r.clientAborted ? 499 : status)
  }

  async function record(engine: Engine, summary: RequestSummary, decision: Decision, servedModel: string, status: number,
    usage?: RequestLog['usage'], responseId?: string) {
    try {
      return await engine.record(summary, decision, { servedModel, status, ...(usage ? { usage } : {}), ...(responseId ? { responseId } : {}) })
    } catch {
      return undefined // state bookkeeping must never fail the request
    }
  }

  const run = (req: IncomingMessage, res: ServerResponse, slot: LogSlot = {}) => {
    handle(req, res, slot).catch((e: unknown) => {
      // Router bug: 5xx so the gateway fallback serves the request. No details leave the process.
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.destroy()
      if (slot.emitted) return
      const log: RequestLog = slot.log ?? { ts: new Date().toISOString(), reqId: randomUUID(), kind: 'error', status: 500 }
      log.kind = 'error'
      log.status = 500
      log.reason = 'internal'
      log.error = (e as Error)?.name ?? 'Error'
      emit(sink, log, now(), universe)
    })
  }
  const server = createServer(run)
  // Expect: 100-continue: authenticate before inviting the body.
  server.on('checkContinue', (req, res) => {
    const route = routeOf(req.method, req.url)
    if (route.kind !== 'health' && route.kind !== 'not-found' && !inbound(req.headers, { discovery: route.kind === 'models' }).ok) {
      emit(sink, { ts: new Date(now()).toISOString(), reqId: randomUUID(), kind: 'rejected', status: 403, reason: 'expect-continue-forbidden' }, now(), universe)
      forbid(res)
      return
    }
    // One generation for the identity check here and the whole request after it (I1: the mode cannot change between them).
    const gen = runtime.current()
    if (route.kind === 'model' && deps.identity) {
      const id = deps.identity.check(req.headers, identityMode(gen))
      if (!id.ok) {
        emit(sink, { ts: new Date(now()).toISOString(), reqId: randomUUID(), kind: 'rejected', status: id.status, reason: id.code,
          principal: id.principal, identity: id.identity, configVersion: gen.configVersion }, now(), universe)
        json(res, id.status, { error: IDENTITY_ERROR[id.status], code: id.code }, true)
        return
      }
    }
    res.writeContinue()
    run(req, res, { gen })
  })
  server.requestTimeout = 15 * 60_000
  server.headersTimeout = 30_000
  server.keepAliveTimeout = 65_000
  return { server, handle }
}

/** The router without a config source: one fixed generation from the boot policy, engine and assessor. */
function fixedRuntime(deps: RouterDeps, sink: (line: string) => void): RuntimeRef {
  const { config } = deps
  if (!deps.engine) throw new TypeError('createRouter: `engine` or `runtime` required')
  const engine = deps.engine
  return createRuntime(bakedDocument(config.policy), {
    catalog: config.catalog, store: deps.store, sink, engineFor: () => engine,
    buildAssessor: () => ({ ok: true, ...(deps.assessor ? { assessor: deps.assessor } : {}) }),
  })
}

/** Without ROUTER_MODEL_UNIVERSE: the boot generation's models plus the assessor model (today's IAM grant). */
export function defaultUniverse(config: RouterConfig, g: Generation): ReadonlySet<string> {
  const u = new Set(allowedModels(config.policy, config.catalog))
  for (const m of g.pinAllowed) u.add(m)
  if (g.assessor) u.add(g.assessor.settings.model)
  return u
}
