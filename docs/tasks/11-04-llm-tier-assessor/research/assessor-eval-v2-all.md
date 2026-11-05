# Tier assessor offline eval

Pack: assessor/v2+3893290b1a13

> SWE-bench Verified (princeton-nlp/SWE-bench_Verified): no licence declared on the dataset card; SWE-bench code is MIT; issue texts come from 12 upstream projects. Used for offline evaluation only; no issue text is reproduced here (instance ids and aggregates only).

## Summary

| model | variant | dataset | n | coverage | acc. on opinions | fast pred | **fast precision** | frontier recall | no opinion | unavailable | p50 ms | p95 ms | >1.5 s | mean $/assess | cached in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| global.openai.gpt-6-luna | v2 | hand | 80 | 95.0% | 98.7% | 40 | **100.0%** | 83.3% | 5.0% | 0 | 1183 | 1353 | 0.0% | $0.000372 | 61.2% |
| global.openai.gpt-6-luna | v2 | swebench | 500 | 86.4% | 77.8% | 1 | **0.0%** | 55.6% | 13.2% | 2 | 1305 | 1455 | 3.0% | $0.000638 | 24.9% |
| global.openai.gpt-6-luna | v2 | traj | 80 | 61.3% | 91.8% | 22 | **95.5%** | 57.1% | 38.8% | 0 | 1235 | 1431 | 1.5% | $0.000462 | 46.8% |
| global.openai.gpt-6-luna | v2 | all | 660 | 84.4% | 81.9% | 63 | **96.8%** | 62.3% | 15.3% | 2 | 1292 | 1444 | 2.5% | $0.000587 | 31.3% |

## Threshold recommendation

- **global.openai.gpt-6-luna v2**: 0.5 — lowest threshold with fast precision ≥ 0.95 (95.3% on 64 fast calls), coverage 97.1%

## global.openai.gpt-6-luna · v2 · hand

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 40 | 0 | 0 | 0 | 0 |
| standard | 0 | 20 | 0 | 2 | 0 |
| frontier | 0 | 1 | 15 | 2 | 0 |

Cost: total $0.029781, mean $0.000372, p95 $0.000743; mean tokens in 5147 / out 182.

| category | n | correct | no opinion |
|---|---|---|---|
| explore | 20 | 20 | 0 |
| mechanical | 15 | 15 | 0 |
| bounded | 20 | 19 | 1 |
| deep | 15 | 14 | 1 |
| confusable | 6 | 3 | 2 |
| injection | 4 | 4 | 0 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 40 | 100.0% | 94.4% | 97.5% |
| 0.6 | 100.0% | 40 | 100.0% | 94.4% | 97.5% |
| 0.7 | 100.0% | 40 | 100.0% | 94.4% | 97.5% |
| 0.75 | 100.0% | 40 | 100.0% | 94.4% | 97.5% |
| 0.8 | 95.0% | 40 | 100.0% | 83.3% | 98.7% |
| 0.85 | 85.0% | 40 | 100.0% | 72.2% | 100.0% |
| 0.9 | 70.0% | 40 | 100.0% | 44.4% | 100.0% |
| 0.95 | 48.8% | 38 | 100.0% | 5.6% | 100.0% |

## global.openai.gpt-6-luna · v2 · swebench

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 0 | 0 | 0 | 0 | 0 |
| standard | 1 | 311 | 79 | 63 | 1 |
| frontier | 0 | 16 | 25 | 3 | 1 |

Cost: total $0.319164, mean $0.000638, p95 $0.000876; mean tokens in 5553 / out 206.
Unavailable by code: parse 2.
Soft signal: 0 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:sympy__sympy-13798

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 99.6% | 1 | 0.0% | 57.8% | 75.9% |
| 0.6 | 99.6% | 1 | 0.0% | 57.8% | 75.9% |
| 0.7 | 99.0% | 1 | 0.0% | 57.8% | 76.0% |
| 0.75 | 97.8% | 1 | 0.0% | 57.8% | 76.3% |
| 0.8 | 86.4% | 1 | 0.0% | 55.6% | 77.8% |
| 0.85 | 59.0% | 1 | 0.0% | 31.1% | 80.7% |
| 0.9 | 12.6% | 0 | — | 6.7% | 88.9% |
| 0.95 | 0.2% | 0 | — | 0.0% | 100.0% |

## global.openai.gpt-6-luna · v2 · traj

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 21 | 2 | 0 | 7 | 0 |
| standard | 1 | 16 | 1 | 18 | 0 |
| frontier | 0 | 0 | 8 | 6 | 0 |

Cost: total $0.030487, mean $0.000462, p95 $0.000752; mean tokens in 5171 / out 188.
Fast false positives: tj-08#t2

Hint stability over 16 trajectories (64 consecutive-turn transitions):

| measure | value |
|---|---|
| raw flip rate (both turns have an opinion) | 40.7% (11/27) |
| held flip rate (served hint; no opinion keeps the current tier) | 18.8% (12/64) |
| held downgrade flips | 9 |
| downgrade reversed by an upgrade on the next turn | 0 |
| spurious flips (gold unchanged) | 8.1% (3/37) |
| gold changes followed on that turn | 48.1% (13/27) |
| flips at gold-change (boundary) transitions | 75.0% of flips (9/12); boundary transitions are 42.2% of all |
| held flips by turn index (t1..t4) | t1 2/16, t2 7/16, t3 2/16, t4 1/16 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 78.8% | 23 | 91.3% | 78.6% | 87.3% |
| 0.6 | 77.5% | 23 | 91.3% | 78.6% | 87.1% |
| 0.7 | 75.0% | 23 | 91.3% | 78.6% | 86.7% |
| 0.75 | 73.8% | 23 | 91.3% | 71.4% | 86.4% |
| 0.8 | 61.3% | 22 | 95.5% | 57.1% | 91.8% |
| 0.85 | 40.0% | 19 | 100.0% | 28.6% | 96.9% |
| 0.9 | 22.5% | 16 | 100.0% | 14.3% | 100.0% |
| 0.95 | 11.3% | 9 | 100.0% | 0.0% | 100.0% |

## global.openai.gpt-6-luna · v2 · all

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 61 | 2 | 0 | 7 | 0 |
| standard | 2 | 347 | 80 | 83 | 1 |
| frontier | 0 | 17 | 48 | 11 | 1 |

Cost: total $0.379431, mean $0.000587, p95 $0.000859; mean tokens in 5464 / out 202.
Unavailable by code: parse 2.
Soft signal: 0 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:sympy__sympy-13798, tj-08#t2

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 97.1% | 64 | 95.3% | 70.1% | 79.7% |
| 0.6 | 97.0% | 64 | 95.3% | 70.1% | 79.7% |
| 0.7 | 96.2% | 64 | 95.3% | 70.1% | 79.7% |
| 0.75 | 95.2% | 64 | 95.3% | 68.8% | 79.9% |
| 0.8 | 84.4% | 63 | 96.8% | 62.3% | 81.9% |
| 0.85 | 59.8% | 60 | 98.3% | 40.3% | 85.3% |
| 0.9 | 20.8% | 56 | 100.0% | 16.9% | 94.9% |
| 0.95 | 7.4% | 47 | 100.0% | 1.3% | 100.0% |
