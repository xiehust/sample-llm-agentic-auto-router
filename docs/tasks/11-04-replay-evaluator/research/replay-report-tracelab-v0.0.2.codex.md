Trace: data/tracelab/tracelab-v0.0.2.replay.jsonl — 360008 calls, 2739 sessions, filter dialect=openai-responses; catalog 2026-11-04.1 (ap-northeast-1)

| Policy | Cost $ | Δ vs recorded | Hit rate | Switches /100 calls | Tool-turn switches | Cold writes | Cold-write $ lost | Frontier / standard / fast calls |
|---|---|---|---|---|---|---|---|---|
| recorded | 27762 | +0.0% | 96.6% | 0.00 | 0 | 10413 | 2165 | 98.6% / 0.1% / 1.3% |
| always-frontier | 70006 | +152.2% | 96.6% | 0.00 | 0 | 10410 | 5454 | 100.0% / 0.0% / 0.0% |
| always-cheap | 700 | -97.5% | 96.6% | 0.00 | 0 | 10410 | 54.54 | 0.0% / 0.0% / 100.0% |
| classifier | 31694 | +14.2% | 93.7% | 18.89 | 51429 | 63843 | 7642 | 26.1% / 0.0% / 73.9% |
| intent-blind | 9619 | -65.4% | 96.6% | 0.00 | 0 | 10410 | 1138 | 0.0% / 100.0% / 0.0% |
| hint-blind | 9619 | -65.4% | 96.6% | 0.00 | 0 | 10410 | 1138 | 0.0% / 100.0% / 0.0% |
| sticky-session | 70006 | +152.2% | 96.6% | 0.00 | 0 | 10410 | 5454 | 100.0% / 0.0% / 0.0% |
| core-boundary | 9619 | -65.4% | 96.6% | 0.00 | 0 | 10410 | 1138 | 0.0% / 100.0% / 0.0% |
| core-cost | 9619 | -65.4% | 96.6% | 0.00 | 0 | 10410 | 1138 | 0.0% / 100.0% / 0.0% |
| core-cost-subfast | 9619 | -65.4% | 96.6% | 0.00 | 0 | 10410 | 1138 | 0.0% / 100.0% / 0.0% |

Calibration (policy `recorded`): simulated vs recorded hit rate

| Dialect | Calls | Simulated | Recorded | Δ pp |
|---|---|---|---|---|
| openai-responses | 360008 | 96.6% | 96.2% | +0.3 |

- Simulator: exact-prefix cache per (model, shard); TTL from request start, refreshed on hit; full-prompt write each call; no early eviction, no failures/failover, no latency.
- Cost per call via @auto-router/pricing costOf; quality is not measured (tier mix is the only proxy).
- TraceLab prefix identity is reconstructed (task design §3.1): drops → compaction/rewrite; Claude same-model misses within 240 s → rewrite; otherwise append-only. No sub-agent lineages in this trace.

Trace data: TraceLab (SyFI Lab, University of Washington), https://tracelab.cs.washington.edu, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changes: converted to replay-trace/v1 with reconstructed prefix identity.
