// CloudWatch Logs subscription payload → router lines. The payload is base64(gzip(JSON)); each log event's message
// is one router stdout line. EMF documents have no `kind` and are dropped by the subscription filter already.
import { gunzipSync } from 'node:zlib'
import type { ConfigLine, RouterLine } from './types.ts'

export interface LogEvent { id: string; timestamp: number; message: string }
export interface DecodedPayload {
  messageType: string
  logGroup: string
  logStream: string
  logEvents: LogEvent[]
}

export class UnsupportedSchemaError extends Error {
  constructor(v: unknown) {
    super(`router line schemaVersion ${String(v)} is not supported by this ingest build`)
    this.name = 'UnsupportedSchemaError'
  }
}

export const SUPPORTED_SCHEMA = 1
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

export function decodePayload(event: unknown): DecodedPayload {
  const data = (event as { awslogs?: { data?: unknown } } | null)?.awslogs?.data
  if (typeof data !== 'string') throw new Error('not a CloudWatch Logs subscription event (awslogs.data missing)')
  const json = gunzipSync(Buffer.from(data, 'base64'), { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8')
  const p = JSON.parse(json) as Partial<DecodedPayload>
  if (typeof p.messageType !== 'string' || !Array.isArray(p.logEvents)) throw new Error('malformed subscription payload')
  return { messageType: p.messageType, logGroup: String(p.logGroup ?? ''), logStream: String(p.logStream ?? ''), logEvents: p.logEvents }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isUsd = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const REQ_ID = /^[A-Za-z0-9-]{1,64}$/
const KINDS = new Set(['model', 'error', 'rejected'])

function validUsage(u: unknown): boolean {
  if (!isObj(u) || !isObj(u.cacheWriteTokens)) return false
  if (![u.uncachedInputTokens, u.cacheReadTokens, u.outputTokens, u.promptTokens].every(isCount)) return false
  return Object.entries(u.cacheWriteTokens).every(([k, v]) => ['5m', '1h', '30m', '12h'].includes(k) && isCount(v))
}

function validTs(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))
}

/** Returns why a request line cannot be used, or undefined when it is well-formed. */
export function lineProblem(o: Record<string, unknown>): string | undefined {
  if (!validTs(o.ts)) return 'ts'
  if (typeof o.reqId !== 'string' || !REQ_ID.test(o.reqId)) return 'reqId'
  if (typeof o.status !== 'number' || !Number.isInteger(o.status)) return 'status'
  if (o.usage !== undefined && !validUsage(o.usage)) return 'usage'
  if (o.costUsd !== undefined && (!isObj(o.costUsd) || !isUsd(o.costUsd.total))) return 'costUsd'
  if (o.costBoundUsd !== undefined && !isUsd(o.costBoundUsd)) return 'costBoundUsd'
  if (o.decision !== undefined) {
    const d = o.decision
    if (!isObj(d) || typeof d.action !== 'string' || typeof d.model !== 'string' || typeof d.policyVersion !== 'string'
      || (d.mode !== 'auto' && d.mode !== 'observe') || typeof d.point !== 'string' || typeof d.reason !== 'string') return 'decision'
  }
  if (o.switchedFrom !== undefined && (!isObj(o.switchedFrom) || typeof o.switchedFrom.model !== 'string' || !isCount(o.switchedFrom.warmTokens))) return 'switchedFrom'
  if (o.assessor !== undefined && (!isObj(o.assessor) || (o.assessor.costUsd !== undefined && !isUsd(o.assessor.costUsd)))) return 'assessor'
  if (o.principal !== undefined && (!isObj(o.principal) || !['user', 'client', 'none'].includes(String(o.principal.kind)))) return 'principal'
  return undefined
}

export interface Parsed {
  requests: RouterLine[]
  configs: ConfigLine[]
  /** counts by reason: 'json', 'kind:<k>', 'invalid:<field>' (never the line itself) */
  skipped: Record<string, number>
}

/**
 * Keeps model/error/rejected lines and config lines. An unknown `schemaVersion` throws (the event goes to the DLQ
 * and is replayed once the ingest is updated); a malformed line is skipped and counted.
 */
export function parseEvents(p: DecodedPayload): Parsed {
  const out: Parsed = { requests: [], configs: [], skipped: {} }
  const skip = (why: string): void => {
    out.skipped[why] = (out.skipped[why] ?? 0) + 1
  }
  if (p.messageType !== 'DATA_MESSAGE') return out // CONTROL_MESSAGE: CloudWatch's reachability check
  for (const ev of p.logEvents) {
    let o: unknown
    try {
      o = JSON.parse(String(ev?.message ?? '').trim())
    } catch {
      skip('json')
      continue
    }
    if (!isObj(o)) {
      skip('json')
      continue
    }
    if (o.schemaVersion !== undefined && o.schemaVersion !== SUPPORTED_SCHEMA) throw new UnsupportedSchemaError(o.schemaVersion)
    if (o.kind === 'config') {
      if (validTs(o.ts)) out.configs.push(o as unknown as ConfigLine)
      else skip('invalid:ts')
      continue
    }
    if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) {
      skip(`kind:${typeof o.kind === 'string' ? o.kind.slice(0, 20) : 'none'}`)
      continue
    }
    const why = lineProblem(o)
    if (why) {
      skip(`invalid:${why}`)
      continue
    }
    out.requests.push(o as unknown as RouterLine)
  }
  return out
}
