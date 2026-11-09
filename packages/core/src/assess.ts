// Tier assessor hook (parent design.md §3, approved 2026-11-04; core design.md §12). The assessor itself lives in
// @auto-router/assessor; core decides when to consult it, bounds it with a timeout, caches its answer per
// (lineage, user turn) and turns the answer into an optional desired-tier source.
import { TIERS, type Tier } from './policy.ts'
import type { AssessedTurn, RequestSummary, SessionState, TierAssessor } from './types.ts'

export type AssessorMode = 'off' | 'observe' | 'auto'

export const ASSESSOR_DEFAULTS = { mode: 'observe', timeoutMs: 5000, minConfidence: 0.8, downgradeFrom: ['standard'] } as const

/** Most in-engine memo entries (decide-before-record races, concurrent retries); oldest evicted first. */
export const ASSESS_MEMO_MAX = 1024

/** Validated assessor settings; absent when there is no assessor or the mode is 'off'. */
export interface AssessorConfig {
  assessor: TierAssessor
  mode: 'observe' | 'auto'
  timeoutMs: number
  minConfidence: number
  /** Tiers an assessor-driven downgrade may start from (core design §12, downgrade guard). */
  downgradeFrom: ReadonlySet<Tier>
  /** `${assessorId}\0${lineage}\0${turnKey}` → the consultation (a promise, so concurrent decides share it). */
  memo: Map<string, Promise<AssessedTurn>>
}

export interface AssessorOptions {
  assessor?: TierAssessor
  assessorMode?: AssessorMode
  assessorTimeoutMs?: number
  assessorMinConfidence?: number
  /** Tiers an assessor downgrade may start from; default ['standard']. */
  assessorDowngradeFrom?: readonly Tier[]
}

/** Validates the engine's assessor options (always, even without an assessor); throws a TypeError on bad values. */
export function assessorConfig(opts: AssessorOptions): AssessorConfig | undefined {
  const issues: string[] = []
  const mode = opts.assessorMode ?? ASSESSOR_DEFAULTS.mode
  if (mode !== 'off' && mode !== 'observe' && mode !== 'auto') issues.push(`assessorMode must be 'off' | 'observe' | 'auto', got ${String(mode)}`)
  const timeoutMs = opts.assessorTimeoutMs ?? ASSESSOR_DEFAULTS.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) issues.push(`assessorTimeoutMs must be a finite number > 0, got ${String(timeoutMs)}`)
  const minConfidence = opts.assessorMinConfidence ?? ASSESSOR_DEFAULTS.minConfidence
  if (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    issues.push(`assessorMinConfidence must be a number in [0, 1], got ${String(minConfidence)}`)
  }
  const downgradeFrom = opts.assessorDowngradeFrom ?? ASSESSOR_DEFAULTS.downgradeFrom
  if (!Array.isArray(downgradeFrom) || !downgradeFrom.every((t) => (TIERS as readonly unknown[]).includes(t))) {
    issues.push(`assessorDowngradeFrom must be an array of tiers (${TIERS.join(' | ')}), got ${JSON.stringify(downgradeFrom)}`)
  }
  const a = opts.assessor
  if (a !== undefined && (typeof a !== 'object' || a === null || typeof a.id !== 'string' || a.id === '' || typeof a.assess !== 'function')) {
    issues.push('assessor must have a non-empty string id and an assess(card, signal) function')
  }
  if (issues.length > 0) throw new TypeError(`createEngine: invalid assessor options:\n  - ${issues.join('\n  - ')}`)
  if (a === undefined || mode === 'off') return undefined
  return { assessor: a, mode: mode as 'observe' | 'auto', timeoutMs, minConfidence, downgradeFrom: new Set(downgradeFrom as readonly Tier[]), memo: new Map() }
}

/**
 * Key of the user turn a request belongs to: message count + the chain hash of its last message. A retry of
 * the same request (same history) has the same key; every new user turn appends a message, so the key changes.
 * Summaries without a chain (hand-built) fall back to the recorded user-turn counter.
 */
export function turnKeyOf(s: RequestSummary, state: SessionState | undefined): string {
  const last = s.prefix.blockHashes[s.prefix.blockHashes.length - 1]
  return last === undefined ? `turns:${state?.turns ?? 0}` : `m${s.prefix.messageCount}:${last}`
}

/** The assessor's opinion, or undefined for "no opinion" (not ok, no tier, or confidence below the minimum). */
export function opinionOf(rec: AssessedTurn, minConfidence: number): { tier: Tier; confidence: number } | undefined {
  if (rec.status !== 'ok' || rec.tier === undefined || rec.confidence === undefined || rec.confidence < minConfidence) return undefined
  return { tier: rec.tier, confidence: rec.confidence }
}

type Outcome = Omit<AssessedTurn, 'turnKey' | 'assessorId'>

/**
 * Calls the assessor with an AbortSignal that fires after `timeoutMs`. Never rejects: a timeout, a throw or a
 * rejection, and a malformed result all become a status. The timer is always cleared, and a late rejection
 * after a timeout is absorbed (no unhandled rejection).
 */
export async function runAssessor(assessor: TierAssessor, card: unknown, timeoutMs: number): Promise<Outcome> {
  const t0 = Date.now()
  const elapsed = (): number => Math.max(0, Date.now() - t0)
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error(`assessor timeout after ${timeoutMs}ms`))
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })
  try {
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(assessor.assess(card, ac.signal))
    } catch {
      return { status: 'error', latencyMs: elapsed() }
    }
    const settled = pending.then((r) => ({ kind: 'result' as const, r }), () => ({ kind: 'error' as const }))
    const out = await Promise.race([settled, timedOut])
    if (out.kind === 'timeout') return { status: 'timeout', latencyMs: elapsed() }
    if (out.kind === 'error') return { status: 'error', latencyMs: elapsed() }
    return normalizeResult(out.r, elapsed())
  } finally {
    clearTimeout(timer)
  }
}

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
const latencyOf = (v: unknown, measured: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : measured)

/**
 * Untrusted AssessorResult → Outcome. Unknown tiers and bad confidences are 'invalid' (no opinion). Reading the
 * fields can throw (getters, proxies); that is 'invalid' too, so runAssessor keeps its never-rejects promise.
 */
function normalizeResult(r: unknown, measured: number): Outcome {
  try {
    return readResult(r, measured)
  } catch {
    return { status: 'invalid', latencyMs: measured }
  }
}

function readResult(r: unknown, measured: number): Outcome {
  if (typeof r !== 'object' || r === null) return { status: 'invalid', latencyMs: measured }
  const o = r as Record<string, unknown>
  const latencyMs = latencyOf(o.latencyMs, measured)
  if (o.status === 'unavailable') return { status: 'unavailable', latencyMs }
  if (o.status !== 'ok') return { status: 'invalid', latencyMs }
  const c = o.confidence
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return { status: 'invalid', latencyMs }
  const cost = typeof o.costUsd === 'number' && Number.isFinite(o.costUsd) && o.costUsd >= 0 ? { costUsd: o.costUsd } : {}
  if (o.tier === undefined) return { status: 'ok', confidence: c, latencyMs, ...cost }
  if (!isTier(o.tier)) return { status: 'invalid', confidence: c, latencyMs, ...cost }
  return { status: 'ok', tier: o.tier, confidence: c, latencyMs, ...cost }
}

/** Looks the consultation up in the memo, then in SessionState.assessed. */
export function cachedAssessment(cfg: AssessorConfig, key: string, state: SessionState | undefined, turnKey: string): Promise<AssessedTurn> | AssessedTurn | undefined {
  const m = cfg.memo.get(key)
  if (m !== undefined) return m
  const p = state?.assessed
  if (p !== undefined && p.turnKey === turnKey && p.assessorId === cfg.assessor.id) return p
  return undefined
}

export function memoKey(assessorId: string, lineage: string, turnKey: string): string {
  return `${assessorId}\u0000${lineage}\u0000${turnKey}`
}

export function remember(cfg: AssessorConfig, key: string, p: Promise<AssessedTurn>): void {
  cfg.memo.set(key, p)
  while (cfg.memo.size > ASSESS_MEMO_MAX) {
    const oldest = cfg.memo.keys().next().value
    if (oldest === undefined) break
    cfg.memo.delete(oldest)
  }
}
