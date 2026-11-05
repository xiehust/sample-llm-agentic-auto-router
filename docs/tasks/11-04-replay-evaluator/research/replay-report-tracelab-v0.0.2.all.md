Trace: data/tracelab/tracelab-v0.0.2.replay.jsonl — 665453 calls, 8058 sessions; catalog 2026-11-04.1 (ap-northeast-1)

| Policy | Cost $ | Δ vs recorded | Hit rate | Switches /100 calls | Tool-turn switches | Cold writes | Cold-write $ lost | Frontier / standard / fast calls |
|---|---|---|---|---|---|---|---|---|
| recorded | 104008 | +0.0% | 93.4% | 0.01 | 10 | 32520 | 32646 | 93.4% / 3.1% / 3.5% |
| always-frontier | 117553 | +13.0% | 93.4% | 0.00 | 0 | 32505 | 29584 | 100.0% / 0.0% / 0.0% |
| always-cheap | 7525 | -92.8% | 93.4% | 0.00 | 0 | 32505 | 2819 | 0.0% / 0.0% / 100.0% |
| classifier | 72690 | -30.1% | 87.2% | 23.01 | 111345 | 141591 | 37050 | 25.6% / 0.0% / 74.4% |
| intent-blind | 33393 | -67.9% | 93.4% | 0.00 | 0 | 32505 | 13203 | 0.0% / 100.0% / 0.0% |
| hint-blind | 33393 | -67.9% | 93.4% | 0.00 | 0 | 32505 | 13203 | 0.0% / 100.0% / 0.0% |
| sticky-session | 117553 | +13.0% | 93.4% | 0.00 | 0 | 32505 | 29584 | 100.0% / 0.0% / 0.0% |
| core-boundary | 33393 | -67.9% | 93.4% | 0.00 | 0 | 32505 | 13203 | 0.0% / 100.0% / 0.0% |
| core-cost | 33393 | -67.9% | 93.4% | 0.00 | 0 | 32505 | 13203 | 0.0% / 100.0% / 0.0% |
| core-cost-subfast | 33393 | -67.9% | 93.4% | 0.00 | 0 | 32505 | 13203 | 0.0% / 100.0% / 0.0% |

Calibration (policy `recorded`): simulated vs recorded hit rate

| Dialect | Calls | Simulated | Recorded | Δ pp |
|---|---|---|---|---|
| openai-responses | 360008 | 96.6% | 96.2% | +0.3 |
| anthropic-messages | 305445 | 91.4% | 95.2% | -3.8 |

- Simulator: exact-prefix cache per (model, shard); TTL from request start, refreshed on hit; full-prompt write each call; no early eviction, no failures/failover, no latency.
- Cost per call via @auto-router/pricing costOf; quality is not measured (tier mix is the only proxy).
- TraceLab prefix identity is reconstructed (task design §3.1): drops → compaction/rewrite; Claude same-model misses within 240 s → rewrite; otherwise append-only. No sub-agent lineages in this trace.

Trace data: TraceLab (SyFI Lab, University of Washington), https://tracelab.cs.washington.edu, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changes: converted to replay-trace/v1 with reconstructed prefix identity.
