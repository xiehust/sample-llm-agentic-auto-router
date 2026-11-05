# Implement plan: @auto-router/pricing

Only `packages/pricing/**` and this task directory are edited. No new dependencies. No commits.

## Steps

1. [ ] **Types and errors.** `src/types.ts` holds the §3 contract, copied verbatim, plus the optional fields from design §6. `src/errors.ts` holds the error classes.
2. [ ] **Catalog data.**
   - Write the snapshots to `data/snapshots/`: the Tokyo price-list rows, ListInferenceProfiles and ListFoundationModels (model and profile ids only).
   - Write `data/catalog.ap-northeast-1.json` with the 25 models.
   - Fill in context windows from the model cards, flagging any that are still unknown.
3. [ ] **Generator.** `scripts/gen-catalog.ts` turns the JSON into `src/catalog.data.ts`. Run it once.
4. [ ] **Loader.** `src/catalog.ts` holds `loadCatalog()`, `findModel()` and validation.
5. [ ] **Usage.** `src/usage.ts` holds `normalizeUsage()` and `createStreamUsageAccumulator()`. `src/sse.ts` holds `parseSse()`.
6. [ ] **Cost.** `src/cost.ts` holds `costOf()`.
7. [ ] **Fixtures.**
   - Verify the account with sts.
   - Run `scripts/capture-fixtures.mjs`: 13 calls in ap-northeast-1, spend under $0.01. Log the token counts.
   - Scrub the output and store it under `src/__fixtures__/`.
8. [ ] **Tests** (vitest, next to the sources):
   - `catalog.test.ts`: validation, JSON and generated module in sync, every modelId present in the snapshot lists (offline), every Claude/GPT/Kimi entry has a price source, the Sonnet 5.5 read price is 0.10.
   - `usage.test.ts`: fixtures for 3 dialects × {non-stream, stream} × {write, read}, the Messages 1h split, synthetic edge cases (missing usage, nulls, inconsistent counters, malformed SSE).
   - `cost.test.ts`: hand calculations, including Haiku 5.5 at 150K (long tier), Haiku at exactly 100,000 (base tier), GPT-6.1 Sol at 300K (long tier), a mixed 5m/1h write, a TTL fallback, and an unknown TTL that throws.
   - `fixtures.test.ts`: no 12-digit numbers or request ids left in the fixtures.
9. [ ] **Exports.** `src/index.ts` re-exports everything. Add a short `README.md` in the package covering the catalog update procedure.
10. [ ] **Validation.** `pnpm -C packages/pricing typecheck && pnpm -C packages/pricing test`, plus `pnpm -r typecheck` to confirm core and replay still compile against the exports.
11. [ ] **Quality check.** Run trellis-check, then report to the parent session.

## Rollback points
- Data (steps 2–3) and code (steps 4–6) are independent. If a fixture capture fails, the code still ships with synthetic tests, and the gap is reported to the parent.

## AWS spend / safety
- Read-only list and pricing calls. Model invocations happen only in step 7.
- Calls go through the default-profile role after the account check. No resources are created.
