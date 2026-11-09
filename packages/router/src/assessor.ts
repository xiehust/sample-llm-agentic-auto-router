// Tier assessor in the router (task 11-05-codex-deepswe-eval R2). The router builds the card, owns the transport
// (the task role's SigV4 signer to bedrock-runtime, same region as the data plane) and logs each consultation.
// Core decides when to consult, bounds the call with its own deadline and applies (or only records) the opinion.
//
// Logging: core's Decision.assessment has no basis or map outcome (the assessor's `audit` can quote prompt text, so
// core drops it). The router reads only the structured audit fields (proposed tier, rule ids / fact codes, outcome
// code) into a per-request trace, through AsyncLocalStorage around engine.decide(). No text from the card, the
// model output or an error body is ever logged.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { AssessmentStatus, CardContext, Decision, Engine, EngineOptions, RequestSummary, Tier, TierAssessor } from '@auto-router/core'
import { buildCard, createAssessor, FACT_SIGNALS, type Pack, type packDirs, type TaskCard, type Transport } from '@auto-router/assessor'
import type { PriceCatalog } from '@auto-router/pricing'
import type { AssessorLog } from './account.ts'
import { createBedrockPost, type Signer } from './forward.ts'
import type { AutoRules } from './settings.ts'

/**
 * Which of the pack's mappings may act in auto mode (map.ts `autoEligible`).
 * - 'pack': the pack's own `auto` flags (v2.1 and v2.2: every rule auto:false, so auto mode changes nothing).
 * - 'all': every enabled rule and every fact signal (deep, prior-failures, multi-file-edit) is auto-eligible, so
 *   every tier mapTier proposes reaches core. Explicit experiment switch: applied to an in-memory copy of the pack;
 *   the pack files, the rendered prompt and the pack version do not change. Core's downgrade guard and its cost /
 *   count gates still apply. Facts are included because v2.1 frontier and standard mappings usually carry a fact
 *   next to the rule (e.g. deep-investigation + fact:deep), and a basis acts only when every entry is eligible.
 */
export type AssessorAutoRules = AutoRules

export interface AssessorSettings {
  mode: 'observe' | 'auto'
  model: string
  threshold: number
  packName: keyof typeof packDirs
  pack: Pack
  /** The assessor's own call deadline. Core's hard bound on the request is this plus ASSESSOR_GRACE_MS. */
  timeoutMs: number
  autoRules: AssessorAutoRules
}
export type RouterAssessorConfig = { mode: 'off' } | AssessorSettings

/**
 * Core's deadline is the assessor's plus this grace, so the assessor normally reports its own timeout (with its
 * reason code and any cost) before core gives up on it. The request is never delayed beyond timeoutMs + grace.
 */
export const ASSESSOR_GRACE_MS = 100

/** What the router learned about one consultation besides core's Assessment (structured fields only). */
export interface AssessorTrace {
  called?: boolean
  proposedTier?: Tier
  basis?: string[]
  outcome?: string
  costUsd?: number
}

export interface RouterAssessor {
  readonly id: string
  readonly packVersion: string
  readonly settings: AssessorSettings
  /** Spread into createEngine(). */
  readonly engineOptions: Pick<EngineOptions, 'assessor' | 'assessorMode' | 'assessorTimeoutMs' | 'assessorMinConfidence'>
  card(summary: RequestSummary, body: unknown, ctx: CardContext): unknown
  /** Runs `fn` (engine.decide) with a fresh trace that this request's consultation, if any, fills in. */
  traced<T>(fn: () => Promise<T>): Promise<{ value: T; trace: AssessorTrace }>
  /** The log record for a decision, or undefined when the assessor was not consulted (pins, tool turns, …). */
  logOf(decision: Decision, trace: AssessorTrace): AssessorLog | undefined
}

const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier']
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
/** Codes only: rule ids (pack-validated), `fact:*`, map outcomes, assessor reason codes. Anything else is 'other'. */
const CODE = /^[a-z0-9][a-z0-9:+_.-]{0,59}$/
const code = (v: string): string => (CODE.test(v) ? v : 'other')
const reasonCode = (reason: string): string => code(reason.split(':', 1)[0]?.trim() ?? '')

/** The assessor Transport over the router's signed bedrock-runtime POST. */
export function bedrockTransport(upstream: URL, signer: Signer, fetchImpl?: typeof fetch): Transport {
  const post = createBedrockPost(upstream, signer, fetchImpl)
  return (req) => post(req.path, req.body, req.headers, req.signal)
}

/**
 * Settings fingerprint (research 73 A4): the consultation key core uses for its per-turn reuse (memo and
 * SessionState.assessed) is `<pack id>@<model>#<fp>`, so a change of pack content, model, threshold or autoRules makes
 * the current turn consult again instead of reusing an opinion formed under other settings. Mode and timeout do not
 * change the opinion and are not part of it. Logs keep the plain `<pack id>@<model>` id.
 */
export function settingsFingerprint(packVersion: string, s: Pick<AssessorSettings, 'model' | 'threshold' | 'autoRules'>): string {
  return createHash('sha256').update(`${packVersion}|${s.model}|${s.threshold}|${s.autoRules}`).digest('hex').slice(0, 8)
}
const logId = (id: string): string => id.split('#', 1)[0] as string

export function createRouterAssessor(s: AssessorSettings, deps: { transport: Transport; catalog: PriceCatalog }): RouterAssessor {
  const als = new AsyncLocalStorage<AssessorTrace>()
  const all = s.autoRules === 'all'
  const pack: Pack = all ? { ...s.pack, rules: s.pack.rules.map((r) => ({ ...r, auto: r.enabled })) } : s.pack
  const inner = createAssessor({
    model: s.model, transport: deps.transport, catalog: deps.catalog, pack, threshold: s.threshold, timeoutMs: s.timeoutMs,
    autoFacts: all ? [...FACT_SIGNALS] : [],
    // Runs inside assess(), so inside the request's async context: priced even when the output was invalid.
    onCall: (info) => {
      const t = als.getStore()
      if (!t) return
      t.called = info.called
      if (info.costUsd !== undefined) t.costUsd = info.costUsd
      if (info.status === 'unavailable' && info.reason) t.outcome = `unavailable:${reasonCode(info.reason)}`
    },
  })
  const assessor: TierAssessor = {
    id: `${inner.id}#${settingsFingerprint(inner.packVersion, s)}`,
    async assess(card, signal) {
      const r = await inner.assess(card, signal)
      if (r.status !== 'ok') return r
      const a = r.audit
      const proposed = isTier(a.proposedTier) ? a.proposedTier : undefined
      const t = als.getStore()
      if (t) {
        if (proposed) t.proposedTier = proposed
        if (Array.isArray(a.basis)) t.basis = a.basis.filter((b): b is string => typeof b === 'string').slice(0, 8).map(code)
        if (typeof a.outcome === 'string') t.outcome = code(a.outcome)
        else if (typeof a.skipped === 'string') t.outcome = `skipped:${code(a.skipped)}`
      }
      return r
    },
  }
  return {
    id: inner.id,
    packVersion: inner.packVersion,
    settings: s,
    engineOptions: { assessor, assessorMode: s.mode, assessorTimeoutMs: s.timeoutMs + ASSESSOR_GRACE_MS, assessorMinConfidence: s.threshold },
    card: (summary, body, ctx) => inner.card(summary, body, ctx),
    traced: (fn) => {
      const trace: AssessorTrace = {}
      return als.run(trace, async () => ({ value: await fn(), trace }))
    },
    logOf: (decision, trace) => assessorLog(decision, trace, { mode: s.mode, autoRules: s.autoRules, packVersion: inner.packVersion }),
  }
}

/** Core statuses set without an assessor answer: the outcome code is the status itself. */
const CORE_STATUS: ReadonlySet<AssessmentStatus> = new Set(['timeout', 'error', 'invalid'])

/**
 * `packVersion` (research 73 A5): the exact pack content of this consultation, so the console resolves basis rule ids
 * to the rule text of that version (rule ids are shared across packs; their text is not). Also on cached records.
 */
export function assessorLog(decision: Decision, trace: AssessorTrace, s: Pick<AssessorSettings, 'mode' | 'autoRules'> & { packVersion?: string }): AssessorLog | undefined {
  const a = decision.assessment
  if (!a) return undefined
  const cached = a.cached === true
  const out: AssessorLog = { id: logId(a.assessorId), ...(s.packVersion !== undefined ? { packVersion: s.packVersion } : {}), mode: s.mode, autoRules: s.autoRules,
    status: a.status, applied: a.applied, latencyMs: a.latencyMs }
  if (a.tier !== undefined) out.tier = a.tier
  if (a.confidence !== undefined) out.confidence = a.confidence
  if (a.guard) out.guard = a.guard
  if (cached) {
    out.cached = true // reused for the same user turn: no call, no cost, no fresh trace
    return out
  }
  if (trace.proposedTier) out.proposedTier = trace.proposedTier
  if (trace.basis) out.basis = trace.basis
  const outcome = CORE_STATUS.has(a.status) ? a.status : trace.outcome
  if (outcome) out.outcome = outcome
  if (trace.called !== undefined) out.called = trace.called
  // The trace has the cost of every call (including invalid outputs); core's costUsd only that of ok results.
  const cost = trace.costUsd ?? a.costUsd
  if (cost !== undefined) out.costUsd = cost
  return out
}

/**
 * The card the router would send at a session start (or any user-text turn of a new lineage) for a raw request
 * body: core's summarize() as the router runs it, then buildCard with the CardContext core passes when the lineage
 * has no state (no current model, no compactions, root lineage). For offline tier passes over a task set.
 * `engine` is any engine (only its summarize() is used); pass the request headers the client would send
 * (x-router-session, x-router-hint) when they matter.
 */
export function requestCard(engine: Pick<Engine, 'summarize'>, dialect: RequestSummary['dialect'], body: unknown,
  headers: Record<string, string | undefined> = {}, ctx: CardContext = { compactions: 0, lineageKind: 'root' }): TaskCard {
  const summary = engine.summarize(dialect, body, headers, Date.now())
  return buildCard(summary, body, ctx)
}
