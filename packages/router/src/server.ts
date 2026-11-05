// Request pipeline (design §2.2): inbound check -> route -> summarize/decide -> beta veto -> body hints + model
// splice -> SigV4 forward (+ failover) -> relay -> record + log.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { CardContext, Decision, Engine, RequestSummary, StateStore } from '@auto-router/core'
import { RETRYABLE_STATUS } from '@auto-router/core'
import { costFor, emit, hitRate, hopTokenOf, lineageLabel, loggedHeaders, stdoutSink, type LogSink, type RequestLog } from './account.ts'
import { betaVeto, parseBetas, type BetaTable } from './beta.ts'
import { BodyError, readBody, spliceTopLevel, topLevelMembers } from './body.ts'
import type { RouterConfig } from './config.ts'
import { failoverTargets, jitterMs } from './failover.ts'
import { forward, upstreamHeaders, type Signer } from './forward.ts'
import { applyBodyHints, coreHeaders } from './hints.ts'
import { createInboundCheck, type InboundCheck } from './inbound.ts'
import { allowedModels, poolTiers } from './models.ts'
import { routeOf } from './routes.ts'
import { relay } from './stream.ts'

/**
 * Tier-assessor seam (parent design §3): core calls `extras.card(ctx)` lazily, only when it consults the assessor,
 * and passes the CardContext (current/parent tier, compactions, lineage kind). Wire `buildCard` from
 * @auto-router/assessor: `card: (summary, body, ctx) => buildCard(summary, body, ctx)`.
 */
export type CardBuilder = (summary: RequestSummary, body: unknown, ctx: CardContext) => unknown

export interface RouterDeps {
  config: RouterConfig
  engine: Engine
  store: StateStore
  signer: Signer
  inbound?: InboundCheck
  sink?: LogSink
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  card?: CardBuilder
  betaTable?: BetaTable
}

export interface Router { server: Server; handle(req: IncomingMessage, res: ServerResponse, slot?: LogSlot): Promise<void> }

/** Lets the server wrapper log a request whose handler threw (review fix 11). */
export interface LogSlot { log?: RequestLog; emitted?: boolean }

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
  const { config, engine, store, signer } = deps
  const inbound = deps.inbound ?? createInboundCheck(config.hopAuth)
  const sink = deps.sink ?? stdoutSink
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // upstream-503-once[:<n>]: the n-th upstream attempt of this process (first tries and failovers alike) gets a 503.
  const faultAt = config.fault.startsWith('upstream-503-once') ? Number(config.fault.split(':')[1] ?? 1) : 0
  let upstreamAttempts = 0
  const pauseMs = config.fault.startsWith('pause-after-first-frame:') ? Number(config.fault.split(':')[1]) : 0
  const allowed = allowedModels(config.policy, config.catalog)
  const aliases = new Set(Object.keys(config.policy.aliases))
  const known = (id: string) => aliases.has(id) || allowed.has(id)

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
      emit(sink, log, now(), allowed)
    }
    if (route.kind === 'not-found') { log.reason = 'not-found'; finish(404, { error: 'not found' }); return }
    log.hopToken = hopTokenOf(req.headers['x-amz-security-token'])
    // Registered before the first await: a client that leaves while the body is read or core decides must not
    // trigger (and pay for) an upstream call.
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })

    // 1. Hop authentication, before the body is read.
    const auth = inbound(req.headers)
    if (!auth.ok) { log.reason = auth.reason; req.resume(); forbid(res); finish(403); return }
    if (route.kind === 'models') { req.resume(); log.reason = 'models'; finish(200, modelList(config.policy.aliases, now())); return }
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
      // Concrete ids (body model or x-router-hint pin) are limited to the policy's models (review fix 5).
      const pin = summary.hints.pin
      if ((!aliases.has(summary.requestedModel) && !allowed.has(summary.requestedModel)) || (pin !== undefined && !allowed.has(pin))) {
        log.reason = 'pin-not-allowed'
        finish(400, { error: 'model not allowed', code: 'pin-not-allowed' })
        return
      }
      const card = deps.card
      decision = await engine.decide(summary, card ? { card: (ctx) => card(summary, body, ctx) } : undefined)
    } catch (e) {
      log.kind = 'error'
      log.error = (e as Error).name
      log.reason = 'decide-failed'
      finish(503, { error: 'no eligible model' }) // 5xx: the gateway fallback rule serves the request
      return
    }

    // 4. Beta veto (Messages only): deny list, never in observe mode, never to a lower tier.
    if (route.dialect === 'anthropic-messages') {
      const betas = parseBetas(typeof req.headers['anthropic-beta'] === 'string' ? req.headers['anthropic-beta'] : undefined)
      if (betas.length) {
        const current = (await store.get(summary.session.lineage))?.current
        const pool = poolTiers(config.policy, config.catalog, route.dialect)
        const v = betaVeto(decision, betas, { ...(current ? { current } : {}), pool }, deps.betaTable)
        decision = v.decision
        if (v.vetoed) log.betaVeto = v.vetoed
      }
    }
    if (!allowed.has(decision.model)) { // defensive: core only returns pool models or allowed pins
      log.reason = 'pin-not-allowed'
      finish(400, { error: 'model not allowed', code: 'pin-not-allowed' })
      return
    }
    log.decision = {
      action: decision.action, point: decision.point, mode: decision.mode, model: decision.model, reason: decision.reason.slice(0, MAX_REASON),
      policyVersion: decision.policyVersion,
      ...(decision.wouldChoose ? { wouldChoose: decision.wouldChoose } : {}), ...(decision.estimate ? { estimate: decision.estimate } : {}),
    }

    // 5. Opt-in hints, then the model splice.
    let upstreamBody: Buffer
    let stripUsage = false
    try {
      const h = applyBodyHints(route.dialect, raw, body, config.hints)
      stripUsage = h.stripUsage
      if (h.applied.length) log.hints = h.applied
      upstreamBody = spliceTopLevel(h.body, 'model', JSON.stringify(decision.model))
    } catch (e) {
      log.reason = 'invalid-json'
      finish(e instanceof BodyError ? e.status : 400, { error: e instanceof BodyError ? e.message : 'invalid JSON body' })
      return
    }

    // 7. Forward, with one failover before any byte reaches the client.
    if (abort.signal.aborted) { log.clientAborted = true; log.reason = 'client-aborted'; finish(499); res.destroy(); return }
    const headers = upstreamHeaders(req.headers)
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
    let up = await attempt(upstreamBody)
    const failed = (r: Response | { network: string }) => !(r instanceof Response) || RETRYABLE_STATUS.has(r.status)
    // No profile rotation inside a Responses chain (core: failover-chain-locked).
    const chainLocked = summary.previousResponseId !== undefined || decision.point === 'hard-lock-response-chain'
    // Same-model profile retry only for policy.failover.profileRotateOn (default 429; a network error counts as 502):
    // a 5xx on global. is very likely shared by the geo profile, so it goes to core / the gateway fallback instead.
    const rotatable = (r: Response | { network: string }) => config.policy.failover.profileRotateOn.includes(r instanceof Response ? r.status : 502)
    if (failed(up) && rotatable(up) && !abort.signal.aborted && !deadline.signal.aborted && !chainLocked) {
      const to = failoverTargets(config.policy, route.dialect, decision.model).find((m) => allowed.has(m))
      if (to) {
        const status = up instanceof Response ? up.status : up.network
        if (up instanceof Response) await up.body?.cancel().catch(() => undefined)
        // Core learns about the failed profile first, so the final record() and the next decide() see it.
        await record(summary, decision, decision.model, typeof status === 'number' ? status : 502)
        await sleep(jitterMs())
        log.failover = { from: decision.model, to, status }
        served = to
        up = await attempt(spliceTopLevel(upstreamBody, 'model', JSON.stringify(to)))
      }
    }
    clearTimeout(deadlineTimer) // headers arrived (or every attempt failed): the body is governed by the idle timeout
    log.servedModel = served
    if (!(up instanceof Response)) {
      log.reason = `upstream-${up.network}`
      if (up.network === 'aborted') { log.clientAborted = true; finish(499); res.destroy(); return }
      finish(502, { error: 'upstream unavailable' })
      await record(summary, decision, served, 502)
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
    const rec = await record(summary, decision, served, status, r.usage, r.responseId)
    if (rec?.miss) log.miss = rec.miss
    finish(r.clientAborted ? 499 : status)
  }

  async function record(summary: RequestSummary, decision: Decision, servedModel: string, status: number,
    usage?: RequestLog['usage'], responseId?: string) {
    try {
      return await engine.record(summary, decision, { servedModel, status, ...(usage ? { usage } : {}), ...(responseId ? { responseId } : {}) })
    } catch {
      return undefined // state bookkeeping must never fail the request
    }
  }

  const run = (req: IncomingMessage, res: ServerResponse) => {
    const slot: LogSlot = {}
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
      emit(sink, log, now(), allowed)
    })
  }
  const server = createServer(run)
  // Expect: 100-continue: authenticate before inviting the body.
  server.on('checkContinue', (req, res) => {
    const route = routeOf(req.method, req.url)
    if (route.kind !== 'health' && route.kind !== 'not-found' && !inbound(req.headers).ok) {
      emit(sink, { ts: new Date(now()).toISOString(), reqId: randomUUID(), kind: 'rejected', status: 403, reason: 'expect-continue-forbidden' }, now(), allowed)
      forbid(res)
      return
    }
    res.writeContinue()
    run(req, res)
  })
  server.requestTimeout = 15 * 60_000
  server.headersTimeout = 30_000
  server.keepAliveTimeout = 65_000
  return { server, handle }
}
