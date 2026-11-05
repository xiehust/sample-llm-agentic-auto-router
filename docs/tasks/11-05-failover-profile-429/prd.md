# Failover: profile rotation only on 429

## Goal

Same-model profile rotation (`global.` ↔ `<geo>.`) only helps when the failure is a quota throttle: global and geo
profiles have separate TPM/RPM quota allocations, so a 429 on one may succeed on the other. A 5xx / connection
failure / timeout on `global.` (which already routes across all commercial Regions) means the geo profile is very
likely failing too; rotating there just adds a wasted call, a ~10% price premium and a cold cache. On those
statuses go straight to the next step (same-tier sibling, or retain → gateway fallback).

## Requirements

- R1 Policy: `failover.profileRotateOn: number[]`, default `[429]`. Each value is 429 or an integer in 500–599;
  `[]` disables profile rotation. Validation reports bad values like other policy fields.
- R2 Core `decide()` failover step: rotate to another profile of the failed pool entry only when the session's
  `lastFailure.status` is in `profileRotateOn` (legacy state without `lastFailure` keeps rotating). Otherwise skip
  rotation and apply the existing "all profiles exhausted" logic (tool loop: cross-model sibling if portable, else
  retain; otherwise sibling, else retain). The reason says rotation was skipped and why.
- R3 Router in-request retry (one retry before the first byte): only when the upstream status is in
  `profileRotateOn`; a network error / timeout counts as 502.
- R4 Response-chain lock unchanged (no rotation inside a `previous_response_id` chain).
- R5 Docs: router-core design.md step 3, core/router READMEs where they describe failover, architecture doc
  §5.2 / §6.4 (and §12 if relevant).

## Acceptance Criteria

- [x] 429 still rotates global → geo (core and router), including the wrap-around back to `global.`.
- [x] 503 / 500 / 502-network do not rotate by default: core goes to the sibling / retain path; router does not retry.
- [x] `profileRotateOn: [429, 503]` restores rotation on 503.
- [x] Invalid `profileRotateOn` values are rejected by `validatePolicy`.
- [x] `npm test` (core, router) and typecheck pass.

## Notes

- Out of scope: gateway fallback rules, E2E harness (E6 uses router-503 fault → gateway fallback, unaffected).
- No commit from this session; the main session commits.
