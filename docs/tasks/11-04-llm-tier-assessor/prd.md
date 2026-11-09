# LLM tier assessor: few-shot + rules on a lite model

## Goal

`packages/assessor` (`@auto-router/assessor`): judge which tier (fast / standard / frontier) a task needs from a
bounded task card, using team-written rules and few-shot examples on a cheap model. The assessor supplies
intent only; `@auto-router/core` keeps deciding *when* a switch is worth it. Design basis:
`../11-04-llm-auto-router/research/D-llm-tier-assessor.md` (modelled on dsh-superagent's assessment).

User decisions (2026-11-04): the default assessor model is **GPT-6 Luna** (`global.openai.gpt-6-luna`); other lite
models must be supported, at least **Claude Haiku 5.5** (`global.anthropic.claude-haiku-5-5`), and the model is
configuration, not code.

## Requirements

- R1 Card builder: from a `RequestSummary` plus the request body, build the bounded card of design D §3
  (latest user text ≤ 4,000 chars, first user text ≤ 1,200, role/template label or system head ≤ 600, tool names
  ≤ 40, lineage kind, stats, current tier). Never the full transcript; images listed, not sent. Card fields are
  treated as untrusted data in the prompt.
- R2 Prompt pack, versioned (`prompts/assessor/v1/`): instructions, rules `{id, tier, instruction}`, few-shot
  examples, rendered in a stable order (instructions → rules → examples → card last) so the prefix is cacheable.
- R3 Model adapters behind one interface, chosen by configuration:
  - OpenAI shape (Luna and other GPT/Kimi lite models): Responses or Chat Completions with a strict JSON schema.
  - Anthropic shape (Haiku 5.5 and other Claude lite models): Messages with one forced tool whose input schema is
    the output contract.
  - Transport is injected (the data plane provides SigV4 HTTP to bedrock-runtime); tests use a fake transport.
- R4 Output contract (design D §4): `rule_assessments` with exactly one entry per enabled rule, `task_facts`,
  `confidence`, `reason ≤ 30 words`. Strict validation (unknown/missing/duplicate rule ids, enums, bounds).
- R5 Deterministic tier mapping: a pure function from validated facts + matched rules → tier or "no opinion";
  confidence threshold (default 0.8); conflicts → no opinion.
- R6 Failure handling: invalid output, timeout (default 5 s; 1.5 s until 2026-11-05) or transport error → `unavailable` (never an
  exception into the request path); caller keeps the current or default tier.
- R7 Integration contract for core: an optional `assessor` in `createEngine` options, consulted by `desiredTier`
  after hint/alias/deterministic rules and before the pool default, only at session start, sub-agent start and
  user turns; result cached per (lineage, user turn); decision records carry the assessment audit (version,
  model, rule judgements, facts, confidence, latency, cost). Core changes are made by the router-core owner.
- R8 Observe mode: the assessor can run and record without affecting the tier (default), then be enabled per rule.
- R9 Offline evaluation harness:
  - Datasets: SWE-bench Verified problem statements with their human difficulty buckets (licence checked and
    recorded before use; data treated as untrusted, parsed only) mapped to tiers, plus 50–100 hand-labelled
    exploration / mechanical / deep-investigation tasks for coverage of the fast and frontier tiers.
  - Runs every configured model (at least Luna and Haiku 5.5) and reports confusion matrix, fast-tier precision,
    frontier recall, "no opinion" rate, p50/p95 latency and cost per assessment.
  - Exports assessed tiers as `hints.tier` for replay (synthetic traces) to estimate the cost effect.

## Acceptance Criteria

- [ ] Unit tests: card bounds and truncation, prompt rendering order and determinism, both adapters against a fake
      transport (valid, invalid, timeout), validator edge cases, tier mapping table, observe vs auto behaviour.
- [ ] Live smoke test in ap-northeast-1 for Luna and Haiku 5.5 (≤ 10 calls each).
- [ ] Offline eval report (both models) saved under this task's `research/`, with the dataset licence noted.
- [ ] Fast-tier precision and the measured cost per assessment reported; recommendation on default threshold.
- [ ] `pnpm -C packages/assessor typecheck && pnpm -C packages/assessor test` green; no runtime dependencies
      beyond workspace packages.

## Constraints

- Bedrock usage for the live smoke test and offline eval: model invocations only, in ap-northeast-1, total
  spend ≤ USD 2; no resource creation. Account ids and request ids scrubbed from saved outputs.
- Edit only `packages/assessor/**` and this task directory; core and data-plane hooks go through their owners.
- No commits from child sessions.
