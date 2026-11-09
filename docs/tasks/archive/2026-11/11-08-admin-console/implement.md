# Admin console: implementation plan (0c)

Owners and order: design §3. Peers implement in their own git worktrees (no commits); 0c merges per child after
review, commits, deploys. Every child: tests green (`pnpm -r typecheck && pnpm -r test`), N5 grep + leakscan
`--strict`, `scripts/sync-docs.sh` before doc commits.

## Phase 0 — review gate (user)
- [x] User reviews prd.md + design.md v1 and approves spike C1 (approved 2026-11-08) (separate `llmar-idspike` stack, < $1, ~2 h,
      verified teardown).

## Phase 1 — spike and foundations (parallel)
- [x] (2026-11-08, teardown verified) C1 a3 builds `spikes/identity-hop`; 0d reviews; 0c deploys, runs S0 → S1 → S2 → S4 (one browser login by
      the user or 0c) → S7, tears down, verifies empty listing. Results → `research/c1-spike-results.md`.
      S2 adds a `Bearer `-prefixed `x-api-key` case (Codex header delivery). **Gate:** S0 any 2xx → stop. S1/S2 outcome selects the header path (design 0.1 / a3 §1.3) and Codex
      long-session config (0.13).
- [x] C3 0d core (snapshot semantics, observe hold, projected, switchedFrom, policySwapEffects, access caps,
      `./policy` export, parseReason) + router generation holder, S3 poll, universe fix, config lines; a3 reviews.
- [x] C4 73 on top of C3's generation holder (rebase when C3 lands).
- [x] C5 17 against 0d fixtures (exact figures) and a3 table design; local DynamoDB-free unit tests (fake client).
- [x] C7 18 scaffold + pages against a mock API (contract design §2.4), 4f copy; Playwright on 127.0.0.1.
- [x] C8 17 `llmar` CLI with a fake IdP on loopback.

## Phase 2 — identity and console backend (after C1)
- [x] C2 a3 router identity + RouterStack changes; 0d reviews (the `x-api-key` mapping is security-relevant).
- [x] C6 73 handlers + a3 ConsoleStack; 0d reviews authz paths and IAM.
- [x] Contract freeze check: config doc (§2.1), log fields (§2.2), tables (§2.3), API (§2.4) identical across C2–C8.

## Phase 3 — deploy and E2E (0c, real stack, ap-southeast-1)
- [x] Clean worktree of the merged HEAD; `cdk diff` reviewed; deploy RouterStack (identity `observe`), verify E0
      7/7 and anonymous 401/403 unchanged.
- [x] Deploy ConsoleStack with `-c consoleBundle=false -c ingest=false` (no BucketDeployment, no subscription):
      every `/api/*` anonymous → 401 (CloudFront and raw execute-api), valid console token via CloudFront → 200,
      S3 direct → 403; then redeploy with `consoleBundle=true`; then `ingest=true`.
- [x] E2E: admin creates member → member signs in (TOTP) → `llmar login` → Claude Code + Codex calls attributed
      (records, usage, savings fixture reconciliation) → config edit activates ≤ 1 min, rollback → identity
      `require` → disable → 403 ≤ 35 s → budget hard stop → 429 → member isolation tests → zh/en pages.
- [x] Spend ledger (Bedrock ≤ $5 for E2E unless the user raises it).

## Phase 4 — docs and finish
- [ ] C9 4f: README / README.zh-CN "Connecting clients" (member login path), console guide en/zh, infra README
      (deploy, cost, teardown); architecture doc update.
- [ ] Spec update, journal, archive children.

## Rollback points
- RouterStack identity mode back to `off` (config document, no deploy) or redeploy previous image.
- ConsoleStack destroy is independent of RouterStack (SSM values only, no exports).

## Live record (2026-11-08, 0c)
- RouterStack: first deploy rolled back (gateway target discovery hit the old image, source ARN absent); recovered
  with continue-update-rollback (user-approved), fixed (targets DependsOn service; discovery pinned to absent or
  exact gateway ARN). Final router image: 090f8ef (state line every 5 min).
- ConsoleStack: first create failed (Cognito: ALLOW_REFRESH_TOKEN_AUTH with rotation), empty stack deleted
  (user-approved), recreated; phases bundle-off/ingest-off -> bundle -> ingest. Fixes found live: config.json SPA
  schema (contract test), usage-ingest parameter properties under Node type stripping (node-strip-check),
  effective config from config/baked.json, require gated on fresh router state lines. DLQ replayed (user-approved).
- E2E (int 6a09a50): r, c1, c2, c3, id all pass; browser spec 11/11 with isolation required; cleanup done (test
  users deleted). Router-measured spend $0.0057.
- Host: low memory from 2,180 leaked runner-netns test fixtures (killed; harness fixed 7d66995).
