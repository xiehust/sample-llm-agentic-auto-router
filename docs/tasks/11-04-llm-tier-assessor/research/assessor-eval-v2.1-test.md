# Tier assessor offline eval

Pack: assessor/v2.1+2696c56a9c6c

> SWE-bench Verified (princeton-nlp/SWE-bench_Verified): no licence declared on the dataset card; SWE-bench code is MIT; issue texts come from 12 upstream projects. Used for offline evaluation only; no issue text is reproduced here (instance ids and aggregates only).

## Summary

| model | variant | dataset | n | coverage | acc. on opinions | fast pred | **fast precision** | frontier recall | no opinion | unavailable | p50 ms | p95 ms | >1.5 s | mean $/assess | cached in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| global.openai.gpt-6-luna | v2.1 | hand | 80 | 96.3% | 97.4% | 40 | **100.0%** | 83.3% | 3.8% | 0 | 1222 | 1453 | 3.8% | $0.000329 | 61.2% |
| global.openai.gpt-6-luna | v2.1 | swebench | 383 | 83.6% | 95.3% | 1 | **0.0%** | 0.0% | 16.4% | 0 | 1265 | 1433 | 2.9% | $0.000686 | 1.7% |
| global.openai.gpt-6-luna | v2.1 | traj | 80 | 62.5% | 94.0% | 19 | **100.0%** | 64.3% | 37.5% | 0 | 1144 | 1386 | 4.5% | $0.000413 | 45.3% |
| global.openai.gpt-6-luna | v2.1 | all | 543 | 82.3% | 95.5% | 60 | **98.3%** | 48.0% | 17.7% | 0 | 1249 | 1435 | 3.2% | $0.000598 | 15.3% |

## Threshold recommendation

- **global.openai.gpt-6-luna v2.1**: 0.5 — lowest threshold with fast precision ≥ 0.95 (95.4% on 65 fast calls), coverage 96.9%

## global.openai.gpt-6-luna · v2.1 · hand

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 40 | 0 | 0 | 0 | 0 |
| standard | 0 | 20 | 0 | 2 | 0 |
| frontier | 0 | 2 | 15 | 1 | 0 |

Cost: total $0.026343, mean $0.000329, p95 $0.000644; mean tokens in 4349 / out 183.

| category | n | correct | no opinion |
|---|---|---|---|
| explore | 20 | 20 | 0 |
| mechanical | 15 | 15 | 0 |
| bounded | 20 | 19 | 1 |
| deep | 15 | 14 | 0 |
| confusable | 6 | 3 | 2 |
| injection | 4 | 4 | 0 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 40 | 100.0% | 88.9% | 97.5% |
| 0.6 | 100.0% | 40 | 100.0% | 88.9% | 97.5% |
| 0.7 | 100.0% | 40 | 100.0% | 88.9% | 97.5% |
| 0.75 | 98.8% | 40 | 100.0% | 88.9% | 97.5% |
| 0.8 | 96.3% | 40 | 100.0% | 83.3% | 97.4% |
| 0.85 | 90.0% | 40 | 100.0% | 83.3% | 98.6% |
| 0.9 | 73.8% | 40 | 100.0% | 50.0% | 98.3% |
| 0.95 | 48.8% | 38 | 100.0% | 5.6% | 100.0% |

## global.openai.gpt-6-luna · v2.1 · swebench

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 0 | 0 | 0 | 0 | 0 |
| standard | 1 | 305 | 1 | 58 | 0 |
| frontier | 0 | 13 | 0 | 5 | 0 |

Cost: total $0.262894, mean $0.000686, p95 $0.000786; mean tokens in 4740 / out 206.
Soft signal: 0 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:sympy__sympy-13798

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 99.7% | 1 | 0.0% | 0.0% | 95.0% |
| 0.6 | 99.7% | 1 | 0.0% | 0.0% | 95.0% |
| 0.7 | 98.2% | 1 | 0.0% | 0.0% | 94.9% |
| 0.75 | 96.3% | 1 | 0.0% | 0.0% | 95.1% |
| 0.8 | 83.6% | 1 | 0.0% | 0.0% | 95.3% |
| 0.85 | 51.7% | 1 | 0.0% | 0.0% | 94.9% |
| 0.9 | 11.0% | 1 | 0.0% | 0.0% | 97.6% |
| 0.95 | 0.0% | 0 | — | 0.0% | 0.0% |

## global.openai.gpt-6-luna · v2.1 · traj

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 19 | 2 | 0 | 9 | 0 |
| standard | 0 | 19 | 1 | 16 | 0 |
| frontier | 0 | 0 | 9 | 5 | 0 |

Cost: total $0.027286, mean $0.000413, p95 $0.000653; mean tokens in 4373 / out 189.

Hint stability over 16 trajectories (64 consecutive-turn transitions):

| measure | value |
|---|---|
| raw flip rate (both turns have an opinion) | 50.0% (13/26) |
| held flip rate (served hint; no opinion keeps the current tier) | 28.6% (18/63) |
| held downgrade flips | 10 |
| downgrade reversed by an upgrade on the next turn | 0 |
| spurious flips (gold unchanged) | 8.3% (3/36) |
| gold changes followed on that turn | 59.3% (16/27) |
| flips at gold-change (boundary) transitions | 83.3% of flips (15/18); boundary transitions are 42.9% of all |
| held flips by turn index (t1..t4) | t1 5/15, t2 7/16, t3 4/16, t4 2/16 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 80.0% | 24 | 91.7% | 78.6% | 89.1% |
| 0.6 | 78.8% | 24 | 91.7% | 78.6% | 88.9% |
| 0.7 | 77.5% | 24 | 91.7% | 78.6% | 90.3% |
| 0.75 | 73.8% | 23 | 95.7% | 78.6% | 91.5% |
| 0.8 | 62.5% | 19 | 100.0% | 64.3% | 94.0% |
| 0.85 | 40.0% | 18 | 100.0% | 28.6% | 93.8% |
| 0.9 | 22.5% | 15 | 100.0% | 14.3% | 100.0% |
| 0.95 | 10.0% | 7 | 100.0% | 7.1% | 100.0% |

## global.openai.gpt-6-luna · v2.1 · all

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 59 | 2 | 0 | 9 | 0 |
| standard | 1 | 344 | 2 | 76 | 0 |
| frontier | 0 | 15 | 24 | 11 | 0 |

Cost: total $0.316523, mean $0.000598, p95 $0.000776; mean tokens in 4635 / out 201.
Soft signal: 0 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:sympy__sympy-13798

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 96.9% | 65 | 95.4% | 54.0% | 94.7% |
| 0.6 | 96.7% | 65 | 95.4% | 54.0% | 94.7% |
| 0.7 | 95.4% | 65 | 95.4% | 54.0% | 94.8% |
| 0.75 | 93.4% | 64 | 96.9% | 54.0% | 95.1% |
| 0.8 | 82.3% | 60 | 98.3% | 48.0% | 95.5% |
| 0.85 | 55.6% | 59 | 98.3% | 38.0% | 95.7% |
| 0.9 | 21.9% | 56 | 98.2% | 22.0% | 98.3% |
| 0.95 | 8.7% | 45 | 100.0% | 4.0% | 100.0% |
