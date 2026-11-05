# Tier assessor offline eval

Pack: assessor/v1+ee49d3c06e8d

> SWE-bench Verified (princeton-nlp/SWE-bench_Verified): no licence declared on the dataset card; SWE-bench code is MIT; issue texts come from 12 upstream projects. Used for offline evaluation only; no issue text is reproduced here (instance ids and aggregates only).

## Summary

| model | variant | dataset | n | coverage | acc. on opinions | fast pred | **fast precision** | frontier recall | no opinion | unavailable | p50 ms | p95 ms | >1.5 s | mean $/assess | cached in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| global.openai.gpt-6-luna | default | hand | 80 | 96.3% | 98.7% | 40 | **100.0%** | 88.9% | 3.8% | 0 | 1288 | 1465 | 3.8% | $0.000286 | 66.2% |
| global.openai.gpt-6-luna | default | swebench | 383 | 74.7% | 94.1% | 7 | **0.0%** | 0.0% | 23.8% | 6 | 1265 | 1964 | 11.5% | $0.000640 | 1.7% |
| global.openai.gpt-6-luna | default | traj | 80 | 61.3% | 91.8% | 22 | **95.5%** | 57.1% | 38.8% | 0 | 1235 | 1510 | 6.1% | $0.000379 | 46.8% |
| global.openai.gpt-6-luna | default | all | 543 | 75.9% | 94.7% | 69 | **88.4%** | 48.0% | 23.0% | 6 | 1263 | 1778 | 9.6% | $0.000553 | 16.2% |

## Threshold recommendation

- **global.openai.gpt-6-luna default**: 0.95 — lowest threshold with fast precision ≥ 0.95 (98.0% on 50 fast calls), coverage 9.6%

## global.openai.gpt-6-luna · default · hand

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 40 | 0 | 0 | 0 | 0 |
| standard | 0 | 20 | 0 | 2 | 0 |
| frontier | 0 | 1 | 16 | 1 | 0 |

Cost: total $0.022883, mean $0.000286, p95 $0.000597; mean tokens in 3970 / out 184.

| category | n | correct | no opinion |
|---|---|---|---|
| explore | 20 | 20 | 0 |
| mechanical | 15 | 15 | 0 |
| bounded | 20 | 18 | 2 |
| deep | 15 | 14 | 1 |
| confusable | 6 | 5 | 0 |
| injection | 4 | 4 | 0 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 98.8% | 40 | 100.0% | 88.9% | 98.7% |
| 0.6 | 98.8% | 40 | 100.0% | 88.9% | 98.7% |
| 0.7 | 98.8% | 40 | 100.0% | 88.9% | 98.7% |
| 0.75 | 98.8% | 40 | 100.0% | 88.9% | 98.7% |
| 0.8 | 96.3% | 40 | 100.0% | 88.9% | 98.7% |
| 0.85 | 91.3% | 40 | 100.0% | 88.9% | 98.6% |
| 0.9 | 73.8% | 40 | 100.0% | 50.0% | 100.0% |
| 0.95 | 51.2% | 39 | 100.0% | 11.1% | 100.0% |

## global.openai.gpt-6-luna · default · swebench

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 0 | 0 | 0 | 0 | 0 |
| standard | 7 | 269 | 0 | 83 | 6 |
| frontier | 0 | 10 | 0 | 8 | 0 |

Cost: total $0.241338, mean $0.000640, p95 $0.000740; mean tokens in 4365 / out 206.
Unavailable by code: timeout 6.
Soft signal: 5 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:django__django-11099, swe:django__django-11163, swe:django__django-14672, swe:django__django-15554, swe:pytest-dev__pytest-5809, swe:pytest-dev__pytest-7982, swe:sympy__sympy-16886

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 96.6% | 8 | 0.0% | 0.0% | 92.2% |
| 0.6 | 95.6% | 8 | 0.0% | 0.0% | 92.3% |
| 0.7 | 93.2% | 8 | 0.0% | 0.0% | 92.7% |
| 0.75 | 88.3% | 8 | 0.0% | 0.0% | 92.9% |
| 0.8 | 74.7% | 7 | 0.0% | 0.0% | 94.1% |
| 0.85 | 43.1% | 7 | 0.0% | 0.0% | 92.7% |
| 0.9 | 10.2% | 6 | 0.0% | 0.0% | 84.6% |
| 0.95 | 0.3% | 1 | 0.0% | 0.0% | 0.0% |

## global.openai.gpt-6-luna · default · traj

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 21 | 2 | 0 | 7 | 0 |
| standard | 1 | 16 | 1 | 18 | 0 |
| frontier | 0 | 0 | 8 | 6 | 0 |

Cost: total $0.025038, mean $0.000379, p95 $0.000603; mean tokens in 3994 / out 190.
Fast false positives: tj-08#t2

Hint stability over 16 trajectories (64 consecutive-turn transitions):

| measure | value |
|---|---|
| raw flip rate (both turns have an opinion) | 39.1% (9/23) |
| held flip rate (served hint; no opinion keeps the current tier) | 25.0% (16/64) |
| held downgrade flips | 10 |
| downgrade reversed by an upgrade on the next turn | 0 |
| spurious flips (gold unchanged) | 8.1% (3/37) |
| gold changes followed on that turn | 55.6% (15/27) |
| flips at gold-change (boundary) transitions | 81.3% of flips (13/16); boundary transitions are 42.2% of all |
| held flips by turn index (t1..t4) | t1 2/16, t2 9/16, t3 2/16, t4 3/16 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 77.5% | 23 | 91.3% | 71.4% | 88.7% |
| 0.6 | 76.3% | 23 | 91.3% | 71.4% | 88.5% |
| 0.7 | 73.8% | 23 | 91.3% | 71.4% | 88.1% |
| 0.75 | 71.3% | 23 | 91.3% | 71.4% | 89.5% |
| 0.8 | 61.3% | 22 | 95.5% | 57.1% | 91.8% |
| 0.85 | 51.2% | 21 | 95.2% | 28.6% | 90.2% |
| 0.9 | 27.5% | 17 | 100.0% | 21.4% | 100.0% |
| 0.95 | 12.5% | 10 | 100.0% | 0.0% | 100.0% |

## global.openai.gpt-6-luna · default · all

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 61 | 2 | 0 | 7 | 0 |
| standard | 8 | 305 | 1 | 103 | 6 |
| frontier | 0 | 11 | 24 | 15 | 0 |

Cost: total $0.289259, mean $0.000553, p95 $0.000730; mean tokens in 4258 / out 201.
Unavailable by code: timeout 6.
Soft signal: 5 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:django__django-11099, swe:django__django-11163, swe:django__django-14672, swe:django__django-15554, swe:pytest-dev__pytest-5809, swe:pytest-dev__pytest-7982, swe:sympy__sympy-16886, tj-08#t2

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 94.1% | 71 | 85.9% | 52.0% | 92.8% |
| 0.6 | 93.2% | 71 | 85.9% | 52.0% | 92.9% |
| 0.7 | 91.2% | 71 | 85.9% | 52.0% | 93.1% |
| 0.75 | 87.3% | 71 | 85.9% | 52.0% | 93.5% |
| 0.8 | 75.9% | 69 | 88.4% | 48.0% | 94.7% |
| 0.85 | 51.4% | 68 | 88.2% | 40.0% | 93.9% |
| 0.9 | 22.1% | 63 | 90.5% | 24.0% | 95.0% |
| 0.95 | 9.6% | 50 | 98.0% | 4.0% | 98.1% |
