# Claude Code × Harbor: orchestration design (17)

Status: design only. No code before 0c's ack, no AWS calls, no commits. The code will go on branch `cc-harbor`
(worktree `llmar-cc`).

Owners: 4f (harness, proxy, agent), a3 (runner), 0d (statistics), 73 (tier pass). This file covers the orchestration:
- profiles;
- shard plans and admission;
- the staged run and the pilot, including OOM;
- caps;
- classify;
- the timeline;
- the dry run.

Its inputs are the PRD, 0c's staged-run change (stage 1 = rep 1 of all arms on both datasets, then a stop for the
user's decision), a3's OOM flag, and the Codex runs' merged data (DeepSWE: main tree
`experiments/deepswe-harbor/results/merged`; TB: `experiments/tbench-harbor/results/merged`, both gitignored).

## 0. What the Codex runs tell us (planning facts)

| | DeepSWE v1.1 (Codex, 2,240 runs) | TB 2.1 (Codex, 1,008 runs) |
|---|---|---|
| Task limits | every task: 2 CPU, 8 GB, agent 10,800 s, verifier 1,800 s, build 1,800 s | 1–4 CPU, 2–8 GB (68 tasks at 2 GB), agent 600–12,000 s |
| Wall per run, mean | A 819 s, B 641, C 556, F 651 | A 287 s, B 266, C 226, F 274 |
| Agent time p99 / max | ≤ 1,846 s / 4,785 s; 0 agent timeouts in 2,240 runs | max 4,404 s; 6 agent timeouts in 1,010 |
| Concurrency, fleet wall | 6 per runner (count only); about 21 h | 8 per runner (CPU ≤ 8, memory ≤ 48 GB); about 7.8 h |
| Spend by runner | $949–1,290; the shards were balanced on public rates, not on cost | $96–170 (1.8× max/min) |
| Prices (catalog) | Sonnet 5.5 = Sol ($2 / $10, cache read $0.10, write 5m $2.50 / 1h $4) | Opus 5.5 $4 / $20 (2× Sonnet, where Astra was 5× Sol); Haiku 5.5 = Luna |

Public TB 2.1 leaderboard averages (aggregates only): Claude Code trials take 550–800 s against Codex's 420–480 s,
that is **1.3–1.8× longer**.

## 1. Profiles, shard plans, admission

### 1.1 Agent × dataset profiles

`profiles.py` gets an `Agent` dimension: `codex` (today) and `claude-code`. The four CC profiles are `cc-deepswe`
and `cc-tb21`.

Each profile is today's `Dataset` plus agent-specific fields:
- `agent` (`codex` | `claude-code`);
- the job-config factory: `harbor_job:job_config` (Codex), and 4f's Claude Code module;
- the arms' main-loop pins (A Sonnet 5.5, C Opus 5.5, F Haiku 5.5, B auto);
- the plan path `experiments/claude-code-harbor/{deepswe,tb21}/plan.json`;
- the results directory under WORK_DIR: `cc-deepswe/results`, `cc-tb21/results`. Each gets its own proxy ledger,
  caps and exports;
- `dev_results`: `experiments/claude-code-harbor/results/{deepswe,tb21}`.

Selection: `--dataset deepswe|tb21 --agent codex|claude-code`; the default agent is codex. The existing names
(`deepswe`, `tb21`) resolve to the Codex profiles unchanged. **The Codex goldens stay byte-identical**: the current
`tests/test_golden_orchestration.py` plus the TB tests. The arm letters stay A/B/C/F, so shardplan's arm tuple is
unchanged; only the pins differ, and they live in the agent profile and the proxy (4f).

### 1.2 Plans: one per benchmark, with every stage pre-registered (stage 2 is a pure continuation)

`shardplan.py --dataset X --agent claude-code derive --from <the Codex plan>`:
- **Tasks and shards:** the Codex plan's shard assignment, content and image digests, minus the pre-registered drops.
  - DeepSWE keeps 112 tasks: the 113th's reference solution fails.
  - TB keeps 84: the TB §7.5 drops are 5, and flaky_env is kept as a mark.
  - Same shards means the same images per runner and the same per-runner balance.
- **Passes:**
  - `pilot` (phase pilot, §2);
  - `main` (rep 1);
  - `rep2` and `rep3`.
  - Every pass has all four arms, a seeded stratified block order and long tasks first (as TB), seed **20261107**.
  - The strata are (73's new tier pass on Claude Code cards × difficulty) for TB, and (language × difficulty band)
    for DeepSWE.
- **Recorded in plan.json:** the input hashes (Codex plan sha, strata sha), the Claude Code version, and the agent
  binary sha256 (4f).

**The stages are run selections, not plan edits:**
- stage 1: `--pass pilot`, then `--pass main`;
- stage 2: `--pass rep2 --pass rep3`.

The plan file and its sha are the same throughout. So stage 2 is a pure continuation: the same pins, block layout,
seeds and arm orders as were fixed before stage 1.

**Continuity pre-flight.** Before stage 2 (and on any resume), `run` refuses unless each of these equals the
previous `run-config.json`:
- the plan sha;
- the agent version and binary sha;
- the router policy and config hash (the proxy reads it from the router's response header; 4f);
- the assessor pack version;
- concurrency.

`--allow-change <field>` overrides, and is logged. The image digests are checked anyway (taskpin, at start).

**Are the shards fair for cost?** Rebalancing would break the "same images, same shards" continuity, so the shards
are not rebalanced. Instead, the per-runner caps (§3) use each shard's own projection: the pilot κ × that shard's
**Codex-measured** per-task cost. Our own data is a better weight than the public numbers.

### 1.3 Admission and the watchdog

| | cc-deepswe | cc-tb21 |
|---|---|---|
| Concurrency (fixed for the run) | **6** (count), as Codex | **8**, with Σ declared CPU ≤ 8 and Σ memory ≤ 48 GB, as Codex (4-CPU tasks run two arms at a time) |
| Why | 6 × 8 GB = 48 GB declared. Codex's host peak was about 30 GB in use (minimum available 34 GB); Claude Code adds about 0.3–1 GB per trial, inside each task's limit. CPU is 1.5× declared on 8 vCPU, as before. | Unchanged. The tasks' own limits bind the agent too (§2.4 OOM) |
| Watchdog | 5 h (3 h agent + 0.5 h verifier + build), as Codex | per task: agent + verifier + build + 30 min |

**Pilot gates on the concurrency** (it stays fixed for the run, so it is decided before `main`):
- 429 or overloaded after Claude Code's own retries in > 1% of main-loop calls, or any run excluded for upstream
  errors → main runs at 4 (DeepSWE) / 6 (TB).
- Host PSI cpu-full > 0.05, or a global OOM → the same.

**Will Codex's DeepSWE timeouts hold?** Yes. The 3 h agent limit is the task's own and is never overridden; a timeout
is a scored agent outcome.
- Codex's p99 agent time was ≤ 1,846 s and its maximum 4,785 s.
- At 1.8× slower, p99 is about 3,300 s and the maximum about 8,600 s, still under 10,800 s. Timeouts should be rare:
  under 1%, and mostly Opus or long tasks.
- TB's limits are the benchmark's own (the leaderboard ran Claude Code under them). Codex hit 6 timeouts in 1,010
  runs; at 1.3–1.8× we expect roughly 10–25 of 1,008.
- The pilot reports agent time / limit per arm, and S6 reports timeouts per arm.

Claude Code's own limits (4f's agent config): no `--max-turns`, i.e. Harbor's default (none), so the task timeout is
the bound. Bash tool timeouts stay at Claude Code's defaults ("defaults" per the PRD).

## 2. Staged run and the pilot

### 2.1 Stage 1 order: DeepSWE rep 1, then TB rep 1 (recommended)

The runner stack deploys in egress mode `none` (the default), which is DeepSWE's mode. So DeepSWE goes first:
- no network switch is needed at the start;
- DeepSWE carries about 70% of the spend, so its pilot calibrates the larger part of the $8,000 projection before
  anything large is spent;
- TB rep 1 follows after the changeover (archive, a3's switch to internet, isolation, setup, prepull, checks).

**TB first** would give a cheap first look sooner (TB rep 1 is about 2–3 h). But it would start with an extra network
switch, and it would project DeepSWE from a TB pilot, a worse calibration for the bigger half. Either order has 2
changeovers in total if stage 2 runs, because stage 2 starts in whatever mode stage 1 ended in. With DeepSWE first:
- **stage 1:** DS pilot → DS main → changeover → TB pilot → TB main → **stop** (runners in internet mode);
- **stage 2:** TB rep2/rep3 → changeover → DS rep2/rep3.

Reps are exchangeable, so the order of the stage 2 benchmarks doesn't matter statistically. 0d confirms.

### 2.2 Runners across the decision

| Option | Idle cost | Resume cost and risk |
|---|---|---|
| **Keep running** | $2.69/h for the fleet, about $65/day | none: images, checkouts, results, ledger and the internet mode stay warm |
| **Stop the instances (EBS kept)** | EBS only, 4 × 300 GB gp3, about $3–4/day | about 15 min: start, then `isolation --wait` re-proves the guardrails, then `status`. a3 must confirm the firewall rules, egress mode and `llmar-online` survive a reboot (a3's boot script reapplies them) |
| **Tear down and redeploy** | $0 | 2–3 h (deploy, ship, setup, prepull 21 GB TB + DeepSWE images, isolation, checks) plus redeploy risk. Stage 2 continues from fresh results dirs (fresh ledgers), which is fine because it is plan-driven |

a3 confirmed reboot safety. The firewall is an ExecStartPost of docker.service, and fails closed. The egress mode,
`llmar-online`, daemon.json and the env file persist. The public IPv4 changes.

On start:
1. wait for `systemctl is-active docker`, and check that runner-firewall exited 0;
2. run `infra/runner-ssm/runner-egress-<mode>.sh` (idempotent; it re-verifies the mode);
3. run `isolation --wait`;
4. then `status`, and resume.

Recommendation:
- **stop** the instances (confirmed safe);
- otherwise **keep** them running if the decision comes within about a day;
- **tear down** only for a wait longer than about 2–3 days.

Before any stop or teardown: `fetch --mode full` plus merge, so stage 1 is complete on the dev box.

### 2.3 The pilot as stage 1's first slice (phase pilot, excluded from the analysis)

**Pilot tasks per benchmark:** 2 per shard, 8 tasks × 4 arms = 32 runs. They are chosen by a seeded rule on the
Codex-measured per-task cost (all arms): one task near the shard's 25th percentile and one near its 75th, both under
the long-task threshold.
- TB adds **2 scanner-calibration tasks** (0d §10): a seeded draw (plan seed, label `scanner-cal`) from the 5 tasks
  that scanner v1 flagged in every Codex run. The pilot shows lookup-flag telemetry only.
- The pilot tasks also run fresh in `main`, as on TB.
- Codex already ran these tasks 3–5 times, so the pilot gives **paired Claude/Codex ratios on identical tasks**.

**What the pilot calibrates:**
- **κ per arm** = Σ Claude cost / Σ Codex cost of the paired arm on the same tasks (A ↔ Sol, C ↔ Astra, F ↔ Luna,
  B ↔ B). Prices differ (Opus is 2× Sonnet; Astra was 5× Sol), but κ absorbs that.
- Tokens per run, the cache read/write mix, and the helper (Haiku) share of calls and cost per arm.
- Wall time per arm, i.e. the time multiplier against Codex.
- 429 and overloaded rates after retries.
- Attribution: router log ↔ trial 100%, with the main/helper split (§4).
- OOM (§2.4).

**Projection** (computed by `fleet.py project` from the pilot rows; 0d owns the planning numbers):

    P_total = spent so far + Σ_bench Σ_arm κ_arm,bench × C_codex(arm, bench) × planned runs / Codex runs
              + runner hours (≈ $2.69/h × the projected wall) + assessor + the tier pass

C_codex is the Codex total per arm, with its runs normalised to Claude Code's 3 reps.

**The TB term:**
- before the TB pilot: DeepSWE's κ × Codex TB costs, marked provisional;
- after the TB pilot: its own κ.

**Stop-and-ask** (the PRD; no run cuts). After each pilot:
- if `P_total` for both stages exceeds **$8,000** (or stage 1's projection plus its spend does), stop before that
  benchmark's `main`, and 0c asks the user;
- runs are never cut to fit.

The stage 1 → stage 2 decision gets a fresh projection from the stage 1 κ, measured on 448 + 336 runs.

### 2.4 OOM measurement (0c, a3)

**Per trial (driver; on both datasets; in every phase, pilot included).** a3 confirmed the reads (cgroup v2, systemd
driver, `/sys/fs/cgroup/system.slice/docker-<id>.scope/`, derived from `/proc/<pid>/cgroup`). Each 10 s sample reads
the exact counters: `memory.peak` (the high-water mark), `memory.events` (`oom`, `oom_kill`), `memory.stat` `anon`, and
`memory.swap.current`/`swap.peak`. The last sample before Harbor deletes the container is the record, and the kernel
log is the backstop. Harbor sets no memswap limit, so "OOM" here means RAM plus swap exhausted (2 GB + 2 GB on a 2 GB
TB task), the same as in the Codex runs. A near-limit agent is more likely to swap and slow down than to be killed, so
`swap_peak_mb` is recorded too.
- **`oom`:** from the kernel OOM log, attributed to the trial's containers as today (global vs memcg). It gains the
  victim's process name (`task=<comm>`), so each kill is `oom_victim: agent | workload | unknown`, where agent means
  claude, bun or node. Docker `oom` events and exit-137 deaths stay as today.
- **`mem_peak`:** a 10 s sampler over the trial's running containers. It records the container's cgroup memory.current
  maximum and the agent process's RSS maximum (from `docker top <cid> -eo pid,rss,comm`, host-side and read-only;
  nothing is exec'd in the container). It writes `container_mem_peak_mb`, `agent_rss_peak_mb` and `mem_limit_mb` into
  the end event.
- **Pilot report per arm:** OOM-killed count (agent vs workload), the peak-to-limit ratio distribution, and tasks
  above 80% of their limit.

**Scoring (binding: design-stats §9, Amendment 1 §10, confirmed by 0c):**
- **Primary:** an agent OOM inside the task limit is class `agent` and is never rerun. It is scored by the verifier's
  reward if the verifier ran, and unresolved otherwise. This is the existing `agent` path; on DeepSWE, a collected
  patch with no reward is re-verified as today.
- **Sensitivity:** every agent OOM counts as unresolved, and an OOM-task-drop sensitivity is kept.
- **Victims:** agent-victim and workload-victim OOMs are scored the same way. The split is reported per arm (S6).
- classify tags each run (`tags: ['oom-container', 'victim:agent|workload|unknown']`) and never changes the class
  for it.
- A host (global) OOM stays `harness`, rerun (≤ 2), as today.

## 3. Per-runner caps under $8,000, and the CapLedger

**Ledgers.** There is one fail-closed CapLedger per runner per benchmark: its own results directory, settled spend
starting at $0, and a reservation per call. Settled spend persists across stages because it is the same directory.

**Each `run` start sets that ledger's cap:**
- **Hard cap** = the runner's projected spend for the passes being started (its shard's κ × Codex costs) × **1.4**,
  plus the $10 reserve, plus what it has already settled.
  - The 1.4 margin on a pilot κ keeps a cap stop (which excludes runs) unlikely. That matters given "don't let budget
    control make the run worthless".
- **Soft cap** = hard − $10 − the shard's largest single-block planning cost, so that blocks already admitted can
  finish.
- **Global pre-flight** (new, in fleet `start`): Σ over runners of the new hard caps, plus the other benchmark's
  settled and committed spend, plus spend outside the proxy, must be ≤ **$8,000**. Otherwise `start` refuses.
  - Spend outside the proxy: the pilots, the assessor, runner hours, the tier pass.
  - Hard caps are set no higher than the budget allows.
- **The per-runner pre-flight stays:** reserve < hard cap − the shard's largest expected single run.
- **Stage 2** re-derives the caps from the stage 1 κ, which is measured on every task.

**Reservations for Claude** (4f's hproxy pricing):
- A call's worst case must price its prompt at **max(uncached input, cache write 5m/1h)**, not at input. Claude Code
  writes the cache on most calls (the 1h write is 2× input), and an input-priced reservation would undershoot and eat
  into the reserve.
- The worst-case model is the pin for A/C/F, and Opus for B.
- A helper call reserves at its requested model, Haiku.
- Claude Code's subagents can have several calls in flight per trial; the ledger already sums every in-flight
  reservation.

## 4. classify and rerun rules for Claude Code

Harbor 0.25.0's claude-code agent classifies a failed `claude --print --output-format=stream-json` run from the
terminal `result`/`error` events only, then maps them through `ERROR_PATTERNS` to exception types. These already sit
in classify's tables, so the rules carry over. **The one structural need is the proxy summary's main/helper split.**
Today the rules key on the session's *last* model call. With Claude Code, a trailing helper call (Haiku: a title,
summary or Explore subagent) can fail while the main loop finished, and that would trigger a wrong upstream rerun.

**Interface, agreed with 4f in principle:**
- each proxy call records `role: main | helper | unknown`;
- the trial summary keeps today's all-call keys, plus `main: {calls, statuses, error_origins, last_call, spent_usd}`
  and `helper: {...}`;
- for Codex the split is absent, so its classification is byte-identical.

classify (cc profiles) uses `main.last_call` wherever it uses `last_call` today, and falls back to `last_call` when
roles are unknown.

| Claude Code failure | Harbor exception | Class / action |
|---|---|---|
| Normal end (`result` success), verifier ran | none | agent / score |
| Agent timeout (the task's limit) | AgentTimeoutError | agent / score (the verifier runs) |
| `prompt is too long` after auto-compaction; output token maximum | ContextWindowExceededError, OutputTokenExceededError | agent / score |
| Max turns (`result` subtype `error_max_turns`; only if a limit is ever set) | NonZeroAgentExitCodeError, last main call answered | agent / score |
| AUP or cyber refusal hard-stop | AgentSafetyRefusalError | agent / score |
| 429 / rate limit, 529 / overloaded, 5xx, connection lost or stalled mid-stream, after Claude Code's own retries | ApiRateLimitError, ApiOverloadedError, ApiInternalServerError, ApiConnectionClosedError, ApiResponseStalledError | upstream / rerun (≤ 2), when the **last main call** failed upstream or at the gateway. If the main loop's last call was answered, the session ended on its own: agent |
| Model not available (`Cannot use this model`), router refusal | ModelNotFoundError, router origin | upstream / rerun; router origin → sut / score_zero (as Codex: the router is in the path for every arm) |
| Auth (`Invalid API key`, 401/403) | AgentAuthenticationError | harness / rerun (the proxy owns the token) |
| Claude Code fails before any main call (install, config, binary) | NonZeroAgentExitCodeError, main.calls = 0 | harness / rerun |
| A helper call fails, and the main loop's last call was answered | none, or NonZeroAgentExitCodeError | **never a rerun**. Counted as `helper_errors` and reported per arm |
| Container-limit OOM | SandboxLikelyOutOfMemoryError, or a memcg kill in the window | agent / scored by the verifier if it ran, else unresolved; never rerun; tagged `oom-container` + victim (§2.4) |
| Host OOM | via the host summary | harness / rerun |
| Exit status masked (Harbor pipes into `tee`) while an API error ended the session | none | covered: exception `None` plus a failed last main call → upstream / rerun (existing logic). 4f's dry run checks that the exit status propagates |

**Lineages:** Claude Code's subagents start their own conversations, so `routerlogs.unique_lineages` (one lineage per
run) changes for cc profiles to "exactly 1 main lineage, ≥ 0 helper lineages". Attribution stays the hard pilot
gate: every router line belongs to exactly one registered trial.

## 5. Timeline (runner wall time; Claude Code 1.3–1.8× Codex)

| Step | Estimate |
|---|---|
| Prep: implementation, 17 (this design) | 7–9 h, in parallel with 4f's agent/proxy work and 73's tier pass |
| Deploy (a3/0c), ship, setup, DeepSWE prepull, isolation, checks re-run (pins re-checked, PRD) | 2–3 h |
| DeepSWE pilot (32 runs at concurrency 6) and its review | 1–1.5 h |
| DeepSWE rep 1: 448 runs, 112 per runner, about 1,050–1,450 s each | 6–8 h, plus a timeout tail of ≤ 3 h worst case |
| Changeover to TB (archive, switch, isolation, setup, prepull 21 GB, TB checks) | 2–2.5 h |
| TB pilot and review | 0.5–1 h |
| TB rep 1: 336 runs, 84 per runner, about 350–520 s each, long tasks first | 2–3.5 h |
| **Stage 1 total** | **about 14–19 h**; runner cost $40–55 |
| User decision | (runners stopped or kept, §2.2) |
| TB reps 2–3 | 4–7 h |
| Changeover to DeepSWE (images still on disk; isolation; checks reuse per 0d) | 1–1.5 h |
| DeepSWE reps 2–3 | 12–16 h |
| **Stage 2 total** | **about 17–24 h**; runner cost $45–65 |

Rough Bedrock figures (0d's numbers govern): κ ≈ 2–3 on tokens, at the catalog prices. DeepSWE is about $5–9.5 per
4-arm block and TB about $2.2–3.2, giving **about $2.3–4.0k for both stages**. That is under the $8,000 budget at the
planned 3 reps; the pilot decides.

## 6. Changeover dry run, updated (`tests/changeover_dryrun.py --agent claude-code`)

**New in the dry run:**
- the cc profiles, and both stages:
  - stage 1 = DS pilot → main → changeover → TB pilot → main, then **stop**;
  - an instance stop/start simulated as all units and watchers killed, then the driver resumed;
  - stage 2 = TB rep2/rep3 → changeover → DS rep2/rep3;
- the continuity pre-flight passes on a resume and refuses a changed plan or agent pin;
- the global $8,000 pre-flight, and per-benchmark ledgers with caps per stage;
- a fake Claude Code trial dir: the stream-json `claude-code.txt`, a sessions dir with a subagent file, and failure
  scenarios (429 after retries → upstream rerun; a trailing helper 429 → no rerun; a context overflow; an OOM-killed
  agent → tagged);
- fake proxy calls with main/helper roles and Claude cache-write pricing;
- the memory sampler against a docker-top shim.

**Kept:** the real isolation.py in the Harbor-free venv (the class of bug from the TB run), the real
taskpin/leakscan/lookupscan, and the Codex profiles' goldens byte-identical.

**Expected-last-line transcript:** as for TB, handed to 0c before the deploy.

## 7. Interfaces needed from others

- **4f:**
  1. the Claude Code job config. Helper aliases (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) are
     set explicitly to Claude Code's defaults; Harbor's `_model_alias_env(all_aliases=True)` would otherwise point
     them at the main model and break "helpers keep defaults";
  2. per-call `role` and the main/helper summary split;
  3. reservation pricing with cache writes;
  4. the agent version and binary sha, and the router policy hash, exposed for the continuity pre-flight;
  5. exit-status propagation through `| tee`;
  6. the memory sampler's container ids (the compose project prefix, as today).
- **a3:** reboot safety for the stop/start option (firewall, egress mode, `llmar-online`); the docker-top and cgroup
  read paths on the runner.
- **0d:**
  - the OOM scoring rule (default: agent, unresolved, tagged, with a sensitivity);
  - the pilot gates (429 > 1%, PSI, attribution 100%);
  - stage 2's benchmark order;
  - check reuse on the second changeover;
  - the interim look at stage 1.
- **73:** the Claude Code tier pass and `strata.json` per benchmark, before `derive`.

## 8. Estimate (17; after 0c's ack)

| Work | Hours |
|---|---|
| Agent dimension in profiles (cc-deepswe, cc-tb21), `derive`, pilot selection by Codex cost, plans; goldens | 2.0 |
| Continuity pre-flight; global $8,000 pre-flight; per-stage caps; `project` with κ from paired Codex tasks | 1.5 |
| classify: main/helper split, Claude Code table, OOM tags; driver memory sampler and OOM victim parse; tests | 2.5 |
| Merge rows (role split, helper share, memory, OOM), status counters | 1.0 |
| Dry run: cc profiles, two stages with a stop/start, fake Claude Code trials and calls | 1.5 |
| Runbook (`experiments/claude-code-harbor/ORCHESTRATION.md`) | 0.5 |
| **Total** | **≈ 9 h** |
