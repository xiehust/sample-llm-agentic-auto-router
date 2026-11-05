# Implement plan: parent (integration)

## Ownership and parallelism

| Child | Owner session | Can start | Notes |
|---|---|---|---|
| gateway-frontdoor-spike | sample-llm-agentic-auto-router-0c (parent) | now | creates AWS resources in ap-northeast-1; parent keeps account authority |
| router-core | sample-llm-agentic-auto-router-0d | after workspace bootstrap | depends on pricing types only |
| pricing-usage | sample-llm-agentic-auto-router-a3 | after workspace bootstrap | may read Bedrock pricing APIs (read-only) |
| replay-evaluator | sample-llm-agentic-auto-router-73 | after workspace bootstrap | codes against the §3 contracts; integrates real core/pricing when they land |
| router-dataplane-mvp | sample-llm-agentic-auto-router-a3 (AWS writes by parent) | approved 2026-11-04 | V9 script first, executed by parent |
| llm-tier-assessor | sample-llm-agentic-auto-router-73 | after its design review | core hook by 0d |

## Steps

1. [x] Create task tree, PRD, design contracts, copy research.
2. [x] Bootstrap pnpm workspace (root package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest);
       install dev deps once; verify `pnpm -r test` runs on an empty package.
3. [x] Write child PRDs; dispatch peers with: task dir, contracts, conventions, review gate rule.
4. [x] Peers draft `design.md` + `implement.md` for their child; parent reviews; peer runs
       `task.py start` only after the parent replies "approved".
5. [x] Spike: plan → start → execute V0–V8 → findings → teardown → archive.
6. [ ] Integrate: core + pricing + replay build and test together (`pnpm -r build && pnpm -r test`).
7. [ ] Revise data-plane MVP plan with spike findings; review with the user before starting it.
8. [ ] Commit per child after its check passes (first commit c47ac5e: workspace, pricing, spike).

## Validation

- `pnpm -r typecheck && pnpm -r test` green at every integration point.
- Contract drift check: replay compiles against the real core/pricing exports, not local copies.

## Review gates

- Contract change → parent approval before code.
- Any AWS write (create/update/delete) → only from the parent session, tagged, with teardown recorded.
