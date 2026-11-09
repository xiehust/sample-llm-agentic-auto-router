# Design: Codex × DeepSWE live routing experiment

## 1. What the router can change for Codex (sets expectations)
Codex speaks the Responses API (`wire_api = "responses"`), stateless (`store: false`, no `previous_response_id`),
with encrypted reasoning items in the history. In one `codex exec` session almost every call after the first is a
tool-result turn, which core hard-locks, and the encrypted reasoning is non-portable state. So for Codex the router
decides essentially **once per task, at session start**; possible later points are compaction (cache break) and
failover. The experiment therefore measures:
- the value of the session-start choice (assessor-driven tier: fast / standard / frontier);
- that routing is transparent otherwise (no cache loss, no failures, negligible overhead);
- whether any mid-session decision points occur in practice (compaction, failover), and what the router did.

## 2. Hypotheses and analysis
| # | Hypothesis | Measure | Analysis |
|---|---|---|---|
| H1 | B is cheaper than A | $/task (router-priced usage) | paired per task: median ratio B/A, bootstrap 95% CI |
| H2 | B is not much worse than A | resolve rate | paired difference, exact McNemar on discordant pairs, 95% CI; non-inferiority margin 10 pp (indicative at n=50) |
| H3 | Frontier pays off only on hard tasks | C vs A on 20 tasks | resolve diff, $/solved task, by size stratum |
| H4 | Routing is transparent | cache hit rate, router overhead, errors | B vs A cache hit ≥ A − 2 pp; overhead p50/p99; zero router-caused failures |
| H5 | Assessor tiers hold up on real tasks | per-tier outcomes | for tasks B sent to fast/frontier: resolve and cost vs the same tasks in A (and C) |
Secondary: tokens (input/cached/output) per arm, wall time, turns, patch size, compaction/failover events.
One run per (task, arm): agent variance is not separated from arm effect at n=50; the report says so. If budget
remains after the main run, re-run arm A and B on 10 tasks to estimate within-task variance.

## 3. Arms and routing config
One deployment serves all arms (no redeploys between runs):
- Experiment policy `packages/router/config/policy.experiment.ap-southeast-1.json`: default policy with `mode: auto`,
  Responses pool frontier `gpt-6-astra`, standard `gpt-6.1-sol`, fast `gpt-6-luna`; default tier standard; frontier
  guard (`assessorDowngradeFrom: ['standard']`) unchanged.
- Assessor (R2): mode auto in the experiment deployment, pack v2.1, model `global.openai.gpt-6-luna`, threshold 0.8.
  Pins skip consultation, so arms A and C pay no assessor cost and are unaffected.
- Arm A: header `x-router-hint: pin=global.openai.gpt-6.1-sol`; arm C: `pin=global.openai.gpt-6-astra`; arm B: none.
  All arms send `model: "auto"` so they share the same gateway → router path.
- Every request carries `x-router-session: <run-id>` (allow-listed header) so router logs join to runs.

## 4. Tasks
- Source: `R2E-Gym/R2E-Gym-Subset` (Apache-2.0, 4,578 tasks; the DeepSWE-Preview training set). Fields used:
  `docker_image`, `repo_name`, `commit_hash`, `problem_statement`, `expected_output_json`, `num_non_test_lines`,
  `num_non_test_files`, `parsed_commit_content` (gold patch, validation only).
- Not used for assessor tuning (that used SWE-bench Verified + hand + trajectories), so no leakage.
- Selection (seeded): drop repos whose test run exceeds 10 min in validation; stratify by repo (≤ 8 per repo) and
  change size (`num_non_test_lines` ≤ 10 / 11–40 / > 40, roughly equal); 3 pilot tasks drawn separately.
  Arm C subset: 20 of the 50, stratified by size.
- Validation per task (no model calls): base repo fails the expected statuses; gold patch matches them. Tasks
  failing validation are replaced from the same stratum (seeded).

## 5. Run protocol (per task × arm)
1. `docker run -d` the task image (amd64) with a run-specific name, default bridge network, CPU/mem limits.
2. Move the hidden tests out of the agent's container exactly as R2E-Gym's harness does (verify path/convention in
   the R2E-Gym repo before implementing).
3. Copy a pinned static Codex binary (same version for all runs) into the container; `CODEX_HOME` with a generated
   `config.toml`: custom provider (base_url = gateway inference base, `env_key` = token var, `wire_api = "responses"`,
   arm headers), fixed reasoning effort, approval `never`, sandbox `danger-full-access` (the container is the sandbox),
   fixed `model = "auto"`. Never touch the operator's own ~/.codex.
4. Prompt template, identical for all arms: problem statement + fixed instructions (fix the issue in /testbed with a
   minimal change; do not edit or add tests; you may run existing tests).
5. `timeout 40m codex exec --json --skip-git-repo-check -C /testbed "<prompt>"`; keep the JSONL event stream.
6. Patch = `git diff` of /testbed (test files excluded). Grade in a **fresh** container: apply patch, restore hidden
   tests, run them, parse statuses, compare to `expected_output_json` (R2E-Gym rule).
7. Record per run: resolved, patch stats, wall time, turns, Codex token counts, exit reason (done / timeout / error),
   and join router logs by session: decisions, served models, priced usage, cache read/write, assessor result.
Order: all (task, arm) runs shuffled with a fixed seed; concurrency 4. A fresh Cognito token per run (TTL 60 min,
runs ≤ 40 min), passed by env only, never written to disk or logs.

## 6. Cost control
- Live ledger on the runner: after each run, add its cost from Codex token counts × catalog prices (upper bound,
  cache reads priced as reads); refuse to start a run when spent + worst-case(next) > cap.
- Caps: pilot $10, total $200 (Bedrock + runner hours). Parent reconciles with router-priced usage afterwards.
- Estimates: A ≈ $0.75/task, C ≈ $3.75/task, B depends on tier mix; 50 A + 50 B + 20 C ≈ $120–160 + runner ≈ $15.

## 7. Runner infrastructure (`llmar-runner`, torn down after)
- New VPC (1 public subnet + IGW; no NAT), SG with **no inbound rules**, egress 443/80.
- EC2 x86 (m7i.2xlarge class), AL2023, gp3 300 GB, IMDSv2 required with hop limit 1, SSM Agent; tags Project/Purpose/
  Owner. Instance role: AmazonSSMManagedInstanceCore + read of one secret (the M2M client secret) + nothing else.
- Secret: the gateway's M2M client secret in Secrets Manager (`llmar-runner/client`), created by the parent after
  deploy; the runner mints tokens at the Cognito token endpoint.
- Third-party images (Docker Hub `namanjain12/*`) run arbitrary code: isolated instance, no AWS credentials
  reachable from containers (hop limit 1), nothing else in the VPC.

## 8. Outputs
- `experiments/codex-deepswe/` (committed): harness code, selection ids, configs, report generator.
- `experiments/codex-deepswe/results/` (gitignored): JSONL events, patches, grading logs, ledger.
- Report: `docs/experiments/codex-deepswe.zh-CN.md` (+ data JSON with aggregates and per-task rows by id).

## 9. Risks
| Risk | Mitigation |
|---|---|
| Codex calls endpoints the router does not serve (models list, compaction) | pilot; router already serves GET /v1/models; check logs for 4xx |
| Bedrock Responses rejects Codex request fields | pilot; capture first error bodies (scrubbed) |
| Token expiry in long runs | 40-min run timeout < 60-min token TTL |
| Docker Hub rate limits / image size | pre-pull during validation; 300 GB disk |
| Router regressions under real load | E2E regression first; errors are a reported metric |
| Variance at n=50 | paired design, uncertainty reported, optional repeat subset |

## 10. Revisions after the design review (0d, 2026-11-05) — these override §2–§7 where they differ
- **D1 assessor acts in B.** Pack v2.1 has every rule `auto: false`, so auto mode alone would never move a task.
  The experiment deployment sets an explicit router switch `ROUTER_ASSESSOR_AUTO_RULES=all` (default `pack`): all
  *enabled* rules count as auto-eligible. Packs are not edited. The frontier guard still applies.
- **D2 tier pass before selection.** Capture Codex's real session-start request offline (Codex against a local mock
  Responses endpoint, no AWS), build the same card the router builds, and run the assessor in observe on ~500
  candidate tasks (~$0.30, charged to this experiment's ledger). Then: report the predicted tier mix; stratify the 50
  by predicted tier and oversample fast/frontier predictions; report both the sample estimate and a
  population-weighted estimate (weights from the candidate mix). If almost nothing routes off standard, cut B to the
  off-standard tasks plus ~10 standard ones and spend the remainder on A/B repeats; the report then says so.
  B tasks that stay on Sol are an A-vs-A replicate and give the noise floor.
- **D3 baseline and overhead.** B − A is the assessor's marginal effect with the router present, not router vs no
  router; Sol is the counterfactual because it is the router's default tier (C covers "always frontier"). Add arm
  **D (direct)**: 5 tasks, Codex → bedrock-runtime Responses on Sol with no gateway or router, through the runner's
  host proxy, which SigV4-signs with the instance role (Sol only). Overhead comes from router-side timing.
- **D4 grading.** Primary: SWE-bench style. FAIL_TO_PASS = tests failing on base and passing on gold; PASS_TO_PASS =
  passing on both; resolved when all F2P pass and all P2P still pass; tests failing under both are ignored. Secondary:
  R2E-Gym strict (all expected statuses match). Gold validation runs base and gold 3× each; tasks with unstable
  statuses are dropped.
- **D5 network isolation.** Task containers run on a `--internal` Docker network with no internet. A host-side proxy
  (on the runner, outside the containers) is the only egress: it forwards to the gateway (injecting the bearer token)
  or, for arm D, to bedrock-runtime (SigV4). The token never enters a container; Codex gets a dummy key. The JSONL
  stream is scanned for network commands and the count is reported.
- **D6 Codex settings pinned** in config.toml and recorded from the pilot: context window, auto-compact limit
  (≤ 200k tokens, below the 272k long-context price step), reasoning effort and summary, tool settings. The report
  does not call arm A "Codex as normally used with Sol".
- **D7 H1 estimand.** Primary: ΣB/ΣA total-cost ratio with a paired bootstrap CI over tasks, from router-priced usage
  (includes assessor and retries). Secondary: median and geometric mean of per-task ratios.
- **D8 pre-registration.** H1 and H2 primary, everything else descriptive. n=50 at ~20% discordance gives about
  ±12 pp on the resolve difference: it can rule out a large drop (≥ 15 pp), not show equivalence. C (20) and D (5)
  are descriptive. Stats code, seed and selection are committed before the main run.
- **D9 transparency measured per call:** for call k>1, cached_tokens vs the previous call's prompt length (same
  model); count and attribute cache-loss events (compaction, failover, switch, unexplained).
- **D10** log first-call cache reads (cross-run sharing). **D11** grade the diff present at timeout; report timeouts,
  turns and tokens at stop; equal CPU/memory limits. **D12** patch = `git add -A && git diff --cached` minus tests
  and build artefacts; rebuild C extensions in grading if touched (follow R2E-Gym). **D13** record the served model
  per call (response `model`), gateway fallback and failover events per arm. **D14** confirm ap-southeast-1 prices
  for Astra/Sol/Luna (Price List) before reconciling. **D15** contamination is a stated limitation (C vs A most).
- Arms now: A 50 (pin Sol), B per D2 (auto + assessor), C 20 (pin Astra), D 5 (direct Sol). Cap unchanged ($200).
- **Selection (final, overrides §4):** ~500 candidates = seeded simple random sample of R2E-Gym-Subset (its
  predicted-tier mix estimates the population). The 50 are stratified by predicted tier with fast/frontier
  oversampled, simple random within tier, ≤ 8 per repo, no size balancing (it would bias the weighted estimate).
  C (20) and D (5) are size-stratified subsets of the 50. Pilot tasks are drawn from outside the 50.
- **Deploy hygiene:** every experiment deploy is built from a clean `git worktree` of a recorded commit; the router
  image is frozen from the pilot to the end of the main run.
- **Codex observations (offline capture, 0.166.0):** no top-level `instructions`; developer[0] base instructions,
  developer[1] permissions/collaboration mode, user `<environment_context>`, then the prompt; fallback model metadata
  for `auto` (same for all arms); `prompt_cache_key` = thread id (unique per run); `client_metadata` present.

## 11. Revision 2 after the tier pass (user decision 2026-11-05: "add a fast arm")
Tier pass on 500 candidates (Luna, v2.1, autoRules all, 1500 ms router deadline), $0.352: untimed 488 standard / 12 no
opinion / **0 fast / 0 frontier**; within the deadline 193 standard / 307 timed out (p50 1532 ms from the dev box).
So arm B would be served by Sol exactly like A. Arms are re-planned (cap unchanged, $200):
| Arm | What | Tasks |
|---|---|---|
| A | pin `global.openai.gpt-6.1-sol` (standard) | 50 |
| F | pin `global.openai.gpt-6-luna` (fast) | 50 (same tasks) |
| C | pin `global.openai.gpt-6-astra` (frontier) | 20 (size-stratified subset) |
| B | `auto` + assessor auto (the full router path) | 10 (subset): live check, assessor overhead, A-vs-A noise floor |
| D | direct bedrock-runtime on Sol (no gateway/router) | 5 (subset) |
Selection: the 50 are a seeded random sample of gold-validated candidates (≤ 8 per repo); tier stratification is moot
(no off-standard predictions), population weights are dropped. Pilot: 3 tasks outside the 50 (A×3, F×3, B×1, C×1, D×1).
Primary questions (pre-registered): (1) F vs A: paired resolve difference and ΣF/ΣA (is fast good enough for repair
tasks, and how often); (2) C vs A on 20: does frontier buy solves, at what $/solve. Descriptive: an ideal per-task
router (cheapest tier that solved the task, among the arms run on it) vs always-Sol vs the assessor's actual choice
(always standard), i.e. the saving or quality an assessor could have captured; B vs A overhead/transparency (n=10);
D vs A router overhead (n=5). Also reported: the assessor deadline finding (Codex-sized cards answer around 1.5 s).

## 12. Revision 3 after the pilot (user decision 2026-11-05: "scale to 200 tasks"), before any main-run data
Pilot (9 runs, 3 tasks): all completed and graded; served models correct (A Sol, F Luna, C Astra, B Sol via the
assessor). Router-priced cost was ~$0.04/Sol run, ~$0.003/Luna run, ~$0.21/Astra run (~80% of prompt tokens were
cache reads; router overhead p50 1–2 ms) — about 15–20× below the planning estimate. Two harness bugs were fixed
(gateway streams unpriced; client close after completion recorded as an error). Sample size is raised before the
main run (power, not results, motivates it):
| Arm | Tasks |
|---|---|
| A pin Sol | 200 |
| F pin Luna | 200 (same) |
| C pin Astra | 60 (size-stratified subset) |
| B auto + assessor | 30 (subset) |
| D direct Sol | 10 (subset) |
| Repeats | A and F ×2 more on 20 tasks (run-to-run noise) |
Selection: seeded SRS of gold-validated candidates from the same 500-candidate pool (repo cap raised so 200 fit;
the cap and its effect are recorded). Hypotheses, estimators and stats code are unchanged; at n=200 and ~20%
discordance the F−A resolve CI is about ±6 pp. Total cap stays $200 (expected ≈ $30–40 + runner).

## 13. Assessor timeout 5000 ms (user decision 2026-11-05, before the main run)
The router assessor timeout is raised from 1500 ms to 5000 ms (experiment deploy `-c assessorTimeoutMs=5000`, core bound
5100 ms; the code default changes to 5000 ms in a separate commit, deployed after the main run so the image stays
frozen). Reason: Codex-sized cards answer at p50 1.53 s / p95 2.06 s / max 2.9 s, so at 1500 ms about 60% of
consultations timed out and fell back to the default tier. Recomputed offline from the 500 tier-pass rows (no new
calls), at 5000 ms all 500 answer in time: 488 standard / 12 no opinion / 0 off standard — the §11 conclusion holds.
Arm B therefore gets a real opinion on every task (still standard → Sol) and pays the full assessor latency once at
session start. The pilot's single B run used 1500 ms (pilot data is not analysed).
