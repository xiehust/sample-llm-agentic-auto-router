# Tier assessor offline eval

Pack: assessor/v1+ee49d3c06e8d

> SWE-bench Verified (princeton-nlp/SWE-bench_Verified): no licence declared on the dataset card; SWE-bench code is MIT; issue texts come from 12 upstream projects. Used for internal evaluation only; no issue text is reproduced here (instance ids and aggregates only).

## Summary

| model | variant | dataset | n | coverage | acc. on opinions | fast pred | **fast precision** | frontier recall | no opinion | unavailable | p50 ms | p95 ms | >1.5 s | mean $/assess | cached in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| global.openai.gpt-6-luna | default | hand | 80 | 96.3% | 98.7% | 40 | **100.0%** | 88.9% | 3.8% | 0 | 1288 | 1465 | 3.8% | $0.000286 | 66.2% |
| global.openai.gpt-6-luna | default | swebench | 500 | 73.8% | 90.2% | 8 | **0.0%** | 0.0% | 24.6% | 8 | 1273 | 1946 | 12.0% | $0.000644 | 1.3% |
| global.openai.gpt-6-luna | default | traj | 80 | 61.3% | 91.8% | 22 | **95.5%** | 57.1% | 38.8% | 0 | 1235 | 1510 | 6.1% | $0.000379 | 46.8% |
| global.openai.gpt-6-luna | default | all | 660 | 75.0% | 91.7% | 70 | **87.1%** | 31.2% | 23.8% | 8 | 1266 | 1778 | 10.4% | $0.000572 | 13.2% |
| global.anthropic.claude-haiku-5-5 | default | hand | 80 | 86.3% | 100.0% | 35 | **100.0%** | 83.3% | 5.0% | 7 | 2405 | 10002 | 100.0% | $0.000312 | 93.9% |
| global.anthropic.claude-haiku-5-5 | default | swebench | 500 | 66.4% | 93.4% | 2 | **0.0%** | 0.0% | 25.4% | 41 | 2637 | 10001 | 100.0% | $0.000398 | 86.2% |
| global.anthropic.claude-haiku-5-5 | default | traj | 80 | 47.5% | 94.7% | 16 | **100.0%** | 21.4% | 42.5% | 8 | 2456 | 10001 | 100.0% | $0.000373 | 87.0% |
| global.anthropic.claude-haiku-5-5 | default | all | 660 | 66.5% | 94.5% | 53 | **96.2%** | 23.4% | 25.0% | 56 | 2607 | 10001 | 100.0% | $0.000385 | 87.2% |
| global.openai.gpt-6-luna | low | hand | 26 | 92.3% | 100.0% | 14 | **100.0%** | 80.0% | 7.7% | 0 | 1363 | 1828 | 38.5% | $0.000485 | 26.9% |
| global.openai.gpt-6-luna | low | swebench | 155 | 81.3% | 85.7% | 6 | **0.0%** | 0.0% | 18.7% | 0 | 1708 | 2281 | 67.1% | $0.000682 | 1.2% |
| global.openai.gpt-6-luna | low | all | 181 | 82.9% | 88.0% | 20 | **70.0%** | 21.1% | 17.1% | 0 | 1666 | 2261 | 63.0% | $0.000654 | 4.6% |

## Threshold recommendation

- **global.openai.gpt-6-luna default**: 0.95 — lowest threshold with fast precision ≥ 0.95 (96.1% on 51 fast calls), coverage 8.0%
- **global.anthropic.claude-haiku-5-5 default**: 0.5 — lowest threshold with fast precision ≥ 0.95 (96.2% on 53 fast calls), coverage 88.0%
- **global.openai.gpt-6-luna low**: 0.95 — no threshold reaches fast precision ≥ 0.95 with ≥ 5 fast predictions; keep fast rules in observe

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
| standard | 8 | 333 | 0 | 107 | 7 |
| frontier | 0 | 28 | 0 | 16 | 1 |

Cost: total $0.316879, mean $0.000644, p95 $0.000745; mean tokens in 4379 / out 207.
Unavailable by code: timeout 8.
Soft signal: 5 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:django__django-11099, swe:django__django-11163, swe:django__django-13658, swe:django__django-14672, swe:django__django-15554, swe:pytest-dev__pytest-5809, swe:pytest-dev__pytest-7982, swe:sympy__sympy-16886

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 96.6% | 9 | 0.0% | 0.0% | 88.0% |
| 0.6 | 95.8% | 9 | 0.0% | 0.0% | 88.1% |
| 0.7 | 93.0% | 9 | 0.0% | 0.0% | 88.8% |
| 0.75 | 88.2% | 9 | 0.0% | 0.0% | 88.7% |
| 0.8 | 73.8% | 8 | 0.0% | 0.0% | 90.2% |
| 0.85 | 43.4% | 8 | 0.0% | 0.0% | 88.9% |
| 0.9 | 9.6% | 7 | 0.0% | 0.0% | 83.3% |
| 0.95 | 0.4% | 2 | 0.0% | 0.0% | 0.0% |

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
| standard | 9 | 369 | 1 | 127 | 7 |
| frontier | 0 | 29 | 24 | 23 | 1 |

Cost: total $0.364800, mean $0.000572, p95 $0.000738; mean tokens in 4288 / out 202.
Unavailable by code: timeout 8.
Soft signal: 5 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:django__django-11099, swe:django__django-11163, swe:django__django-13658, swe:django__django-14672, swe:django__django-15554, swe:pytest-dev__pytest-5809, swe:pytest-dev__pytest-7982, swe:sympy__sympy-16886, tj-08#t2

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 94.5% | 72 | 84.7% | 33.8% | 89.4% |
| 0.6 | 93.8% | 72 | 84.7% | 33.8% | 89.5% |
| 0.7 | 91.4% | 72 | 84.7% | 33.8% | 90.0% |
| 0.75 | 87.4% | 72 | 84.7% | 33.8% | 90.1% |
| 0.8 | 75.0% | 70 | 87.1% | 31.2% | 91.7% |
| 0.85 | 50.2% | 69 | 87.0% | 26.0% | 91.2% |
| 0.9 | 19.5% | 64 | 89.1% | 15.6% | 93.8% |
| 0.95 | 8.0% | 51 | 96.1% | 2.6% | 96.2% |

## global.anthropic.claude-haiku-5-5 · default · hand

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 35 | 0 | 0 | 1 | 4 |
| standard | 0 | 19 | 0 | 1 | 2 |
| frontier | 0 | 0 | 15 | 2 | 1 |

Cost: total $0.022794, mean $0.000312, p95 $0.000334; mean tokens in 7089 / out 405.
Unavailable by code: timeout 7.

| category | n | correct | no opinion |
|---|---|---|---|
| explore | 20 | 18 | 1 |
| mechanical | 15 | 14 | 0 |
| bounded | 20 | 18 | 0 |
| deep | 15 | 13 | 1 |
| confusable | 6 | 3 | 2 |
| injection | 4 | 3 | 0 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 90.0% | 35 | 100.0% | 94.4% | 100.0% |
| 0.6 | 90.0% | 35 | 100.0% | 94.4% | 100.0% |
| 0.7 | 90.0% | 35 | 100.0% | 94.4% | 100.0% |
| 0.75 | 86.3% | 35 | 100.0% | 83.3% | 100.0% |
| 0.8 | 86.3% | 35 | 100.0% | 83.3% | 100.0% |
| 0.85 | 71.3% | 35 | 100.0% | 44.4% | 100.0% |
| 0.9 | 38.8% | 29 | 100.0% | 11.1% | 100.0% |
| 0.95 | 0.0% | 0 | — | 0.0% | 0.0% |

## global.anthropic.claude-haiku-5-5 · default · swebench

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 0 | 0 | 0 | 0 | 0 |
| standard | 2 | 310 | 2 | 104 | 37 |
| frontier | 0 | 18 | 0 | 23 | 4 |

Cost: total $0.184413, mean $0.000398, p95 $0.000519; mean tokens in 7721 / out 451.
Unavailable by code: timeout 37, invalid 4.
Soft signal: 2 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:scikit-learn__scikit-learn-14141, swe:sympy__sympy-16886

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 91.8% | 2 | 0.0% | 13.3% | 87.6% |
| 0.6 | 91.6% | 2 | 0.0% | 13.3% | 87.8% |
| 0.7 | 89.2% | 2 | 0.0% | 11.1% | 89.0% |
| 0.75 | 68.4% | 2 | 0.0% | 0.0% | 93.3% |
| 0.8 | 66.4% | 2 | 0.0% | 0.0% | 93.4% |
| 0.85 | 8.8% | 1 | 0.0% | 0.0% | 97.7% |
| 0.9 | 0.2% | 1 | 0.0% | 0.0% | 0.0% |
| 0.95 | 0.0% | 0 | — | 0.0% | 0.0% |

## global.anthropic.claude-haiku-5-5 · default · traj

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 16 | 1 | 0 | 11 | 2 |
| standard | 0 | 17 | 0 | 16 | 3 |
| frontier | 0 | 1 | 3 | 7 | 3 |

Cost: total $0.021662, mean $0.000373, p95 $0.001076; mean tokens in 7125 / out 415.
Unavailable by code: timeout 8.

Hint stability over 16 trajectories (64 consecutive-turn transitions):

| measure | value |
|---|---|
| raw flip rate (both turns have an opinion) | 41.2% (7/17) |
| held flip rate (served hint; no opinion keeps the current tier) | 17.0% (9/53) |
| held downgrade flips | 6 |
| downgrade reversed by an upgrade on the next turn | 0 |
| spurious flips (gold unchanged) | 6.3% (2/32) |
| gold changes followed on that turn | 52.4% (11/21) |
| flips at gold-change (boundary) transitions | 77.8% of flips (7/9); boundary transitions are 39.6% of all |
| held flips by turn index (t1..t4) | t1 0/11, t2 6/14, t3 3/14, t4 0/14 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 62.5% | 16 | 100.0% | 50.0% | 92.0% |
| 0.6 | 62.5% | 16 | 100.0% | 50.0% | 92.0% |
| 0.7 | 60.0% | 16 | 100.0% | 35.7% | 91.7% |
| 0.75 | 50.0% | 16 | 100.0% | 21.4% | 95.0% |
| 0.8 | 47.5% | 16 | 100.0% | 21.4% | 94.7% |
| 0.85 | 25.0% | 14 | 100.0% | 7.1% | 100.0% |
| 0.9 | 6.3% | 5 | 100.0% | 0.0% | 100.0% |
| 0.95 | 0.0% | 0 | — | 0.0% | 0.0% |

## global.anthropic.claude-haiku-5-5 · default · all

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 51 | 1 | 0 | 12 | 6 |
| standard | 2 | 346 | 2 | 121 | 42 |
| frontier | 0 | 19 | 18 | 32 | 8 |

Cost: total $0.228868, mean $0.000385, p95 $0.000516; mean tokens in 7585 / out 442.
Unavailable by code: timeout 52, invalid 4.
Soft signal: 2 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:scikit-learn__scikit-learn-14141, swe:sympy__sympy-16886

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 88.0% | 53 | 96.2% | 39.0% | 89.5% |
| 0.6 | 87.9% | 53 | 96.2% | 39.0% | 89.7% |
| 0.7 | 85.8% | 53 | 96.2% | 35.1% | 90.6% |
| 0.75 | 68.3% | 53 | 96.2% | 23.4% | 94.5% |
| 0.8 | 66.5% | 53 | 96.2% | 23.4% | 94.5% |
| 0.85 | 18.3% | 50 | 98.0% | 11.7% | 99.2% |
| 0.9 | 5.6% | 35 | 97.1% | 2.6% | 97.3% |
| 0.95 | 0.0% | 0 | — | 0.0% | 0.0% |

## global.openai.gpt-6-luna · low · hand

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 14 | 0 | 0 | 0 | 0 |
| standard | 0 | 6 | 0 | 1 | 0 |
| frontier | 0 | 0 | 4 | 1 | 0 |

Cost: total $0.012614, mean $0.000485, p95 $0.000652; mean tokens in 3973 / out 223.

| category | n | correct | no opinion |
|---|---|---|---|
| explore | 6 | 6 | 0 |
| mechanical | 5 | 5 | 0 |
| bounded | 6 | 6 | 0 |
| deep | 5 | 4 | 1 |
| confusable | 2 | 1 | 1 |
| injection | 2 | 2 | 0 |

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 14 | 100.0% | 80.0% | 96.2% |
| 0.6 | 100.0% | 14 | 100.0% | 80.0% | 96.2% |
| 0.7 | 96.2% | 14 | 100.0% | 80.0% | 96.0% |
| 0.75 | 96.2% | 14 | 100.0% | 80.0% | 96.0% |
| 0.8 | 92.3% | 14 | 100.0% | 80.0% | 100.0% |
| 0.85 | 84.6% | 14 | 100.0% | 80.0% | 100.0% |
| 0.9 | 76.9% | 14 | 100.0% | 60.0% | 100.0% |
| 0.95 | 53.8% | 13 | 100.0% | 20.0% | 100.0% |

## global.openai.gpt-6-luna · low · swebench

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 0 | 0 | 0 | 0 | 0 |
| standard | 6 | 108 | 1 | 26 | 0 |
| frontier | 0 | 11 | 0 | 3 | 0 |

Cost: total $0.105716, mean $0.000682, p95 $0.000801; mean tokens in 4371 / out 283.
Soft signal: 6 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:django__django-11163, swe:django__django-14376, swe:django__django-16139, swe:django__django-9296, swe:pytest-dev__pytest-5809, swe:sympy__sympy-16886

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 6 | 0.0% | 7.1% | 87.1% |
| 0.6 | 100.0% | 6 | 0.0% | 7.1% | 87.1% |
| 0.7 | 99.4% | 6 | 0.0% | 7.1% | 87.0% |
| 0.75 | 97.4% | 6 | 0.0% | 7.1% | 86.8% |
| 0.8 | 81.3% | 6 | 0.0% | 0.0% | 85.7% |
| 0.85 | 50.3% | 6 | 0.0% | 0.0% | 87.2% |
| 0.9 | 10.3% | 3 | 0.0% | 0.0% | 81.3% |
| 0.95 | 1.3% | 2 | 0.0% | 0.0% | 0.0% |

## global.openai.gpt-6-luna · low · all

| gold \ predicted | fast | standard | frontier | none | unavailable |
|---|---|---|---|---|---|
| fast | 14 | 0 | 0 | 0 | 0 |
| standard | 6 | 114 | 1 | 27 | 0 |
| frontier | 0 | 11 | 4 | 4 | 0 |

Cost: total $0.118330, mean $0.000654, p95 $0.000781; mean tokens in 4313 / out 275.
Soft signal: 6 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:django__django-11163, swe:django__django-14376, swe:django__django-16139, swe:django__django-9296, swe:pytest-dev__pytest-5809, swe:sympy__sympy-16886

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 20 | 70.0% | 26.3% | 88.4% |
| 0.6 | 100.0% | 20 | 70.0% | 26.3% | 88.4% |
| 0.7 | 98.9% | 20 | 70.0% | 26.3% | 88.3% |
| 0.75 | 97.2% | 20 | 70.0% | 26.3% | 88.1% |
| 0.8 | 82.9% | 20 | 70.0% | 21.1% | 88.0% |
| 0.85 | 55.2% | 20 | 70.0% | 21.1% | 90.0% |
| 0.9 | 19.9% | 17 | 82.4% | 15.8% | 91.7% |
| 0.95 | 8.8% | 15 | 86.7% | 5.3% | 87.5% |
