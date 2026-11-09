# Assessor pack v2.2: calibrate tier calls on the Harbor outcomes

## Goal
The user asked (2026-11-07) for a new assessor version, built from the findings and records of the two Harbor experiments. Its tier calls should match what the runs actually showed, as closely as possible. The current pack is v2.1.

## What the Harbor runs showed about v2.1
- DeepSWE v1.1: 112 tasks × 4 arms × 5 runs.
- Terminal-Bench 2.1: 84 tasks × 4 arms × 3 runs.
- Frontier calls bought nothing measurable:
  - v2.1 sent about 58–64% of DeepSWE runs and about 34% of TB tasks to Astra;
  - Astra − Sol was −0.2 pp on DeepSWE and +2.8 pp on TB (CI includes 0), at 5–6× the cost;
  - the assessor's selection ability, (C − A | frontier) − (C − A | standard), was +0.4 pp [−5.3, 6.2] on DeepSWE;
  - on the TB frontier stratum, Sol was already at 81%.
- The fast tier was never used: 0 fast calls on both datasets. Yet the held-out ideal router picked Luna on 72–77% of tasks (at 0.47–0.55× Sol's cost, −2.4 to −6.1 pp). On average Luna loses 14–17 pp, so the value is in finding the easy tasks, not in escalating hard ones.
- On DeepSWE, long specs read as frontier (instruction length drove the call); on TB, length didn't (γ = 0.03).
- Live opinions agree with the offline tier pass 80–88% of the time, and with each other run to run at a similar rate.

## Requirements
- A new pack version (v2.2) under `packages/assessor/prompts/assessor/`. v2.1 stays unchanged, so the deployed router and old reports stay reproducible.
- Labels come from the measured outcomes: per task, a target tier derived from the arms' resolve rates and costs. 0d defines the rule, pre-registered before any v2.2 tuning.
- Evaluation is on a pre-registered held-out split. Tasks used to tune the pack are never used to report its score. A cross-dataset check (tune on one benchmark, test on the other) is reported too.
- Report, per dataset and on the held-out set: agreement with the target tier; the simulated quality and cost of "route by v2.2" against pinned Sol / Luna / Astra and against v2.1; and fast-call precision. A wrong fast call costs quality, so it is the error that matters most.
- Live assessor calls (the model judging cards) are cheap, at about $0.03–0.10 per pass of 196 cards. Cap: $5 for this task, on its own ledger.
- N5: no third-party task text in committed files. Task ids, labels and aggregates only.
- The router stays on the default observe config. Deploying v2.2 to the router, or any new live agent run, is a separate decision for the user.

## Acceptance criteria
- [ ] Target-tier rule and split pre-registered (0d) before tuning.
- [ ] v2.2 pack committed with its rationale; v2.1 unchanged.
- [ ] Held-out evaluation report (zh) committed under docs/: agreement, simulated quality/cost against the pins and v2.1, fast precision, cross-dataset result, limits (small n, overfitting risk, offline simulation ≠ live run).
- [ ] Spend ≤ $5, ledger recorded.

## Out of scope
- Router policy or core changes.
- Live Harbor runs with v2.2. That's a possible follow-up, and needs the user's go.
