# Tier assessor: offline eval and live results (2026-11-04)

Files:
- `smoke.md`: the live smoke test.
- `assessor-eval.{json,md}`: the full report, with confusion matrices, threshold sweeps, per-category results, false-positive ids and stability tables.

| Setting | Value |
|---|---|
| Pack | `assessor/v1+ee49d3c06e8d` |
| Region | bedrock-runtime ap-northeast-1, model invocations only |
| Account | caller account checked to equal `LLMAR_SPIKE_ACCOUNT` before any call |
| Eval timeout | 10 s, so the true latency is measured; the production default is 1.5 s |

> SWE-bench Verified (princeton-nlp/SWE-bench_Verified): the dataset card declares no licence, and the SWE-bench code is MIT. The issue texts come from 12 upstream projects. The data is used for internal evaluation only; this report reproduces no issue text (instance ids and aggregates only).

## Datasets

| Set | Items | Gold labels |
|---|---|---|
| SWE-bench Verified | 500 | `<15 min` and `15 min–1 h` → standard (455); `1–4 h` and `>4 h` → frontier (45) |
| Hand-labelled | 80 | 40 fast / 22 standard / 18 frontier; includes confusables and 4 prompt-injection attempts |
| Trajectories (hint stability) | 16 × 5 turns = 80 | per turn |

The hand-labelled and trajectory sets are disjoint from the few-shot examples (tested).

## Spend (ledger, costOf on returned usage)

| Run | Calls | $ |
|---|---|---|
| Smoke | 20 | 0.0128 |
| Luna, main | 580 | 0.3473 |
| Haiku 5.5, main | 580 | 0.2492 |
| Luna, trajectories | 80 | 0.0250 |
| Haiku 5.5, trajectories | 80 | 0.0290 |
| Luna `effort:low` | 181 | 0.1183 |
| **Total** | **1,521** | **$0.7817** (cap $1.80) |

## Results at the default threshold (0.8)

| Model | Set | Coverage | Acc. on opinions | Fast pred | **Fast precision** | Frontier recall | Unavailable | p50 / p95 ms | > 1.5 s | $/assessment |
|---|---|---|---|---|---|---|---|---|---|---|
| Luna (effort none) | hand | 96.3% | 98.7% | 40 | **100%** | 88.9% | 0 | 1288 / 1465 | 3.8% | 0.00029 |
| Luna | SWE-bench | 73.8% | 90.2% | 8 | **0%** (8 FP) | **0%** | 8 (timeouts) | 1273 / 1946 | 12% | 0.00064 |
| Luna | all (660) | 75.0% | 91.7% | 70 | **87.1%** | 31.2% | 8 | 1266 / 1778 | 10.4% | 0.00057 |
| Haiku 5.5 | hand | 86.3% | 100% | 35 | **100%** | 83.3% | 7 | 2405 / 10002 | 100% | 0.00031 |
| Haiku 5.5 | SWE-bench | 66.4% | 93.4% | 2 | **0%** (2 FP) | **0%** | 41 | 2637 / 10001 | 100% | 0.00040 |
| Haiku 5.5 | all (660) | 66.5% | 94.5% | 53 | **96.2%** | 23.4% | 56 (52 timeouts, 4 invalid) | 2607 / 10001 | 100% | 0.00039 |
| Luna effort low | sample (181) | 82.9% | 88.0% | 20 | **70%** | 21.1% | 0 | 1666 / 2261 | 63% | 0.00065 |

## Findings

1. **Fast-tier precision is perfect on hand-written tasks but not on real issues.**
   - On the hand-labelled set, fast precision is 100% for both models.
   - On SWE-bench, Luna puts 8/500 bug fixes on fast and Haiku 2/500. All 2 + 8 are standard-gold.
   - Several of these issues spell out the exact fix (e.g. `swe:django__django-11099`), so "fast" is defensible for them. Strictly, they still count as errors.
   - Luna's false positives come with high confidence. Raising the threshold therefore barely helps: precision reaches 0.95 only at threshold 0.95, with 8% coverage.
   - Haiku stays at ≥ 96% across the sweep.
   - Caveat: the hand set was written by the same author as the prompt pack, so it is optimistic.
2. **Neither model recognises SWE-bench frontier items** (1–4 h and > 4 h): 0/45 for both. They label them bounded-change → standard.
   - The 1h-plus difficulty of a GitHub issue isn't visible from the issue text alone, at least not against D's frontier rule ("unclear root cause across modules; concurrency/security/performance; design; large refactors; failed twice").
   - Frontier recall on hand-labelled deep investigations is 83–89%.
   - Treat the assessor as reliable at the fast boundary only. Frontier upgrades come mostly from the explicit signals: `prior_failures ≥ 2` and deep-investigation phrasing.
3. **Latency decides the default model. Luna fits; Haiku doesn't.**
   - Luna: p50 1.27 s, p95 1.78 s, 10% over 1.5 s.
   - Haiku 5.5: p50 2.6 s, every call over 1.5 s, and 9% of calls didn't answer within 10 s. Its prompt is about 7.1K Claude tokens against Luna's 4.0K, and it writes about 405 output tokens against Luna's 200.
   - Haiku works only as a configured alternative with a longer budget, or with an asynchronous assessment applied from the next turn.
4. **`effort: low` on Luna is worse on every measure:**

   | Effort | p50 | Fast precision | $ / assessment |
   |---|---|---|---|
   | none (default) | 1.27 s | 87% | 0.00057 |
   | low | 1.67 s | 70% | 0.00065 |

   Keep `none`.
5. **Cost per assessment is about $0.0003–0.0006.**
   - Luna's implicit cache hit rate was erratic: 66% on hand items, 1% on SWE-bench (concurrent).
   - Haiku's explicit breakpoint gives 87% cached input.
   - Cost is negligible next to the routing effect (below).
6. **Prompt injection had little effect: 4 attempts, Luna 4/4 correct, Haiku 3/4.** The tier comes from the facts and the rule judgements, so instructions inside the card don't control it directly.

## Threshold recommendation

Keep the default at **0.8** and keep **every rule in observe mode** (`auto:false`) for now.
- At 0.8, Luna has 75% coverage and 87% fast precision overall (100% hand-labelled, with 8 SWE false positives).
- Raising Luna's threshold buys too little precision for the coverage lost:

  | Threshold | Fast precision | Coverage |
  |---|---|---|
  | 0.8 | 87% | 75% |
  | 0.9 | 89% | 20% |
  | 0.95 | 96% | 8% |

- Haiku reaches ≥ 95% precision at every threshold from 0.5 to 0.9, but its latency rules it out at 1.5 s.
- Before turning on `auto` for `explore-readonly` / `mechanical-edit`, tighten `mechanical-edit` in pack v2: an issue that only *suggests* a fix is not a specified change. Then re-measure the SWE false positives.

## Hint stability (16 five-turn trajectories, 64 transitions per model)

| Measure | Luna | Haiku 5.5 |
|---|---|---|
| Held flip rate (served hint; no opinion keeps the current tier, as core does) | 25.0% (16/64) | 17.0% (9/53) |
| Raw flip rate (both turns have an opinion) | 39.1% (9/23) | 41.2% (7/17) |
| Spurious flips (gold unchanged) | **8.1%** (3/37) | **6.3%** (2/32) |
| Flips at gold-change (boundary) transitions | **81% of flips** (13/16) | **78% of flips** (7/9) |
| Boundary transitions as a share of all transitions | 42% | 40% |
| Downgrade flips / reversed by an upgrade on the next turn | 10 / **0** | 6 / **0** |
| Gold changes followed on that turn | 56% | 52% |
| Held flips by turn index (t1 / t2 / t3 / t4) | 2 / 9 / 2 / 3 | 0 / 6 / 3 / 0 |

**Flips cluster on boundary turns; they are not uniform.**
- About 80% of flips happen at transitions where the work changes kind (gold changes), and those are only about 40% of transitions.
- Away from boundaries the flip rate is 6–8% per transition.
- No downgrade was reversed on the next turn: no oscillation was observed.
- The turn-2 peak follows from the dataset design, where many trajectories change task at t2.
- Two caveats:
  - Acknowledgement turns ("ok", "thanks") are skipped by the precheck and hold the tier, so a few gold changes cannot be followed by construction.
  - 16 trajectories is a small sample.
- **For the count-gate question:** the data supports letting hint-driven downgrades skip the count gates at boundary turns, with the cost gate kept. The spurious-flip rate of about 7% per transition is the residual risk. This remains a decision for 0c / 0d; the replay sensitivity row showed −1.4…+0.2% cost.

## Cost effect in replay (SYNTHETIC; 400 sessions, seed 2026, 30% alt turns, default idle, 5m TTL)

Method:
- The trace's per-turn `hints.tier` is the true need.
- `hints` resamples each turn from the model's measured confusion row (hand + SWE-bench + trajectories). No opinion or unavailable removes the hint, so the pool default (standard) applies.
- Replay runs `hint-blind` and `core-cost`.

| Trace (gold pair) | Hints | hint-blind $ | core-cost $ | core-cost vs no hints | Fast / frontier calls (core-cost) |
|---|---|---|---|---|---|
| standard→fast | none (all standard) | 630.41 | 630.41 | — | 0 / 0 |
| standard→fast | perfect | 570.95 | 571.11 | −9.4% | 4,328 / 0 |
| standard→fast | **Luna-assessed** | 574.26 | **576.54** | **−8.5%** (90% of the ideal) | 4,254 / 178 |
| standard→fast | Haiku-assessed | 591.15 | 591.25 | −6.2% | 3,337 / 91 |
| frontier→standard | perfect | 1176.86 | 1124.48 | — | 0 / 12,778 |
| frontier→standard | Luna-assessed | 896.43 | 888.85 | cheaper, but **under-serves frontier** | 265 / 5,421 |
| frontier→standard | Haiku-assessed | 843.43 | 850.65 | cheaper, but under-serves frontier | 87 / 4,471 |

On the standard→fast trace:
- Luna's assessed hints capture about 90% of the ideal saving.
- Gold-standard turns that were assessed fast: Luna 52 of 2,566 turns (2.0%), Haiku 12 (0.5%).

On the frontier→standard trace, the low frontier recall shows up as cost "savings" that are really quality loss:
- Luna-assessed hints keep 42% of the frontier calls that perfect hints would serve.
- This matches finding 2.

## Code and tests

`pnpm -C packages/assessor typecheck && pnpm -C packages/assessor test`: green, 163 tests in 9 files (after the trellis-check hardening: ledger cap validation and per-call persistence, a true worst-case estimate, scrubbing of `_bdrk_` ids, unknown card keys rejected). This includes `contract.test.ts`, which is checked at compile time: `createAssessor` is assignable to core's `TierAssessor`, `assess()` returns core's `AssessorResult` with `costUsd`, `buildCard` accepts core's `CardContext`, and the card thunk fits `DecideExtras` and `Engine.decide`.

---

# Pack v2 (2026-11-05): tighter fast boundary, higher frontier recall, Luna only

Files:
- `assessor-eval-v1-test.{json,md}` and `assessor-eval-v2-test.{json,md}`: the headline comparison, on hand + held-out SWE-bench test split + trajectories.
- `assessor-eval-v2-all.{json,md}`: v2 on all 660 items.

Pack: `assessor/v2+3893290b1a13` (`prompts/assessor/v2/`). At the time the library default stayed v1 (`packDirs.v2` selects v2).

Changes:
- **mechanical-edit:** "an issue or bug report that describes wrong behaviour and suggests or sketches a fix is NOT a specified change". A reported fix counts as `partially` specified.
- **deep-investigation / `reasoning_depth: deep`:** now covers a bug that depends on several interacting components or on subtle semantics, with the cause not located, and a fix that needs a decision about intended behaviour or API.
- **bounded-change / `routine`:** a reproducible bug in one feature stays routine even when its cause is not yet located.
- **Few-shot examples:** three new ones, written for this pack (none from SWE-bench).

**Method:**
- SWE-bench is split by a hash of the instance id (`sweSplit`; `--swe-split dev|test`):
  - dev: 117 items, 27 frontier;
  - test: 383 items, 18 frontier.
- v2 was tuned in two iterations on dev only. The test split is held out and gives the headline numbers. Frontier recall on test rests on only 18 items.
- The hand-labelled and trajectory sets were written by the pack author, not drawn from any dataset, so they are optimistic for both packs.
- v1 numbers come from the earlier Luna run (same model, effort `none`, threshold 0.8).

## v1 vs v2 (Luna, threshold 0.8)

| Set | Metric | v1 | v2 |
|---|---|---|---|
| hand (80) | fast precision | 100% (40) | 100% (40) |
| | coverage | 96.3% | 95.0% |
| | frontier recall | 88.9% | 83.3% |
| SWE-bench test (383) | fast predictions (all false) | 7 | **1** |
| | coverage | 74.7% | 86.2% |
| | frontier recall | 0% (0/18) | **55.6% (10/18)** |
| | standard → frontier (false upgrades) | 0% (0/365) | **17.3% (63/365)** |
| | acc. on opinions | 94.1% | 78.8% |
| | unavailable | 6 | 1 |
| SWE-bench dev (117, tuning) | frontier recall / standard → frontier | 0% / 0% | 57.7% / 17.8% |
| trajectories (80) | fast precision | 95.5% | 95.5% |
| | held flip rate | 25.0% (16/64) | **18.8% (12/64)** |
| | raw flip rate | 39.1% | 40.7% |
| | spurious flips (gold unchanged) | 8.1% (3/37) | 8.1% (3/37) |
| | flips at boundary transitions | 81% | 75% |
| | gold changes followed | 55.6% | 48.1% |
| hand + SWE test + traj (543) | **fast precision** | 88.4% (69) | **96.8% (63)** |
| | **coverage** | 75.9% | **83.8%** |
| | **frontier recall** | 48.0% | **66.0%** |
| | acc. on opinions | 94.7% | 83.5% |
| | latency p50 / p95 | 1263 / 1778 ms | 1286 / 1434 ms |
| | > 1.5 s | 9.6% | 2.1% |
| | $/assessment | 0.00055 | 0.00068 (prompt +28%, 5.4K tokens) |

All 660 items under v2: fast precision 96.8%, coverage 84.4%, frontier recall 62.3%, standard → frontier 15.6% (80/513).

On trajectories the aggregate rows match v1 by coincidence. The runs are independent: 11 of 80 outcomes differ, and confidences shift.

## Frontier upgrades carry a real cost

The over-upgrades can't be separated offline.
- In v2 the deep-investigation rule and the `deep` fact always co-occur, so requiring both changes nothing.
- A frontier-only confidence threshold cuts false upgrades and recall together:

  | Frontier threshold | Standard → frontier | Frontier recall | Frontier precision |
  |---|---|---|---|
  | 0.8 | 17.3% | 55.6% | 14% |
  | 0.85 | 9.3% | 27.8% | 13% |
  | 0.9 | 1.9% | 5.6% | 13% |

- Caveat: SWE-bench gold is a coarse time-to-fix bucket. Some `15 min–1 h` items may truly need deep reasoning, so part of the 17% may be label noise. The data cannot tell.

**Replay (SYNTHETIC, 400 sessions, seed 2026, 30% alt turns, default idle, 5m TTL, current core preset `cost-modeled-v2`):** each turn's hint is resampled from the measured confusion rows, at seed 7.

| Trace | Hints | core-cost $ | vs no hints | Fast / standard / frontier calls |
|---|---|---|---|---|
| standard→fast | none | 630.41 | — | 0 / 22,710 / 0 |
| standard→fast | perfect | 570.80 | −9.5% | 4,684 / 18,026 / 0 |
| standard→fast | Luna v1 | 575.42 | −8.7% | 4,573 / 17,970 / 167 |
| standard→fast | **Luna v2** | **728.29** | **+15.5%** | 4,255 / 14,701 / **3,754** |
| frontier→standard | perfect | 1125.74 | — | 0 / 10,116 / 12,594 |
| frontier→standard | Luna v1 | 881.23 | under-serves frontier (39% of ideal frontier calls) | 270 / 17,516 / 4,924 |
| frontier→standard | **Luna v2** | 1062.20 | **87% of ideal frontier calls** | 90 / 11,645 / 10,975 |

v2 is a quality-for-cost trade:
- On the frontier→standard trace, v2 serves frontier calls more than twice as often as v1.
- On a workload with no frontier need, its false upgrades make assessed hints cost more than having no hints.

## Recommendation

1. **Don't make v2 the default as it stands.**
   - Its fast boundary is better than v1's: one SWE-bench false fast against seven, 96.8% fast precision, +8 points of coverage, and fewer held flips.
   - Its frontier signal is too noisy to drive upgrades: 14% precision on held-out SWE-bench.
2. **Recommended next step: a v2.1.** It would keep v2's mechanical-edit / `fully-specified` tightening and v1's frontier and `deep` definitions.
   - Expected result: v2's fast-side gains without the false frontier upgrades.
   - Verification: one Luna run on hand + SWE test + traj, 543 calls, about $0.36.
   - Not run. The ledger has $0.42 left of $1.80, and a run needs approval first.
3. **Wherever v2's frontier signal is used, keep it in observe mode.** All rules stay `auto:false`. Frontier upgrades should come from `prior_failures ≥ 2` and explicit signals, not from the assessor's depth judgement.

## Spend

| Run | Calls | $ |
|---|---|---|
| v2 dev iteration 1 (dev split + hand) | 197 | 0.1230 |
| v2 dev iteration 2 (dev split) | 117 | 0.0940 |
| v2 final (hand + SWE-bench + traj) | 660 | 0.3794 |
| **Ledger total** | | **$1.3782 of $1.80** |

---

# Pack v2.1 (2026-11-05): v2's fast-side tightening with v1's frontier definition

Files: `assessor-eval-v2.1-test.{json,md}` (hand + SWE-bench test split + trajectories, 543 items).

Pack: `assessor/v2.1` (`prompts/assessor/v2.1/`, `--pack v2.1`).
- From v2: the explore-readonly and mechanical-edit instructions, and the `fully-specified` definition.
- bounded-change: v1's text plus "a bug report that points to the faulty code or suggests a fix".
- From v1: the deep-investigation rule, the `routine` / `deep` definitions, and the frontier examples.
- Examples: v1's plus v2's suggested-fix → standard example.
- Every rule `auto:false`. The library default was v1 when this run was made.

Method:
- There was no live tuning. v2.1 is assembled from parts already measured on dev, and the remaining ledger only allowed one run.
- That one run was a single 543-call Luna eval on hand + SWE test + traj: $0.3165, all 543 calls ok, none stopped by the budget.

| Metric (Luna, threshold 0.8) | v1 | v2 | **v2.1** |
|---|---|---|---|
| Fast precision, hand + SWE test + traj | 88.4% (69) | 96.8% (63) | **98.3% (60)** |
| False fasts, SWE test (all fast calls there are false) | 7 | 1 | **1** |
| Fast precision, hand / traj | 100% / 95.5% | 100% / 95.5% | 100% / **100%** |
| Coverage, all 543 | 75.9% | 83.8% | 82.3% |
| Frontier recall, all 543 | 48.0% | 66.0% | 48.0% |
| Frontier recall, SWE test | 0/18 | 10/18 | 0/18 |
| Frontier recall, hand / traj | 88.9% / 57.1% | 83.3% / 57.1% | 83.3% / 64.3% |
| **Standard → frontier, SWE test** | 0/365 | 63/365 (17.3%) | **1/365 (0.3%)** |
| Acc. on opinions, all 543 | 94.7% | 83.5% | **95.5%** |
| Unavailable | 6 | 1 | 0 |
| Latency p50 / p95, ms | 1263 / 1778 | 1286 / 1434 | 1249 / 1435 |
| $/assessment | 0.00055 | 0.00068 | 0.00060 |
| Held flip rate, traj | 25.0% (16/64) | 18.8% (12/64) | 28.6% (18/63) |
| Spurious flips (gold unchanged), traj | 8.1% | 8.1% | 8.3% (3/36) |
| Share of flips at boundary transitions, traj | 81% | 75% | 83% |
| Gold changes followed, traj | 55.6% | 48.1% | 59.3% |

v2.1's extra held flips are mostly at boundary transitions, where the gold tier changes. Spurious flips stay at about 8%.

**Replay (SYNTHETIC, same setup as above).**
- Setup: core preset `cost-modeled-v2`, seed 7.
- Each pack's confusion rows come from the same 543 items, so the v1 and v2 rows here differ from the all-items table above.

| Trace | Hints | core-cost $ | vs no hints | Fast / standard / frontier calls | Turns resampled wrongly |
|---|---|---|---|---|---|
| standard→fast | none | 630.41 | — | 0 / 22,710 / 0 | |
| standard→fast | perfect | 570.80 | −9.5% | 4,684 / 18,026 / 0 | |
| standard→fast | Luna v1 | 571.80 | −9.3% | 4,568 / 18,099 / 43 | 53 standard turns → fast |
| standard→fast | Luna v2 | 723.36 | +14.7% | 4,270 / 14,794 / 3,646 | 396 standard turns → frontier |
| standard→fast | **Luna v2.1** | **583.61** | **−7.4%** | 4,093 / 18,515 / 102 | 6 → fast, 15 → frontier |
| frontier→standard | perfect | 1125.74 | — | 0 / 10,116 / 12,594 | |
| frontier→standard | Luna v1 | 975.18 | 57% of ideal frontier calls | 271 / 15,273 / 7,166 | |
| frontier→standard | Luna v2 | 1084.16 | 91% | 91 / 11,121 / 11,498 | |
| frontier→standard | **Luna v2.1** | 988.07 | 61% | 13 / 15,012 / 7,685 | |

Reading:
- On the standard→fast trace, v2.1 saves 7.4% where v1 saves 9.3%. The $11.81 gap is mostly quality, not waste: v1 sends 53 standard turns to fast and v2.1 sends 6, and v2.1 is more cautious on true fast turns.
- v2's false-upgrade cost is gone.
- Frontier coverage matches v1. The frontier signal comes from `prior_failures` and explicit deep-investigation phrasing, as in v1.

## Recommendation

1. **v2.1 is the better default candidate.** Against v1 it has:
   - higher fast precision (98.3% vs 88.4%) and higher coverage (82.3% vs 75.9%);
   - no false-upgrade cost, and frontier recall equal to v1;
   - lower p95 latency.
   - The cost: more held flips on trajectories (28.6% vs 25.0%), though most are at boundary turns.
2. **Keep every rule `auto:false`.** v2.1 has only 60 fast predictions and the hand set is by the pack author, so precision is optimistic. Before `auto` on `explore-readonly` / `mechanical-edit`, collect observe-mode data from real sessions.
3. **Decision (2026-11-05, 0c): v2.1 is the default pack** (`defaultPackDir` → `prompts/assessor/v2.1/`). `packDirs.v1` still selects v1, and every rule stays `auto:false`.

## Spend

| Run | Calls | $ |
|---|---|---|
| v2.1 final (hand + SWE test + traj) | 543 | 0.3165 |
| **Ledger total** | | **$1.6947 of $1.80** |
