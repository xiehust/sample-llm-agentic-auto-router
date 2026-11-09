# In-session escalation — design

§1–6 (signals, mechanism, code plan) are owned by 4f and 73. §7 (statistics, gate, live design, budget) is owned by 0d.

## 3. Retrospective signal study (4f; offline, $0)

**Result:** no-go. Among the 16 pre-listed rules, all router-observable and prefix-only, none fires selectively on failures, and none passes all three gate conditions on the held-out split. The no-go therefore doesn't depend on which rule was selected. 0d's check is in §7.8.

### 3.1 Data and signals

**Data**
- The final merged Harbor rows, with the analysis set as in the reports: phase ≠ pilot, scored, in_comparisons.
  - DeepSWE: 112 tasks × 5 runs per arm.
  - TB 2.1: 84 tasks × 3.
  - Arms used: A (Sol), F (Luna), C (Astra).
- No run in either experiment served more than one model. Every number below is simulated from pinned runs.

**Per-request state** (`experiments/escalation/signals.py`; text-free, counts only)
- The state comes from the Codex rollouts, joined to the proxy call log (status 200, seq order). The state at request k is what a router deciding request k can know.
- Rollout coverage: DeepSWE 2224/2240 runs, TB 978/1008.
- The rollout and the call log agree call for call in 2164 and 927 runs. In the rest the rollout lacks 1–4 tail calls; the signals carry forward and costs always come from the call log.
- Runs without a rollout never fire on body signals. Excluding them moves M2 by ≤ 1.6 pp.

**Who can observe each signal**

| Signal | Observable by |
|---|---|
| k (lineage call count); compactions (core's `compaction:shrink`: prompt < 0.6 × the peak since the last one); prompt tokens of call k−1; lineage spend | the router today (state and usage). Spend is in RequestLog, not yet in SessionState |
| card.stats.turnIndex, prevTurnToolErrors | the router today, but always 0 in a Codex exec run: one user turn, and the Responses dialect has no tool-error flag |
| non-zero exits and their streak, test runs and test failures (by command shape) and their streak, repeated commands, look-only streak | the request body, which Codex resends in full, but only with new parsing of untrusted text (Codex's "Process exited with code N") |
| encrypted reasoning content, the verifier | not observable |

**Descriptive constraints, before any outcome was joined:**
- Compaction happens almost only on Luna: 69 of 560 DeepSWE F runs, 1 A run, 0 C runs, and 2 runs in all of TB.
  - Codex compacts at 200k tokens. The median peak prompt is about 70k for Sol and Astra on DeepSWE, 132k for Luna, and about 20k on TB.
- The median TB run starts no test suite.

### 3.2 Method

The method is §7.2, which is binding. Everything was frozen before any outcome was joined: hashes in §7.7, `experiments/escalation/FROZEN.json`.

| | Sol→Astra (source A, target C) | Luna→Sol (source F, target A) |
|---|---|---|
| Rules | consec_nonzero ≥ 3 · ≥ 5 · test_fail ≥ 3 · consec_test_fail ≥ 2 · k ≥ q.75 · k ≥ q.90 · prompt ≥ 100k · repeat_cmd ≥ 5 | compactions ≥ 1 · compactions ≥ 1 ∨ consec_nonzero ≥ 3 · compactions ≥ 1 ∨ test_fail ≥ 3 · k ≥ q.50 · prompt ≥ 100k · repeat_cmd ≥ 5 · consec_nonzero ≥ 3 · spend ≥ 2 × the median F run cost |
| Selection (tune split) | max M2 ΔR vs Sol, with a fire rate ≤ 25% on Sol-resolved runs | max M2 ΔR vs Sol, with the high cost ratio ≤ 0.60 |

- The k quantiles and the spend constant come from outcome-free tune-split data:
  - DeepSWE: q.75/q.90 = 51/63, q.50 = 72, spend $0.201.
  - TB: q.75/q.90 = 27/49, q.50 = 13, spend $0.022.
  - The thresholds differ by benchmark. A deployed router wouldn't know the benchmark, so this is a deployment caveat.
- A rule fires at most once. A fire with < 15% of the agent timeout left keeps the run's own outcome.
- The scenarios for a fired run:
  - M0, no help;
  - M1, a fresh target run's rate;
  - M2, the optimistic scenario: a success is kept and a failure is rescued at the target's rate;
  - M2_self, the same with a second source roll.
- The gate cost is the source prefix + a cold cache write of the switching prompt on the target + a full target run.

### 3.3 Results

**Pipeline check.** "Perfect-signal, optimistic" (fire at request 1 on every failing run, M2, as graded, all tasks) reproduces §7.1:
- Sol→Astra: +4.8 on DeepSWE and +5.0 on TB.
- Luna→Sol vs Sol: +7.0 and +5.0.

**Gate.** Selected rule per escalation and benchmark; held-out split; primary basis; pp vs pinned Sol, 95% task bootstrap.

| | Rule | Fire rate (resolved / failed) | M2 | M2_self | Δ_spec | M1 | Cost vs Sol: high / splice / tail | Gate |
|---|---|---|---|---|---|---|---|---|
| Sol→Astra, DeepSWE | prompt ≥ 100k | 0.12 / 0.10 | +0.7 [0.0, +2.1] | +1.1 | −0.4 [−2.0, +0.8] | −0.5 | ×2.58 / ×1.58 / ×1.67 | a ✗ b ✗ c ✗ |
| Sol→Astra, TB | k ≥ 49 | 0.07 / 0.00 | 0.0 | 0.0 | 0.0 | 0.0 | ×2.19 / ×1.70 / ×1.49 | a ✗ b ✗ c ✗ |
| Luna→Sol, DeepSWE | repeat_cmd ≥ 5 | 0.21 / 0.22 | −12.3 [−21.5, −3.2] | −15.7 | +3.4 | −14.0 | ×0.51 / ×0.44 / ×0.26 | a ✗ b ✗ c ✓ |
| Luna→Sol, TB | prompt ≥ 100k | 0.10 / 0.03 | −19.6 [−33.3, −5.9] | −19.6 | 0.0 | −19.6 | ×0.34 / ×0.45 / ×0.20 | a ✗ b ✗ c ✓ |

What else the run shows:
- **Tune → held-out M2 for the selected rules:** +0.7 → +0.7, +0.2 → 0.0, −11.2 → −12.3, −8.7 → −19.6.
- **TB as graded** selects the same rules and reaches the same verdicts (Luna→Sol held-out M2 −15.7).
- **No rule passes on held-out, selected or not.** The only Luna→Sol rule at or above Sol is prompt ≥ 100k on DeepSWE (+2.7 pp), but it fires on 81% of Luna runs and costs ×1.23 vs Sol.
  - Below the ×0.60 cost line, every Luna→Sol rule is 12–20 pp below Sol.
  - Every Sol→Astra rule's held-out M2 is ≤ +2.0 pp, with Δ_spec ≤ +0.2.
- **Selectivity:** across the family, the fire rate on failed runs differs from that on resolved runs by at most 0.13 (TB as graded, k ≥ 13). On DeepSWE, test_fail ≥ 3 fires more often on Sol-resolved runs (0.35 vs 0.29).
  - Rescue-weighted recall of the selected rules is 0.00–0.24. Luna→Sol needs about 0.72 to tie Sol (§7.1).
- **Descriptive AUC scan:** failed vs resolved, runs alive at k ∈ {5, 10, 20, 40}, 11 signals × 2 escalations × 2 benchmarks, with no correction for multiple comparisons.
  - At k ≤ 10 every cell lies in 0.41–0.57, almost all with a CI covering 0.5. At k = 20–40 on TB only 28% and 10% of Sol runs are still alive; the point estimates spread wider there, with CIs that include 0.5.
  - One cell points the other way: Sol's consecutive test failures at k = 20 on DeepSWE, AUC 0.43 [0.39, 0.47]. In this cell, Sol runs with more consecutive test failures at k = 20 were somewhat more often resolved (one descriptive cell among many, uncorrected).
- **Most of a switch's cost is the continuation at Astra's prices**: about 5× Sol's per token, with cache reads at 10×. The cold write of the switching prompt (about $0.9 at 70k tokens, more than a mean Sol run) adds about a quarter. Even at 6–12% fire rates, Sol→Astra is ×1.5–2.6 vs Sol.

### 3.4 What this does and does not show

**The counterfactual is not identified.** An escalated session continues the source's transcript and container state. It also loses the source's encrypted reasoning and starts on a cold cache. M0–M2 are therefore a band of scenarios, not a bound, and the CIs cover task sampling only.

**Not tested:**
- an assessor re-consult mid-session;
- richer judgements of the transcript, such as a model reading the history;
- restarting on the target instead of continuing;
- other agents or clients;
- signals the router would see one request later than the frozen timing.

The negative result holds only for the pre-listed router-observable rules on these two benchmarks with Codex 0.166.

**Files:**
- Committed: `experiments/escalation/` (`signals.py`, `simulate.py`, `rules.json`, `FROZEN.json`, `tests/`, 8 tests).
- `results/` stays local: it joins run ids to outcomes.
- Committed files hold task ids and aggregates only.

## 4. Mechanism (4f; for the record: §7.8 is a no-go, so nothing here is proposed for building)

### 4.1 What the router can do mid-session today (Codex exec over Responses, full history per request)

- **No in-session model change is possible except failover and the context gate.**
  - Every request after the first ends in a tool output, which hits `hard-lock-tool-loop` (decide step 4, before any break point).
  - The history carries encrypted reasoning, so `portability['openai-encrypted-reasoning'] = 'same-model'` leaves only the current model eligible.
  - This matches the data: 0 multi-model runs in 3,248 analysed runs.
- **Hysteresis and `maxSwitchesPerLineage` don't apply.** They gate only cost-driven downgrades at user turns. Upgrades have no gate and no cap, so an escalation would need its own one-way, once-per-lineage limit.
- **The request after a Codex compaction is expected to be a free break point.**
  - Its history is [developer, user×3]: it ends in user text and carries no reasoning items.
  - It isn't an extension of any cached prefix record, so warm(current) = 0 and the shrink rule gives `compaction:shrink`.
  - It's the one switch point today without a hard lock, at a small prompt. To be confirmed by a core test before anyone relies on it. A `minCompactions` key on `PolicyRule.when` would be enough to act there.
  - The rule "escalate at the first compaction" failed the gate (−14 pp on DeepSWE; too rare on TB).
- **The assessor is consulted only at start points and user-text turns, never in a tool loop.** Its card stats carry no struggle information for Codex (§3.1).

### 4.2 What a switch costs

| Cost | Detail |
|---|---|
| Cache | The cache is per model. The first target request writes the whole prompt (u_k = prompt × the target's 30m write price): about $0.9 for Sol→Astra at 70k tokens, about $0.33 for Luna→Sol at 130k. Later cache reads cost 10× more per token in both cases (Astra vs Sol, Sol vs Luna). |
| Reasoning | The source's encrypted reasoning can't go to the target. It must be stripped on the switching request and on every later one, because Codex resends the history. The stripped items are the reasoning ids present at the switch; the target keeps its own reasoning. The target continues without the source's chain of thought. How Bedrock answers a foreign encrypted item is unverified (a cents-level probe by 0c before any live run). |
| Response chains | An escalation can fire only on a full-history request. A request with `previous_response_id` can't move to another model. |
| Time | Turns and time are already spent. A late fire is of no use (§3.2). |

### 4.3 If it were built: deterministic rule, code plan (not proposed)

**Policy.** An optional `escalation` section: `{ rules: [{ id, fromTier, toTier, any: [{ signal, ge }] }], maxPerLineage: 1, parser: 'codex-exec' }`.
- `validatePolicy` adds no key when the section is absent, so every existing config validates to the identical Policy object.

**Core**
- A new step after failover and before the hard locks, for a lineage with an `escalation=<id>` hint and a matching rule:
  - signals as in §7.7: call k−1's prompt from state, compactions over calls < k, and body counts from a summarize-time parser that emits counts only;
  - on a fire, `switch` to the target with point `escalation`;
  - `SessionState.escalation = { ruleId, atCall, from, to, stripIds }`;
  - from then on, the lineage's desired tier is floored at the target, and it never switches back.
- Fail-safe. Any of the following means no escalation, logged with a reason:
  - a parse error or an unknown rule id;
  - a target outside the pool or the context gate;
  - a recent failure on the target;
  - `previous_response_id`.

**Router**
- Hint key `escalation`.
- Strip `stripIds` reasoning items by replacing the top-level `input` member whole.
- The RequestLog `escalation` block and the `x-router-request-id` header (§6.5).
- Observe mode logs `wouldFire` only.

**Tests**
- Golden replays of recorded DeepSWE and TB request sequences through the engine, with and without the section absent: decisions and log lines byte-identical.
- With the section present:
  - fire at the exact request;
  - one switch only;
  - no switch back at a later break point;
  - the strip happens and is stable across requests, so the target's cache stays warm.
- Each fail-safe path.
- The pin path (A arm) untouched.

**Estimate:** about 1.5–2 days with tests, plus 17's §6 harness work.

**Assessor re-consult on struggle:** not proposed; see §4.5 (73).

### 4.4 Recommendation (4f)

- Don't build the escalation path, and don't run a live experiment (§7.8).
- If this direction is revisited, it needs a different kind of signal, such as a transcript judgement or a restart policy. Test it first offline with this harness: a new frozen rule family runs through `simulate.py` unchanged.

### 4.5 Assessor re-consult on struggle (73): not tested, deferred

The deterministic rule (§4.3) is the only mechanism considered for the experiment. A mid-session assessor re-consult is recorded as a deferred option, for three reasons:

1. **No $0 gate.** The §7.2 retrospective has no mid-session assessor calls to replay. A gate would need cards rebuilt from the recorded sessions and live assessor calls on them, under a separate pre-registration.
2. **No selection skill at session start.** Assessor v2.2 found no usable "Luna is enough" signal on the card (task 11-07-assessor-pack-v2-2).
3. **Struggle stats would repeat the rule's inputs.** Those signals already failed the gate (§3; AUCs 0.41–0.57). The only extra input a model could use is tool-output text, and card/v1 excludes it by design (untrusted content, no-text logging). Adding it would need its own security review.

If it is ever reopened, it needs:

- **Consult point:** a new point inside the tool loop, gated on `policy.escalation`. Core consults today only at start points and user-text turns (`meta.consult`). The call would be asynchronous: consult at request k, act at k+1 or later. That keeps the §7.7 timing and adds no request latency.
- **Rate limit:** consult once per pre-signal episode, or every N requests, and never after the lineage has switched.
- **Switching:** act only on upgrades, through the same switch mechanics as §4.3 (one-way, at most one per lineage, chainReset).
- **card/v2:** card/v1 rejects unknown keys and packs declare `card/v1`, so the stats need a new card version.
  - The stats: `requestIndex`, `toolCalls` and `toolFailures` in request k's body, `prevPromptTokens` (usage of call k−1), and `compactions` before k.
  - `toolFailures` can only be parsed from Codex output text ("Process exited with code N", N ≠ 0), because Responses `*_call_output` carries no error flag. Only the count would go on the card.
  - card/v2 would need its own pack and golden tests; the card/v1 packs (v1–v2.2) stay unchanged.
- **Cost and latency:** measured on Harbor Codex start cards (Luna, 1,176 calls), a consult costs $0.00034 on average with prompt caching. Latency is p50 1.44 s, p95 1.6–1.8 s, max 2.1 s. Mid-session cards would be about the same size.

## 6. Orchestration: per-run cap, switch verification, runbook delta (17)

This section is a plan only; nothing is implemented until the user approves. It builds on the Harbor harness
(`experiments/deepswe-harbor/`, the `--dataset` profiles) as it ran for TB 2.1.

**Contingent.** 4f reports that the §7.3 retrospective gate failed for all four escalations; 0d is to confirm. If so,
there is no live run and nothing here is built, unless the user approves a run anyway. The interfaces agreed with 4f
are recorded in §6.5, so the plan stays complete either way.

### 6.1 Per-run cost cap (TB $15, DeepSWE $30): yes, enforceable, fail-closed

**What exists.**
- The proxy's route already carries a per-run budget: R2E `proxy.Route.budget_usd` plus its one-call margin.
  `_admit` refuses a call when the run's settled spend plus this call's worst case exceeds it, and `budget_stopped`
  is sticky.
- hproxy sets that budget to `inf` today. The per-runner CapLedger (fail closed, reservations per call) is a
  separate check, and it stays as it is.
- So the per-run cap is the same admission rule at route level: a call that could push the run past its cap is never
  forwarded. Like the runner cap, it is a pre-call bound. A call that ends above its reserved worst case can overshoot
  by at most one call's error.

**What changes:**

| Where | Change | Owner |
|---|---|---|
| hproxy | `register_trial(trial_id, arm, cap_usd=None)` sets `Route.budget_usd`. The refusal gets its own code, `trial-cap`, distinct from the runner ledger's `budget`, with a non-retryable status so Codex ends the turn instead of retrying 4×. The summary gains `trial_cap_usd`, `trial_capped` (= `budget_stopped`) and `trial_cap_refusals`. Without a cap, all of this is absent, so DeepSWE and TB stay byte-identical. | 4f |
| driver | `run --trial-cap-usd X`: passed to register_trial and recorded in run-config and in every start event. status counts capped trials. A cap below the dataset's largest expected single run is refused by the start pre-flight, the inverse of today's check. | 17 |
| classify | A new first-match rule after `cap_stop`: `trial_capped` → class `agent`, action **`score_zero`**, reason `per-run cost cap`. The run is scored and stays in the analysis (0d §7.4), even if the verifier later passes. Without this rule it would land on today's "last call refused by the proxy → harness, rerun" path, which is wrong for this design. The runner cap keeps precedence: when the runner itself is cap-stopped, the run is `cap_stop`, excluded. | 17 |
| merge, harvest | `trial_capped`, `trial_cap_usd` and the capped run's reward in rows. A sensitivity row counts capped runs whose verifier passed anyway. | 17, with 4f for harvest |
| fleet | `start --trial-cap-usd` and the pre-flight; status shows `capped=N`. | 17 |

**Tests:**
- **hproxy (4f):**
  - the call that would cross the cap is refused, earlier calls aren't, and the refusal is sticky;
  - the refusal code and status are distinct from the runner ledger's;
  - reservations are released;
  - the runner ledger is unaffected by a route refusal, and the reverse;
  - no cap means exactly today's summary keys.
- **classify (17):**
  - `trial_capped` → `agent/score_zero` with reward 0, with reward 1, with NonZeroAgentExitCode, and with the proxy as the last call's origin;
  - `cap_stopped` together with `trial_capped` → `cap_stop`;
  - the DeepSWE and TB grids are byte-identical (golden).
- **driver (17):**
  - FakeProxy summaries with `trial_capped` → final `scored`, score 0, no rerun;
  - run-config and start events carry the cap;
  - the pre-flight refuses a cap below the largest expected run.
- **Integration (17):** the real RunnerProxy plus the mock router with a priced stream. Fake Harbor makes N calls; the cap trips at call k; the trial ends `agent/score_zero` and the runner ledger keeps running.
- **Goldens:** the DeepSWE and TB orchestration snapshots are unchanged with no cap.

### 6.2 One-way switch, at most 1 per lineage: what the harness needs to verify it per run

The switch is router-side (4f/73). The harness verifies it from three sources, joined per run:

1. **Proxy call log** (have it): per call it records time, status, origin, `served_model` (from the router's
   response headers), priced cost and `call_id`. That is enough to see a switch live, without router logs.
2. **Router logs** (needed, per request), keyed by `session` = trial_id, as `routerlogs.join` already does:
   - `reqId`, also returned to the proxy as a response header so each proxy call joins exactly one router line;
   - `lineage`, `turnIndex`, `servedModel`;
   - the escalation block: rule hash, signal values at this request, `fired` (bool), `switched` (bool, true only on
     the request that changes model), `from`/`to`, the lineage's `switchCount` so far, and `chainReset` (the first
     post-switch request drops source-model reasoning or response chaining);
   - `failover`, and the policy/config hash.
3. **Frozen-rule replay** (73/4f's `packages/replay` or equivalent): per session, the request index at which the
   frozen rule fires on the logged signals, or none. It writes JSON keyed by session.

**Per-run derived fields** (merge, into rows):
- `served_seq`: the run-length encoded served models, e.g. `Luna×23,Sol×41`;
- `n_switches`, `switch_req` (request index), `switch_turn` (turnIndex);
- `switch_t_left_s`: the agent timeout minus the elapsed time at the switch;
- `cost_pre` / `cost_post`: the proxy's priced split at the switch;
- `cache_after`: the cached-token share of the first 5 calls after the switch;
- `capped`.

**Integrity checks.** A new `switchcheck.py` (17), run in `fleet.py merge`; any failure is reported as a mechanism
failure per 0d §7.4:
- **I1 (A arm):** 0 switches; every served model is Sol; no escalation block fires.
- **I2 (E arms, one way):** the first served model is the source; `served_seq` is `source+ target*`; there is no
  target → source transition; served models ⊆ {source, target}.
- **I3:** ≤ 1 switch per lineage (router `switchCount` ≤ 1), and ≤ 1 per run unless the run has more than one
  lineage. `unique_lineages` is expected to hold, as it did on TB and DeepSWE.
- **I4 (replay):** for every E run, the replayed firing request equals the observed `switch_req` (100%). Runs where
  the replay doesn't fire have 0 switches. A late-fire block (the rule fired but no request followed) is listed, not
  failed.
- **I5 (reconciliation):** every proxy call of a run has exactly one router line, and the reverse, by `reqId`.
  `served_model` agrees between the proxy and the router. The proxy's call count equals the router's.
- **I6:** 0 router-origin failures and 0 failovers in A and E. The rule and policy hash on every line equals the
  pre-registered hash.
- **I7:** at the switch, `chainReset` is true, and the next request carries no `previous_response_id` chain into the
  target. The router logs the flag; the proxy confirms the request had no source-model encrypted reasoning items,
  from body keys only, never text.

**Live checks** (driver, from the proxy log only, at the end of each trial):
- the trial's `served_seq`, `n_switches` and `switch_req` go into the end event;
- I1 or I2 failing live, or > 1 switch, raises a `mechanism` alert in status, and in the pilot halts the runner;
- the pilot's firing rate, outside 0.5×–2× of the retrospective rate, is shown in `fleet status` for 0c's
  pre-registered stop (mechanics only, no resolve).

A **forced-fire smoke** (threshold 0, one task, outside the analysis) must show `switch_req` = 1 or 2,
`chainReset`, then I1–I7 PASS.

**Tests (17):**
- synthetic router-log and proxy-log fixtures for each check, PASS and FAIL;
- a replay mismatch, a reverse switch, two switches, a missing router line, served-model disagreement;
- a live-check halt in the pilot;
- goldens unchanged.

### 6.3 Plans, arms and the runbook delta from TB

**Arms in the harness.** Arms are one tuple in shardplan, harbor_job and hcommon. Arms become per plan: the plan
lists its arms, and the proxy route stamps the arm's hint. A stays as today (`pin=Sol`). E_FS and E_SA get the hints
4f/73 define. The A arm's router path must be byte-identical (0d), checked by I1 plus a request-hash comparison
against the TB A arm on the smoke task.

**Plans.** A new `shardplan.py --dataset {tb21-esc,deepswe-esc} derive` command:
- it keeps each benchmark's committed shard assignment, digests and drop lists (TB: the 84 kept tasks and
  flaky_env, per TB §7.5; DeepSWE: the 112);
- it writes passes `main`, then `rep2`…`rep5`: arms A, E_FS (and E_SA if it passes the gate), N = 5, stratified,
  long tasks first, seed 20261107;
- the pilot gets 2 tasks per shard, plus the forced-fire smoke task.

Two new profiles with their own plan and results directories; DeepSWE and TB stay byte-identical (goldens).

**Runbook delta** (runners are torn down, so redeploy first). TB first, then DeepSWE, with no outcome look between
them (0d):
1. **Deploy:**
   - a3 redeploys the runner stack;
   - 0c deploys the router with escalation available but off by default, so A is byte-identical;
   - verify the router hash.
2. **TB:**
   1. a3's switch to `CONTAINER_EGRESS=internet`;
   2. `$T pack`, `ship`;
   3. `isolation --wait`;
   4. `setup`, `prepull`;
   5. `check`: the checks are re-run on the new hosts because the internet content can change. The pre-registered TB
      drop list stays fixed; a new failure is reported, not dropped.
   6. the forced-fire smoke;
   7. the pilot, with `--trial-cap-usd 15` and the per-runner caps from 0d §7.5. Gate: mechanics, I1–I7 and the
      firing-rate stop;
   8. main with `--max-blocks 6` as a status look, then the rest;
   9. `check --post`, `fetch --mode full`, merge plus switchcheck.
3. **Changeover to DeepSWE:**
   1. `$T archive`;
   2. a3's switch back to `none`;
   3. `$D isolation --wait` with the DeepSWE profile, `setup`, `prepull`;
   4. `check`: DeepSWE is offline and deterministic, so the committed check summary can be reused; the pre-registered
      choice is 0d's;
   5. the pilot with `--trial-cap-usd 30`, main, and the full fetch as above.
4. **Archive both, then teardown.**

**Dry run:** `tests/changeover_dryrun.py` gains:
- the escalation profiles;
- a fake router that emits router-log lines with a scripted switch, so switchcheck runs end to end;
- a capped trial;
- the TB → DeepSWE changeover.

### 6.4 Estimate (17; starts only after user approval)

| Work | Hours |
|---|---|
| Per-run cap: driver, classify, merge and fleet plumbing, pre-flight, tests (hproxy part: 4f, ≈ 1.5–2 h) | 2.0 |
| Arms per plan; `derive`; two escalation profiles; goldens | 2.0 |
| switchcheck.py (I1–I7), router-log/proxy join fields, live end-of-trial checks and the pilot halt, tests | 3.5 |
| Dry run: fake router logs, capped trial, TB → DeepSWE changeover | 1.5 |
| Runbook (experiments/escalation-harbor/ORCHESTRATION.md) | 0.5 |
| **Total (17)** | **≈ 9.5 h** |

Dependencies:
- **4f/73:** the router-log fields of §6.2 (in particular `reqId` echoed as a response header, `switched`,
  `switchCount`, `chainReset` and the rule hash), the replay tool's JSON output, and the arm hints.
- **4f:** the hproxy route cap.
- **a3:** the redeploy.

The router work (core/router plus replay) is not in this estimate.

### 6.5 Interfaces agreed with 4f (2026-11-07)

1. **Trial-cap refusal: HTTP 402**, with a JSON error body whose code is `trial-cap`.
   - It can't be 429: 429 is the runner ledger's `budget`, and Codex retries 429 and 5xx (request_max_retries 4).
   - It can't be 400: a 400 is readable as a real invalid request, such as a context overflow.
   - classify keys on `trial_capped` from the proxy summary, not on the status.
   - **Pre-pilot check:** the real Codex 0.166 ends the turn after one 402 attempt. 4f's dev-box Codex dry run, with
     a mock router that returns 402 at call k, counts the calls after the refusal; the expected count is 0. If Codex
     retries, the cap still holds, because every retry is refused too, but the run spends turns idling until Codex
     gives up. Either way it is recorded.
2. **Router logs:**
   - `reqId` is echoed as the `x-router-request-id` response header. The proxy records it per call, which is the I5
     join key.
   - The escalation block is `{ruleHash, signals{…counts at this request}, fired, switched, from, to, switchCount,
     chainReset}`. The rule hash is sha256 of the canonical escalation policy JSON, first 16 hex characters.
   - The block is absent unless escalation is configured, so existing configs log byte-identical lines.
3. **Timing contract** (0d §7.7):
   - The rule at request k uses the router state from requests < k: the prompt tokens of call k−1 from its usage, and
     compactions over calls < k.
   - Body signals are counted over the tool outputs in request k's body.
   - The block logs the signals on exactly this basis, so the replay is a pure function of logged values.
4. **Replay:** a small Python script beside switchcheck, 17's, reading the logged `signals` and the frozen rule.
   It outputs, per session, the firing request index (or null) and the rule hash.
   - It is a second implementation of 4f/73's TypeScript rule, so it gets a cross-check test: on a fixed set of
     synthetic signal sequences, it must fire exactly where the TS rule fires. 4f provides the TS output as a fixture.
   - I4 then catches any live divergence.
5. **Arm hints:**
   - The E arms send `x-router-hint: tier=fast;escalation=<ruleId>`; E_SA sends `tier=standard;…`.
   - A keeps `pin=Sol`, and pin returns before any escalation code runs, which is what keeps A byte-identical.
   - An unknown rule id is ignored and logged, so it fails safe to no escalation; I1/I2 flag it in an E arm, as a run
     with 0 switches and a `rule-unknown` log line.
6. **chainReset:**
   - Escalation fires only on full-history requests; a request with `previous_response_id` never fires.
   - At the switch and on every later request, the router strips the source model's encrypted reasoning items, by the
     ids recorded at the switch.
   - **I7, from the proxy:** on post-switch requests, no input item of type `reasoning` carries an id recorded before
     the switch. The proxy logs only item types and ids (opaque, never content) for E-arm trials, and only from the
     switch on.

Estimate change: the replay script and its cross-check add ≈ 1 h, so ≈ 10.5 h in total for 17.

## 7. Statistics: retrospective method, go/no-go gate, pre-registered live design, budget (0d)

### 7.1 Planning numbers from the existing Harbor data

These come from the final merged rows: TB as graded, DeepSWE with all reps. They are task-level means, so every task has equal weight. Rescue rates use fresh pinned-arm runs of the same task.

| Quantity (mean over tasks) | DeepSWE (112) | TB 2.1 (84) |
|---|---|---|
| Sol / Astra / Luna resolve | 74.3 / 73.6 / 56.6% | 85.3 / 88.5 / 72.2% |
| **Sol→Astra** oracle rescue mass, (1 − p_Sol)·p_Astra | 4.8 pp | 5.0 pp |
| … of which a fresh Sol run would also rescue, (1 − p_Sol)·p_Sol | 4.4 pp | 2.9 pp |
| … Astra-specific part, (1 − p_Sol)(p_Astra − p_Sol) | **0.4 pp** | **2.1 pp** |
| Tasks with p_Sol < 1 and p_Astra > 0 | 21 | 11 |
| **Luna→Sol** oracle rescue mass, (1 − p_Luna)·p_Sol | 24.7 pp | 18.1 pp |
| … Sol-specific part, (1 − p_Luna)(p_Sol − p_Luna) | 13.9 pp | 13.1 pp |
| Luna→Sol vs pinned Sol, perfect signal, optimistic | +7.0 pp | +5.0 pp |
| Rescue-weighted recall needed for Luna→Sol = Sol (optimistic) | ≈ 0.72 | ≈ 0.72 |
| … for Luna→Sol to be within 5 pp of Sol | ≈ 0.51 | ≈ 0.45 |
| Mean cost per run, Sol / Astra / Luna | $0.72 / $4.38 / $0.13 | $0.23 / $1.17 / $0.02 |
| Max cost of a fresh Astra run | $13.95 | $8.47 |

What this means before any signal is studied:
- **Sol→Astra has very little room.** A perfect signal plus the optimistic rescue model gives about +5 pp on both benchmarks. Most of that is the "second roll" effect: a fresh Sol run would rescue nearly as much. The Astra-specific part is 0.4 pp on DeepSWE and 2.1 pp on TB. On DeepSWE, the gate's condition (b) (§7.3) is therefore unlikely to pass even with a perfect signal.
- **Luna→Sol has room, but the result depends steeply on the signal.** Each 0.1 of rescue-weighted recall moves the result by about 1.8 pp on TB and 2.5 pp on DeepSWE. The policy breaks even with pinned Sol at about 0.72.

### 7.2 Retrospective study: method (offline, $0)

Notation:
- **s** is the source arm and **g** the target arm: Sol→Astra is s = A, g = C; Luna→Sol is s = F, g = A.
- Each scored source-arm run j on task t has:
  - y_j, its resolved outcome;
  - c_j, its ledger cost;
  - k_j, the first request at which the frozen rule fires (k_j = ∞ if the rule never fires);
  - π_j, the prefix cost: the router's per-request priced cost for requests before k_j, scaled to the run's ledger total.
- p_g(t) and c_g(t) are the target arm's mean resolve rate and mean cost on t, over all scored runs.
- p_s^{−j}(t) is the leave-one-out source rate on t (the mean of the other source runs).

**The counterfactual is not identified.** An escalated session is not a fresh run of the target model:
- it inherits the transcript and the container state, which may already be broken;
- it loses the encrypted reasoning, because that only ports within the same model;
- it starts on a cold cache;
- it has less time and fewer turns left.

Fresh-run rates also include a second-roll component that a session which carries on does not get. The study therefore reports a **band of scenarios, none of which is a bound**:

| Scenario | Outcome of a fired run | Purpose |
|---|---|---|
| **U** (optimistic) | y_j if y_j = 1; otherwise p_g(t) | The most favourable case considered: escalation never breaks a success, and it rescues at the rate of a fresh target run |
| **R** (replacement) | p_g(t) | As if the fired run had been on the target from the start, with the source prefix still paid |
| **U_self** | As U, but rescues at p_s^{−j}(t) | What the same rule would "gain" from a same-model second roll |
| **L** (null) | y_j | Escalation buys nothing; cost only |

Rules that apply to every scenario:
- **Non-fired runs:** ŷ_j = y_j and ĉ_j = c_j.
- **Late fires:** a run that fires with less than 15% of its agent timeout remaining (timed from the router-log timestamps) keeps y_j in U and R.
- **Target-specific gain:** Δ_spec = U − U_self.

Cost of a fired run:
- **High (used by the gate):** ĉ_j = π_j + u_j + c_g(t). Here u_j is the turn-k prompt at the target's uncached input price, the cold-cache switch.
- **Low (reported alongside):** ĉ_j = π_j + u_j + ρ_j·(c_j − π_j). Here ρ_j is the ratio of target to source price for the run's remaining token mix, from the pricing module.

Estimands, reported for each scenario and computed against pinned Sol:
- **ΔR_SA** = mean_t [mean_j ŷ_j − mean_j y_j] over the same Sol runs. Only fired runs contribute, so there is no run-to-run noise.
- **ΔR_FS** = mean_t [mean_j ŷ_j(Luna runs) − p_A(t)].
- **Cost ratio** = Σ_t mean_j ĉ_j / Σ_t mean c_A(t).
- **Descriptive measures:**
  - firing rate on source successes and on source failures;
  - rescue-weighted recall, Σ_{fired, y=0} p_g / Σ_{y=0} p_g;
  - the distribution of the firing turn.
- **CIs:** task bootstrap, seed 20261107, 10,000 resamples. These CIs cover task sampling only, not uncertainty in the scenario.

Rules against fooling ourselves:
1. **Prefix-only signals.** A rule at request k may use only what the router sees in requests 1..k: card stats and the conversation as it stood at k. It must not use later turns, the verifier, rewards or the exit reason. Features that the mechanism (§2) can't compute per request are out.
2. **Pre-listed rule family.** 4f lists the family before computing any association between signals and outcomes: at most 8 rules per escalation, for example 4 signals × 2 thresholds. The family and the scorer get hashes recorded here.
3. **Selection on tune, gate on held-out.** Use the v2.2 split (`experiments/assessor-v22/heldout/split.jsonl`, sha256 daac972f…; DeepSWE 67/45, TB 50/34). The objective is fixed now:
   - **Sol→Astra:** maximise U ΔR_SA, subject to a firing rate of at most 25% on Sol successes.
   - **Luna→Sol:** maximise U ΔR_FS, subject to a high-cost ratio of at most 0.60.
   - **Ties:** the rule that fires less.
   - Each escalation gets one rule, chosen on its own source arm's tune-split runs.
4. **Honest caveat:** the held-out split protects only against overfitting in rule selection. Every Harbor outcome has already been reported, so the designers are not blind to the per-task results. Freezing the rule family before computing the association is the only mitigation.
5. **All-task numbers** are reported as descriptive only.

### 7.3 Go/no-go gate (held-out split, selected rule, computed once and recorded with hashes)

Each escalation is gated separately, on each benchmark.

**Sol→Astra goes live only if all three hold:**
- (a) U ΔR_SA ≥ +3.0 pp;
- (b) Δ_spec ≥ +1.0 pp, i.e. the gain is not just a second roll;
- (c) the high-cost ratio point estimate is ≤ 2.0.

**Luna→Sol goes live only if all three hold:**
- (a) U ΔR_FS ≥ 0.0 pp;
- (b) the 95% lower bound of U ΔR_FS is > −5 pp;
- (c) the high-cost ratio point estimate is ≤ 0.60.

Why these thresholds. They come from simulated live power, using per-task rates as the truth, task-paired, normal approximation, N = 5 runs per arm:
- **Sol→Astra:**
  - +3.0 pp is about the live CI half-width (±2.6–2.8 pp).
  - Even if U were true, the live "resolves more than Sol" claim would have about 60% power. A true +2.4 pp gives about 46%; +1.4 pp gives about 18%.
- **Luna→Sol:**
  - U at recall 0.8 is +1.4 pp on TB and +2.1 pp on DeepSWE. With the CI half-width at ±4.4–5.0 pp, the 5-pp non-inferiority claim then has 84–96% power.
  - At U ≈ −0.4 pp, power falls to 35–47%.
  - U is optimistic, so condition (a) is set at 0.
- **More runs barely help.** Going from 5 to 8 runs per task shrinks the half-width by only 0.3–0.4 pp, because the number of tasks limits the precision.

Outcomes of the gate:
- If neither escalation passes on either benchmark, there is no live run. The retrospective write-up is the result.
- If an escalation passes on only one benchmark, it runs live only there.

### 7.4 Pre-registered live design (only for the escalations that pass §7.3)

**Arms:**
- **A**, pinned Sol: a concurrent control with the existing observe config, byte-identical and with no escalation config.
- **E_FS**, Luna→Sol.
- **E_SA**, Sol→Astra, only if it passes the gate.

Both E arms:
- use the frozen rule (its hash is recorded before the pilot);
- switch at most once per lineage, one way, with no switch back.

**Pinned Astra and pinned Luna are not rerun.** The historical C and F arms (same Codex, Harbor and task pins) serve as descriptive references only. A concurrent C would cost $491 on TB and $2,454 on DeepSWE at N = 5, and it answers no question that is asked here.

**Benchmarks and runs:**
- **Recommended:** TB 2.1 first, on the same 84 tasks (drop list and flaky_env as TB §7.5), then DeepSWE v1.1 on its 112 tasks. N = 5 runs per arm per task on both.
- Both are pre-registered and approved together.
- No outcome look between the two benchmarks; analysis starts when both are scored.
- The pass/block interleaving, long-tasks-first ordering and sharding are as before.
- If only one benchmark is approved, TB is the cheaper one. It is also the only one where Sol→Astra can plausibly pass condition (b) of the gate.

**Scoring and classification:**
- The run classifier and rerun rules are DeepSWE §7.4 and TB §7.4–7.5, unchanged.
- TB primary basis: TB §7.7, with flagged-and-resolved runs counted as unresolved and the scanner version frozen, plus the as-graded result side by side. A claim is stated without qualification only if both bases agree.
- A run stopped by its per-run cap (§7.5) counts as **unresolved and stays in the analysis**, because it is a cost of the policy. The count of such runs is reported.
  - This applies **even if the verifier later passes** (confirmed 2026-11-07, answering 17's edge case).
  - The rule is conservative against the arm under test, because the E arms are the ones that can reach the cap.
  - Sensitivity: keep the verifier's reward for capped runs. Report "capped but the verifier passed", per arm.
  - If a claim differs between the two, report both; the primary decides.
  - A runner-level cap stop is still `cap_stop` and excluded (§6).

**Primary estimands** (paired_mean_diff, task as the unit, equal weights, bootstrap CI and sign-flip p; cost = ratio of sums of per-task mean costs). These claim rules are fixed in advance:
- **P-FS (E_FS − A):**
  - "Not worse than Sol by more than 5 pp, and cheaper" if CI lower > −5 pp and cost-ratio CI upper < 1.
  - "≥ Sol and cheaper" if CI lower > 0 and cost-ratio upper < 1.
  - Otherwise, point estimates and CIs only.
- **P-SA (E_SA − A):**
  - "Resolves more than Sol" if CI lower > 0. The cost ratio and the cost per extra resolved task are reported with it.
  - Harm guard: if the CI lower bound is ≤ −5 pp, report "non-inferiority at 5 pp not shown".
- Each escalation, on each benchmark, is its own decision at 95%.
- No pooled "escalation works" claim. The two benchmarks are shown side by side and not combined, as in TB §7.11.
- The word "equivalent" is not used.

**Secondary analyses (descriptive):**
- **S1, mechanics:** firing rate, the distribution of the firing turn, the time left when the rule fires, and timeouts after a switch.
- **S2, the switch itself:** the uncached cost of the switch, cache retention after it, and the cost split into prefix and continuation.
- **S3, outcomes by fired vs not fired.** These groups are selected by the rule, so this is not causal.
- **S4, calibration:**
  - Replay the frozen rule on the live A runs.
  - Compute the U/R/L band from the historical C rates.
  - Report whether the measured E_SA falls inside the band. For E_FS, use the historical F arm.
- **S5, held-out subset:** P-FS and P-SA on the held-out tasks only. The rule was chosen on the tune tasks.
- **S6, per-task tables.**

**Integrity checks** (if any fails, the run is reported as a mechanism failure, not as an estimate of the policy):
- Replaying the frozen rule on the router logs reproduces 100% of the switches, and no switches occur where the rule did not fire.
- The A arm has 0 switches.
- No lineage has more than one switch.
- 0 router-caused failures and 0 failovers.
- Every E run reconciles with the router log, including the request where the switch happened.
- These are implemented as `switchcheck.py` I1–I7 (§6, 17). Two further checks are part of the pre-registered list:
  - **I5:** proxy ↔ router-log 1:1 by reqId, and the served models agree.
  - **I7:** the reasoning chain is reset at the switch, and no source-model encrypted reasoning reaches the target.
- I4's late-fire block (the rule fired, but no request followed) is listed, not failed. Such runs count as not escalated in S1.

**No-look rule:** no outcome looks until every run on both benchmarks is scored.
- The pilot checks mechanics only: whether the rule fires, whether the switch happens and what it costs.
- A forced-fire smoke config (threshold 0) on one task tests the switch path. It is not counted in the analysis.
- Pre-registered pilot stop: if the E arm's firing rate is outside 0.5×–2× of the retrospective rate, stop and report to 0c before the main run. This is a mechanics check; resolve is not computed in the pilot.

### 7.5 Budget and caps

Cost per E run:
- E_SA ≈ c_Sol + f·c_Astra.
- E_FS ≈ c_Luna + f·c_Sol.
- f is the firing rate, and the continuation is costed at a fresh target run's mean cost. That is conservative against the low-cost model but does not include the cold-cache switch, so add about 10%.

N = 5 runs per arm per task.

| | TB (420 runs per arm) | DeepSWE (560 runs per arm) |
|---|---|---|
| A, pinned Sol | $97 | $403 |
| E_FS at f = 0.3 / 0.5 / 1.0 | $39 / $59 / $107 | $160 / $235 (at 0.4) / $477 |
| E_SA at f = 0.25 / 0.5 / 1.0 | $218 / $344 / $588 | $1,016 / $1,630 / $2,857 (only if the gate passes; not expected) |
| Runner, 4 × r7i.2xlarge at about $2.69/h | A+FS about 7 h, with SA about 12 h: $19–32, plus about $10 standby | A+FS about 12 h: about $31, plus about $15 standby |
| Pilot, plus forced-fire smoke | ≤ $25 | ≤ $40 |
| **Expected total** | A+FS about $200; with SA about $430 | A+FS about $710 |
| **Worst case (f = 1)** | A+FS about $250; with SA about $860 | A+FS about $960 |
| **Hard cap** | **$400** A+FS / **$1,000** with SA | **$1,200** A+FS (**$4,000** if SA passes) |

Basis for the runner hours:
- TB: 1,008 runs took about 7.8 h on 4 runners.
- DeepSWE: 2,240 runs took about 21 h.
- Escalated sessions run longer, so add 10–20%.

Caps:
- **Per runner:** soft cap 80% and hard cap 90% of the benchmark cap ÷ 4, in the fail-closed CapLedger, as in TB §7.9.
- **Per run:** TB $15 and DeepSWE $30, about 1.8–2× the most expensive fresh Astra run. 17 confirms that the harness can enforce this. If it can't, only the per-runner caps apply, and that is recorded.
- **Recommended combined approval:** TB + DeepSWE with Luna→Sol only, about $910 expected and a **$1,600 cap**. If Sol→Astra passes on TB, add $600, for **$2,200**.

**Timeline:**
- Retrospective study and gate: about 1 day (4f with 0d). The mechanism and code (73/17, nothing deployed) run in parallel, about 1–2 days.
- Then user approval.
- Then: pilot about 2 h, TB about 7–12 h, DeepSWE about 12 h, report about 0.5 day.

### 7.6 Recommendation (0d)

1. Run the retrospective gate first; it costs $0. Expect Sol→Astra to fail. Its Astra-specific rescue mass is only 0.4 pp on DeepSWE and 2.1 pp on TB, even with a perfect signal and optimistic rescue. If it fails, don't pay for that arm.
2. If Luna→Sol passes, run A + E_FS at N = 5 on TB and then DeepSWE: about $910 expected, $1,600 cap. The question it answers is whether Luna→Sol is within 5 pp of Sol and cheaper. That is the same "cheaper near-Sol" reading as v2.2, now with a mechanism that can actually act on what happens in the session.
3. Don't rerun pinned Astra or pinned Luna.

### 7.7 Retrospective freeze receipts (0d, 2026-11-07, recorded before any outcome was joined)

4f's `experiments/escalation/` was checked against §7.2–7.3. The sha256 values match the files on disk.

- FROZEN.json `3a90b0e226e5eb94a855cca559ba42b925e57f45a7fffc6834502c3137f742ad`
- rules.json `beb1960e67cd8324bdbb661ea67d52d30f40b2a9d2f2f7daa52cb0b1e4facde5`. Contents:
  - the rule families, SA1–8 and FS1–8;
  - the selection objectives;
  - the late-fire rule;
  - the scenarios: M0 = L, M1 = R, M2 = U, M2_self = U_self;
  - the cost models (high gates);
  - the bootstrap settings.
- signals.py `b1a64cea6b0374e925cba6d905968081d7a71da078b523ed2f932297569ad5a9`, simulate.py `1df2a9039913e65e44397ecbb5d406b5871550555d2eb7446aa6719422965ac8`
- Text-free extracts: deepswe `1896d131d4a3e1cb5f9d922b4c0a58aadfb34166c00e00c6190d6ae273e23280`, tbench `57262a4c8ff013ba60c422351302e74545dadcf99b1aa8d30e9ae89506a5f6a6`
- Thresholds resolved from outcome-free tune-split data:
  - DeepSWE: SA k quantiles q.75 = 51 and q.90 = 63; FS k q.50 = 72; R8′ = $0.20135.
  - TB: SA q.75 = 27 and q.90 = 49; FS q.50 = 13; R8′ = $0.021877.
- Code review against §7.2–7.3:
  - The gate conditions and the selection constraints are as written.
  - Ties go to the lower fire rate.
  - "No eligible rule" means the gate fails.
  - Router-today signals are strictly "before request k":
    - prompt_tokens and compactions use requests ≤ k − 1;
    - this is one request more conservative than what the router could see on request k itself.
  - **The live implementation (§2–6) must use the same timing.** Otherwise I4's replay compares a different rule.
- Gate basis:
  - DeepSWE as graded.
  - TB primary (§7.7 of TB), with as-graded as the sensitivity. The §7.1 planning numbers are as graded.
- The 2-fold cross-fit was dropped. The held-out gate is binding, so this is acceptable.

### 7.8 Gate result (0d check, 2026-11-07): no-go on all four, so no live run

- **The run:** 4f ran `simulate.py run` once, on FROZEN `3a90b0e2…`. I re-checked all the hashes after the run, and every one matches.
- **Selection:** I checked it against each rule's tune values (`results/sim-*.json`). Every selection is correct:
  - DeepSWE SA7 and FS6;
  - TB SA6 and FS5.
  - TB's SA5 and SA6 tie on tune M2 (+0.2 pp). The tie goes to SA6, which has the lower fire rate (0.10 vs 0.25).
- **Pipeline check:** the perfect-signal optimistic check reproduces §7.1 on the graded basis (SA +4.8 / +5.0, FS +7.0 / +5.0).

| Escalation × benchmark (held-out, primary) | Rule | M2 vs Sol | Δ_spec | High-cost ratio | Gate |
|---|---|---|---|---|---|
| Sol→Astra, DeepSWE (45) | SA7 prompt ≥ 100k | +0.7 [0.0, 2.1] | −0.4 | 2.58 | (a)(b)(c) fail |
| Sol→Astra, TB (34) | SA6 k ≥ 49 | 0.0 | 0.0 | 2.19 | (a)(b)(c) fail |
| Luna→Sol, DeepSWE (45) | FS6 repeat_cmd ≥ 5 | −12.3 [−21.5, −3.2] | — | 0.51 | (a)(b) fail, (c) pass |
| Luna→Sol, TB (34) | FS5 prompt ≥ 100k | −19.6 [−33.3, −5.9] | — | 0.34 | (a)(b) fail, (c) pass |

Robustness of the conclusion:
- **No rule in either family passes all three conditions on held-out**, whichever rule had been selected.
- Sol→Astra: the best held-out M2 is SA4 on DeepSWE, at +2.0 pp with a cost ratio of 3.05.
- Luna→Sol: the only rule at or above Sol is FS5 on DeepSWE, at +2.7 pp, but its cost ratio is 1.23. It fires on 81% of runs, so it costs more than pinned Sol.
- M2 is the optimistic scenario, so the more realistic scenarios fail too. TB as graded gives the same selection and the same failures.

**Reading:**
- Among the 16 pre-listed rules, none fires selectively on runs that will fail.
  - Fire rates on failed and on resolved runs are within about 0.1 of each other.
  - The descriptive AUCs (signals × k × arms × benchmarks, not corrected for multiple comparisons) are 0.41–0.57.
- This is "not found among the router-observable, prefix-only rules tested", not "no signal exists".
- Untested:
  - an assessor re-consult mid-session;
  - richer transcript judgements;
  - a restart rather than a continuation.

**Per §7.3:** no live run. The retrospective write-up (4f, §3) is the result, so the §7.5 budget is not requested.
- **Disclosure (4f):** after 0d's check, `simulate.py run` was started a second time by accident. The inputs were the same, with the FROZEN hashes matching. The run is deterministic with the same seed, and every gate number came out identical. Nothing was changed or selected on the second run.
