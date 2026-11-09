# DeepSWE v1.1 × Codex via Harbor: routing experiment

## Goal
Find out whether the router's `auto` + assessor mode gives the best quality/cost trade-off against always pinning
Sol (standard), Luna (fast) or Astra (frontier) on hard, long-horizon tasks. Context: the R2E-Gym experiment
(report withdrawn 2026-11-07: its tasks were too easy to be useful) could not answer this, because those tasks were easy (Astra = Sol) and the
assessor said standard every time.

## User decisions (2026-11-05)
- Dataset: **DeepSWE v1.1** (Datacurve, `datacurve-ai/deep-swe`, Apache-2.0), all 113 tasks.
- Harness: **Harbor** (`harbor-framework/harbor`). Do not rebuild what Harbor provides: task loading, environments,
  agent install and run, separate verifier, results.
- Agent: Codex, reasoning effort **high**.
- Budget: **$8,000 total** (Bedrock, the assessor and runner hours), doubled by the user on 2026-11-06 so that budget
  control does not leave the experiment inconclusive. Earlier: $2,000 → $3,000 → $4,000 + 20% buffer ($4,800
  ceiling, $1,200 per runner) on 2026-11-05.
- Runners: **4 identical** x86 instances, **8 vCPU / 64 GB** each, in ap-southeast-1. Sharded by task: each runs all
  arms on its shard (user agreed 2026-11-05). Each stops when its shard is done; all are torn down after.
- Keep the **host-side proxy**: the gateway token stays on the host and never enters a task container.
- Work in parallel with the project's peer Claude sessions. The parent session (0c) does all AWS writes, deploys,
  runs and commits.

## Steps
1. **Offline tier pass (gate, about $0.10).** The assessor judges all 113 tasks from a Codex-shaped session-start
   request. Simulate `auto` + assessor using the public per-task trial outcomes. If almost nothing routes off
   standard, report to the user before the live run (B would equal Sol).
2. **Live run through Harbor.** Arms: A pin Sol, F pin Luna, C pin Astra, B `auto` + assessor (the deployed
   router config), 113 tasks each. Repeats only if the budget and the stats plan call for them.
3. **Report** (zh): resolve rate and cost per arm on the same tasks, paired comparisons of B against A, F and C,
   an ideal per-task router, the assessor's tier choices against outcomes, router transparency (cache, overhead,
   failovers), and comparison with the public mini-swe-agent results (as a reference only).

## Acceptance criteria
- [ ] Tier pass results and the simulated B against A/F/C reported (step 1), with its caveats (public data used
      gpt-5.6 Sol/Luna and mini-swe-agent; we run gpt-6.1 Sol, gpt-6 Luna and gpt-6 Astra with Codex).
- [ ] All live runs graded by Harbor's verifier. Errors are classified as infrastructure or agent, and
      infrastructure errors are retried or excluded by a pre-registered rule.
- [ ] Spend stays ≤ the $8,000 ceiling (per-runner hard caps sum to $6,400 + runner hours). The proxy enforces the cap and fails closed.
- [ ] No token, account id or third-party task text in committed files (N5); no inbound to the runner; task
      containers reach only the host proxy; the verifier has no network.
- [ ] The runner and its secret are torn down and verified. The router stack stays up.
- [ ] Report committed: `docs/experiments/deepswe-harbor.zh-CN.md`.

## Out of scope
- Changing the assessor pack or router policy during the experiment (any change is a follow-up).
- Modal or other cloud sandboxes; Pier.
