# Implementation plan

Owners: 73 = assessor wiring in the router; a3 = runner infra, experiment policy, deploy prep; 4f = experiment
harness and report generator; 0d = independent review + statistics plan. Parent (0c) = every AWS write, deploys,
runs, commits.

## P0 Build (parallel, no AWS writes)
- [ ] 73: router consults the assessor (R2): config (off|observe|auto, model, threshold, pack), card building, Luna
      call via SigV4 on the task role, priced + logged, failure-tolerant, pins skip; tests. Infra env + IAM if needed.
- [ ] a3: `llmar-runner` CDK stack (design §7) with tests/cdk-nag; experiment policy file; deploy context for the
      experiment; Secrets Manager secret wiring for the runner (created by the parent).
- [ ] 4f: `experiments/codex-deepswe/`: task loader + seeded stratified selection; gold validation; container
      orchestration; Codex config/prompt; run + grade; ledger; router-log join; results schema; report generator.
      Read R2E-Gym's harness for the hidden-test and grading conventions first.
- [ ] 0d: statistics plan (design §2) in code for the report generator; review queue.

## P1 Review gate
- [ ] 0d reviews 73's router change and a3's runner stack; 73 or a3 reviews 4f's harness. Fixes, then parent commits.

## P2 Deploy router (parent)
- [ ] Deploy main with the default policy; E0 gate; full E2E; E6 (`-c e2eFault=upstream-503-once:2`, fresh task);
      E5b; E7b (desired 0, then scale to 1). Record results.
- [ ] Redeploy with the experiment policy + assessor auto. Smoke: one `auto` and one pinned Responses call.

## P3 Runner (parent)
- [ ] Create the client secret; deploy `llmar-runner`; verify no inbound, IMDS hop limit, role scope.
- [ ] Gold-validate all selected tasks on the runner (no model calls); commit the selection ids.

## P4 Pilot (cap $10)
- [ ] 3 pilot tasks × A, B; 1 × C. Gate: runs complete, grading correct, router logs join, ledger matches router
      pricing within 10%, no unexplained 4xx/5xx. Fix and repeat pilot only if needed.

## P5 Main run (cap $200 total)
- [ ] 50 × A, 50 × B, 20 × C, shuffled, concurrency 4. Monitor ledger and errors; stop on cap or systemic failure.

## P6 Report and teardown
- [ ] After the main run: commit 0d's `core-gate-fixes` (worktree ../llmar-0d, based on 5f22b71, decide.ts + assessor.test.ts only, reviewed by 73; core 183/183), merge into main, sync-docs (core design step 6, §12, rows #39/#40), redeploy from a clean worktree.
- [ ] Generate data + Chinese report; 0d checks the statistics; commit (N5 grep).
- [ ] Destroy `llmar-runner` and the secret; verify teardown. Router stack stays (user decision). Update STATUS.md.

## Rollback points
- Assessor wiring defaults to off; the default policy deployment is unaffected.
- Runner stack is independent of the router stack.
