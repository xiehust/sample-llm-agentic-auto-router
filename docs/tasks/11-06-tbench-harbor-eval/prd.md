# Terminal-Bench 2.1 × Codex via Harbor: routing experiment

## Goal
The same question as the DeepSWE run (`11-05-deepswe-harbor-eval`), on a second, different benchmark: does the
router's `auto` + assessor mode give the best quality/cost trade-off against always pinning Sol (standard), Luna
(fast) or Astra (frontier)? Terminal-Bench tasks are terminal and system work (builds, sysadmin, security, data,
science), shorter than DeepSWE's, and they need the internet.

## User decisions (2026-11-06)
- Dataset: **Terminal-Bench 2.1** (`harbor-framework/terminal-bench-2-1`, Apache-2.0), pinned to commit
  `12b7565679ce5006230b…353673a133db93` (2026-11-05). The user asked for 100 random tasks, but the release has
  only 89, so **all 89 tasks** are used. With every task included, nothing is sampled.
- Harness: **Harbor**, as for DeepSWE. Reuse the DeepSWE integration: proxy, driver, fleet, classify, harvest and
  report. Don't build a second harness.
- Agent: Codex, reasoning effort **high**.
- Arms: A pin Sol, F pin Luna, C pin Astra, B `auto` + assessor (the deployed router config), **3 runs per task in
  every arm** (4 × 3 × 89 = 1,068 runs).
- Budget: **$4,000 total** (Bedrock, the assessor and runner hours). This is separate from DeepSWE's $8,000.
- Network: **outbound internet for task containers, with guardrails.** All 89 tasks set `allow_internet = true`
  (pip/apt installs, model and data downloads), so DeepSWE's offline isolation can't be used. Guardrails:
  - no EC2 instance metadata;
  - no VPC or other private ranges;
  - the host is reachable only on the proxy port;
  - no traffic between containers;
  - no inbound.
  The gateway token stays on the host proxy and never enters a container.
- Residual egress risks **accepted explicitly by the user (2026-11-06)**, after the guardrails above (TCP 80/443 to
  public IPv4 plus the VPC resolver only; design §9.5):
  - (b) code in a container could open a reverse tunnel over 443 and let an outside party drive the agent and the
    proxy; this is bounded by the per-runner hard cap ($900, fail-closed) and detected from the command and
    connection logs;
  - (c) the traffic leaves from the account's public IPs, so abuse would be attributed to the account.
- Arms run 3 times, **fixed**: the user declined a cost-only headroom extension (2026-11-06), even if budget is left over.
- Runners: the same 4 runners (x86, 8 vCPU / 64 GB, ap-southeast-1). This run starts **right after the DeepSWE run's
  final fetch**, after changing only the network rules (no redeploy). Sharded by task, as before.
- Work in parallel with the project's peer Claude sessions. The parent session (0c) does all AWS writes, deploys,
  runs and commits.

## Steps
1. **Offline tier pass (gate, about $0.10).** The assessor judges all 89 tasks from a Codex-shaped session-start
   request. If almost nothing routes off standard, report to the user before the live run (B would equal Sol).
2. **Isolation and pilot** on the changed network rules: the guardrails above, verified from inside a task
   container, then a small pilot that prices runs (κ) and checks the joins, as for DeepSWE.
3. **Live run through Harbor**: 4 arms × 3 runs × 89 tasks, cost-capped per runner.
4. **Report** (zh): the same comparisons as the DeepSWE report (resolve rate and cost per arm on the same tasks, B
   against A/F/C, an ideal per-task router, the assessor's choices against outcomes). Also a side-by-side with the
   DeepSWE result, and the public Terminal-Bench leaderboard as a reference only.

## Acceptance criteria
- [ ] Tier pass results reported (step 1), with caveats.
- [ ] Every task passes Harbor's oracle check on the changed network before the live run. Failing tasks are dropped
      by a pre-registered rule and reported.
- [ ] All live runs graded by Harbor's verifier. Infrastructure errors are retried or excluded by a pre-registered
      rule.
- [ ] Network guardrails verified from inside a task container on every runner: metadata, VPC, host ports other
      than the proxy, and other containers are unreachable; the internet is reachable; nothing is inbound.
- [ ] Solution lookup checked: the solutions are public, and agents have the internet. Each run's commands are
      scanned for access to the benchmark's repositories or solution files, and a pre-registered rule decides how
      flagged runs are reported.
- [ ] Spend stays ≤ $4,000. The proxy enforces the per-runner caps and fails closed.
- [ ] No token, account id or third-party task text in committed files (N5).
- [ ] The runner and its secret are torn down and verified after this run. The router stack stays up.
- [ ] Report committed: `docs/experiments/tbench-harbor.zh-CN.md`.

## Constraints
- **The DeepSWE run is live until about 12:00 UTC on 2026-11-06.** Nothing in `experiments/deepswe-harbor/` on
  `main` changes until its final fetch. TB code lives on the branch `tb21-harbor` (worktree
  `<workspace>/llmar-tb21`) and merges after DeepSWE's final fetch. Nobody runs `fleet.py pack`
  or `ship` in the main tree.
- Runner infra changes go through 0c. While DeepSWE runs, nothing changes on the runners.

## Out of scope
- Changing the assessor pack or router policy during the experiment.
- A 100-task set built from other datasets.
- Terminal-Bench 2.0 numbers, except as a public reference.
