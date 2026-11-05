# Implement plan: router-core

Scope: `packages/core/**` only. No root edits, no new dependencies, no AWS calls, no commits.

## Ordered checklist

1. [ ] Gate: parent approves design.md and contract additions C1–C5. If any is declined, apply the
       fallback noted in design §6/§8.
2. [ ] `src/pricing-types.ts`: verbatim §3 pricing types, or a re-export if pricing has landed.
       `src/types.ts`: core contract types incl. the approved additions.
3. [ ] `src/policy.ts`: Policy v1, defaults, `validatePolicy`, `PolicyError`. Add `policy.test.ts`.
4. [ ] `src/hash.ts` and `src/summarize/*`: three dialect extractors, header/session/lineage, hints,
       token estimator. Add `summarize.test.ts` (scenarios 5, 6, 20) and the perf test (22).
5. [ ] `src/cost.ts` and `src/warmth.ts`. Add `cost.test.ts` (scenarios 13, 19).
6. [ ] `src/decide.ts`. Add `decide.test.ts` (scenarios 1–4, 7–12, 14, 15).
7. [ ] `src/record.ts`. Add `record.test.ts` (scenarios 16–18, Responses alias).
8. [ ] `src/engine.ts`, `src/store-memory.ts`, `src/index.ts` exports. Add an end-to-end trace test:
       a multi-turn Claude Code-like session with a sub-agent and compaction, asserting the decision
       sequence.
9. [ ] Run `trellis-check`. Fix issues, then re-run validation.
10. [ ] Report to parent with the validation output summary.

## Validation commands

```bash
pnpm -C packages/core typecheck
pnpm -C packages/core test
CORE_SKIP_PERF=1 pnpm -C packages/core test     # CI-style run
grep -n '"dependencies"' -A3 packages/core/package.json   # only @auto-router/pricing (workspace)
```

## Review gates and rollback

- Gate 1: parent replies "approved" before `task.py start`.
- Gate 2: when pricing exports its types, swap `pricing-types.ts` to a re-export and re-run
  typecheck. A mismatch is a contract drift; raise it with the parent and don't patch it locally.
- Rollback: the package is self-contained. Revert `packages/core/src/**` to the skeleton.
