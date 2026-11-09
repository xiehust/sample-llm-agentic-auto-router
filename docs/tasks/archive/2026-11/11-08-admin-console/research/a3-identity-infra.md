# a3: identity at the router, usage ingest, console infra and IAM (research, 2026-11-08)

Scope: design §2 (gateway + router side), §4, §6, §8, §9. Research only: no AWS writes, no code changes.
Labels: **[doc]** stated in AWS docs (links in §7), **[code]** read in this repo, **[bench]** measured locally,
**[infer]** reasoning, still unverified, **[spike]** decided by the spike plan in §1.4.

## 0. Decisions (summary)

| # | Decision | Basis |
|---|---|---|
| A1 | Keep the preferred path: the client sends its Cognito access token again in `x-api-key`, the router target allowlists it (10th and last slot), and the router verifies it in process. | `x-api-key` is not a restricted header [doc]. The interceptor alternative fails on body size [doc]. |
| A2 | No gateway request interceptor. | The interceptor input always carries the request body (base64); only `RESPONSE_BODY` can be excluded; Lambda sync limit 6 MB vs our 10 MiB bodies [doc]. It would also put a synchronous Lambda on every request (PRD constraint). |
| A3 | Router verification: `node:crypto` RS256, no new dependency. The verified-token cache is keyed by the signature segment. JWKS comes from S3 (`identity/jwks.json`), never fetched at request time. | p99 49 µs full verify, ~1 µs on a cache hit [bench]. |
| A4 | Identity mode `off \| observe \| require`, default `observe`. **The R2 disable bound holds only in `require`**: in `observe` a disabled member can omit `x-api-key`. | [infer] |
| A5 | Block list `identity/blocks.json` (console writes it), plus `identity/budget-blocks.json` (ingest writes it if budgets ship). Both are separate objects from the versioned config document, polled with `If-None-Match` every 30 s. Disable → served no more within ~35 s. | Cognito revocation does not reach third-party verifiers [doc]. |
| A6 | Close the direct-`bedrock` bypass with a lowest-priority catch-all gateway rule → `router` target, and shorten the `cli` client's access-token validity (15–30 min). | Gateway rules support no-condition catch-alls [doc]; whether the rule routes ids outside the target's `models` is decided by spike S7. |
| A7 | Two DynamoDB tables: `console` (config versions, audit, members metadata; PITR on) and `usage` (records + rollups; TTL; PITR off). Ingest writes with `TransactWriteItems` (record put with `attribute_not_exists` + aggregated rollup `ADD`s), so retries are exact. | [infer]; about $8 per million router requests. |
| A8 | Separate `ConsoleStack` in the same CDK app. Router-side additions (the `cli` client, the config/identity bucket, `jwks-sync`, the identity env) stay in `RouterStack`. Cross-stack values go through SSM parameters, not `Fn::ImportValue`. | Avoids export locks; the console can be deployed and destroyed on its own. |
| A9 | The SPA calls the HTTP API directly (CORS limited to the CloudFront origin), and `/api` is not proxied through CloudFront. WAF, if wanted, goes on CloudFront only and is noise reduction, not the gate. | HTTP APIs have no WAF integration [infer, well known; confirm in review]. The JWT authorizer is the gate. |
| A10 | Pool MFA `ON` (TOTP) for everyone (recommended), or `OPTIONAL` with console-api refusing admin routes unless the caller has TOTP enrolled. | Cognito MFA is a pool setting with no per-group requirement [infer from the API shape]. |

## 1. §2 Verified principal: gateway side

### 1.1 Evidence

| Question | Answer | Label |
|---|---|---|
| Can `x-api-key` be allowlisted on a target? | Yes. It is not on the restricted list (which includes `Authorization`, `Cookie`, `Content-*`, `X-Forwarded-*`, `X-Amzn-*` except `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*`). Rules: ≤ 10 request headers per target, names `^[a-zA-Z0-9_-]+$`, **values ≤ 4 KB, printable ASCII**. "Headers provided in API keys … cannot be configured": this concerns an `API_KEY` credential provider on that target; the router target uses `GATEWAY_IAM_ROLE` [code]. | [doc] header page |
| Forwarded unchanged? | Not stated. Allowlisted headers arrived as sent in the 11-04 spike V3 (other names) [code: spike-findings]. Two places could drop or alter it: the gateway (if it consumes `x-api-key` as a credential) and the private REST API (`x-api-key` is REST's API-key header; `apiKeyRequired` is off on our method). | [spike S1] |
| Does CUSTOM_JWT read `x-api-key`? | Possibly. The inference-target guide shows the Anthropic SDK with `api_key="<gateway-auth-token>"`, and that SDK sends `x-api-key`, not `Authorization`. So the gateway likely accepts the JWT from `x-api-key` on `/inference`. Unknown: precedence when both are present, and whether it strips the header. | [doc] inference provider page; [spike S2] |
| Interceptors on inference targets? | Supported. They use the `http` payload with a base64 body, and can rewrite `model` and inject headers (including `Authorization`). `payloadFilter` can exclude only `RESPONSE_BODY`. Lambda sync limit 6 MB request + response, so a 10 MiB body (13.3 MiB base64) cannot pass. The interceptor is gateway-wide, so it would also sit in front of the `bedrock` fallback. **Rejected.** | [doc] interceptors config / examples |
| Auth-code user tokens pass `allowedClients` + `allowedScopes`? | Expected yes. Cognito access tokens carry `client_id`, `scope`, `token_use=access`, `sub`, `cognito:groups`, `username` and no `aud`. Custom scopes appear only for tokens from the OAuth endpoints (authorize/token), **not** from `InitiateAuth`. The gateway lists `client_id` and scopes among the claims it checks. | [doc] access token, scopes, auth-code blog; [spike S4] |
| Identity reaching the router today | Gateway role only (SigV4 hop); `x-router-caller-arn` is set by API Gateway [code: stack.ts, inbound.ts]. | [code] |
| Cognito revocation | `AdminUserGlobalSignOut` revokes refresh tokens and Cognito-API use of access tokens; "other requests might be valid until your user's token expires". The gateway and the router keep accepting the JWT until `exp`. | [doc] |
| Gateway rules | Up to 20 rules; conditions `matchPrincipals` (IAM only, not JWT), `matchPaths` (HTTP targets), `matchModels`; a rule with no conditions is a catch-all; first match per action type. | [doc] rules page |

### 1.2 Bypass and disable-bound analysis (new risks)

- **Direct `bedrock` target.** A concrete fallback-model id (e.g. the Messages fallback) skips the `auto*` rule and is served by the `bedrock` target under the gateway role (dataplane E5c [code]). The router never sees it, so there is no block, no budget and no attribution. A disabled member keeps this until the access token expires.
  - Mitigation 1 (S7): a catch-all rule at priority 1,000,000, `routeToTarget: router`. The router answers concrete ids with `pin-not-allowed`, or serves them when the policy allows them, in both cases after its identity checks.
  - Mitigation 2: `cli` client access-token validity 15–30 min (Cognito minimum 5 min), so even the bypass path is bounded. Trade-off with Codex long sessions: 73 owns the client side.
- **Gateway fallback while the router is down or the circuit is open.** It is served by `bedrock` with no identity checks. This is an accepted degraded mode; the health panel shows fallback counts, and the requests are unattributed.
- **`observe` mode:** disable works only for verified callers, so it is a rollout mode, not a security mode.
- Bound in `require` mode: console disable → `blocks.json` put (≤ 1 s) → router poll (≤ 30 s, S3 strong read-after-write) → 403. **≤ ~35 s**, within the R2 target of 2 min. The console also calls `AdminDisableUser` + `AdminUserGlobalSignOut`, so no new tokens are issued.

### 1.3 Fallbacks if S1/S2 fail (in order)

1. The gateway forwards `x-api-key` but the REST hop drops it → map it explicitly on the integration: `integration.request.header.x-router-identity` ← `method.request.header.x-api-key`. A config-only change; 0d reviews it, since a mapping is the one place a client value becomes a router-trusted header.
2. The gateway consumes or strips `x-api-key` → custom header `x-router-identity` (same 10th slot). Claude Code cannot send a dynamic custom header (only `Authorization`/`X-Api-Key` carry the `apiKeyHelper` value), so it would need a local helper proxy (73).
3. Last resort: per-role gateways. The JWT passthrough idea does not fit: the hop's `Authorization` is SigV4.

### 1.4 Spike plan (0c runs it; user approval needed; no Bedrock spend except S7)

**Where:** a separate stack `llmar-idspike`, built from `spikes/apigw-hop` (V9d) copied to `spikes/identity-hop`, because the spike must cross the same gateway → private REST → NLB → Fargate hop. Changes from V9d:
- gateway `CUSTOM_JWT` on a spike user pool with a domain, resource server `<spike>/invoke`, an M2M client, and a `cli` client (auth code + PKCE, no secret, callback `http://127.0.0.1:<port>/callback`, scopes `openid <spike>/invoke`), with a managed login v2 `CfnManagedLoginBranding` (`useCognitoProvidedValues: true`) for the `cli` client, or S4 has no sign-in page;
- the target's `allowedRequestHeaders` plus `x-api-key`;
- the stub echoes, **in the response body only**, `xApiKey: {present, length, sha256_12}`. It already redacts `x-api-key`, and it never logs the value;
- a `bedrock` connector target for S7.

Region: a deploy parameter (AZ IDs for managed private endpoints, as in V9d). Results go to the gitignored `results/`.

| # | Steps | Pass / record |
|---|---|---|
| S0 gate | V9d gate unchanged, plus: anonymous gateway call; an M2M token for a client not in `allowedClients`; a `cli` access token without the invoke scope; an ID token. | Anonymous 401, the others 401/403. **Stop on any 2xx.** |
| S1 forward | 1) `UpdateGatewayTarget` with `x-api-key` in the allowlist → no ValidationException, and the target stays READY (discovery reruns). 2) Valid M2M `Authorization`, plus `x-api-key` = the same token, on all three paths, stream and non-stream. 3) `x-api-key` lengths of 3,900 and 4,200 bytes (above the 4 KB rule). 4) A header census at the stub (names only): does the gateway add any identity header of its own? | Stub `sha256_12` and `length` equal the client's for (2). Record (3): 4xx at the gateway, or dropped. Record (4). |
| S2 precedence | a) valid `Authorization` + junk `x-api-key`; b) no `Authorization`, valid token only in `x-api-key`; c) `Authorization` = M2M token A, `x-api-key` = user token B; d) valid `Authorization` + expired but signed `x-api-key`. | Record status and stub digest for each. Acceptable outcomes: the gateway authenticates with `Authorization` and passes `x-api-key` through (the router verifies it independently), or it validates `x-api-key` when present (stricter). **Fail:** the stub never sees `x-api-key` when `Authorization` is present → §1.3 item 2. |
| S4 user tokens | Spike user (AdminCreateUser, then set a permanent password). Auth code + PKCE in a real browser once (managed login; `InitiateAuth` tokens lack custom scopes). Decode the token locally and print claim names plus `token_use`, `client_id` equality and the `scope` list, never the token. Call the gateway with it. Then do a refresh-token grant and call again. | Claims present as in §1.1. 200 on both calls. Request with `scope=openid` only → 403. |
| S7 bypass | 1) User token, model = the pinned Messages fallback id, `max_tokens: 1` → record (expected 200 from `bedrock`, under $0.001). 2) Add the catch-all rule (priority 1,000,000 → stub target), repeat. 3) Re-run S1(2) with `auto` to confirm the fallback rule still wins at its priority. | (2): the stub sees the concrete id (rule works), or the gateway rejects it (the target's `models` list limits routing, so look for another control). Record either way. |
| Teardown | `spike.py teardown` + `verify`: target → managed resource gateway → stack (pool, domain, clients, VPC, NLB, VPCE, ECS, log groups). | Verify listing is empty for `llmar-idspike*`. |

Cost: V9d measured $0.15–0.20/h. With about 2 h of deployed time, total **< $1** including S7. S3 (client header behaviour: Claude Code 2.1.318, Codex, SDKs) belongs to 73, and can run against this stack while it is up (stub echo, no spend).

Post-implementation E2E on the real stack, after the router identity module ships in `observe` mode: the log shows `principal.kind=user` with the member's `sub` for Claude Code and Codex calls, which proves end-to-end integrity through the signature check. Then `require` mode: disable → 403 within 35 s; missing `x-api-key` → 401.

## 2. Router JWT verification (module `identity.ts`)

- **Input.** `x-api-key` only, a raw JWT (strip an optional `Bearer `). Reject repeated or comma-joined values (same rule as `inbound.ts` `single()`). Length cap 4,096 bytes (the gateway's value limit).
- **Order in `server.ts`.** After hop auth (step 1) and **before the body is read**. A rejection costs no body read, as with hop auth. The same check goes on the `checkContinue` path.
- **Checks, all required in `require`:**
  1. three base64url segments; header `alg === 'RS256'`, and `kid` present in the key map (no `none`, no HS*);
  2. `crypto.verify('sha256', h.p, key, sig)`, with keys built once per JWKS load via `createPublicKey({ key: jwk, format: 'jwk' })`; only `kty=RSA`, `use=sig`, modulus ≥ 2048 bits, ≤ 10 keys (otherwise keep the last good JWKS);
  3. `iss === https://cognito-idp.<region>.amazonaws.com/<poolId>`;
  4. `token_use === 'access'`;
  5. `exp > now − 30 s` and `iat < now + 30 s`, plus `nbf` if present. 30 s leeway: Fargate uses Amazon Time Sync, and the gateway has already checked `exp`;
  6. the scope list contains `<prefix>/invoke`;
  7. no `client_id` allowlist (design v1 0.4: the router mirrors the scope-only gateway); `client_id` is recorded, not checked.
- **Principal.**
  - `{ kind: 'client', id: client_id }` when `sub === client_id` and there is no `username` (Cognito M2M tokens);
  - otherwise `{ kind: 'user', id: sub, client: client_id }`;
  - on failure `{ kind: 'none', reason }`.
  - Ids only: no username, e-mail or groups in the log.
- **Cache.** `Map<signatureSegment, {principal, exp}>`, LRU of 10,000 entries, evicted at `exp`. The block list is checked on every request, after the cache, so a block applies to cached tokens too. Cost: hit ~1 µs; miss p50 34 µs / p99 49 µs [bench: Node 24.20, arm64, 2048-bit key, 865-byte token]. Well inside the ~1 ms p99 budget.
- **JWKS delivery.** `jwks-sync` Lambda in RouterStack, outside the VPC (it needs `cognito-idp` over the internet). It runs at deploy (custom-resource trigger) and hourly (EventBridge schedule, about 720 invocations a month), fetches `<issuer>/.well-known/jwks.json`, validates it, and writes `identity/jwks.json` only when it changed.
  - The router polls it every 30 s with `If-None-Match`, alongside `config/active.json` and `identity/blocks.json`; boot reads it once.
  - No request-time fetch: the router has no internet, and a PrivateLink endpoint for user pools covers API operations, not the issuer's JWKS [infer].
- **Rotation.** Cognito "might rotate" keys [doc]; the JWKS lists all active keys, and the router swaps its key map atomically.
  - Unknown `kid` → reason `identity-kid-unknown`, EMF `Alerts{AlertReason=identity-kid-unknown}`, and an alarm. The console's "refresh keys" action invokes `jwks-sync`.
  - In `require`, an unknown `kid` → 401 (Claude Code re-runs `apiKeyHelper` on 401, which does not help, so the alarm matters).
- **Modes** (env `ROUTER_IDENTITY_MODE`; later the config document `identity.mode`):
  - `off`: the header is never read.
  - `observe`: verify, log `principal`, never reject on missing or invalid; **blocks still apply to verified principals** (403).
  - `require`: missing/invalid → 401 `{code: identity-*}`, blocked → 403 `identity-blocked`, budget → 429 `budget-exceeded`.
  - All are 4xx, so the gateway fallback (5XX/connection) never serves a rejected caller [code: stack.ts fallback triggers].
  - JWKS unavailable in `require` → 401 `identity-keys-unavailable` + alarm. Never 503: a 503 would trigger the fallback bypass.
- **`RequestLog`.**
  - Add `principal?: { kind: 'user'|'client'|'none'; id?: string; client?: string; reason?: string }`, set on every line after hop auth, including `rejected`.
  - EMF: no principal dimension (cardinality). Add `IdentityRejects` with dimension `IdentityReason` (bounded codes) and the alert above.
  - Existing hygiene holds: `x-api-key` is not in `LOGGED_HEADERS` or `UPSTREAM_HEADERS`, and the sentinel test in `server.test.ts` already covers it [code]. Add a test that no error message or log line contains any JWT segment.
- **Codes.** `identity-missing`, `-malformed`, `-alg`, `-kid-unknown`, `-signature`, `-expired`, `-issuer`, `-token-use`, `-scope`, `-client`, `-blocked`, `-keys-unavailable`, `budget-exceeded`.
- **Block list format.** `{ schemaVersion, etag, principals: [{kind, id, reason: 'disabled'|'admin', at}] }`, held in a `Set` keyed by `kind:id`. The console removes an entry on re-enable.
- **Principals map** (design v1 0.16). `identity/principals.json` `{ "<kind>:<id>": { group, cap? } }`, console-written, polled with the block lists. It is the only source of `principal.group` and per-principal caps: the router never authorizes from `cognito:groups`, which lags by up to the token lifetime.

## 3. §4 Usage ingest

- **Source.** One subscription filter on the router log group (up to 5 per log group [doc]):
  `{ $.kind = "model" || $.kind = "error" || $.kind = "rejected" || $.kind = "config" }` (design v1 §2.3; ingest ignores kinds it does not store).
  - It matches the request lines, not the EMF documents, which have no `kind` [code: account.ts `emit`].
  - Delivery: usually under 3 minutes; on retryable destination errors CloudWatch Logs retries for up to 24 h; on non-retryable errors (e.g. AccessDenied) the filter is disabled for up to 10 min and **logs are skipped** [doc].
- **`usage` table** (on-demand, TTL attribute `ttl`, SSE owned key, PITR off: data rebuildable within the log retention window).

| Item | pk | sk | Notes |
|---|---|---|---|
| Request record | `P#<kind>:<id>` | `T#<ts>#<reqId>` | The R4 fields from the log line plus 0d's counterfactual costs. Costs as integer nano-USD so sums reconcile exactly with `costUsd` (DynamoDB numbers are exact decimals). `ttl` = ts + retention (default 90 d). About 1–1.5 KB. |
| GSI1 "all by day" | `D#<yyyy-mm-dd>` | `<ts>#<reqId>` | Admin list. INCLUDE projection of the list columns only (≈ 0.4 KB). Shard as `D#<day>#<n>` only above ~300 rps. |
| GSI2 "session" (sparse) | `S#<kind>:<id>#<session>` | `<ts>#<reqId>` | The principal is in the key, so a member query is scoped by construction; the server builds the key from the token, never from a parameter. |
| Rollup per principal | `U#<kind>:<id>#<yyyy-mm>` | `<dd>#<dialect>#<servedModel>#<tier>` | One item per day (the sk starts with `<dd>`), so these are the daily rollups: `ttl` 400 days (design v1). `ADD` counters: requests, errors, rejects, token classes (uncached, cacheRead, cacheWrite5m/1h, output), cost, baseline costs per baseline, assessor cost, switches, misses, failovers. Member pages and budgets. |
| Rollup admin | `A#<yyyy-mm>` | `<dd>#<kind>:<id>#<dialect>#<servedModel>#<tier>` | One query per month for the overview; bounded (principals × models × tiers × days); `ttl` 400 days. |
| Budget total | `B#<kind>:<id>#<yyyy-mm>` | `TOTAL` | O(1) spend check (R7, if it ships). |

- **Idempotency.** `reqId` is a per-request UUID [code: server.ts]. Per Lambda event:
  1. parse and validate the lines (unknown `schemaVersion` → DLQ);
  2. chunk ≤ 20 requests;
  3. per chunk, one `TransactWriteItems`: a `Put` for each record with `attribute_not_exists(pk)`, plus `Update ADD` per distinct rollup key, with deltas aggregated inside the chunk (an item may appear only once per transaction; ≤ 100 items);
  4. on `TransactionCanceled` with `ConditionalCheckFailed`, drop the duplicate requests named in the cancellation reasons and retry the rest; on `TransactionConflict`, retry with jitter (rollup items are hot when Lambdas run concurrently).

  A retried batch therefore never double-counts.
- **Failure handling.**
  - Function errors after in-handler retries → throw. CloudWatch Logs re-delivers; the subscription invokes Lambda asynchronously [infer; confirm when deploying].
  - Async config: `maximumRetryAttempts: 2`, `maximumEventAge: 6 h`, `onFailure` → SQS DLQ (SSE-SQS, 14-day retention).
  - Alarms: DLQ depth > 0, function `Errors` > 0, subscription `DeliveryErrors`.
  - `replay-dlq` script: re-invoke with the stored `awslogs` payload. Safe because ingest is idempotent.
  - Drift check on the health panel: the EMF `Requests` sum per day vs the `A#` rollup `requests`.
- **Budgets (if R7 ships).** After a chunk commits, read `B#…` for each principal touched. If it is over the hard limit, ingest rewrites `identity/budget-blocks.json`, its own object and its only S3 write. Lag ≤ ingest delay (≤ 3 min) + 30 s poll. The R2 bound does not apply to budgets; document a "soft, minutes" bound.
- **Batch sizes.** CloudWatch Logs decides the events per invocation; the handler must accept 1..N. Memory 256 MB, arm64, Node 24, timeout 60 s, reserved concurrency unset.

## 4. §6 / §8 Console infra

### 4.1 Stack shape

- **RouterStack (changes)**:
  - `cli` app client: auth code + PKCE, no secret, loopback callbacks, scopes `openid <prefix>/invoke`, access token 15–30 min, refresh 30 d (enable refresh-token rotation if available in the region, [infer]);
  - gateway `allowedClients` plus `cli` (or D-a3-1 below);
  - config/identity bucket: versioned, BPA on, SSE-S3, `enforceSSL`; bucket policy denies `s3:GetObject` to the task role unless `aws:SourceVpce` is our S3 gateway endpoint;
  - `jwks-sync` Lambda + schedule; the task role reads `config/*` and `identity/*`;
  - target `allowedRequestHeaders` plus `x-api-key`;
  - catch-all rule (S7);
  - router env `ROUTER_IDENTITY_*`;
  - SSM parameters `/<prefix>/router/{userPoolId,userPoolArn,logGroupName,configBucket,gatewayId,serviceArn}`.
- **ConsoleStack (new, same app, deployed after RouterStack, destroyed first)**:
  - values read with `ssm.StringParameter.valueForStringParameter` (resolved at deploy, no export lock);
  - groups `admin` and `member`;
  - the `console` app client (auth code + PKCE, callback = CloudFront URL, scopes `openid <prefix>/console`; no invoke scope);
  - resource-server scope `<prefix>/console`;
  - tables `console` and `usage`; Lambdas `console-api` and `usage-ingest`; the subscription filter (behind context flag `ingest`; the SPA upload behind `consoleBundle`, see §4.4); DLQ; HTTP API; S3 site bucket + CloudFront.
- **D-a3-1 (decide, 0d reviews).** Service clients (R7) need the gateway to accept new client ids.
  - (a) The console calls `UpdateGateway` → CloudFormation drift, and the console holds a gateway write permission. Not recommended.
  - (b) The gateway checks `allowedScopes` only. Only clients that an admin created with the invoke scope can obtain it, and the console client never gets it. **Recommended**; the router mirrors it.
  - (c) No service clients in release 1.

### 4.2 Cognito changes (cdk-nag acks become false)

- Existing acks COG2/COG3/COG8 say "no human users". Once members exist that is untrue, so rewrite them [code: stack.ts acks].
  - COG2 (MFA) is satisfied with MFA `ON`/TOTP (A10).
  - COG3/COG8 (threat protection needs Plus): ack with the reason "small invited team, no self sign-up; Plus is a deploy option".
- Password policy is already strong. Admin-created users only (`AdminCreateUser`, invite e-mail through the Cognito default sender; SES only if volume requires it).

### 4.3 HTTP API, Lambdas, IAM

- **HTTP API.**
  - JWT authorizer: issuer = pool, audience = [console client id]. Cognito access tokens have no `aud`, and HTTP API matches `client_id` instead (docs, "evaluation" section; covered by the S0-style console check in §4.4).
  - Every route requires the scope `<prefix>/console`, so ID tokens and router tokens are refused.
  - No `$default` route. Stage throttling (e.g. rate 20, burst 40).
  - Access logs to a log group (HTTP API needs no account-level role, so APIG1 is satisfied rather than acked). Do not log `$context.authorizer.claims.*`.
  - CORS: `allowOrigins` = the CloudFront domain only; headers `authorization`, `content-type`.
- **Authorization in `console-api`.**
  - Group from `requestContext.authorizer.jwt.claims['cognito:groups']`. HTTP API flattens array claims into a string like `[admin member]`, so parse it defensively and test both shapes.
  - `/admin/*` → `admin`.
  - `/me/*` → the principal is taken from `sub`/`client_id` only.
  - With A10 `OPTIONAL`: admin routes call `AdminGetUser` and require `SOFTWARE_TOKEN_MFA` (cached 5 min).

| Lambda | Allowed (resources pinned) | Not allowed |
|---|---|---|
| `console-api` | `cognito-idp:` `AdminCreateUser, AdminGetUser, ListUsers, AdminDisableUser, AdminEnableUser, AdminDeleteUser, AdminUserGlobalSignOut, AdminResetUserPassword, AdminAddUserToGroup, AdminRemoveUserFromGroup, AdminListGroupsForUser, ListUsersInGroup` on the pool ARN. Plus, if R7: `CreateUserPoolClient, DeleteUserPoolClient, DescribeUserPoolClient, ListUserPoolClients` (code allowlist: never touch the `agent`/`cli`/`console` clients, which IAM cannot express). DynamoDB `GetItem, PutItem, UpdateItem, Query, TransactWriteItems, ConditionCheckItem` on `console`; `GetItem, Query, BatchGetItem` on `usage` + indexes. S3 `PutObject, GetObject` on `config/active.json`, `config/versions/*`, `identity/blocks.json`, `identity/principals.json`. `bedrock-agentcore:GetGateway, ListGatewayTargets, GetGatewayTarget, ListGatewayRules, GetGatewayRule` on this gateway. `ecs:DescribeServices` on the router service. `cloudwatch:GetMetricData` on `*` (no resource-level support, IAM5 ack). `lambda:InvokeFunction` on `jwks-sync`. | Any Bedrock invoke, `UpdateGateway*`, `iam:*`, `UpdateUserPoolClient` (it could add callback URLs to the `cli`/`console` clients), S3 delete, `identity/jwks.json` (written only by `jwks-sync`). |
| `usage-ingest` | DynamoDB `PutItem, UpdateItem, TransactWriteItems, ConditionCheckItem, GetItem` on `usage`; `GetItem, Query` on `console` with `ForAllValues:StringLike` `dynamodb:LeadingKeys` = `MEMBER#*` (budget limits; design v1 §2.3); `sqs:SendMessage` on its DLQ; S3 `PutObject` on `identity/budget-blocks.json` (R7 only). Resource policy: `logs.amazonaws.com` with `SourceArn` = the router log group and `SourceAccount`. | Any other `console` partition, writes to `console`, Cognito, everything else. |
| `jwks-sync` (RouterStack) | S3 `GetObject, PutObject` on `identity/jwks.json`. | Everything else. |
| Router task role (add) | S3 `GetObject` on `config/active.json`, `identity/*`. | Writes. |

- Log groups: explicit, one week retention, `RemovalPolicy.DESTROY`. Use explicit log policies rather than the managed basic execution role (avoids IAM4).

### 4.4 Static site, deploy ordering, anonymous-denial checks

- **Site bucket.** BPA all on, `enforceSSL`, SSE-S3, versioning off, no website hosting. CloudFront with `S3BucketOrigin.withOriginAccessControl`, default root `index.html`, SPA error mapping 403/404 → `/index.html`.
  - Response-headers policy: HSTS; a CSP with `default-src 'self'; connect-src 'self' <api> <cognito domain>; frame-ancestors 'none'`; `X-Content-Type-Options`.
  - The bundle holds no data and no secrets (pool id, client id and API URL are public configuration), so ungated delivery is fine; the data sits behind the API.
- **Deploy order** (builder-security: verify anonymous denial before restricted content exists):
  1. RouterStack changes (identity `observe`).
  2. ConsoleStack with context `consoleBundle=false` and `ingest=false`: no BucketDeployment and no subscription filter exist yet. The tables are empty and no users exist. Every interactive client (`console`, `cli`, optional `console-local`) has its own `CfnManagedLoginBranding` (`useCognitoProvidedValues`).
  3. Run the check script:
     - every route in the route table, unauthenticated → 401;
     - junk bearer → 401;
     - ID token → 401/403;
     - router M2M access token → 401/403;
     - member access token on every `/admin/*` route → 403;
     - an undefined path → 404;
     - S3 REST URL for `index.html` → 403;
     - `GetBucketPolicyStatus` `IsPublic=false` and `GetPublicAccessBlock` all true;
     - `ListFunctionUrlConfigs` empty for every console Lambda;
     - CloudFront `/index.html` → 200.

     **Stop on any 2xx with data.**
  4. Create the first admin from the CLI with operator credentials (never through an unauthenticated path).
  5. Redeploy with `consoleBundle=true` (uploads the SPA), then `ingest=true`. Usage data starts flowing only now.
- **Teardown** (ConsoleStack first, then RouterStack):
  - tables `RemovalPolicy.DESTROY`, `deletionProtection: false`;
  - site bucket `autoDeleteObjects` (custom resource; ack its IAM4/IAM5/L1 findings) or an emptying script;
  - CloudFront disables, then deletes (minutes);
  - subscription filter, DLQ, Lambdas and log groups go with the stack; SSM parameters go with RouterStack.
  - Verification listing: no `<prefix>-console*` Lambdas, tables, queues, log groups or HTTP APIs, and no distribution with the stack tag; the config bucket is gone with RouterStack.

### 4.5 cdk-nag findings to expect

| Finding | Handling |
|---|---|
| COG2 / COG3 / COG8 | MFA ON satisfies COG2; COG3/COG8 acked with a new reason (§4.2). Remove the old "no human users" reasons. |
| APIG1 / APIG4 | Satisfied (access logs; JWT authorizer). |
| CFR1 (geo), CFR2 (WAF) | Ack (team console, JWT-gated API; WAF optional, D1). |
| CFR3 (CloudFront logs) | Enable standard logging v2 to CloudWatch Logs, or ack. |
| CFR4 (TLS min with the default certificate) | Ack unless a custom domain + ACM certificate is configured (then TLSv1.2_2021). |
| S1 (server access logs) | Ack for the site bucket (static, CloudFront-only); enable on the config bucket (cheap, audit value). |
| DDB3 (PITR) | On for `console`; ack for `usage` (rebuildable from the logs within retention; TTL data). |
| IAM5 | `cloudwatch:GetMetricData` `*`; `config/versions/*`; DynamoDB index ARNs `/index/*`. Each acked with its exact finding. |
| L1 | Node 24 runtime. |
| SQS3/SQS4 | The DLQ is itself a DLQ (SQS3 n/a); `enforceSSL: true` (SQS4). |

## 5. §9 Cost (list prices, us-east-1 used as a reference; the region is a deploy parameter and prices vary a little)

Assumed unit prices: Lambda arm64 $0.20/M requests + $0.0000133/GB-s; DynamoDB on-demand $0.625/M WRU, $0.125/M RRU, storage $0.25/GB-month, PITR $0.20/GB-month; HTTP API $1.00/M; S3 GET $0.0004/1k, PUT $0.005/1k; CloudFront always-free tier 1 TB + 10M requests; alarms $0.10 each. 0c should confirm them with the pricing API before publishing.

| Item | Idle per month | Per unit |
|---|---|---|
| Router polling 3 objects / 30 s / task | ≈ $0.10 per task | none |
| `jwks-sync` hourly | ≈ $0 | none |
| DynamoDB storage | cents | 90-day records ≈ 1.5 KB × requests retained |
| CloudFront, HTTP API, Lambda, SQS | $0 | console call ≈ $1/M (HTTP API) + ~$0.7/M (Lambda 512 MB, 100 ms) + reads, about $2–3 per million console calls |
| Alarms (~6) | ≈ $0.60 | none |
| Cognito Essentials | $0 under the MAU free tier (verify the current tier on the pricing page) | M2M: per successful token request (per-client charge removed in Nov 2025 [doc]); user tokens: MAU only |
| WAF on CloudFront (optional) | ≈ $5 + $1/rule | $0.60/M requests |
| **Ingest per million router requests** | none | DynamoDB ≈ 12 WRU/request (record 2 + rollups 3, all ×2 transactional, + GSIs 2) ≈ **$7.5**; Lambda ≈ $0.1; storage ≈ $0.4/month while retained. **≈ $8 per million**, under 0.1% of the Bedrock spend for the same requests. A non-transactional variant is ≈ $3/M but loses exactness. |

Idle total ≈ **< $1/month** without WAF.

## 6. Open risks

1. **S1/S2 unknowns** (the gateway may consume `x-api-key`; the REST hop may drop it). Fallbacks in §1.3; item 2 there needs a client-side proxy for Claude Code.
2. **Bypass via the concrete-id `bedrock` route** until S7 shows the catch-all works. Until then the disable bound for that path = access-token lifetime.
3. **Fallback while the router is down** serves blocked members (accepted, documented, counted).
4. **The last header slot is used** (10/10). Any future forwarded header needs a slot freed first, e.g. merge `x-session-id` into `x-router-session` (73).
5. **JWKS staleness** (rotation between syncs) → 401s in `require`. Mitigations: hourly sync, alarm, the console button.
6. **Integrity of `identity/*`.** Whoever can write `jwks.json` can mint router identities. The gateway still authenticates against the real JWKS, so the impact is attribution, blocks and budgets. Writers: the `jwks-sync` role only (jwks); console-api only (blocks). Enable S3 access logs on the bucket.
7. **Subscription "disabled 10 min, logs skipped"** on non-retryable errors (e.g. a broken Lambda resource policy) → gaps in usage. The drift check and alarm catch it, and the gap can be rebuilt from the logs within retention (one week today: consider 30 days if the console ships).
8. **Cognito MFA granularity** (A10). If the user wants member MFA optional, the admin-MFA check moves into console-api.
9. **Codex and short access tokens.** 15–30 min tokens worsen Codex's start-time token read (73 owns the helper proxy).
10. **HTTP API array-claim format** (`[a b]`): test it, or add groups as scopes with a pre-token-generation V2 trigger (Essentials) if parsing proves brittle.

## 7. Evidence

- Header propagation, restricted headers, limits: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-headers.html
- Inference provider targets (Anthropic SDK `api_key=` example, routing, streaming): https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-inference-provider.html
- Interceptor config (`passRequestHeaders`, `payloadFilter` excludes `RESPONSE_BODY` only, 6 MB): https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-configuration.html
- Interceptors on inference targets (`http` payload, base64 body, model rewrite): https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-examples.html
- Gateway rules (catch-all, conditions, limits): https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-rules.html
- CustomJWTAuthorizerConfiguration (allowedClients/Scopes/Audience, customClaims): https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-runtime-customjwtauthorizerconfiguration.html
- Auth-code flow with the gateway (claims checked): https://aws.amazon.com/blogs/machine-learning/building-a-secure-auth-code-flow-setup-using-agentcore-gateway-with-mcp-clients/
- Cognito access token / scopes (custom scopes only from the OAuth endpoints): https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html, https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html
- Verifying JWTs, key rotation, kid caching: https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
- AdminUserGlobalSignOut semantics: https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminUserGlobalSignOut.html
- Cognito what's new (M2M per-client charge removed; PrivateLink for user pool APIs): https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-whats-new.html
- Subscriptions (delivery latency, 24 h retry, skip on non-retryable, 5 filters per log group): https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Subscriptions.html
- HTTP API JWT authorizers (scopes, evaluation): https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
- Repo: `infra/src/stack.ts` (headers 9/10, fallback triggers, nag acks), `packages/router/src/{server,inbound,account,forward,config}.ts`, `docs/tasks/11-04-gateway-frontdoor-spike/research/spike-findings.md` (V3 header forwarding), `spikes/apigw-hop/` (V9d harness), dataplane design §5.4 and E5c.
- Benchmark: a scratch script outside the repo (`node:crypto` RS256, 20k verifies / 200k cache hits); not committed.
