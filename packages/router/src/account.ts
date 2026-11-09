// Accounting and observability (design §2.8): one JSON log line per request plus one EMF document.
// Never logs bodies, prompts, raw session ids or header values outside LOGGED_HEADERS.
import { createHash } from 'node:crypto'
import type { AssessmentStatus, Decision, RecordResult, RequestSummary, Tier } from '@auto-router/core'
import { costOf, findModel, type CostBreakdown, type Dialect, type NormalizedUsage, type PriceCatalog } from '@auto-router/pricing'
import type { IdentityStatus, Principal } from './identity.ts'

export const LOGGED_HEADERS = ['anthropic-version', 'anthropic-beta', 'openai-beta', 'content-type'] as const

export interface RequestLog {
  ts: string
  reqId: string
  kind: 'model' | 'rejected' | 'error'
  status: number
  dialect?: Dialect
  /** A known model id or alias, else 'other' (client-controlled text is never logged as is). */
  requested?: string
  requestedLength?: number
  lineage?: string
  /**
   * lineageLabel(session root): sha256(root)[:16], never the raw value. The root is x-router-parent-session, else
   * the session header (x-router-session, ...), else the fingerprint id. Lets a client join its runs to log lines.
   * A log property only: never an EMF dimension (one value per session).
   */
  session?: string
  decision?: Pick<Decision, 'action' | 'point' | 'mode' | 'model' | 'reason' | 'policyVersion'> & Partial<Pick<Decision, 'wouldChoose' | 'estimate' | 'projected'>>
  servedModel?: string
  stream?: boolean
  usage?: NormalizedUsage
  costUsd?: CostBreakdown
  hitRate?: number
  miss?: RecordResult['miss']
  /**
   * Timing (ms, router clock). bodyReadMs: request start → body parsed. decideMs: time in engine.decide(),
   * including any assessor consultation (also in assessor.latencyMs). overheadMs: body parsed →
   * upstream send, plus writing the response head (so it includes decideMs). upstreamTtfbMs: upstream send →
   * response headers (failover included). durationMs: request start → last byte relayed (or the error answer).
   * Router pre-upstream time = bodyReadMs + overheadMs (minus the head write, under 1 ms).
   */
  bodyReadMs?: number
  decideMs?: number
  overheadMs?: number
  upstreamTtfbMs?: number
  durationMs?: number
  bodyBytes?: number
  hints?: string[]
  failover?: { from: string; to: string; status: number | string }
  betaVeto?: string
  headers?: Partial<Record<(typeof LOGGED_HEADERS)[number], string>>
  reason?: string
  error?: string
  clientAborted?: boolean
  /**
   * How x-amz-security-token arrived (the value is never logged). The hop's integration mapping overwrites it with
   * 'redacted'; 'other' means the mapping is missing and the gateway's session token reached the router.
   */
  hopToken?: HopToken
  /** Set when x-amz-source-arn was not this gateway's ARN (model discovery allows that; inference rejects it). */
  sourceArn?: SourceArnLog
  /** SSE comment heartbeats the router wrote during upstream silence. */
  heartbeats?: number
  /** Set only when an E2E fault is configured (ROUTER_FAULT_INJECT). */
  fault?: string
  /** Present only when core consulted the tier assessor (or reused its answer) for this decision. */
  assessor?: AssessorLog
  /** Bedrock-compat edits made to this request (bedrock-compat.ts): 'user_id' and/or 'beta:<name>'. Absent when none. */
  sanitized?: string[]
  /** Body edits for the served model's dialect (bedrock-compat.ts chatTokenLimit), codes only. Absent when none. */
  bodyEdits?: string[]
  /** Runtime configuration generation that served this request (settings.ts; "0-baked" without a document). */
  configVersion?: string
  /** Price catalog behind `costUsd` (savings repricing must use the same one, 0d §1.2). */
  catalogVersion?: string
  /** The lineage moved off `model` on this call; `warmTokens` = its prefix still warm there (switch penalty, 0d §1.2). */
  switchedFrom?: RecordResult['switchedFrom']
  /**
   * 0.3c: the upstream answered 2xx but no usage event arrived at all (e.g. a stream cut before its usage). The call
   * was billed; `costBoundUsd` is an approximate upper bound (estimated prompt × the highest input-side rate, plus the
   * output cap × the output rate). `boundPartial`: no output cap was set, so the output term is missing. Never in
   * `costUsd`, which stays "metered".
   */
  usageMissing?: true
  costBoundUsd?: number
  boundPartial?: true
  /**
   * Identity gate (identity.ts; absent when the mode is off): the verified principal, ids and the group from
   * principals.json only, and how the identity header verified. Never a username, e-mail or token.
   */
  principal?: Principal
  identity?: IdentityStatus
}

export type HopToken = 'absent' | 'redacted' | 'other'
/** How x-amz-source-arn differed from the gateway ARN (inbound.ts sourceArnShape): shape only, never the value. */
export type SourceArnLog = 'absent' | 'gateway' | 'gateway-subresource' | 'other-agentcore' | 'other'

/**
 * One tier-assessor consultation (router assessor.ts). Codes and numbers only: never card, prompt or output text.
 * - `tier`: the opinion core saw (absent when the assessor withheld it: no opinion, or a basis that is not
 *   auto-eligible under autoRules 'pack'); `proposedTier`: what the pack's mapping proposed, whatever the flags.
 * - `basis`: rule ids and `fact:*` signals behind proposedTier, or the no-opinion code.
 * - `outcome`: map outcome (fast | standard | frontier | low-confidence | conflict | fast-unsettled | no-rule),
 *   `skipped:<precheck code>`, `unavailable:<reason code>`, or core's timeout | error | invalid.
 * - `costUsd`: this consultation's spend (absent when cached, i.e. reused for the same user turn).
 * - `packVersion`: `<pack id>+<sha256[:12]>` of the rendered pack (also when cached); resolves `basis` rule ids to
 *   the rule text of that version (console packs archive).
 */
export interface AssessorLog {
  id: string
  packVersion?: string
  mode: 'observe' | 'auto'
  autoRules: 'pack' | 'all'
  status: AssessmentStatus
  tier?: Tier
  proposedTier?: Tier
  confidence?: number
  basis?: string[]
  outcome?: string
  latencyMs: number
  costUsd?: number
  called?: boolean
  applied: boolean
  cached?: true
  guard?: string
}

export function hopTokenOf(v: string | string[] | undefined): HopToken {
  return v === undefined ? 'absent' : v === 'redacted' ? 'redacted' : 'other'
}

export type LogSink = (line: string) => void
export const stdoutSink: LogSink = (line) => { process.stdout.write(`${line}\n`) }

/** Short, stable, non-reversible lineage label for logs (never the raw session id). */
export function lineageLabel(lineage: string): string {
  return createHash('sha256').update(lineage).digest('hex').slice(0, 16)
}

export function loggedHeaders(h: Record<string, string | string[] | undefined>): RequestLog['headers'] {
  const out: Record<string, string> = {}
  for (const k of LOGGED_HEADERS) { const v = h[k]; if (typeof v === 'string') out[k] = v }
  return out
}

export function costFor(catalog: PriceCatalog, model: string, usage: NormalizedUsage | undefined): CostBreakdown | undefined {
  const m = usage ? findModel(catalog, model) : undefined
  if (!m || !usage) return undefined
  try { return costOf(usage, m) } catch { return undefined }
}

/**
 * 0.3c approximate bound for a billed call without usage: estPromptTokens × max(input, every cache-write rate) (the
 * long-context prices when the estimate exceeds 0.9 × their threshold, as chars/4 can undercount), plus the request's
 * output cap × the output rate. Undefined for a model the catalog does not price.
 */
export function costBound(catalog: PriceCatalog, model: string, s: RequestSummary): { usd: number; partial: boolean } | undefined {
  const m = findModel(catalog, model)
  if (!m) return undefined
  const est = Math.max(0, s.prefix.estPromptTokens)
  const p = m.longContext && est > 0.9 * m.longContext.aboveTokens ? m.longContext.price : m.price
  const writes = Object.values(p.cacheWrite).filter((n): n is number => typeof n === 'number')
  const inRate = Math.max(p.input, ...writes)
  const out = s.maxOutputTokens
  return { usd: (est * inRate + (out !== undefined ? out * p.output : 0)) / 1_000_000, partial: out === undefined }
}

export function hitRate(u: NormalizedUsage | undefined): number | undefined {
  return u && u.promptTokens > 0 ? u.cacheReadTokens / u.promptTokens : undefined
}

const sum = (r: Partial<Record<string, number>>): number => Object.values(r).reduce<number>((a, b) => a + (b ?? 0), 0)

/**
 * CloudWatch EMF document for one request (namespace LlmAutoRouter, low-cardinality dimensions). `known` bounds the
 * ServedModel dimension (anything else is 'other'; the raw id stays a truncated property).
 */
export function emf(log: RequestLog, nowMs: number, known?: ReadonlySet<string>): Record<string, unknown> {
  const metrics: Array<{ Name: string; Unit: string; v: number }> = [{ Name: 'Requests', Unit: 'Count', v: 1 }]
  if (log.costUsd) metrics.push({ Name: 'CostUsd', Unit: 'None', v: log.costUsd.total })
  if (log.usage) {
    metrics.push({ Name: 'PromptTokens', Unit: 'Count', v: log.usage.promptTokens },
      { Name: 'CacheReadTokens', Unit: 'Count', v: log.usage.cacheReadTokens },
      { Name: 'CacheWriteTokens', Unit: 'Count', v: sum(log.usage.cacheWriteTokens) })
  }
  if (log.decision?.action === 'switch') metrics.push({ Name: 'Switches', Unit: 'Count', v: 1 })
  if (log.miss) metrics.push({ Name: 'Misses', Unit: 'Count', v: 1 })
  if (log.overheadMs !== undefined) metrics.push({ Name: 'OverheadMs', Unit: 'Milliseconds', v: log.overheadMs })
  if (log.upstreamTtfbMs !== undefined) metrics.push({ Name: 'UpstreamTtfbMs', Unit: 'Milliseconds', v: log.upstreamTtfbMs })
  // Only statuses Bedrock (or the network to it) produced: not router 400/413s and not client aborts (499).
  if (log.status >= 400 && log.kind === 'model' && log.servedModel !== undefined && !log.clientAborted) metrics.push({ Name: 'UpstreamErrors', Unit: 'Count', v: 1 })
  if (log.failover) metrics.push({ Name: 'Failovers', Unit: 'Count', v: 1 })
  if (log.betaVeto) metrics.push({ Name: 'BetaVetoes', Unit: 'Count', v: 1 })
  const a = log.assessor
  if (a && !a.cached) {
    metrics.push({ Name: 'AssessorConsults', Unit: 'Count', v: 1 }, { Name: 'AssessorLatencyMs', Unit: 'Milliseconds', v: a.latencyMs })
    if (a.costUsd !== undefined) metrics.push({ Name: 'AssessorCostUsd', Unit: 'None', v: a.costUsd })
    if (a.status !== 'ok') metrics.push({ Name: 'AssessorUnavailable', Unit: 'Count', v: 1 })
  }
  if (a?.applied) metrics.push({ Name: 'AssessorApplied', Unit: 'Count', v: 1 })
  const statusClass = `${Math.floor(log.status / 100)}xx`
  const directives: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> = [
    { Namespace: NAMESPACE, Dimensions: [['Dialect', 'ServedModel'], ['Mode']], Metrics: metrics.map(({ Name, Unit }) => ({ Name, Unit })) },
    // Outcome by status class and reason code: both low-cardinality (codes only; raw status/text stay properties).
    { Namespace: NAMESPACE, Dimensions: [['StatusClass'], ['StatusClass', 'Reason']],
      Metrics: metrics.filter((m) => m.Name === 'Requests' || m.Name === 'UpstreamErrors').map(({ Name, Unit }) => ({ Name, Unit })) },
  ]
  if (log.miss) directives.push({ Namespace: NAMESPACE, Dimensions: [['MissReason']], Metrics: [{ Name: 'Misses', Unit: 'Count' }] })
  // Security signal: one series per alert reason, so an alarm can watch it directly.
  const alert = alertOf(log)
  if (alert) directives.push({ Namespace: NAMESPACE, Dimensions: [['AlertReason']], Metrics: [{ Name: 'Alerts', Unit: 'Count' }] })
  const doc: Record<string, unknown> = {
    _aws: { Timestamp: nowMs, CloudWatchMetrics: directives },
    Dialect: log.dialect ?? 'none',
    ServedModel: log.servedModel === undefined ? 'none' : !known || known.has(log.servedModel) ? log.servedModel : 'other',
    ServedModelId: log.servedModel?.slice(0, 128) ?? 'none',
    Mode: log.decision?.mode ?? 'none',
    StatusClass: statusClass,
    Reason: reasonDimension(log.reason),
  }
  for (const m of metrics) doc[m.Name] = m.v
  if (log.miss) doc.MissReason = log.miss.reason
  if (alert) { doc.Alerts = 1; doc.AlertReason = alert }
  doc.Status = log.status
  return doc
}

const NAMESPACE = 'LlmAutoRouter'

/** Reason code as a metric dimension: the part before ':', lower-case code characters only, else 'other'. */
export function reasonDimension(reason: string | undefined): string {
  if (!reason) return 'none'
  const code = reason.split(':', 1)[0]?.trim() ?? ''
  return /^[a-z0-9-]{1,40}$/.test(code) ? code : 'other'
}

/** Writes the log line and the EMF document; both are single-line JSON. */
export function emit(sink: LogSink, log: RequestLog, nowMs: number, known?: ReadonlySet<string>): void {
  sink(JSON.stringify(log))
  if (log.kind === 'model' || log.kind === 'error') sink(JSON.stringify(emf(log, nowMs, known)))
  else { const a = alertOf(log); if (a) sink(JSON.stringify(alertEmf(a, nowMs))) }
}

/** Security signals, one EMF series per reason (an alarm watches each). */
export function alertOf(log: RequestLog): string | undefined {
  if (log.hopToken === 'other') return 'hop-token-unexpected'
  if (log.identity === 'invalid:kid-unknown') return 'identity-kid-unknown'
  if (log.identity === 'invalid:keys-unavailable') return 'identity-keys-unavailable'
  return undefined
}

/** Alert-only EMF document, for rejected lines (they get no request metrics). */
export function alertEmf(reason: string, nowMs: number): Record<string, unknown> {
  return { _aws: { Timestamp: nowMs, CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [['AlertReason']], Metrics: [{ Name: 'Alerts', Unit: 'Count' }] }] },
    AlertReason: reason, Alerts: 1 }
}
