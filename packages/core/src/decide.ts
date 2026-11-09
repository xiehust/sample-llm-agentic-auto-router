// decide(): decision-point classification + model choice (core design.md §6; parent §5).
import { cachedAssessment, memoKey, opinionOf, remember, runAssessor, turnKeyOf, type AssessorConfig } from './assess.ts'
import { tierWithinCap, type Cap } from './cap.ts'
import { estimateCost } from './cost.ts'
import { tierRank, TIERS, type LineageKind, type Policy, type PolicyRule, type PoolEntry, type Portability, type Tier } from './policy.ts'
import type { Dialect, ModelPrice } from './pricing-types.ts'
import { templateFamilyOf } from './summarize/index.ts'
import type { AssessedTurn, Assessment, CardContext, Decision, DecideExtras, DecisionPoint, RequestSummary, SessionState, StateStore } from './types.ts'
import { blockSetOf, isExpired, maxLiveTokens, warmTokens, writeTtlFor } from './warmth.ts'

/**
 * The caller's access cap leaves nothing to route to (design 0.16): 'access-cap' = no pool model of the dialect is
 * within the cap; 'access-cap-context' = models within the cap exist but none fits the prompt, while one above
 * the cap would. The router answers 400 with the code (never 5xx, which would trigger the gateway fallback).
 */
export class AccessCapError extends Error {
  readonly code: 'access-cap' | 'access-cap-context'
  readonly dialect: Dialect
  constructor(dialect: Dialect, code: 'access-cap' | 'access-cap-context', detail: string) {
    super(`${code} for ${dialect}: ${detail}`)
    this.name = 'AccessCapError'
    this.code = code
    this.dialect = dialect
  }
}

export class NoEligibleModelError extends Error {
  readonly dialect: Dialect
  constructor(dialect: Dialect, detail: string) {
    super(`no eligible model for ${dialect}: ${detail}`)
    this.name = 'NoEligibleModelError'
    this.dialect = dialect
  }
}

export interface DecideContext {
  policy: Policy
  catalog: ReadonlyMap<string, ModelPrice>
  store: StateStore
  /** Tier assessor hook (§12); absent = no assessor or assessorMode 'off'. */
  assessor?: AssessorConfig
}

interface Candidate { entry: PoolEntry; tier: Tier; price: ModelPrice }
type Choice = Omit<Decision, 'policyVersion' | 'mode' | 'wouldChoose'>

/** What evaluate() learned besides the choice; read by the assessor hook only. */
interface EvalMeta {
  /** The decision point admits a consultation (start point, or a user-text turn), see §12. */
  consult: boolean
  /** No hint, alias tier or rule set the desired tier (it fell through to the pool default). */
  desiredDefault: boolean
  kind: LineageKind
}
type Opinion = { tier: Tier; confidence: number }
/** sessionTier 'root': the tier taken from the root lineage (pending: the root has no served model yet). */
type Inherited = { tier: Tier; pending: boolean }

const START_POINTS: ReadonlySet<DecisionPoint> = new Set(['session-start', 'subagent-start', 'task-start'])
/**
 * Break points: a free choice of model (no switch cost assumed). Observe mode moves a held lineage only here, and
 * the observe projection takes a fresh value here (0d research §1.6, §2.4).
 */
export const BREAK_POINTS: ReadonlySet<DecisionPoint> = new Set(['session-start', 'subagent-start', 'task-start', 'compaction', 'idle-expired', 'prefix-reset'])
/** Points where a lineage keeps its model whatever the policy or cap says (I3). */
const HOLD_POINTS: ReadonlySet<DecisionPoint> = new Set(['hard-lock-tool-loop', 'hard-lock-response-chain', 'hard-lock-state', 'failover'])

export async function decide(ctx: DecideContext, s: RequestSummary, extras?: DecideExtras): Promise<Decision> {
  const { policy } = ctx
  const base = { policyVersion: policy.version, mode: policy.mode }
  const requested = s.requestedModel
  const isAlias = Object.hasOwn(policy.aliases, requested)
  const tag = `family=${templateFamilyOf(s)} est=${s.prefix.estPromptTokens}`

  // 1. Pinned (R11). A concrete model is a pin in both modes (admin console 0.3a): auto would pin it, so an observe
  // evaluation of it would describe something auto never does. The caller checks pins against the access cap.
  if (s.hints.pin) return { ...base, action: 'pin', model: s.hints.pin, point: 'pinned', reason: `pin: x-router-pin ${s.hints.pin}; ${tag}` }
  if (!isAlias) return { ...base, action: 'pin', model: requested, point: 'pinned', reason: `pin: concrete model ${requested}; ${tag}` }

  const pool = policy.pools[s.dialect]
  if (!pool || pool.models.length === 0) throw new NoEligibleModelError(s.dialect, 'no pool configured')
  const cap = extras?.cap?.maxTier !== undefined ? extras.cap : undefined

  let state = await ctx.store.get(s.session.lineage)
  let newUnderRoot = false
  if (state === undefined) {
    // Root index (optional store method): a lineage first noted under a root we had already seen is a
    // sub-agent. rootSeen is stable per (root, lineage), so a retry or a concurrent first call of the same
    // sub-agent lineage (no state yet) is classified the same way. A lineage that is its own root
    // (hand-built summaries, e.g. replay) never is, whatever arrived first.
    if (ctx.store.noteRoot) {
      const seen = await ctx.store.noteRoot(s.session.root, s.session.lineage)
      newUnderRoot = seen.rootSeen && s.session.root !== s.session.lineage
    }
    // A chain continued under another lineage (e.g. session headers added mid-chain) still has its alias.
    const alias = s.previousResponseId ? `resp:${s.previousResponseId}` : undefined
    if (alias !== undefined && alias !== s.session.lineage) {
      const a = await ctx.store.get(alias)
      if (a?.current !== undefined) state = a
    }
  }
  // Opt-in session-scoped tier (§13): only the root lineage's first served decision may consult; every other
  // auto decision under the root takes the tier of the root lineage's current model.
  let inherited: Inherited | undefined
  if (policy.sessionTier === 'root') {
    const rootLin = await ctx.store.rootLineage?.(s.session.root)
    const isRoot = rootLin === undefined || rootLin === s.session.lineage
    if (!isRoot || state?.current !== undefined) {
      const rs = isRoot ? state : await ctx.store.get(rootLin as string)
      const t = rs?.current !== undefined ? tierOfModel(ctx, pool, rs.current) : undefined
      inherited = t !== undefined ? { tier: t, pending: false } : { tier: pool.defaultTier, pending: true }
    }
  }
  const meta: EvalMeta = { consult: false, desiredDefault: false, kind: 'root' }
  let auto = evaluate(ctx, s, pool, state, tag, newUnderRoot, undefined, meta, inherited, cap)
  const card = extras?.card
  if (ctx.assessor !== undefined && typeof card === 'function' && meta.consult && meta.desiredDefault) {
    auto = await withAssessment(ctx, ctx.assessor, s, pool, state, meta.kind, card, auto, (op) => evaluate(ctx, s, pool, state, tag, newUnderRoot, op, undefined, undefined, cap))
  }
  if (policy.mode === 'auto') return { ...base, ...auto }

  // 8. Observe (aliases only: concrete models are pins): same evaluation, but serve the observe default. A lineage
  // whose model differs from the default (a config swap changed the default, or flipped auto → observe) is held on
  // it until its next break point, so a swap never moves a tool loop or a response chain (0d research I3).
  const current = state?.current
  let dflt = policy.observeDefaults?.[s.dialect] ?? auto.model
  // The cap applies to the served model too (design 0.16): a default above it serves auto's (capped) choice.
  if (cap && !tierWithinCap(cap, tierOfModel(ctx, pool, dflt))) dflt = auto.model
  // A model above the caller's cap holds only where auto holds it too (hard locks, failover retains); at a user turn
  // it moves, as auto's 'ineligible' move does.
  const hold = current !== undefined && current !== dflt && !BREAK_POINTS.has(auto.point)
    && (HOLD_POINTS.has(auto.point) || tierWithinCap(cap, tierOfModel(ctx, pool, current)))
  const prev = state?.projected ?? current
  const free = BREAK_POINTS.has(auto.point) || auto.action === 'initialize' || auto.action === 'switch'
  const projected = free || prev === undefined ? auto.model : prev
  return {
    ...base,
    ...auto,
    model: hold ? (current as string) : dflt,
    reason: `${hold ? 'observe-hold' : 'observe-default'}: ${auto.reason}`,
    wouldChoose: auto.model,
    projected: { model: projected, switch: prev !== undefined && projected !== prev },
  }
}

/** Steps 2–7: what auto mode would do. */
function evaluate(
  ctx: DecideContext,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  tag: string,
  newUnderRoot: boolean,
  opinion?: Opinion,
  meta?: EvalMeta,
  inherited?: Inherited,
  cap?: Cap,
): Choice {
  const { policy, catalog } = ctx
  const now = s.receivedAt
  const est = s.prefix.estPromptTokens
  const maxOut = s.maxOutputTokens ?? 0
  const blocks = blockSetOf(s)
  const marginMs = policy.cache.ttlSafetyMarginMs
  const fits = (p: ModelPrice): boolean => est <= p.contextWindow * policy.gate.contextHeadroom
  const fitsPhysically = (p: ModelPrice): boolean => est + maxOut <= p.contextWindow
  const warm = (model: string): number =>
    warmTokens(state, model, s, now, { marginMs, minTokens: catalog.get(model)?.cache.minTokens ?? 0, blocks })
  const costFor = (model: string, price: ModelPrice): number =>
    estimateCost(price, { warmTokens: warm(model), promptTokens: est, horizon: policy.horizon, writeTtl: writeTtlFor(policy, model, price) }).totalUsd

  // 2. Candidates: pool ∩ catalog ∩ dialect, then ∩ the caller's cap (design 0.16). A current model above the cap
  // is no candidate, so it holds through hard locks and moves at the next user turn ('ineligible') or break point.
  const all: Candidate[] = []
  for (const entry of pool.models) {
    const price = catalog.get(entry.model)
    if (price && price.dialects.includes(s.dialect)) all.push({ entry, tier: entry.tier ?? price.tier, price })
  }
  if (all.length === 0) throw new NoEligibleModelError(s.dialect, 'no pool model is in the catalog')
  const inPool = cap ? all.filter((c) => tierWithinCap(cap, c.tier)) : all
  if (inPool.length === 0) throw new AccessCapError(s.dialect, 'access-cap', `no pool model within maxTier ${cap?.maxTier}`)

  const current = state?.current
  // A failover profile counts as a member of its pool entry (same tier), so the router stays on it
  // until the next break point.
  const currentEntry = current ? inPool.find((c) => c.entry.model === current || c.entry.failover?.includes(current)) : undefined
  const currentPrice = current ? catalog.get(current) : undefined

  // Provider-specific state in the history restricts where the conversation can go (before the gate, so
  // a gate fallback never lands on a model that cannot take the history).
  const restricted = current !== undefined && s.nonPortableState.length > 0
  const rule = restricted ? strictest(s.nonPortableState, policy.portability) : undefined
  const portable = restricted
    ? inPool.filter((c) => c === currentEntry || (rule === 'same-family' && currentPrice !== undefined && c.price.family === currentPrice.family))
    : inPool

  // Context gate. With nothing inside the headroom: the current model if it physically fits, else the
  // cheapest model that physically fits (lowest tier, then input price), else the largest window.
  let eligible = portable.filter((c) => fits(c.price))
  let gateNote = ''
  let fallbackCurrent = false
  if (eligible.length === 0 && portable.length > 0) {
    const physical = portable.filter((c) => fitsPhysically(c.price))
    if (cap && physical.length === 0 && !restricted && all.some((c) => fitsPhysically(c.price))) {
      throw new AccessCapError(s.dialect, 'access-cap-context', `no model within maxTier ${cap.maxTier} fits ${est + maxOut} tokens`)
    }
    if (currentEntry !== undefined && portable.includes(currentEntry) && fitsPhysically(currentPrice ?? currentEntry.price)) {
      eligible = [currentEntry]
      gateNote = '; gate-fallback:current'
      fallbackCurrent = true
    } else if (physical.length > 0) {
      eligible = [physical.reduce((a, b) => (tierRank(b.tier) < tierRank(a.tier) || (b.tier === a.tier && b.price.price.input < a.price.price.input) ? b : a))]
      gateNote = '; gate-fallback:cheapest'
    } else {
      eligible = [portable.reduce((a, b) => (b.price.contextWindow > a.price.contextWindow ? b : a))]
      gateNote = '; gate-fallback'
    }
  }
  /** True when the gate keeps the lineage from the model it would pick for tier t without the gate. */
  const gateBlocks = (t: Tier): boolean => portable.length > 0 && !eligible.includes(pickForTier(portable, t))

  // '; access-cap:<tier>' on decisions the cap shaped (set after the hard locks; savings keep them apart, 0d §1.4).
  let capNote = ''
  const retain = (point: DecisionPoint, reason: string): Choice => ({ action: 'retain', model: current as string, point, reason: `${reason}; ${tag}${gateNote}${capNote}` })
  // Moves to candidate c's primary profile (so a failover profile is left at the next break point).
  const choose = (c: Candidate, point: DecisionPoint, reason: string): Choice => {
    const model = c.entry.model
    const action: Decision['action'] = !current ? 'initialize' : model === current ? 'retain' : 'switch'
    return { action, model, point, reason: `${reason}; ${tag}${gateNote}${capNote}` }
  }

  // 3. Failover: the model we would use failed (429/5xx) within the window.
  const fo = failover(ctx, s, state, inPool, eligible, retain)
  if (fo) return fo

  // Responses chain with no router state: the stored response's model is unknown, so lock to the
  // deterministic dialect default instead of deciding fresh (no cost evaluation).
  if (current === undefined && s.previousResponseId) {
    const c = pickForTier(eligible, pool.defaultTier)
    return choose(c, 'hard-lock-response-chain',
      `chain-state-missing: previous_response_id ${s.previousResponseId} has no router state, dialect default tier=${pool.defaultTier} → ${c.entry.model}`)
  }

  const subHint = s.hints.boundary === 'subagent-start' || s.hints.parentSession !== undefined || s.hints.agentId !== undefined
  const kind: LineageKind = state?.kind ?? ((current === undefined && newUnderRoot) || subHint ? 'subagent' : 'root')
  const desired = desiredTier(policy, pool, s, kind, opinion, inherited)
  if (meta) {
    meta.kind = kind
    meta.desiredDefault = desired.source === 'default'
  }

  if (current) {
    // 4. Hard locks: never switch.
    if (s.lastTurn === 'tool-result') return retain('hard-lock-tool-loop', 'hard-lock: tool loop')
    if (s.previousResponseId) return retain('hard-lock-response-chain', `hard-lock: previous_response_id ${s.previousResponseId}`)
    if (restricted && eligible.every((c) => c === currentEntry)) {
      return retain('hard-lock-state', `hard-lock: non-portable state ${s.nonPortableState.join(',')}`)
    }
  }
  if (cap?.maxTier !== undefined) {
    const overCap = current !== undefined && currentEntry === undefined && all.some((c) => c.entry.model === current || c.entry.failover?.includes(current))
    // '<from>' = the tier routing would have chosen without the cap: the desired tier, else (a lineage above a new cap)
    // the tier it is on. Usage ingest reads it for the cap savings row (0d §1.4).
    const from = tierRank(desired.tier) > tierRank(cap.maxTier) ? desired.tier : overCap ? tierOfModel(ctx, pool, current as string) : undefined
    // The older 2-part form when the uncapped tier is unknown (a current model outside pool and catalog tiers).
    if (from !== undefined) capNote = `; access-cap:${cap.maxTier}:${from}`
    else if (overCap) capNote = `; access-cap:${cap.maxTier}`
  }

  // 5. Free break points: full decision, no switch cost.
  const bp = breakPoint(policy, s, state, est, warm, marginMs, catalog.get(current ?? '')?.cache.minTokens ?? 0, newUnderRoot)
  if (bp) {
    if (meta) meta.consult = START_POINTS.has(bp.point) ? s.lastTurn !== 'tool-result' : s.lastTurn === 'user-text'
    const c = pickForTier(eligible, desired.tier)
    const pick = `tier=${desired.tier} via ${desired.source} → ${c.entry.model}`
    if (current !== undefined && c !== currentEntry && gateBlocks(desired.tier)) {
      return choose(c, bp.point, `gate-forced: ${bp.code}, tier=${desired.tier} via ${desired.source} blocked by the context gate, ${current} → ${c.entry.model}`)
    }
    // Only a real recovery clears gateForced: while the gate still blocks the desired tier, the lineage
    // stays forced (record() keeps the flag) and the next break point / user turn tries again.
    if (state?.gateForced && !gateBlocks(desired.tier)) return choose(c, bp.point, `gate-recover: ${bp.code}, forced from ${state.gateForced.from}, ${pick}`)
    return choose(c, bp.point, `${bp.code}: ${bp.note ? `${bp.note}, ` : ''}${pick}`)
  }
  if (!current) throw new Error('unreachable: no current model outside a break point')

  // 7. Assistant prefill: continue on the same model.
  if (s.lastTurn === 'assistant') return retain('user-turn', 'retain: prefill')
  // 6. User turn.
  const curOk = currentEntry !== undefined && currentPrice !== undefined && eligible.includes(currentEntry) && (fallbackCurrent || fits(currentPrice))
  // Under userTurn 'retain' the desired tier only matters for a forced move (!curOk) or a gate recovery (which
  // needs the gate to pass again: no gate fallback), so a plain user turn does not consult the assessor (no
  // latency or spend for an opinion that cannot act).
  if (meta) meta.consult = s.lastTurn === 'user-text' && (policy.userTurn !== 'retain' || !curOk || (state?.gateForced !== undefined && gateNote === ''))
  if (!curOk) {
    // A forced move, so go straight to the desired tier. In the pool but outside the gate ⇒ gate-forced
    // (not sticky: see gate-recover); out of the pool ⇒ ineligible.
    const c = pickForTier(eligible, desired.tier)
    const code = currentEntry !== undefined ? 'gate-forced' : 'ineligible'
    return choose(c, 'user-turn', `${code}: ${current} → ${c.entry.model} tier=${desired.tier} via ${desired.source}`)
  }
  // A gate-forced lineage returns to the desired tier as soon as that tier passes the gate again, without
  // the downgrade cost gate (the move was never a policy choice). Applies under both userTurn settings.
  // Recovery restores at most the tier the lineage was forced off: a desired tier below it (from any source:
  // assessor, hint, alias or rule) is a policy downgrade, so it waits for the usual gates (a later cost-gated
  // user turn, or the next break point under userTurn 'retain').
  if (state?.gateForced && gateNote === '') {
    const fromTier = tierOfModel(ctx, pool, state.gateForced.from)
    const held = fromTier !== undefined && tierRank(desired.tier) < tierRank(fromTier)
    const target = held ? fromTier : desired.tier
    const c = pickForTier(eligible, target)
    if (c.tier === target) {
      const note = held ? ` (desired ${desired.tier}: the downgrade waits for the usual gates)` : ''
      return choose(c, 'user-turn', `gate-recover: ${current} → ${c.entry.model}, forced from ${state.gateForced.from}, tier=${target} via ${desired.source}${note}`)
    }
  }
  if (policy.userTurn === 'retain') return retain('user-turn', 'retain: boundary-gated')

  const curRank = tierRank(currentEntry.tier)
  const wantRank = tierRank(desired.tier)
  if (wantRank === curRank) return retain('user-turn', 'retain: same-tier')

  const target = pickForTier(eligible, desired.tier)
  const targetRank = tierRank(target.tier)
  // pickForTier falls back to other tiers; only a move in the desired direction counts.
  if (target === currentEntry || (wantRank > curRank ? targetRank <= curRank : targetRank >= curRank)) {
    return retain('user-turn', wantRank > curRank ? 'retain: no-higher-tier' : 'retain: no-lower-tier')
  }
  const stayUsd = costFor(current, currentPrice)
  const switchUsd = costFor(target.entry.model, target.price)
  const estimate = { stayUsd, switchUsd, horizonCalls: policy.horizon.calls }
  const move = `${currentEntry.tier}→${target.tier} ${current} → ${target.entry.model}`

  // Upgrade: quality-driven, no cost gate.
  if (targetRank > curRank) {
    return { action: 'switch', model: target.entry.model, point: 'user-turn', reason: `upgrade:${desired.source}: ${move}; ${tag}${capNote}`, estimate }
  }

  // Downgrade: cheap gates first, then break-even with hysteresis.
  const h = policy.hysteresis
  const sinceSwitch = state!.turns - (state!.lastSwitchTurn ?? Number.NEGATIVE_INFINITY)
  const saving = stayUsd - switchUsd
  const need = Math.max(h.minUsd, (h.costRatio - 1) * switchUsd)
  const money = `saving=$${saving.toFixed(4)} need=$${need.toFixed(4)} H=${policy.horizon.calls}`
  let rejected: string | undefined
  if (sinceSwitch < h.minTurnsBeforeSwitch) rejected = `min-turns (${sinceSwitch} < ${h.minTurnsBeforeSwitch})`
  else if ((state!.costSwitches ?? 0) >= h.maxSwitchesPerLineage) rejected = `max-switches (${h.maxSwitchesPerLineage})`
  else if (!(saving > need)) rejected = 'cost'
  if (rejected !== undefined) {
    const [code, ...rest] = rejected.split(' ')
    return { action: 'retain', model: current, point: 'user-turn', reason: `downgrade-rejected:${code}: ${[...rest, move, money].join(' ')}; ${tag}${capNote}`, estimate }
  }
  return { action: 'switch', model: target.entry.model, point: 'user-turn', reason: `downgrade: ${move} ${money}; ${tag}${capNote}`, estimate }
}

/** Time of the last 429/5xx on `model` (failures map, else the legacy lastFailure). */
export function failedAt(state: SessionState | undefined, model: string): number | undefined {
  const t = state?.failures?.[model]
  if (t !== undefined) return t
  return state?.lastFailure?.model === model ? state.lastFailure.atMs : undefined
}

/**
 * Step 3. Response chain (previous_response_id): no rotation at all, retain the exact model id
 * (failover-chain-locked). Otherwise, when the failed model's own last status (failureStatus) is in
 * failover.profileRotateOn (default 429),
 * the next unfailed profile of the same model first (wrapping around the profile list). Only when every profile
 * failed within the window, or the status does not rotate profiles (5xx: global. already spans Regions), may the
 * lineage leave the model:
 * - tool loop: only with no non-portable state, to a same-tier sibling that passes the gate → failover-cross-model;
 * - otherwise: same-tier sibling (non-portable state is enforced through `eligible`), else retain.
 */
function failover(
  ctx: DecideContext,
  s: RequestSummary,
  state: SessionState | undefined,
  inPool: Candidate[],
  eligible: Candidate[],
  retain: (point: DecisionPoint, reason: string) => Choice,
): Choice | undefined {
  const { policy, catalog } = ctx
  const now = s.receivedAt
  const windowMs = policy.failover.windowMs
  const recent = (m: string): boolean => {
    const t = failedAt(state, m)
    return t !== undefined && now - t <= windowMs
  }
  const current = state?.current
  // No current model yet: the session's first call failed (lastFailure names it).
  const failed = current ?? state?.lastFailure?.model
  if (failed === undefined || !recent(failed)) return undefined
  // The failed model's own last status (failureStatus; legacy state: lastFailure when it names this model).
  const ownStatus = state?.failureStatus?.[failed] ?? (state?.lastFailure?.model === failed ? state.lastFailure.status : undefined)
  const status = ownStatus !== undefined ? ` after ${ownStatus}` : ''
  const tag = `family=${templateFamilyOf(s)} est=${s.prefix.estPromptTokens}`
  const action: Decision['action'] = current ? 'switch' : 'initialize'

  const entry = inPool.find((c) => c.entry.model === failed || c.entry.failover?.includes(failed))
  // Not a pool model (an earlier pin, a policy change): no profiles to rotate through. The regular steps
  // decide: hard locks keep it, a user turn moves it into the pool ('ineligible').
  if (!entry) return undefined
  // Response chain: no profile rotation (a stored response is not proven readable from another inference profile, e.g. global. → a geo profile) until the
  // parent's E2E check verifies cross-profile readability. Keep the exact model id.
  if (s.previousResponseId) {
    return current ? retain('failover', `failover-chain-locked: ${failed} failed${status}, previous_response_id ${s.previousResponseId} stays on the same profile`) : undefined
  }
  const profiles = [entry.entry.model, ...(entry.entry.failover ?? [])].filter((p) => catalog.get(p)?.dialects.includes(s.dialect))
  // Profile rotation only when the failed model's own status is in profileRotateOn (default 429: separate per-profile
  // quotas), never on another model's status. Legacy state without a status for it keeps rotating.
  const rotate = ownStatus === undefined || policy.failover.profileRotateOn.includes(ownStatus)
  const i = profiles.indexOf(failed)
  const order = [...profiles.slice(i + 1), ...profiles.slice(0, Math.max(i, 0))]
  const next = order.find((p) => !recent(p))
  if (next !== undefined && rotate) return { action, model: next, point: 'failover', reason: `failover: profile ${failed} → ${next}${status}; ${tag}` }

  // Every profile of the model failed within the window, or the status does not rotate profiles.
  const skipped = next !== undefined
  const all = skipped
    ? `${failed} failed (no profile rotation on ${ownStatus})`
    : `all ${profiles.length} profile(s) of ${failed} failed within ${windowMs}ms`
  const why = skipped ? `; no profile rotation on ${ownStatus}` : ''
  const sibling = eligible.find((c) => c !== entry && c.tier === entry.tier && !recent(c.entry.model))
  if (current !== undefined && s.lastTurn === 'tool-result') {
    if (s.nonPortableState.length > 0) return retain('failover', `failover: exhausted for ${failed} (hard lock: tool loop with ${s.nonPortableState.join(',')}${why})`)
    if (!sibling) return retain('failover', `failover: exhausted for ${failed} (hard lock: tool loop, no sibling${why})`)
    return { action, model: sibling.entry.model, point: 'failover', reason: `failover-cross-model: ${all} → ${sibling.entry.model} (tool loop)${status}; ${tag}` }
  }
  if (sibling) return { action, model: sibling.entry.model, point: 'failover', reason: `failover: sibling ${failed} → ${sibling.entry.model}${status}${why}; ${tag}` }
  if (current) return retain('failover', `failover: exhausted for ${failed}${skipped ? ` (no profile rotation on ${ownStatus})` : ''}`)
  return undefined
}

function breakPoint(
  policy: Policy,
  s: RequestSummary,
  state: SessionState | undefined,
  est: number,
  warm: (model: string) => number,
  marginMs: number,
  currentMinTokens: number,
  newUnderRoot: boolean,
): { point: DecisionPoint; code: string; note?: string } | undefined {
  const current = state?.current
  if (!current) {
    if (newUnderRoot) return { point: 'subagent-start', code: 'subagent-start', note: 'new lineage under seen root' }
    const sub = s.hints.boundary === 'subagent-start' || s.hints.parentSession !== undefined || s.hints.agentId !== undefined || state?.kind === 'subagent'
    return sub ? { point: 'subagent-start', code: 'subagent-start' } : { point: 'session-start', code: 'session-start' }
  }
  if (s.hints.boundary === 'compaction') return { point: 'compaction', code: 'compaction:hint' }
  if (s.hints.boundary === 'task-start') return { point: 'task-start', code: 'task-start' }
  if (s.hints.boundary === 'subagent-start') return { point: 'subagent-start', code: 'subagent-start:hint' }
  const entry = state.perModel[current]
  if (entry && isExpired(entry, s.receivedAt, marginMs)) return { point: 'idle-expired', code: 'idle-expired' }
  if (warm(current) > 0) return undefined
  if (entry && est < policy.compaction.shrinkRatio * maxLiveTokens(entry, s.receivedAt, marginMs)) return { point: 'compaction', code: 'compaction:shrink' }
  // No entry, or a prompt below the cacheable minimum: nothing was lost, so this is not a reset.
  if (!entry || est < currentMinTokens) return undefined
  return { point: 'prefix-reset', code: 'prefix-reset' }
}

/** First eligible entry with tier t; else nearest higher tier; else nearest lower tier. */
function pickForTier(cands: Candidate[], t: Tier): Candidate {
  const want = tierRank(t)
  const byRank = (r: number): Candidate | undefined => cands.find((c) => tierRank(c.tier) === r)
  for (let r = want; r <= 2; r++) {
    const c = byRank(r)
    if (c) return c
  }
  for (let r = want - 1; r >= 0; r--) {
    const c = byRank(r)
    if (c) return c
  }
  throw new Error('pickForTier: empty candidate list')
}

function desiredTier(
  policy: Policy,
  pool: NonNullable<Policy['pools'][Dialect]>,
  s: RequestSummary,
  kind: LineageKind,
  opinion?: Opinion,
  inherited?: Inherited,
): { tier: Tier; source: string } {
  // summarize() only emits valid tiers, but replay may build summaries by hand.
  if (s.hints.tier && (TIERS as readonly string[]).includes(s.hints.tier)) return { tier: s.hints.tier as Tier, source: 'hint' }
  const alias = Object.hasOwn(policy.aliases, s.requestedModel) ? policy.aliases[s.requestedModel] : undefined
  if (alias && alias !== 'default') return { tier: alias, source: 'alias' }
  const family = templateFamilyOf(s)
  const rule = policy.rules.find((r) => ruleMatches(r, s, family, kind))
  if (rule) return { tier: rule.tier, source: `rule:${rule.id}` }
  if (inherited) return { tier: inherited.tier, source: inherited.pending ? 'session-tier:pending' : 'session-tier' }
  if (opinion) return { tier: opinion.tier, source: `assessor(${opinion.confidence.toFixed(2)})` }
  return { tier: pool.defaultTier, source: 'default' }
}

function ruleMatches(r: PolicyRule, s: RequestSummary, family: string, kind: LineageKind): boolean {
  const w = r.when
  if (w.lineageKind !== undefined && w.lineageKind !== kind) return false
  if (w.requestedModel && !w.requestedModel.some((p) => (p.endsWith('*') ? s.requestedModel.startsWith(p.slice(0, -1)) : s.requestedModel === p))) return false
  if (w.agentId && (s.hints.agentId === undefined || !w.agentId.includes(s.hints.agentId))) return false
  if (w.templateFamily && !w.templateFamily.includes(family)) return false
  if (w.minPromptTokens !== undefined && s.prefix.estPromptTokens < w.minPromptTokens) return false
  if (w.maxPromptTokens !== undefined && s.prefix.estPromptTokens > w.maxPromptTokens) return false
  return true
}

/** Strictest portability among the tags; unknown tags are treated as same-model. */
function strictest(tags: string[], portability: Record<string, Portability>): Portability {
  return tags.some((t) => (portability[t] ?? 'same-model') === 'same-model') ? 'same-model' : 'same-family'
}

/**
 * §12. Consults the assessor (or reuses its answer for this lineage and user turn) and attaches the assessment.
 * 'observe' keeps the baseline choice. 'auto' re-evaluates with the opinion as the desired-tier source (after
 * hint, alias and rules, before the pool default): upgrades apply at once, downgrades go through the usual
 * cost and count gates. `applied` = the opinion changed the chosen model.
 */
async function withAssessment(
  ctx: DecideContext,
  cfg: AssessorConfig,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  kind: LineageKind,
  card: (c: CardContext) => unknown,
  baseline: Choice,
  reevaluate: (op: Opinion) => Choice,
): Promise<Choice> {
  const id = cfg.assessor.id
  const turnKey = turnKeyOf(s, state)
  const key = memoKey(id, s.session.lineage, turnKey)
  const hit = cachedAssessment(cfg, key, state, turnKey)
  let rec: AssessedTurn
  if (hit !== undefined) {
    rec = await hit
  } else {
    // consultOnce is built not to reject; the catch is a backstop, because a rejected promise in the memo would
    // fail every decide() of this turn.
    const p = consultOnce(ctx, cfg, s, pool, state, kind, card, turnKey)
      .catch((): AssessedTurn => ({ turnKey, assessorId: id, status: 'error', latencyMs: 0 }))
    remember(cfg, key, p)
    rec = await p
  }
  let op = opinionOf(rec, cfg.minConfidence)
  // Downgrade guard: an assessor downgrade may only start from a tier in assessorDowngradeFrom (the assessor
  // under-calls frontier work). "From" is the current model's tier, else the pool default at a start point. A
  // gate-forced lineage is judged from the model it was forced off (gateForced.from): the forced model's tier was
  // never a choice, so it must neither block recovery (standard forced up to frontier) nor license a downgrade
  // (frontier forced down to standard). A guarded opinion is clamped to that tier, so the lineage holds it
  // instead of drifting to the default.
  let guarded: { from: Tier; to: Tier } | undefined
  if (op !== undefined) {
    const tierOf = (m: string | undefined): Tier | undefined => (m !== undefined ? tierOfModel(ctx, pool, m) : undefined)
    const from = tierOf(state?.gateForced?.from) ?? tierOf(state?.current) ?? pool.defaultTier
    if (tierRank(op.tier) < tierRank(from) && !cfg.downgradeFrom.has(from)) {
      guarded = { from, to: op.tier }
      op = { tier: from, confidence: op.confidence }
    }
  }
  let choice = baseline
  let applied = false
  if (cfg.mode === 'auto' && op !== undefined) {
    choice = reevaluate(op)
    applied = guarded === undefined && choice.model !== baseline.model
    if (guarded) choice = { ...choice, reason: `${choice.reason}; assessor-downgrade-guarded ${guarded.from}→${guarded.to}` }
  }
  const assessment: Assessment = { assessorId: id, status: rec.status, latencyMs: rec.latencyMs, applied }
  if (guarded) assessment.guard = 'assessor-downgrade-guarded'
  if (rec.tier !== undefined) assessment.tier = rec.tier
  if (rec.confidence !== undefined) assessment.confidence = rec.confidence
  if (hit !== undefined) assessment.cached = true
  else if (rec.costUsd !== undefined) assessment.costUsd = rec.costUsd
  return { ...choice, assessment }
}

/** Builds the CardContext, calls the lazy card thunk, then the assessor. Never rejects. */
async function consultOnce(
  ctx: DecideContext,
  cfg: AssessorConfig,
  s: RequestSummary,
  pool: NonNullable<Policy['pools'][Dialect]>,
  state: SessionState | undefined,
  kind: LineageKind,
  card: (c: CardContext) => unknown,
  turnKey: string,
): Promise<AssessedTurn> {
  const assessorId = cfg.assessor.id
  const cc: CardContext = { compactions: state?.compactions ?? 0, lineageKind: kind }
  const current = state?.current
  if (current !== undefined) {
    cc.currentModel = current
    const t = tierOfModel(ctx, pool, current)
    if (t !== undefined) cc.currentTier = t
  }
  if (kind === 'subagent') {
    const t = await parentTierOf(ctx, pool, s).catch(() => undefined)
    if (t !== undefined) cc.parentTier = t
  }
  let built: unknown
  try {
    built = card(cc)
  } catch {
    return { turnKey, assessorId, status: 'error', latencyMs: 0 }
  }
  return { turnKey, assessorId, ...(await runAssessor(cfg.assessor, built, cfg.timeoutMs)) }
}

/** Pool tier of a model (a failover profile counts as its entry), else its catalog tier. */
function tierOfModel(ctx: DecideContext, pool: NonNullable<Policy['pools'][Dialect]>, model: string): Tier | undefined {
  const e = pool.models.find((m) => m.model === model || m.failover?.includes(model))
  if (e) return e.tier ?? ctx.catalog.get(e.model)?.tier ?? ctx.catalog.get(model)?.tier
  return ctx.catalog.get(model)?.tier
}

/**
 * Tier of the parent lineage's current model. The parent is the first lineage noted under the root
 * (StateStore.rootLineage, optional); nested sub-agents therefore see the root lineage, not their direct parent.
 */
async function parentTierOf(ctx: DecideContext, pool: NonNullable<Policy['pools'][Dialect]>, s: RequestSummary): Promise<Tier | undefined> {
  const parent = await ctx.store.rootLineage?.(s.session.root)
  if (parent === undefined || parent === s.session.lineage) return undefined
  const ps = await ctx.store.get(parent)
  return ps?.current === undefined ? undefined : tierOfModel(ctx, pool, ps.current)
}
