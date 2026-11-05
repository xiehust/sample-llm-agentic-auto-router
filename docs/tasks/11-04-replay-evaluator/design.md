# Design: @auto-router/replay

This package replays agent traces offline under routing policies, against a simulated provider prompt cache.
Each call is priced with `@auto-router/pricing` `costOf`. For each policy it reports cost, cache hit rate,
switches and cold writes.

It consumes the parent `design.md` §3 contracts unchanged, uses no new dependencies, and makes no AWS calls.

## 1. Data flow

```
public trace (untrusted, data/<source>/)          synthetic generator (src/synth.ts)
        │ adapter (parse JSON only)                         │
        ▼                                                   ▼
  replay-trace/v1 JSONL (data/<source>/*.replay.jsonl, globally time-sorted)
        │ stream
        ▼
  Replayer ── per call ──► Policy.choose(call, view) ──► model id
        │                        ▲      (core policies: RequestSummary → Engine.decide)
        ▼                        │
  ProviderCacheSim (ground truth) ── NormalizedUsage ──► costOf(usage, price)
        │                                              │
        └──► Policy.observe(call, model, usage) ──────►  (core: Engine.record → closed loop)
        ▼
  Metrics accumulator ──► report JSON + markdown table (stdout)
```

There are two separate cache views:
- The **simulator** is ground truth: what the provider would bill.
- The **router** keeps its own estimate. For core policies this is the engine's `StateStore`, fed only through
  `record(...usage)`.

The replay never lets a policy read simulator state.

## 2. Trace schema `replay-trace/v1` (JSONL, one call per line)

```ts
interface TraceCall {
  v: 1
  session: string            // root session id (user-visible session)
  lineage: string            // cache lineage: main thread, sub-agent or fork; == session for the main thread
  parentLineage?: string     // set on the first call of a sub-agent or fork lineage
  seq: number                // call index within the lineage (0-based)
  ts: number                 // request start, epoch ms (TTL clock; Anthropic counts TTL from request start)
  dialect: Dialect           // 'anthropic-messages' | 'openai-chat' | 'openai-responses'
  model: string              // model the source trace actually used (raw string, mapped via model map)
  promptTokens: number       // full prompt size = Σ prefix.segments[].tokens
  newTokens: number          // tokens not shared with this lineage's previous call
  outputTokens: number       // billed output, reasoning included
  reasoningTokens?: number
  lastTurn: LastTurn         // 'user-text' | 'tool-result' | 'assistant' | 'other'
  prefix: {
    segments: { id: string; tokens: number }[]  // prompt = concatenation; see §2.1
    templateTokens: number   // leading tokens that are system + tools (template family)
  }
  appendedBlocks?: number    // content blocks added since the previous call (Anthropic lookback); optional
  markers?: Array<'compaction' | 'rewrite' | 'subagent-start' | 'fork' | 'model-change' | 'session-start'>
  recorded?: { cacheReadTokens: number; cacheWriteTokens: number; uncachedInputTokens: number } // source-trace usage, for calibration only
}
```

### 2.1 Prefix identity: run-length segments

A prompt is an ordered list of segments. Two segments with the same `id` have identical content over their
common length. So the shared prefix of two prompts is computed like this:
- walk both lists while the ids are equal, adding `min(tokens)`;
- stop at the first segment where the ids differ or where the tokens differ (a shorter segment ends the match).

This representation is exact for append-only agents, and compact: one segment per chain, not one hash per
block. Block-hash traces (Mooncake, Qwen Bailian) map to it with one segment per block, so a second adapter
needs no schema change.

`RequestSummary.prefix.blockHashes` for the core engine is derived deterministically:
- cut the prompt into blocks of `blockTokens` (default 4096; the trailing partial block is dropped);
- hash each block as `fnv1a64(prevHash, segment ids/offsets covered)`;
- memoize per lineage, so each call hashes only its new blocks.

The other `prefix` fields are filled as follows:
- `toolsHash` and `systemHash` come from the template segment id;
- `estPromptTokens` is `promptTokens`;
- `messageCount` is `seq + 1`.

The trace has no message content, so `summarize()` is never called. The replay builds the `RequestSummary`
directly. That type is part of the §3 contract.

## 3. Public trace: TraceLab v0.0.2 (chosen)

| | |
|---|---|
| Source | https://github.com/uw-syfi/TraceLab, release `v0.0.2` asset `syfi_coding_trace.jsonl.gz` |
| Integrity | sha256 `11ce51ec0a25e3d1d95b025bca2f7d1647e47571eb7cc968acd5fc64d4b4fb65` (matches the GitHub release digest; verified on download) |
| Licence | Data: **CC BY 4.0** (attribution: "TraceLab (SyFI Lab, University of Washington)", https://tracelab.cs.washington.edu; we indicate changes = converted to replay-trace/v1). Code in that repo: Apache-2.0 (we use none of it). |
| Content | 665,453 LLM rounds and 8,058 sessions of real Claude Code (305K rounds) and Codex (360K rounds) use, May–Oct 2026. Per round: model, `input_tokens_total = prefix_tokens + newly_append_tokens`, Claude cache read/write/uncached, output and reasoning, timing events (ISO timestamps), first input event type, and tool-result/user-message counts. |
| Why this one | It is the most agent-realistic public trace: real tool-loop gaps, user idle, compaction and model switches. Mooncake toolagent gaps are not loop-like (C research §3), and Qwen Bailian is not agentic. |
| Gaps | No content and no block hashes, so prefix identity is reconstructed (§3.1). No explicit sub-agent lineage: only 96 of the 8,058 sessions use more than one model, and sub-agent transcripts do not appear as separate lineages. No 1h-TTL split in v0.0.2. |

Storage:
- The raw `.jsonl.gz` and the converted file go in `packages/replay/data/tracelab/`, which is gitignored by
  `packages/replay/.gitignore`.
- A `data/README.md` is committed with source, sha256, licence and the fetch command.
- The adapter only does `gunzip → readline → JSON.parse` and type-checks fields. Nothing from the data is
  executed, evaluated or used as a path or a command.

### 3.1 TraceLab adapter rules (prefix reconstruction)

Sessions are ordered by `(round_index, file order)`.

| Field | Rule |
|---|---|
| `dialect` | `claude` → `anthropic-messages`; `codex` → `openai-responses` |
| `ts` | The last input event (`user_message` / `tool_result`) timestamp before the first output event. Otherwise the first event. |
| `lastTurn` | `first_input_event_type`: `tool_result` → `tool-result`, `user_message` → `user-text`, null → `other` |
| `templateTokens` | Round 0 `prefix_tokens` when > 0 (a cross-session template hit was recorded). Otherwise the median of that value over the same `(provider, model family)`. |
| Template segment id | `tpl:<provider>:<user>`. Templates are shared within one user (one org). They are never shared across users. |
| Prefix shared with the previous call, `d` | (a) `input < prev_input`, a drop: `d = max(min(R, input), min(templateTokens, input))`, where R is the recorded cache read. Marked `compaction` if `input < 0.7·prev`, else `rewrite`. (b) Claude, same model, gap < 240 s, and `R < prev_input − 1024`: the recorded cache should have been warm, so the prefix changed at R. `d = max(R, templateTokens)`, marked `rewrite`. (c) Otherwise the call is append-only: `d = prev_input`. |
| Segments | Keep the previous segments truncated to `d`, then append a new segment `<lineage>:s<k>` of `input − d` tokens. `newTokens = input − d`. |
| `markers` | `session-start` at round 0. `model-change` when the model differs from the previous round. |
| `recorded` | Claude: from the `claude_*` fields. Codex: read = `prefix_tokens`, write = 0 (OpenAI-style implicit caching). |

Limits, which also go in the report header:
- Rule (b) treats a real miss inside the TTL as a content change. It is right for Claude, whose explicit
  caching is deterministic. It is not applied to Codex, where implicit caching can miss for routing reasons.
- Template sizes are estimates.
- Without sub-agent lineages, the `subagent-start` policies are only exercised by the synthetic traces.

## 4. Provider cache simulator (ground truth)

Configured per run (`SimConfig`, JSON, all optional). Defaults are taken from the catalog's `cache` block:

```ts
interface SimConfig {
  ttlOverride?: Partial<Record<string, CacheTtl>>  // modelId → TTL to write with (default: catalog defaultTtl)
  lookbackBlocks?: number          // Anthropic read lookback; off by default (null); 20 when enabled
  scatter?: { global: number; geo: number; inRegion: number; shards: number } // P(request lands on a non-primary shard); default {0,0,0,4}
  seed?: number                    // PRNG seed for scatter (mulberry32), default 1
}
```

Semantics, per request `r` served on model `m`:

1. **Cache domain**: `(m.modelId, shard)`.
   - Shard 0 is the primary.
   - With probability `scatter[m.endpointScope]` the request goes to a uniformly random shard among
     `1..shards-1`. This models the Bedrock remark that a global or cross-region profile "may lead to
     increased cache writes".
   - Caches never cross models, profiles or regions.
2. **Read**: the longest live entry `e` in the domain whose prompt is a prefix of `r`'s prompt (shared-prefix
   rule of §2.1).
   - "Live" means `now < e.expiresAt`.
   - With `lookbackBlocks`, it also requires `r.blockIndex − e.blockIndex ≤ lookbackBlocks`, where blockIndex
     is the cumulative `appendedBlocks` in the lineage.
   - Only an entry of at least `cache.minTokens` counts. `read = e.length`.
   - **Hit refresh**: `e.expiresAt = now + ttl(e)`.
3. **Write**: if `promptTokens ≥ minTokens` and `cache.mode ≠ 'none'`, write an entry for the full prompt
   (breakpoint at the end, as Claude Code and automatic caching do).
   - TTL: `ttlOverride[m] ?? defaultTtl`. `expiresAt = now + ttl`, measured from request start.
   - `write = promptTokens − read`.
   - If the model has no write price for that TTL, the write is billed as uncached input. The usage reports it
     as uncached, not as a write, as for an implicit cache with no premium.
4. **Usage**: `{ uncachedInputTokens: promptTokens − read − write, cacheReadTokens: read,
   cacheWriteTokens: { [ttl]: write }, outputTokens, reasoningTokens, promptTokens }`.
   - Cost is `costOf(usage, price)`. The long-context tier is decided by pricing from `promptTokens`.
5. **Store**:
   - The entries of one domain form a trie keyed by segment id.
   - Each node keeps `(length, expiresAt, blockIndex)` entries sorted by length.
   - Expired entries are pruned lazily on visit, plus a periodic sweep.
   - Memory is bounded by the live entries, which means calls within the TTL.

Not modelled:
- capacity eviction before TTL (no SLA, unknown);
- failures and failover (there is no failure data, so the `failover` decision point is not exercised; a
  `--fail-rate` injection is a possible follow-up);
- latency.

## 5. Policies

A policy sees only what a router could see: the call (without `recorded`), its own memory, and the usage
returned for its own past calls.

```ts
interface ReplayPolicy {
  name: string
  choose(call: TraceCall, ctx: PolicyCtx): Promise<string> | string   // returns catalog modelId
  observe?(call: TraceCall, servedModel: string, usage: NormalizedUsage): Promise<void> | void
}
```

**Pools.** Per dialect, from `pools` in the replay config (default file `src/pools.default.json`, validated
against the catalog):

| Dialect | frontier | standard | fast |
|---|---|---|---|
| anthropic-messages | `global.anthropic.claude-opus-5-5` | `global.anthropic.claude-sonnet-5-5` | `global.anthropic.claude-haiku-5-5` |
| openai-chat / openai-responses | `global.openai.gpt-6-astra` | `global.openai.gpt-6.1-sol` | `global.openai.gpt-6-luna` |

| Policy | Rule |
|---|---|
| `recorded` | Baseline. The trace's own model, mapped to the catalog: exact `global.<vendor>.<name>` id, then a prefix match, then a pool tier from the name keyword (opus/fable→frontier, sonnet/sol/terra→standard, haiku/luna/mini/spark→fast). The mapping table is printed in the report. |
| `always-frontier` / `always-cheap` | Pool `frontier` / `fast` for the call's dialect. |
| `classifier` | Cache-blind, per request: `fast` if `lastTurn = tool-result` and `newTokens < 4000`, else `frontier`. This is a stub rule standing in for a naive per-turn classifier. |
| `sticky-session` | Applies the `classifier` rule once, on the first call of each lineage, then pins that model for the lineage. |
| `core-boundary` / `core-cost` | `@auto-router/core` `createEngine({ policy, catalog, store: InMemoryStateStore, now: () => virtualClock })`. Per call: build `RequestSummary` (§2.1), `decide`, simulate, `record(summary, decision, { servedModel, status: 200, usage })`. `requestedModel` is the router alias (see open question Q1). Hints: `--hints none` (transparent) or `cooperative` (sets `hints.boundary` from markers and `parentSession` from `parentLineage`). |
| `scripted` | Test-only. Stays on A and switches to B at call k. Used for the break-even test. |

The `PolicyCtx` gives the dialect pools, the catalog and the policy's own per-lineage memory. It does not
give simulator state.

## 6. Metrics and report

Per policy, accumulated over the calls:
- **Cost**: `total` and the breakdown `input / cacheRead / cacheWrite / output` in USD; per-session p50, p90
  and max; Δ% vs `recorded`.
- **Hit rate**: `Σ cacheRead / Σ promptTokens`, token-weighted. Also the share of calls with read ≥ 90% of
  the prompt.
- **Switches**: number of times the served model differs from the lineage's previous served model; switches
  per 100 calls; and a split into `on tool-result turns` (hard-lock violations) and `other`.
- **Cold writes**: calls where `write − newTokens > 1024`, meaning existing context was rewritten.
  `coldWriteTokens = Σ max(0, write − newTokens)`. Also `$ lost to cold writes`, the write premium paid on
  those tokens.
- **Mix**: calls and cost by tier and by model.
- **Core policies**: a histogram of `Decision.point` and `action`.
- **Calibration**, `recorded` policy only: simulated hit rate vs the trace's recorded hit rate, per provider.
  This sanity-checks the simulator and prefix reconstruction. Target for Claude: within 5 percentage points.

Report JSON:

```ts
interface ReplayReport {
  schema: 'replay-report/v1'
  meta: { generatedAt: string; trace: { path: string; sha256: string; calls: number; sessions: number; filter?: string };
          catalog: { version: string; asOf: string; region: string }; sim: SimConfig; pools: object; modelMap: Record<string,string>;
          corePolicyVersion?: string; notes: string[] }
  policies: PolicyResult[]
}
```

The CLI prints a markdown table, one row per policy, with these columns: cost $, Δ vs recorded, hit %,
switches/100 calls, tool-turn switches, cold writes, cold-write $, and frontier/standard/fast %.

**CLI** (runs on Node 24 with native type stripping, no build step and no new dependencies):

```
node src/cli.ts replay  --trace <file> --policy <name|all> [--catalog <file>] [--sim <file>] [--pools <file>]
                        [--hints none|cooperative] [--provider claude|codex] [--sessions N] [--out <report.json>]
node src/cli.ts convert tracelab <in.jsonl.gz> <out.replay.jsonl>
node src/cli.ts synth   <scenario> <out.replay.jsonl>
```

- Exposed as the `replay` bin and the `pnpm -C packages/replay replay …` script.
- `--catalog` takes a catalog JSON (the pricing schema of design §2.2) and is validated with pricing's loader
  rules. The default is `loadCatalog()`.

## 7. Break-even test (acceptance)

`src/breakeven.test.ts` builds synthetic lineages:
- one warm-up call on A at context C (excluded from cost);
- then N steps of +1,000 new tokens and 250 output tokens, 1 s apart;
- the context grows with each step.

It replays two runs:
- `stay`: every step on A;
- `switch`: every step on B;

and finds the smallest N with `Σ cost(switch) ≤ Σ cost(stay)`, plus the one-time extra cost.

Expected values, from parent §1, ±1 step:

| Switch | 50K | 150K |
|---|---|---|
| Opus 5.5 → Sonnet 5.5; GPT-6.1 Sol → Terra | 11 | 17 |
| Sonnet/Opus 5.5 → Haiku 5.5; GPT-6.1 Sol → GPT-6 Luna | 1 (cheaper from the first step) | Luna 1; Haiku from Opus 2, from Sonnet 7 (long tier) |
| Sonnet 5.5 → Opus 5.5 | never (≤ 1000 steps); extra +$0.25 ±0.01 | never; +$0.74 ±0.01 |

The parent table uses a fixed context; this test grows the context. The ±1-step tolerance absorbs the
difference, which by my hand check is under 0.6 steps.

The test runs against `loadCatalog()`. Before pricing lands, it runs against a fixture catalog with the same
prices (`src/__fixtures__/catalog.breakeven.json`). That fixture is deleted at integration if the real
catalog matches.

## 8. Dependencies on parallel packages

- Imports go through `src/deps.ts` only. Before the real packages land, it re-exports from
  `src/_stubs/{pricing,core}.ts`. The stubs are the §3 types plus a minimal `costOf` and a pass-through
  engine.
- At integration, `deps.ts` points to `@auto-router/pricing` and `@auto-router/core` and `_stubs/` is
  deleted. A test asserts that `_stubs/` does not exist once the real packages export `costOf` and
  `createEngine`.
- The core policies need two things from router-core: Q1 a routing alias for `requestedModel`, and Q2 the
  `Policy` objects for the `boundary` and `cost` settings. Until then, the `core-*` rows are reported as
  `pending`.

## 9. Package layout

```
packages/replay/
  .gitignore                 data/* except data/README.md
  data/README.md             sources, sha256, licence, fetch commands
  src/
    deps.ts                  single import point for core/pricing (stubs → real)
    schema.ts                TraceCall types + validator (hand-written)
    trace-io.ts              JSONL stream reader/writer (gz aware)
    adapters/tracelab.ts     TraceLab → replay-trace/v1 (§3.1)
    synth.ts                 synthetic scenarios (break-even, agent sessions w/ sub-agents and compaction)
    sim.ts                   ProviderCacheSim (§4)
    prefix.ts                shared-prefix rule, blockHashes derivation (fnv1a64)
    policies/*.ts            §5 policies + model map
    pools.default.json → pools.default.ts (TS module, no JSON import)
    replayer.ts              orchestration, virtual clock
    metrics.ts, report.ts    §6
    cli.ts                   §6 CLI
    *.test.ts                vitest next to sources
```

## 10. Additions approved during implementation (parent 0c, 2026-11-04)

- **Schema:**
  - additive optional `TraceCall.hints?: { tier }`, the cooperative per-turn intent;
  - `lastTurn: 'other'` for harness side calls (the compaction fork).
- **Policies:**
  - `intent-blind`: sub-agent lineage → fast, main → standard, applied per request.
  - `hint-blind`: serves `hints.tier` on every request. No lock, gate or hysteresis.
  - `core-cost-subfast` (`policyPresets.costModeledSubagentFast`) is listed only when core exports it.
  - Cooperative core summaries forward `hints.tier`.
- **Metric:** `intentAdherence`, the share of hinted calls served at the hinted tier. It is the quality-side cost
  of gating.
- **Synthetic generator:** parameters are cited from research C §3 (`SYNTH_SOURCES`). `synthStats()` reports the
  realized values next to the targets.
- **Sweep** (`replay sweep`), synthetic and labelled as such:
  - (A) sub-agent intent over sub-agent share 4/8/16% × idle default/heavy × Claude TTL 5m/1h.
  - (B) per-turn intent over tier pair (standard→fast, frontier→standard) × alt-turn share 15/30% × idle × TTL,
    at 8% sub-agents.
- **Gate analysis** (`gate.ts`): for each hinted switch request at a user turn, it records whether core allowed or
  blocked it, the reason, and the direction. It also compares realized cost against `hint-blind` over the same
  turn plus the lineage's next turn, and gives the turn-length and prompt-size distributions of blocked turns.
