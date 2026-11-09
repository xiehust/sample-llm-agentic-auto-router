# Codex × DeepSWE (R2E-Gym) live routing experiment

## Goal
Measure what the router actually does for a real coding agent: run OpenAI Codex CLI through AgentCore Gateway →
router → Bedrock on real repository-repair tasks from the DeepSWE training set (R2E-Gym-Subset), and report solve
rate, cost, caching and routing behaviour against fixed-model baselines.

## User decisions (2026-11-05)
- Deploy the router stack to ap-southeast-1 and **leave it deployed** afterwards.
- Wire the tier assessor into the router first, so the auto arm makes assessor-driven choices.
- Run the agents on an **x86 EC2 runner in ap-southeast-1** (R2E-Gym images are amd64; the dev box is aarch64).
  The runner is torn down after the experiment; the router stack stays.
- **3 arms**, **50 tasks**, spend cap **$200** (Bedrock via the gateway + runner).

## Requirements
- R1 Deploy: stack up in ap-southeast-1 from the current main; E0 gate, full E2E regression, plus the open checks
  E6 (`upstream-503-once:2`), E5b (`auto:*` aliases) and E7b (circuit-breaker timing). Stack stays up.
- R2 Assessor in the router: the router consults the v2.1 assessor (GPT-6 Luna) at consult points (session start,
  user-text turns) and passes the opinion to core's decide. Modes off | observe | auto via config; pins skip it.
  Assessor calls are priced and logged; assessor failure never fails the request. Independent review (0d) before deploy.
- R3 Arms (same tasks, same prompt, same Codex version/config except routing):
  - A: pin standard `global.openai.gpt-6.1-sol` (the default tier, i.e. "no router").
  - B: `auto` with the assessor in auto mode.
  - C: pin frontier `global.openai.gpt-6-astra`, on a stratified 20-task subset (quality ceiling).
- R4 Tasks: 50 tasks sampled from R2E-Gym-Subset, stratified by repository and change size, fixed seed; 3 separate
  pilot tasks not in the 50. Every selected task is validated without model calls: the gold patch resolves it and the
  unmodified repo does not. Task ids are recorded; no dataset text is committed.
- R5 Grading: hidden tests are not visible to the agent; a run is resolved when the hidden tests' statuses match the
  task's expected output (R2E-Gym criterion), graded in a fresh container.
- R6 Budget: a ledger stops scheduling at the cap. Pilot cap $10 (gate before the main run). Total cap $200.
- R7 Report (Chinese, publishable): per-arm solve rate, $/task, $/solved task, cache hit rate, router decisions
  and assessor tiers, latency/overhead, errors (router, gateway fallback, Bedrock), paired comparisons with
  uncertainty, limitations. Per-task table with ids only. Raw results stay gitignored.
- R8 Safety: runner has no inbound ports (SSM only), IMDSv2 with hop limit 1 (containers cannot reach instance
  credentials), least-privilege role, tagged `llmar-*`, verified teardown. Tokens are short-lived (60 min), never
  logged; the experiment never changes non-llmar resources. N5 rules apply to everything committed.

## Acceptance criteria
- [ ] Router stack deployed; E0 + regression + E6/E5b/E7b results recorded; stack left running.
- [ ] Assessor wiring merged after review, with tests; live observe/auto verified in the pilot.
- [ ] 50 + 3 tasks selected and gold-validated; selection list (ids) committed.
- [ ] Pilot within $10 with end-to-end grading proven; main run completed within $200 (or stopped by the ledger,
      with the stop reported).
- [ ] Report committed under docs/ with the per-task table and analysis; runner torn down and verified.

## Out of scope
- Tuning prompts or policy on the 50 main tasks (pilot tasks only). Changing the Codex agent itself.
- Anthropic-dialect agents (Codex speaks the Responses API only).
