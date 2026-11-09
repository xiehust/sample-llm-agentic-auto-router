# C1 identity spike: Cognito access token in `x-api-key` through the gateway hop

Question for the admin console: does a client's Cognito access token, sent again in `x-api-key`, reach the router
**unchanged** through AgentCore Gateway (CUSTOM_JWT, scope-only) → private REST API (AWS_IAM) → VPC link → NLB →
Fargate? And which credential does the gateway authenticate when both headers are present? Plan:
[a3 research §1.4](../../docs/tasks/11-08-admin-console/research/a3-identity-infra.md) (synced from the task docs);
design v1 decisions 0.1, 0.3, 0.4 and 0.13 depend on the result.

```
source scripts/local.env                                    # LLMAR_SPIKE_ACCOUNT (+ optional LLMAR_OWNER)
S="uv run spikes/identity-hop/spike.py --region <region>"  # or LLMAR_SPIKE_REGION / AWS_REGION
$S deploy      # stack llmar-idspike (~10 min), then the VPCE-policy update pass
$S gate        # S0, with no target: must print GATE PASSED
$S s1          # creates the router target (x-api-key allowlisted), forwarding checks
$S s2          # precedence and Bearer cases (~6 min: waits for a 5-minute token to expire; --no-expired skips)
$S s4          # user tokens: two browser sign-ins (managed login, 127.0.0.1:8976 callback)
$S s7          # bypass: bedrock connector target + catch-all rule (2 Bedrock calls, max_tokens 1)
$S teardown    # rule -> targets -> managed resource gateway -> stack, then the verification listing
$S verify      # rerun the listing only
```

`--print-template` (with any command) prints the CloudFormation template without AWS calls. The region must offer
AgentCore managed private endpoints in two AZ IDs: built in for ap-northeast-1 and ap-southeast-1, otherwise
`--az-ids <id1>,<id2>`.

## Shape

The V9d hop ([apigw-hop](../apigw-hop/README.md)), changed as follows:

- **Gateway:** `CUSTOM_JWT`, `allowedScopes: [llmar-idspike/invoke]`, no `allowedClients` (design 0.4).
- **Cognito pool:** admin-created users only, MFA off for the spike user.
  - Managed login v2 domain.
  - Resource server scopes `invoke` and `other`.
  - Four M2M clients: `m2m-a`, `m2m-b`, `m2m-short` (5-minute tokens) and `m2m-other` (the wrong scope).
  - A public `cli` client: auth code + PKCE, callback `http://127.0.0.1:8976/callback`, scopes `openid invoke`, 30-minute access tokens, with its own `ManagedLoginBranding` (`UseCognitoProvidedValues`).
- **REST method:** also maps `x-api-key` into `x-router-identity` (a3 §1.3 fallback 1). One run therefore shows both the pass-through and the explicit mapping.
- **Stub:** echoes `{present, length, sha256_12, bearer}` for `x-api-key` and `x-router-identity`, in the response body only. It never echoes or logs either value.
- **Gateway role:** may invoke one global profile (`LLMAR_IDSPIKE_BEDROCK_MODEL`, default Haiku 5.5) for S7, plus the connector's discovery calls.

**Secrets.** Client secrets, tokens and the spike user's password stay in memory. `results/*.json` hold only digests, lengths, statuses and claim *names*. `mask()` replaces 12-digit numbers and anything JWT-shaped.

## Checks and what to record (results/ is gitignored)

| Step | Pass / record |
|---|---|
| **gate (S0)** | V9d network gate. Anonymous, `Bearer junk` and a valid token with the wrong scope → 401/403. A valid token gets past the authorizer (any non-401/403 status, since no target exists yet). **Any 2xx stops the run.** |
| **s1** | **Allowlist:** whether `x-api-key` is accepted (if refused, it retries with `x-router-identity` and records the error).<br>**Forwarding:** `forwarded_unchanged_every_call` on 3 paths × stream/non-stream.<br>**REST mapping:** `rest_mapping_copy_unchanged`.<br>**4 KB value rule:** behaviour at 3,900 vs 4,200 bytes.<br>**Census:** header names at the stub. |
| **s2** | Cases a–j (valid/junk/expired/other-scope/Bearer-prefixed tokens in `Authorization` and `x-api-key`). **Gate for design 0.1: `header_path_ok`**, i.e. the stub sees B when `Authorization: A` and `x-api-key: B` are both sent. `gateway_accepts_jwt_in_key_alone` decides the Codex single-sign-in option (design 0.13). |
| **s4** | Access-token claims: `token_use=access`, `client_id`, the invoke scope, `username`, no `aud`. The gateway accepts the access token (200, forwarded unchanged) and refuses an ID token and an `openid`-only token. A refreshed token keeps the scope. Both refresh tokens are revoked at the end. |
| **s7** | Before the rule, a concrete Bedrock id is served by `bedrock` (the bypass). After the catch-all rule it reaches the stub (`catchall_rule_routes_concrete_id_to_router`). Stub models still route; an unknown model reaches the router. |
| **teardown** | The verification listing is empty: stack, gateway, targets, rule, REST API, VPC link, NLB, VPCE, resource gateway, ECS, VPC, NAT/EIP, log groups, IAM roles, user pool. |

**S4 from a remote dev box.** Run `ssh -L 8976:127.0.0.1:8976 <host>` first, then open the printed URL on your laptop and sign in as `idspike-user`. The password is printed once.

## Cost

About $0.2/h (NAT, NLB, two VPCE ENIs, the managed resource gateway, one 0.25 vCPU task), plus cents of API
Gateway, Cognito (M2M token requests) and two Bedrock calls with `max_tokens: 1`. A full run of about 2 h costs **< $1**.
