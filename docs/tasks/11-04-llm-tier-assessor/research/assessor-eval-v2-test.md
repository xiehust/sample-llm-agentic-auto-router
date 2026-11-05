# Tier assessor offline eval

Pack: assessor/v2+3893290b1a13

> SWE-bench Verified (princeton-nlp/SWE-bench_Verified): no licence declared on the dataset card; SWE-bench code is MIT; issue texts come from 12 upstream projects. Used for offline evaluation only; no issue text is reproduced here (instance ids and aggregates only).

## Summary

| model | variant | dataset | n | coverage | acc. on opinions | fast pred | **fast precision** | frontier recall | no opinion | unavailable | p50 ms | p95 ms | >1.5 s | mean $/assess | cached in |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| global.openai.gpt-6-luna | v2 | hand | 80 | 95.0% | 98.7% | 40 | **100.0%** | 83.3% | 5.0% | 0 | 1183 | 1353 | 0.0% | $0.000372 | 61.2% |
| global.openai.gpt-6-luna | v2 | swebench | 383 | 86.2% | 78.8% | 1 | **0.0%** | 55.6% | 13.6% | 1 | 1301 | 1454 | 2.6% | $0.000784 | 1.7% |
| global.openai.gpt-6-luna | v2 | traj | 80 | 61.3% | 91.8% | 22 | **95.5%** | 57.1% | 38.8% | 0 | 1235 | 1431 | 1.5% | $0.000462 | 46.8% |
| global.openai.gpt-6-luna | v2 | all | 543 | 83.8% | 83.5% | 63 | **96.8%** | 66.0% | 16.0% | 1 | 1286 | 1434 | 2.1% | $0.000682 | 15.6% |

## Threshold recommendation

- **global.openai.gpt-6-luna v2**: 0.5 — lowest threshold with fast precision ≥ 0.95 (95.3% on 64 fast calls), coverage 96.7%

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
| standard | 1 | 250 | 63 | 50 | 1 |
| frontier | 0 | 6 | 10 | 2 | 0 |

Cost: total $0.300343, mean $0.000784, p95 $0.000890; mean tokens in 5538 / out 206.
Unavailable by code: parse 1.
Soft signal: 0 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:sympy__sympy-13798

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 99.7% | 1 | 0.0% | 61.1% | 77.2% |
| 0.6 | 99.7% | 1 | 0.0% | 61.1% | 77.2% |
| 0.7 | 99.0% | 1 | 0.0% | 61.1% | 77.3% |
| 0.75 | 98.2% | 1 | 0.0% | 61.1% | 77.4% |
| 0.8 | 86.2% | 1 | 0.0% | 55.6% | 78.8% |
| 0.85 | 57.4% | 1 | 0.0% | 27.8% | 81.8% |
| 0.9 | 12.8% | 0 | — | 5.6% | 85.7% |
| 0.95 | 0.0% | 0 | — | 0.0% | 0.0% |

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
| standard | 2 | 286 | 64 | 70 | 1 |
| frontier | 0 | 7 | 33 | 10 | 0 |

Cost: total $0.360611, mean $0.000682, p95 $0.000874; mean tokens in 5433 / out 200.
Unavailable by code: parse 1.
Soft signal: 0 fast predictions on SWE-bench '<15 min fix' items.
Fast false positives: swe:sympy__sympy-13798, tj-08#t2

| threshold | coverage | fast pred | fast precision | frontier recall | acc. on opinions |
|---|---|---|---|---|---|
| 0.5 | 96.7% | 64 | 95.3% | 78.0% | 81.5% |
| 0.6 | 96.5% | 64 | 95.3% | 78.0% | 81.5% |
| 0.7 | 95.6% | 64 | 95.3% | 78.0% | 81.5% |
| 0.75 | 94.8% | 64 | 95.3% | 76.0% | 81.6% |
| 0.8 | 83.8% | 63 | 96.8% | 66.0% | 83.5% |
| 0.85 | 58.9% | 60 | 98.3% | 44.0% | 87.2% |
| 0.9 | 22.7% | 56 | 100.0% | 22.0% | 94.3% |
| 0.95 | 8.8% | 47 | 100.0% | 2.0% | 100.0% |
