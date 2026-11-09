# Design (draft, 0c, 2026-11-05): DeepSWE v1.1 × Codex via Harbor

Owners fill in the sections marked **OPEN**. 0d reviews the draft before `task.py start`.

## 1. Known facts
- **Tasks:** `datacurve-ai/deep-swe` `tasks/<id>/`, Harbor format (`task.toml`, `instruction.md`, `environment/`,
  `tests/`, `solution/`), 113 tasks, 91 repos, 5 languages. Pin the repo commit.
- **Per-task limits:** agent `timeout_sec = 10800` (3 h), verifier 1800 s; 2 CPU / 8 GB / 20 GB each; agent and
  verifier `network_mode = "no-network"`; verifier `environment_mode = "separate"`.
- **Patch collection:** a `[[verifier.collect]]` hook, `git diff --binary <base> HEAD`, so the agent must commit.
- **Images:** prebuilt at `public.ecr.aws/d3j8x8q7/swe-bench-202605:<ext_id>-v1.1`.
- **Public trial data** (`deepswe.datacurve.ai/artifacts/v1.1/{tasks,trials}.json`): mini-swe-agent, 4 attempts
  per (task, config), with gpt-6-astra and gpt-5.6 Sol/Luna at low…max effort. Pass rate and cost per run at high:
  Luna 44% / $0.78, Sol 69% / $3.47, Astra 73% / $3.92. Held-out per-task oracle at high: 71.9% at $250 per pass of
  113 tasks (Sol $390, Astra $441).
- **Harbor** (`harbor-framework/harbor`):
  - installed `codex` agent; native `config.toml` support (custom provider, `OPENAI_BASE_URL`, reasoning effort);
  - local Docker environment with an egress-control sidecar (gost) for `allowlist` network policies;
  - adds the inference endpoint host to restricted policies;
  - separate verifier environment.
- **Router (deployed, stays up):** image 2834b91 with the experiment config (policy.experiment, assessor auto,
  autoRules all, timeout 5000 ms). Pins skip the assessor.

## 2. Arms
| Arm | Request | Tasks |
|---|---|---|
| A | `model: auto` + `x-router-hint: pin=global.openai.gpt-6.1-sol` | 113 |
| F | `pin=global.openai.gpt-6-luna` | 113 |
| C | `pin=global.openai.gpt-6-astra` | 113 |
| B | `auto`, no pin (assessor auto) | 113 |

- Same Codex version, prompt (task `instruction.md`), effort high and limits for every arm.
- Run order: shuffled with a fixed seed.
- One Harbor job per trial attempt, driven by 17 (§4.4).

## 3. Step 1: offline tier pass (73)
- Build the session-start request Codex would send for each instruction (the R2E capture shape, from the Harbor
  Codex version), then the router's card. Run the deployed assessor config (v2.1, Luna, autoRules all, 5000 ms)
  once per task.
- Spend ≤ $0.50, charged to this experiment's ledger, not the assessor eval ledger.
- Simulate B: tier → model → that model's public per-task pass rate and cost at high effort; compare with always
  Sol/Luna/Astra and the oracle.
- Report the tier mix, the latency, and the simulated cost/quality with caveats.
- Gate: fewer than ~5% of tasks off standard ⇒ 0c reports to the user before step 2.

### 3.1 Step 1 result (73, 2026-11-05) — gate passed
- Inputs: deep-swe 0b9fabbb, Harbor 0.25.0, 3 runs, $0.117 spent.
- Tier mix: frontier 69–71, standard 39–43, none 1–4 of 113 per run, fast 0. A task gets the same tier in all
  3 runs 78/113 times; pairwise agreement is 79%.
- Latency: p50 1.5 s, p95 1.7–1.8 s; 1 of 339 calls exceeded 5 s.
- Simulated B (public per-task means at high; frontier→Astra): 71.5% [64.4, 78.3] at $427 per pass, against Sol
  69.3% / $392 and Astra 73.2% / $443. B−Sol is +2.1 pp [−3.2, +7.5] at ×1.09 cost. The held-out oracle is
  70–71% at about $265.
- The frontier label barely tracks where Astra helps. Every frontier answer rests on deep-investigation +
  fact:deep, because the long multi-part specs read as "deep". Expect live B ≈ Astra on about 62% of tasks, with
  cost close to C. The deployed assessor is tested as-is (no pack changes in this experiment; see prd).

## 4. Harbor integration (4f) — draft for review
Code: `experiments/deepswe-harbor/` (`harbor_job.py`, `codex_config.py`, `llmar_env.py`, `harvest.py`,
`dryrun.py`, `mock_upstream.py`, `cli.py`); tests in `tests/` (no network, no Docker, no AWS).

### 4.1 Pins
- **Harbor 0.25.0** (PyPI; the last release, later builds are `0.25.1.devN`). Read from the released wheel, not
  the 981a4b2 checkout (that has unreleased changes, e.g. `skip_install`).
- **Codex 0.166.0** (the R2E pin: static musl release asset, sha256 pinned in `codex_setup.CODEX`), staged on the
  host with `cli.py stage-codex --arch x86_64`.
- Runner tools Harbor shells out to: Docker Compose v2 plugin and buildx ≥ 0.17 (`compose build` of the verifier
  image). Pre-pull Harbor's kernel-probe image `alpine:3.23.4@sha256:5b10f4…` and the sidecar base
  `gogost/gost:3.2.7-nightly.20260602@sha256:afc013…` (the sidecar build is COPY-only). `HARBOR_TELEMETRY=0`.

### 4.2 Codex install under no-network
- Harbor's `codex` install step uses nvm, nodejs.org and npm inside the container, so it can't work on the
  runner (bridges have no egress).
- In 0.25.0, `install()` returns early when `codex --version` equals the requested version. So the pinned binary
  is **bind-mounted read-only at `/usr/local/bin/codex`** (`environment.mounts`, agent environment only).
- Result: no derived images, no download inside any container. Dry run: `agent_info.version = 0.166.0`, install
  skipped.

### 4.3 Codex config (identical for every arm)
- Harbor's built-in `codex` agent, no subclass: `model_name = "auto"`, `skip_model_parsing`,
  `reasoning_effort = "high"` (Harbor passes `-c model_reasoning_effort=high`; the dry run saw
  `reasoning: {effort: high}` and `model: auto` in the request).
- Native config (inline JSON → `$CODEX_HOME/config.toml`):
  - provider `llmar`: `base_url = http://172.17.0.1:8088/r/<trial-id>/v1`, `wire_api = "responses"`,
    `env_key = LLMAR_DUMMY_KEY` (dummy value in `agent.env`);
  - R2E's provider retry and timeout settings and R2E's `CODEX_SETTINGS`, except the keys Harbor sets itself
    (effort, web_search);
  - `model_context_window = 272000` and `model_auto_compact_token_limit = 200000` (0d finding 3: below the
    smallest pool window, Sol 1.0M, at the long-context price step).
- **No startup network** (0c/18: on the runner every external DNS lookup times out after about 5 s).
  - Found with a logging DNS stub: Codex 0.166.0 resolves `api.github.com` and `chatgpt.com` at startup for its
    curated-plugin sync (`plugins` feature, on by default, which also tries a `git fetch` when git is present).
  - `features.plugins = false` and `features.plugin_discovery_prefetch = false` are set for every arm.
  - Measured in a plain container with blackholed DNS: before, 5.07 s with 4 queries; after, 0.22 s with 0
    queries. In the Harbor dry run the agent's tail after its last call fell from 4.8 s to 0.4 s.
  - Already off from R2E: update check, analytics, feedback, otel, apps, remote plugins, web search.
  - In the agent environment a lookup that is attempted fails at once anyway, because the sidecar's nftables
    reject forwarded DNS.
- **Stable prompt prefix:** CODEX_HOME is Harbor's constant `/installed-agent/codex-home`, and it appears in
  the skills developer block. Three dry-run trials had byte-identical developer text and tools. Only Codex's
  per-conversation ids differ per trial (input item ids, `prompt_cache_key`, `client_metadata`), as on R2E. So the
  router's templateFamily and the cross-trial prefix are stable; this is a setup fact for the report.
- Harbor's own flags: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json
  --enable unified_exec`. Codex warns "model metadata for `auto` not found, using fallback metadata"; this is the
  same for every arm and was the same on R2E.
- **Arm headers live on the proxy, not in the container**: the route registered for the trial id sets
  `x-router-hint: pin=<model>` (A Sol, F Luna, C Astra, B none) and `x-router-session: <trial-id>`. Client
  copies of router headers are never forwarded. The container config differs between trials only in the route
  id.

### 4.4 One Harbor job per trial attempt (agreed with 17)
- The driver runs `harbor run --config <job.json>` once per (task, arm, rep, attempt) with `n_concurrent_trials = 1`
  and `retry.max_retries = 0`, using `harbor_job.job_config(arm, trial_id, task_dir, jobs_dir, job_name, base_url)`
  and `harbor_job.harbor_env(os.environ)`. `harbor_env` scrubs OPENAI_/CODEX_/AWS_/ANTHROPIC_/LLMAR_, sets
  `HARBOR_TELEMETRY=0` and puts this directory on PYTHONPATH.
- Why per trial rather than per arm or all arms in one job:
  - Harbor queues trials task-major with agents in a fixed order, so it can't give each block its own random arm
    order (§7.6);
  - in-job retries delete the failed trial dir;
  - the driver needs one route and one trial id per attempt for the session stamp and the cap.
- The driver owns block and arm order, concurrency (≤ 6 per runner; never override task CPU/memory/storage), the
  soft cap and the §7.4 rerun rule. trial_id is a uuid4 hex, one per attempt and never reused, so every attempt
  has its own `x-router-session` (the assessor memo key includes the lineage).

### 4.5 Network
- Harbor policies (task.toml): `[environment]` has none, so the setup baseline is public; agent phase is
  `no-network`; verifier is separate with `no-network`.
- The job adds only `agent.extra_allowed_hosts = ["172.17.0.1"]`. An explicit list replaces Harbor's automatic
  inference host. Nothing is added to the environment or verifier.
- **Agent environment.** Harbor's egress sidecar (gost transparent proxy plus nftables in a shared netns, main
  `network_mode: service:sidecar`).
  - In allowlist mode non-TCP is rejected except DNS to resolv.conf nameservers, and TCP is redirected to gost,
    which forwards only when the original destination, or the sniffed HTTP Host/TLS SNI, is allowlisted.
  - Codex's requests carry `Host: 172.17.0.1:8088`.
  - The allowlist is host-level: through the sidecar, *any port* on 172.17.0.1 is reachable (dry run: host :22
    answered). The runner's INPUT rule, bridge → 172.17.0.1 TCP 8088 only, is the port boundary (a3).
  - **main drops NET_RAW** (`compose/main-cap-drop-net-raw.json`, review 18), so no raw/packet sockets can bypass
    the nftables rules.
- **Offline environments** (`llmar_env.LlmarDockerEnvironment` via `environment.import_path`).
  - An environment whose every phase policy is `no-network` (the separate verifier; oracle/nop checks) runs with
    compose `network_mode: none` (loopback only) and no sidecar.
  - Reason (review 18 F1): Harbor's own no-network is the sidecar, which a NET_RAW process can bypass and which
    leaves 172.17.0.1:8088 reachable.
  - Policy switches on an offline environment are no-ops, with a warning when the target isn't no-network.
- Dev-box dry run (agent container, before cap_drop): only the proxy port answered.
  - internet TCP/HTTP: closed with no data;
  - IMDS: closed;
  - external DNS: failed;
  - host :22 through the sidecar: open (see above).
  18 verifies on the runner.

### 4.6 Results mapping (`harvest.py`)
- Inputs:
  - 17's `results/merged/harvest-meta.jsonl` (`fleet.py merge`), one line per attempt: trial_id, arm, task,
    pass, phase, rep, attempt, rerun_of, class, action, score, is_final, final_status, runner/shard/block, host,
    cap_stopped, pred_tier, jobs_dir, task_dir;
  - `job_name` (the deciding verifier result, `<trial_id>-rv<k>-…` after a re-verify) and `agent_job_name`
    (agent logs and timings);
  - `merged/calls.jsonl`.
  One row per (pass, task, arm, rep): its `is_final` attempt, else its latest attempt as `pending`.
- **The score is the classifier's** (0d review F2):
  - `scored` → `resolved = (score == 1)`, `in_comparisons = true`;
  - `excluded`, or not final → `exit_reason = harness-error` (`budget` for cap_stop), out of comparisons.
  - For scored rows `exit_reason` (done / timeout / error) is descriptive only and comes from the deciding
    attempt's original Harbor exception, so a re-verified timeout stays `timeout`.
- The row `deepswe-harbor-run/v1` keeps the R2E names, so `results.analysis_row`, `stats.py`, `routerlogs.join` and
  73's `assessor_live` take it unchanged. Fields:
  - `run_id` = trial_id = x-router-session;
  - `repo` (owner/name), `language`, `size_bucket` (reference solution's non-test lines changed);
  - numeric `reward.json` fields, ctrf counts by bucket and status, patch bytes and emptiness;
  - `calls` (R2E `calls_summary`), `tokens_by_model` (0d finding 4) and `ledger_usd`;
  - Harbor exception and its FailureCause, phase timings, host metrics.
  Text-free.
- Harbor collects and verifies after `AgentTimeoutError` (dry run). Harbor's in-job retry is off.
- Commit requirement (0d finding 2): DeepSWE's instruction asks the agent to commit on a new branch. The collect
  hook diffs base..HEAD. This is the benchmark's own rule, the same for every arm and the same as the public
  harness, so no harness-level commit is added. `patch.empty` is reported per arm.
- Report: the R2E `report.py` is R2E-specific text. The DeepSWE report reuses its helpers and `stats.py` and takes
  73's assessor section. Written in P5.

### 4.7 Dry run (dev box, arm64)
- All 113 DeepSWE images are linux/amd64 only (manifest check, no pull), and the dev box has no amd64 emulation.
  So the local dry run uses a stand-in task (`dryrun.py`): an arm64 image, with DeepSWE's task.toml shape.
- The run uses the real Harbor 0.25.0, Codex 0.166.0, `harbor_job` configs and RunnerProxy against
  `mock_upstream` (loopback; it imitates router headers and requires a bearer `tok-*`). The token minter is
  fake, with a 125 s TTL so it re-mints mid-trial.
- Checked:
  - install skipped;
  - the agent's tool call ran and committed; the patch was collected and graded;
  - `x-router-session` = trial id; hints per arm; no `x-llmar-*` leak;
  - served model per call; ledger settled; token re-minted;
  - egress probe from the agent container; verifier-side probe;
  - F timeout path.
- The same `cli.py dryrun --task-dir <deepswe task>` runs a real task on the x86 runner (P2).

## 5. Host proxy (4f) — draft for review
`hproxy.py`. It reuses `codex-deepswe/proxy.py` and runs in-process in 17's driver. The only change to the R2E
file is additive: `_json_meta` records the error body's shape (`error_shape`), with no text.
- **Reused unchanged:**
  - routes `/r/<trial-id>/v1/{responses,models}`; nothing else, no CONNECT, no absolute URIs, no compressed
    bodies;
  - body `model` must be `auto`;
  - one upstream host (the gateway), resolved per connection and refused if any address is private, link-local
    or IMDS; TLS to the vetted IP with SNI and certificate checks;
  - SSE usage tap and per-call pricing (the experiment Region's catalog);
  - `served_model` and router headers in every call record;
  - no body, prompt, token or Authorization value in any log.
- **Session stamping:** `register_trial(trial_id, arm)` → `x-router-session: <trial_id>` and the arm's hint on
  every upstream request. The router's session label `sha256(trial_id)[:16]` is the router-log join key
  (`routerlogs.join` unchanged). Assessor `cached` comes from that join.
- **Token:** one `SharedToken` (auth.RunToken) for all trials.
  - Client-credentials token from the runner's secret, kept in memory.
  - Re-minted 2 minutes before expiry; dropped after an upstream 401 (at most once per 30 s), so Codex's retry gets a
    fresh one. Optional `token_max_age_s` (off by default; the pilot uses 600) re-mints by age, forcing a real
    mid-session re-mint. Counts are in the runner summary (`token_mints`, `token_remints`) and per trial
    (`token_remints` = distinct token generations seen − 1).
  - Trials last up to 3 h; the TTL is 60 min. Mint failures are `AuthError`, origin `proxy`.
- **Hard cap, fails closed** (`CapLedger`, default **$1,130 per runner of Bedrock spend seen by the proxy**,
  configurable; runner hours only if a rate is given):
  - every model call reserves its worst case before it is forwarded (R2E's estimate: previous prompt + new bytes
    / 3, all uncached, at the size's price, + 16k output);
  - a call is admitted only if settled + in-flight reservations + this call ≤ cap − $10 reserve;
  - the first refusal stops the proxy: every later call is `429 budget`, attributed to its trial (`cap_stopped`),
    until an operator restarts it with a new cap (`unstop`, logged);
  - the admit/settle/stop log (`cap-events.jsonl`) is fsynced; on restart, an admitted call without a settle is
    charged its worst case;
  - `proxy-state.json` mirrors the totals for the driver;
  - no per-trial budget (§7.5); trials over $25 go to `alerts.jsonl`.
- **Failure fields** (0d F1/F4, for 17's split by status and code): each failed call records status, origin, the
  error code (`code`, sanitized to `[A-Za-z0-9_.-]{1,64}`, from the JSON error's code or type or from a stream
  `response.failed`/`error` event), the body shape, the stream terminal and `model_not_found`. `served_model` is
  recorded as soon as headers arrive, so a call that fails mid-stream still names its model (73 L1). Token
  invalidation after a 401 is limited to once per 30 s (73 L3), and the settle runs in a `finally` (73 L2).
- **Per-trial summary** for 17's classifier (`unregister_trial`): statuses (model calls), `error_origins`
  (router / gateway / upstream / proxy / transport; heuristic from router headers and the error body's shape,
  checked against the router-log join), `last_call` (with `code`), `last_failure`, `failures`, `throttled`, `cap_stopped`, `auth_errors`,
  `token_invalidations`, `refused`, `calls`, `spent_usd`, `served_models`, `tokens_by_model`, `open_calls`.
  Every `calls.jsonl` line has trial_id, status and origin.
- **Exposure (builder-security):**
  - Binds only `172.17.0.1:8088`: `check_bind` refuses unspecified, loopback and public addresses, and
    RunnerProxy refuses any address other than the configured proxy address (review 18 F7).
  - No auth of its own. Who can reach it: local containers on the runner's bridges (the runner has no inbound
    rules; the firewall admits only TCP 8088 from bridges). Offline environments can't reach it.
  - What a caller can do: call `/r/<registered uuid>/v1/responses` with model `auto`, which spends at most the
    cap. The token never leaves the proxy.
  - The dev-box dry run bound docker0's address there, against a mock with no credentials.

## 6. Runner (a3) — OPEN
- `llmar-runner` with instance type and disk as context parameters: x86, 8 vCPU / 64 GB (r7i.2xlarge class).
- Disk sized from the 113 image sizes (manifest sizes, measured without pulling).
- Firewall: DOCKER-USER rules compatible with Harbor's compose networks and egress sidecar. Task and verifier
  containers: no IMDS, no host ports except the proxy port, no internet. The sidecar may reach only the proxy.
- Concurrency: 2 CPU per trial; agents mostly wait on the model, so `--n-concurrent` 6–8 is measured in the
  pilot (CPU steal, verifier time).

## 7. Statistics (0d) — pre-registration (budget: $4,000 planned + 20% buffer, design §9)
Frozen before the pilot. Functions are in `experiments/codex-deepswe/stats.py`:
- reused: `paired_diff` (Newcombe method 10 + exact McNemar), `noninferiority`, `cost_ratio` (ratio of sums,
  seeded bootstrap), `ideal_router`, `replicate_noise`, `by_stratum`;
- added for this experiment (0d, with tests): `paired_mean_diff` (several runs per (task, arm)) and
  `ideal_router_heldout`.

Seed 20261105, 10 000 resamples. The module docstring is the R2E pre-registration and stays as is; this section is
the one for DeepSWE.

### 7.1 What the public data says about noise (planning numbers)
From `trials.json`, mini-swe-agent at effort high, 4 attempts × 113 tasks per model (planning only: other models
and harness):

| | Luna | Sol | Astra |
|---|---|---|---|
| pass rate | 44.2% | 69.4% | 73.2% |
| tasks with mixed outcomes over 4 attempts | 59% | 38% | 22% |
| P(two runs of the same config disagree), unbiased | 33% | 22% | 12% |
| cost per run, mean / p90 / max | $0.78 / 1.28 / 2.76 | $3.47 / 5.79 / 14.31 | $3.92 / 5.99 / 13.66 |
| agent time per run, mean / max | 8 min / 46 min | 10 min / 39 min | 17 min / 86 min |

- Noise is about 4× R2E's. Two Sol runs disagree on ~22% of tasks, so **B = Sol on every task would still show
  ~22% discordance against A**, and a single-run B−A has a 95% CI of about **±8–9 pp** however good the router is.
- Sol vs Sol cost ratio on one run each: about 1.0 [0.94, 1.05]. A cost difference under ~6% between B and A is
  noise.
- Expected single-run discordance and difference vs Sol: Astra 24%, +3.9 pp; Luna 40%, −25 pp.

### 7.2 Design and estimands
Runs per (task, arm), all planned up front, run as passes in which every compared arm appears (§7.6):
- **A (Sol) 3, B (auto) 3, F (Luna) 2, C (Astra) 2** on all 113 tasks (after the §7.4 drop rule);
- R2 (a 4th A + B run) is **dropped** after step 1: B costs about $427 per pass, not $370, which leaves about $190,
  and a 4th run on about 26 tasks would gain less than 0.3 pp.
- After the pilot (κ_Sol ≈ 0.18), 4th and 5th A + B runs and a 3rd C + F run are pre-registered as extensions that
  the checkpoint adds if the projected headroom covers them (§7.5.1).

Unit: a task. The tasks are treated as a sample of hard long-horizon tasks. Each arm's per-task resolve rate is
the mean of its runs; every comparison is paired on the tasks where both arms have ≥ 1 scored run, with equal
weight per task.

**Primary (one joint question): where does B sit against A on quality and cost?**
- P1. Δ(B−A) = mean over tasks of [mean of B runs − mean of A runs] (`paired_mean_diff`):
  - paired percentile bootstrap CI over tasks;
  - two-sided sign-flip randomisation p;
  - non-inferiority at **10 pp** (the R2E margin): shown iff the CI lower bound > −0.10.
- P2. Cost ratio = Σ_tasks (mean B cost) / Σ_tasks (mean A cost), via `cost_ratio` on per-task mean costs.
- Claims, all pre-registered:
  - "B ≥ A at lower cost" only if P1 NI is shown **and** the P2 upper bound is < 1.
  - "B better than A" only if the P1 lower bound is > 0.
  - "B costs more than A" if the P2 lower bound is > 1.
  - Otherwise B's point on the cost/quality plane is reported with both CIs, next to A and C.
  - Never "equivalent".
- **Expectation after step 1** (frontier routing on about 62% of runs, so B ≈ Astra there): B−A about +2 pp,
  cost about ×1.09. So "lower cost" is unlikely, NI is likely shown, and a +2 pp gain is not detectable. The
  question in practice becomes S1's B vs C.
- Sensitivity, reported next to P1: run 1 only, `paired_diff` (Newcombe + McNemar), comparable with R2E.
- Expected precision (simulated from the public per-task rates; the range is plug-in vs Jeffreys-posterior
  per-task rates):

| scenario | true B−A | 1 run each: half-width / P(NI) | 3 runs each: half-width / P(NI) |
|---|---|---|---|
| B = Sol on every task | 0 | ±7.4–9.0 pp / 0.60–0.77 | ±4.3–5.2 pp / 0.96–0.99 |
| 15% to Luna, 5% to Astra, at random | −2.9 pp | ±8.3–9.6 pp / ~0.33 | ±5.5–6.2 pp / ~0.62 |
| 30% to Luna, 10% to Astra, at random | −5.7 pp | ±9.0–10.1 pp / 0.08–0.13 | ±6.4–6.9 pp / 0.11–0.21 |

  - With the observed tier mix (each B run goes frontier with that task's tier-pass frequency) and 3/3/2 runs of
    A/B/C: B−A +1.7 to +2.3 pp, ±6.3–7.0 pp, P(NI) 0.94–1.0; B−C −1.3 to −1.5 pp, ±5.0–6.4 pp, P(NI) 0.77–0.95.
  - With 3 runs each, the minimum detectable B−A at 80% power is about 7 pp (about 12 pp with 1 run).
  - A B that routes 20% of tasks to Luna and loses about 3 pp still shows NI only about 60% of the time, so the
    report states the CI and does not read "not shown" as "B is worse".

**Secondary (95% CIs, no multiplicity adjustment, labelled secondary)**, all with `paired_mean_diff` on
per-task means:
- S1. **B vs C, the key secondary after step 1:** B−C with NI at 10 pp, and ΣB/ΣC. Does B keep Astra's quality
  while sending about 38% of tasks to Sol? Expected about −1.5 pp at about ×0.96, a saving the cost CI (about ±5%)
  probably can't separate from 1. Also B−F and ΣB/ΣF.
- S2. F−A and C−A.
  - Expected half-widths: C−A about ±7 pp (was ±9–10 at one run), so a true +3–4 pp is still not detectable;
    report "no difference detected" if so. F−A about ±8 pp.
- S3. Ideal per-task router over {F, A, C}:
  - **held-out** (`ideal_router_heldout`: choose on one run, score on another) — the honest version;
  - in-sample (`ideal_router` on run 1) — the noise-inflated upper bound. The gap between the two is the noise
    inflation.
  - B's gap to the held-out version. The public 71.9% "held-out oracle" (§1) uses other models and a different
    harness; reference only.
- S4. **Stratified by the tier-pass tier** (step 1, fixed before the live run, so pre-treatment).
  - Stratum = the majority tier over the 3 tier-pass runs ("none" counts as standard, the router's no-opinion
    mapping): **frontier 73, standard 40** (0d's count from `tiers-r*.jsonl`; 0c's 70/39 may count "none"
    differently — fix one definition before the pilot). A secondary flag marks the 80 tasks whose 3 tiers agree.
  - Per stratum, `paired_mean_diff` and `cost_ratio` for B−A, B−C and C−A. These are inferential at 73 and 40
    tasks, but secondary. Expected half-widths for B−A: about ±9 pp (frontier) and ±8–9 pp (standard).
  - **Transparency checks:** in the standard stratum B ≈ Sol, so B−A ≈ 0 and B/A cost ≈ 1 plus assessor
    overhead. In the frontier stratum, B ≈ Astra, so B−C ≈ 0 and B/C cost ≈ 1. A deviation in either is router
    behaviour (mid-session switches, failovers), not routing.
  - **Routing value:**
    - The decomposition B−A = w_frontier·Δ_frontier + w_standard·Δ_standard, with the counterfactual C−A per
      stratum.
    - Assessor skill = (C−A | frontier) − (C−A | standard): does it send to Astra the tasks where Astra helps?
      Public expectation +4.7 vs +2.5 pp. The interaction CI is about ±11 pp, so this is **descriptive**; step 1
      already says the frontier label barely tracks Astra's gains.
  - **Live tier:** B's session-start tier per run against the tier-pass majority, as an agreement table. On the
    33 unstable tasks the live tier varies between runs of the same task, independently of the agent: a small
    within-task natural experiment (Astra-served vs Sol-served B runs), descriptive only.
- S5. Run-to-run noise per arm (`replicate_noise` on all 113): flip rate (Wilson) and pair disagreement
  (bootstrap). For B, also the live tier flip rate across its 3 runs. This is the null scale for every paired
  difference.
- S6. Descriptive:
  - cost per solved task, tokens and cache;
  - timeouts and context failures per arm;
  - B's token share by served model (mid-session switches);
  - assessor latency and cost; failovers;
  - per-runner table (§7.7).

### 7.3 Why this allocation
Weighed against the old R1 (A′ on 40), a second B pass only, and second or third C passes:
- **Every extra run of A and B narrows the primary; runs of C or F don't.** A second run of A only gives
  ±7.5–7.8 pp. A and B at 2 runs each give ±5.2–6.3. At 3 each, ±4.3–5.2 (B ≡ Sol), or ±6.3–7.0 with the
  observed tier mix. A 4th run gains under 0.5 pp, so R2 is dropped.
- **F and C at 2 runs**, because:
  - it is the minimum for `ideal_router_heldout`;
  - it gives F's and C's own noise;
  - it brings the secondary B−F, B−C and C−A from about ±9–10 to about ±7 pp.
  A 3rd C run ($443) gains only about 1 pp on secondaries and nothing on P1.
- **Old R1 is superseded:** A's noise comes from its 3 runs. **R3 stays** (tier pass × 3, about $0.30): it
  separates assessor instability from agent noise.
- **Repeats run as whole passes in which every compared arm appears** (§7.6). So drift between passes is balanced
  across arms, and every run of a task enters P1 on equal terms.
- **Open, for 4f/0c:** whether the router's assessor cache is keyed by session or by content.
  - If by content, B's runs 2–3 reuse run 1's tier, so B's repeats measure agent noise only, and R3 is the only
    measure of assessor noise.
  - Either is acceptable, but it must be known. Log `assessor.cached` per B run.

### 7.4 Pre-registered scoring and exclusion rule
Classification is a deterministic function of logged error fields (exit codes, exception class, HTTP status and
its origin), written and tested before the pilot, and applied without looking at rewards. It matches the public
leaderboard: there `agent_timeout` and `context_window_exceeded` are scored (4 of 116 timeouts passed on the
patch they left), while provider/routing/verifier errors are `excluded_error`.

| Class | Examples | Scoring |
|---|---|---|
| **Agent outcome (scored)** | verifier fails; empty patch or no commit; agent timeout (3 h); context window exceeded; Codex gives up or exits non-zero due to model behaviour; refusal or content filter; task-container OOM within the task's own 8 GB limit | scored by the verifier on whatever was committed; no patch = 0 |
| **System under test (scored as failure)** | an error **originating in the router**: 4xx/5xx generated by the router, assessor-caused errors, a bad routing decision, a failover that ends the session | 0 for that arm, and listed. The router is the treatment in every arm |
| **Upstream infrastructure (retry)** | Bedrock 5xx, throttling or timeouts surfacing after the router's and Codex's own retries; model-not-found | rerun the whole trial |
| **Harness/host infrastructure (retry)** | proxy errors (token mint/refresh, ledger), image pull or environment start failure, Docker/sidecar failure, host OOM or kill, runner reboot | rerun the whole trial |
| **Verifier infrastructure (re-verify)** | verifier timeout (1800 s) or crash with the collected patch intact | re-run the verifier only; rerun the trial if the patch is lost |

- At most 2 reruns per (task, arm). A rerun replaces the errored trial; the count is reported per arm.
- Still errored after 2 reruns: excluded from comparisons with that arm (pairwise complete). If any arm has
  more than 3 such tasks, a sensitivity analysis counts them as failures.
- Before any model run (P2 oracle check): drop a task whose reference `solution/` does not pass, or whose
  unmodified base passes. Same set for every arm; the drops are listed.
- Pilot runs are not in the analysis; the main pass reruns those tasks.
- A cap stop by the proxy: in-flight trials are excluded as infrastructure. Analysis is on the complete task
  blocks (see run order).

### 7.5 Budget ($4,000 planned; the 20% buffer, up to $4,800, is only for reruns and κ > 1 overruns of planned runs)
Planning cost = public mini-swe-agent cost per run × κ, where κ = our cost / public cost, measured per arm.

| Item | Runs | Planning $ (κ = 1) |
|---|---|---|
| Step 1 tier pass × 3 (R3) | — | 0.5 |
| P3 pilot (4 tasks, one per runner and language, × 4 arms; not analysed; cap approved by 0c) | 16 | ≤ 50 |
| A, Sol × 3 | 339 | 1,176 |
| B, auto + assessor × 3 (≈ $427 per pass: step 1's simulated mix, about 62% Astra) | 339 | ~1,281 |
| F, Luna × 2 | 226 | 176 |
| C, Astra × 2 | 226 | 886 |
| 4 runners + EBS (4 × r7i.2xlarge + 250 GB ≈ $2.69/h; about 330 trial-hours at public speed, so about 15 h wall per runner at 5–6 slots, about 45 h if Codex is 3× slower) | — | ≤ 250 |
| **Planned total** | 1,146 | **≈ 3,820** |
| Unplanned headroom inside the $4,000 | | ~180 |
| Buffer: reruns (§7.4) and κ > 1 on the planned runs | | ≤ 800 |

**Checkpoint at 25%**, when every runner has finished ≥ 7 of its task blocks (random by construction):
re-project the planned total from the measured per-arm κ, plus reruns at the observed rate.
- Projection ≤ $4,800, including reruns (the buffer absorbs κ > 1): continue as planned.
- Projection > $4,800: the tier pass routes ≥ 10% of tasks to frontier, so **0c asks the user** and gives the
  two options with their precision cost:
  1. C's 2nd run → a seeded subset: S1/S2 widen, and the held-out router shrinks to the subset;
  2. the 3rd A and B runs → a seeded subset, the same tasks for both: P1 widens from about ±6.6 toward ±8 pp.
  0d's default recommendation is (1): it keeps P1 intact. Then stop and ask again if it still doesn't fit.
- Every cut is to a seeded, stratified subset of tasks that is fixed before any of the cut runs' outcomes are seen.
  P1 stays unbiased because tasks are weighted equally whatever their run count.

No per-trial cost cap, since truncating a run changes the agent. The proxy alerts on any trial over $25.

**Per-runner caps:** each proxy ledger counts only Bedrock calls through that runner's proxy.
- Planned Bedrock per runner ≈ $880 (+ $40 pilot on one of them), under the $1,000 plan cap.
- Runner hours (≤ $250) and the router's own assessor calls (a few dollars) are outside the proxy ledgers. So
  four hard caps of $1,200 could reach $4,800 in Bedrock alone and exceed the ceiling once the runners are added.
- Recommend: per-runner hard caps of **$1,130** (= ($4,800 − $250 − $30) / 4), and 0c moves headroom between
  runners.

#### 7.5.1 Headroom use (pre-registered 2026-11-05, after the pilot, before any checkpoint data)
The pilot measured cost only (not analysed): κ_Sol ≈ 0.18 ($0.62 per run), κ_Astra ≈ 0.9 ($3.55), κ_Luna ≈ 0.1
($0.08), B ≈ $2.6. At these κ the planned passes cost about $1.9k in Bedrock, which leaves about $1.9k of headroom
inside the $4,000. It also moves the expectation in §7.2: B/A cost is about ×4 (so "B costs more than A" is the
likely P2 claim) and B/C about ×0.7, so S1 (B vs C) carries the practical question.

Per-pass cost at pilot κ: A $70, B $275, C $401, F $9. Simulated with Jeffreys-posterior per-task rates and the
observed tier mix (§7.2), runs per arm as A/B/C:

| Runs A/B/C | Extra $ | B−A half-width / P(NI) | B−C half-width / P(NI) |
|---|---|---|---|
| 3/3/2 (plan) | 0 | ±7.0 pp / 0.94 | ±6.4 pp / 0.77 |
| 4/4/2 (+ `rep4`) | 345 | ±6.6 / 0.96 | ±6.1 / 0.82 |
| 4/4/3 (+ `rep3c`) | 755 | ±6.5 / 0.97 | ±5.6 / 0.87 |
| **5/5/3 (+ `rep5`)** | **1,100** | **±6.2 / 0.99** | **±5.5 / 0.89** |
| 8/6/4 (all the headroom) | 1,980 | ±5.9 / 0.99 | ±5.1 / 0.94 |

- The floor is set by between-task heterogeneity: about ±4.8 pp on B−A with infinite runs. Past 5/5/3 each
  further $400 buys ≤ 0.3 pp, so the rest of the headroom is **not** spent.
- A-only passes are cheaper per pp, but they are not used: they put more of A's runs late in time than B's,
  which §7.6 avoids. Every extension keeps A and B in the same passes.

**Extension list, in this order, appended after `rep3` on every runner** (all 113 tasks, `--order stratified`, so
every prefix is a stratified subset; orders are fixed by the plan seed and the pass name):
1. `rep4`: A, B, rep 4. Block-list sha256 prefix 601119d55872a290.
2. `rep3c`: C, F, rep 3 (F adds $9 and a third held-out fold for S3). Block-list sha256 prefix e20dd41b9921c197.
   C's 3rd run sits between B's 4th and 5th in time.
3. `rep5`: A, B, rep 5. Block-list sha256 prefix b00727866ecc3fa3.

(The sha256 is over `{shard: [task, ...]}` in block order, sorted keys, from a dry run of `add_pass` on the frozen
plan.)

**Rule at the checkpoint** (applied by 0c with `fleet.py project`; cost figures only, no per-arm outcome is looked
at before the rule is applied):
- H = $3,800 − (spent + projected remaining Bedrock of the planned passes with reruns at the observed rate +
  runner hours to date and projected + assessor calls). The $200 below $4,000 absorbs κ error in the projection;
  the $800 buffer stays reserved for reruns and κ > 1 on planned runs, and extensions never draw on it.
- Walk the list in order. Add an item if its full projected cost (checkpoint κ × planning cost, plus its runner
  hours) ≤ the H left.
- If the next item doesn't fit in full: add it and `shardplan cut --name <pass> --per-shard N` with N = the largest
  number of blocks per shard that fits, if N ≥ 7; otherwise don't add it. Then stop.
- Stop after `rep5` in any case. Also check that each runner's projected Bedrock stays under its hard cap minus
  the proxy reserve.
- If the projection exceeds $4,800 instead, §7.5's cut options apply and no extension is added.
- 0c records H, κ per arm, and the passes added (and any cut) in run-config before restarting the driver with the
  added `--pass` flags.

**Analysis with the extensions:** P1, P2 and S1–S6 are unchanged and use every scored run (equal task weights;
unequal run counts per task from a cut are fine). Two added sensitivities, reported next to P1 and S1:
- S7a: reps 1–3 only (the plan as first registered, A/B/C 3/3/2);
- S7b: drift check, A's and B's reps 4–5 against their reps 1–3, paired by task (`paired_mean_diff` within arm),
  descriptive.

#### 7.5.2 C and F reps 4–5, added after an interim look (registered 2026-11-06, before any rep4c/rep5c run)
What happened (§11): interim per-arm resolve rates on main + rep2 were computed and shown to the user at 01:50 UTC.
At about 02:10 the budget was doubled and rep4c/rep5c (C and F, reps 4–5) were added. The rule ("every arm gets 5
runs per task") does not mention the interim rates, but nobody can show the decision would have been the same
without them. So:
- **Blind-design set:** the runs whose design was fixed before any outcome was seen. That is A and B reps 1–5
  (§7.5.1, fixed at the checkpoint) and C and F reps 1–3 (`rep3c` included).
- **P1/P2 are unaffected:** A and B have no runs added after the look. They use reps 1–5, as registered.
- **S1 and S2 claims (B−C, B−F, C−A, F−A: NI, better, cost) are made on the blind-design set.** The same comparisons
  with C and F at 5 runs are shown next to them as the more precise estimate, labelled "includes runs added after
  an interim look". If the two disagree on a claim, the report says so and keeps the blind-design claim.
- **S3, S4 and S5** use all runs. Wherever C or F reps 4–5 enter, the label says so; these sections are secondary
  or descriptive anyway.
- **S7a** (reps 1–3 for A/B, 1–2 for C/F) is unchanged. **S7b** covers all four arms: reps 4–5 against reps 1–3,
  within each arm, descriptive.
- **No further interim looks** at per-arm outcomes until every pass has a final record on every runner. No further
  design changes are made on any basis other than cost.
- Expected precision at 5 runs per arm: B−C ±5.0 pp (all runs), against ±5.5 on the blind-design set. B−A stays
  ±6.2. More budget can't fix the floor for B−A: with 112 tasks, between-task heterogeneity holds it at about
  ±4.8 pp however many runs, so a true B−A of a few pp can't be detected. The decisive questions are NI and cost.

### 7.6 Run order
Amended at P1 to fit 17's shard plan, which has one rep per pass. The properties §7 needs are kept.
- **Passes, in this order on every runner:**
  1. `main`: A, B, F, C, rep 1;
  2. `rep2`: A, B, F, C, rep 2;
  3. `rep3`: A, B, rep 3.
- Each pass covers the runner's whole shard, in blocks. A block is one task with that pass's arms in a seeded
  random order. Each pass's block order is the shard shuffled with seed 20261105 + runner index (+ the pass
  number).
- **Every arm of a comparison is in every pass it runs in.** So drift between passes hits A and B (and F and C in
  passes 1–2) equally, and each paired difference stays within one pass's time window.
- The noise estimates (S5) span passes, so they read as "noise plus drift over the run".
- The 25% checkpoint is taken in `main`. Its cuts (§7.5) become pass cuts, `shardplan cut` to the first N blocks
  per shard, a seeded prefix fixed before any of those runs:
  - option (1): C's arm in `rep2` → cut;
  - option (2): `rep3` → cut.
- A cap stop leaves complete blocks of the pass that was running.
- The pilot is a separate pass and is not analysed.

### 7.7 Runners (design §9)
- The runner is a **blocking factor by design**: every arm of a task runs on the same runner, so each paired
  difference is within-runner, and a runner's additive effect (host speed, network) cancels in the pair. The
  shards are stratified by language and public difficulty, so pooling the paired differences across runners is
  unbiased for the 113-task estimand.
- Ignoring the stratification in the CI is conservative (stratified assignment can only lower the variance).
  **P1/P2 pool all runners, unstratified, as pre-registered.** The runner adds no parameter to the primary.
- What pooling does not remove is a **runner × arm interaction**: a slow or overloaded host hurts long runs
  (Astra about 2× Sol's agent time) and timeouts are scored. It is prevented by:
  - identical instance type, AMI, bootstrap, `--n-concurrent` and Harbor/Codex versions on every runner;
  - blocks launched together, so arms share the same host load.
  It is checked, before unblinding the arm comparisons, by per-runner health:
  - CPU steal and load;
  - host OOM and kill events;
  - infrastructure-error rate;
  - agent time of A runs relative to the public time of the same tasks.
- **Rule:** a runner whose host faults are flagged has the affected trials classified as infrastructure (§7.4)
  and rerun on that runner after the fault is fixed. A trial is never moved to another runner, because the pair
  must stay within one runner.
- Reported per runner (descriptive, about 28 tasks each, B−A CI ≈ ±10 pp at 3 runs): B−A, cost ratio, timeouts and infra
  errors. No significance test across runners: it would have no power and is not a gate.
- **Caps:** a per-runner cap stop truncates only that runner's shard. Its completed blocks are a random subset of
  its shard, so the analysis set is still unbiased but no longer balanced by stratum. 0c moves headroom before
  any runner reaches its cap.
  - A cap stop with other runners still holding headroom is a process failure, logged as such.
  - The §7.5 checkpoint cuts are decided globally, and every subset is drawn stratified by runner.
- Results rows carry `runner` (shard index); `by_stratum(a, b, 'runner')` gives the per-runner table.

## 9. Four runners, sharded by task (proposed to the user 2026-11-05)
- Four identical runners (same instance type, AMI and bootstrap). The 113 tasks are split into four shards,
  stratified by language and by public difficulty (the per-task pass rate at high effort), with a fixed seed.
- Every runner runs **all four arms** on its own shard, in shuffled order. So no arm is tied to one machine or one
  time window, and the pairs stay within one machine. The runner is a stratum in 0d's analysis.
- Each runner's proxy has its own hard cap of $1,130 on Bedrock spend. The four sum to $4,520, which leaves room
  under the $4,800 ceiling ($4,000 plan + the user's 20% buffer) for runner hours (≤ $250) and the router's assessor
  calls, neither of which the proxy sees (0d). The driver stops scheduling new planned work at a $1,000 soft cap and reports to 0c; the buffer covers
  retries and overruns of already-planned runs, and anything beyond the plan needs 0c's go-ahead. 0c may move headroom
  between runners. A runner is stopped as soon as its shard is done and its results are fetched; all are destroyed
  at the end.
- Each runner pulls only its own shard's images (about 28), so disk is sized per shard.
- Capacity checked (ap-southeast-1 Bedrock quotas): Sol 2M TPM, Astra 4M, Luna 4M. At 4 × 6–8 concurrent the
  estimated Sol peak is about 1M TPM. Watch for 429s (failover would confound the arms) and router load (one
  task) in the pilot.
- Owner of the orchestration (shard plan, per-runner driver around `harbor run`, results fetch/merge, monitoring,
  oracle check): 17.

- Runner price check (0c, 2026-11-05): r7i.2xlarge is offered in apse1-az1/az2/az3 at $0.6384/h; gp3 costs
  $0.096/GB-month. So 4 × (r7i.2xlarge + 250 GB) ≈ $2.69/h, about $65 per day.
- Fetch: the light set (rows, ledger, calls, result/reward/ctrf, patch, metrics) goes as chunked base64 over SSM
  send-command, the same way as R2E. Full trial dirs go to a private experiment bucket (`<prefix>-runner-results-*`):
  Block Public Access on, SSE-S3, TLS only, no public grants, the runner role limited to s3:PutObject on its
  prefix, a 30-day expiry, emptied and destroyed with the runner stack.
- Assessor cache (answer to 0d's question): the core memo key is (assessorId, lineage, turnKey), where turnKey
  hashes the message chain. The lineage comes from `x-router-session`, so a per-trial session header gives every B
  run its own consultation. Without the header, same-task runs could share a fingerprint lineage and reuse run 1's
  tier. The proxy must therefore stamp a unique per-trial session, and `assessment.cached` is logged per B run.

## 10. Isolation and security checks (18)
- Independent review, not anchored on the owners' reading: the proxy bind and its lack of auth, the
  DOCKER-USER/bridge rules, Harbor's egress sidecar, the verifier's no-network mode, and the token path (minted on
  the host, never written to disk, never inside a container).
- An isolation suite run on each runner before the pilot, as executable checks with pass/fail. From an agent
  container and from a verifier container: no internet (public DNS and HTTPS), no IMDS, no other host ports, the
  proxy reachable only from the agent side. From the host: the proxy is not bound beyond the bridge, and the runner
  security group has no inbound rules.
- An after-run scan of the trial artifacts and logs for token-shaped strings and account ids.

## 8. Risks
| Risk | Mitigation |
|---|---|
| 3 h runs exceed the 60 min token TTL | proxy refreshes tokens; the token never enters containers |
| Harbor egress or install fails under no-network | pilot; derived image with Codex pre-installed |
| Long runs → total wall time several days at concurrency 4 | measure in pilot; concurrency 6–8 if CPU allows |
| Compaction / failover mid-session | the router logs them; reported as mid-session decision points |
| Public data uses other model versions | report as reference only |


## 11. Checkpoint record (design §7.5.1 applied)

**Checkpoint applied (0c, 2026-11-05 17:15 UTC, cost figures only; no per-arm outcome looked at).**
- State at the checkpoint: 7 main blocks per runner (112 runs), 0 reruns, 0 excluded; 1 task dropped by the oracle
  check (prometheus-transactional-reload-status), so 112 tasks.
- κ per arm (`fleet.py project`, main pass, 28 runs each): A 0.209, F 0.146, C 1.105, B 0.78.
- Planned passes (main/rep2/rep3) projected Bedrock $2,249.25 (spent $234.72 incl. the pilot); runner hours ≈ $38;
  assessor ≈ $0.5. H = $3,800 − $2,288 ≈ **$1,512**.
- Extensions in order: rep4 + rep3c + rep5 add ≈ $1,315 Bedrock + ≈ $19 runner hours = $1,334 ≤ H, so **all three
  are added in full**, with no cut (block-list sha256 prefixes 601119d55872a290, e20dd41b9921c197, b00727866ecc3fa3:
  match). H left ≈ $178.
- Projected Bedrock per runner with all passes: $960 / $787 / $878 / $939 (max ≤ $1,120 = hard cap − reserve).
  Soft cap raised from $1,000 to $1,100 so that no runner stops admitting blocks while the others have headroom;
  hard cap $1,130 (the four sum to $4,520 ≤ $4,800).

**Pre-rep5 re-check (0d's rule; 0c, 2026-11-06 01:48 UTC, from the merged data of a full fetch).**
- State: main and rep2 finished on every runner; rep3 187/224; rep4 27/226 (runner 1 ahead). Reruns 4 (3 verifier
  infra, 1 harness), 0 excluded, 0 429s.
- κ per arm, main pass / all finished non-pilot passes, and the larger one used: A 0.214 / 0.209 → 0.214;
  F 0.169 / 0.170 → 0.170; C 1.156 / 1.132 → 1.156; B 0.734 / 0.755 → 0.755.
- Bedrock spent $2,221.42 (incl. the pilots); remaining with rep5 in full $1,346.88; runner hours $30 so far +
  about $20 to go; assessor < $1. Total ≈ $3,620 ≤ $3,950, so **rep5 stays in full** (no cut).

**Budget increase and C/F extension (user, 2026-11-06 ≈ 02:10 UTC).**
- The user doubled the budget ($4,000 → **$8,000**, all costs included) and asked that budget control must not
  leave the experiment inconclusive.
- Disclosure: 0c computed interim resolve rates (and mean cost per run) for all four arms on main + rep2 at 01:50
  UTC and showed them to the user, before this decision. The extension rule (equal runs per arm) does not reference
  them; whether the decision would have been the same without them cannot be verified, so C/F reps 4–5 are treated
  as added after an interim look (§7.5.2). No further looks at per-arm outcomes until every pass is final on every
  runner; no further design change except on cost.
- Added: **rep4c** and **rep5c** (C and F, reps 4 and 5, all tasks, stratified order). Design becomes 5 runs per
  task for every arm (A, B, C, F). S7a stays reps 1–3; S7b (drift of reps 4–5 vs 1–3) now covers all four arms.
- Projection with the new passes (κ above): Bedrock ≈ $4,608 total ($1,250 / $976 / $1,128 / $1,254 per runner);
  runner hours ≈ $57; total ≈ $4,670 ≤ $8,000.
- Caps, applied when each runner restarts after rep3c (the driver reads them at start; no drain, no run is
  cancelled): soft **$1,500**, hard **$1,600** per runner (the four sum to $6,400; with runner hours ≤ $8,000).
  Until then the old caps hold, and every runner's projection to the end of rep3c is ≤ $900 < $1,120.
