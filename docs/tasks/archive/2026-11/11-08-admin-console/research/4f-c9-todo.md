# C9 docs: open items (4f, updated 2026-11-08 after the live E2E)

Worktree `llmar-console-4f`, branch `console/4f`, fast-forwarded to console/int 6a09a50; changes uncommitted.

## Done
1. README / README.zh-CN verification block: replaced with the two 2026-11-08 runs (client test before identity;
   end to end with identity and the console, ap-southeast-1).
2. infra README console section: keys, defaults and outputs checked against the merged `console-stack.ts`; first
   admin via `-c adminEmail`; teardown lists what CDK's runtime log groups leave behind; new "Deploy notes and
   troubleshooting" (the six live findings, DLQ replay link) and "Verified end to end".
3. Router stack identity inputs: `identityMode`, `cliRedirectPorts`, `codexOauthPort`, `cliRefreshDays`,
   `packsArchive`; `jwks-sync` in the deploy order; full stack order stated.
4. Members without a console: README shows the `llmar configure` block built from router stack outputs.
6. Codex `redirect_port` 52820 (registered on the `cli` client).
8. Router log retention stays 7 days (stack: ONE_WEEK); architecture §11 unchanged, plus the 5-minute state line.
9. `llmar-m2m-token` rename: no other doc uses the old name for service clients (the 11-04 design doc is
   historical).
- Console guide en/zh: first-admin note; decisions screenshot (en and zh), checked: no e-mail, account id, user id
  or token visible, no PNG text metadata.
- Architecture doc: §10 identity deploy parameters, §13.6 end-to-end results.

## Still open
5. `<raw URL of tools/llmar/llmar>` in both READMEs: fill in on the publish branch.
7. Architecture diagram 01 still shows the flow without the console and `x-api-key`.
- Console cost figures are a3's list-price estimates (us-east-1 reference), not checked with the Price List API
  (4f has no AWS access); the infra README says so.
- The Codex long-session config (`gateway_oauth` on `x-api-key`) was not part of the E2E, which ran Codex with
  `auth.command` and a static `x-api-key`. The README claims only what was run.

## Screenshots not used
- `policy.*.png`: shows an unmasked Cognito user id in "by user:…" (config author).
- `overview.*.png`: only a loading spinner.
- `savings.*.png`: clean, but the "Where requests went" table header renders the `term.tier` glossary text (a UI
  bug, reported to 18); tiny amounts round to $0.00 next to a 95.0% rate.

## Release-note text (not in the user guide)

> **Gateway fallback now works for clients that send `x-api-key`.** On a router 5XX, the gateway forwarded the
> client's `x-api-key` to Bedrock, and Bedrock rejects a request that carries both `x-api-key` and `Authorization`
> (400). Claude Code always sends `X-Api-Key` from `apiKeyHelper`, so until now it never got the fallback when the
> router failed. The Bedrock fallback target now has an explicit request-header allowlist without `x-api-key`
> (found in the identity spike, S7).
