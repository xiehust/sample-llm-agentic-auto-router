# Router core: lineage, break points, per-model cache state, switch economics, policy

## Goal

`packages/core` (`@auto-router/core`): a pure, dependency-free TypeScript decision engine implementing
the contracts in `../11-04-llm-auto-router/design.md` §3 and the decision table in §5. No network or
file I/O; state goes through the `StateStore` interface (in-memory implementation included).

Read first: parent `prd.md`, `design.md`; research `B-router-landscape.md` (§2 P0–P9),
`C-inference-cache-routing.md` (§2 M1–M11), `A-provider-caching.md` (§1.2 invalidation table).

## Requirements

- `summarize(dialect, body, headers, now)` for `anthropic-messages`, `openai-chat`, `openai-responses`:
  - Session key priority: `x-router-session` (cooperative) > `x-claude-code-session-id` > `x-session-id`
    > `prompt_cache_key` (OpenAI bodies) > fingerprint = hash(tenant? + tools hash + system hash + first
    user message). Lineage: `x-router-parent-session` / `x-router-agent-id` hints, else a new system/tools
    fingerprint under the same root is a new lineage (sub-agent).
  - `lastTurn` per dialect (tool_result / function_call_output / role=tool → `tool-result`).
  - `previousResponseId`; `nonPortableState` (Anthropic thinking blocks with signatures, OpenAI encrypted
    reasoning items).
  - Chained block hashes over canonical JSON at message boundaries (tools → system → messages);
    `estPromptTokens` heuristic (pluggable).
  - Must handle 1 MB bodies in < 10 ms p50 on the dev box.
- `decide(summary)`: classify the decision point (pinned, hard locks, free break points, user turn,
  failover), choose a model from the dialect pool, apply the cost model over horizon H with per-model cache
  state and fragmentation, hysteresis (`costRatio`, `minUsd`, `minTurnsBeforeSwitch`), `observe` vs `auto`
  (observe returns the client's model and fills `wouldChoose`). Upgrades are driven by tier hints/rules,
  not cost.
- `record(summary, decision, outcome)`: update cache state from usage; `servedModel` may differ from the
  decision (gateway fallback); attribute unexpected misses (`model_changed`, `ttl_expired`,
  `prefix_changed`, `unknown`).
- Versioned `Policy` schema (pools per dialect with tiers, rules template-family → tier, TTL policy,
  hysteresis, default horizon) with validation; documented in this task's `design.md`.

## Acceptance Criteria

- [ ] Unit tests on synthetic agent traces cover: tool-loop lock; Responses chain lock; thinking-state
      lock; session start; sub-agent lineage separation (same root, different system); idle expiry;
      compaction detection; cost-gated downgrade at a user turn (passes and fails the break-even);
      upgrade by tier hint; switch-back within TTL priced with fragmentation only; pin; observe mode.
- [ ] `pnpm -C packages/core typecheck && pnpm -C packages/core test` green; no runtime dependencies.
- [ ] `summarize` performance check on a 1 MB body included in tests (skippable in CI by env flag).

## Constraints

- Work only inside `packages/core/` and this task directory. Do not edit root files or other packages.
- Pricing types come from `@auto-router/pricing`. Until it lands, depend on it via `workspace:*` and code
  against the parent §3 contract; coordinate with the pricing-usage session through the parent if a
  contract change is needed.
- No commits; no AWS calls.
