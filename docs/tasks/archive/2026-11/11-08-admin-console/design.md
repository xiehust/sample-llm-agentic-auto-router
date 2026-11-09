# Admin console: design (v1, 0c, 2026-11-08)

Integrates the peer research in `research/` (normative for their sections unless this file overrides them):
a3 `a3-identity-infra.md` (identity, ingest, infra, IAM, cost), 0d `0d-savings-hotswap.md` (savings, hot swap),
73 `73-assessor-decisions.md` + `decision-codes.json` (assessor runtime, pack manifest, code labels),
17 `17-clients-cli-login.md` (client headers, `llmar` CLI), 18 `18-frontend-stack.md` (SPA), 4f `4f-ia-copy.md` +
`i18n/` (pages, copy, Get started). User decisions: D1 = option A (internet-reachable behind Cognito sign-in);
D2 = budgets, service clients and per-principal tier limits in the first release; what-if replay later.

## 0. Decisions (0c, resolving the peer open points)

| # | Decision | Source |
|---|---|---|
| 0.1 | Verified principal: the client re-sends its Cognito access token in `x-api-key`; the router target allowlists it (10th header); the router verifies it in process (RS256, `node:crypto`, JWKS from S3). No interceptor. The router accepts the value with or without a `Bearer ` prefix (Codex header delivery adds it). Fallbacks a3 §1.3; **risk:** fallback 2 (gateway drops `x-api-key` → `x-router-identity`) leaves Claude Code with no attribution path (it cannot send a dynamic custom header, and a local injecting proxy is rejected as home-made auth), so if S2 lands there 0c brings the trade-off (unattributed Claude Code vs per-role gateways) back to the user. **Gated by spike C1.** | a3 A1–A3, 17 §2.1 |
| 0.2 | Identity mode `off \| observe \| require`, default `observe` for rollout; disable/budget bounds hold only in `require` (≤ ~35 s). The console warns before `require` while unattributed traffic exists. | a3 A4–A5, 4f |
| 0.3 | Gateway: catch-all lowest-priority rule → router, so concrete model ids also pass the router's identity checks (spike S7); `cli` access tokens 30 min. | a3 A6 |
| 0.3d | Spike C1 (research/c1-spike-results.md): the gateway authenticates `Authorization` only and forwards `x-api-key` as sent, so the router verifies it (0.1 confirmed; no fallback header). Codex attributed long sessions need two sign-ins (0.13). The production `BedrockTarget` gets `allowedRequestHeaders` without `x-api-key` (`anthropic-version`, `anthropic-beta`, `openai-beta`), or every gateway fallback for a request carrying `x-api-key` fails with 400 — this also fixes the fallback for today's Claude Code clients. | 0c |
| 0.3a | Concrete model ids reaching the router are treated as pins in both modes: in the policy and within the caller's cap → served; in the policy but above the cap (and not in `allowPins`) → 400 `access-cap`; not in the policy → 400 `pin-not-allowed` (checked first). This changes observe mode: today observe evaluates concrete requests (wouldChoose, assessor audit); from now on they are pins in both modes, with no evaluation and no assessor call. Reason: auto would pin them, so an observe projection for them would describe something auto never does, and the assessor calls cost money without actionable data. Decide/observe tests updated in C3. | 0c (owner 0d) |
| 0.3b | Health panel: the gateway publishes no fallback metric (E7b), so gateway-fallback calls are not counted; the panel shows router 5xx, unhealthy targets and task count as the proxy, with a caption. The "Applying…" state ends when a router `config` line reports the new `principalsVersion` / blocks etag. UI language is a `localStorage` preference. | 0c |
| 0.3c | Streams with no usage event at all (Harbor summary §4.2, §5 item 6) are no longer logged as $0: the router logs `usageMissing: true` and a separate top-level `costBoundUsd` (no `costUsd`, so `costUsd` present still means metered and EMF `CostUsd` is unchanged). Approximate bound: core's `estPromptTokens` × max(input, every cache-write rate), long-context prices when the estimate exceeds 0.9 × the threshold, plus the request's output cap × output price; with no output cap the output term is omitted and `boundPartial: true` is logged. The estimate (chars/4) can undercount, e.g. CJK text, so the UI calls it approximate. Partial usage keeps today's priced path. Ingest shows unmetered calls separately (count, bound) and excludes them from savings (0d §1.3; fixture F5b). In C3, router part. | 0d (review a3) |
| 0.4 | Gateway authorizer becomes **scope-only** (`allowedScopes: [<prefix>/invoke]`, no `allowedClients`), so service clients need no gateway update. The router mirrors it (scope-only: `iss` = pool, `token_use=access`, scope `<prefix>/invoke`, `exp`/`nbf`, plus the block lists), so creating or deleting a service client writes no config version. The console client never gets the invoke scope; only admins can create pool clients. Verified by spike S0. | a3 D-a3-1 |
| 0.5 | Cognito: pool MFA **OFF** (user decision 2026-11-08; enabling TOTP MFA is documented as a production hardening step); managed login v2 (zh-CN); clients `agent-m2m` (existing), `cli` (auth code + PKCE, `http://127.0.0.1:<fixed ports>/callback`, scopes `openid <prefix>/invoke`), `console` (auth code + PKCE, scope `<prefix>/console`, access 15 min, refresh 8 h, rotation). Every interactive client (`console`, `cli`, optional `console-local`) gets a `CfnManagedLoginBranding` style (`useCognitoProvidedValues`), or it has no sign-in pages; the spike pool too. Loopback callbacks use `http://127.0.0.1:<port>`. | a3 A10, 17 §3.2, 18 §2.2 |
| 0.6 | SPA: React 19 + Vite + Cloudscape (classic charts only; no Highcharts-based package), oidc-client-ts, tokens in sessionStorage (memory as deploy option), typed dictionaries + intl-messageformat, strict CSP. | 18 |
| 0.7 | API **same-origin**: CloudFront `/api/*` → HTTP API (JWT authorizer + `<prefix>/console` scope), default behavior → private S3 (OAC, BPA on). No CORS. Group checks per route in the Lambda. Overrides a3 A9. | 18 §4.3 |
| 0.8 | Separate `ConsoleStack` in the same app; router-side additions stay in `RouterStack`; values via SSM. Two tables: `console` (PITR) and `usage` (TTL). | a3 A7–A8 |
| 0.9 | Hot swap = new `Engine` over the same `StateStore`, one `ActiveConfig` generation snapshot per request (policy + engine + assessor). The router never rejects on a diff (boot has no previous version; rollback must always work), but it **does reject, keeping the last good config,** a document that fails intrinsic validation or the checks that depend on the running image: unknown pack name, assessor model not in the catalog or without an adapter, auto + autoRules `pack` with no auto rule. IAM-universe membership is checked by the console only (failure mode: assessor `unavailable`, not an outage). The console shows `policySwapEffects(prev, next)` and asks to confirm disruptive changes. Fix first: boot-time allowed set (`server.ts:98/:211`) and observe-default per call (`decide.ts:100`). | 0d §2, 73 A3 |
| 0.10 | Pins of a model the admin removed: immediate 400 (access semantics). | 0d open 2 |
| 0.11 | Savings: 0d §1 as frozen: static baseline by default (also tier:standard, tier:frontier, observe-default); `R = B − A*`, `S = A − A*`, `N = B − A − X`; negative shown; router adds `catalogVersion` and `switchedFrom`; core adds `decision.projected` (carry-forward) and the projection is shown, labelled indicative; prompt-cache KPI `Cnet` separate. | 0d §1, open 1/3/4 |
| 0.12 | Assessor runtime: mode/pack/model/threshold/timeoutMs/autoRules editable; packs preloaded at boot; one pure `validateAssessorSettings` shared with the console; settings fingerprint in the id passed to core; `AssessorLog.packVersion`; committed pack manifest + golden test; packs archive in S3 for old records. | 73 A1–A7 |
| 0.13 | Clients: Claude Code unchanged (`apiKeyHelper` sends both headers), `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=240000`. Codex: `env_http_headers` carries only `x-router-session` (an env `x-api-key` stays the start-time value and expires after 30 min); attributed sessions use `auth.command` (`refresh_interval_ms=240000`) + `gateway_oauth` delivering `x-api-key` (two sign-ins), or a single `gateway_oauth` on `x-api-key` if S2 shows the gateway authenticates `x-api-key` alone (S2 tests a `Bearer `-prefixed value); Codex's `redirect_port` must be one of the `cli` client's registered 127.0.0.1 callbacks. SDKs: the verified `Auth` recipe on `httpx2` (anthropic 2.x / openai 3.x; `httpx` only for older SDKs), both headers per request. Anthropic `credentials=` not documented until the oauth beta is handled. README's `3000000` TTL is replaced in C9. | 17 §2–3 |
| 0.14 | `llmar` CLI: one Python-stdlib file (`login/token/status/logout`), credentials file 0600 + flock, token cache with 5-min margin, exit 2 on `invalid_grant`. | 17 §3 |
| 0.15 | Budgets and blocks: ingest writes `identity/budget-blocks.json`, console writes `identity/blocks.json`; router polls both (30 s); answers 403 `identity-blocked` / 429 `budget-exceeded`; never 5xx (a 5xx would trigger the gateway fallback, which bypasses the router). | a3 A5, 17 §3.6 |
| 0.16 | Per-principal tier limits: group default caps in the config `access.groups` block (versioned); principal → group and per-principal cap overrides in `identity/principals.json` (console-written on member/group/cap changes, polled 30 s like the block lists, ≤ ~35 s). The router never authorizes from the token's `cognito:groups` claim (it lags up to the token lifetime). The resolved cap is passed to core per request as `DecideExtras.cap` from the generation snapshot. `maxTier` is a candidate filter inside `evaluate()` and holds at hard locks like any swap (never a post-hoc clamp); pins are checked immediately (access semantics, as 0.10). Frozen semantics: `allowPins` absent → a pin is allowed when its tier ≤ `maxTier`; a listed pin is allowed above `maxTier`; the cap also applies to observe-served, `wouldChoose` and `projected` models; nothing within the cap fits the gate → 400 `access-cap-context` (never 5xx); precedence principal > group > none. Capped decisions carry reason key `access-cap` and get their own savings row (a cap's forced downgrade is not a routing saving). | 0d |

## 1. Topology

```
browser ─HTTPS─> CloudFront ─┬─ /*      ─OAC─> S3 (SPA bundle + config.json; no data)
                             └─ /api/*  ─────> HTTP API (JWT: pool, scope <prefix>/console)
                                                 └─> console-api Lambdas ─> DynamoDB console/usage, Cognito admin (this pool),
                                                                            S3 config bucket (config/, identity/), AgentCore Get/List,
                                                                            CloudWatch GetMetricData
router task (ECS, no internet) ─poll 30 s (S3 gateway endpoint)─> config/active.json, identity/{jwks,blocks,budget-blocks,principals}.json
router stdout ─> CloudWatch Logs ─subscription (model, error, config, boot lines)─> usage-ingest ─> DynamoDB usage (+ SQS DLQ)
jwks-sync Lambda (hourly) ─> identity/jwks.json      member CLI: llmar login (PKCE, 127.0.0.1) → llmar token → tools
```

## 2. Contracts (frozen at review; owners keep them in sync)

### 2.1 Config document `config/active.json` (owner 0d, assessor block 73)
`{ schemaVersion: 1, version: "<n>-<author-ts>", policy: Policy, assessor: { mode: off|observe|auto, pack,
packVersion, model, threshold, timeoutMs, autoRules } (one shape; fields kept and ignored when off, so off →
observe restores them; `packVersion` lets the router detect pack drift after an image deploy: warn and apply),
identity: { mode }, access: { groups: { admin|member|service: Cap } } }`, `Cap = { maxTier?: Tier, allowPins?:
string[] }`. Separate, unversioned objects polled every 30 s and taken into the same per-request snapshot:
`identity/jwks.json` (jwks-sync), `identity/blocks.json` (console), `identity/budget-blocks.json` (ingest),
`identity/principals.json` (console: `{ "<kind>:<id>": { group?: admin|member|service, cap? } }`). A generation is `(configVersion, principalsVersion)`; a principal naming a group missing from `access.groups` gets no cap and a logged issue code (not a rejection). The console validates image-dependent checks against the manifest of the image ECS reports as running (rolling deploys may briefly mix images). Blocks, budget blocks and JWKS are separate objects (different writers, no version churn). Precedence: document
over env; the CDK-baked policy only when the object is absent, as `configVersion: "0-baked"` (seeded in the
console table). Versions are ordered by the parsed integer `n`, never by string compare. The router logs
`kind: "config"` on every activation and rejection (`configVersion`, `status`, issue codes, `assessor{mode, pack,
packVersion, model, threshold, timeoutMs, autoRules}`, `packs[{name, packVersion}]` bundled in the image,
`drift`), and stamps `configVersion` on every model line; ingest resolves policy and pack per record by
`configVersion` (replaces 0d's policy-unknown rule).

### 2.2 Router log line additions (owners: a3 identity, 0d core fields, 73 assessor)
`principal: { kind: 'user'|'client'|'none', id?, group? }` (group from `principals.json`), `identity: 'verified'|'missing'|'invalid:<code>'`,
`configVersion`, `catalogVersion`, `switchedFrom: { model, warmTokens }` (switch lines),
`decision.projected: { model, switch }` (observe), `assessor.packVersion`. No usernames, e-mails or token
material, ever.

### 2.3 Tables (owner a3; record shape 17 with 0d fixtures)
a3 §3 as written (its `U#`/`A#` rollups are already per day by sort key; they get a 400-day TTL, records 90 days): `usage` record `pk=P#<kind:id>`, `sk=T#<ts>#<reqId>`, GSIs by day and by principal+session;
rollups `U#<principal>#<month>` / `A#<month>` with nano-USD integers; `TransactWriteItems` for exact retries;
TTL 90 days on records. Budgets and caps are keyed `MEMBER#<kind:id>` (members and service clients). Ingest may read `console` items `MEMBER#*` only (`dynamodb:LeadingKeys`) to evaluate budgets. Subscription filter: `kind` ∈ model | error | rejected | config (rejected lines count 401/403/429 per principal); ingest ignores kinds it does not store. `console`: `CONFIG v#<n>`, `ACTIVE`, `AUDIT#<ts>`, `MEMBER#<kind:id>` (budget, caps, notes).

### 2.3a Frozen storage contracts (2026-11-08, after the C5/C6 reviews)
- Config versions: `console` pk `CONFIG`, sk `v#<n>`, attribute `doc` (JSON string of the document; `doc.version` =
  `<n>-<yyyymmddThhmmssZ>`); pointer pk `CONFIG`, sk `ACTIVE`, attribute `version`. The baked boot policy is `v#0`
  (`0-baked`).
- Members, service clients and the default: pk `MEMBER#<kind:id>` (or `MEMBER#default`), sk `PROFILE`, flat attributes
  `status` (active|disabled), `role` (admin|member|service), `budgetMonthlyUsd` (N, or NULL = none), `budgetAlertAt`
  (N, fraction 0–1), `budgetHardStop` (BOOL), `cap` (map, optional). Budget spend = ΣA + ΣX for the UTC month (actual
  cost plus assessor cost), the same figure in the console and in the block decision.
- Router config lines in `usage`: pk `C#config`, sk `<ts>#<task>#<source>` (read with a pk query or begins_with, never an exact sk); sources boot|config|principals|jwks|blocks|budget-blocks; stored fields: source, outcome, attempted, from,
  configVersion, principalsVersion, policyVersion, mode, catalogVersion, issues, warnings, plus pass-through
  lineFields (blocks etag, packs, drift). The console ends "Applying…" when every running task reports the target.
- Identity objects (`identity/blocks.json`, `identity/principals.json`) are regenerated from the table; a failed S3
  put returns 502 `identity-delivery-failed`, is audited, and `admin.identity.republish` repeats it; the console shows
  an "identity delivered" state like config `delivered`.
- Paging cursors: the API checks that a cursor's partition key equals the caller's scope before using it (members
  can never page another principal).
- `A#<month>` account rollups are one partition (fine for team scale; shard by day if write rates approach
  ~1k WCU/s).

### 2.4 Console API (owner 73 for handlers, a3 for infra)
`/api/me/{profile,usage,records,records/{reqId},sessions/{label},latest,setup}` (caller's own principal, derived
from the token; another principal's id → 404), `/api/admin/{members,service-clients,config,config/versions,
config/validate,config/activate,assessor/packs,gateway,usage,records,audit,health,budgets}`, and
`/api/packs/{packVersion}` (both roles: rule text for a record's basis, read from the private packs archive; no
direct CloudFront path to the bucket's data prefixes). Stable error codes
(`{ error: { code, message } }`); 18's client wrapper maps codes to i18n keys.

## 3. Child tasks, owners and order

| Child | Scope | Implement | Review |
|---|---|---|---|
| C1 identity-spike | `spikes/identity-hop` from V9d; S0/S1/S2/S4/S7 + teardown (a3 §1.4) | a3 harness, **0c runs AWS** | 0d |
| C2 router-identity | `identity.ts`, `principal`, modes, blocks/budget-blocks poll, 403/429 codes; RouterStack: `x-api-key` allowlist, catch-all rule, scope-only authorizer, `cli` client, config bucket, `jwks-sync` | a3 | 0d |
| C3 runtime-config | core: generation snapshot semantics, observe hold, `projected`, `switchedFrom`, `policySwapEffects`, access caps, `./policy` browser export, `parseReason`; router: S3 poll, generation holder, universe fix, `config` lines, `catalogVersion` | 0d | a3 |
| C4 assessor-runtime | 73 A1–A7, manifest + golden test, packs archive | 73 | 0d |
| C5 usage-ingest | Lambda, tables, savings module (0d formulas + fixtures), rollups, budget evaluation → budget-blocks | 17 | 0d |
| C6 console-api | handlers, authz per route, Cognito admin ops, config versions/validate/activate, audit, gateway read, metrics; ConsoleStack | 73 (handlers), a3 (stack) | 0d |
| C7 console-web | SPA per 18 + 4f pages and copy | 18 | 4f (copy), 0d (authz paths) |
| C8 cli-login | `llmar` CLI + tests | 17 | a3 |
| C9 docs + E2E | README/zh "Connecting clients" update, console docs, deploy/teardown, E2E on the real stack | 4f (docs), 0c (E2E) | 0d |

Order: C1 first (gates the header choice in C2, C8, C9 and 0.13). C3 and C4 start at once (no AWS), sharing the
generation holder (C3 lands it, C4 builds on it). C5/C6/C7/C8 build against fixtures and mocks in parallel, then
integrate when C2/C3 land. Deploy only after every review passes, from a clean worktree, by 0c.

## 4. Security checklist (release gate)
- Anonymous and wrong-scope requests: gateway 401/403 (unchanged), every `/api/*` route 401 before data exists
  (via CloudFront and via the raw execute-api URL), a valid console token via CloudFront → 200, S3 objects 403
  directly (OAC only); verified at deploy before uploading the bundle and before enabling ingest.
- CloudFront `/api/*`: CachingDisabled + AllViewerExceptHostHeader origin request policy; HTTP API routes under
  `/api`.
- Member isolation tests (cannot list or fetch other principals; admin routes 403).
- No token/secret logging (router, Lambdas, CLI); CLI credentials file 0600; strict CSP; no tokens or credentials in `localStorage` (language/theme/density preferences only).
- Least-privilege IAM per Lambda (a3 §4.3); no `UpdateGateway`/`UpdateUserPoolClient` from the console.
- cdk-nag acks updated (Cognito "no human users" reasons become false: a3 §4.2).

## 5. Cost
a3 §5: idle < $1/month for the console (CloudFront, HTTP API, Lambda, DynamoDB on demand, S3); about $8 per
million router requests for ingest; WAF not deployed (optional later, ~$5–6/month). Spike C1 < $1.
