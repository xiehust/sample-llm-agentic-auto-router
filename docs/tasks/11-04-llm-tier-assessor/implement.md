# Implement plan: @auto-router/assessor

Scope rules:
- Edit only `packages/assessor/**` and this task directory.
- No new dependencies and no commits.
- Bedrock: model invocations only, in ap-northeast-1, with a total of ≤ $2 enforced by a ledger.
- Datasets are untrusted: parse them with JSON only and never execute anything from `data/`.

## Steps

1. [x] **Scaffold**
   - Create `src/contract.ts`, mirroring parent §3 until core exports the hook.
   - Add `.gitignore` entries for `data/*` and `!data/README.md`.
   - Write `data/README.md` with the SWE-bench licence note and the fetch command.
   - Add `package.json` scripts `eval` and `smoke`. Scripts only.
2. [x] **Card** (`card.ts`)
   - Implement the three dialect extractors, `cut()`, sanitization and `isTaskCard`.
   - Tests:
     - bounds of 4,000/1,200/600 chars and 40 tools, with full length recorded;
     - images are counted, not sent;
     - tool-result blocks are not user text;
     - previous-turn tool calls and errors;
     - `</task_card` is defanged;
     - the worst-case card stays under the size bound.
3. [x] **Pack** (`prompts/assessor/v1/*`, `pack.ts`)
   - Write the starter rules and about 9 examples from D §5, then `validatePack`, `renderPrompt` and `packVersion`.
   - Tests:
     - order is instructions → rules → examples → card;
     - rendering is byte-identical across runs;
     - a rule edit changes the version;
     - disabled rules are not rendered;
     - every example validates and maps to its labelled tier.
4. [x] **Schema and validator** (`schema.ts`, `validate.ts`)
   - Tests cover missing, unknown, duplicate and disabled ids; extra keys; enum and bound violations; the 30-word limit; and NaN or out-of-range confidence.
5. [x] **Tier mapping** (`map.ts`)
   - Write one table-driven test per row of design §7, plus the auto-eligibility (`basis` ⊆ auto) cases.
6. [x] **Adapters and transport** (`adapters/*`, `transport.ts`)
   - Golden request bodies for each adapter.
   - Parse tests: valid, refusal, incomplete or truncated output, a missing tool call, and non-JSON text.
7. [x] **Assessor** (`assessor.ts`)
   - Implement precheck → render → call → parse → validate → map → cost, and make sure it never throws.
   - Tests against `fakeTransport`:
     - valid results for Luna (Responses), Luna (Chat) and Haiku (Messages);
     - invalid output → unavailable;
     - timeout at 1.5 s → unavailable, with the abort propagated;
     - a caller abort;
     - HTTP 429/500;
     - observe vs auto (`tier` withheld until the rules are auto);
     - `costUsd` equals `costOf` on the fixture usage.
8. [x] **Live transport and smoke test** (`eval/live-transport.ts`, `eval/cli.ts smoke`)
   - The live transport signs with the router's signer stack (devDependencies `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node`, `@smithy/protocol-http`). No hand-rolled SigV4.
   - Smoke test: ≤ 10 calls each for Luna and Haiku 5.5. This verifies strict json_schema on Responses (falling back to Chat if rejected), forced tool use on Bedrock Messages, usage normalization and latency.
   - Save the scrubbed transcript summary to `research/smoke.md`.
   - Credentials come from env vars exported from the default profile. Before the first call, check that the caller account equals `LLMAR_SPIKE_ACCOUNT` (from `scripts/local.env`); refuse to run when it is unset or different.
9. [x] **Datasets**
   - `fetch swebench`: the datasets-server rows API, field allowlist, count check (500) and the bucket histogram.
   - Write `eval/handlabelled.v1.jsonl` (80 items).
   - Tests: the dataset parser rejects malformed rows; the hand-labelled set is disjoint from the examples.
10. [x] **Eval harness and report** (`eval/harness.ts`, `eval/report.ts`)
    - Implement the budget ledger, concurrency, scrubbing, the confusion matrix, the metrics and the threshold sweep.
    - Unit tests on canned results, including a test that the ledger stops before the cap.
11. [x] **Eval runs**
    - Luna (effort `none`) and Haiku 5.5 on 500 SWE-bench + 80 hand-labelled items, plus Luna `effort:low` on 180 items.
    - Write `research/assessor-eval.{json,md}`: the licence note, both models, fast precision, cost per assessment and the threshold recommendation.
12. [x] **Replay hints** (`eval/hints.ts`)
    - Resample synthetic replay traces' `hints.tier` from the measured confusion matrix.
    - Run replay hint-blind / core-cost on the original and resampled traces, and append the cost effect to the report.
13. [x] **Validation**
    - Run `pnpm -C packages/assessor typecheck && pnpm -C packages/assessor test` and `pnpm -r typecheck`.
    - Run trellis-check.
    - Report the results, the eval summary, the spend, and the interface note for 0d (`card(ctx)`) to 0c.

## Review gates

- Steps 2–7 run with no network.
- Step 8 is the first live call; after it, report the smoke findings, especially any structured-output fallback.
- Step 11 runs only after the ledger test passes.

## Rollback points

- If live calls are blocked by credentials or access, steps 1–7, 9 and 10 still complete with fake transports. Report the gap instead.
- If Bedrock rejects strict schemas on both OpenAI shapes, switch to prompt-only JSON plus the validator, and report it as a finding.
- If core's hook has not landed, `contract.ts` keeps the local mirror, and the switch to the core import is one line.
