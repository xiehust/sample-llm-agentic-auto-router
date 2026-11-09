# Assessor pack v2.2: design

Sections other than §7 belong to their owners (73: the pack and tier passes; 0c: integration). **§7, the statistics
pre-registration, is 0d's**, written 2026-11-07 before any v2.2 tuning.

## 3. Pack mechanism (73)

### 3.1 Why a prompt-only pack couldn't change the tier mix
- The model only reports facts (scope, specification, reasoning depth, prior failures) and judges each rule. The
  tier comes from `map.ts`, a fixed table that every pack used.
- In that table, `reasoning_depth = deep` alone gives frontier (`fact:deep`). That fired on every frontier call of
  the Harbor runs. A settled fast call needed `fully-specified` + lookup/routine, and a matched standard rule always
  beat a matched fast rule.
- So narrowing frontier or opening fast needed the mapping to be a pack property, not only the wording.

### 3.2 The optional `mapping` block (pack.json)
- Keys, each optional; a missing key takes its value from `DEFAULT_MAPPING`, which is the old table:
  - `frontierFacts` ⊆ {deep, prior-failures}: the fact signals that alone support frontier (default both);
  - `priorFailuresMin`: the threshold for `fact:prior-failures` (default 2);
  - `standardFacts` ⊆ {multi-file-edit}: the fact signal that alone supports standard (default it);
  - `fastSpecifications`, `fastDepths`: when a matched fast rule settles (default fully-specified; lookup, routine);
  - `fastBeatsStandard`: a settled fast match outranks standard rules and facts (default false).
  Frontier signals still outrank fast, and a fast + frontier rule match is still a conflict (no opinion).
- `mapTier` takes the block from the pack. The assessor, the eval harness and the pack's example self-check pass it
  through. The router has no code change: it would use v2.2's mapping only if ROUTER_ASSESSOR_PACK=v2.2.
- The block is part of the prompt version hash only when present, so v1/v2/v2.1 keep their versions.
- **Guards** (`map.golden.test.ts`, written before the change):
  - the full truth table, 18,432 cases (every task-facts combination × matched-rule subset × 4 confidences), is
    hashed under the shipped auto flags and under "every rule and fact auto"; v1, v2 and v2.1 must reproduce both
    hashes;
  - the three shipped prompt versions are pinned;
  - a block equal to `DEFAULT_MAPPING` must reproduce the same hashes.
  The router's assessor tests (120) stay green with the default pack.

## 4. Harness (73): experiments/assessor-v22/
- **Cards.** `assess.ts` rebuilds the 196 session-start cards (DeepSWE 112, TB 84; the analysis set) from the
  tier passes' stored bodies with the router's `requestCard`, with the tier passes' check (turn 0, no firstUser,
  latestUser is the instruction). Selection by 0d's `split.jsonl` (`--subset tune|heldout|all`).
- **Live calls.** One pack over the cards with the deployed experiment config: Luna, threshold 0.8, every rule and
  fact signal auto, the 5 s router deadline applied to `pred`. Uses packages/assessor's `runEval`:
  - the caller account must equal LLMAR_SPIKE_ACCOUNT;
  - every call is reserved at its worst case on the task ledger (results/ledger.json, cap $5) before it is made;
  - rows hold codes and numbers only: matched rule ids, task facts, confidence, tier, basis, latency, cost.
- **Re-mapping.** `remap.ts` re-applies another mapping to stored outputs with no call. It refuses unless the
  rendered system prompt is byte-identical to the one the calls were made with.
- **Scoring.**
  - `export.py` writes 0d's call-file format (`task_id`, `pred_tier`, plus pack and rep).
  - `score.py` is a tune-only diagnostic scorer: it drops held-out tasks before any outcome is aggregated, refuses a
    SEALED labels file, and re-derives every tune label from the merged rows (0 mismatches). On v2.1 it matches 0d's
    scorer (DeepSWE-tune −1.1 pp at ×4.18).
  - Official numbers are 0d's `labels/score.py` (§7.4).
- **Baseline.** v2.1 through the same runner, 3 passes × 196 cards (label `v21-base`): it reproduces the old tier
  passes (DeepSWE-tune frontier 62% of calls, −0.6 pp at ×4.20).

## 5. Tuning record (73)

All numbers in this section are **tune split only** (DeepSWE 67, TB 50 tasks). They are in-sample, from 3 live
passes per card; the held-out results are §7's.

### 5.1 DeepSWE-tune → v2.2-D
- **No card-visible signal for fast_safe was found** (descriptive scan, tune split).
  - Per call (v2.1 baseline), fast_safe is 44–59% in every cell with more than 13 calls: scope, specification,
    reasoning depth, matched rules, confidence, instruction-length tercile; language and solution size (task
    metadata, not in the card) too. The base rate is 54%. This scan is descriptive and makes many comparisons: no
    rule was built on any cell of ≤ 13 calls.
  - The diagnostic pack **d1c** (a deliberately permissive fast rule) called fast on 54% of calls at **51%
    precision [36, 66]**, comparable to the 54% base rate; fast loss 16.3 pp. M1 vs Sol: **−8.8 pp [−14.5, −3.3] at ×0.59**. Kept as
    a documented negative result.
  - **d1b** (a narrow "contained fix with a stated exact result" fast rule) never matched: DeepSWE's multi-part
    specs don't state one exact result.
- **Frontier.** On the tasks v2.1 majority-calls frontier, Astra − Sol is −0.9 pp, against −5.8 pp on its standard
  tasks. The selection is in the right direction in-sample (+4.9 pp, noisy, n = 67; the full-data skill was +0.4
  [−5.3, 6.2]), but the selected tasks still show no Astra gain.
- **d1a = v2.2-D** (`assessor/v2.2-D+e2183dce2cb9`):
  - `deep-investigation` covers only open-ended design work with no defined deliverable, or work that already
    failed twice;
  - mapping `frontierFacts: [prior-failures]`;
  - the "hang under load" example is relabelled standard.
  - Tune: 0 frontier calls in 201, so M1 = 0.0 pp ×1.00 (it is the null pack here); vs v2.1 +1.1 pp [−1.9, +4.6]
    at ×0.24.
- Frozen 2026-11-07, commit f27e706. Its TB cross-pass was produced before any TB label was opened.

### 5.2 TB-tune → v2.2-T
- **An inverted pattern, recorded and not used.** On TB-tune the cards v2.1 calls deep, multi-file or
  cross-module, or frontier, are the most fast_safe (84–100% of calls; Sol − Luna ≈ 0): they are tasks every model
  solves. Its routine and single-file cards are the least (59–64%; Sol − Luna +17–20 pp). A rule built on this
  would contradict the pack's own semantics and the DeepSWE evidence, so none was (0c, 0d).
- **t1 = v2.2-T** (`assessor/v2.2-T+08a4a9507f32`), the only candidate tried:
  - v2.2-D plus one fast rule, `known-procedure`: a well-known, documented procedure (install or configure a
    standard service or tool, a standard build/training/analysis recipe, a textbook technique). It doesn't fit when
    success hinges on an exact output format, an exact number or a spelled-out edge case, or when the method must be
    invented.
  - Mapping: `fastBeatsStandard: true`, `fastSpecifications [fully-specified, partially]`, `fastDepths [lookup,
    routine, deep]`.
  - Two synthetic examples: an nginx TLS reverse proxy → fast; an exact byte-for-byte CSV converter → standard.
  - Tune: fast on 26% of calls (15 tasks) at **92% precision [75, 100]**, fast loss −2.6 pp; M1 **+0.7 pp [−3.3,
    +4.0] at ×0.79 [0.62, 0.95]**; vs v2.1 +0.9 pp at ×0.33. Fast calls are mostly system administration (20/21),
    then software engineering 8/33, ML 3/6, security 3/18, data science 3/18, model training 2/9.
  - This is in-sample, and the rule was written after looking at TB-tune outcomes, so expect shrinkage (0d).
- Frozen 2026-11-07 (committed before v2.2 tuning began). On DeepSWE held-out cards the rule never fires, so DeepSWE can't test
  it: "the rule doesn't transfer to DeepSWE-style cards", not evidence of safety.

### 5.3 Both tune sets → v2.2 (release candidate)
- On DeepSWE-tune, `known-procedure` stays quiet: 0 fast calls in 201, M1 0.0 pp ×1.00.
- Nothing else passed the a-priori bar, so **v2.2 = v2.2-T**: the same prompt and mapping
  (`assessor/v2.2+08a4a9507f32`) at packages/assessor/prompts/assessor/v2.2. It is registered, not the default, and
  not deployed.
- Frozen 2026-11-07, commit 5529169.
- Label-free held-out call mixes: DeepSWE about 94% standard; TB fast on 13% of calls, half the tune rate.

### 5.4 Spend
$0.84 of the $5 cap (results/ledger.json): v2.1 baseline $0.20, DeepSWE candidates $0.22, TB candidate $0.06,
DeepSWE check of the TB rule $0.08, evaluation passes $0.28.

## 7. Statistics (0d): pre-registration

### 7.1 Question and data
- **Question:** can a pack whose session-start tier calls are tuned to the measured Harbor outcomes route better
  than (a) pinning Sol and (b) v2.1, on tasks it was not tuned on?
- **Data:** measured outcomes only, with no new agent runs. Per task and arm (F Luna, A Sol, C Astra), the resolve
  rate and the mean cost over that arm's runs.
  - DeepSWE: 112 tasks × 5 runs.
  - TB 2.1: 84 tasks × 3 runs.
  - Rows: phase ≠ pilot, final_status scored, in_comparisons. All runs are used, including DeepSWE's C/F reps 4–5:
    the §7.5.2 blind-design rule governed that report's B−C claims, not a new label analysis.
- **TB basis: as graded** (`resolved`), not the §7.7 primary.
  - The 106 lookup flags were task-level scanner false positives that hit every arm of a task (TB report §5).
  - The primary would turn those tasks into "no arm solves it" and so mislabel them fast.
  - The §7.7-primary outcomes are reported as a sensitivity for the simulated routing only.
- **Unit:** a task. The card is the session-start card from the existing tier-pass `bodies.jsonl` of each dataset
  (the same card the live router built; 73's card checks).

### 7.2 Target-tier label (fixed now; file `labels/make_labels.py`, deterministic)
Per task, with p_F, p_A, p_C the per-task mean resolve rates over all runs:
- **target_tier** = the cheapest tier whose rate equals the best of the three. Ties go to the cheaper tier, so
  fast < standard < frontier.
  - This is the in-sample ideal per-task router's choice. It has no free margin parameter: any δ > 0 would have to
    be chosen, and 5 or 3 runs give rate steps of 0.2 or 0.33.
  - Tasks no arm solved (9 DeepSWE, 5 TB) are labelled fast, since nothing is gained by paying more. They carry
    `unsolved = true` and can be down-weighted in tuning.
- **fast_safe** (binary) = p_F ≥ p_A: Luna did at least as well as Sol on this task.
- **stability** = the share of 2,000 within-task run bootstraps that give the same target_tier. `ambiguous` =
  stability < 0.6.
  - This is an indicator only, and optimistic. The honest noise figure is the split-half reliability below.
- **Label noise:** labels computed from half of each arm's runs agree with labels from the other half only
  - 3-class 70% (DeepSWE) / 76% (TB);
  - fast_safe 75% / 81%, κ ≈ 0.5.
  So agreement with the label is capped well below 100%. Agreement is therefore a secondary metric; the primary is
  simulated routing (§7.4).
- **Counts (all tasks):**
  - DeepSWE fast 56 / standard 46 / frontier 10;
  - TB fast 55 / standard 22 / frontier 7;
  - fast_safe 60/112 and 58/84;
  - ambiguous 5 / 2.

### 7.3 Split and the order of work (sealed held-out set)
- **Within each dataset:** a task-level split, 60% tune / 40% held-out, stratified by (target_tier, tier-pass
  stratum). It is systematic over a seeded hash order (seed 20261107).
  - DeepSWE: 67 tune / 45 held-out.
  - TB: 50 tune / 34 held-out.
- **Files:** in `labels/`, gitignored (they're in the task dir); the sha256 values fix them.
  - `split.jsonl` (all tasks, split only): `daac972f3906fe2308c71922e9ad2e7e2ff1d27ccbe7f4b75d4d75922948aa2a`.
  - `labels-tune.jsonl` (tune tasks only, every label field): `465ad04f6c75c78b37684c5758056a37db8226004b44b09d28a26f23b67dc3d2`.
  - `labels-all.SEALED.jsonl` (all tasks, including held-out): `f3e09386674df32a40686746d6af51d38de6ea93353df8e81209903df2b5b80a`.
- **Sealing:** until a pack is frozen, the tuner (73) does not open the SEALED file. It also reads no per-task
  outcome of a held-out task (rows.jsonl, report tables) and no per-task v2.1 call joined to outcomes for
  held-out tasks. Aggregate report numbers are fine.
- **Packs and order** (each frozen pack gets one held-out evaluation, no re-tuning after it):
  1. **v2.2-D**: tuned from v2.1 on **DeepSWE-tune only**. Frozen, then evaluated on **all 84 TB tasks** (cross:
     tune on DeepSWE, test on TB) and on DeepSWE-held-out. This must happen before 73 opens any TB label.
  2. **v2.2-T**: tuned from v2.1 on **TB-tune only**. Frozen, then evaluated on **DeepSWE-held-out** (cross: tune
     on TB, test on DeepSWE). By then 73 has seen DeepSWE-tune labels, so only the sealed DeepSWE held-out set is a
     valid test here.
  3. **v2.2** (the release candidate): tuned on DeepSWE-tune + TB-tune. Frozen, then evaluated on DeepSWE-held-out
     and TB-held-out. This is the **primary result**.
- **No adaptive reuse of the held-out sets.** 73 freezes each pack and produces its call files: 3 passes over the
  held-out (and, for v2.2-D, all TB) cards. The calls are label-free.
  - **0d scores them only after all three packs are frozen**, and reports every held-out number at once. No
    held-out score of v2.2-D or v2.2-T is seen before v2.2 is frozen.
  - One exception, so the cross test is clean: 73 must not have tuned on TB before v2.2-D's TB calls are produced.
- **Evaluation calls:** 3 live passes per card for every evaluated pack, plus v2.1's existing 3 tier passes
  (`tiers-r*.jsonl`).
- **Budget:** the cards are cheap (§ PRD: $0.03–0.10 per 196-card pass). Tuning passes go on tune cards only.
  Total ≤ $5 on this task's ledger.

### 7.4 Metrics (held-out, per dataset; the two held-out sets are never pooled into one claim)
For a pack v, each held-out task t gets 3 calls. A call of fast, standard, frontier or none routes to Luna, Sol,
Astra or Sol respectively; none maps to Sol, the router's no-opinion mapping.
- **Simulated outcome:** R_t(v) and K_t(v) are the mean over the 3 calls of p_{call,t} and c_{call,t} (each tier's
  measured per-task rate and mean cost). That is the expected outcome under the assessor's own call variability,
  as in live sessions.
- **M1 (primary): route-by-v against pinned Sol.**
  - ΔR = mean_t [R_t(v) − p_{A,t}], with a paired task bootstrap CI (10,000, seed 20261107).
  - Cost ratio = Σ_t K_t(v) / Σ_t c_{A,t}, with its CI.
  - Pre-registered reading:
    - **"v beats Sol"** only if the ΔR CI lower bound > 0 and the cost-ratio CI upper bound ≤ 1.
    - **"v is a cheaper near-Sol"** if the ΔR lower bound > −5 pp and the cost-ratio upper bound < 1.
    - Otherwise, report the point and both CIs. Never "equivalent".
- **M2: route-by-v against v2.1** (same ΔR and cost-ratio definitions, against v2.1's calls). Also against pinned
  Luna and pinned Astra, and against v2.1's **measured** B arm on the same tasks, as a check of the simulation
  against reality.
- **M3, fast-call quality (the costly error):**
  - fast precision = the share of fast calls on fast_safe tasks (call-weighted, CI by task bootstrap);
  - fast loss = the mean of (p_A − p_F) over fast-called tasks, in pp;
  - fast coverage = the share of calls that are fast.
- **M4: agreement** with target_tier (3-class accuracy, Cohen's κ, the confusion matrix) and with fast_safe. Each is
  read against the label-noise ceiling in §7.2.
- **Scorer, fixed before any held-out scoring:** `labels/score.py`, sha256
  `b7594b1dbf9fecff9754df7c255335c177e68c08ec5d874167c9cb3aad3fba36`. The label script `labels/make_labels.py` has
  sha256 `38fba1fb79511454c97956f16d3d3cd08620a4e705c9006b5566c828a6d6512b`.
  - Call files use the tier-pass format: one line per card with `task_id` and `pred_tier`, the call the router
    acts on. none or missing → Sol.
  - The scorer was tested on the tune split only.
- **Sensitivities:**
  - TB on the §7.7-primary outcomes;
  - excluding `unsolved` tasks;
  - excluding TB's 2 flaky_env tasks;
  - majority call instead of the mean over 3 calls.
- **Descriptive:** call distributions per pack; the share of fast calls by TB difficulty and by DeepSWE language;
  the run-to-run flip rate of calls.

### 7.5 What to expect: can a pack beat pinning Sol?
Computed on all tasks from the measured runs, with no pack involved. The ceiling for any outcome-blind assessor is
a router that knows each task's label from half the runs and is scored on the other half:
- **DeepSWE:** −1.1 pp against Sol (run-split range −4.2 to +1.8) at ×0.73 cost, with the label fast 62% of the
  time.
- **TB:** −3.1 pp (−6.5 to 0.0) at ×0.41 cost, fast 79%.

Even with outcome knowledge, routing does not beat Sol on quality. The saving comes almost entirely from fast calls
on easy tasks. Frontier is the label on only 3–4% of tasks.

So, plainly:
- **"v2.2 beats Sol" is not a realistic outcome.** It would need a card-only assessor to exceed an outcome oracle.
- **The best realistic outcome is "cheaper near-Sol":** a 25–60% saving for a loss within 5 pp. It needs high
  fast precision from the card alone. v2.1 never called fast, and frontier calls bought nothing.
- **Power is low:** with 45 / 34 held-out tasks, ΔR's CI is about ±4–6 pp. A true −1 pp may still fail the 5 pp
  criterion.
- The most likely result is therefore: "v2.2 cuts cost against v2.1 (fewer frontier calls) and probably against
  Sol, with a quality change that can't be pinned down to within ±5 pp." The report should say so in those words if
  that is what happens.
- A pack that simply stops calling frontier (all standard) reproduces pinned Sol by construction. That **null pack**
  is reported next to v2.2 as the reference: any v2.2 value beyond it comes from fast calls.

### 7.6 Report (zh) and limits
- Report M1–M4 per dataset and per pack (v2.1, null, v2.2-D, v2.2-T, v2.2) on the held-out sets. The cross results
  are labelled as such. Per-task output: ids, labels and calls only.
- **Limits:**
  - offline simulation ≠ live run: one session-start call, with no mid-session effects;
  - labels from 5 or 3 runs are noisy (κ ≈ 0.5 split-half);
  - small n;
  - one agent and harness;
  - tuning-set overfitting, which the sealed split guards against, though only once per frozen pack;
  - the DeepSWE-tune labels were also seen when building v2.2-T, so only DeepSWE-held-out is a clean cross-test.

### 7.7 Freeze receipts (0d, recorded on receipt; held-out set not yet scored)
- **v2.2-D** (`assessor/v2.2-D+e2183dce2cb9`), received 2026-11-07. `packs/FROZEN.json` sha256
  `e752183160f31e1f1835fdf7a55f96a1b68337ad72eb73fcc20e317316baed5a`.
  - Evaluation call files (`experiments/assessor-v22/results/export/v22d-eval/`), sha256:
    - deepswe-r1-heldout `6cd731160cd37092671b2bdf8bd68d4c76f02e954b38b7b1e52638bc694f9006`
    - deepswe-r2-heldout `5753fa90ad173694b1aea8e3c1d7eaf2323c06d637547aa4bf96d49f6ca7cef3`
    - deepswe-r3-heldout `2ee7eac8df24b31b4e104f72b34126db0f445b2e38650f04da6cacc7a7c95cd0`
    - tb21-r1-all `cad3c2f9aa5918032fd9f25e2a65df0435c280fae165993e788031dbd9224111`
    - tb21-r2-all `ceaf6289e4ec293759302c5800cfa21948cd2bbb03e1c56e23342af57393350d`
    - tb21-r3-all `5dcb12e80aa662524d7dc4eeb6730b76d5fdcc262a418c419d7cb0cbcb58ff89`
  - 73 states that no TB label was opened before these were produced.
- **v2.2-T** (`assessor/v2.2-T+08a4a9507f32`), received 2026-11-07. Tuned from v2.1 on TB-tune only, with one
  candidate. `packs/FROZEN.json` (now holding both packs) sha256
  `347612e…af46319050c5f7`.
  - Evaluation call files (`results/export/v22t-eval/`), sha256:
    - deepswe-r1-heldout `a4a15573613334b1fce350e49a4900fdb76ea9a178ca58636f7e50ca1b96b3df`
    - deepswe-r2-heldout `ad4ccd7d920b432bfbd368a31862809a054fdda0dbbd83cab0249b35c99b74c5`
    - deepswe-r3-heldout `399b8384d01887381551ea318eee00294ce3edf4856209ccf28b8edee8b4ca27`
  - Its TB-tune numbers (fast precision 92%, ΔR +0.7 pp at ×0.79) are in-sample. Expect shrinkage. Its fast rule
    is first tested out of sample by v2.2 on TB-held-out.
- **v2.2** (`assessor/v2.2+08a4a9507f32`, the same prompt and mapping as v2.2-T), committed 5529169. `FROZEN.json`
  sha256 `1c7d9d68b37f8f56cd2effc803615384ff988c101b2b12bfe01deae6d4818b6e`. Held-out call files `v22-eval/`:
  deepswe r1–r3 `366720d2…`, `c434d6bf…`, `5339644d…`; tb21 r1–r3 `1d295290…`, `08ebec02…`, `9c45c4d0…`. All were
  verified on receipt. The earlier v2.2-D and v2.2-T files were re-verified unchanged.

### 7.8 Held-out scoring (0d, 2026-11-07, run once after all three freezes)

**Tracked copies (0c, 2026-11-07):** score.py (8b78491f…), make_labels.py (38fba1fb…), split.jsonl (daac972f…), labels-all.jsonl (f3e09386…, the former sealed file, renamed after scoring) and the 9 held-out score outputs are committed byte-identical under `experiments/assessor-v22/heldout/`.

- **Scorer fix before reporting:** `boot()` let NaN resamples (no fast call in the resample) into the sort, which
  corrupted the fast-precision CI only. NaN resamples are now dropped. score.py sha256 `b7594b1d…` →
  `8b78491f5014769c686c1ee9a4db52c15c41447dbd2e29022e6b180f570029dc`. No M1, M2 or M4 value changed.
- **Outputs:** `labels/heldout-results/` (run.sh, extra.py, JSON per run).
- **Released content = v2.2-D (0d, 2026-11-07, after the user's release decision; derived from the same outcomes and call files, no new scoring run).**
  - Basis: the committed score.py functions, with v2.1 = the step-1 tier passes. Task bootstrap, seed 20261107, 10,000 resamples. As graded.
  - **DeepSWE held-out (45):** v2.2-D calls 100% standard, which is pinned Sol (×1.000). Against v2.1: −0.1 pp [−3.0, 2.8], cost ×0.224 [0.19, 0.27].
  - **TB, all 84 tasks (cross test; v2.2-D was never tuned on TB):** 99.6% standard and 0.4% frontier. Against Sol: 0.0 pp, ×1.03. Against v2.1: +0.1 pp [0.0, 0.4], cost ×0.42 [0.34, 0.52].
  - TB held-out (34) is a subset of the 84: +0.0 pp, ×0.37 [0.27, 0.59] against v2.1. Not cited separately.
