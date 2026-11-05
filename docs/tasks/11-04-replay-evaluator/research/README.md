# Replay evaluator: final report (2026-11-04)

Build:
- `@auto-router/core` at df20bf1 (round 2), with presets `boundaryGated`, `costModeled` and `costModeledSubagentFast`.
- `@auto-router/pricing` catalog `2026-11-04.1` (ap-northeast-1).
- The replay package in this task.

Commands, run from `packages/replay`:
- `node src/cli.ts replay --trace data/tracelab/tracelab-v0.0.2.replay.jsonl --policy all [--provider claude|codex]`, which writes `replay-report-tracelab-v0.0.2.{all,claude,codex}.{json,md}`.
- `node src/cli.ts sweep --sessions 400 --seed 2026`, which writes `replay-sweep.{json,md}`.

Trace data: TraceLab (SyFI Lab, University of Washington), https://tracelab.cs.washington.edu, licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Changes: converted to replay-trace/v1 with reconstructed prefix identity.

## 1. Calibration on TraceLab v0.0.2 (policy `recorded`, simulated vs recorded hit rate)

| Dialect | Calls | Simulated | Recorded | Δ pp |
|---|---|---|---|---|
| anthropic-messages (Claude) | 305,445 | 91.4% | 95.2% | **−3.8** (target ±5: pass) |
| openai-responses (Codex) | 360,008 | 96.6% | 96.2% | +0.3 |

Sensitivity: if every Claude write uses a 1h TTL, the simulated Claude hit rate is 97.5% (+2.2 pp). Real traffic sits between the 5m and 1h simulations.

## 2. Policies side by side: TraceLab, all 665,453 calls (8,058 sessions)

| Policy | Cost $ | Δ vs recorded | Hit rate | Switches /100 calls | Tool-turn switches | Cold writes | Cold-write $ lost | Frontier / standard / fast calls |
|---|---|---|---|---|---|---|---|---|
| recorded | 104,008 | +0.0% | 93.4% | 0.01 | 10 | 32,520 | 32,646 | 93.4% / 3.1% / 3.5% |
| always-frontier | 117,553 | +13.0% | 93.4% | 0.00 | 0 | 32,505 | 29,584 | 100 / 0 / 0 |
| always-cheap | 7,525 | −92.8% | 93.4% | 0.00 | 0 | 32,505 | 2,819 | 0 / 0 / 100 |
| classifier (cache-blind, per request) | 72,690 | −30.1% | 87.2% | **23.01** | **111,345** | **141,591** | 37,050 | 25.6 / 0 / 74.4 |
| intent-blind | 33,393 | −67.9% | 93.4% | 0.00 | 0 | 32,505 | 13,203 | 0 / 100 / 0 |
| hint-blind | 33,393 | −67.9% | 93.4% | 0.00 | 0 | 32,505 | 13,203 | 0 / 100 / 0 |
| sticky-session | 117,553 | +13.0% | 93.4% | 0.00 | 0 | 32,505 | 29,584 | 100 / 0 / 0 |
| core-boundary | 33,393 | −67.9% | 93.4% | 0.00 | 0 | 32,505 | 13,203 | 0 / 100 / 0 |
| core-cost | 33,393 | −67.9% | 93.4% | 0.00 | 0 | 32,505 | 13,203 | 0 / 100 / 0 |
| core-cost-subfast | 33,393 | −67.9% | 93.4% | 0.00 | 0 | 32,505 | 13,203 | 0 / 100 / 0 |

Per-provider tables are in the `.claude.md` and `.codex.md` files. Cost-modeled policy vs recorded:

| Provider | Core-cost $ | Recorded $ | Δ |
|---|---|---|---|
| Claude | 23,774 | 76,245 | −68.8% |
| Codex | 9,619 | 27,762 | −65.4% |

On Codex the classifier costs **+14.2%** vs recorded.

TraceLab findings:
1. **Every no-switch policy keeps the recorded hit rate.** The cache-blind classifier switches 23 times per 100 calls, 111K of them inside tool loops. It writes 4.4× more cold entries and loses 6 pp of hit rate.
2. **On this trace every core preset equals the intent-blind/hint-blind baseline.** TraceLab has no tier intent: no text, no hints, no sub-agent lineages. So the desired tier is always the pool default (standard), and the cost gate never runs.
3. **The round-2 fix removed the gate-fallback Opus calls** that the first report found: 5,036 calls / 35 switches above 900K before. There are now 0 frontier calls and 0 switches.
4. **Δ vs recorded is relative to the model mapping** (`meta.modelMap`). Many trace models are not in the Tokyo catalog.

## 3. SYNTHETIC: sensitivity sweep (this section is synthetic data, not a trace)

### Generator

Generator `agentSessions`: 400 sessions, seed 2026. Parameters are from research C §3 (`SYNTH_SOURCES` in `src/synth.ts`):

| Parameter | Distribution | Source |
|---|---|---|
| Intra-turn gap | lognormal, median 1.2 s, p95 37 s | Copilot traces |
| Cross-turn idle (default) | median 172 s, p90 20.6 min | Copilot; TraceLab p90 |
| Cross-turn idle (heavy) | median 10 min, p90 60 min | assumption |
| Calls per turn | geometric, mean 6.6 | Copilot |
| Calls per session | median 15 | Copilot |
| Append per step | ≈860 tokens, with a 4% large-read tail | TraceLab |
| Output per step | median 220 | TraceLab |
| Initial context | median 25K | — |
| Template | main 13K (TraceLab), sub-agent 9K (assumption) | — |
| Compaction | cache-safe fork; keeps 27% | Copilot |
| Sub-agents | own template, 1–4K task, 1–2K summary | Anthropic context-engineering post |

Realized statistics (8% sub-agents, default idle), against the targets:

| Statistic | Realized | Target |
|---|---|---|
| Median prompt | 66.7K | 68–126K |
| Intra-turn gap median / p95 | 1.35 s / 46 s | 1.2 s / 37 s |
| Cross-turn gap median / p90 | 162 s / 19.0 min | 172 s / 20.6 min |
| Heavy idle median / p90 | 567 s / 55.8 min | — |
| Median append | 925 | ~860 |
| Median output | 222 | 184–252 |
| Sessions compacted | 6.0% | 7.8–9.7% |
| Sub-agent share of tool steps | 7.6% | 8% |

Sweep dimensions:
- sub-agent share 4 / 8 / 16%;
- idle default / heavy;
- Claude write TTL 5m / 1h. Both the simulator and core's `cache.writeTtl` are set.

### (A) Sub-agent intent: `intent-blind` vs `core-cost-subfast` (same intent, with or without cost modelling)

**The advantage is 0.0% in all 12 cells.**
- Costs, switches and cold writes are identical.
- In the 8% default cell, both policies send 15,783 main-lineage calls to standard and 6,927 sub-agent calls to fast. This matches 0d's numbers.
- Reason: a sub-agent starts a new lineage at a free break point, so there is no cache to lose and nothing for the gate to judge. Cost modelling neither helps nor hurts.

The intent itself is worth a lot. Here is `core-cost` (no sub-agent rule) against `core-cost-subfast`:

| Sub-agent share | default 5m | default 1h | heavy 5m | heavy 1h |
|---|---|---|---|---|
| 4% | −6.0% | −10.2% | −4.6% | −8.9% |
| 8% | −13.4% | −20.3% | −10.5% | −18.2% |
| 16% | −20.1% | −29.9% | −16.5% | −27.8% |

The saving grows with the sub-agent share and with the 1h TTL. Quality is not measured: tier mix is the only proxy.

### (B) Per-turn intent (cooperative `hints.tier`): `hint-blind` vs `core-cost`, which is the real test of the gate

Two tier pairs, alt-turn share 15 / 30%, 8% sub-agents.

| Pair | Advantage of core-cost (positive = cheaper) | Switches /100: hint-blind → core-cost | Intent adherence: core-cost (hint-blind 100%) |
|---|---|---|---|
| standard→fast | **−1.1% … +0.8%** (no effect) | 1.99–3.28 → 1.53–3.12 | 93–100% |
| frontier→standard | **+1.2% … +6.6%** | 1.99–3.28 → 0.43–2.68 | 82–98% |

For frontier→standard, cold-write $ falls by 3–52%. The largest gains are with the 1h TTL, where the cache to lose is larger.

#### Sensitivity: standard→fast, count gates on (defaults) vs off for hint-driven downgrades

This is a sensitivity row, **not a recommendation**: the defaults are kept. The defaults are minTurnsBeforeSwitch 2 and maxSwitchesPerLineage 6. "Off" means minTurnsBeforeSwitch 0 and no switch cap; the cost gate still applies. The `core-cost-nocount` variant is in `policies/index.ts`.

| Cell | Defaults $ | Off $ | Δ off vs defaults | sw/100 defaults → off | Intent adherence defaults → off |
|---|---|---|---|---|---|
| 15% default 5m | 605.15 | 606.09 | +0.2% | 1.91 → 1.99 | 99 → 100% |
| 15% default 1h | 548.49 | 546.71 | −0.3% | 1.66 → 1.77 | 98 → 99% |
| 15% heavy 5m | 744.77 | 744.88 | +0.0% | 1.95 → 1.99 | 100 → 100% |
| 15% heavy 1h | 611.66 | 611.26 | −0.1% | 1.53 → 1.65 | 97 → 98% |
| 30% default 5m | 571.11 | 570.95 | −0.0% | 2.95 → 3.28 | 97 → 100% |
| 30% default 1h | **528.06** | **520.53** | **−1.4%** | 2.52 → 3.10 | 94 → 99% |
| 30% heavy 5m | 675.44 | 675.97 | +0.1% | 3.12 → 3.28 | 99 → 100% |
| 30% heavy 1h | 590.11 | 588.18 | −0.3% | 2.48 → 2.92 | 93 → 97% |

The 30% default 1h cell reproduces 0d's $528.06 vs $520.53. Across the sweep, turning the count gates off changes cost by −1.4% … +0.2%. It raises intent adherence by up to 5 pp, at the price of more switches.

#### Gate analysis (core-cost; hinted switch requests at user turns; cost = that turn + the lineage's next turn)

- **All blocks are downgrades** (`downgrade-rejected`). Upgrades are never blocked.
- **frontier→standard: the gate pays off.** Blocked turns cost core $60–264 vs hint-blind $78–329 in every cell, i.e. blocking saved 8–32%. Blocked turns are long-context: prompt p50 111–126K, p90 205–218K. Turn length p50 5–6 calls, p90 12–15.
- **standard→fast: blocked downgrades are mostly break-even, and some are unprofitable.** With the 1h TTL, the 30% default cell spends $50.93 on core vs $42.69 on hint-blind for the blocked turns. The 30% heavy 1h cell spends $63.14 vs $61.63, and the 30% default 5m cell $17.96 vs $16.82.
  - These blocked turns are long-context: p50 143–188K on 1h cells.
  - Finding for 0d: with the 1h TTL, core's stay-vs-switch estimate is pessimistic for switches to the floor tier on long contexts. Likely causes are the fast model's low write price at 1h, and the horizon.
  - Left as a finding; not tuned in replay.

## 4. Validation

- `pnpm -C packages/replay typecheck && pnpm -C packages/replay test` is green, against core df20bf1.
- The sweep CLI adds the sensitivity section automatically for standard→fast cells.
- Not covered:
  - quality, for which tier mix is the only proxy;
  - failover (no failure data);
  - sub-agent lineages in real traces (TraceLab has none).
