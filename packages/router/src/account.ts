// Accounting and observability (design §2.8): one JSON log line per request plus one EMF document.
// Never logs bodies, prompts, raw session ids or header values outside LOGGED_HEADERS.
import { createHash } from 'node:crypto'
import type { Decision, RecordResult } from '@auto-router/core'
import { costOf, findModel, type CostBreakdown, type Dialect, type NormalizedUsage, type PriceCatalog } from '@auto-router/pricing'

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
  decision?: Pick<Decision, 'action' | 'point' | 'mode' | 'model' | 'reason' | 'policyVersion'> & Partial<Pick<Decision, 'wouldChoose' | 'estimate'>>
  servedModel?: string
  stream?: boolean
  usage?: NormalizedUsage
  costUsd?: CostBreakdown
  hitRate?: number
  miss?: RecordResult['miss']
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
  /** SSE comment heartbeats the router wrote during upstream silence. */
  heartbeats?: number
  /** Set only when an E2E fault is configured (ROUTER_FAULT_INJECT). */
  fault?: string
}

export type HopToken = 'absent' | 'redacted' | 'other'

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
  const statusClass = `${Math.floor(log.status / 100)}xx`
  const directives: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> = [
    { Namespace: NAMESPACE, Dimensions: [['Dialect', 'ServedModel'], ['Mode']], Metrics: metrics.map(({ Name, Unit }) => ({ Name, Unit })) },
    // Outcome by status class and reason code: both low-cardinality (codes only; raw status/text stay properties).
    { Namespace: NAMESPACE, Dimensions: [['StatusClass'], ['StatusClass', 'Reason']],
      Metrics: metrics.filter((m) => m.Name === 'Requests' || m.Name === 'UpstreamErrors').map(({ Name, Unit }) => ({ Name, Unit })) },
  ]
  if (log.miss) directives.push({ Namespace: NAMESPACE, Dimensions: [['MissReason']], Metrics: [{ Name: 'Misses', Unit: 'Count' }] })
  // Security signal: one series per alert reason, so an alarm can watch it directly.
  const alert = log.hopToken === 'other' ? 'hop-token-unexpected' : undefined
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
}
