# §6 Orchestration (17), draft v2 for 0c, to be merged into design.md

Status: design and estimate only. Nothing is implemented. Code will go only in the worktree `llmar-tb21`
(branch `tb21-harbor`). Inputs: the 89 task.toml files at the pinned commit (labels and numbers only), plus
design.md §4 (4f) and §7 (0d). Prototypes are in `/tmp/17-tb/`; nothing from them is committed.

**v2 changes**, to follow 0d's §7 and 4f's §4:
- every pass, main included, uses a stratified order by (tier stratum × difficulty);
- the shards are also balanced on expected cost (§7.6);
- rep4 and rep5 are in the plan, with the checkpoint at 6 main blocks (§7.10);
- oracle and null checks get 2 attempts each, a `flaky_env` mark, and a post-run re-check (§7.5);
- caps are $800 soft / $900 hard (§7.9);
- `taskpin` and `lookupscan` call sites, and the `llmar-online` network ensure (§4.3–4.5);
- the commit hash is stored as base64url, because the full hash has a bare 12-digit run (N5).

## 6.0 Facts (89 task.toml files at 12b75656)

| | |
|---|---|
| Difficulty | hard 30, medium 55, easy 4 |
| Category | 16 categories. software-engineering 26; system-administration 9; scientific-computing, security, data-science 8 each; debugging, file-operations 5 each; model-training, mathematics, data-processing 4 each; machine-learning 3; five singletons |
| Agent timeout (s) | 600:1, 750:1, 900:48, 1200:5, 1800:17, 2400:2, 3600:13, 7200:1 (sam-cell-seg), 12000:1 (build-pov-ray) |
| Verifier timeout | the same as the agent timeout for 85 tasks. The other four: caffe-cifar-10 3600 → 1200, crack-7z-hash 1800 → 900, overfull-hbox 750 → 360, query-optimize 900 → 1800 |
| Resources | cpus 1:83, 2:3, 4:3; memory 2 GB:68, 4 GB:13, 8 GB:8; storage 10 GB; no GPUs; build timeout 600 |
| Images | every task has a prebuilt `docker_image`; no compose |
| Network | `allow_internet = true` everywhere. All 89 test.sh install from the internet at verify time and write `reward.txt` 1/0 from pytest's exit code. A failed install gives **reward 0, not an error**. All write `--ctrf /logs/verifier/ctrf.json` |

Heavy tasks:

| Task | Resources | Agent timeout (s) |
|---|---|---|
| caffe-cifar-10 | 4 CPU, 8 GB | 3600 |
| mcmc-sampling-stan | 4 CPU, 8 GB | 1800 |
| rstan-to-pystan | 4 CPU, 8 GB | 1800 |
| compile-compcert | 2 CPU, 4 GB | 2400 |
| install-windows-3.11 | 2 CPU, 4 GB | 3600 |
| overfull-hbox | 2 CPU, 4 GB | 750 |

Five 1-CPU tasks also take 8 GB.

## 6.1 Shard plan (`shardplan.py --dataset tb21 build-tb`)

**Inputs:**
- the task checkout at the pin (metadata via `taskpin.task_facts`; the content digests and the image digests from
  `taskpin`, §4.3);
- 73's frozen `strata.json` (tier per task, §7.8);
- 0d's public per-task cost profile (§7.1/7.6; a relative weight, gitignored, used only for balance).

**Committed plan** `experiments/tbench-harbor/plan.json`:
- schema `tbench-harbor-plan/v1`, seed 20261106;
- `dataset`: name tb21, repo, `commit_b64`, n_tasks;
- per task:
  - `group`, category, `difficulty2` (easy+medium / hard), tier;
  - agent and verifier timeouts, cpus, memory_mb, shard;
  - `digest_b64`, `image`, `image_digest_b64` and `image_bytes`, from `taskpin.plan_pins`;
- the passes.

Digests are stored as base64url. The validator refuses any `\d{12}`. The plan holds no task text and no public
per-task rates or costs.

**Groups:** a category with ≥ 4 tasks is its own group. The others (machine-learning plus the five singletons, 8
tasks) form `other`. That gives 11 groups.

**Assignment** (deterministic, seeded, fixed before any outcome):
1. Category deal, as in DeepSWE's `assign_shards` with group in place of language. Within a group, sort by
   (difficulty, public cost weight descending, agent timeout descending, seeded tie). Deal consecutive runs of 4
   with a seeded permutation. Each group's leftovers go to the currently smallest shards. Result: sizes
   22/22/22/23 and every group within ±1 per shard.
2. Swap search: seeded hill-climbing over swaps of two tasks *of the same group* in different shards, which
   preserves step 1's guarantees. It minimises a lexicographic objective:
   1. the two ≥ 7200 s tasks in different shards;
   2. the top-5 cost tasks ≤ 2 per shard (§7.6: the tail must not land on one runner);
   3. ≤ 1 four-CPU task, ≤ 2 tasks of ≥ 2 CPU, and ≤ 2 tasks of 8 GB per shard;
   4. hard, ≥ 3600 s and tier-stratum counts within ±1;
   5. then the range of Σ expected cost, then the range of Σ agent timeouts.

Prototype with every term (seed 20261106; inputs: 0d's cost weights, sha256 `36a154ad…`, and 73's strata.json,
sha256 `9db628eb…`; five improvement passes). Every constraint holds:

| Shard | n | hard | frontier | ≥ 3600 s | ≥ 7200 s | top-5 cost | 4-CPU | ≥ 2 CPU | 8 GB | Σ cost weight | Σ agent timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 22 | 7 | 8 | 3 | build-pov-ray | 1 | 1 | 1 | 2 | 21.95 | 11.6 h |
| 1 | 22 | 8 | 7 | 4 | – | 1 | 1 | 2 | 2 | 21.97 | 10.2 h |
| 2 | 23 | 8 | 8 | 4 | – | 1 | 0 | 2 | 2 | 22.01 | 10.4 h |
| 3 | 22 | 7 | 7 | 4 | sam-cell-seg | 2 | 1 | 1 | 2 | 23.08 | 10.1 h |

- The cost range is 5% of the shard mean (22.25).
- Every group is within ±1 across the shards.
- The cost weights are third-party numbers: kept gitignored at `experiments/tbench-harbor/results/inputs/`. The plan
  records only their sha256.

**Passes**, in run order on every runner. Every pass covers all 4 arms:

| Pass | Phase | Rep | Note |
|---|---|---|---|
| `pilot` | pilot (outside the analysis) | 1 | 2 tasks per shard (0d; 32 runs); its tasks run again fresh in main |
| `main` | main | 1 | |
| `rep2` | repeat | 2 | |
| `rep3` | repeat | 3 | |
| `rep4` | repeat | 4 | §7.10 headroom; pre-registered now, block-list sha256 recorded; run only after the checkpoint decision, possibly `cut --per-shard N` (N ≥ 6) |
| `rep5` | repeat | 5 | same as rep4 |

- **Block order (§7.6):** every pass uses `stratified_order`, seeded with (plan seed + shard, pass name), over
  strata (tier, difficulty2). So every prefix is a stratified subset, and any cut is pre-registered.
- **Arm order:** seeded per (pass, task), as on DeepSWE.
- **Anti-tail (needs 0d's OK, a small deviation from a pure stratified order):** in every pass, the blocks of the
  two ≥ 7200 s tasks move to block 1 of their shard (a stable partition). Without it, a 12000 s trial at the end of
  the last pass sets the runner's end time.
- **Pilot** (0d: 2 per shard, 8 tasks, 32 runs, as an 8-slot load test; no task ≥ 7200 s; at least one
  multi-CPU task fleet-wide):
  - pick 1 (seeded): standard tier, 1 CPU, 2 GB, ≤ 900 s, medium, distinct groups across shards (largest first);
  - pick 2 (seeded): frontier tier, ≤ 1800 s, a different group from pick 1, so that B's frontier routing is
    priced in the pilot;
  - the shortest multi-CPU task (overfull-hbox, 2 CPU, 750 s) replaces pick 2 on its shard.

  Prototype:

  | Shard | Pick 1 | Pick 2 |
  |---|---|---|
  | 0 | kv-store-grpc | rstan-to-pystan (4 CPU, frontier: exercises the pair admission) |
  | 1 | query-optimize | model-extraction-relu-logits (frontier) |
  | 2 | sqlite-with-gcov | overfull-hbox (2 CPU: whole-block admission) |
  | 3 | modernize-scientific-stack | feal-linear-cryptanalysis (frontier) |

  - Σ cost weight is 5.13, i.e. about $42 at s = 1, within 0d's ≤ $75.
  - Pilot caps per runner (0d): soft $35 / hard $50, about $40 effective with the $10 reserve. That is ≤ $200
    fail-closed fleet-wide, against about $42 expected and the §7.9 plan line of ≤ $75. The worst expected shard
    is $18.5.
  - Pre-flight (0d): `fleet.py start` refuses unless reserve < hard cap − the largest expected single run of the
    passes being started. The largest run comes from the gitignored plan detail: weight × arm planning cost, C at
    s = 1, about $6.9 for rstan-to-pystan. So a cap stop can only come from a real overrun.

## 6.2 Dataset parameter and the module split (agreed with 4f, design §4.0)

`experiments/deepswe-harbor/profiles.py` (17) holds a frozen `Dataset` dataclass:

```
DEEPSWE: plan=deepswe-harbor/plan.json, repo=datacurve-ai/deep-swe, checkout='deep-swe', results='results',
         dev_results=deepswe-harbor/results, roots=today's ROOTS, max_concurrency=6, wall_timeout_h=5.0,
         task_check='task.toml sha256', checks=(reps 1, drop if any oracle fails), online_network=False
TB21:    plan=tbench-harbor/plan.json, repo=harbor-framework/terminal-bench-2-1, checkout='terminal-bench-2-1',
         results='tb21/results', dev_results=tbench-harbor/results, roots=ROOTS+('experiments/tbench-harbor',),
         max_concurrency=8, wall_timeout_h=None (per task), task_check=taskpin, image_pin=taskpin,
         checks=(2 attempts, §7.5 rule), online_network=True, verifier_net_rule=True, resource_budget=(8 cpu, 48 GB),
         isolation_args='--profile tb21 … --out $WORK_DIR/tb21/results/isolation'
```

`driver.py`, `fleet.py` and `shardplan.py` take `--dataset {deepswe,tb21}`, defaulting to deepswe. Every DEEPSWE
value is today's constant. The driver refuses a plan whose `dataset.name` differs; DeepSWE's frozen plan has no name
and reads as deepswe.

| Module (17) | TB changes (DeepSWE path unchanged) |
|---|---|
| driver.py | Paths(work, profile). `fetch-tasks` → `taskpin` (fetch sequence, three integrity checks). `prepull` → `repo@digest` pulled and tagged `repo:tag`. At `run`/`check` start: image digests via `taskpin`, and, when the env file has `CONTAINER_EGRESS=internet`, `taskpin.check_online_network(run)`. Infra creates `llmar-online` (`br-llmon`, 10.201.0.0/24, icc=false, masquerade, no IPv6); the driver only checks it and refuses on a mismatch. The TB profile refuses to start without `CONTAINER_EGRESS=internet`. `ONLINE_NETWORK` and `ONLINE_DNS` from the env file go into the `harbor run` subprocess env (added to the allowlist; absent for DeepSWE, so its env is unchanged) and into run-config. Per-trial start times are logged (0d: start spread within each block, S6). Resource-weighted admission and a per-task watchdog (§6.3). `check` uses the §7.5 rule plus `flaky_env` and a `--post` re-check. `export` runs `lookupscan` over each trial dir on the runner, before leakscan, so blocked and over-1-MiB rollouts are still scanned, and ships text-free `lookup/<trial>.json` (call site to confirm with 4f). `dataset` is added to status and manifests only when it isn't deepswe. |
| fleet.py | ROOTS, the driver's `--dataset`, the dev-box dirs, the concurrency limit, the isolation args and the setup clone all come from the profile. merge passes `flaky_env` and the `lookup` records into harvest-meta. New `archive` (§6.4) and `check --post`. |
| shardplan.py | `build-tb` (§6.1); TB strata, pilot and cut. DeepSWE's `build` and its RNG streams are untouched. |
| classify.py | TB rules (a)–(c) of §4.7, behind an evidence keyword argument that defaults to None (§6.3) |

- **4f owns:** harbor_job, codex_config, llmar_env, hcommon, harvest, report_zh, dryrun, cli, hproxy,
  mock_upstream, isolation/isoprobe (with 18), and the new `taskpin.py` and `lookupscan.py`, which my code calls.
- **Byte-identity:** before refactoring, golden tests record from main@7ced27d:
  - every fleet command line (unit and driver commands, start args, bootstrap, isolation);
  - the driver's Paths;
  - job.json and argv for fake-harbor runs;
  - status keys and an export manifest;
  - a byte-for-byte rebuild of DeepSWE's plan.json.

  After the refactor they must be identical. The 215 existing tests stay green with unchanged expectations.

## 6.3 Concurrency, resources, classification

**Is 8 slots OK with 1-CPU tasks? Yes.** Codex runs inside the task container, so agent and task share the task's
hard CFS `cpus` and `mem_limit` (Harbor 0.25.0 sets limits, not reservations). Eight 1-CPU trials can't exceed the 8
vCPUs. For comparison, DeepSWE ran at 6 slots with larger task limits. Across 1,110 scored attempts its host CPU
busy share was mean 0.34, p99 0.75. CPU PSI-full was 0, and there was no steal, no swap and no 429s at 24 sessions.
TB means 32 sessions; 429s are watched in the pilot and in status.

**Admission budget per runner, fixed for the whole run:**
- Σ declared cpus of running trials ≤ **8** (the vCPUs, so each trial can always get its declared CPUs);
- Σ declared memory ≤ **48 GB**;
- trial count ≤ **8**.

The order stays as it is: reruns and re-verifies of admitted blocks, then unstarted trials of admitted blocks, then
the next block. It gains head-of-line blocking: if the next candidate doesn't fit, nothing else starts, so small
blocks can't starve a heavy one.

Consequences:

| Block | How it runs |
|---|---|
| 1-CPU task | two blocks side by side |
| 2-CPU task | alone on the host, all four arms together |
| 8 GB task | at most one at a time |
| 4-CPU task (3 tasks) | two arms at a time, in the seeded arm order |

The 4-CPU case is the only break from "a block's arms run together". The alternative, 2× CPU oversubscription,
squeezes training within fixed timeouts, which is a soft override of the task's resources. **0d: pairs accepted.** For DeepSWE the plan has no cpus or memory, so each trial weighs 1 against `--concurrency`,
as today.

**`llmar-online` invariant (4f):** the driver never creates or removes it.
- `prune_networks` keeps its `label=com.docker.compose.project` filter. The infra network has no compose label.
- `cleanup` stays limited to the trial's own compose project.
- At `run` and `check` start, `check_online_network` runs **after** `prune_networks`, so a future filter change
  fails loudly.
- A test asserts that no driver code path issues `network rm` on anything without a compose label.

**Watchdog:** per task, agent + verifier + build timeouts + 30 min. build-pov-ray gets 7.3 h; today's fixed 5 h would
kill it. DeepSWE keeps 5 h.

**Tail:**
- the two ≥ 7200 s tasks are on different runners and run first in every pass;
- shard 3, which holds build-pov-ray, has fewer other ≥ 3600 s tasks;
- the timeout is a cap: the public Codex average trial is 7–8 min.

Worst case (12000 s plus the verifier, starting at block 1 of the last pass): about 1.5–2 h past the other trials.

**Simulation** (`/tmp/17-tb/sim.py`): 200 runs per setting. Trial wall = lognormal(σ 0.7) × f × agent timeout,
capped at the timeout, plus 60 s plus the verifier time. Passes main to rep3, with the budget above.

| f (≈ mean trial wall) | Slots | Fleet makespan, mean / p90 |
|---|---|---|
| 0.15 (≈ 525 s, close to the public 7–8 min) | 8 | 6.6 / 7.1 h |
| 0.15 | 6 | 7.7 / 8.2 h |
| 0.25 (≈ 740 s) | 8 | 9.3 / 9.8 h |
| 0.25 | 6 | 10.8 / 11.4 h |

Each of rep4 and rep5 adds about a third of the main-to-rep3 time.

**Classification** (classify.py, TB profile only; 0d §7.4, 4f §4.7):
- **(a)** TB has no patch, so `verifier_infra` → **rerun** (≤ 2), never a regrade.
- **(b)** Reward 0 **and** (no `verifier/ctrf.json` **or** 0 tests in it) **and** a network-error pattern in
  `verifier/test-stdout.txt` → `verifier_infra`.
  - The patterns live in classify (17). 4f supplies the candidates: curl exit 6/7/28, apt "Temporary failure
    resolving", "Could not connect" and "Unable to fetch", the uv installer's download failure, pip/uv
    ConnectionError, "error sending request" and "dns error".
  - Without the pattern, reward 0 stays an agent outcome. An agent that breaks the environment must not earn a
    rerun.
- **(c)** An agent exception before the verifier ran → rerun. Harbor verifies after agent timeouts and non-zero
  exits, so those stay scored.
- §7.4's harness-side network evidence (egress filter denial, environment build or package fetch, proxy, host OOM)
  → harness, as today.
- `check` uses the same (b) function for oracle and nop attempts (0d: accepted). A (b) attempt is retried ≤ 2 and
  not counted; still (b) after that, it counts as a **failed** attempt. The retries are capped per (task, kind,
  attempt slot), with no loop.
- **(b) also requires `net_config_touched == false`** (0d: accepted; lookupscan N1–N6). The patterns and the rules
  are hashed and tested before the pilot, and reward-blind.

**Checks (§7.5, TB profile; DeepSWE's `run_checks` and `summarize_checks` semantics are unchanged):**
- **Attempt slots:** 2 counted slots per (task, kind). The check-end events of a (task, kind) are walked in log
  order, which is deterministic and resumable.
  - A pass or fail verdict fills the current slot.
  - An `infra` verdict (Harbor environment or verifier exception, no valid reward, or classify rule (b)) is a retry
    of the current slot.
  - The 3rd consecutive infra in one slot (1 try + 2 retries) fills the slot as a **counted failure**, with reason
    `infra-exhausted`.
  - The bound is ≤ 6 attempts per (task, kind), with no loop. (0d: today's code allows infra ≤ max_infra per
    (task, kind), i.e. 3 tries in total, and then leaves the task `unresolved`.)
- **Verdicts:**
  - oracle: drop if both slots failed; 1 of 2 → kept, `flaky_env`;
  - nop (0d): an `infra-exhausted` slot is **unverified**, neither a pass nor a clean fail.
    - Any pass → drop.
    - Both slots unverified → drop: no evidence the tests reject an unmodified task.
    - One clean fail + one unverified → kept, `flaky_env`.
    - Both clean-fail → kept.
  - A task flagged by either check is `flaky_env` once in the summary, with every reason listed.
- **Completeness:** when a check run completes, every TB task has 2 counted slots per kind, so `summarize_checks`
  never reports it `unresolved`. Only an interrupted run, which resumes from the log, leaves tasks unresolved, and
  the run gate refuses those.
- **Tests:**
  - 3 consecutive (b) attempts → 1 counted failure;
  - (b)×3 in both oracle slots → dropped;
  - (b)×3 then a pass → `flaky_env`;
  - (b)×2 then a pass → a clean pass with 2 infra noted;
  - nop: unverified + clean fail → kept, `flaky_env`; nop unverified ×2 → dropped; oracle and nop both flaky →
    one `flaky_env` with 2 reasons;
  - concurrent slots interleaved in the log → the same counts;
  - resume mid-slot → no extra attempts;
  - the DeepSWE profile reproduces today's summaries byte for byte.
- The check watchdog is per task too: the task's own agent + verifier + build timeouts + 30 min, in place of the
  fixed 2 h `run_checks` timeout. build-pov-ray's oracle runs under its 12000 s agent timeout.
- `check --post` after the last pass: the oracle once on every kept task, into `checks-post/`. It is a sensitivity
  only and never changes the drop list.

## 6.4 Changeover runbook (0c)

```
F="python3 experiments/deepswe-harbor/fleet.py --region <region> --stack <prefix>-runner"   # DeepSWE (default profile)
T="$F --dataset tb21"
```

0. **DeepSWE final.**
   ```
   $F fetch --mode full
   merge --harvest
   ```
   0d and 4f confirm the data is complete. Then merge `tb21-harbor` into main and commit (0c). Pack only from a
   clean worktree of that HEAD.
1. **Stop and verify.**
   ```
   $F stop
   $F units
   $F status
   ```
   - `stop` drains, a no-op if the run has ended.
   - `units`: all four llmar-* units inactive.
   - `status`: every runner shows run-end, 0 running, no attempt without an end. Record the counts.
2. **Archive** (new; no deletes, no moves).
   ```
   $F archive --dataset deepswe
   $F fetch
   ```
   - `archive` writes `$WORK_DIR/archive/deepswe-<ts>.manifest.json` (the sha256 of every results file, plus
     counts), then runs `chmod -R a-w $WORK_DIR/results`, and prints the manifest's sha256.
   - The light fetch brings the manifest back; check it against the dev-box mirror.
   - DeepSWE's images stay, unless `docker_free_gb` < 100 after the prepull (0c's go).
   - TB writes only under `$WORK_DIR/tb21/`, with a fresh ledger starting at $0.
3. **Ship.**
   ```
   $F pack && $F ship
   ```
4. **Network.** 0c applies a3's firewall delta; no redeploy. Then:
   ```
   $T isolation --wait
   ```
   This is the gate, PASS on all 4 runners, for gates O1–O8, L and P (§4.6). The suite runs before any task
   container gets the internet: the oracle runs third-party solution and test code, so isolation goes before
   `check`, as in 4f's order.
5. **Setup and prepull** (in parallel with step 4's wait; prepull runs no task container).
   ```
   $T setup
   $T prepull
   ```
   - `setup` stages Codex 0.166.0, clones at the pin and runs the three `taskpin` checks.
   - `prepull` pulls the shard's images by digest and tags them, plus the probe. Check prepull.json for
     `docker_free_gb`.
6. **Oracle and null checks.**
   ```
   $T check --kind both --concurrency 8
   $T status
   $T fetch
   … merge
   ```
   `checks.json` lists the drops and `flaky_env`; 0d signs it off. Estimate: about 1–2 h (some solutions build or
   train). No Bedrock cost.
7. **Pilot.**
   ```
   $T start --pass pilot --gateway-url <GatewayUrl> --concurrency 8 --soft-cap 35 --hard-cap 50 --token-max-age-s 600
   $T fetch
   python3 experiments/deepswe-harbor/fleet.py --dataset tb21 merge --tasks-dir <checkout>/tasks --tiers <strata.json> --harvest
   ```
   The gate:
   - joins: router session = trial_id;
   - κ per arm;
   - host health (PSI, OOM, steal) and 429s;
   - the leakscan fixture and blocked lists;
   - classify (b) hits;
   - lookupscan hits, read without rewards; then freeze the scanner and record its hash.
8. **Main up to the checkpoint** (§7.10).
   ```
   $T start --pass main --pass rep2 --pass rep3 --gateway-url <GatewayUrl> --concurrency 8 --soft-cap 800 --hard-cap 900 --max-blocks 6
   $T fetch
   … merge
   $T project
   ```
   - `project` gives the headroom H and the rep4/rep5 fit, using cost only.
   - Cut rep4/rep5 if needed: `shardplan.py --dataset tb21 cut --name rep4 --per-shard N`.
   - Then pack, ship and restart without `--max-blocks`. Add `--pass rep4 --pass rep5` if they fit.
   - Re-check before rep5 starts (§7.10).
9. **Monitor and finish.**
   - During the run: `$T status`, `$T fetch` and merge, periodically.
   - At the end: `$T check --post`, then `$T fetch --mode full`, then `merge --harvest`.
   - Teardown: 0c and a3.

Timing from about 12:00 UTC:

| Steps | Time |
|---|---|
| 1–3 | ≈ 0.5 h |
| 4–5 | ≈ 0.75 h |
| 6 | ≈ 1–2 h |
| 7 | ≈ 0.75 h |
| main to rep3 | ≈ 6.5–10 h |
| each of rep4 and rep5 | +2–3 h |

## 6.5 Estimates

**Implementation (17): about 6–7 h**, plus 0d's review:

| Work | Time |
|---|---|
| profiles, plumbing and golden tests | 1.5 h |
| `build-tb`, strata, cost balance, plan.json and tests | 1.5 h |
| resource-weighted admission and watchdog | 1.5 h |
| taskpin, network-ensure and lookupscan call sites | 0.75 h |
| classify (a)–(c) | 0.75 h |
| checks per §7.5 and `--post` | 0.5 h |
| `archive` and runbook | 0.5 h |

If approved by about 05:30 UTC, it's ready by about 12:00. Parts that gate the first runner steps come first: the
profile and plumbing, `check` and taskpin wiring; `build-tb` needs 73's `strata.json`. Parts needed only from the
pilot on (lookupscan export, `check --post`, `archive` polish) come last.

**Spend:**
- Caps per §7.9: soft $800 / hard $900 per runner.
- 0d's plan: about $1.5–2.8k for main to rep3.
- My rough Bedrock figure, $1.1–1.6k, sits at the low end of that.

## 6.6 Decisions and open points

**Decided** (0d, 2026-11-06):
- the 4-CPU pairs;
- long tasks first in every pass;
- (b) in the checks (retried ≤ 2, then counted as a failure);
- (b) requires `net_config_touched == false`;
- a 2-per-shard pilot, with a frontier-tier pick 2 and caps $35 / $50;
- the shard prototype;
- the cost weights as an input.

**Agreed with 4f** (frozen):
- `taskpin` and `lookupscan` signatures;
- `check_online_network` (infra creates the network; the driver only checks it);
- `ONLINE_NETWORK` and `ONLINE_DNS` passed into the `harbor run` env;
- the `pin-images` fallback, which records the pull time.

**Open:**
1. 73 confirmed `strata.json` is frozen (sha256 `9db628eb…`, path fixed). The only possible change before the
   pilot: a carddiff re-freeze (kept as strata.v1.json). 73 would send the new sha256, and I would rebuild
   plan.json before `check`.
2. 0c: approval of §6; Docker Hub queries from the dev box (otherwise `pin-images`); the new `archive` command.
