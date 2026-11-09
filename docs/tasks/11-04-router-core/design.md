# Design: @auto-router/core (router decision engine)

Implements the parent contract (`../11-04-llm-auto-router/design.md` §3) and decision table (§5).
Pure TypeScript, ESM, no runtime dependencies besides `node:crypto` (built-in) and type-only imports
from `@auto-router/pricing`. No network or file I/O. All state goes through `StateStore`.

Research anchors: B §2 P0–P9 (patterns), C §2 M1–M4/M6/M9/M11 (prefix hash, warmth model, usage
feedback, affinity keys, hysteresis, break points), A §1.2 (Claude invalidation table).

## 1. Module layout

```
packages/core/src/
  index.ts            public exports (contract §3 + Policy + validatePolicy + helpers)
  pricing-types.ts    the ONLY import site of @auto-router/pricing types (shim, see §9)
  types.ts            RequestSummary, Decision, SessionState, ... (contract §3, core-owned)
  policy.ts           Policy schema v1, defaults, validatePolicy()
  hash.ts             sha256 helpers, chained block hash
  summarize/
    index.ts          summarize(): headers → session key + hints; dispatch per dialect
    anthropic.ts      anthropic-messages extractor
    openai-chat.ts    openai-chat extractor
    openai-responses.ts
    tokens.ts         default token estimator (pluggable)
  cost.ts             cost-over-horizon model (per model, per-model warmth, long-context tier)
  warmth.ts           warmTokens(state, model, summary, now), TTL resolution
  decide.ts           decision-point classification + model choice
  record.ts           usage feedback, cache-state update, miss attribution
  assess.ts           tier assessor hook: option validation, timeout runner, turn key, opinion (§12)
  engine.ts           createEngine() wiring
  store-memory.ts     InMemoryStateStore (+ bounded root index for noteRoot)
  *.test.ts           vitest, next to sources; fixtures in src/__fixtures__/
```

## 2. Policy schema (v1, owned by core)

```ts
type Tier = 'fast' | 'standard' | 'frontier'            // order: fast < standard < frontier

interface PoolEntry {
  model: string                     // Bedrock model / inference-profile id, must exist in catalog
  tier?: Tier                       // overrides catalog tier
  failover?: string[]               // same model on other profiles (e.g. a geo profile after 'global.'), in order
}

interface Policy {
  schemaVersion: 1
  version: string                   // recorded in every Decision.policyVersion
  mode: 'observe' | 'auto'
  aliases: Record<string, Tier | 'default'>   // requested model names that mean "route me", e.g.
                                    // { auto: 'default', 'auto:fast': 'fast' }; anything else is
                                    // concrete → pinned in auto mode (R11)
  pools: Partial<Record<Dialect, { defaultTier: Tier; models: PoolEntry[] }>>
  rules: Array<{                    // first match wins → desired tier
    id: string
    when: {
      requestedModel?: string[]     // exact, or prefix with trailing '*'
      agentId?: string[]            // x-router-agent-id hint
      templateFamily?: string[]     // templateFamilyOf(summary) (12-hex id, logged on every decision)
      minPromptTokens?: number
      maxPromptTokens?: number
      lineageKind?: 'root' | 'subagent'   // SessionState.kind, or the current decision point for a new lineage
    }
    tier: Tier
  }>
  gate: { contextHeadroom: number } // eligible iff estPromptTokens <= contextWindow * headroom (0.9)
  cache: {
    ttlSafetyMarginMs: number       // treat entry as cold this long before TTL end (15000)
    writeTtl?: Record<string, CacheTtl>   // per model; default = catalog cache.defaultTtl
  }
  hysteresis: {
    costRatio: number               // k: switch iff stay − switch > max(minUsd, (k−1)·switch)   (1.2)
    minUsd: number                  // absolute floor on expected saving                         (0.02)
    minTurnsBeforeSwitch: number    // user turns since last switch                              (2)
    maxSwitchesPerLineage: number   // cost-driven switches only                                 (6)
  }
  horizon: { calls: number; appendTokensPerCall: number; outputTokensPerCall: number }  // 15, 1000, 250
  compaction: { shrinkRatio: number }   // prompt < ratio × last cached tokens ⇒ compaction (0.6)
  portability: Record<string, 'same-model' | 'same-family'>
                                    // per nonPortableState tag; defaults:
                                    // anthropic-thinking-signature: same-family,
                                    // openai-encrypted-reasoning: same-model,
                                    // kimi-reasoning-content: same-family
  failover: { windowMs: number;     // a failed call this recent ⇒ next decide() is a failover (10000)
              profileRotateOn: number[] } // statuses that rotate profiles first ([429]; ⊆ RETRYABLE_STATUS, [] = never)
  userTurn: 'cost-gated' | 'retain' // 'cost-gated' (default): §6 step 6. 'retain': user turns never
                                    // switch (reason 'retain: boundary-gated'); break points, failover,
                                    // hard locks and pins are unchanged
  observeDefaults?: Partial<Record<Dialect, string>>  // model served for alias requests in observe mode
}
```

Defaults when omitted: `schemaVersion` 1, `mode` 'observe' (record-only before auto, R9), `userTurn`
'cost-gated', `aliases` `{ auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard',
'auto:frontier': 'frontier' }` (an explicit `aliases` object replaces them), `rules` [], portability as listed.

**Presets** (`policyPresets` in `src/presets.ts`, exported). Both use mode 'auto', the default aliases and
default numbers, and these pools (tiers explicit for OpenAI):
- 'anthropic-messages': defaultTier standard; `global.anthropic.claude-opus-5-5`,
  `global.anthropic.claude-sonnet-5-5`, `global.anthropic.claude-haiku-5-5` (catalog tiers).
- 'openai-chat' and 'openai-responses': defaultTier standard; `global.openai.gpt-6-astra` (frontier),
  `global.openai.gpt-6.1-sol` (standard), `global.openai.gpt-6-luna` (fast).

| Preset | version | userTurn | rules |
|---|---|---|---|
| `boundaryGated` | `preset-boundary-gated-v1` | 'retain' | none |
| `costModeled` | `preset-cost-modeled-v1` | 'cost-gated' | none |
| `costModeledSubagentFast` (opt-in) | `preset-cost-modeled-subagent-fast-v1` | 'cost-gated' | `subagent-fast`: `when.lineageKind: 'subagent'` → fast |

`costModeledSubagentFast` exercises the cost gate: sub-agent lineages start on the fast tier, root lineages keep
the pool default (standard). Caveat for transparent mode: a tools change opens a new lineage under the same
root, which the root index reads as a sub-agent (§6 step 5), so that lineage would desire fast too.

`validatePolicy(input: unknown): Policy` is hand-written (no zod). It fills defaults, rejects unknown
`schemaVersion`, checks numeric ranges, tier names, `when.lineageKind`, unknown `when` keys (an ignored condition
would make the rule match every call), and duplicate rule ids, and reports every error at once
(`PolicyError.issues: string[]`). `createEngine` also checks that every pool model exists in the
catalog and supports that dialect (`dialects` includes it), and that every `cache.writeTtl` entry for a
catalog model names a TTL the model offers (`cache.ttls`); otherwise costOf would price the default TTL
while warmth assumed the configured one. Otherwise it throws.

## 3. summarize(dialect, body, headers, nowMs) → RequestSummary

Headers are lower-cased once (values trimmed; `string[]` values from raw Node headers are joined with
`, `, other non-string values are dropped). The function never throws on odd bodies or headers. Missing
fields fall back to empty values.

### 3.1 Prefix hash chain (M1)
- `toolsHash` = H(dialect, JSON(tools)); `systemHash` = H(toolsHash, JSON(system)). For Chat and
  Responses, `system` means the leading system/developer messages or `instructions`.
- Cache-relevant params are hashed **between system and the first message**:
  `paramsHash` = H(systemHash, JSON(params)). Params by dialect:
  - Anthropic: `tool_choice`, `thinking`, `output_config`.
  - Chat Completions: `tool_choice`, `parallel_tool_calls`, `response_format`, `reasoning_effort`.
  - Responses: `tool_choice`, `parallel_tool_calls`, `text`, `reasoning`.

  Per A §1.2 these invalidate the messages layer. Placing them before the messages makes a change
  register as a prefix reset in the same lineage. (An earlier draft folded them into the seed of
  `toolsHash`; that also changed the template family and therefore the lineage, so toggling thinking
  looked like a new sub-agent and lost the session state.)
- `blockHashes[i]` = H(prev, JSON(message_i)) for each remaining message/input item, chained from
  `paramsHash`. Block 0 = toolsHash and block 1 = systemHash are included at the front (paramsHash is
  not), so `blockHashes.length = messages + 2`.
- Canonicalisation = `JSON.stringify` of the parsed value, in insertion order. This deviates on
  purpose from "sorted keys": the provider caches bytes, so a client that reorders keys really does
  miss, and sorting would hide that cache breaker. It is also cheaper.
- **Breakpoint markers are removed before hashing** (tools, system and every block): Anthropic
  `cache_control` and the Bedrock GPT/Kimi `prompt_cache_breakpoint` content-part field. They are
  request metadata, not prompt content, and clients move them every turn (Claude Code marks only the
  newest message), so keeping them would break the chain on every request and turn each user turn into
  a free `prefix-reset`. Only blocks whose JSON contains a marker key pay a second, replacer-based
  stringify (check review 2026-11-04).
- Hashes are truncated to 16 hex chars (64 bits) in the summary.

### 3.2 Session key and lineage (R7, M4)
- `sessionId` = first present of:
  - `x-router-session` (source `cooperative`)
  - `x-claude-code-session-id` (source `header`)
  - `x-session-id` (source `header`)
  - body `prompt_cache_key` on OpenAI dialects (source `header`)
  - otherwise the fingerprint `H(x-router-tenant ?? '', toolsHash, systemHash, first user message)` (source `fingerprint`)
- `root` = `x-router-parent-session` ?? sessionId.
- `lineage`:
  - with an `x-router-agent-id` hint: `${sessionId}/a:${agentId}`;
  - otherwise: `${sessionId}/t:${templateFamily}`, where templateFamily = H(toolsHash, systemHash) truncated to 12 hex chars.

  Consequences:
  - A Claude Code sub-agent shares the session header but has its own system prompt, so it gets a
    separate lineage.
  - A fork has identical tools and system, so it shares the parent's lineage. That is intended:
    forks reuse the parent cache and must stay on the same model.
- Responses without session headers but with `previous_response_id` use lineage
  `resp:${previous_response_id}`. `record` writes an alias state under `resp:${responseId}` (needs
  contract addition C3, §8), so chains survive without client headers.

### 3.3 Turn kind, locks, hints
- `lastTurn`:
  - Anthropic: last message role user containing any `tool_result` block → `tool-result`; otherwise
    `user-text`; assistant (prefill) → `assistant`.
  - Chat: role `tool`/`function` → `tool-result`; `user` → `user-text`; `assistant` → `assistant`;
    else `other`.
  - Responses: string input → `user-text`; last item `*_call_output` → `tool-result`; user message
    → `user-text`; else `other`.
- `previousResponseId` = body `previous_response_id`.
- `nonPortableState` tags:
  - `anthropic-thinking-signature`: assistant `thinking` with `signature`, or `redacted_thinking`.
  - `openai-encrypted-reasoning`: a `reasoning` item with `encrypted_content`.
  - `kimi-reasoning-content`: a Chat assistant message with `reasoning_content`.
- `hints` come from headers: `x-router-pin`, `x-router-tier`, `x-router-boundary`
  (`compaction|subagent-start|task-start`), `x-router-parent-session`, `x-router-agent-id`.
  Invalid values are dropped. `x-claude-code-parent-agent-id` also sets `hints.parentSession` when
  `x-router-parent-session` is absent. It is a hint only: `root` is still `x-router-parent-session ?? sessionId`.
- `maxOutputTokens` (optional): Anthropic `max_tokens`; Chat `max_completion_tokens ?? max_tokens`; Responses
  `max_output_tokens`. Only finite numbers ≥ 0 count; otherwise the field is absent (the gate reads it as 0).
- `estPromptTokens` comes from the pluggable estimator. The default is ceil(chars/4) over the
  serialized blocks; base64 image/document sources count as 1,600 tokens each, not by length.
  Option: `createEngine({ estimateTokens })` (additive, C1).
- Performance: one pass per message (stringify + hash). Target < 10 ms p50 on a 1 MB body; there is a test for it.

## 4. Warmth and cache state (M2, M3)

- `CacheState` is kept per (lineage, modelId). Model ids are inference-profile ids, so the endpoint
  dimension is part of the key (`global.` and a geo profile such as `<geo>.` are separate cache domains).
- **Prefix records (follow-up item 4).** `CacheState.prefixes` holds up to 4 records `{hash, tokens,
  touchMs}`, most recently touched first. A fork (Claude Code compaction or prompt-suggestion fork: same
  system/tools, the parent's history plus one message) shares the parent's lineage. Its record must not
  overwrite the parent's, or the parent's next turn would look like a `prefix-reset`. Compat fields:
  `cachedPrefixHash`/`cachedTokens` mirror `prefixes[0]`, and `lastTouchMs` is the latest touch over all
  records. An entry without `prefixes` (old state, replay fixtures) is read as one record built from the
  compat fields.
- `warmTokens(state, m, summary, now)` = the largest `tokens` over records whose `hash` is in the request's
  block set and that are live, capped at `estPromptTokens`. A record is live while
  `now ≤ touchMs + ttlMs − margin`, using its own touch and the entry's TTL. The result is 0 when
  `estPromptTokens < minTokens(m)`. Membership uses a Set built once per decide. Fragmentation falls out of
  this: a model visited earlier and still within TTL has its old prefix warm, so only the part appended
  since then is cold.
- `idle-expired` uses `lastTouchMs`, so it fires only when every record has expired. A single branch that
  went cold on its own (other records live) is a `prefix-reset`. The compaction shrink test compares
  against the largest live record.
- TTL: `ttlMs` (per entry) comes from the TTLs actually written. If the usage carries no TTL split, it comes
  from `policy.cache.writeTtl[m]`, then the catalog `defaultTtl`. Implicit-cache models (mode
  `implicit`) are assumed warm for the full prompt after a successful call (predict-on-route),
  then corrected by later usage.

## 5. Cost model over horizon H (P3, parent §5)

For model m with warm tokens `W` and prompt `P` (H = `policy.horizon.calls`, D = append + output per call):

```
call 0:      read W, write P − W, output O
call i ≥ 1:  prompt_i = P + i·D; read prompt_{i−1}, write D, output O    (in-turn gaps ≪ TTL)
cost_i      = read·r(m, prompt_i) + write·w(m, prompt_i) + O·out(m, prompt_i)
```

- **Pricing goes through `costOf` (parent decision 2026-11-04).** Each horizon call becomes a
  hypothetical `NormalizedUsage` (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens[ttl]`,
  `outputTokens`, `promptTokens = prompt_i`), and `@auto-router/pricing` `costOf(usage, price)` prices
  it. Core keeps no per-token price arithmetic. The long-context tier, the TTL write price and
  `cache.mode` are all costOf's job.
- Core does decide how the tokens split before pricing:
  - Cache mode `none`, or `prompt_i < cache.minTokens`: everything goes to `uncachedInputTokens`.
  - Implicit-only models: writes go to `uncachedInputTokens`, since they carry no write premium.
- `cost(m, H) = Σ costOf(usage_i).total` is a simple loop, which is fine for H ≤ 200.
- Check: Opus 5.5 → Sonnet 5.5 at 50K (global prices from A §2) breaks even at ≈ 11 calls, which
  reproduces the parent §1 table. That case is a unit test.

### 5.1 Gate calibration investigation (follow-up item 8, 2026-11-04)

Replay sweep (B), standard→fast with a 1h Claude TTL: the turns where core-cost blocked a hinted downgrade
cost $50.9 under core against $42.7 under hint-blind. Candidates: (a) H=15 too short, (b) pessimistic
pricing, (c) hysteresis.

**Representative case from the cost function** (Sonnet 5.5 → Haiku 5.5, global prices; stay warm except a
2K append, target cold; D = 1000 + 250):

| P, TTL | H | stay $ | switch $ | saving $ | need $ (max(minUsd, 0.2·switch)) | verdict |
|---|---|---|---|---|---|---|
| 150K, 1h | 7 | 0.1622 | 0.2078 | −0.0456 | 0.0416 | reject |
| 150K, 1h | 15 | 0.3517 | 0.2876 | 0.0641 | 0.0575 | pass (by 0.0066) |
| 150K, 1h | 30 | 0.7285 | 0.4479 | 0.2807 | 0.0896 | pass |
| 150K, 5m | 15 | 0.3224 | 0.2248 | 0.0977 | 0.0450 | pass |
| 188K, 1h | 15 | 0.4087 | 0.3522 | 0.0565 | 0.0704 | reject (margin) |
| 188K, 1h | 30 | 0.8426 | 0.5410 | 0.3016 | 0.1082 | pass |

Break-even H at 150K: raw 8 (5m) / 11 (1h); with k=1.2 and minUsd 10 / 15. Haiku's first call at 150K and
1h is 150K × $1.00/M (long-tier 1h write) + 250 × $2.50/M = $0.1506.

**(b) Pricing:** no bug found.
- The cold write uses `writeTtlFor(dest)`: 1h only because the sweep sets `cache.writeTtl` to 1h for every
  Claude id, and the simulator then writes 1h too. With 5m configured, it is priced at 5m.
- Above 100K, `costOf` re-prices the whole request, read portion included. That is the Bedrock rule and the
  pricing contract, and both the simulator and core use it.
- The stay side goes through the same `estimateCost`, so it is priced the same way.

**Breakdown of blocked downgrades on the replay trace** (400 sessions, seed 2026, 8% sub-agents, 30%
alt-turn share, 1h; a scratch script runs replay's own synth + simulator against this core):

| Variant | core $ | hint-blind $ | blocked: min-turns / max-switches / cost |
|---|---|---|---|
| defaults (H=15, k=1.2, minUsd 0.02, minTurns 2, maxSwitches 6) | 528.06 | 522.11 | 69 / 43 / 32 |
| minTurnsBeforeSwitch 0 | 523.35 | 522.11 | 0 / 52 / 28 |
| maxSwitchesPerLineage 1000 | 526.06 | 522.11 | 72 / 0 / 38 |
| both count gates off | **520.53** | 522.11 | 0 / 0 / 34 |
| k=1, minUsd 0 (count gates on) | 530.09 | 522.11 | 72 / 53 / 0 |
| both count gates off, H=40 | 522.11 | 522.11 | 0 / 0 / 0 (allows everything = hint-blind) |
| 5m TTL, defaults | 571.11 | 570.95 | 54 / 7 / 0 |

Remaining calls in the lineage at a downgrade request: p25/p50/p75 = 17/47/107.

**Conclusion: (c), specifically the count-based anti-flap gates, not the price margin and not H.**
- 78% of the blocks come from `minTurnsBeforeSwitch` and `maxSwitchesPerLineage`. Alternating hints
  (fast for one turn, then back to standard) trip both gates.
- With both gates off, the cost gate alone beats hint-blind by $1.58 at H=15: its 34 cost rejections are
  correct.
- Removing the k/minUsd margin makes things worse ($530.09).
- A longer H makes things worse too (H=40 allows every switch, so cost equals hint-blind). (a) is ruled out,
  and no adaptive horizon was added.

No defaults changed (synthetic data). Candidate follow-ups for the parent:
- exempt hint-sourced downgrades (`desired.source === 'hint'`) from the two count gates, keeping the cost
  gate;
- or count only real flaps (A→B→A within TTL) instead of all switches.

## 6. decide(summary) → Decision

Steps, in order. The first match returns.

1. **Pinned**: `hints.pin`, or (auto mode and `requestedModel` ∉ aliases).
   - Return `action: 'pin'`, `model: pin ?? requestedModel`, `point: 'pinned'`.
   - In observe mode a concrete `requestedModel` is not pinned. It is evaluated (step 8).
2. Load `state = store.get(lineage)`. If there is none:
   - call `store.noteRoot?.(root, lineage)` once. `newUnderRoot = rootSeen && root ≠ lineage` (a lineage that
     is its own root, as in replay's hand-built main lineages, is never a sub-agent). The store's answer is
     stable per (root, lineage): `rootSeen` means the root already had another lineage when this lineage was
     *first* noted. "No state" also covers a retry after an unrecorded first call (4xx) and concurrent first
     calls of one sub-agent lineage, so these must not flip to `session-start` (check review round 2; the
     earlier `&& !lineageSeen` term did exactly that). `InMemoryStateStore` keeps a root's first lineage until
     the root is evicted, and `put()` refreshes the root's recency;
   - with `previousResponseId` and a lineage other than `resp:<id>`, read the alias `resp:<id>`. If it has a
     current model, it stands in as the state (the chain stays locked to that model).

   Build eligible candidates:
   - pool[dialect] ∩ catalog;
   - if `nonPortableState` is non-empty and `state.current` is set, restrict to `same-model` or
     `same-family` (family from the catalog). This now happens before the gate, so a gate fallback never
     lands on a model that cannot take the history;
   - context gate (`est ≤ contextWindow·headroom`).

   **Gate fallback (follow-up item 5).** If no candidate passes the headroom:
   1. the current model, if it physically fits (`est + maxOutputTokens ≤ contextWindow`) → note `gate-fallback:current`;
   2. else the cheapest pool model that physically fits (lowest tier, then lowest input price) →
      `gate-fallback:cheapest`. A higher tier is never picked just because the gate failed;
   3. else the largest context window → `gate-fallback`.

   The note is appended to every reason. An empty pool for the dialect throws `NoEligibleModelError`.

   Replay repro: at 909,981 tokens both 1M models fail the 0.9 headroom. The old fallback (largest window)
   picked Opus, and the forced user-turn move made the lineage switch Sonnet→Opus 35 times. Now the lineage
   stays on Sonnet (`gate-fallback:current`).
3. **Failover (follow-up item 1).** It triggers when the model we would use failed (429/5xx) within
   `failover.windowMs`. That model is `state.current`, or the `lastFailure` model when the session's first
   call failed. Failures are tracked per profile in `state.failures` (time) and `state.failureStatus` (status);
   legacy `lastFailure` is read as a fallback. The reason's `after S` is the failed model's own status.
   - **Response chain (2026-11-04, item C):** with `previousResponseId` there is no profile rotation at all (no
     `global.`→`<geo>.` move), because cross-profile readability of a stored response is unproven. Retain the exact
     model id: `point: 'failover'`, reason `failover-chain-locked: X failed after S, previous_response_id … stays
     on the same profile`. With no current model, failover returns nothing and step 3b (chain-state-missing)
     locks to the dialect default. This holds until the parent's E2E check verifies cross-profile readability.
   - **Profile rotation only on `failover.profileRotateOn` (2026-11-05, default `[429]`):** global and geo
     profiles have separate quotas, so a throttle may clear on another profile; a 5xx / connection failure on
     `global.` (already routed across Regions) is very likely shared by the geo profile. The status is the failed
     model's own last status, `failureStatus[X]` (2026-11-05 review M1: never another model's, e.g. a sibling that
     failed after the lineage left X; legacy state falls back to `lastFailure` when it names X, and rotates when no
     status is known). `profileRotateOn` must be a subset of core's exported `RETRYABLE_STATUS`
     (429, 500, 502, 503, 504), the same set the router's in-request retry uses. If it is in the list: move to the next
     profile of the same pool entry that has not failed within the window. The profile list is primary then
     `failover`, starting after the failed one and wrapping around. `point: 'failover'`, reason
     `failover: profile …`. Otherwise skip rotation and apply the next bullet as if every profile had failed;
     the reason adds `no profile rotation on <status>`.
   - A failed model that is not in the pool (an earlier pin, a policy change) has no profiles: failover does
     not apply and the regular steps decide (hard locks keep it; a user turn moves it, `ineligible`).
   - Only when **every** profile of the model failed within the window (or rotation was skipped) may the lineage leave the model:
     - tool loop (`lastTurn === 'tool-result'`): only if `nonPortableState` is empty, and only to a same-tier
       sibling in the dialect pool that passes the gate and has not failed recently. Reason `failover-cross-model:
       all N profile(s) of X failed within W ms → Y (tool loop)`. Otherwise retain with `failover: exhausted …
       (hard lock: tool loop, no sibling | with <tags>)`;
     - otherwise: a same-tier sibling (`failover: sibling …`; non-portable state is enforced through the
       eligible set), else retain (`failover: exhausted …`).
   - Stay there until the next break point, because `state.current` follows the served model.
3b. **Response chain without state (follow-up item 3).** `previousResponseId` with no state (neither the
   lineage nor the `resp:` alias): lock to `pickForTier(pool.defaultTier)` over the gated candidates, with
   no cost evaluation and no rules or hints. Action `initialize`, point `hard-lock-response-chain`, reason
   `chain-state-missing: …`. Observe mode follows the usual rules (step 8).
4. **Hard locks** (only if `state.current` is set; retain current):
   - `lastTurn === 'tool-result'` → `hard-lock-tool-loop`.
   - `previousResponseId` → `hard-lock-response-chain`.
   - the state restriction leaves only the current model → `hard-lock-state`.
5. **Free break points** (full decision, no switch cost):

   | Condition | Point |
   |---|---|
   | no state, new lineage under a seen root (noteRoot) | `subagent-start` (reason `subagent-start: new lineage under seen root, …`) |
   | no state, with a subagent-start hint, parent-session hint or agent-id hint, or `state.kind === 'subagent'` (failure-created state) | `subagent-start` |
   | no state, otherwise | `session-start` |
   | boundary hint `compaction` | `compaction` |
   | boundary hint `task-start` | `task-start` (C2; otherwise `session-start` with reason `task-start`) |
   | current model's entry expired: idle > TTL − margin | `idle-expired` |
   | warm(current) = 0, state exists, est < shrinkRatio × cachedTokens(current) | `compaction` |
   | warm(current) = 0, state exists, prompt not shrunk (tools/system/params changed) | `prefix-reset` (C2; otherwise `compaction` with reason `prefix-reset`) |

   Not a break point: warm(current) = 0 because there is no cache entry for current, or because the
   prompt is below the model's `minTokens` (nothing was cached, so nothing was lost). In transparent
   mode a tools/system change produces a new template family and therefore a new lineage. With the root
   index that lineage is a `subagent-start` (without `noteRoot`, a `session-start`). `prefix-reset` for tools
   changes needs a stable lineage (`x-router-agent-id`).

   Model = `pickForTier(desiredTier)`. Action is `initialize` when there was no current model,
   otherwise `switch` or `retain`. Gate codes (follow-up item 5):
   - the move leaves the current model, and the gate excludes the model the desired tier would get
     without the gate → reason code `gate-forced` (text names the break point);
   - else, if `state.gateForced` is set and the gate no longer blocks the desired tier → `gate-recover` (text
     names the break point and `forced from`). While the desired tier is still blocked the break point keeps
     its own code and `gateForced` stays set.
5b. **Lineage kind (follow-up items 6, 7).** `kind = state.kind`, else (new lineage) `'subagent'` iff this is
   a subagent-start point (noteRoot new-lineage-under-seen-root, subagent-start hint, `parentSession` or
   `agentId` hint), else `'root'`. Rules with `when.lineageKind` match it. The derivation never relies on
   `root === lineage` alone; summarize() lineages are `${sessionId}/t:${family}`. `record` persists `kind`
   when it creates the state (success or failure path): `'subagent'` iff `decision.point === 'subagent-start'`
   or the summary carries a sub-agent hint (so a lineage whose first call was pinned or chain-locked keeps it).
6. **User turn** (`state.current` set and `lastTurn` is `user-text` or `other`):
   - Forced move first: if the current model has dropped out of the pool (`ineligible`) or fails the gate
     (`gate-forced`, unless it is the `gate-fallback:current` choice), switch to `pickForTier(desired)`. This
     applies under both `userTurn` settings, because staying would fail the request.
   - **gate-recover**: if `state.gateForced` is set, the gate passed normally (no fallback note), and
     `pickForTier(desired)` has the desired tier, move there with reason `gate-recover`, without the
     downgrade cost gate. This also applies under `userTurn: 'retain'`, because the forced move was never a
     policy choice. Hard locks and failover come first. The user-turn recovery restores at most the tier of
     `gateForced.from` (2026-11-05 follow-up): a desired tier below it, from any source (assessor, hint, alias,
     rule), is a policy downgrade, so the lineage recovers to the `from` tier (reason suffix `(desired <tier>:
     the downgrade waits for the usual gates)`). The downgrade is then decided by a later user turn through the
     cost and count gates, or, under `userTurn: 'retain'` (user turns never downgrade), at the next break point.
     Break points are full decisions anyway, so their gate-recover goes straight to the desired tier.
   - `policy.userTurn === 'retain'`: return `retain` with reason `retain: boundary-gated`.
   - `desired = tierOf(hints.tier ?? alias tier ?? first matching rule ?? pool.defaultTier)`.
   - **Upgrade** (desired > tier(current)): switch now to `pickForTier(desired)`. The decision is
     quality-driven, so no cost gate applies. Reason `upgrade:<source>`.
   - **Downgrade** (desired < tier(current)): candidate = `pickForTier(desired)`, then
     `stay = cost(current,H)` and `sw = cost(candidate,H)`. Switch iff all of these hold:
     - `stay − sw > max(minUsd, (k−1)·sw)`
     - `turns − lastSwitchTurn ≥ minTurnsBeforeSwitch`
     - `costSwitches < maxSwitchesPerLineage`

     Otherwise retain with reason `downgrade-rejected:<which gate>`. `estimate` is always filled.
   - **Same tier**: retain (`retain: same-tier`). A tier fallback in `pickForTier` that does not move
     in the desired direction also retains (`retain: no-higher-tier` / `retain: no-lower-tier`).
7. `lastTurn === 'assistant'` (prefill) with state: retain (`user-turn`, reason `retain: prefill`).
8. **Observe mode**: compute steps 2–7 exactly as auto would, using the real state. Then return
   `wouldChoose = chosen`, keeping auto's action and point. The served `model`:
   - a concrete `requestedModel` is served as is;
   - if `requestedModel` is an alias (`auto`, `auto:fast`, …), serve
     `policy.observeDefaults[dialect]` (required for every pooled dialect when mode is observe), and
     prefix the reason with `observe-default:`. Because `state.current` follows the served model, cost estimates reflect reality. This is
   a one-step counterfactual; multi-step counterfactuals are replay's job.

`pickForTier(t)`: the first eligible pool entry with tier t; otherwise the nearest higher tier,
then the nearest lower tier. Reasons always have the form `<code>: <text>`. The code is
stable for metrics. The text includes the template family and est tokens.

## 7. record(summary, decision, outcome)

1. `state = get(lineage) ?? new` (a new state gets `kind`, §6 5b). `RecordResult.chainStateMissing = true` when
   the decision's reason code (after an `observe-default: ` prefix) is `chain-state-missing`. Status ≥ 400:
   - 429 or 5xx: set `lastFailure = {model: servedModel, status, atMs}`, `failures[servedModel] = atMs` and
     `failureStatus[servedModel] = status`. `failures` is pruned to `failover.windowMs` and bounded by the number
     of profiles in the dialect pool (newest kept); `failureStatus` keeps the same keys; empty fields are removed.
   - Any failure: do not touch cache state or counters. Return.
2. Success:
   - `prev = state.current`; `state.current = servedModel`.
   - If `servedModel ≠ decision.model`, the gateway fell back. Accept it and set reason flag `served-differs`.
   - If `prev && prev ≠ servedModel`: `switches++`, `lastSwitchTurn = turns`, and `costSwitches++`
     when the decision was a cost-gated downgrade (reason code `downgrade`) and the served model is the one auto
     chose (`wouldChoose ?? model`; in observe mode only a client move onto that model counts).
   - On `lastTurn === 'user-text'`: `turns++`. Always: `calls++`, `lastSeenMs = now`,
     `lastPrefixHash = last block`, `lastFailure = undefined`, `failures[servedModel]` and
     `failureStatus[servedModel]` removed (and the rest pruned).
   - Reason code `gate-forced` and an actual move (`prev ≠ served`): `gateForced = {from: prev, atMs}`.
     Reason code `gate-recover`: `gateForced` removed.
   - `decision.point === 'compaction'`: `compactions++` (CardContext, §12).
   - `decision.assessment` present (success **and** failure paths, before the status check; it is neither cache
     state nor a counter): `assessed = { turnKey: turnKeyOf(summary, pre), assessorId, status, tier?, confidence?,
     latencyMs }` (§12). It is persisted wherever the state is put: on success and on 429/5xx. A 4xx writes
     nothing (unchanged), so only the in-engine memo covers a retry of a 4xx turn.
3. Cache state for `servedModel`, from usage, as prefix records (§4). `live` = the old entry's live records.
   `hit` = the longest live record on this request's chain: a read hits, and refreshes, the longest cached
   prefix. Only `hit` is refreshed. Older ancestors keep their touch and age out before other branches.
   A confirmed miss means usage is present, `servedWarm ≥ minTokens` and `read < 0.5·servedWarm`.
   - `cached = cacheReadTokens + Σ cacheWriteTokens > 0`: upsert `{hash: last block, tokens: cached, touchMs:
     receivedAt}` first; refresh `hit` (unless the miss is confirmed); keep the other live records, newest
     first; evict beyond 4. TTL: the shortest TTL written, else the previous TTL, else policy/catalog. On a
     confirmed miss, the in-chain records with `tokens > read` are dropped (the miss falsified them); records
     of other branches stay. `touchMs` uses the request start (`summary.receivedAt`), because provider TTLs
     count from the start of the request.
   - `cached === 0` and the model is implicit: upsert with the full prompt (predict-on-route).
   - `cached === 0` otherwise: drop every record on this chain and keep other branches. The entry is deleted
     when nothing is left. If `promptTokens < minTokens`, the entry is left unchanged.
   - Usage absent (e.g. a Chat stream without `include_usage`): treat it as **unknown, never a miss**. If the
     prefix is warm, refresh `hit` only; otherwise upsert the full prompt with the configured TTL. Skip miss
     attribution.
3b. **Prune (2026-11-04, item B).** For every model except `state.current`: drop each prefix record with
   `touchMs + ttlMs < receivedAt` (no safety margin; the record stamps use `receivedAt` too) and drop the entry
   when no record is left (an entry without records uses `lastTouchMs`). The current model's entry is never
   dropped, because idle-expired detection reads it. Pruned records were cold already, so warmth, switch-back
   pricing and miss attribution (computed from the pre-state) do not change; the state just stops growing.
4. **Miss attribution** (M3), only when usage is present. `expected = warmTokens(pre-state, decision.model)` before the update.
   If `expected ≥ minTokens` and `cacheReadTokens < 0.5·expected`, check these in order:
   1. `servedModel ≠ decision.model` → `model_changed`
   2. age of the matched record (the one `expected` came from) > 0.8·ttl → `ttl_expired`
   3. `lastPrefixHash(pre)` ∉ `blockHashes` → `prefix_changed`. The expectation came from a record on this
      chain (`expected > 0` implies one matched), but the lineage's latest write was on another branch: a fork
      or concurrent sibling interleaved. With multi-prefix records that write no longer evicts our record, so
      the miss is a provider-side effect of branching (server-local cache, the sibling landing elsewhere).
   4. otherwise → `unknown` (Bedrock server-local miss, eviction)

   The result is returned (C4) and kept as `state.lastMiss`.
5. Responses aliasing (C3): if `outcome.responseId` is present, put a minimal state at
   `resp:${responseId}` with `current = servedModel` (and `kind`).
6. `put(state)`.

Concurrency: `get`/`put` is last-write-wins per lineage. Parallel siblings in one lineage can
overwrite each other's cache entry; the effect is a slightly stale estimate, never a lock violation.
Locks are derived from the request itself (`lastTurn`, `previous_response_id`), not from state.

## 8. Contract additions requested (all additive; need parent OK before code)

| # | Change | Why |
|---|---|---|
| C1 | `createEngine` opts: `estimateTokens?: (text: string) => number` (signature as recorded by the parent) | PRD "pluggable estimator" |
| C2 | `DecisionPoint` += `'task-start' \| 'prefix-reset'` | Distinct metrics for cooperative task boundaries and tools/system/param changes; fallback mapping in §6 if declined |
| C3 | `record` outcome += `responseId?: string` | Responses chains without session headers (`resp:` aliasing) |
| C4 | `record` returns `Promise<RecordResult>` (`{ miss?: { reason: 'model_changed'\|'ttl_expired'\|'prefix_changed'\|'unknown'; expectedTokens: number; readTokens: number } }`) instead of `Promise<void>` | Router/replay need the attribution; void callers are unaffected |
| C5 | `SessionState` += optional `calls`, `lastSwitchTurn`, `costSwitches`, `lastFailure`, `lastMiss` | Hysteresis, failover, attribution. Core-owned; optional so replay fixtures stay valid |

### 8.1 Follow-up additions (2026-11-04, all optional / backward compatible)

```ts
interface RequestSummary { maxOutputTokens?: number }                                     // item 5
interface PrefixRecord { hash: string; tokens: number; touchMs: number }                  // item 4 (exported)
interface CacheState { prefixes?: PrefixRecord[] }                                        // item 4, ≤ 4, most recent first
interface RecordResult { chainStateMissing?: true }                                       // item 3
interface SessionState {
  failures?: Record<string, number>                                                       // item 1, model → atMs
  failureStatus?: Record<string, number>                                                  // 2026-11-05 M1, model → last status
  gateForced?: { from: string; atMs: number }                                             // item 5
  kind?: 'root' | 'subagent'                                                              // item 6
}
interface StateStore {
  noteRoot?(root: string, lineage: string): Promise<{ rootSeen: boolean; lineageSeen: boolean }>   // item 2
}
// Tier assessor hook (§12): TierAssessor, AssessorResult, CardContext, DecideExtras, Assessment, AssessmentStatus,
// AssessedTurn; Decision.assessment?; SessionState.compactions? / assessed?; StateStore.rootLineage?(root);
// EngineOptions.assessor? / assessorMode? / assessorTimeoutMs? / assessorMinConfidence?; Engine.decide(summary, extras?).
// Policy (core-owned): PolicyRule.when.lineageKind?: 'root' | 'subagent'; export type LineageKind.
// policyPresets gains costModeledSubagentFast. InMemoryStateStore options gain maxLineagesPerRoot (64).
```

New reason codes: `failover-cross-model`, `chain-state-missing`, `gate-forced`, `gate-recover`,
`failover-chain-locked` (item C). Desired-tier source `assessor(<confidence>)` (§12). Gate notes:
`gate-fallback:current`, `gate-fallback:cheapest`, `gate-fallback`. `DecisionPoint` is unchanged.

Exports beyond §3: `Policy`, `PolicyInput`, `PolicyRule`, `PoolEntry`, `Portability`, `Tier`,
`validatePolicy`, `PolicyError`, `POLICY_DEFAULTS`, `DEFAULT_ALIASES`, `DEFAULT_PORTABILITY`,
`NoEligibleModelError`, `InMemoryStateStore`, `LineageKind`, `PrefixRecord`, `templateFamilyOf`, `defaultEstimateTokens`,
`estimateCost` (cost model; replay may reuse it), `policyPresets`, and the types `RecordOutcome`,
`RecordResult`, `MissAttribution`, `MissReason`, `EngineOptions`. `RecordResult` also carries
`servedDiffers?: true` when the gateway served another model.

## 9. Dependency on @auto-router/pricing

Status (2026-11-04): pricing has landed. `src/pricing-types.ts` is now the re-export file described
below; the shim is gone. The real `costOf` falls back to the default-TTL write price (then throws) where
the shim fell back to the input price. Core only writes with `writeTtlFor()` (policy override or
catalog `defaultTtl`), so the difference is never hit. Tests may import `loadCatalog` from
`@auto-router/pricing` directly for the real-catalog smoke test.

Core uses the pricing types (`Dialect`, `CacheTtl`, `NormalizedUsage`, `ModelPrice`, `PriceCatalog`,
`CostBreakdown`) and the runtime function `costOf`. All of them come in through
`src/pricing-types.ts`. Until a3's package exports them, that file holds a verbatim copy of the §3
types plus a local `costOf` shim with the exact signature. The shim covers base and long tier,
cache read, writes by TTL and output. When pricing lands, the whole file becomes
`export { costOf } from '@auto-router/pricing'; export type { ... } from '@auto-router/pricing'`,
the shim is deleted, and typecheck plus the break-even test prove there is no drift.
Tests use a local fixture catalog (Claude 5.5 family with Bedrock global prices from A §2, plus a
Haiku long-context tier and two OpenAI-dialect models), not `loadCatalog()`.

## 10. Test plan (vitest, synthetic agent traces)

Trace builder helpers produce bodies for each dialect: user turn, assistant tool_use, tool_result,
compaction (short summary history), sub-agent (same session header, different system), plus usage
outcomes. Scenarios:

| # | Scenario | Expect |
|---|---|---|
| 1 | session start | `initialize`, `session-start`, model = rule or default tier |
| 2 | tool loop after a desired-tier change | `retain`, `hard-lock-tool-loop` |
| 3 | Responses with `previous_response_id`, incl. headerless `resp:` alias chain | `hard-lock-response-chain`, same model |
| 4 | encrypted reasoning, family restriction leaves only current | `hard-lock-state` |
| 5 | sub-agent: same header, different system | different lineage, `subagent-start`, parent state untouched |
| 6 | fork: same system/tools | same lineage, no reset |
| 7 | idle > TTL | `idle-expired`, free switch to desired tier |
| 8 | compaction: prompt shrinks and chain breaks; and via hint | `compaction` |
| 9 | tools change, no shrink | `prefix-reset` |
| 10 | downgrade at user turn: 50K, long horizon passes; short horizon / huge context fails | `switch` vs `retain: downgrade-rejected:cost` |
| 11 | minTurnsBeforeSwitch, maxSwitches gates | rejected with gate code |
| 12 | upgrade by `x-router-tier` | `switch`, no cost gate |
| 13 | switch-back within TTL | candidate cost uses old warm prefix; only the appended part is cold (fragmentation) |
| 14 | pin: concrete model in auto mode; `x-router-pin` | `pin` |
| 15 | observe mode | `model = requestedModel`, `wouldChoose` set, state follows the served model |
| 16 | failover: 429 recorded, then decide | next profile of the same model, `failover`; stays until a break point |
| 17 | gateway fallback served another model | state follows it; miss attributed `model_changed` |
| 18 | miss attribution: ttl_expired, unknown | correct reason |
| 19 | break-even table: Opus→Sonnet at 50K | ≈ 11 calls (±1) |
| 20 | summarize per dialect: lastTurn, tags, hints, header precedence, prompt_cache_key | field-level asserts |
| 21 | validatePolicy: defaults, bad values aggregated, catalog cross-check in createEngine | errors listed |
| 22 | perf: 1 MB body < 10 ms p50 over 20 runs (skipped when `CORE_SKIP_PERF=1`) | — |
| 23 | failover in a tool loop: profile, then cross-model only when all profiles failed; wrap-around; non-portable / no sibling / chain → retain; failures map bounds; rotation from the failed model's own status (sibling's status ignored, third profile tried, first-call 5xx re-picks, legacy state) (`failover.test.ts`) | reasons, state |
| 24 | root index: new lineage under seen root → subagent-start; no noteRoot → unchanged; parent-agent-id hint (`lineage.test.ts`) | point, calls |
| 25 | chain-state-missing: headerless and header lineages, alias lookup, observe (`chain-state.test.ts`) | default model, `chainStateMissing` |
| 26 | multi-prefix: parent/fork interleave, 5th prefix evicts LRU, per-record expiry, confirmed miss drops only falsified records, switch-back (`warmth.test.ts`) | records, points |
| 27 | gate: 909,981-token repro stays on Sonnet; cheapest / largest fallbacks; gate-forced → gate-recover (`gate.test.ts`) | no Sonnet→Opus |
| 28 | lineage kind + `costModeledSubagentFast`: Claude Code trace and replay summary shape (with/without noteRoot, sub-agent first) | main standard, sub fast |
| 29 | item 8 numbers: Sonnet→Haiku 150K/188K at 5m/1h (`cost.test.ts`) | break-even H |
| 30 | assessor outcomes at session start: ok/applied, equal-to-default (applied false), low confidence, no tier, unavailable, invalid tier/confidence/shape, throwing getters, sync throw, rejection, card thunk throws, timeout (fake timers: abort at the default `ASSESSOR_DEFAULTS.timeoutMs`, 5000 ms, no timer left) and an assessor that ignores the signal (`assessor.test.ts`) | status, model, applied |
| 31 | assessor modes: observe = no-assessor decisions + audit; off / no assessor / no card thunk = identical decisions, no calls; policy observe → `wouldChoose` | deep equality |
| 32 | assessor caching: concurrent and repeated decides for one turn → 1 call (`cached`); persisted `assessed` reused by another engine; other assessor id re-assesses; new user turn → new call; tool loop never; a timeout persisted on the 5xx path is reused for a retry of the same turn only; memo bound (`ASSESS_MEMO_MAX`) | call counts |
| 33 | assessor not consulted: tool loop, response chain, chain-state-missing, header pin, concrete model (auto), hint tier, alias tier, rule match, failover, session start ending in a tool result; card thunk untouched | calls 0 |
| 34 | CardContext: currentModel/currentTier/compactions/lineageKind, parentTier via `rootLineage`, absent without it | exact objects |
| 35 | assessor tier changes: upgrade at a user turn (no cost gate), idle-expired break point, downgrade rejected by cost / min-turns, `userTurn: 'retain'`; the context gate excludes the opinion's tier; same-family upgrade with thinking state, same-model portability → `hard-lock-state` (not consulted); option validation | reasons |
| 36 | item B: other models' expired entries pruned through record and record-by-record (`pruneExpired`), current kept (`record.test.ts`) | perModel keys |
| 37 | item C: response chain failover retains the exact id (`failover-chain-locked`), the same failure without a chain rotates; no current model → chain-state-missing default (`failover.test.ts`) | point, model |
| 38 | `userTurn: 'retain'` + assessor: plain user turn not consulted (no call, no card, no assessment); session start and `idle-expired` still consulted and applied; forced move (`ineligible`) and gate-forced lineage (`gate-recover`) consulted; `cost-gated` user turns still consulted | calls, models |
| 39 | `userTurn: 'retain'`: a gate-forced lineage held by the gate fallback (`gate-fallback:current`) is not consulted | calls |
| 40 | downgrade guard on a gate-forced lineage judges from `gateForced.from`: standard forced to frontier + standard / fast opinion → user-turn gate-recover to standard (fast held: next turn `downgrade-rejected`; under `retain` the next turn is `boundary-gated`), not guarded; frontier forced to standard + standard opinion → guarded, recovers to frontier | models, guard |

## 11. 2026-11-04 follow-up decisions (parent)

1. Cross-model failover is allowed inside a tool loop only when every profile of the current model failed
   within the window, the history has no non-portable state, and the target is a same-tier pool sibling
   that passes the gate. It is never allowed on a response chain. Failures are tracked per profile.
2. Transparent sub-agent detection through an optional `StateStore.noteRoot`; `x-claude-code-parent-agent-id`
   is a parent hint.
3. `previous_response_id` without router state locks to the dialect default (`chain-state-missing`).
4. Up to 4 prefix records per (lineage, model), so forks do not overwrite the parent's record. Deviation from
   the brief: only the longest in-chain record (the one a read hits) is refreshed, not every in-chain
   record. Refreshing every ancestor made them crowd out a fork's record within two parent turns, and a
   provider read refreshes the entry it hit.
5. Gate fallback prefers the current model, then the cheapest model that physically fits. Gate-forced moves
   recover (`gate-recover`) at the next eligible point.
6. Opt-in preset `costModeledSubagentFast` with `when.lineageKind`; `SessionState.kind`.
7. lineageKind bug: the replay run that sent all 22,710 calls to fast hit an intermediate build. `presets.ts`
   (with the new rule) existed before `ruleMatches` knew `lineageKind`, so the unknown condition matched
   every call. The current build serves the same trace as main 15,783 standard / sub 6,927 fast, in both
   hint modes. Hardening: a lineage equal to its root is never `newUnderRoot`, so a sub-agent call arriving
   first cannot turn the main lineage into a sub-agent. `kind` is persisted by `record`; decide never writes
   state.
8. Gate calibration: the cause is (c), the count-based hysteresis gates (§5.1). No pricing bug, no adaptive
   horizon, and no default changed.
9. **Response chains never rotate profiles (item C).** Failover with `previousResponseId` retains the exact model
   id (`failover-chain-locked`), even when other profiles of the same model are healthy; the earlier
   "exhausted → retain" chain branch is gone because it can no longer be reached. Revisit after the parent's E2E
   check of cross-profile readability of stored responses.
10. **Expired entries are pruned (item B).** See §7 step 3b.
11. **Open item for item 8: no count-gate exemption for hint-driven downgrades, for now.** A hint (or assessor)
    driven downgrade still has to pass `minTurnsBeforeSwitch` and `maxSwitchesPerLineage`. The measured saving of an
    exemption is about $6 of $528 (1.1%), and the LLM assessor's hint flip rate is unknown. Task 73 measures hint
    stability in the assessor eval; revisit after that. Defaults stay unchanged.
12. **Clock skew (accepted as is).** record() stamps failures (`failures`, `lastFailure`) with the engine clock
    (`now()`, after the response), while decide() compares them against `summary.receivedAt`. The effective failover
    window therefore drifts by the request duration (plus any skew between the two clocks); cache records use
    `receivedAt` on both sides and are not affected.
13. **Assessment.costUsd (parent §3 amendment, approved 2026-11-04).** `Assessment.costUsd?` copies
    `AssessorResult.costUsd` (finite, ≥ 0; otherwise dropped) so the router can account assessor spend. It is set only
    on the decision that actually called the assessor, never with `cached`, so spend is counted once. `audit` stays
    out of Assessment: it can quote untrusted prompt text, and the assessor logs it through its own sink.
14. **Open item (deferred): TTL for cached failed consultations.** `timeout` / `error` / `unavailable` / `invalid`
    results are reused until the next user turn, however late a retry of the same turn arrives. A short expiry for
    non-`ok` outcomes is a possible follow-up; not done.
15. **Gate-pessimism investigation (replay 135d2ec, B standard→fast 30% default 1h; analysis only, no code change).**
    The stay-vs-switch estimate is not pessimistic; if anything it is optimistic (H=15 exceeds the realized 8–10-call
    stretch on the cheaper tier, and the switch-back rewrite is not modelled). No 1h write double count, Haiku's
    >100K long-context price is applied per horizon call, and stay-side output is priced. Of the $8.24 gap
    (core $50.93 vs hint-blind $42.69 on 144 blocked turns): `min-turns` 69 turns, $5.53 real; `max-switches` 43
    turns, $3.54 apparent but $0.60 real (hint-blind's fast cache was already warm); cost-check 32 turns, blocking
    saved $0.84 (taking them would lose $2.62). Candidate changes, replay-measured but **not applied** (parent
    decides): `minTurnsBeforeSwitch` 2 → 1 (≡ off in all 16 cells; worst regression +0.1%), optionally H 15 → 8;
    longer-term, a switch-back write term in the estimate. (Analysis scripts were local scratch and are not part of the repo.)
    **Parent decision (2026-11-04):** estimate accepted as sound. `minTurnsBeforeSwitch` stays 2 until task 73's
    hint-stability number (assessor eval) arrives; if the flip rate is low or flips cluster at boundaries, the
    costModeled presets move to 1. That change is prepared but **not applied**:
    `patches/costModeled-minTurns-1.patch` (presets `costModeled` / `costModeledSubagentFast` → `-v2` with
    `hysteresis.minTurnsBeforeSwitch: 1`; global defaults and `boundaryGated` unchanged; test: a hinted downgrade
    right after a hinted upgrade is `min-turns`-rejected at 2 and reaches the cost check at 1). Apply with
    `git apply`; validated against e0c651c (core 159/159, replay 73/73). H=8 is not adopted (−5 pp intent adherence).
16. **Follow-up (not built): switch-back write term in `estimateCost`.** The switch side should include the expected
    rewrite on the original model when the lineage returns: tokens appended while on the cheaper tier are written
    again at the original model's write rate (1h: 2× input). Weight it by an expected stay length on the new tier
    instead of shortening H (realized stretches 8–10 calls vs H=15). This is the long-term fix for the slight
    switch-favouring bias found in item 15; needs a replay number before any default changes.

## 12. Tier assessor hook (parent §3, approved 2026-11-04)

The interface lives in core (`types.ts`), the implementation in `@auto-router/assessor` (`buildCard`,
`createAssessor`). The exported `TierAssessor`, `AssessorResult` and `CardContext` are structurally identical to
`packages/assessor/src/contract.ts` (checked with a mutual-assignability compile check), so that file can become
a one-line re-export.

```ts
interface TierAssessor { readonly id: string; assess(card: unknown, signal: AbortSignal): Promise<AssessorResult> }
type AssessorResult =
  | { status: 'ok'; tier?: Tier; confidence: number; audit: Record<string, unknown>; latencyMs: number; costUsd?: number }
  | { status: 'unavailable'; reason: string; latencyMs: number }
interface CardContext { currentModel?: string; currentTier?: Tier; parentTier?: Tier; compactions: number; lineageKind: 'root' | 'subagent' }
interface DecideExtras { card?: (ctx: CardContext) => unknown }
type AssessmentStatus = 'ok' | 'unavailable' | 'timeout' | 'error' | 'invalid'
interface Assessment { assessorId: string; status: AssessmentStatus; tier?: Tier; confidence?: number; latencyMs: number; applied: boolean; cached?: true }
interface AssessedTurn { turnKey: string; assessorId: string; status: AssessmentStatus; tier?: Tier; confidence?: number; latencyMs: number }
// Decision.assessment?: Assessment; SessionState.compactions?: number; SessionState.assessed?: AssessedTurn
// StateStore.rootLineage?(root: string): Promise<string | undefined>     (InMemoryStateStore implements it)
// EngineOptions: assessor?; assessorMode?: 'off' | 'observe' | 'auto' (default 'observe');
//   assessorTimeoutMs?: number (default 5000, > 0; 1500 until 2026-11-05); assessorMinConfidence?: number (default 0.8, in [0, 1])
// Engine.decide(summary, extras?: DecideExtras)
```

`createEngine` validates the options (always, even without an assessor) and throws a `TypeError` that lists every
bad value: mode, timeout (finite, > 0), confidence (finite, in [0, 1]), assessor shape (non-empty `id`,
`assess` function). No assessor or `assessorMode: 'off'` disables the hook.

**When core consults.** All of these hold:
- an assessor is configured, the mode is not `off`, and `extras.card` is a function (no thunk = no-op);
- the desired tier fell through to the pool default: no valid `hints.tier`, no non-default alias tier, no
  matching rule;
- the point admits it: `session-start` / `subagent-start` / `task-start` unless the last message is a tool
  result; any other break point (`idle-expired`, `compaction`, `prefix-reset`) or the step 6 user turn only when
  `lastTurn === 'user-text'`;
- at the step 6 user turn under `userTurn: 'retain'`, only when the opinion can act there (2026-11-05): a forced
  move (the current model is ineligible or outside the context gate) or a gate-forced lineage whose gate passes
  again (gate-recover; not while a gate fallback holds it, 2026-11-05 follow-up). A plain retained user turn is not consulted, so retain sessions pay no assessor latency or spend for an opinion
  that `retain: boundary-gated` would ignore. Start points and other break points are unaffected.

Never on pins (header, or a concrete model in auto mode), failover, chain-state-missing, hard locks (tool loop,
response chain, non-portable state), prefill (`assistant`), or any tool-result follow-up. The decision steps
are unchanged: decide() runs evaluate() as before and only then, if the evaluation says the point admits a
consultation, consults. Without an assessor the decision is the same object as before.

**Lazy card.** `extras.card(ctx)` runs only right before `assess()`, never on a cache hit. A throwing thunk is
status `error` with `latencyMs: 0`, and the assessor is not called.

**CardContext.** `currentModel` = `state.current`; `currentTier` = its pool tier (a failover profile counts as
its entry; else catalog tier); `compactions` = `state.compactions ?? 0` (record() increments it on every
recorded `compaction` decision); `lineageKind` = the rules' derivation (§6 5b). `parentTier`, for a sub-agent
only: the tier of the current model of the parent lineage, where the parent is `store.rootLineage(root)`, the
first lineage noted under the root. **Choice:** option 2 (root index), because noteRoot already registers the
root's first lineage deterministically and record() cannot learn the parent at creation time. It is one
optional, read-only store method; no new persisted field. Limits: nested sub-agents see the root's first lineage
(the main agent), not their direct parent; a store without `rootLineage`, an evicted root or a parent with no
current model leave `parentTier` undefined.

**Timeout.** `runAssessor` passes an `AbortSignal` and starts a timer of `assessorTimeoutMs`. On expiry it aborts
the signal and returns status `timeout`. The timer is always cleared. The assessor promise is wrapped with both
handlers, so a late rejection after a timeout is absorbed (no unhandled rejection). A sync throw or a rejection is
`error`; `unavailable` is passed through; a malformed result (not an object, unknown status, confidence not a
finite number in [0, 1], unknown tier string, or fields that throw when read) is `invalid`. decide() also
backs the consultation promise with a catch (status `error`), so a rejected promise can never sit in the memo
and fail every decide() of the turn. `latencyMs` is the assessor's own value when it is a
finite number ≥ 0, else the measured wall time.

**Opinion.** Only `status 'ok'` with a tier and `confidence ≥ assessorMinConfidence`. Everything else is "no
opinion" and the decision is the baseline.

**Modes** (independent of `policy.mode`):
- `observe`: consult and attach `assessment` with `applied: false`; the choice is the baseline (no-assessor) choice.
- `auto`: with an opinion, evaluate() runs again with the assessor as the desired-tier source, after hint, alias and
  rules and before the pool default (reason `tier=X via assessor(0.91)` / `upgrade:assessor(0.91): …`). The
  usual paths then apply: at a start point it is the initial tier; at another break point the full decision;
  at a user turn an upgrade switches at once (no cost or count gate, as for hints), a downgrade goes through the
  cost and count gates (`downgrade-rejected:*`), and `userTurn: 'retain'` retains (as it does for hints). The
  context gate, portability and hard locks hold throughout. `applied` = the re-evaluated model differs from the
  baseline model (so an opinion equal to the default tier is `applied: false`, even though the reason names the
  assessor).
- Under `policy.mode: 'observe'` the re-evaluated choice is what feeds `wouldChoose`; the served model follows
  step 8 as before.

**Caching per (lineage, user turn).** `turnKey = m<messageCount>:<last chain hash>` (`turns:<state.turns>` when
the summary has no chain). **Choice:** the chain hash through the last message is identical for a retry of the
same request (same history) and changes with every new user turn (a message is appended), and it needs nothing
from the state. A user-turn counter would not work for persistence: `turns` increments on the successful record,
so a retry after success would look like a new turn, and the only other re-decides of a turn (after 429/5xx) are
failover points, which never consult. Lookups, in order:
1. the in-engine memo `assessorId\0lineage\0turnKey` → promise (bounded at 1024, oldest first). Concurrent
   decides for one turn share one call;
2. `state.assessed` with the same `turnKey` and `assessorId` (written by record(), so another engine on the
   same store reuses it).

A hit sets `assessment.cached = true` (the one field beyond parent §3) and does not call the thunk or the
assessor. All outcomes are cached, including timeouts and errors, so a retry of a slow turn does not pay the
timeout twice. Opinions are re-derived from the cached confidence with the engine's own `assessorMinConfidence`.
A different assessor id re-assesses.

**Deviations from parent §3.** `Assessment.cached?: true` (allowed extra). `AssessmentStatus` adds `timeout`,
`error` and `invalid` to the assessor's `ok` / `unavailable` (§3 leaves the status set open). Optional
`StateStore.rootLineage` and `SessionState.compactions` / `assessed` (core-owned, optional).


**Downgrade guard (`assessorDowngradeFrom`, approved 2026-11-04 after task 73's eval).** The assessor under-calls
frontier work (0/45 frontier on SWE-bench; on the frontier→standard replay pair assessed hints keep only 42% of
frontier calls). EngineOptions `assessorDowngradeFrom?: Tier[]`, default `['standard']`, validated (tiers only).
- "From" tier = the lineage's current model tier (pool tier; a failover profile counts as its entry; else the
  catalog tier), or the pool default at a start point with no current model. In policy observe the current model is
  the served one, so the guard follows what was actually served. A gate-forced lineage (`gateForced`) is judged
  from the tier of `gateForced.from`, the model it was forced off (2026-11-05 follow-up): the forced model's tier
  was never a choice, so it neither blocks recovery (standard forced up to frontier, then a standard or fast
  opinion recovers, to standard at a user turn; see step 6 gate-recover) nor licenses a downgrade (frontier forced down to standard, then a standard opinion is guarded
  and the lineage recovers to frontier).
- An opinion below "from" with "from" ∉ the list is **clamped to "from"**: in auto mode the lineage holds its tier
  (retain; the pool default cannot pull it down on that consulted turn either), `applied: false`,
  `Assessment.guard = 'assessor-downgrade-guarded'`, and the reason gets the suffix
  `; assessor-downgrade-guarded <from>→<to>` (the reason code is unchanged). assessorMode observe: audit field only,
  decision and reason unchanged. Under policy observe the guarded evaluation feeds `wouldChoose`.
- Not affected: upgrades, downgrades from listed tiers (standard→fast still goes through the cost and count gates),
  client hint tiers (`x-router-hint tier=`), alias/rule tiers, and turns where the assessor gives no opinion (the
  pool default still applies there; widening the guard to those is a possible follow-up).
- Tests: `assessor.test.ts` "downgrade guard" (frontier + standard opinion → retain/guarded; same with frontier
  listed → not guarded; standard + fast → cost gate; frontier pool default at start; upgrades never guarded; client
  hints unaffected; policy observe wouldChoose; option validation). The existing min-turns case now lists frontier.
