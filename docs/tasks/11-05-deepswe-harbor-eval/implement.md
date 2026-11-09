# Implementation plan

Owners:
- 73: step 1 tier pass and the B simulation.
- 4f: Harbor integration, host proxy and report.
- a3: runner infra.
- 0d: review and statistics plan.
- Parent (0c): every AWS write, deploys, runs and commits.

New code lives in `experiments/deepswe-harbor/`. Shared modules are imported from `experiments/codex-deepswe/`
where possible; if one must be duplicated, say so.

## P0 Research and build (parallel, no AWS writes; 73's Bedrock calls ≤ $0.50, approved by 0c)
- [ ] 73: tier pass on the 113 tasks plus the simulation (design §3). Results go to
      `experiments/deepswe-harbor/results/tierpass/` (gitignored). Write a short summary for 0c.
- [ ] 4f: Harbor integration and the proxy changes (design §4–5). Get a local dry run working on the dev box with a
      mock Responses endpoint and one small task (arm64 dev box: use a task whose image has an arm64 variant, or
      run under emulation; otherwise run the dry run on the runner in P2).
- [ ] a3: runner stack parameters, disk sizing, and a firewall compatible with Harbor (design §6); cdk-nag and tests.
- [ ] 0d: statistics plan and budget split (design §7, with runner as a stratum); review of design.md.
- [ ] 17: multi-runner orchestration (design §9): shard plan, per-runner driver and caps, fetch/merge, monitoring,
      the oracle check through Harbor's oracle agent.
- [ ] 18: independent security review (builder-security) of the proxy, runner firewall, egress sidecar and token
      handling; an isolation test suite the parent runs on each runner before the pilot (design §10).

## P1 Review gate
- [ ] 0d reviews 4f's integration and a3's stack; 73 or a3 reviews 4f's proxy changes. Fixes, then the parent commits.
- [ ] Step 1 gate result shown to the user (if fewer than 5% of tasks are off standard).

## P2 Runner (parent)
- [ ] Create the client secret; deploy 4 runners (8 vCPU / 64 GB each) from a clean worktree; verify no inbound,
      IMDS hop limit, role scope.
      Flags: `-c runnerCount=4 -c runnerInstanceType=r7i.2xlarge -c runnerVolumeGb=250 -c runnerSwapGb=32
      -c runnerDirectModel=none -c runnerAmiId=<resolved AL2023 x86_64 id>` (the AMI pin stops a redeploy from replacing
      the instances mid-run). Run 18's isolation suite on every runner before the pilot.
- [ ] Pre-pull the images; run the oracle check (apply `solution/`, verify it passes) for all 113 tasks — no model
      calls. Drop or flag tasks that fail.

## P3 Pilot (cap $40)
- [ ] 3 tasks × A/F/C/B. Gate: runs complete, the verifier grades, router logs join, the proxy ledger matches router
      pricing within 10%, token refresh works on a run longer than 60 min (or is forced), egress is denied except
      the proxy.

## P4 Main run (plan $4,000; hard ceiling $4,800 = $1,200 per runner)
- [ ] 113 × A/F/C/B, shuffled, at the measured concurrency. Monitor the ledger and errors.
- [ ] Repeats per 0d's plan if the budget allows.

## P5 Report and teardown
- [ ] Report generated (zh); 0d checks the statistics; commit (N5 grep).
- [ ] Fetch results, then empty the results bucket (`aws s3 rm --recursive`), then destroy `llmar-runner` and the
      secret; verify the teardown. Update STATUS.md.

## Rollback points
- The runner stack is independent of the router stack; the router config is unchanged.
- The proxy cap fails closed.
