# Design: router data plane MVP (`packages/router` + `infra/`)

Status: draft for user review (2026-11-04). No code has been written and no AWS writes have been made. Inputs:
- spike findings (V0–V8);
- parent design §2/§3/§6;
- `@auto-router/core` as it stands (engine, policy v1, `InMemoryStateStore`, header hints);
- `@auto-router/pricing` (catalog 2026-11-04.1, normalizers, stream accumulator, `costOf`).

## 1. Topology (revised after V9d)

```
Agent client (Claude Code / OpenAI SDK / Strands)
  │  HTTPS  https://{gw}.gateway.bedrock-agentcore.<region>.amazonaws.com/inference/v1/...
  │  Authorization: Bearer <Cognito access token>           (§5: CUSTOM_JWT gateway)
  ▼
AgentCore Gateway  <prefix>-gw   inbound JWT check · header allowlist · rules · fallback
  │  rule: model auto* → router target; fallback on 5XX → bedrock target (pinned standard tier)
  │  router target = inference provider, GATEWAY_IAM_ROLE + iamCredentialProvider {service: execute-api},
  │  privateEndpoint (managed resource gateway in our VPC, routingDomain = execute-api VPC endpoint)
  ▼
Private REST API  <prefix>-api   AWS_IAM · resource policy: gateway role via this endpoint only   (§4, V9d)
  ▼  VPC link → internal NLB :8080 (SG: no ingress; PrivateLink traffic only)
ECS Fargate ARM64  <prefix>-router   inbound check → core → SigV4 forward → stream tee → pricing → core.record
  ▼  VPC interface endpoint (private DNS) bedrock-runtime.<region>.amazonaws.com
Bedrock runtime  /anthropic/v1/messages · /openai/v1/chat/completions · /openai/v1/responses
```

- The private subnets have **no NAT and no internet egress**. The router reaches Bedrock, ECR, CloudWatch Logs and S3 (ECR layers) only through VPC endpoints.
- The Region is a deploy input. Nothing defaults to a particular Region.

## 2. Service: `packages/router`

### 2.1 Modules

| Module | Responsibility |
|---|---|
| `config.ts` | Loads env + `policy.json` + catalog at boot and validates them (`core.validatePolicy`, `pricing.loadCatalog`, cross-check). Any error stops the process with exit 1. |
| `server.ts` | `node:http` server. Bind comes from `ROUTER_BIND` (**default `127.0.0.1`**; the task definition sets `0.0.0.0` inside the private-subnet container, where the SG is the boundary) and `ROUTER_PORT` (8080). Request timeout 15 min; headers timeout 30 s; keep-alive 65 s. |
| `inbound.ts` | Hop verification, fail-closed (§2.3). |
| `routes.ts` | Maps paths to dialects. `POST /v1/messages` → `anthropic-messages`, `POST /v1/chat/completions` → `openai-chat`, `POST /v1/responses` → `openai-responses`. `GET`/`DELETE /v1/responses/{id}` and `POST …/{id}/cancel` are forwarded as-is (no routing; `x-router-decision: passthrough`). `GET /healthz` returns `200 ok` with no data and no auth (Lattice health check). Everything else returns 404. |
| `body.ts` | Reads the body up to `ROUTER_MAX_BODY_BYTES` (16 MiB, 413 beyond). `JSON.parse` feeds summarize. `spliceTopLevel(bytes, key, newValue)` rewrites only the top-level `model` value span, found by a minimal top-level JSON scanner. Other bytes are untouched (D2), and the result is verified by a property test. |
| `hints.ts` | Unpacks `x-router-hint: pin=…;tier=…;boundary=…` into the individual headers core reads (`x-router-pin`, `x-router-tier`, `x-router-boundary`). Strips any client-sent `x-router-tenant` (§5.4). Applies the opt-in body hints (§2.5). |
| `forward.ts` | Builds the upstream request (`https://bedrock-runtime.ap-northeast-1.amazonaws.com` + provider path) and signs it with `@smithy/signature-v4` (service `bedrock`, signed payload hash) using task-role credentials from `@aws-sdk/credential-provider-node`. Sends with built-in `fetch` (undici) and passes an `AbortSignal` tied to client disconnect. |
| `stream.ts` | Relays upstream bytes to the client as they arrive (`Readable.fromWeb` → `res.write`, with backpressure). An incremental SSE line parser runs on a tee and feeds `pricing.createStreamUsageAccumulator`. Non-streaming bodies are buffered (they are needed for usage) and then written unchanged. |
| `failover.ts` | Same-model, other-profile retry (§2.6). |
| `beta.ts` | Beta-header compatibility table and the switch veto (§2.7). |
| `account.ts` | Normalizes usage, calls `costOf`, calls `core.record`, and writes the log line and EMF (§2.8). |

### 2.2 Request pipeline

1. **Inbound check (§2.3).** On failure: 403 `{"error":"forbidden"}`, logged without headers.
2. **Route and dialect.** Read the body (413 / 400 on invalid JSON).
3. `headers = allowlisted request headers + unpacked hints`. Then `summary = engine.summarize(dialect, json, headers, now)` and `decision = await engine.decide(summary)`. On a core error (e.g. `NoEligibleModelError`), return 503 so the gateway fallback takes over.
4. **Beta veto (§2.7).** It may replace `decision` with a retain/pin of the requested or current model.
5. **Opt-in body hints (§2.5).** Then splice `model = decision.model`.
6. **Response headers** are set before any byte is written:
   - `x-router-decision: <action>;<point>;<mode>`
   - `x-router-model: <decision.model>`
   - `x-router-reason: <code>` (the code part of `decision.reason`)
   In observe mode, `wouldChoose` goes to logs only, so headers stay small.
7. **Forward with SigV4.** On 429/5xx before the first relayed byte, apply failover (§2.6).
8. **Relay status and the upstream content-type.** Upstream `x-amzn-requestid` is logged, not returned (it isn't on the response allowlist).
9. **On finish, abort or error:** `usage = accumulator.result() ?? normalizeUsage(...)` (non-stream), or `undefined`. Then `engine.record(summary, decision, {servedModel, status, usage, responseId})`, and write the log and EMF.

Overhead is measured as `t(upstream request start) − t(body complete)`, plus `t(first client byte) − t(first upstream byte)`, and logged as `overheadMs`.

### 2.3 Inbound check (fail-closed)

Configured by `ROUTER_HOP_AUTH`:

| Value | Check |
|---|---|
| `apigw-iam` (§4) | API Gateway has verified SigV4 and the resource policy. The router additionally requires `x-router-caller-arn` = an assumed-role session of the gateway role, `x-router-source-vpce` = `ROUTER_API_VPCE_ID`, and `x-amz-source-arn` = `ROUTER_GATEWAY_ARN`; repeated values are rejected. |
| `lattice-iam` (retired after V9) | Lattice has already verified SigV4 and the auth policy. The router additionally requires: `x-amzn-lattice-identity` contains `Principal=<gateway role ARN>` (parsed; Lattice sets this header, and V9 confirms it overwrites client-supplied values); `x-amz-source-arn == ROUTER_GATEWAY_ARN`; `x-amz-source-account == ROUTER_ACCOUNT`. |
| `jwt` (option b) | `Authorization: Bearer` verified with `jose` against the Cognito JWKS: `iss`, `exp`/`nbf` (30 s skew), `token_use=access`, `client_id ∈ allowed`, scope `llmar/invoke`. Plus the `x-amz-source-arn` check. |
| unset / unknown | **Reject every request** (fail-closed). |

There is no test bypass in production code. Local tests construct the inbound checker with an injected verifier. The only bypass is `ROUTER_INBOUND_TEST_BYPASS=1`, honored only when the bind is `127.0.0.1` (asserted at boot).

### 2.4 Model id handling
- The requested model after gateway prefix stripping is `auto`, `auto:fast`, `auto:standard` or `auto:frontier`. These are core aliases (`DEFAULT_ALIASES`).
- A concrete Bedrock id is a pin; core returns `action: 'pin'`.
- Responses continuation (`previous_response_id`): core hard-locks the model. The router still sends the `model` field on every request, as `bedrock-runtime` requires.

### 2.5 Opt-in hints (config `ROUTER_HINTS`, JSON; every hint defaults to off)

| Hint | Behaviour | Default | Note |
|---|---|---|---|
| `chatIncludeUsage: 'off' \| 'inject-strip' \| 'inject'` | For `openai-chat` with `stream: true` and no `stream_options.include_usage`: add it. With `inject-strip`, the final `choices: []` usage chunk is dropped from the client stream, so the client sees what it would have seen. | **open decision** (I recommend `inject-strip`) | Without it, Bedrock sends no usage (pricing fixture `stream-no-include-usage`) and cost/hit-rate are unknown for those calls. |
| `claudeAutoCache: boolean` | For `anthropic-messages` with no `cache_control` anywhere: add top-level `cache_control: {type: 'ephemeral'}` (automatic caching, supported on all 5.x / 4.5+ models in the pool). | off | Changes billing (writes at 1.25×), so it is opt-in. |
| `claudeCacheTtl: 'keep' \| '1h-on-idle'` | Upgrade existing `cache_control` TTLs to `1h` for lineages whose median inter-turn gap is > 4 min. | keep | MVP implements `keep` only; the other value is reserved. |

Every applied hint is logged (`hints: [...]`). Hints are spliced in at top level only; nested edits are never made.

### 2.6 Failover (D9)
- Trigger: an upstream status in the policy's `failover.profileRotateOn` (default `[429]`; a network error counts as 502) **before the first byte is relayed**. 5xx is not retried by default (2026-11-05): `global.` already routes across Regions, so the geo profile very likely fails too; the 5xx goes to the gateway fallback. Streams that fail mid-way are passed through as-is.
- Candidates: the `failover` list of the pool entry for `decision.model` in the policy (core `PoolEntry.failover`, e.g. `global.anthropic.claude-opus-5-5` → `jp.anthropic.claude-opus-5-5`). One retry, with no backoff beyond a jittered 50–150 ms.
- Recording: `core.record` gets `servedModel = <profile actually served>` and the first failure status. A new decision with `point: 'failover'` is recorded on the next request, per the core design.
- If every attempt fails, return the last upstream status. A 5xx triggers the gateway fallback rule; a 429 is returned to the client (gateway fallback is 5XX only).
- Router-internal errors (bugs, timeouts to the credential provider) return 502/503, so the gateway serves the request from the pinned Bedrock model.

### 2.7 Beta-header compatibility (D8)
- `anthropic-beta` values are compared against `beta-compat.json`, keyed by beta value → list of model-id globs that accept it. The table is seeded from the spike (V8: `interleaved-thinking-*`, `context-1m-*` OK; `extended-cache-ttl-2025-04-11` rejected) and the Bedrock model cards.
- When `decision.action === 'switch'` (or `initialize` onto a model other than the session's current one) and the target model is not covered for every beta value, the decision is replaced by retain/current (or the requested pin), with reason `beta-incompatible:<value>`. If the requested model is itself incompatible, Bedrock's own 400 is passed through.
- **Risk:** Claude Code sends several betas by default. E2E step 3 lists them; unknown values are treated as "only the requested/current model is safe", so routing degrades to no-switch rather than failing.
- Follow-up for core: a `constraints.betas` input to `decide` would let the gate filter candidates instead of vetoing after the fact. This is a contract change and needs a parent note.

### 2.8 Logs and metrics
- **Log line** (stdout JSON, CloudWatch Logs, 7-day retention): `ts`, `reqId` (router-generated uuid), `dialect`, `requested`, `decision{action,point,mode,model,wouldChoose,reason,policyVersion,estimate}`, `servedModel`, `status`, `stream`, `usage` (normalized), `costUsd` (CostBreakdown), `hitRate` = read/prompt, `miss` (RecordResult), `overheadMs`, `upstreamTtfbMs`, `durationMs`, `bodyBytes`, `hints`, `failover`, and `lineage` (sha256 prefix, never the raw session id).
- Never logged: bodies, prompts, any header value except an allowlist (`anthropic-version`, `anthropic-beta`, `openai-beta`, `content-type`). A test asserts that `authorization`, `x-amz-security-token`, `x-api-key` and `cookie` never appear (this is the spike's stub incident turned into a regression test).
- **EMF metrics**, namespace `LlmAutoRouter`, dimensions `{Dialect, ServedModel}` and `{Mode}`, kept to low cardinality: `Requests`, `CostUsd`, `PromptTokens`, `CacheReadTokens`, `CacheWriteTokens`, `Switches`, `Misses` (dimension `Reason`), `OverheadMs`, `UpstreamTtfbMs`, `UpstreamErrors` (dimension `Status`), `Failovers`, `BetaVetoes`.

### 2.9 State
- `new InMemoryStateStore({maxEntries: 100_000})` behind core's `StateStore` interface.
- The MVP runs **one task**, so there is no affinity problem. With more than one task, Lattice round-robins requests, state splits per task, and cache tracking degrades towards fingerprint-only. An external store (DynamoDB or ElastiCache) is the follow-up.
- A process restart loses state, and core treats the next request as a break point.

### 2.10 Dependencies for the router (to be approved; none installed)

| Package | Kind | Why |
|---|---|---|
| `@smithy/signature-v4` | runtime | SigV4 signing of upstream Bedrock requests (vetted signer, also used by the AWS SDK). |
| `@aws-crypto/sha256-js` (or `@smithy/hash-node`) | runtime | Hash implementation the signer requires. |
| `@aws-sdk/credential-provider-node` | runtime | Task-role credentials via the ECS container endpoint, with refresh. |
| `@smithy/protocol-http` | runtime | `HttpRequest` type the signer consumes. |
| `jose` | runtime, **only if V9 picks (b)** | JWT/JWKS verification (no hand-written crypto). |
| `@auto-router/core`, `@auto-router/pricing` | workspace | Engine and accounting. |

No web framework and no logging library: JSON lines and EMF are written by hand (EMF is a JSON spec).

## 3. Infra: `infra/` (CDK TypeScript; revised 2026-11-04 after V9d, publishable per parent N5)

Deploy inputs, all CDK context:
- `region` and `account` (both required and explicit; `account=env` is an explicit opt-in) and `azIds` (per-Region default table for managed private endpoints);
- `prefix` (default `llmar`) and `tags` (Project/Purpose defaults, nothing personal);
- `policyFile` (validated against the Region catalog at synth);
- `catalogFile` (optional, for a self-captured Region);
- `routerDesiredCount` (default 0).
See `infra/README.md`.

| Resource | Configuration |
|---|---|
| VPC | 2 private isolated subnets by AZ ID; no IGW or NAT; REJECT flow logs. Interface endpoints with private DNS: `bedrock-runtime`, `ecr.api`, `ecr.dkr`, `logs` (SG: 443 from the router). Gateway endpoint `s3` (router egress via the S3 prefix-list parameter). |
| execute-api endpoint | Private DNS **off**. SG: 443 from the AgentCore resource-gateway SG only. Endpoint policy: `execute-api:Invoke` for the gateway role only. It cannot name the API: the API's resource policy names the endpoint, which would make a template cycle. |
| REST API | `PRIVATE` (VpcEndpointIds = endpoint), stage `v1` (throttling from context, default 20 rps / burst 40), `ANY /{proxy+}`, `AWS_IAM`.<br>Integration: `HTTP_PROXY` over `VPC_LINK` to `http://<nlb>:8080/v1/{proxy}`, `ResponseTransferMode: STREAM`, 900 s.<br>Integration headers: `x-router-caller-arn` ← `context.identity.userArn`; `x-router-source-vpce` ← `context.identity.vpceId`; `x-amz-security-token` ← `'redacted'` (V9d found API Gateway passes the gateway session token through).<br>Resource policy: Allow the gateway role with `aws:SourceVpce` = endpoint; Deny other endpoints; **Deny other principals**, because in the same account an identity-policy Allow alone would admit any role. |
| NLB | Internal, TCP 8080, IP targets from the ECS service, health check HTTP `/healthz`. SG has **no ingress rules** and `EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic=off`, so only VPC link traffic gets in. Egress: 8080 to the router SG. |
| ECS | Fargate ARM64 (1 vCPU / 2 GB), desired count from context (0 first), circuit breaker with rollback, no public IP, Container Insights off (router EMF instead). Router SG: ingress 8080 from the NLB SG only; egress 443 to endpoints and S3. |
| Router env | `ROUTER_REGION`, `ROUTER_HOP_AUTH=apigw-iam`, gateway role/ARN, `ROUTER_API_VPCE_ID`, `ROUTER_MAX_BODY_BYTES` = 10 MiB, `ROUTER_POLICY_JSON` (validated policy), `ROUTER_CATALOG_JSON` (only with `catalogFile`), `ROUTER_HINTS` (inject-strip). |
| IAM: task role | `bedrock:InvokeModel*` on exactly the router's allowed models, using the documented cross-Region inference pattern: profile in-Region + foundation model in-Region + `arn:aws:bedrock:::foundation-model/<id>` (`aws:RequestedRegion = unspecified`), all tied to the profile ARNs. Geographic profiles get the destination-Region foundation model. No wildcard model ARNs for global profiles, no `*` actions. Responses: `bedrock:InvokeModel` on `project/*`, conditioned on `bedrock:ModelArn` = the Responses pool's profiles. The default project is documented as required for Responses on bedrock-runtime. |
| IAM: gateway role | `execute-api:Invoke` on the router API stage; `bedrock:InvokeModel*` on the two fallback models (same pattern); connector discovery List/Get. |
| Cognito | User pool `<prefix>-users` (no self sign-up, Essentials); resource server `<prefix>`, scope `invoke`; M2M client (client credentials, Cognito-generated secret); domain `<prefix>-<stack-guid-block>`. |
| AgentCore Gateway | `<prefix>-gw`, `CUSTOM_JWT` (pool discovery URL, allowed client, scope `<prefix>/invoke`). |
| Target `router` | Inference provider. Endpoint `https://<api>.execute-api.<region>.amazonaws.com`; operations `/v1/messages`, `/v1/chat/completions`, `/v1/responses` with models `auto`, `auto:*`; `GATEWAY_IAM_ROLE` + `iamCredentialProvider {service: execute-api}`. `managedVpcResource`: private subnets, resource-gateway SG, `routingDomain` = the endpoint's regional DNS name. Request allowlist (9): see `REQUEST_HEADERS`. Response allowlist: decision/model/reason. |
| Target `bedrock` + rule | Bedrock connector, fallback only. Rule `auto`/`auto:*` → router; 5XX/connection/unroutable/first-byte timeout (610 s) → `bedrock` with Sonnet 5.5 (triggers 5XX/400/404) → GPT-6.1 Sol. `MatchPaths` accepts only one-segment prefixes, so per-path rules are impossible (API pattern `/[\w\-.]+/\*`). |

## 4. V9: gateway → container hop (decided 2026-11-04)

**Verdict: (d), a private REST API with `AWS_IAM` behind an execute-api VPC endpoint, then VPC link and internal NLB.**
- V9 rejected (a), VPC Lattice: the AgentCore signer signs payloads, Lattice rejects signed payloads, and the gateway's model discovery fails at target creation. Evidence: `research/v9-findings.md`.
- V9d (ap-southeast-1) verified (d). Gate: unsigned, other-role (identity Allow, explicit Deny) and outside-VPC calls were all denied, and direct TCP to the NLB and task timed out.
- Hop: target READY (discovery `GET /v1/models` passed). All three APIs returned 200 with byte-exact bodies. The identity headers carry the gateway role session, our endpoint and the gateway ARN, and client-sent values are overwritten (R-a4 pass).
- Size: 1, 7 and 9.5 MB pass; 12 MB gets 413 from API Gateway (10 MiB cap). TimeoutInMillis 900000 with STREAM was accepted without a quota request.
- Streaming cadence and latency results: see `research/v9-findings.md` (V9d section) when 0c adds them.
- The router checks `apigw-iam` fail-closed (§2.3): caller ARN = gateway role session, source VPCE = configured, `x-amz-source-arn` = gateway ARN, and repeated values are rejected.

## 5. Inbound auth for agent clients

### 5.1 Options

| | `AWS_IAM` gateway | `CUSTOM_JWT` gateway (Cognito) |
|---|---|---|
| Claude Code | **Not usable in Messages mode.** Claude Code sends a bearer/api key, not SigV4. Bedrock mode (`CLAUDE_CODE_USE_BEDROCK=1` + `ANTHROPIC_BEDROCK_BASE_URL`) signs for `bedrock` on the InvokeModel paths, which is a different API from the Messages pass-through the router serves; this is also untested on the gateway. | `ANTHROPIC_BASE_URL=https://{gw}/inference`. Auth via `apiKeyHelper` (a script that fetches a Cognito client-credentials token, refreshed with `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3000000`) or `ANTHROPIC_AUTH_TOKEN` for short sessions. `ANTHROPIC_MODEL=router/auto`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=router/auto:fast`. |
| OpenAI SDK | Needs a custom `httpx` auth hook that SigV4-signs for `bedrock-agentcore`. | `OpenAI(base_url="https://{gw}/inference/v1", api_key=<token>)`. Refresh by recreating the client, or with a small `httpx.Auth` that renews before `exp`. `model="router/auto"`. |
| Strands / boto3 | Native SigV4 (botocore `SigV4Auth`, service `bedrock-agentcore`) on raw HTTP; Strands' OpenAI or Anthropic model provider with a signing http client. | Strands `OpenAIModel` / `AnthropicModel` with `base_url` and the bearer token, the same as above. |
| Identity reaching the router | Gateway role only. | Gateway role only (§5.4). |
| Operational | No IdP; IAM policy `bedrock-agentcore:InvokeGateway`. | Cognito pool, app clients, secret handling through Secrets Manager, and token TTL. |

### 5.2 Recommendation
**`CUSTOM_JWT` with Cognito for the MVP gateway.** It is the only option where both required clients (Claude Code Messages and the OpenAI SDK) work without a self-built signing proxy.
- Tokens are issued by Cognito (client credentials, scope `llmar/invoke`), not minted by us. The client secret is Cognito-generated, stored in Secrets Manager, and read by `apiKeyHelper` with the developer's own AWS credentials.
- A second `AWS_IAM` gateway in front of the same router targets is an optional later addition for AWS-native workloads (Strands / boto3). It doesn't change the router, because the hop auth is the same.

### 5.3 Concrete client configs (for E2E)
- **Claude Code** (`~/.claude/settings.json` or project settings):
  - `{"apiKeyHelper": "~/bin/llmar-token", "env": {"ANTHROPIC_BASE_URL": "https://{gw}/inference", "ANTHROPIC_MODEL": "router/auto", "ANTHROPIC_DEFAULT_HAIKU_MODEL": "router/auto:fast", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": "3000000"}}`
  - `llmar-token` fetches the secret through `aws secretsmanager get-secret-value` (developer credentials), then POSTs to `https://{domain}.auth.ap-northeast-1.amazoncognito.com/oauth2/token` with `grant_type=client_credentials&scope=llmar/invoke`, and prints `access_token`.
  - Unverified whether the gateway accepts the token in `x-api-key` as well as `Authorization: Bearer`; `apiKeyHelper` sends both.
- **OpenAI SDK (Python):** `OpenAI(base_url=f"https://{gw}/inference/v1", api_key=token)`; `client.chat.completions.create(model="router/auto", stream=True, ...)`; `client.responses.create(model="router/auto", store=False, ...)`.
- **Strands:** `OpenAIModel(client_args={"base_url": ..., "api_key": token}, model_id="router/auto")`.

### 5.4 Identity and isolation caveat
- On the inference target path the router sees only the gateway role, so session headers are client-asserted.
- Consequences:
  - A client can collide with or poison another client's lineage state. State holds hashes, counts and model ids, never content, so the impact is routing quality and cost attribution only.
  - Per-tenant routing and cost attribution by user is not possible in the MVP.
- Mitigations:
  - The router drops `x-router-tenant` from clients.
  - Lineage keys are hashed.
  - Later options: a request interceptor that injects a verified `sub` (unverified for inference gateways, and interceptor Lambda payload limits conflict with 12 MB bodies); option (b) for an HTTP target; or one gateway per tenant.

## 6. E2E test plan (revised 2026-11-04 for ap-southeast-1 and the V9d hop; 0c runs the AWS parts)

**Budget: ≤ USD 5** of Bedrock spend for E1–E13. Use Haiku 5.5 and GPT-6 Luna (via `auto:fast` or the `x-router-hint` pin) except where a tier, fallback model or cache-parity test needs the default (Sonnet 5.5, GPT-6.1 Sol). Every test logs its spend from the router's `costUsd`, and the run stops at USD 4.50.

**Setup:**
- Stack deployed with `-c region=ap-southeast-1` and the default policy (global profiles only), at desired count 0 first.
- E2E scripts live in `packages/router/e2e/` (implementer). One small router change is needed first: a log field `hopToken: 'absent' | 'redacted' | 'other'`, which records how `x-amz-security-token` arrived without ever logging its value (E9).
- In-VPC probes reuse `spikes/apigw-hop/probe/probe.py`, as a temporary Lambda in the router VPC that is tagged and deleted after E0.

| # | Test | Pass criterion |
|---|---|---|
| E0 | **Gate, before any traffic (desired count 0, then again at 1).**<br>Outside the VPC: anonymous `POST /inference/v1/messages` to the gateway; a token for the wrong client or scope; the private API hostname.<br>In-VPC probe: the API through the execute-api endpoint, unsigned and signed by the probe role (identity Allow); direct TCP to the NLB IPs and the task IP on 8080. | Gateway 401/403 JWT errors. API hostname NXDOMAIN outside the VPC. In-VPC: 403 unsigned, 403 other role (explicit Deny), TCP timeouts. **Stop on any 2xx.** |
| E1 | OpenAI SDK Chat Completions, streaming and non-streaming, model `auto` | 200; SSE incremental; `x-router-*` headers present; the log has usage and cost; with `inject-strip`, the client stream has no `usage` key. |
| E2 | OpenAI SDK Responses, streaming and non-streaming: `store=false`, then `store=true` + `previous_response_id` | The continuation hard-locks the model (`hard-lock-response-chain`) and gets no router failover. `GET`/`DELETE /v1/responses/{id}` are out of scope (404 at the router if they reach it). |
| E3 | Claude Code headless: `claude -p "<task>" --output-format stream-json` in a sample repo, 10+ tool turns, model `auto` | Completes. The betas Claude Code sends are recorded. There is no `betaVeto` (deny-list table), and no 400 from Bedrock; if there is one, document `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Decisions are logged per turn, and tool loops show `hard-lock-tool-loop`. |
| E4 | Cache parity: a scripted 20-turn agent session, once through the gateway (observe, policy default) and once directly to Bedrock with the same model | Hit rate (read/prompt) within 2 pp. |
| E5 | Pins: (a) `x-router-hint: pin=global.anthropic.claude-haiku-5-5`; (b) a hint pin outside the policy; (c) a concrete body model `global.anthropic.claude-haiku-5-5` (it doesn't match `auto*`, so the gateway's bedrock target serves it) | (a) router `pin`, served by Haiku, body bytes unchanged except `model`; (b) 400 `pin-not-allowed`, no Bedrock call; (c) Bedrock 403 for the gateway role, which only allows the fallback models. That is documented, not a failure. |
| E5b | Model aliases through the gateway rule (`auto`, `auto:*` StringLike): `auto:fast` on Messages, Chat and Responses; `auto:bogus`; `autox` | `auto:fast` reaches the router on all three paths (`x-router-model` present) and resolves to the fast tier (`tier=fast via alias`; observe mode serves the observe default and logs Haiku 5.5 / GPT-6 Luna as `wouldChoose`). `auto:bogus` reaches the router and gets 400 `pin-not-allowed`. `autox` never reaches the router. |
| E6 | Router 5xx path with global-only profiles: an e2e task revision with `ROUTER_FAULT_INJECT=upstream-503-once:2` and `ROUTER_FAULT_INJECT_ALLOW=1`; turn 1 router-served, turn 2 faulted | No router retry (no failover profiles). The client still gets a 200 from the gateway fallback (Sonnet 5.5 on Messages). The router log shows the 503 recorded to core. The fault must not hit the session's first call: with no current model core falls through to `session-start` (seen in the first run). The next turn (turn 3) is `failover` to a same-tier sibling when the policy has one; the default policy has none, so it is `retain` (`failover: exhausted`). |
| E7 | Gateway fallback chain: scale ECS to 0 and call `auto` on all three paths, streaming and non-streaming; then a request both fallback models reject (e.g. an invalid parameter) | Messages answered by Sonnet 5.5. Chat Completions and Responses answered by GPT-6.1 Sol after Sonnet's 4XX: proves the two-step chain (§3 rule), streaming included. Record the extra rejected Sonnet call per Chat/Responses fallback. When both fail, the client sees the **last target's** (Sol's) error. Check the gateway's fallback and circuit-breaker metrics for these requests. Then, with the router back at 1 task, force repeated router 5xx (`router-503` fault revision) and record whether and when the circuit opens: `auto*` is served by the fallback, the router logs nothing, and when it recovers. |
| E7b | Circuit breaker, informational: at desired count 0 send N `auto` requests (all served by the fallback), then scale to 1 and probe every 10 s | Records the time from the router's first healthy NLB target to the first router-served `auto` request, the TTFB of fallback-served requests before and after the breaker could have opened, and the gateway's CloudWatch metrics for the window. No fallback or circuit-breaker metric is documented. No pass/fail threshold yet. |
| E8 | Request size: Messages with a 9.5 MiB body, then 10.5 MiB | 9.5 MiB passes the hop and the router (Bedrock may answer `prompt is too long`, not billed). 10.5 MiB gets **413 from API Gateway** (`HTTP content length exceeded 10485760 bytes`). Being a 4xx, no gateway fallback, and nothing in the router log. |
| E9 | Session token never reaches the router | Every E1–E8 router log line has `hopToken: 'redacted'`. Plus the infra test asserting the integration mapping `x-amz-security-token ← 'redacted'`. |
| E10 | Streaming limits, end to end through router → API Gateway → AgentCore → client: (a) a Messages stream whose upstream goes silent for 6 min between frames (a slow tool-free prompt on Luna, or `ROUTER_STREAM_IDLE_TIMEOUT_MS` raised in the e2e revision so the router's dead-upstream detector doesn't fire first); (b) a 14-minute stream that keeps sending | (a) survives: `: keepalive` comments arrive about every 60 s (`heartbeats` > 0 in the log), the SDK ignores them, and the stream completes, whereas V9d without heartbeats was cut at about 302 s. (b) completes. A 15-minute+ stream is not run: V9d showed a clean close at about 901 s, logged `stream-duration-cap`. |
| E11 | Overhead: 200 requests (Luna, short) | `overheadMs` p50 < 20, p99 < 100. |
| E12 | Log hygiene: search the router log group and the VPC flow logs for `authorization`, `security-token` values, `x-api-key`, `cookie`, the Cognito client secret and prompt text markers | No hits. Field names are fine; values are not. |
| E13 | Teardown | `cdk destroy`, then the verification listing finds nothing tagged or `<prefix>-`: gateways, REST APIs, VPC links, NLBs, VPC endpoints, resource gateways, ECS, VPC, Cognito, log groups. |

**Optional, only in Regions with geographic profiles** (e.g. ap-northeast-1 with `config/policy.example.ap-northeast-1.json`), not run in ap-southeast-1:
- **E-geo-1, profile rotation:** `upstream-503-once` on a pool model with a `jp.` failover profile, with `failover.profileRotateOn: [429, 503]` in the policy (the fault injects a 503). Served by the `jp.` profile, `failover` logged, the next turn on the failover profile. With the default `[429]` the same fault checks the opposite: no router retry, gateway fallback.
- **E-geo-2, chain readability:** a Responses `store=true` call on `global.`, then `previous_response_id` sent on the `jp.` profile (`x-router-hint` pin). This records whether a stored response is readable across profiles. Until it is shown readable, core keeps `failover-chain-locked`, and the router skips failover inside chains.

**Spend estimate:**
- E1–E3: ≈ USD 1.5 (Claude Code dominates).
- E4: ≈ USD 1.5 (two 20-turn sessions, mostly cache reads).
- E6–E8 and E10: < USD 0.5.
- E11: ≈ USD 0.1.
- Total ≈ USD 3.6, under the USD 5 cap.

## 7. Open decisions for the user / parent
1. `chatIncludeUsage` default. I recommend `inject-strip`. It is a body change beyond the model field, but without it Chat stream cost is unknown.
2. Confirm CUSTOM_JWT (Cognito) as inbound auth for the MVP; an AWS_IAM gateway can be added later.
3. Fallback models per path: Sonnet 5.5 (Messages) and GPT-6.1 Sol (Chat/Responses).
4. Whether the Responses GET/DELETE target (`router-http`) is in MVP scope (default: off).
5. Dependency approvals (§2.10, §3).
6. E2E budget of USD 5.

## 8. Implementation notes (2026-11-04, steps 1–6; deviations from the sections above)

- **§2.5 inject-strip.** With `include_usage`, Bedrock adds a top-level `"usage":null` to every chunk; without it, the field is absent (pricing fixtures). So `inject-strip` also removes that member, as well as dropping the `choices: []` usage chunk. Every other byte of every frame is unchanged.
- **§2.3.** `x-amz-source-account` is checked only when present. `x-amz-source-arn` already pins the account, and V9 records whether the gateway sends it over Lattice.
- **§2.7.** An `initialize` onto an incompatible model moves to the first pool model that accepts every beta. A `switch` retains the session's current model (read from the store). If no pool model is safe, the decision is kept and Bedrock validates.
- **§2.10.** The signer uses a `node:crypto` SHA-256/HMAC adapter instead of `@aws-crypto/sha256-js`. The pure-JS hash is slow on 16 MiB bodies, against the N1 budget. `@aws-crypto/sha256-js` is unused by the router (the assessor's eval transport still uses it).
- **§2.4 / D3.** A concrete Bedrock id does not match the router's `auto*` models, so the gateway's `bedrock` target serves it directly, limited by the gateway role to the fallback models. Pins through the router use `x-router-hint: pin=…`.
- **§3 rule.** `MatchPaths` accepts only target prefixes (`^/[\w\-.]+/\*$`), so there are no per-API rules. One rule (`auto`, `auto:*`) falls back to `bedrock`/Sonnet 5.5 (triggers 5XX/400/404/connection/unroutable), then to `bedrock`/GPT-6.1 Sol. E7 must verify this chain on all three paths.
- **§3 overrides.** The L1 `CfnGatewayRule` in aws-cdk-lib 2.275 does not type `MatchModels` or `Fallback`, so they are property overrides. CFN-validate warning F3018 is acknowledged.
- **§3 nag.** cdk-nag v3 runs as a `Validations` plugin. Acknowledgements are exact findings (per-model foundation-model ARNs, `project/*`, `ecr:GetAuthorizationToken`, connector discovery, COG2/3/8 for an M2M-only pool, IAM4 for the ECS Lattice infrastructure role).
- **§3 subnets.** Subnets use `AvailabilityZoneId` apne1-az1/az2, the AZ IDs supported for managed private endpoints.
- **Step 5.** The image runs the TypeScript sources with Node 24 type stripping. It uses `pnpm install --prod --filter @auto-router/router...` rather than `pnpm deploy`, because the workspace symlinks keep real paths outside `node_modules`.
- **§2.2 / §2.8 (0c decisions, 2026-11-04).**
  - Mid-stream upstream failure: recorded to core as 502, reason `mid-stream`.
  - Client abort after the forward: logged as 499, reason `client-abort`, and recorded with the upstream status.
  - Both cases log, price and record the partial usage.
  - EMF adds the dimension sets `{StatusClass}`, `{StatusClass, Reason}` (reason code, bounded) and `{MissReason}`.
- **Assessor seam.** `RouterDeps.card(summary, body, ctx)` receives core's CardContext from `extras.card(ctx)` (core 04d54a2).
- **0d review fixes (2026-11-04).**
  - Beta table: a deny list. Observe mode only annotates `wouldChoose`; auto mode moves only to the same tier or higher.
  - Concrete ids: allowlisted to catalog ∩ (pools ∪ failover ∪ observe defaults); infra grants exactly these.
  - Failover: each failed attempt is recorded before the retry; none inside a response chain.
  - Upstream timeouts: header 60 s for streams and 600 s otherwise; stream idle 240 s.
  - Duplicate top-level keys: 400.
  - 403: `connection: close`; `checkContinue` is authenticated.
  - Crash path: logged; `ServedModel` and `requested` are bounded; `decision.reason` is cut to 200 characters in logs.
  - Partial-usage limits are documented in the router README: output tokens are lost before `message_delta`, and warmth is pessimistic after a mid-stream 502.
