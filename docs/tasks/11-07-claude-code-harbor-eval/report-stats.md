# Claude Code × Harbor, Sonnet 5.5 (A) vs Opus 5.5 (C), rep 1: report statistics (0d, 2026-11-07)

This is the final analysis under design-stats §15 and Amendments 7–9 (§16–§18). It is computed once, after both datasets were final; no earlier outcome look happened.

- **Script:** `experiments/claude-code-harbor/report_stats.py` (sha256 prefix 2507d18e98784515; first committed in a9b7db6 as 48206384…, which differs only in the §5.2 status string), run as `python3 -I`.
- **Estimators:** `experiments/codex-deepswe/stats.py`, with seed 20261105 and n_boot 10,000, as in the Codex reports.
- **Output:** `experiments/claude-code-harbor/results/report-stats.json` (gitignored; sha256 prefix 72e076e86b5de6f0). The a9b7db6 version, 65fe6dfa…, had the same numbers: only the §5.2 status string differs.
- **Inputs:** `results/{deepswe,tb21}/merged/` as merged by 0c from a84af4e, classifier VERSION 3a18f4db…ec973078.
  - DeepSWE: the memory-episode file, re-hashed against §17 (45d1bd8e…b146a1, which matches).
  - TB: lookupscan f462bb9a58e0e9c2 on 186/186 main attempts.
  - Codex rows: `experiments/{deepswe,tbench}-harbor/results/merged/rows.jsonl`.
  - The public DeepSWE v1.1 trials file is third-party and not committed.

## 1. Verdicts (§15.3)

| Dataset | Resolve (C − A) | Cost per run (C/A) | Pattern | Gap ≥ +10 pp? |
|---|---|---|---|---|
| **DeepSWE (primary dataset)** | INCONCLUSIVE: CI [−9.9, +8.1] pp | **NOT CONFIRMED**: CI lower 2.32 > 1.10 | **different pattern** (cost part) | no |
| **TB 2.1** | INCONCLUSIVE: CI [−4.8, +9.5] pp | **NOT CONFIRMED**: CI lower 2.08 > 1.10 | **different pattern** (cost part) | no |

- **The public pattern is not reproduced with Claude Code + 5.5.** That pattern is "Opus resolves clearly more and is not dearer per run".
  - Opus 5.5 costs about 2.5× Sonnet 5.5 per run on both datasets.
  - No Opus resolve advantage was detected on either dataset.
- **Resolve is inconclusive under the pre-registered rule.** The DeepSWE CI upper bound is +8.1 pp, not below +5. Even so, a gap of the public data's size, about +25 pp, lies far outside both CIs.
- **No sensitivity changes a category** (§2.2, §3.2). The TB verdict needs no qualification: the scanner and as-graded bases agree, and §18 (a) and (b) agree with the primary.

## 2. DeepSWE (112 tasks; 111 pairs)

**Pairs.** One pair is excluded under §7: pwntools-tube-multiplexing, C, verifier_infra (verifier timed out 3×). §7's ">3 excluded" rule is not triggered.

| Analysis | Pairs | A | C | C − A, pp [95% CI] | McNemar C-only/A-only | Cost per run C/A [CI] | Cost per solve C/A [CI] | Resolve / cost → pattern |
|---|---|---|---|---|---|---|---|---|
| **Primary** | 111 | 72.1% | 71.2% | −0.9 [−9.9, +8.1] | 12/13, p = 1.00 | ×2.50 [2.32, 2.70] | ×2.53 [2.20, 2.93] | INCONCLUSIVE / NOT CONFIRMED → different |
| §17 memory-episode task drop | 105 | 74.3% | 73.3% | −1.0 [−9.5, +7.6] | 11/12, p = 1.00 | ×2.46 [2.29, 2.66] | ×2.49 [2.17, 2.88] | INCONCLUSIVE / NOT CONFIRMED → different |

### 2.1 Primary details

- **Sign-flip p:** 1.00.
- **Cost per run:** A $0.942, C $2.352. Over the 111 pairs, ΣA $104.56 and ΣC $261.11. A's five costliest tasks are 17% of ΣA.
- **Cost per solve:** A $1.31 [1.08, 1.60], C $3.31 [2.81, 3.91].
- **Why C costs more:** C makes 41.1 calls per run against A's 31.5, about 1.3× the tokens. Its implied unit price is about 2.0× A's. The product is ×2.5.
- **0/1 counts, "per-task rates are 0/1":** both 67, C only 12, A only 13, neither 19.
  - C-only − A-only = −0.9% of tasks, which equals C − A.
  - Opus's rescue rate on the tasks Sonnet missed: 12/31 = 38.7%. This is descriptive.

### 2.2 Sensitivities

- **§17 memory-episode drop:** shown in the table above. It doesn't change a category.
- **Not triggered:**
  - §9 agent-OOM task drop and §10.1 agent OOM counted as unresolved: 0 agent OOMs.
  - §13 deviation drop: 0 deviations.
  - §7 ">3 excluded" sensitivity.

## 3. TB 2.1 (84 tasks; 84 pairs)

**The primary basis** is §5.1 scanner v2. No main run is flagged, and the base layer flags none either, so it equals the as-graded basis.

**The 9 §18 pairs** (sut, `refusal_fallback_blocked`) are scored 0 on attempt 1:
- break-filter-js-from-html (A, C), crack-7z-hash (A, C) and vulnerable-secret (A, C);
- dna-assembly, dna-insert and password-recovery (C only).

| Analysis | Pairs | A | C | C − A, pp [95% CI] | McNemar C-only/A-only | Cost per run C/A [CI] | Cost per solve C/A [CI] | Resolve / cost → pattern |
|---|---|---|---|---|---|---|---|---|
| **Primary (scanner v2)** | 84 | 84.5% | 86.9% | +2.4 [−4.8, +9.5] | 6/4, p = 0.75 | ×2.49 [2.08, 3.03] | ×2.42 [1.94, 3.06] | INCONCLUSIVE / NOT CONFIRMED → different |
| As graded | 84 | identical: 0 scanner flags | | | | | | same |
| §18(a) drop the 6 refusal tasks | 78 | 88.5% | 93.6% | +5.1 [−1.3, +12.8] | 6/2, p = 0.29 | ×2.56 [2.14, 3.14] | ×2.42 [1.93, 3.10] | INCONCLUSIVE / NOT CONFIRMED → different |
| §18(b) refusals scored by verifier | 84 | identical: 0 of the 9 attempt-1 trials pass their verifier | | | | | | same |
| flaky_env drop (tune-mjcf), descriptive | 83 | 84.3% | 86.7% | +2.4 [−4.8, +9.6] | 6/4 | ×2.49 [2.08, 3.04] | ×2.42 [1.95, 3.07] | same |

### 3.1 Primary details

- **Sign-flip p:** 0.75.
- **Cost per run:** A $0.156, C $0.388. ΣA $13.08 and ΣC $32.56. A's five costliest tasks are 35% of ΣA.
- **Cost per solve:** A $0.18 [0.13, 0.25], C $0.45 [0.32, 0.59].
- **0/1 counts:** both 67, C only 6, A only 4, neither 7.
  - C-only − A-only = +2.4%.
  - Opus's rescue rate on Sonnet's misses: 6/13 = 46.2%. This is descriptive.

### 3.2 Sensitivities and pending items

- **§18(a), the refusal-task drop, moves C − A toward Opus:** to +5.1, with CI [−1.3, +12.8]. That is because C refused on 3 tasks where A did not. The category stays INCONCLUSIVE.
- **§9 OOM sensitivity:** not triggered, with 0 agent OOMs.
- **§5.2 post-run oracle: not run** (0c omission; the runners were destroyed before it). The planned sensitivity, which drops tasks whose oracle fails after the run, is therefore unavailable.
  - The primary is unaffected, because it keeps every task by design.
  - The pre-run oracle/nop checks on the 84 kept tasks passed, with dropped [] and unresolved [].
  - tune-mjcf carries the flaky_env mark; the descriptive drop is in the table above.

## 4. Public Claude 5 comparison (§15.4, descriptive, DeepSWE, our 112 tasks)

| Source | Runs per task | A | C | C − A, pp [95% CI] |
|---|---|---|---|---|
| Public mini-swe-agent, Sonnet 5 / Opus 5, effort high | all (4; 3 for 3 C tasks) | 48.2% | 73.3% | +25.1 [+16.9, +33.3] |
| Public, attempt 1 only | 1 | 50.0% | 75.0% | +25.0 [+13.4, +36.6] |
| **Ours, Claude Code, Sonnet 5.5 / Opus 5.5** | 1 | 72.1% | 71.2% | −0.9 [−9.9, +8.1] |

- **The public per-run cost ratio** was ×0.82 over all attempts and ×0.80 [0.74, 0.87] on attempt 1. Ours is ×2.50.
  - In the public data, Opus was cheaper per run because Sonnet's runs were much longer. In ours, Opus runs are about 1.3× longer, at about 2× the unit price.
- **Per-task agreement:** 111 tasks are in both sources.
  - The same sign of C − A (ties count as same): 34% against the public all-attempt means, and 48% against public attempt 1.
  - Pearson r of per-task C − A: −0.01 against the all-attempt means, and +0.04 against attempt 1.
- **Not allowed:** pooling, a test of the difference, or attributing the difference to agent, model generation or price. Agent, models, prices and harness all differ.
- **Re-check:** `public/analyze.py --extra` reproduced attempt 1 exactly (+25.0 [+13.4, +36.6]; ×0.80 [0.74, 0.87]; §15.6).

## 5. Cross-agent: Codex Astra − Sol (§6, descriptive)

| Dataset | Codex rep 1: C − A [CI] | Codex report primary (published) | Claude Code rep 1 |
|---|---|---|---|
| DeepSWE (112) | +0.9 [−6.3, +8.0] (74.1% → 75.0%) | −0.2 [−3.1, +2.7] (blind-design set: A reps 1–5, C reps 1–3) | −0.9 [−9.9, +8.1] |
| TB (84) | +2.4 [−3.6, +8.3] (85.7% → 88.1%) | +2.8 [−0.8, +6.7] (3 reps, v1 lookup basis) | +2.4 [−4.8, +9.5] |

- The middle column quotes the Codex reports. report-stats.json's `all_reps` field is a different recomputation, as graded with every rep in both arms: DeepSWE −0.7 [−3.7, +2.1], TB +3.2 [0.0, +6.7]. It is not the Codex primary and is not cited.

- Codex TB is shown as graded. That equals scanner v2, which flags 0 of the 978 scannable Codex runs (of 1,008; 30 have no scannable transcript, §15.7).
- **Both agents show a small frontier-over-standard gap on these two benchmarks**, of a few points or less. The public mini-swe-agent Claude 5 gap is the outlier.

## 6. S6, descriptive

| | DeepSWE A | DeepSWE C | TB A | TB C |
|---|---|---|---|---|
| Scored finals | 112 | 111 | 84 | 84 |
| Calls per run (all main structural type, served by the pin) | 31.5 | 41.1 | 9.3 | 10.5 |
| Reruns or superseded attempts (cost, not in estimands) | 0 | 4 ($8.71) | 6 ($0.03) | 12 ($0.10) |
| Agent timeouts (final, scored) | 0 | 0 | 1 | 3 |
| Agent OOM, final (Wilson upper) | 0 (3.3%) | 0 (3.3%) | 0 (4.4%) | 0 (4.4%) |
| Refusal calls, final trials | 0 | 1 (non-terminal) | 6 (in 3 trials) | 12 (in 6 trials) |
| §18 refusal-fallback pairs | — | — | 3 | 6 |
| §13 deviations: refused fallback requests, all attempts | 0 | 0 | 9 | 18 |
| count_tokens calls, final (all 404, never forwarded; §16) | 16 (13% of trials) | 47 (32%) | 1 (1%) | 2 (2%) |
| Sanitized requests (§11.5) | all 3,532 | all 4,566 | all 782 | all 885 |

- **Structural request types (§13 4b):** every model call in every arm is structural type `main`, with 100% of calls and cost. No Task, Plan, Explore, background or compaction calls appear in any final trial. So H1–H3 are degenerate: "helper share 0%".
- **Fallback models (§18, by name):**
  - A: claude-sonnet-5 (cyber) 2, not exported 1;
  - C: claude-opus-4-8 (cyber) 3, claude-opus-5 (bio) 2, not exported 1.
  - The "not exported" pair is vulnerable-secret; see disclosure 3.
- **DeepSWE memory (§17):**
  - optique-conditional-option-dependencies C and pebble-durability-wait-apis C reached their container limit.
  - Final trials with host pswpout > 0: A 11, C 13 (14.6M and 30.9M pages), from 0c's episode file.
- **TB containers at their memory limit** (peak ≥ limit; this includes page cache on the 2 GB tasks): 8 tasks in A and 9 in C. Descriptive.

## 7. Disclosures

1. **0d pilot glimpse.** While inspecting the merged file schema, 0d printed two pilot `final` rows that carried a score: one DeepSWE pilot C trial and one TB pilot A trial. This was after both datasets were final, and pilot rows enter no analysis (§4.1). It is disclosed because §4.1 says no pilot outcome is shown.
2. **4f's key-name slip** during scanner (b): field names only (§15.7).
3. **Unexported trial dirs.** driver.py's export name filter (any path containing token, secret or credential) dropped every trial dir of vulnerable-secret and count-dataset-tokens. That is TB main A1 and C1 of count-dataset-tokens, and A1–3 and C1–3 of vulnerable-secret. The runners are destroyed.
   - Their scores, verifier status (`tests_ran` true) and scanner records (f462bb9a, source cc-session) come from the attempts.jsonl rows the driver recorded on the runner. That is the same source as every other run's score.
   - §18(b) uses the same field. **These runs cannot be re-verified offline from transcripts or verifier files.**
4. **Classifier version.** The TB run-configs record the classifier in effect at run time (aad5dbb0…). The §18 reclass is 3a18f4db…, applied at merge.
5. **TB post-run oracle not run.** §5.2 pre-registered this check. 0c's teardown checklist omitted `fleet check --post`, and the runners were destroyed, so it cannot be run now. Any task whose environment drifted between the pre-run check and the end of the run is therefore undetected. Such drift would affect both arms of a task alike.
6. **Seed.** The stats.py default, 20261105, is used, as in the Codex reports (§1.2). analyze.py's own blocks use Random(20261107). Its CIs are reproduced from its own output, not re-drawn.
