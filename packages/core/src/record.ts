// record(): usage feedback → cache state, counters, miss attribution (core design.md §7; research C M3).
import type { Policy } from './policy.ts'
import type { CacheTtl, Dialect, ModelPrice } from './pricing-types.ts'
import type {
  CacheState, Decision, MissAttribution, PrefixRecord, RecordOutcome, RecordResult, RequestSummary, SessionState, StateStore,
} from './types.ts'
import { turnKeyOf } from './assess.ts'
import { parseReason } from './reason.ts'
import { blockSetOf, entryFrom, isRecordLive, recordsOf, TTL_MS, warmTokens, writeTtlFor } from './warmth.ts'

export interface RecordContext {
  policy: Policy
  catalog: ReadonlyMap<string, ModelPrice>
  store: StateStore
}

/** Stable reason code of a decision (observe prefixes removed). */
export function reasonCode(reason: string): string {
  return parseReason(reason).code
}

export async function record(
  ctx: RecordContext,
  s: RequestSummary,
  decision: Decision,
  outcome: RecordOutcome,
  nowMs: number,
): Promise<RecordResult> {
  const { policy, catalog, store } = ctx
  const pre = await store.get(s.session.lineage)
  const state: SessionState = pre ?? { key: s.session, perModel: {}, turns: 0, switches: 0, lastSeenMs: nowMs }
  // The lineage kind is fixed when the lineage is created (rules with when.lineageKind read it). The
  // sub-agent hints count too, so a lineage whose first call was pinned or chain-locked keeps them.
  if (pre === undefined) {
    const subHint = s.hints.boundary === 'subagent-start' || s.hints.parentSession !== undefined || s.hints.agentId !== undefined
    state.kind = decision.point === 'subagent-start' || subHint ? 'subagent' : 'root'
  }
  const served = outcome.servedModel
  const code = reasonCode(decision.reason)
  const result: RecordResult = {}
  if (code === 'chain-state-missing') result.chainStateMissing = true
  const failureBound = Math.max(1, poolProfileCount(policy, s.dialect))
  // Tier assessor hook (§12): persist the consultation for this user turn, so a retry of the same turn (on any
  // engine sharing the store) reuses it. Not cache state or a counter, so failures persist it too.
  const a = decision.assessment
  if (a !== undefined) {
    state.assessed = { turnKey: turnKeyOf(s, pre), assessorId: a.assessorId, status: a.status, latencyMs: a.latencyMs }
    if (a.tier !== undefined) state.assessed.tier = a.tier
    if (a.confidence !== undefined) state.assessed.confidence = a.confidence
  }

  // 1. Failures never touch cache state or counters; 429/5xx arm failover for the next decide().
  if (outcome.status >= 400) {
    if (outcome.status === 429 || outcome.status >= 500) {
      state.lastFailure = { model: served, status: outcome.status, atMs: nowMs }
      state.failureStatus = { ...state.failureStatus, [served]: outcome.status }
      setFailures(state, { ...state.failures, [served]: nowMs }, nowMs, policy.failover.windowMs, failureBound)
      await store.put(state)
    }
    return result
  }

  // TTLs count from request start (Anthropic), so cache records are stamped with receivedAt.
  const at = s.receivedAt
  const blocks = blockSetOf(s)
  const marginMs = policy.cache.ttlSafetyMarginMs
  const minTokensOf = (m: string): number => catalog.get(m)?.cache.minTokens ?? 0
  const lastBlock = s.prefix.blockHashes[s.prefix.blockHashes.length - 1]

  // Pre-update view used for miss attribution.
  const expected = warmTokens(pre, decision.model, s, at, { marginMs, minTokens: minTokensOf(decision.model), blocks })
  const preEntry = pre?.perModel[decision.model]
  const matched = preEntry ? matchedRecord(preEntry, blocks, at, marginMs) : undefined
  const preLastPrefix = pre?.lastPrefixHash
  const servedWarm = warmTokens(pre, served, s, at, { marginMs, minTokens: minTokensOf(served), blocks })

  // 2. Counters. The served model wins over the decision (gateway fallback).
  const servedDiffers = served !== decision.model
  if (servedDiffers) result.servedDiffers = true
  const prev = state.current
  state.current = served
  if (prev !== undefined && prev !== served) {
    result.switchedFrom = { model: prev, warmTokens: warmTokens(pre, prev, s, at, { marginMs, minTokens: minTokensOf(prev), blocks }) }
  }
  // Observe projection (0d research §1.6): carried in state; an auto decision ends it (auto's current is the truth).
  if (decision.projected) state.projected = decision.projected.model
  else if (decision.mode === 'auto') delete state.projected
  if (prev !== undefined && prev !== served) {
    state.switches++
    state.lastSwitchTurn = state.turns
    // A cost-gated downgrade that was actually served (observe mode: only if the client happened to send
    // the model auto would have picked, so the counter matches the auto counterfactual).
    if (decision.action === 'switch' && code === 'downgrade' && served === (decision.wouldChoose ?? decision.model)) {
      state.costSwitches = (state.costSwitches ?? 0) + 1
    }
  }
  if (s.lastTurn === 'user-text') state.turns++
  if (decision.point === 'compaction') state.compactions = (state.compactions ?? 0) + 1
  state.calls = (state.calls ?? 0) + 1
  state.lastSeenMs = nowMs
  if (lastBlock !== undefined) state.lastPrefixHash = lastBlock
  delete state.lastFailure
  if (state.failures) {
    const rest = { ...state.failures }
    delete rest[served]
    setFailures(state, rest, nowMs, policy.failover.windowMs, failureBound)
  }
  // Gate-forced moves are not sticky: remember where the lineage came from until it recovers.
  if (code === 'gate-forced' && prev !== undefined && prev !== served) state.gateForced = { from: prev, atMs: nowMs }
  else if (code === 'gate-recover') delete state.gateForced

  // 3. Cache state for the served model: up to 4 prefix records (forks keep the parent's record).
  const price = catalog.get(served)
  const configuredTtlMs = TTL_MS[writeTtlFor(policy, served, price)]
  const old = state.perModel[served]
  const live = old ? recordsOf(old).filter((r) => isRecordLive(r, old, at, marginMs)) : []
  const inChain = (r: PrefixRecord): boolean => blocks.has(r.hash)
  // A read hits (and refreshes) the longest cached prefix of the request, so only the longest live in-chain
  // record is refreshed. Older ancestors keep their touch and age out before other branches do.
  let hit: PrefixRecord | undefined
  for (const r of live) if (inChain(r) && (hit === undefined || r.tokens > hit.tokens)) hit = r
  const refresh = (r: PrefixRecord): PrefixRecord => (r === hit ? { ...r, touchMs: Math.max(r.touchMs, at) } : r)
  const store4 = (records: PrefixRecord[], ttlMs: number): void => {
    const e = entryFrom(served, records, ttlMs)
    if (e) state.perModel[served] = e
    else delete state.perModel[served]
  }
  /** Upserts this request's last block; `keep` filters the other live records, `touch` refreshes the hit record. */
  const upsert = (tokens: number, ttlMs: number, touch: boolean, keep: (r: PrefixRecord) => boolean = () => true): void => {
    if (lastBlock === undefined) {
      // Hand-built summaries without a chain: tokens only, never warm by hash.
      state.perModel[served] = { model: served, cachedTokens: tokens, lastTouchMs: at, ttlMs } satisfies CacheState
      return
    }
    const rest = live.filter((r) => r.hash !== lastBlock && keep(r)).map((r) => (touch ? refresh(r) : r))
    rest.sort((a, b) => b.touchMs - a.touchMs) // stable: LRU last
    store4([{ hash: lastBlock, tokens, touchMs: at }, ...rest], ttlMs)
  }

  const usage = outcome.usage
  if (usage) {
    const writes = (Object.entries(usage.cacheWriteTokens) as Array<[CacheTtl, number | undefined]>).filter(([, n]) => (n ?? 0) > 0)
    const cached = usage.cacheReadTokens + writes.reduce((a, [, n]) => a + (n ?? 0), 0)
    // A confirmed miss falsifies the in-chain records larger than what was read; other branches stay.
    const missed = servedWarm > 0 && servedWarm >= minTokensOf(served) && usage.cacheReadTokens < 0.5 * servedWarm
    const notFalsified = (r: PrefixRecord): boolean => !(missed && inChain(r) && r.tokens > usage.cacheReadTokens)
    if (cached > 0) {
      // The tail of the prefix carries the shortest TTL written (1h entries must precede 5m ones).
      const ttlMs = writes.length > 0 ? Math.min(...writes.map(([t]) => TTL_MS[t])) : (old?.ttlMs ?? configuredTtlMs)
      upsert(cached, ttlMs, !missed, notFalsified)
    } else if (price?.cache.mode === 'implicit') {
      // Implicit caches do not always report: assume the whole prompt is cached, later usage corrects it.
      upsert(usage.promptTokens || s.prefix.estPromptTokens, configuredTtlMs, true)
    } else if (usage.promptTokens >= minTokensOf(served)) {
      // Nothing cached: every record on this chain is falsified; records of other branches stay.
      store4(live.filter((r) => !inChain(r)), old?.ttlMs ?? configuredTtlMs)
    }
  } else if (servedWarm > 0 && old) {
    // Usage unknown (e.g. Chat stream without include_usage): never a miss. The warm prefix was refreshed.
    const touched = live.map(refresh)
    touched.sort((a, b) => b.touchMs - a.touchMs)
    store4(touched, old.ttlMs)
  } else if (price?.cache.mode !== 'none' && s.prefix.estPromptTokens >= minTokensOf(served)) {
    // Predict-on-route: assume the full prompt was written with the configured TTL.
    upsert(s.prefix.estPromptTokens, configuredTtlMs, true)
  }

  // 3b. Expired entries of other models are dropped (record by record; the entry when none is left). The
  // current model's entry stays, because idle-expired detection reads it.
  pruneExpired(state, at)

  // 4. Miss attribution, only with real usage.
  if (usage && expected > 0 && expected >= minTokensOf(decision.model) && usage.cacheReadTokens < 0.5 * expected) {
    const miss: MissAttribution = { reason: 'unknown', expectedTokens: expected, readTokens: usage.cacheReadTokens }
    if (servedDiffers) miss.reason = 'model_changed'
    else if (preEntry && matched && at - matched.touchMs > 0.8 * preEntry.ttlMs) miss.reason = 'ttl_expired'
    else if (preLastPrefix !== undefined && !blocks.has(preLastPrefix)) {
      // The expectation came from a record on this chain, but the lineage's latest write was on another
      // branch (a fork or concurrent sibling interleaved).
      miss.reason = 'prefix_changed'
    }
    result.miss = miss
    state.lastMiss = { ...miss, atMs: nowMs }
  }

  // 5. Responses aliasing (C3): chains without session headers find their state via the response id.
  if (s.dialect === 'openai-responses' && outcome.responseId) {
    const alias: SessionState = {
      key: { ...s.session, lineage: `resp:${outcome.responseId}` },
      current: served,
      perModel: {},
      turns: state.turns,
      switches: state.switches,
      lastSeenMs: nowMs,
    }
    if (state.kind !== undefined) alias.kind = state.kind
    const e = state.perModel[served]
    if (e) alias.perModel[served] = e
    if (state.lastPrefixHash !== undefined) alias.lastPrefixHash = state.lastPrefixHash
    await store.put(alias)
  }

  await store.put(state)
  return result
}

/**
 * Removes, for every model except `state.current`, the prefix records past their TTL (`touchMs + ttlMs < nowMs`,
 * no safety margin) and the entry once no record is left. An entry without records uses `lastTouchMs`.
 */
export function pruneExpired(state: SessionState, nowMs: number): void {
  for (const [model, e] of Object.entries(state.perModel)) {
    if (model === state.current) continue
    if (e.prefixes === undefined && e.cachedPrefixHash === undefined) {
      if (e.lastTouchMs + e.ttlMs < nowMs) delete state.perModel[model]
      continue
    }
    const recs = recordsOf(e)
    const kept = recs.filter((r) => r.touchMs + e.ttlMs >= nowMs)
    if (kept.length === recs.length) continue
    const next = entryFrom(e.model, kept, e.ttlMs)
    if (next) state.perModel[model] = next
    else delete state.perModel[model]
  }
}

/** The live record on this chain with the most tokens (the one warmTokens used). */
function matchedRecord(entry: CacheState, blocks: Set<string>, nowMs: number, marginMs: number): PrefixRecord | undefined {
  let best: PrefixRecord | undefined
  for (const r of recordsOf(entry)) {
    if (blocks.has(r.hash) && isRecordLive(r, entry, nowMs, marginMs) && (best === undefined || r.tokens > best.tokens)) best = r
  }
  return best
}

/** Profiles (models + failover ids) in the dialect pool: the bound on SessionState.failures. */
function poolProfileCount(policy: Policy, dialect: Dialect): number {
  const ids = new Set<string>()
  for (const e of policy.pools[dialect]?.models ?? []) {
    ids.add(e.model)
    for (const f of e.failover ?? []) ids.add(f)
  }
  return ids.size
}

/** Keeps failures within the window, newest `bound` entries, and failureStatus for the same keys; removes empty fields. */
function setFailures(state: SessionState, failures: Record<string, number>, nowMs: number, windowMs: number, bound: number): void {
  const kept = Object.entries(failures)
    .filter(([, t]) => nowMs - t <= windowMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, bound)
  if (kept.length === 0) delete state.failures
  else state.failures = Object.fromEntries(kept)
  const statuses = kept.flatMap(([m]) => {
    const st = state.failureStatus?.[m]
    return st === undefined ? [] : [[m, st] as const]
  })
  if (statuses.length === 0) delete state.failureStatus
  else state.failureStatus = Object.fromEntries(statuses)
}
