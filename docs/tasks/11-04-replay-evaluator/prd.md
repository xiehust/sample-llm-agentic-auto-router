# Offline replay evaluator with cache-aware pricing

## Goal

`packages/replay` (`@auto-router/replay`): replay agent traces under routing policies against a
simulated provider cache, and report cost, cache hit rate, switch count and cold writes per policy. This
is how routing policies are judged before any live traffic.

Read first: parent `prd.md`, `design.md` (§1 break-even table, §3 contracts, §5 logic); research
`C-inference-cache-routing.md` §3 (agent workload data, public traces) and `B-router-landscape.md` §2 P3.

## Requirements

- Trace schema (JSONL, documented): per call — session/lineage, timestamp, dialect, requested model,
  prompt token count, new tokens since the previous call, output tokens, last-turn kind, prefix identity
  (chained block hashes or parent pointers), sub-agent / compaction markers when known.
- Adapters for at least one public agent trace with prefix information (TraceLab, Qwen Bailian usage
  traces, or Mooncake toolagent; choose by availability and licence). Downloaded data is untrusted: keep it
  in its own directory, never execute anything from it.
- Provider cache simulator (ground truth, separate from the router's estimate): exact-prefix cache per
  (model, endpoint) with TTL refresh on hit, write premiums by TTL, optional Anthropic 20-block lookback,
  optional scatter factor for global profiles.
- Policies: always-frontier, always-cheap, cache-blind per-request classifier (stub rule), sticky-session,
  and the `@auto-router/core` engine in boundary-gated and cost-modeled settings.
- Cost via `@auto-router/pricing` `costOf`; CLI `replay --trace <file> --policy <name> --catalog <file>`
  printing a table and writing JSON.

## Acceptance Criteria

- [ ] A test reproduces the parent §1 break-even table from synthetic traces (±1 step).
- [ ] Report on one public trace for all policies, saved under this task's `research/`.
- [ ] Compiles and runs against the real `@auto-router/core` and `@auto-router/pricing` packages at
      integration (temporary local stubs allowed before they land, deleted afterwards).
- [ ] `pnpm -C packages/replay typecheck && pnpm -C packages/replay test` green.

## Constraints

- Work only inside `packages/replay/` and this task directory (trace data under `packages/replay/data/`,
  gitignored if large).
- No AWS calls; no commits.
