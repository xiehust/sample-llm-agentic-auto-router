# In-session escalation: start cheap, escalate on struggle signals

## Goal
The user chose this direction on 2026-11-07, after the Harbor runs and the assessor v2.2 result. A tier call made once, at session start, from the card had no detectable selection skill on either benchmark. The alternative is to start every session on a cheaper model (Sol, or Luna) and escalate mid-session only when the session shows signs of struggle, for example:
- repeated test failures;
- repeated tool errors;
- context compactions;
- no progress after many turns.

**This task delivers a design and a budget for the user to review.** No live Harbor run starts until the user approves.

## What the earlier runs already showed
- Astra − Sol is −0.2 pp on DeepSWE and +2.8 pp on TB (CIs include 0), at 5–6× the cost.
- A frontier escalation therefore only pays off if it's aimed at the minority of sessions where Astra actually rescues a Sol failure.
- Luna is −14 to −17 pp on average, but in hindsight it ties Sol on most tasks. A "start on Luna, escalate to Sol" policy is the other candidate.
- Switching models mid-session has costs:
  - OpenAI encrypted reasoning only ports within the same model;
  - the prompt cache is per model;
  - the router has hysteresis and a cap on switches per lineage.

## Requirements
1. **Retrospective signal study (offline, about $0).** Use the existing Harbor data: Codex rollouts, router logs and per-run outcomes for DeepSWE and TB.
   - Do in-session signals observable at turn k separate the sessions where the pinned arm failed but the stronger arm solved the same task?
   - What is the upper bound on resolve gain and cost for a simple escalation rule, by simulation?
   - This gates whether a live run is worth proposing at all.
2. **Mechanism design.**
   - Which signals the router can actually observe per request: card stats such as turnIndex, prevTurnToolCalls/Errors and compactions; anything else.
   - How core/policy would trigger an escalation (a deterministic policy rule, an assessor re-consult, or both).
   - What a switch costs: cache, reasoning portability, hysteresis.
   - Fail-safe behaviour.
   - The code changes needed in core and router, with tests, and nothing deployed.
3. **Experiment design (pre-registered).**
   - Arms: e.g. pinned Sol, Sol→Astra escalation, Luna→Sol escalation, optionally pinned Astra.
   - The benchmark: TB is cheaper per run; DeepSWE is harder.
   - Runs per task, estimands, precision, budget and caps, runner time, and the timeline.
4. Present all of it to the user, with a recommendation, a budget and the go/no-go criteria.

## Constraints
- No AWS writes or deploys without the user's approval. The router stays on the default observe config.
- N5: no third-party task text in committed files.
- Router behaviour for existing configs must stay byte-identical unless the escalation is explicitly enabled.

## Acceptance criteria
- [ ] Retrospective study written up with its simulated upper bound.
- [ ] Mechanism design with the code plan, and the risks of switching.
- [ ] Pre-registered experiment design with budget, caps and the go/no-go rule.
- [ ] User decision recorded.
