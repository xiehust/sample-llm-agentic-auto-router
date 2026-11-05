# Spike findings: AgentCore Gateway as front door for a self-built router

Run 2026-11-04, ap-northeast-1. Scripts: `spikes/agentcore-gateway/` (`spike.py`, `stub/index.js`).
Raw results stay local (gitignored `spikes/agentcore-gateway/results/`, they name the account).
Teardown verified: stack, gateway, targets, rules, Lambda, IAM roles, VPC, log group and the managed VPC
Lattice resource gateways/configurations are all gone. Bedrock spend < USD 0.05.

## Verdict

**GO** for "AgentCore Gateway front door + self-built router target", with two changes to the plan:

1. Do not host the router on a Lambda Function URL: the gateway passes ≥ 12 MB bodies but a Lambda URL target
   caps request bodies at ~4.5 MB (6 MB event limit, base64 body). Host it in a container.
2. The gateway → container hop needs a verifiable auth mechanism other than Lambda IAM (follow-up V9 below).

## Answers

| # | Question | Answer | Evidence |
|---|---|---|---|
| Gate | Anonymous access denied? | Yes. Stub URL → 403 `AccessDeniedException`; gateway → 403 `MissingAuthenticationTokenException` (error body in the client's API shape). Checked before any test traffic. | gate.json |
| V0 | Gateway SigV4 to a custom endpoint | **Yes, with an explicit `iamCredentialProvider {service: "lambda", region}`** on both inference provider targets and HTTP passthrough targets. Inferred signing fails: `Credential should be scoped to correct service: 'lambda'`. `CALLER_IAM_CREDENTIALS` fails against a Lambda URL (inferred: wrong service; explicit: `The security token included in the request is invalid`). | v0.json, v0b.json |
| V0 | What does the target see? | Caller = gateway execution role session (`…/<gateway-role>/gateway-session-invocation`); headers `x-amz-source-arn` = gateway ARN, `x-amz-source-account`. | v0.json |
| V1 | `privateEndpoint` on inference / HTTP targets | **Accepted and READY on both** (managed VPC Lattice), although only documented for MCP/OpenAPI targets. End-to-end private call not tested (needs an internal HTTPS service the gateway trusts). | v1.json |
| V2 | Byte fidelity | **Byte-identical** request bodies on all three APIs and both target types (unsorted keys, odd spacing, `\u` escapes). Only exception: a target-qualified model id is rewritten (prefix stripped). | v2.json |
| V2 | SSE | **Incremental**: 100 ms chunk cadence preserved, same as calling the stub directly. | v2.json |
| Lat | Extra hop | +~80 ms time-to-first-byte p50 (854 vs 770 ms direct, measured from the dev box); both target types alike. | lat.json |
| V3 | Request headers | Allowlisted headers arrive on both target types (`x-claude-code-session-id`, `x-session-id`, `anthropic-beta`, `anthropic-version`, `x-router-*`, `openai-beta`, `x-stainless-lang`). Others are dropped; client `user-agent` and `x-forwarded-for` are not forwarded (XFF = gateway egress IP). Max 10 request + 10 response headers per target. | v3.json |
| V3 | Response headers | Allowlisted ones return (`x-router-decision`, `x-router-model`, …); others dropped. | v3.json |
| V4 | Model ids | Glob entries (`stubx-*`) match. `target/model` routes to that target **and the prefix is stripped**; a qualified id skips the target's model patterns (`stubx/other` → target sees `other`). Unknown id → 404 `not_found_error`. Bedrock ids reach the connector; Messages → Bedrock needs the `anthropic-version` header (SDKs send it). | v4.json |
| V5 | Body size | Gateway forwards 7 MB and 12 MB to Bedrock (Bedrock answers `prompt is too long`); 24 MB → `JSON … malformed` (a limit between 12 and 24 MB, gateway or Bedrock). Lambda URL target: 1 MB ok, 5–7 MB → 413, 10 MB → 502. | v5.json |
| V6 | Fallback | A rule on the inference target (`matchModels` → `staticRoute` router target, `fallback` → Bedrock target with a pinned model on `5XX`) works for non-streaming and streaming. The caller can tell only from the body `model`; the router never sees the request. | v6.json |
| V7 | Responses `GET`/`DELETE` | **Not routable on `/inference`** (`No Target found for Target name: inference`). Works on an HTTP passthrough target (`/{target}/v1/responses/{id}`). | v7.json |
| V8 | Cache through the gateway | `cache_control` preserved: write 9,615 → read 9,615 tokens; `ttl: "1h"` works with no beta header. `anthropic-beta` is forwarded on the connector path by default and **validated by Bedrock** (obsolete `extended-cache-ttl-2025-04-11` → 400; `interleaved-thinking-…`, `context-1m-…` → 200). | v8.json |

Incident during the spike: the first stub version logged and echoed every request header, including the
gateway session's `x-amz-security-token`. The stub now redacts `authorization`, `x-amz-security-token`,
`x-api-key` and `cookie`; saved results were scrubbed; the log group was deleted with the stack. (A session
token alone cannot sign requests, and the credentials were short-lived.)

## Recommendations for the data-plane MVP

1. **Target type.** Register the router as an **inference provider target** for `POST` traffic: it keeps the
   gateway's model-aware features (rules, fallback bypass to Bedrock on router failure, token-limit policies,
   `/inference` base URL). Add an **HTTP passthrough target** to the same router only if clients need
   Responses `GET`/`DELETE`. Both use `iamCredentialProvider` with an explicit service.
2. **Model ids.** Clients send `router/auto` (prefix stripped → router sees `auto`) or a router-only glob
   such as `auto*` on the router target. Never register globs that overlap Bedrock ids on the router target
   (collisions prefer the Bedrock target).
3. **Hosting and auth (V9, first MVP step).** Container (ECS Fargate) inside a VPC, reached through
   `privateEndpoint`. Candidate auth for that hop, to verify end to end:
   a. VPC Lattice service with an IAM auth policy (gateway signs with `vpc-lattice-svcs`; Lattice verifies);
   b. `JWT_PASSTHROUGH` (HTTP targets only) with JWT verification in the router against the IdP JWKS;
   c. mTLS via the target `certificateConfigurations` (unverified what it covers).
   Keep the Lambda-URL path only as a ≤ 4 MB fallback.
4. **Defence in depth.** The router checks `x-amz-source-arn` equals the expected gateway ARN.
5. **Header allowlist (≤ 10 each).** Request: `x-claude-code-session-id`, `x-session-id`, `anthropic-beta`,
   `anthropic-version`, `openai-beta`, `x-router-session`, `x-router-parent-session`, `x-router-agent-id`,
   `x-router-hint` (+1 spare). Response: `x-router-decision`, `x-router-model`, `x-router-reason`.
6. **Beta headers.** Pass `anthropic-beta` through; when the router changes models it must check the target
   model accepts every beta (Bedrock rejects unknown values).
7. **Fallback bypass.** Configure the gateway fallback (router 5xx → Bedrock, pinned standard-tier model);
   core must tolerate turns it never saw (prefix mismatch → treat as a break point).
8. **Inbound auth for agent clients (decide in MVP).** `AWS_IAM` needs SigV4 clients (AWS SDK; Claude Code in
   Bedrock mode signs for `bedrock`, which the gateway accepts on the InvokeModel path per docs — untested).
   Anthropic/OpenAI SDK clients need bearer tokens → a `CUSTOM_JWT` gateway (e.g. Cognito). Two gateways in
   front of one router are possible.
