Trace: data/tracelab/tracelab-v0.0.2.replay.jsonl — 305445 calls, 5319 sessions, filter dialect=anthropic-messages; catalog 2026-11-04.1 (ap-northeast-1)

| Policy | Cost $ | Δ vs recorded | Hit rate | Switches /100 calls | Tool-turn switches | Cold writes | Cold-write $ lost | Frontier / standard / fast calls |
|---|---|---|---|---|---|---|---|---|
| recorded | 76245 | +0.0% | 91.4% | 0.02 | 10 | 22107 | 30481 | 87.3% / 6.6% / 6.0% |
| always-frontier | 47548 | -37.6% | 91.4% | 0.00 | 0 | 22095 | 24130 | 100.0% / 0.0% / 0.0% |
| always-cheap | 6825 | -91.0% | 91.4% | 0.00 | 0 | 22095 | 2765 | 0.0% / 0.0% / 100.0% |
| classifier | 40996 | -46.2% | 82.9% | 27.86 | 59916 | 77748 | 29408 | 25.1% / 0.0% / 74.9% |
| intent-blind | 23774 | -68.8% | 91.4% | 0.00 | 0 | 22095 | 12065 | 0.0% / 100.0% / 0.0% |
| hint-blind | 23774 | -68.8% | 91.4% | 0.00 | 0 | 22095 | 12065 | 0.0% / 100.0% / 0.0% |
| sticky-session | 47548 | -37.6% | 91.4% | 0.00 | 0 | 22095 | 24130 | 100.0% / 0.0% / 0.0% |
| core-boundary | 23774 | -68.8% | 91.4% | 0.00 | 0 | 22095 | 12065 | 0.0% / 100.0% / 0.0% |
| core-cost | 23774 | -68.8% | 91.4% | 0.00 | 0 | 22095 | 12065 | 0.0% / 100.0% / 0.0% |
| core-cost-subfast | 23774 | -68.8% | 91.4% | 0.00 | 0 | 22095 | 12065 | 0.0% / 100.0% / 0.0% |

Calibration (policy `recorded`): simulated vs recorded hit rate

| Dialect | Calls | Simulated | Recorded | Δ pp |
|---|---|---|---|---|
| anthropic-messages | 305445 | 91.4% | 95.2% | -3.8 |

- Simulator: exact-prefix cache per (model, shard); TTL from request start, refreshed on hit; full-prompt write each call; no early eviction, no failures/failover, no latency.
- Cost per call via @auto-router/pricing costOf; quality is not measured (tier mix is the only proxy).
- TraceLab prefix identity is reconstructed (task design §3.1): drops → compaction/rewrite; Claude same-model misses within 240 s → rewrite; otherwise append-only. No sub-agent lineages in this trace.

Trace data: TraceLab (SyFI Lab, University of Washington), https://tracelab.cs.washington.edu, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changes: converted to replay-trace/v1 with reconstructed prefix identity.
