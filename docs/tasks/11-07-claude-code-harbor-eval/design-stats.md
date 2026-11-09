# Claude Code × Harbor — statistics pre-registration (0d)

Status: **approved by 0c, 2026-11-07, binding.** It was written before any tier-pass, pilot or stage-1 outcome existed. Changes are allowed only before stage 1 starts, each recorded here as a dated amendment. For example, if the user changes the B arm at the tier-pass gate, §1 and §3 are amended. **Amendment 6 (§15) reduces the run to arms A and C, rep 1 only. Every B/F estimand in §1–§3, §8 and §14 is not run.**

The method follows DeepSWE §7 and TB §7 unless this file says otherwise. Those are the Codex designs, `docs/tasks/11-05-…/design.md` and `docs/tasks/11-06-…/design.md`. Below they are cited as DS §x and TB §x.

## 1. Design and estimands

### 1.1 Units, arms and what an arm means

- **Unit:** a task. The tasks are the same sets as the Codex runs: DeepSWE v1.1 with 112 tasks, and TB 2.1 with 84 tasks, both re-verified pre-run (§5).
  - Each dataset is analysed on its own. **No claim pools the two datasets.**
  - The estimand is the equal-weight mean over a dataset's tasks.
- **Runs:** up to 3 per (task, arm), rep 1–3, **in two stages** (user decision, 2026-11-07; §8).
  - Stage 1 is rep 1 of every arm on both datasets.
  - Stage 2 is reps 2–3, and runs only if the user decides to continue.
  - There is no extension beyond 3 runs. The one pre-registered look is the one in §8.
  - The budget rule ("stop and ask if the pilot projection exceeds $8,000; never cut runs") is a cost decision, not a statistical one.
- **Arms.** Each arm fixes the main-loop model only:
  - **A:** pinned Sonnet 5.5;
  - **B:** auto with assessor v2.2 (frontier → Opus, standard → Sonnet, fast → Haiku);
  - **C:** pinned Opus 5.5;
  - **F:** pinned Haiku 5.5.
  - Helper calls keep Claude Code's defaults in every arm (Haiku for Explore and background calls).
  - Every estimand below therefore compares **policies: Claude Code with its default helpers, plus a main-loop model choice.** None of them is a pure model-versus-model contrast.
- **Main vs helper** is a per-call field set by the proxy and router (4f/17), never by the analysis:
  - **main:** the call is in the arm-routed main loop;
  - **helper:** the call carries Claude Code's explicitly requested helper model.
  - This needs a precondition (§4): 100% of calls carry the field, and in pinned arms 100% of main calls are served by the pin.

### 1.2 Primary

- **P1, B − A resolve.** `paired_mean_diff`: per task, the mean of B's runs minus the mean of A's runs.
  - Paired percentile bootstrap CI over tasks, plus the sign-flip p.
  - The stats.py seed and n_boot are the same as in the Codex reports.
  - Non-inferiority at **10 pp** (comparable with the Codex runs), with **P1-tight at 5 pp** reported beside it on both datasets, as TB §7.2 did.
  - The report leads with the strongest result that is shown, and says so explicitly when the result is "NI at 10 pp but not 5 pp".
- **P2, B/A cost.** `cost_ratio`, the ratio of sums of per-task mean costs, with a bootstrap CI.
  - The cost of a run is its proxy ledger, **helpers included**, plus B's assessor calls.
- **Claim rules,** exactly as DS §7.2:
  - "B is not worse than A and costs less" if CI lower > −margin and cost-ratio upper < 1.
  - "Better" if CI lower > 0.
  - "Costs more" if cost-ratio lower > 1.
  - Otherwise, the point estimates and both CIs only.
  - The word "equivalent" is never used.
  - A degenerate CI supports no resolve claim, but the cost claim stays.

### 1.3 Secondary

All have 95% CIs, no multiplicity adjustment, and are labelled as secondary.

- **S1:** B − C (NI at 10 and 5 pp, and ΣB/ΣC; claim rule "B ≥ C and cheaper") and B − F.
- **S2:** C − A and F − A, with their cost ratios.
  - **C − A is the premise of this experiment:** that the Claude tiers have a real gap. The report puts it right after P1/P2, but under the secondary claim rules.
- **S3:** the ideal per-task router over {F, A, C}: held-out (3 folds) and in-sample on run 1 (TB §7.2).
- **S4:** results by tier-pass stratum, and selection ability (§3).
- **S5:** run-to-run noise per arm.
- **S6, descriptive:**
  - per-solve cost per arm, Σcost / Σsolved, with a task-bootstrap CI;
  - timeouts, turns, tokens and cache;
  - B's served-model share for main calls;
  - assessor latency and cost;
  - failovers;
  - per-runner results;
  - TB flag rates (§5).
- **Helper accounting, H** (descriptive; it enters P2 only as part of the cost):
  - **H1:** per arm, the helper share of calls, of input + output tokens and of cost, as mean, median and per-task distribution.
  - **H2:** a main-only cost ratio for P2 and S1/S2, i.e. the same ratio with helper costs removed. It shows how much helpers dilute the cost contrasts. It is never used for a claim.
  - **H3:** the helper share by arm, for example whether Opus delegates to Explore more or less than Sonnet. Helper behaviour is part of each policy, so a difference here is a result, not a confound to remove.
  - **H4:** helper calls served by a model other than the one requested must number 0 (§4).
- **Sensitivities, all reported next to the result they touch:**
  - run 1 only (`paired_diff`);
  - excluded counted as failures (§7);
  - TB lookup (§5);
  - TB post-run oracle check (§5);
  - B and S4 on the **DeepSWE held-out 45** (§3.2).

## 2. Precision at 3 runs per task (Codex prior)

These are the Codex runs restricted to reps 1–3. They are task-paired, as graded, with a 4,000-resample percentile bootstrap.

| Contrast | DeepSWE (112 tasks): Codex Δ [95% CI] | half-width | TB (84 tasks): Codex Δ [95% CI] | half-width |
|---|---|---|---|---|
| B − A | −1.5 [−5.4, +2.4] | ±3.9 | +1.6 [−1.6, +5.2] | ±3.4 |
| B − C | −2.1 [−5.4, +1.2] | ±3.3 | −1.6 [−5.2, +2.0] | ±3.6 |
| C − A | +0.6 [−2.4, +3.9] | ±3.1 | +3.2 [0.0, +6.7] | ±3.4 |
| F − A | −16.4 [−23.5, −9.5] | ±7.0 | −13.1 [−21.0, −5.2] | ±7.9 |

What to expect for Claude:
- **If the gap between tiers is real, expect wider intervals than these.** An Opus−Sonnet effect that varies by task raises the per-task SD; for Codex, the SD of C − A was 15–17 pp.
- **As a planning range:** ±3–5 pp for contrasts between adjacent strong tiers, and ±7–9 pp for anything involving Haiku.
- **Detectable effect:** with about 80% power, a true C − A of about +5 pp gives CI lower > 0.
- **B − A NI at 5 pp** needs a true B − A of at least about −1.5 pp for about 80% power. **NI at 10 pp** is met in every plausible scenario.
- **More runs per task would barely help.** On Codex, going from 3 to 5 runs shrank the half-widths by only about 0.5–1 pp. Precision is limited by the number of tasks.

## 3. Selection ability under v2.2

### 3.1 Strata and the size question

- **The strata are fixed before the pilot.** They come from 73's offline v2.2 tier pass on Claude Code cards: 3 passes, majority tier, "none" counted as standard. They are frozen in `strata.json` with a hash, and the PRD requires the result to be shown to the user before the pilot.
- **Selection ability** = (C − A | frontier) − (C − A | standard), descriptive (as in DS and TB). The B − A decomposition Σ w_s Δ_s is also reported.
- **Expected precision of the selection-ability estimate.** From the Codex per-task SD of C − A at 3 runs, the half-width depends on the size of the frontier stratum:
  - 5 tasks: ±14–15 pp;
  - 10 tasks: ±10–11 pp;
  - 15 tasks: ±8.5–9 pp;
  - 20 tasks: ±7.5–8 pp;
  - 30 tasks: ±7 pp.
- **Pre-registered reporting rule.**
  - **If both strata have ≥ 15 tasks:** report selection ability with its CI.
  - **Otherwise:** report "not estimable at this stratum size", with the counts and the per-stratum C − A as description only.
  - The same rule applies to the "three passes agree" subset.
- **Expectation, stated now.** On the Codex cards, v2.2-D called **0% frontier** on DeepSWE held-out and **0.4%** on TB.
  - If the Claude Code tier pass looks similar, the frontier stratum will be nearly empty.
  - Then B ≈ A by construction. P1 measures the router's overhead on the main loop and the assessor's cost, not routing value, and S4's selection ability is not estimable.
  - The report must say this plainly. It must not present B − A ≈ 0 as evidence that routing works or fails.

### 3.2 The held-out caveat

- **v2.2 is v2.2-D content.** It was tuned on the **DeepSWE tune split** (67 tasks, Codex/GPT outcomes) and never on TB.
- **What that means for each dataset:**
  - All 84 TB tasks, and the 45 DeepSWE held-out tasks, are new to the pack.
  - The 67 DeepSWE tune tasks are not.
  - The tuning used GPT-family outcomes, so it doesn't tune to Claude outcomes. The pack's frontier narrowing was still shaped on those tasks' cards.
- **Sensitivity:** P1, S1 and S4 on the DeepSWE held-out 45, using the committed split (`experiments/assessor-v22/heldout/split.jsonl`, sha256 daac972f…).
- **Out of scope:** this experiment does not test whether a pack calibrated on GPT transfers to Claude in any formal way. Re-tuning on Claude outcomes is out of scope (PRD). If it is done later, it must use a fresh held-out split.

## 4. Pilot, attribution preconditions, blinding

### 4.1 The pilot

**The pilot is calibration only.**
- Pilot trials (phase = pilot) are excluded from every analysis. The main pass runs those tasks again fresh.
- The pilot is used for:
  - cost per arm and the budget projection;
  - helper/main split and attribution;
  - harness errors;
  - timing and admission;
  - TB scanner calibration (§5.1).
- **No resolve rate, reward or verifier outcome is computed, shown or discussed for pilot runs.** That includes run status that would reveal one, beyond "the verifier ran".
- The pilot sample is a seeded sample within each shard, as in TB §7.5. Its size and caps belong to 17 and 0c.

### 4.2 Preconditions, checked on the pilot and again on the full run

A failure stops the run before main, or marks the affected runs as a mechanism failure in the report.
1. 100% of calls are attributed: trial ↔ router log ↔ proxy ledger, 1:1.
2. Every call carries the main/helper field.
3. In pinned arms, 100% of main calls are served by the pin.
4. In B, every main call is served by the model the assessor's tier maps to, and the assessor is consulted once per session.
5. 0 helper calls are served by a model other than the one requested.
6. Helper calls in B are not routed by the assessor.

### 4.3 Looks: only the one pre-registered stage-1 look (§8)

- There is exactly one outcome look before the end: **after stage 1 is final on both datasets**, on every runner. It follows §8.
- Otherwise no per-arm outcome is computed or shown to anyone:
  - not during stage 1;
  - not between DeepSWE stage 1 and TB stage 1;
  - not during stage 2.
- While runs are in progress, only cost and run status are used.
- Any exception is disclosed. The comparisons it touches are then made on the blind-design set (DS §7.5.2).

## 5. TB rules

### 5.1 Lookup-flag rule

This is the Harbor-summary §5 item 7 lesson, pre-registered here.

- **Scanner v2** (4f) must:
  - parse Claude Code transcripts (Bash tool calls, plus WebFetch/WebSearch if enabled; TB matches the Codex profile, where web search was off);
  - exempt content that comes from the task image, not only the task's `environment/` directory;
  - require a download-shaped action (URL, clone, fetch or curl) for a line-match flag;
  - keep L1 (benchmark access) and L2 (solution artifact) as in TB §7.7.
- **Calibration, reward-blind, before the main run.** Scanner v2 is run on:
  - (i) the 1,008 Codex TB command logs. Their 106 v1 flags were reviewed manually and classified as false positives in three task-level categories (TB report §5).
  - (ii) the Claude pilot transcripts.
  - The flag rate is reported per arm, with no outcome joined.
- **Freeze criterion:** scanner v2 is frozen, with its version hash in run-config, once both hold:
  - **(a)** it flags ≤ 2% of the Codex TB runs, all task-level categories included;
  - **(b)** no pilot task is flagged in every pilot run of every arm.
- **If either fails,** 4f revises the exemptions, reward-blind, and the calibration is repeated before main. Every revision is logged.
- **Scoring:**
  - **Primary:** as TB §7.7, with scanner v2. A flagged run that resolved is scored as not resolved. It is never excluded, and its cost counts.
  - **Sensitivity:** as graded.
  - A claim is stated without qualification only if both bases agree. Otherwise both are reported and the primary decides.
- **Task-level rule, pre-registered.** If a task is flagged in ≥ 2/3 of its runs in at least 3 of the 4 arms, it is listed as a "task-level flag" for a reward-blind description in the report.
  - It stays flagged in the primary.
  - A second sensitivity drops those tasks.
  - No manual overrides.
- **S6 rules from TB §7.7, unchanged:**
  - flag rates per arm, with Wilson CIs;
  - the > 5% summary rule;
  - a note if A and B flag rates differ (Fisher p < 0.05, descriptive).

### 5.2 Oracle checks, pre and post

- **Pre-run.** On the final network rules, rerun the TB §7.5 oracle/nop rule, unchanged, on the 84 kept tasks.
  - A kept task that now meets the drop rule is dropped for this experiment and listed.
  - The 5 Codex drops stay dropped, with no re-check, so the task set can only shrink. The cross-agent section uses the common task set (§6).
- **DeepSWE:** re-check the 112 pins and run the oracle once per task. A task whose oracle fails is dropped and listed (DS §7.4).
- **Post-run, TB only** (DeepSWE is offline): run the oracle once more on every kept task. Tasks that now fail are removed in a sensitivity; the primary keeps them (TB §7.5).
- `flaky_env` handling is as in TB §7.5: the marks are carried over and re-evaluated pre-run.

## 6. Cross-agent section: Claude Code vs Codex (descriptive only)

**May be shown:**
- **Within-agent contrasts side by side:** for example, Claude's C − A next to Codex's C − A, per dataset, each with its own CI. This uses the same table layout as TB §7.11.
- **Matching:** the Codex numbers are shown with reps 1–3 (matched precision) and as reported (DeepSWE blind set).
- **Task set:** the common set only, after any §5.2 drops.
- **Arm levels per agent,** and cost per solve per agent.
- **Per-task agreement across agents,** descriptive:
  - how often the same tasks are hard for both agents, using the correlation of per-task rates;
  - the overlap of tasks where frontier > standard.

**May not be claimed:**
- No statement that one agent or model family "is better" or "is cheaper" as a tested result. Agent, models, prices, timing and helpers all differ, and nothing was randomised between agents.
- No difference-in-differences test. If a difference is shown, it is labelled descriptive and carries no CI-based claim.
- No pooling across agents or datasets.
- No transfer claim for the assessor pack beyond §3.2.
- The public leaderboards are reference only (TB §7.11).

## 7. Missing runs, reruns and classification (aligned with 17)

- **The classifier is reused:** DS §7.4 and TB §7.4, with the classes agent, sut, upstream, harness, verifier_infra, cap_stop and cancelled.
  - At most 2 reruns and 2 re-verifies per (task, arm, rep).
  - If still errored after that: excluded pairwise-complete.
  - If any arm has more than 3 such tasks in a dataset: the excluded-as-failures sensitivity.
  - The classifier is deterministic, reward-blind and version-hashed. 17 maps the Claude Code fields onto it. The mapping is tested before the pilot and frozen with its hash.
- **Claude Code additions,** for 17 to confirm:
  - **Agent outcomes, scored:**
    - max turns or the context limit reached;
    - Claude Code exits non-zero because of model behaviour;
    - refusal;
    - auto-compact failure;
    - agent timeout (the task's own, multiplier 1.0).
  - **Upstream, rerun:** Bedrock throttling, overloaded or 5xx responses that surface after Claude Code's own retries.
  - **sut, scored 0 and listed:** any router-originated refusal or error on a main or a helper call, including a helper model the router refuses to serve. The router is the treatment.
  - **Harness, rerun:**
    - the proxy cannot attribute a call;
    - the Claude Code install or startup fails;
    - an auth or base-URL failure at startup.
  - **TB rule (b)** (verify-time network failure with `net_config_touched` false) applies unchanged.
- **Cap stops:**
  - Runner cap stops are `cap_stop` and excluded; analysis then uses the complete task blocks.
  - There is no per-run cap in this experiment. If 17 adds one, a capped run counts as unresolved and stays in the analysis, as in the escalation design §7.4.
- **Reporting:** the count of reruns per arm, by class, and the list of excluded (task, arm) pairs.

## 8. Staged run: the pre-registered stage-1 look (added 2026-11-07, before any tier-pass, pilot or stage-1 outcome)

### 8.1 What stage 1 can resolve (Codex prior)

I checked 0c's numbers on the Codex reps 1–3. They agree within bootstrap noise.

| Contrast | DeepSWE: 1 run, ±95% | 1 run, ±99.9% | 3 runs, ±95% | TB: 1 run, ±95% | 1 run, ±99.9% | 3 runs, ±95% |
|---|---|---|---|---|---|---|
| C − A | ±6.4 | ±10.7 | ±3.1 | ±5.4 | ±9.0 | ±3.2 |
| B − A | ±6.4 | ±10.7 | ±3.9 | ±6.7 | ±11.3 | ±3.6 |
| B − C | ±6.4 | ±10.7 | ±3.3 | ±5.8 | ±9.7 | ±3.6 |
| F − A | ±9.8 | ±16.5 | ±6.7 | ±9.7 | ±16.3 | ±8.1 |

- The 1-run half-widths are averaged over which single rep is used.
- **Single-run points swing.** Among Codex reps 1–3, DeepSWE C − A ranged from −1.8 to +2.7 and B − A from −5.4 to +3.6. 0c's wider ranges include reps 4–5.
- **Information fraction.** Stage 1 carries about 0.25–0.65 of the 3-run information: var(3-run) / var(1-run) is 0.23–0.37 for adjacent tiers and 0.50–0.65 for F − A.

### 8.2 Stage-1 reading rules (alpha spending)

- **Stage-1 boundary: Haybittle–Peto, z = 3.29 (a 99.9% CI).** The stage-1 boundary is a 99.9% CI, two-sided α₁ = 0.001.
  - It is the conservative end of the O'Brien–Fleming family. Lan–DeMets OBF at an information fraction of about 0.35 gives z ≈ 3.3.
  - It doesn't depend on knowing the information fraction exactly.
- **Final boundary:** stays z = 1.96 (§8.4).
- **Allowed at stage 1:** the DS §7.2 claim rules, applied with the 99.9% CI instead of the 95% CI:
  - "better" or "lower than": the CI excludes 0;
  - NI at 10 pp or 5 pp;
  - "costs more" or "costs less": the cost-ratio CI excludes 1.
- **Every stage-1 statement is labelled** "stage 1, 1 run per task, 99.9% CI".
  - The nominal 95% CI is also shown, labelled "for orientation, not for claims".
  - No other claim is made at stage 1, and the word "equivalent" is never used.
- **What stage 1 can realistically claim** (Codex prior):
  - F − A at about −15 pp or more;
  - C − A at about +10 pp or more;
  - cost ratios, whose CIs are tight. For example, ×5 price gaps are certain at stage 1.
  - NI at 5 pp for B − A is essentially out of reach at stage 1, because it needs B − A of about +6 pp or more.
- **Not computed at stage 1:**
  - selection ability (S4). It is not estimable at 1 run in any stratum size we expect.
  - the S5 noise estimates, which need 2+ runs.
  - S3. Only its in-sample version exists at 1 run, so it is not shown.

### 8.3 What the user is shown at the look, and how to decide

**The look packet.** It is generated by the same report code with `--stage 1`, per dataset. 0c shows it to the user.
1. Arm levels (rep 1). For each of B − A, B − C, C − A and F − A: the point estimate, the 99.9% CI, the nominal 95% CI and the stage-1 verdict under §8.2.
2. Cost per run, cost ratios and per-solve cost per arm, helper share (H1), and B's served-model share and tier-pass strata counts.
3. TB: flag rates and the as-graded vs primary difference. Integrity checks §4.2 (pass/fail) and the OOM rates (§9).
4. **A projection of what stage 2 buys.** The expected final 95% half-width for each contrast is the stage-1 half-width × 0.6 for adjacent tiers and × 0.85 for F − A. These are the Codex 3-run/1-run ratios (0.48–0.61 and 0.68–0.84), rounded up. The packet also says which claims stage 2 could make that stage 1 cannot: NI at 5 pp, C − A of moderate size, selection ability (if both strata have ≥ 15 tasks, §3.1) and S5.
5. The stage-2 cost projection (§8.5).

**Guidance (non-binding; the decision is the user's).**
- **Stage 1 is "decisive" for a contrast when** its 99.9% CI already excludes the values that would change the routing recommendation. Examples:
  - F − A with a 99.9% CI upper bound below −5 pp, which settles "Haiku is not enough as the main loop";
  - C − A with a 99.9% CI lower bound above +5 pp, which settles "Opus buys a real gain".
  - More runs would only narrow these.
- **Stage 1 is "not decisive"** for C − A or B − A when the 99.9% CI spans both 0 and ±5 pp. That is the likely case for adjacent tiers unless the gap is large. Here stage 2 is what can answer the question:
  - its ±3–4 pp final CI resolves effects of about ±5 pp;
  - it also enables NI at 5 pp.
- **If B's main loop was served by Sonnet in ≥ 95% of sessions** (likely under v2.2; §3.1), B ≈ A by construction. Stage 2 adds little about routing, but it still adds to C − A and F − A.
- **The user's options:**
  - (i) stop;
  - (ii) continue all arms on both datasets;
  - (iii) continue a subset of arms or datasets, for example only A and C to pin down C − A.
  - Arms, tasks, pack, scanner and classifier cannot change between the stages. Adding runs beyond 3 is not an option.

### 8.4 The combined stage 1 + 2 analysis

- **If the user continues,** the final analysis is §1–7 unchanged. It uses all 3 reps per task in the same `paired_mean_diff` (equal weight per run), at the 95% CI, z = 1.96.
- **Why this stays valid after an outcome-dependent decision.** The decision to continue can only stop paths, never add rejections. The final test's rejection region is fixed in advance, and a stop at stage 1 makes no claim beyond §8.2's α₁. So the overall two-sided type-I error per contrast is ≤ α₁ + α₂ = 0.001 + 0.05 = 0.051.
  - This holds whatever the user's reason for continuing or stopping (a non-binding decision), and for a subset continuation under option (iii).
- **Bias caveat (stated in the report).** If continuation depended on stage-1 results, the combined point estimate is slightly biased conditional on continuing. The combined estimate weights stage 1 at 1/3, so the conditional bias is about a third of the stage-1 selection effect.
  - The report gives the stage-1 and stage-2 estimates separately, next to the combined one.
  - The stage-2-only estimate (reps 2–3), which is independent of the decision, is shown as a sensitivity.
- **Drift check:** rep 1 vs reps 2–3 per arm (as DS S7b, descriptive). Stage 2 runs later, but every arm is in every block, so drift between stages hits all arms equally.
- **For arms or datasets that were not continued,** the contrasts are final at stage 1 under §8.2. They are labelled that way, and they are not mixed with 3-run contrasts in one table without a label.
- **If the user stops after stage 1,** the report is the stage-1 packet in full, with §8.2's claims only. Every non-claim is reported as the point estimate plus the 99.9% CI and the nominal 95% CI.

### 8.5 Stage-2 cost projection at the look (cost only, not an outcome)

- **Bedrock:** projected stage 2 = 2 × the stage-1 Bedrock total, per arm and dataset, plus reruns at the stage-1 rerun rate per arm.
  - Interval: a 90% task-bootstrap interval of 2 × Σ per-task stage-1 cost. Repeated runs of a task cost about the same, so this interval mainly reflects the long tail of expensive tasks.
- **Runner:** 2 × stage-1 runner hours at the fleet rate, plus standby.
- **Budget comparison:** compared with the remaining budget, $8,000 − the ledger to date.
  - If the projection's upper bound exceeds the remainder, the packet says so, and per the budget rule the user decides.
  - Runs are never cut silently within a continued stage.
  - Cost per arm in stage 2 for an option (iii) subset is shown separately.

## 9. OOM: scoring and reporting (added 2026-11-07, before any pilot outcome)

- **An agent-container OOM within the task's own memory limit is an agent outcome: scored and never rerun.** This is DS §7.4's class, now made explicit for Claude Code (Bun's RSS is 0.3–0.6 GB above Codex's, and TB has 2 GB limits).
  - Detection: the classifier's OOM exceptions (`SandboxLikelyOutOfMemoryError`, `MemoryLimitExceededError`) or a container OOMKilled event.
  - Scoring: by the verifier on whatever state remains if the verifier ran; unresolved otherwise.
  - Which process was killed (the agent or the task's own workload) doesn't change the class.
  - Task resources are not overridden: the limits are part of the benchmark, and memory use is part of the agent policy.
- **Host OOM is infrastructure:** the runner kernel's OOM killer acting outside the task's cgroup limit. The class is harness, and the trial is rerun (≤ 2). 17's classifier separates the two using the host kernel-log watcher and the container's cgroup event.
- **Reporting (S6, per arm and dataset):**
  - agent OOM rate with Wilson CIs, and resolved-despite-OOM counts;
  - A vs B and A vs C OOM rates, two-sided Fisher on runs, descriptive. If p < 0.05, the report says that the contrast includes a memory-failure effect, for example longer Opus sessions OOMing more.
  - 17's pilot peak RSS per arm. It is calibration only, and no outcome is attached.
- **Sensitivity:** drop every task with an agent OOM in any run of any arm. Whole tasks are dropped, so the pairs stay complete. Recompute P1, P2, S1 and S2, and report next to the primary when the drop list is non-empty.
- **Cross-agent section (§6):**
  - The OOM rates of Claude Code and Codex on TB are shown side by side, descriptive. Codex's agent OOM count is taken from the Codex runs' classifier.
  - Any Claude vs Codex level difference on TB is read with this next to it: the agents use memory differently in a fixed-limit benchmark.

## 10. Amendment 1 (2026-11-07, before any tier-pass, pilot or stage-1 outcome): orchestration decisions for 17

1. **OOM victim.** Agent-victim (claude/bun/node) and workload-victim OOMs inside the task limit are scored the same way, as §9 says: they are agent outcomes.
   - **Scoring stays as §9:** by the verifier if it ran, otherwise unresolved.
   - **Sensitivity:** all agent-OOM runs counted as unresolved, whatever the reward. This sits next to §9's OOM-task-drop sensitivity.
   - **S6** reports the victim split per arm (descriptive).
2. **Pilot gates (17 §…).**
   - The gates use only attribution, throttling, PSI and OOM telemetry, never resolve outcomes.
   - A concurrency change applies to **all arms of a dataset equally**, because the arms are interleaved within blocks. It is fixed before main for that dataset and **kept for stage 2**.
   - If a gate trips again in stage 2, the change is applied to all arms and recorded in the report, together with the passes it affects.
3. **Pilot tasks.**
   - 17's seeded choice at the 25th and 75th Codex cost percentiles is fine. The Claude/Codex κ is a cost ratio, not an outcome.
   - **TB addition, for scanner v2 calibration (§5.1):** add 2 tasks by seeded draw from the 5 tasks that scanner v1 flagged in every Codex run: mailman, make-doom-for-mips, fix-code-vulnerability, pytorch-model-recovery and hf-model-inference.
   - Use the plan seed and the label "scanner-cal". This choice is reward-blind.
   - Like every pilot task, they run fresh in main. No pilot resolve rates are computed (§4.1).
4. **Stage order.**
   - Stage 1: DS rep 1 → TB rep 1.
   - Stage 2: TB reps 2–3 → DS reps 2–3. This order is fine: reps are exchangeable and get equal weight in every estimand.
   - The §8.4 drift check (rep 1 vs reps 2–3) is read as "stage" drift, which includes time.
   - **Check reuse at the second changeover:**
     - **DeepSWE** is offline. Its pre-run oracle check (§5.2) is reused, provided the task-file hashes and image digests verify unchanged (taskpin verify plus the digest check). If anything changed, re-run the oracle for the changed tasks only. Such a task is never dropped mid-experiment; it goes into a sensitivity.
     - **TB** depends on the internet, and the gap between stages is the user's decision, so it may be long. Before stage 2, run one oracle slot on every kept task.
       - A task that now fails is **kept**, so the task set matches stage 1. It is listed and removed in a sensitivity, like the post-run check.
       - The post-run oracle check (§5.2) runs after the last TB pass that happens.
5. **Caps and planning numbers.**
   - 17's hard cap (shard projection × 1.4 + reserve + settled, with Σ caps + other spend ≤ $8,000 pre-flight) is fine statistically. A cap stop is `cap_stop`, excluded; the analysis then uses complete blocks (§7).
   - **Planning numbers (0d):** the Codex runs' per-run token mix repriced at the Claude catalog prices.
     - Sonnet is priced like Sol; Opus is 2× Sonnet (Astra was 5× Sol); Haiku is priced like Luna.
     - Assumption: B ≈ A under v2.2.
   - Per run, at a token multiplier of 1:

| Dataset | A | B | C | F | 4 arms × 3 reps |
|---|---|---|---|---|---|
| DeepSWE | $0.71 | $0.68 | $1.35 | $0.13 | $964 |
| TB | $0.20 | $0.19 | $0.37 | $0.02 | $198 |

   - Both datasets together: **$1,162 × the multiplier m** (Claude Code tokens / Codex tokens).
     - m = 2 gives $2.3k; m = 3 gives $3.5k; m = 4 gives $4.6k. Stage 1 is a third of each.
     - The $8,000 budget is reached only at m ≈ 6.5, after the pilot and about $150 of runners.
     - This agrees with 17's $2.3–4.0k.
   - **Caveats:**
     - Explicit Claude cache writes (5m, 1.25× input) replace part of Codex's uncached input.
     - Helpers on Haiku add little.
     - If B routes to Opus more than expected, its cost moves toward C's.
     - The pilot's per-arm κ supersedes these numbers.

## 11. Amendment 2 (2026-11-07, before any tier-pass, pilot or stage-1 outcome): call classes and request sanitising

1. **Three call classes instead of two.** This replaces the main/helper split in §1.1.
   - **main:** the root session's main loop.
   - **main-model subagent:** Task subagents that inherit the main model.
   - **helper:** calls carrying a Haiku-named model that Claude Code requested: background calls and Explore.
2. **The policy each arm runs** (policy.sessionTier: "root"):
   - In **A, C and F**, main calls and main-model subagent calls run on the arm's pinned model.
   - In **B**, both run on the model mapped from the session's single assessed tier. Subagents never trigger their own consult.
   - Helpers run as Claude Code requests them in every arm.
   - So B's estimands compare "main loop and main-model subagents on the assessed tier", not the main loop alone.
3. **§4.2 preconditions, extended to the new class:**
   - (3) in pinned arms, 100% of main and main-model subagent calls are served by the pin;
   - (4) in B, 100% of them are served by the assessed tier's model, with exactly one consult per root session;
   - (5) and (6) are unchanged for helpers.
4. **H1–H3 report all three classes per arm:** share of calls, tokens and cost. H2's main-only cost ratio becomes "main + main-model subagent", with helpers removed.
5. **Request sanitising.** The router sanitises `metadata.user_id` and strips the rejected `advanced-tool-use` beta.
   - It is on by default and identical in every arm, so it is part of the common treatment and doesn't enter any contrast.
   - S6 reports, per arm, how many requests were changed (descriptive). They are expected to be similar across arms.
   - Requests that need no change are byte-identical.

## 12. Amendment 3 (2026-11-07, before any tier-pass, pilot or stage-1 outcome): call-role details (with 4f)

1. **`sanitized` values** use the router's full names, for example `beta:advanced-tool-use-2025-11-20` and `user_id`.
2. **`assessor_consults`** = the number of assessor invocations per root session, from the router logs, joined at merge (17).
   - An invocation counts whatever its status. A reused cached assessment does not count.
   - Precondition §4.2 (4) is checked on the merged value.
3. **Roles in arm F.** In F every call is Haiku, so `call_role` comes from request structure: no tools (background calls), or Explore's read-only tool set from the capture.
   - **Cross-check:** the same structural classifier is also run in A, B and C, next to the model-name role, and the agreement rate is reported.
   - If agreement is below 99% on main + helper calls in A/B/C, F's helper share is reported as "not reliably classifiable", and F is left out of the H1/H3 comparisons.
   - **Null roles in F:** a null `call_role` in F from structural ambiguity does **not** fail §4.2 (1)–(2), provided the call is attributed to its trial and served by the pin. Every F call is Haiku either way, so serving is unaffected. These calls are reported as "unclassified" in H1.
   - Elsewhere a null role still fails the precondition.

## 13. Amendment 4 (2026-11-07, before any tier-pass, pilot or stage-1 outcome): native per-role models

The user's decision is that "helpers keep Claude Code defaults". 0c's reading of it: the pinned Claude Code 2.1.318's **native** per-role model choice, with Harbor's alias override neutralised (R6). The choice is whatever that turns out to be, and nothing is forced to Haiku.

**4a, binding whatever the native choice is: the expected-model check.**
- 4f's capture produces a frozen **native role table**, hashed and recorded here before the pilot. It uses the cc_agent subclass, with a mock that actually drives Explore, Task, Plan, background and compaction calls.
- The table maps each request type to the model Claude Code requests, as a function of the main model M:
  - main loop;
  - Task or main-model subagent;
  - Plan;
  - Explore;
  - background (title, summary and similar);
  - compaction.
- Precondition §4.2 (5) is replaced by a stronger one. For every call, in every arm:
  - `requested_model` = table[request type](M_arm);
  - **and** `served_model` is as §4.2 (3)/(4) require for main and main-model subagent calls, or = `requested_model` for helpers.
  - Here M_arm is the pin, or in B the assessed tier's model.
- A call whose request type isn't in the table is a violation, not a default.
- So a Harbor-style override, where every call requests M, fails whenever the table says something else.
- **Request type from structure.** The request type is taken from request structure (`call_role_struct`, §12) in every arm, so the check doesn't depend on the model name. §12's 99% agreement rule then compares the structural type with the table's expected model.

**4b: BINDING (case observed 2026-11-07, see 4c). It was conditional on the native table putting every request type on M, and the table does.**
- In that case the "defaults" policy has no Haiku helpers. The helper class is **empty by observation, not by design**: Claude Code itself chose M for every role.
- §1.1 and §11 then read:
  - each arm runs every call on its main model;
  - in B, every call runs on the assessed tier's model;
  - the estimands are unchanged, but the report states that these contrasts are policy contrasts in which helpers also changed model.
- **H1–H3** are reported by **structural** request type (Explore, background, Plan, compaction, Task, main), with each type's model as observed. The "helper" share becomes "the share of helper-type calls", all on M. H2's "main-only" ratio drops the helper-type calls; it stays descriptive.
- ~~0c records which case holds, with the table hash, before the pilot. 4b's text then either becomes binding or is struck through, and nothing else changes.~~ This is done; see 4c.

**4c: the record (2026-11-07, before any pilot or stage-1 outcome).**

*The table and its hash*
- The frozen native role table is `experiments/claude-code-harbor/native-roles.json`, as committed on cc-harbor in **8f4c677**, sha256 **cdd8ddab5cb8…beb4515b3** (0d re-hashed the committed blob).
- The working tree has one uncommitted edit: it removes `claude_code.commit`, an upstream 40-hex sha that would trip N5's 12-digit check.
  - With that edit the file's sha256 is 89f7e8c0908dd81855ec90f2fb62240cc160499df595d9fa2ae94be84807ba93, and `roles` is unchanged.
  - If that edit is committed, the 89f7e8c0… version is the frozen table. **Any other change to `roles` or `classifier` needs a new amendment.**

*How it was captured*
- The pinned Claude Code 2.1.318 binary was run directly, with no Harbor, in an isolated network namespace against a scripted mock.
- The environment was identical to cc_agent's, with CLAUDE_CODE_SUBAGENT_MODEL unset.

*What the table shows*
- Every observed role requests the main model M, for M = Sonnet, Opus and Haiku. The roles observed are main, Task (general-purpose), Plan, Explore, and compaction (under Sonnet only).
- **No background or tool-less requests occur in --print mode.**
- Under Opus and Haiku the session hit Claude Code's own blocking limit before compaction. M is expected there too.

*Binding rules from this table*
- **The helper class is empty by observation.** Every call in every arm is expected to request the arm's main model:
  - the pin in A, C and F;
  - in B, the Claude-side main model that B's agent config names. The router serves it on the session's assessed tier (§11), and that covers compaction and all subagents.
- **Deviation:** any call whose `requested_model` ≠ M_arm. For example, a Haiku-named call in A, B or C, or a background-type call naming another model.
  - A deviation is **never remapped**. It is served as requested, if the router allows that, and it is reported.
  - In the **pilot**, any deviation stops the run before main, so 0c and 4f can investigate.
  - In the **main run**, deviations are counted per arm and type in S6. If any trials have them, a sensitivity excludes those trials, whole tasks across all arms, to keep the pairs intact.
  - A refusal by the router counts as sut (§7).
- **Background-type calls,** if they appear in the run although none appeared in --print, are checked against M like every other type.
- **H1–H3** are reported by structural type, as 4b says.

*Hash update (2026-11-07, before any pilot outcome)*
- **The binding native role table is sha256 89f7e8c0908dd81855ec90f2fb62240cc160499df595d9fa2ae94be84807ba93**, cc-harbor d32c6a1. 0d re-hashed the committed blob.
- cdd8ddab… was the pre-N5 draft of the same `roles`. 0c amended the unpushed commit, so that version exists in no commit.
- Where 4c above names cdd8ddab… or 8f4c677 as the frozen version, read 89f7e8c0… and d32c6a1.

## 14. Amendment 5 (2026-11-07, before any pilot or stage-1 outcome): arms final; report plan for "is Opus worth routing to"

**Arms.** The arms are final at A, B (v2.2), C and F. This is the user's decision, with no v2.1 arm, so the §1/§3 B-arm amendment path in the status line is not used.
- The tier pass is informational only: it reports v2.2's tier mix on Claude Code cards.
- It still fixes the §3.1 strata, frozen before the pilot.

**Report plan.** These sections are required in the final report. They answer "is Opus worth routing to" without a routing arm that uses Opus often.

1. **S4, selection ability, under the §3.1 rule.**
   - It is reported only if both v2.2 strata (and, for the subset, the three-pass-agreement strata) have ≥ 15 tasks. Otherwise the report says "not estimable at this stratum size", gives the counts, and shows each stratum's C − A as description only.
   - The B − A decomposition Σ w_s Δ_s is shown in either case.
2. **S3, the ideal per-task router, descriptive and not achievable.**
   - It runs over {F, A, C}, and also over **{A, C} only**. The two-tier version answers whether picking Opus per task beats always using Sonnet.
   - Each version has two forms:
     - **Held-out:** for each rep r ∈ {1, 2, 3}, choose a tier per task on the other two reps, score it on rep r, and average the three folds. Ties go to the cheaper tier.
     - **In-sample:** run 1 only, labelled as an upper bound inflated by noise.
   - Each form reports the resolve rate, cost, Δ vs A and the cost ratio vs A (with CIs), and the choice shares.
3. **Opus-specific rescue mass, descriptive:**
   - mean_t (1 − p_A)(p_C − p_A), the gain beyond what a Sonnet re-run would give;
   - next to it, (1 − p_A)·p_C and (1 − p_A)·p_A, as in escalation §7.1;
   - the number of tasks with p_C > p_A and with p_C < p_A.
   - This bounds how much any Sonnet→Opus routing could gain on these tasks, for an oracle router and for a perfect-signal escalation.
4. **Per-task C − A heterogeneity, descriptive:**
   - the distribution of per-task differences;
   - the share of discordant tasks;
   - the TB author-difficulty split (as TB §7.8), side by side with the Codex Astra − Sol figures (§6).
5. **Stage-1-only case (if the user stops after stage 1).**
   - S3 held-out and S5 need ≥ 2 reps, so they are not reported.
   - Items 3–4 are reported from rep 1 only, labelled "1 run per task; per-task rates are 0/1".
   - S4 follows the §3.1 rule with the §8.2 99.9% CIs.

## 15. Amendment 6 (2026-11-07, before any pilot or stage-1 outcome): a two-arm Sonnet vs Opus check, rep 1 only

**User decision, verbatim:** "还想确认 Claude Code + 5.5 是否也是这个模式，只跑一个小规模验证：只跑 Sonnet 和 Opus 两组的第一阶段。" (confirm whether Claude Code + 5.5 follows the same pattern, with only the Sonnet and Opus arms, stage 1). It was made after 0c's offline analysis of the public DeepSWE trials (mini-swe-agent, effort high, 4 attempts, 112 tasks). That analysis found:
- Opus 5 at 73.3% and $6.08/run, Sonnet 5 at 48.2% and $7.38/run;
- C − A = +25.1 pp [+16.7, +33.3], and a per-run cost ratio of ×0.82.

### 15.1 What changes

- **Arms:** A (pinned Sonnet 5.5) and C (pinned Opus 5.5) only. **B and F are not run.**
  - Every estimand, check and section that involves B or F is **not run**:
    - P1/P2, S1, the B − A/B − C/B − F/F − A parts of S2, S4 and §3 (selection ability, strata, held-out caveat);
    - H checks that are B-specific, and §4.2 (4) and (6);
    - the B and F rows of §8 and §14;
    - the {F, A, C} versions of S3.
  - **No tier pass** is run.
- **Runs:** rep 1 only, on both datasets: DeepSWE 112 × 2 = 224 runs, TB 84 × 2 = 168 runs, plus the pilot slice for A and C.
  - **This is the final analysis of this experiment, not an interim look.** §8's staged design is superseded: there is no look and no Haybittle–Peto, and claims use **plain 95% CIs**.
  - If the user later asks for more reps, that is a new, separately pre-registered extension. The §15.3 verdict stays decided at rep 1 and is not re-tested on the combined data. A combined 3-rep result would be reported as an estimate with its CI, labelled as an extension.
- **Blinding:** no outcome is computed or shown until rep 1 is final on both datasets. The pilot is calibration only (§4.1).

### 15.2 Estimands, per dataset and never pooled

**Primary: C − A resolve.** `paired_mean_diff` at 1 run per task: the mean over tasks of [C's run − A's run]. Paired task bootstrap 95% CI, with the stats.py seed and n_boot.
- Sensitivity: exact McNemar, with the discordant counts (C-only and A-only solves).
- On TB: the primary is the §5.1 basis, scanner v2. As-graded is a sensitivity, and a verdict is stated without qualification only if both bases agree.

**Cost:**
- Per-run cost ratio C/A (`cost_ratio`, ratio of sums, bootstrap CI). This is the primary cost estimand.
- Per-solve cost ratio (`usd_per_solved_ratio`, paired bootstrap CI), plus each arm's $/solve.
- All costs include every call, since §13 puts every role on the arm's model.

**Opus-specific rescue mass, rep 1, labelled "per-task rates are 0/1".** At one run per task, mean_t (1 − a)(c − a) reduces to the share of tasks that only C solves. So report:
- the counts of tasks solved by C only, by A only, by both and by neither;
- C-only − A-only as a share of tasks, which equals C − A;
- C-only / (C-only + neither): Opus's rescue rate on the tasks Sonnet missed. Descriptive.

**Expected precision** (Codex prior, rep 1): C − A ±6.4 pp on DeepSWE and ±5.4 on TB, at 95%.
- With about 80% power, a true C − A of about +9 pp on DeepSWE (+8 on TB) gives a CI lower bound > 0: (1.96 + 0.84) × the SE.
- A true +15 pp or more is detected essentially always.

### 15.3 The "same pattern" reading rule, per dataset

The public pattern has two parts: Opus resolves clearly more than Sonnet, and Opus is not more expensive per run. Each part gets a verdict from the 95% CI.

| Part | CONFIRMED | NOT CONFIRMED | INCONCLUSIVE |
|---|---|---|---|
| Resolve (C − A) | CI lower bound > 0 | CI upper bound < +5 pp (a practically relevant gap is ruled out) | otherwise |
| Cost per run (C/A) | CI upper bound ≤ 1.10 (no more than 10% dearer) | CI lower bound > 1.10 | otherwise |

How the two parts combine:
- **Same pattern:** both parts CONFIRMED.
- **Different pattern:** either part NOT CONFIRMED. The report says which part.
- **Inconclusive:** anything else. The report says which part is inconclusive.

Size descriptor (not a verdict): the report also says whether C − A's CI lower bound exceeds +10 pp, "a gap of at least the public data's order", or not.

How the datasets are read:
- **DeepSWE is the primary dataset** for this question, because the public pattern comes from DeepSWE.
- **TB gets its own verdict,** reported next to DeepSWE as a second benchmark. The two are not combined.
- The per-solve cost ratio is reported next to the verdict but doesn't enter it.

### 15.4 Comparison with the public Claude 5 numbers (descriptive only)

- **Shown side by side:** the public mini-swe-agent Claude 5 results (Opus 5 vs Sonnet 5, effort high), both as 0c computed them (4 attempts) and with **attempt 1 only**, for matched precision, next to our Claude Code 5.5 rep-1 results, on the same 112 DeepSWE tasks.
- **Per-task agreement:** the share of tasks where C − A has the same sign in both, and the correlation of per-task C − A. Descriptive.
- **Not allowed:**
  - pooling;
  - any test of whether the difference between the two is zero;
  - any claim that it is the agent, the model generation or the price ratio that explains a difference. Agent, model generation, prices and harness all differ.
- **Verification:** 0d re-checks 0c's public analysis script (`analyze.py`) before the report and records its hash and outputs here. The public numbers are reference only.

### 15.5 What carries over unchanged, restricted to A and C

- **§4.2 attribution:** (1) every call attributed; (2) every call has a role; (3) every call in A and C is served by the pin; the §13 native-role check, where every call requests M_arm and any deviation is reported, never remapped, and a pilot deviation stops the run.
- **§5.1 lookup scanner v2 (TB):**
  - Calibration uses the Codex TB logs plus the A/C pilot transcripts, including the 2 "scanner-cal" tasks.
  - Freeze criterion (b) applies to A and C.
  - The task-level flag list (≥ 2/3 of runs in ≥ 3 of 4 arms) becomes **"flagged in both arms"**, since each arm has 1 run.
- **§5.2 oracle checks:** pre-run on both datasets. The TB post-run oracle runs after TB rep 1. The pre-stage-2 check is moot.
- **§7 classification and reruns, §9 OOM** (verifier-scored, with the all-unresolved sensitivity and the OOM-task drop), and **§10 items 1–2 and 5** (caps). The planning numbers at m = 1: DeepSWE A+C 112 × ($0.71 + $1.35) = $231, TB 84 × ($0.20 + $0.37) = $48, so about $280 × m.
- **§11–§13:** call classes, sanitizing and the native role table hash.
- **§6 cross-agent section:** only C − A against Codex's Astra − Sol, with Codex's rep 1 shown for matched precision.

### 15.6 The public analysis, re-checked (0d, 2026-11-07, before any pilot or stage-1 outcome)

**Reproduction.** 0c's `experiments/claude-code-harbor/public/analyze.py` (cc-harbor 811c617, sha256 8082e67e…) was re-run on `trials.json` (sha256 310cb428…, not committed) with the assessor-v22 call files. The output is **byte-identical** to 0c's (md5 f630e944…).

**Inputs checked:**
- d1a's calls carry `assessor/v2.2-d1a+e2183dce2cb9`, the same content hash as v2.2-D (`+e2183dce2cb9`).
- The v22d-eval held-out calls match the committed score exports task for task: 45 × 3, all standard.
- Opus 5 has 3 tasks with 3 scored attempts. The held-out ideal router needs 4, so it uses 109 tasks.

**0d additions (`--extra`).** The new script has sha256 02aba07a54e3bcede02b24c34c953e58e4b7a20fd3b554b3fe91e2c62615c4fd. The default output is unchanged, and the `--extra` block runs on its own RNG.

**Attempt 1 only, for matched precision with our rep 1.** Attempt 1 is the earliest-started scored attempt; the public rows carry no `run_attempt`.

| | Opus 5 − Sonnet 5 | Cost per run C/A | Cost per solve | Exact McNemar |
|---|---|---|---|---|
| Attempt 1 only | +25.0 pp [+13.4, +36.6] | ×0.80 [0.74, 0.87] | ×0.53 [0.42, 0.67] | p = 0.0002 |
| All attempts | +25.1 pp [+16.7, +33.3] | ×0.82 [0.77, 0.89] | ×0.54 [0.45, 0.64] | — |

- Attempt-1 counts: both 43, Opus only 41, Sonnet only 13, neither 15. Opus rescues 73% of the tasks Sonnet missed.
- **The public pattern meets the §15.3 rule at attempt 1 on both parts:** the resolve CI lower bound is +13.4 > 0, and the cost CI upper bound is 0.87 ≤ 1.10. That makes it a fair template for our rep 1.

**The held-out ideal router depends on the tie rule.** 0c's version sends ties to Sonnet and gives 71.0%; with ties to the cheaper tier (Opus, here) it gives 75.3%, with 77% of choices going to Opus. Against pinned Opus on the same 109 tasks (73.2%), the cheaper-tie version is **+2.1 pp [−1.8, +6.3]**. Either way, the router has **not been detected** beating pinned Opus. §14's rule (ties go to the cheaper tier) applies to our report.

### 15.7 Scanner v2 calibration record (§5.1; 0d, 2026-11-07, reward-blind, before any pilot or stage-1 outcome)

- **Criterion (a) passes.** On the 1,008 Codex TB runs (978 scanned; 30 have no local transcript, a fetch gap on the dev box), lookupscan v2 at VERSION d68ada39 flags **0** runs. v1 flagged 102.
- **v2 before revisions already met (a):** 15 flags, 1.49%. The four reward-blind revisions R1–R4 then removed the four false-positive classes that TB report §5 had already identified by hand:
  - R1: `command -v curl` doesn't count as a download;
  - R2: a search for the task's own subject, required by the instruction;
  - R3: an L1 string inside a file edit;
  - R4: imports, license headers and comments are not distinctive.
- **Added for transparency, S6:** the TB report also gives, per arm, the flags that **v2 without R1–R4** would raise, and the exempt counts per rule (L1_search_exempt, L1_site_exempt, L2_lines_exempt, L2_canary_exempt). A reader can then see what the revisions exempted. These are descriptive and never part of the primary.
- **Required before freezing:**
  - **R2 is narrowed.** A search stays exempt only if it contains none of: solution, solve.sh, test_outputs, tests/, oracle, answer, tbench, terminal-bench, harbor. A synthetic positive test, a query naming the task id together with "solution", must flag. If this changes lookupscan, it gets a new VERSION and (a) is re-run.
  - **Criterion (b)** is checked on the A/C pilot transcripts, reward-blind, including the 2 scanner-cal tasks.
  - The frozen VERSION goes into run-config before TB main. A revision after (b) means re-running (a) and (b).
- **Caveat stated in the report:** with 0 positives in calibration, the scanner's sensitivity rests on its synthetic positive tests: benchmark repo, site, HF, tooling, a search naming the benchmark, solution URLs, the canary, and ≥ 3 solution lines from download output.
- **R2 narrowed (4f, 2026-11-07).** Scanner VERSION **f462bb9a58e0e9c2** (cc-harbor 62b5687). A task-id search containing any of the listed terms is never exempt, and six synthetic positives (task id plus solution, solve.sh, answer, oracle, tests/test_outputs.py or harbor) all flag.
  - **(a) re-run: 0 / 1,008.**
  - The base counts (v2 with R1–R4 off; descriptive, the per-record `base` field) are identical to the earlier pre-revision run:

| Arm | Base flags | Exempted by |
|---|---|---|
| A | 4 | R2 2, R1/R4 2 |
| B | 5 | R2 3, R1/R4 2 |
| C | 4 | R2 3, R1/R4 1 |
| F | 2 | R2 1, R3 1 |
| **Total** | **15** | R2 9, R1/R4 5, R3 1 |

  - Base-flagged tasks: mteb-leaderboard 9, make-doom-for-mips 4, sam-cell-seg 1, fix-git 1.
  - Exempt counts: L2_canary_exempt is 9 per arm, every one canary-in-environment.
  - **Still open before the freeze:** criterion (b) on the A/C pilot transcripts.
- **Scanner-cal tasks (0d verified, 2026-11-07):** hf-model-inference and pytorch-model-recovery.
  - Source: the TB pilot plan `experiments/claude-code-harbor/tb21/plan.json` (cc-harbor e6fd568), `passes.pilot.labels["scanner-cal"]`.
  - The draw reproduces with `random.Random("20261107:scanner-cal").sample(sorted pool, 2)`.
  - The TB pilot is 9 tasks × A/C × 1 = 18 trials.
  - The (b) script requires both tasks to have a final pilot run in A and in C. Its pass rule: no pilot task is flagged in both A and C.
- **Criterion (b) passes; scanner FROZEN (0d sign-off, 2026-11-07, reward-blind, before TB main).**
  - 4f's result on the 18 TB pilot finals (9 tasks × A/C, attempt 1, all class `agent`): A 0/9 flagged, C 0/9; the base layer (R1–R4 off) flags 0/18 and no exemption fired. No task is flagged in both arms.
  - Both scanner-cal tasks (hf-model-inference, pytorch-model-recovery) have a final pilot run in A and in C.
  - Transcript completeness, text-free: source cc-session 18/18; session tool_use count = stream-json count 18/18; 3–14 tool calls per run; no subagent files.
  - (a) stands at 0 / 1,008: no revision since VERSION f462bb9a58e0e9c2, so no re-run.
  - **Frozen VERSION f462bb9a58e0e9c2.** 0d re-hashed `experiments/deepswe-harbor/lookupscan.py` (sha256[:16]) at main, cc-harbor and 62b5687: all three match. driver.py records this value as `lookupscan_version` in run-config; all 4 TB runners show it (0c). Any change to lookupscan.py before the TB report means a new VERSION, re-running (a) and (b), and a disclosure.
  - **Caveat, unchanged:** with 0 positives in calibration, also on the 2 scanner-cal tasks, the scanner's sensitivity rests on its synthetic positive tests.
  - **(a)'s denominator, corrected (4f, 2026-11-07, after the run):** 0/1,008 is effectively **0 of 978 scannable** Codex TB runs.
    - 24 runs had no trial dir, because the export name filter (token/secret/credential) dropped every vulnerable-secret and count-dataset-tokens trial.
    - 6 had leakscan-blocked transcripts: 5 sanitize-git-repo and 1 make-doom-for-mips.
    - These 30 count as unflagged with source "missing".
    - The Claude Code TB run is unaffected, because lookupscan runs on the runner before export (186/186 scanned).
  - **Disclosure:** while running (b), 4f printed a row's key names, which showed the field names `reward` and `score` but no values. This is not an outcome look.

## 16. Amendment 7 (2026-11-07, after the DeepSWE A/C pilot re-run, before main; pilot telemetry only, no reward seen): `count_tokens` is an auxiliary non-model call

**Why.** The pilot re-run failed one precondition only: 4 of 541 calls (2 in A, 2 in C, one per trial) had a null `call_role` and `call_role_struct`, and so `calls_count_mismatch` for those 4 trials. 0c reports all 4 are `POST /v1/messages/count_tokens`, answered 404 locally by hproxy and never forwarded (no router event, $0; correction below). So Claude Code uses its local token estimate, in both arms alike. The native role capture (§13) ran under the same condition: its mock (`e2e/mock_capture.py`) also answers count_tokens with 404, so the role table was captured with count_tokens unavailable and is not reopened.

**Decision: count_tokens stays unavailable.** Making it work would change the harness or a route between pilot and main, which changes the treatment. The local 404 is the pilot's condition and is part of the common treatment in every arm, like sanitising (§11.5).

1. **Auxiliary-call predicate.** A call is `call_type: count_tokens` (tagged in hproxy, 4f) only if **all** hold:
   - method `POST` and path exactly `/v1/messages/count_tokens` (query string ignored);
   - **answered locally by hproxy:** never forwarded, so no router event and no router response headers; status 404; ledger cost $0 and no usage.
   - Identification: on DeepSWE main (untagged hproxy) by the path leaf; from the TB changeover on, also by hproxy's tag `call_type: count_tokens` with `call_role = call_role_struct = 'non_model'`. If both are present they must agree; a disagreement fails the gate.
2. **What it is exempt from:** §4.2 (1)'s router-log leg, (2) role, (3) served-by-pin, the §13 requested-model check, and cost. The calls-count check (17) counts model calls only (`/v1/messages`): hproxy model calls = router log events, 1:1, per trial. **It is not exempt from attribution to its trial:** an auxiliary call that cannot be tied to a trial still fails §4.2 (1).
3. **Still failing the gate, unchanged:** any other null-role call, any call on another path, and any model call without a router event.
4. **Stop rules in main (not remapped, not exempted):**
   - a count_tokens call that does **not** meet the predicate (e.g. it was forwarded, got a router event, a non-404 status, non-zero cost or usage) means the route or harness changed mid-experiment. The run stops for 0c, and a new amendment is needed;
   - this is checked on main exactly as on the pilot.
5. **No request body is stored** for auxiliary calls beyond what hproxy keeps for model calls (count_tokens bodies carry task context; N5).
6. **Reporting (S6, descriptive, per arm):** count_tokens calls, how many got 404, and the share of trials with ≥ 1. They never enter an estimand or a contrast. During the run they are used only for the stop rule in 4, not shown per arm (§4.3).

**Pilot record under this amendment (0c, outcome-blind):** 16 runs, all class `agent`, 0 reruns, 0 429s, $25.29; 0 gateway-fallback, 0 pin_served_other, 0 requested_wrong / main_served_wrong; router join 1,074 events, router_incomplete 0; PSI 0, no host OOM. With the 4 count_tokens calls classed per 1, every precondition passes. Projection at pilot κ: DeepSWE $406 + TB $87 + other $25 = $517, well inside the $8,000 rule (§1.1).

**Correction (2026-11-07, 4f via 0c, during DeepSWE main; factual, the intent is unchanged).** As committed in 849d515, §16 said the gateway answered count_tokens. In fact hproxy has answered count_tokens itself with a 404, never forwarding it, since 62b5687. The pilot records' origin `gateway` is hproxy's label for its local answers. The predicate in 1 and the stop rule in 4 are reworded to match. The value `non_model` counts as a role for §4.2 (2) only for calls that meet the predicate.

## 17. Amendment 8 (2026-11-07, after DeepSWE rep 1 closed, before any outcome is computed): memory-pressure telemetry on DeepSWE

**What 0c reports (outcome-blind).** DeepSWE closed with 224 finals. There was 1 harness rerun, and 1 verifier_infra exclusion (pwntools, C: the verifier timed out 3 times), so 111 pairs remain under §7. On runner 1 there was one memory-pressure episode with 0 OOM and cpu-full 0. A C trial of optique-conditional-option-dependencies reached its container limit and swapped.

**Reading.**
- This is telemetry, not a gate. The §10 PSI rule gates concurrency only before main, and no concurrency change was made.
- Swapping without an OOM is a normal agent run, scored by its verifier. §9 does not apply.

**The episode set: fixed by a rule and a frozen file, not by a count.**
- **Rule.** Every task in the DeepSWE main pass with any attempt, in either arm, whose host `psi_memory_some` over the trial window is above 0.05. That is the gate's `memory_ok` threshold.
- **Inputs, telemetry only:** task, arm, attempt, runner, is_final, host PSI/swap/OOM, and container memory peak and limit. No outcome field was read.
- **File:** `results/deepswe/memory-episode-tasks.json` (gitignored), sha256 45d1bd8e5b526f15d0702ccfb056f42e54b44789d6aa88d19c2876b9adb146a1, frozen 2026-11-07T19:10:57Z by 0c. The analysis reads the set from this file and checks the hash. The list below is only a record of it.
- **Result: 6 tasks.**
  - Tasks: gql-incremental-graphql-delivery, optique-conditional-option-dependencies, psd-tools-blend-range-api, tengo-destructuring-bindings, ts-pattern-match-each, updo-policy-alerting.
  - Trials above the threshold: 10, all attempt 1 on runner 1. These are A and C for gql, psd-tools, tengo and updo, and C only for optique and ts-pattern.
- **Correction.** An earlier draft of this section said "5 tasks × both arms". 0c had miscounted, and the frozen file holds the set.

**Sensitivity, pre-registered here before any outcome.**
- It drops the episode tasks as whole tasks in both arms, which removes 6 pairs: 111 − 6 = 105.
- It re-estimates C − A (CI) and C/A per run (CI) on DeepSWE.
- It is reported next to the §9 OOM-task-drop sensitivity and never changes the §15.3 verdict.
- The 0.05 threshold was chosen after the telemetry was seen, but before any outcome. It is the gate's own threshold, not a new one. This is disclosed in the report.

**S6, descriptive, per arm.**
- **Containers at their own limit** (peak ≥ limit): optique C and pebble-durability-wait-apis C. Pebble is not in the episode set, because its runner showed no host PSI above 0.05.
- **Final trials with pswpout > 0:**
  - A: 11 trials, 14.6M pages in total;
  - C: 13 trials, 30.9M pages in total.
- **The episode, by arm:** 4 tasks in both arms, 2 in C only.

## 18. Amendment 9 (2026-11-07, after TB rep 1 closed, before any outcome is computed): refusals whose Claude Code fallback the pin blocks

**What happened (0c, outcome-blind).**
- In 9 TB (task, arm) pairs the pinned model refused twice (stop_reason `refusal`; Claude Code retries once).
- Claude Code 2.1.318 then switched the session to its built-in fallback model:
  - Opus 5.5 → claude-opus-4-8 (cyber) or claude-opus-5 (bio);
  - Sonnet 5.5 → claude-sonnet-5 (cyber).
- hproxy answered that request with 403 `model-not-allowed`, and Claude Code exited with an API error.
- The classifier called this `upstream`, reran it ×2, then excluded it.
- **The pairs.**
  - A has 3: crack-7z-hash, vulnerable-secret, break-filter-js-from-html.
  - C has 6: those 3 plus password-recovery, dna-insert, dna-assembly.
  - That is 6 tasks: 3 refused in both arms and 3 in C only.
- DeepSWE had no such pair. One C trial there had a single refusal call and went on normally.

**Which pre-registered rules apply.** The `upstream` class was wrong, because the event is deterministic and a rerun repeats it (it did). Three rules already cover this case:
- §7: a refusal is an agent outcome, scored.
- §13 4c: the fallback request has `requested_model` ≠ M_arm, so it is a **deviation**. It is never remapped. A refusal to serve it counts as **sut**. In main, deviations are counted per arm and type, and a sensitivity drops those tasks whole.
- §7: sut is "scored 0 and listed; the router is the treatment". hproxy's pool check enforces the pin the same way the router's does, so it is read the same way.

The most specific rule decides the case: §13's deviation rule, refused, which is sut.

**Ruling.**
1. **Class:** `sut`, reason `refusal_fallback_blocked`. 17's reclass is deterministic and reward-blind, and it applies to every attempt on both datasets. An attempt is reclassed only if all of these hold:
   - the session has ≥ 1 model call with stop_reason `refusal`, served by M_arm;
   - after it, there is a request with `requested_model` ≠ M_arm;
   - hproxy answered that request 403 `model-not-allowed`;
   - it is the session's terminal API error.
2. **Which attempt is scored:** attempt 1 of each of the 9 pairs. Attempts 2–3 should never have run: they are superseded and never scored.
3. **Primary scoring:** the 9 trials are **scored 0** (unresolved), per the sut rule, and stay in every estimand. No pair or task is excluded, so §7's "> 3 excluded" sensitivity is not triggered by these pairs.
4. **Cost:** the per-run cost estimand uses attempt 1's cost for these trials, including its refusal calls. The cost of attempts 2–3 is reported in S6 and in total spend, but it is not in any estimand.
5. **Calls:** the 27 refused fallback requests (9 pairs × 3 attempts) are **§13 deviations**, not an exempt non-model class.
   - Their role comes from structure where possible; if that is not possible, it is `deviation`.
   - §4.2 (2)/(3) and §13 treat them as reported deviations, counted per arm, type and fallback model in S6. They are not gate failures, since this is main and not the pilot.
   - The served-by-pin check still covers every *served* call.
6. **Sensitivities, reported next to the primary:**
   - **(a) Drop the refusal tasks.** This is §13's pre-registered deviation sensitivity: the 6 tasks dropped whole, in both arms, 78 pairs on TB. Re-estimate C − A and C/A.
   - **(b) Verifier-scored.** Attempt 1 is scored by its verifier if the verifier ran, otherwise unresolved, as §9 does. This reads §7's "refusal is an agent outcome" literally.
   - If (a) or (b) gives a different §15.3 category than the primary, the TB verdict is stated with that qualification, alongside the existing scanner/as-graded qualification.
7. **S6, descriptive:**
   - refusal-blocked pairs per arm, by category (cyber or bio, from the fallback model name);
   - the 2×2 count: both arms 3, C only 3, A only 0;
   - all refusal calls per arm on both datasets, including DeepSWE's one non-terminal refusal.
   - The report says the pinned arms measure **the 5.5 model alone**: the pin blocks Claude Code's default fallback to an older model. In normal use those sessions would go on, on claude-opus-4-8, claude-opus-5 or claude-sonnet-5.
8. **Not part of this experiment:** re-running the 9 pairs with the fallback allowed. That is a different treatment (mixed models inside a pinned arm), and it would need router-pool and IAM changes. If the user wants it, it is a separately pre-registered extension, and the §15.3 verdict is not re-decided on it.

**Checks before 17's reclass merges, all reward-blind:**
- the rule matches exactly the 9 TB pairs, on every attempt, and 0 DeepSWE attempts;
- after the reclass, the list of remaining excluded (task, arm) pairs, by class, on both datasets;
- for the 9 attempt-1 trials, whether the verifier ran (yes/no only; this is needed for sensitivity b);
- the classifier version hash, bumped and recorded.
