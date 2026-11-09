# C1 identity spike: results (0c, 2026-11-08)

Harness: `spikes/identity-hop` at 3e335cf (a3; reviewed 0d), run by 0c in ap-southeast-1 as stack `llmar-idspike`
(scope-only CUSTOM_JWT gateway → private REST API → NLB → Fargate stub; Cognito pool with managed login v2).
Raw results: `spikes/identity-hop/results/*.json` in the run worktree (gitignored; digests, lengths, statuses only).
S4's two browser sign-ins were done with headless Chromium on the dev box (user-approved automation); the password
stayed in a 0600 file outside the repo. Bedrock spend: 4 calls, `max_tokens: 1`, global Haiku 5.5.

| Check | Result |
|---|---|
| gate | PASS (11/11): unsigned/other-role/direct-TCP/outside-VPC denied; anonymous, junk bearer, wrong scope denied at the gateway; a valid token passes the authorizer; no 2xx anywhere before the target existed. |
| S1 forward | `x-api-key` accepted in the target allowlist; forwarded **unchanged** on Messages/Chat/Responses, stream and non-stream; the REST mapping copy (`x-router-identity`) is identical. A 4,200-byte value still arrived (the documented 4 KB value rule was not enforced; the router caps at 4,096). The stub never sees an `Authorization` header (the REST hop consumes the gateway's SigV4 one). |
| S2 precedence | The gateway authenticates **only `Authorization`**. `x-api-key` is never used as the credential (valid key alone → 401) and is forwarded whatever it holds: junk, another valid token, a `Bearer `-prefixed value (as sent), an expired token. Expired `Authorization` + valid key → 403. ⇒ the router must verify `x-api-key` itself (design 0.1, as built in C2); Codex needs a refreshing `Authorization` **and** `x-api-key` (no single-sign-in option). |
| S4 user tokens | Auth code + PKCE via managed login v2 on a `127.0.0.1` callback: access token has `token_use=access`, `client_id`=cli, the invoke scope, `username`, no `aud` (1,062 bytes); passes the gateway; forwarded unchanged; ID token refused; `openid`-only token refused; a refreshed token keeps the scope and passes. |
| S7 rules | Catch-all (priority 1,000,000 → router) routes concrete Bedrock ids and unknown models to the router; priority is lower-number-first; the `id-*` rule with a 5XX fallback still matches first. |
| S7 fallback | **Finding:** with `x-api-key` in the request, the 5XX fallback to the `bedrock-runtime` connector target fails with 400 "Cannot provide both x-api-key and Authorization headers" (the gateway forwards the client's `x-api-key` to Bedrock when the target has no header allowlist). Without `x-api-key` the fallback serves (200). After setting the connector target's `metadataConfiguration.allowedRequestHeaders` to `anthropic-version, anthropic-beta` (no `x-api-key`), the fallback serves **with** `x-api-key` (200). |

Consequences (applied to design 0.1, 0.3, 0.13):
1. Header path: `x-api-key`, verified by the router; no fallback header needed.
2. The production `BedrockTarget` must get an explicit `allowedRequestHeaders` without `x-api-key`
   (`anthropic-version`, `anthropic-beta`, `openai-beta`). This also fixes a pre-existing defect: Claude Code (which
   already sends `X-Api-Key` from `apiKeyHelper`) never got the gateway fallback.
3. Codex attributed long sessions = `auth.command` (Authorization) + `gateway_oauth` delivering `x-api-key`: two
   sign-ins. Short sessions: env token in both headers.
4. Catch-all rule closes the concrete-id bypass; gateway fallback after a router 5xx remains unattributed (degraded
   mode, counted as "not visible" in the console).

Teardown: complete; `verify` listing empty (stack, gateway, targets, rules, REST API, VPC link, NLB, VPCE, resource gateway and configurations, ECS, VPC, probe Lambda, log groups, IAM roles, user pool, password file). The teardown script was stopped once by the host (low memory) after deleting rules and targets; CloudFormation finished the stack delete and `verify` was re-run. Results copied to `research/c1-results/`.
