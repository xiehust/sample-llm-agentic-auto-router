### (A) SYNTHETIC — sub-agent intent: `intent-blind` vs `core-cost-subfast`

| Sub-agent share (realized) | Idle | Claude TTL | intent-blind $ | core-cost-subfast $ | Advantage | intent-blind sw/100 | core-cost-subfast sw/100 | intent-blind cold-write $ | core-cost-subfast cold-write $ | intent-blind intent adherence | core-cost-subfast intent adherence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4% (3.9%) | default | 5m | 683.72 | 683.72 | +0.0% | 0.00 | 0.00 | 263.83 | 263.83 | — | — |
| 4% (3.9%) | default | 1h | 526.40 | 526.40 | +0.0% | 0.00 | 0.00 | 24.97 | 24.97 | — | — |
| 4% (3.9%) | heavy | 5m | 909.70 | 909.70 | +0.0% | 0.00 | 0.00 | 489.81 | 489.81 | — | — |
| 4% (3.9%) | heavy | 1h | 614.67 | 614.67 | +0.0% | 0.00 | 0.00 | 113.23 | 113.23 | — | — |
| 8% (7.6%) | default | 5m | 546.02 | 546.02 | +0.0% | 0.00 | 0.00 | 191.27 | 191.27 | — | — |
| 8% (7.6%) | default | 1h | 449.80 | 449.80 | +0.0% | 0.00 | 0.00 | 20.68 | 20.68 | — | — |
| 8% (7.6%) | heavy | 5m | 719.55 | 719.55 | +0.0% | 0.00 | 0.00 | 364.80 | 364.80 | — | — |
| 8% (7.6%) | heavy | 1h | 513.16 | 513.16 | +0.0% | 0.00 | 0.00 | 84.04 | 84.04 | — | — |
| 16% (13.5%) | default | 5m | 591.70 | 591.70 | +0.0% | 0.00 | 0.00 | 214.53 | 214.53 | — | — |
| 16% (13.5%) | default | 1h | 478.58 | 478.58 | +0.0% | 0.00 | 0.00 | 22.95 | 22.95 | — | — |
| 16% (13.5%) | heavy | 5m | 757.09 | 757.09 | +0.0% | 0.00 | 0.00 | 379.92 | 379.92 | — | — |
| 16% (13.5%) | heavy | 1h | 528.64 | 528.64 | +0.0% | 0.00 | 0.00 | 73.01 | 73.01 | — | — |

Advantage of cost-modeled (positive = cheaper): 0.0% … 0.0%.

### (B) SYNTHETIC — per-turn intent (cooperative hints.tier): `hint-blind` vs `core-cost`

| Pair main→alt, alt share | Idle | Claude TTL | hint-blind $ | core-cost $ | Advantage | hint-blind sw/100 | core-cost sw/100 | hint-blind cold-write $ | core-cost cold-write $ | hint-blind intent adherence | core-cost intent adherence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| standard→fast, 15% | default | 5m | 606.09 | 605.15 | +0.2% | 1.99 | 1.91 | 206.23 | 204.30 | 100% | 99% |
| standard→fast, 15% | default | 1h | 548.80 | 548.49 | +0.1% | 1.99 | 1.66 | 52.50 | 46.06 | 100% | 98% |
| standard→fast, 15% | heavy | 5m | 744.88 | 744.77 | +0.0% | 1.99 | 1.95 | 345.02 | 344.58 | 100% | 100% |
| standard→fast, 15% | heavy | 1h | 616.64 | 611.66 | +0.8% | 1.99 | 1.53 | 120.34 | 107.98 | 100% | 97% |
| standard→fast, 30% | default | 5m | 570.95 | 571.11 | -0.0% | 3.28 | 2.95 | 211.01 | 205.34 | 100% | 97% |
| standard→fast, 30% | default | 1h | 522.11 | 528.06 | -1.1% | 3.28 | 2.52 | 75.78 | 65.55 | 100% | 94% |
| standard→fast, 30% | heavy | 5m | 675.97 | 675.44 | +0.1% | 3.28 | 3.12 | 316.04 | 313.54 | 100% | 99% |
| standard→fast, 30% | heavy | 1h | 591.45 | 590.11 | +0.2% | 3.28 | 2.48 | 145.14 | 126.12 | 100% | 93% |
| frontier→standard, 15% | default | 5m | 1191.37 | 1150.24 | +3.5% | 1.99 | 0.97 | 455.04 | 393.78 | 100% | 94% |
| frontier→standard, 15% | default | 1h | 1052.78 | 1009.32 | +4.1% | 1.99 | 0.43 | 148.63 | 71.95 | 100% | 90% |
| frontier→standard, 15% | heavy | 5m | 1471.58 | 1453.91 | +1.2% | 1.99 | 1.51 | 735.26 | 709.89 | 100% | 98% |
| frontier→standard, 15% | heavy | 1h | 1200.31 | 1132.45 | +5.7% | 1.99 | 0.55 | 296.17 | 199.02 | 100% | 91% |
| frontier→standard, 30% | default | 5m | 1176.86 | 1124.48 | +4.5% | 3.28 | 1.84 | 495.00 | 404.51 | 100% | 89% |
| frontier→standard, 30% | default | 1h | 1044.07 | 1006.84 | +3.6% | 3.28 | 0.93 | 205.96 | 102.17 | 100% | 82% |
| frontier→standard, 30% | heavy | 5m | 1398.50 | 1377.02 | +1.5% | 3.28 | 2.68 | 716.66 | 683.23 | 100% | 96% |
| frontier→standard, 30% | heavy | 1h | 1206.39 | 1127.06 | +6.6% | 3.28 | 1.14 | 368.30 | 229.59 | 100% | 84% |

Advantage standard→fast: -1.1% … 0.8%.

Advantage frontier→standard: 1.2% … 6.6%.

#### Sensitivity (standard→fast): count gates on (defaults) vs off for hint-driven downgrades

Not a recommendation: the defaults (minTurnsBeforeSwitch 2, maxSwitchesPerLineage 6) are kept. "off" sets minTurnsBeforeSwitch 0 and no switch cap; the cost gate still applies.

| Cell | core-cost $ (defaults) | core-cost $ (count gates off) | Δ off vs defaults | sw/100 defaults | sw/100 off | cold-write $ defaults | cold-write $ off | intent adherence defaults | intent adherence off |
|---|---|---|---|---|---|---|---|---|---|
| 15% default 5m | 605.15 | 606.09 | +0.2% | 1.91 | 1.99 | 204.30 | 206.23 | 99% | 100% |
| 15% default 1h | 548.49 | 546.71 | -0.3% | 1.66 | 1.77 | 46.06 | 46.47 | 98% | 99% |
| 15% heavy 5m | 744.77 | 744.88 | +0.0% | 1.95 | 1.99 | 344.58 | 345.02 | 100% | 100% |
| 15% heavy 1h | 611.66 | 611.26 | -0.1% | 1.53 | 1.65 | 107.98 | 109.44 | 97% | 98% |
| 30% default 5m | 571.11 | 570.95 | -0.0% | 2.95 | 3.28 | 205.34 | 211.01 | 97% | 100% |
| 30% default 1h | 528.06 | 520.53 | -1.4% | 2.52 | 3.10 | 65.55 | 70.11 | 94% | 99% |
| 30% heavy 5m | 675.44 | 675.97 | +0.1% | 3.12 | 3.28 | 313.54 | 316.04 | 99% | 100% |
| 30% heavy 1h | 590.11 | 588.18 | -0.3% | 2.48 | 2.92 | 126.12 | 132.68 | 93% | 97% |

#### Gate analysis (core-cost, per hinted switch request at a user turn; cost = that turn + the lineage's next turn)

| Cell | Requests | Allowed (down/up) | Blocked (down/up) | Allowed: core $ vs blind $ | Blocked: core $ vs blind $ | Blocked turn calls p50/p90 | Blocked prompt p50/p90 | Block reasons |
|---|---|---|---|---|---|---|---|---|
| standard→fast 15% default 5m | 447 | 214/219 | 14/0 | 219.42 vs 218.81 | 4.02 vs 4.62 | 5/10 | 98K/212K | downgrade-rejected 14 |
| standard→fast 15% default 1h | 427 | 176/195 | 56/0 | 121.27 vs 119.30 | 22.42 vs 22.46 | 5/13 | 188K/245K | downgrade-rejected 56 |
| standard→fast 15% heavy 5m | 449 | 220/223 | 6/0 | 262.20 vs 262.10 | 1.99 vs 2.10 | 3/9 | 85K/143K | downgrade-rejected 6 |
| standard→fast 15% heavy 1h | 412 | 164/180 | 68/0 | 142.44 vs 142.37 | 32.16 vs 36.32 | 6/13 | 188K/240K | downgrade-rejected 68 |
| standard→fast 30% default 5m | 729 | 324/344 | 61/0 | 325.78 vs 322.95 | 17.96 vs 16.82 | 5/15 | 107K/212K | downgrade-rejected 61 |
| standard→fast 30% default 1h | 708 | 264/300 | 144/0 | 188.01 vs 181.35 | 50.93 vs 42.69 | 5/15 | 143K/236K | downgrade-rejected 144 |
| standard→fast 30% heavy 5m | 733 | 349/360 | 24/0 | 387.74 vs 386.89 | 9.59 vs 10.12 | 5/11 | 106K/181K | downgrade-rejected 24 |
| standard→fast 30% heavy 1h | 704 | 261/295 | 148/0 | 230.75 vs 226.16 | 63.14 vs 61.63 | 6/16 | 166K/235K | downgrade-rejected 148 |
| frontier→standard 15% default 5m | 359 | 96/120 | 143/0 | 222.34 vs 222.71 | 116.20 vs 156.24 | 5/13 | 126K/218K | downgrade-rejected 143 |
| frontier→standard 15% default 1h | 315 | 25/67 | 223/0 | 86.20 vs 85.77 | 139.22 vs 179.01 | 6/14 | 114K/209K | downgrade-rejected 223 |
| frontier→standard 15% heavy 5m | 404 | 164/177 | 63/0 | 434.29 vs 434.90 | 60.40 vs 78.07 | 6/12 | 126K/212K | downgrade-rejected 63 |
| frontier→standard 15% heavy 1h | 323 | 42/78 | 203/0 | 152.23 vs 152.18 | 138.27 vs 203.64 | 5/13 | 111K/207K | downgrade-rejected 203 |
| frontier→standard 30% default 5m | 655 | 181/228 | 246/0 | 427.88 vs 428.11 | 201.18 vs 246.95 | 6/15 | 126K/213K | downgrade-rejected 246 |
| frontier→standard 30% default 1h | 606 | 61/138 | 407/0 | 174.51 vs 171.36 | 263.84 vs 285.93 | 5/15 | 117K/212K | downgrade-rejected 407 |
| frontier→standard 30% heavy 5m | 702 | 292/314 | 96/0 | 750.48 vs 753.19 | 91.99 vs 112.21 | 5/13 | 124K/205K | downgrade-rejected 96 |
| frontier→standard 30% heavy 1h | 617 | 92/158 | 367/0 | 289.41 vs 290.03 | 261.70 vs 328.65 | 5/15 | 113K/211K | downgrade-rejected 367 |
