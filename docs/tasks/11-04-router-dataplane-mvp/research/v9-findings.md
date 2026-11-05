# V9 findings: gateway → container hop (2026-11-04, ap-northeast-1)

Run by the parent session with `spikes/lattice-hop/spike.py` (stack `llmar-v9`, `Purpose=spike`). No Bedrock
calls. Raw results are in `spikes/lattice-hop/results/` (gitignored, account ids masked).

## Verdict: option (a) (VPC Lattice service + IAM auth policy) is NOT viable. Go to fallback (d).

AgentCore signs every request to the target with a signed payload. A Lattice service with `AWS_IAM` rejects
signed payloads, and the credential provider has no unsigned-payload option (`iamCredentialProvider` has only
`service` and `region`). R-a1 is a hard fail.

## Results

| Check | Result |
|---|---|
| 1. Gate (no target yet) | **Passed.** Unsigned request from a VPC client: 403 `AccessDeniedException … no service-based policy allows`. Different role (identity policy allows `vpc-lattice-svcs:Invoke`, not in auth policy), SigV4 with `UNSIGNED-PAYLOAD`: 403, again "no service-based policy allows", so the auth policy itself denies it. Direct TCP to the task IP from the VPC: timeout. Anonymous call to the gateway: 403 `MissingAuthenticationTokenException`. Service DNS resolves only to Lattice link-local addresses (169.254.171.x / fd00:ec2:80::). |
| Payload-signed request from the probe | 403 `IncompleteSignatureException: Missing the 'x-amz-content-sha256' in canonical headers`. |
| R-a3: target endpoint = Lattice service DNS | **Target FAILED:** `… vpc-lattice-svcs.ap-northeast-1.on.aws is not a valid resource configuration domain name`. A managed private endpoint cannot point at a Lattice service domain. |
| R-a3 workaround: `managedVpcResource.routingDomain` = private hosted zone CNAME to the service DNS; endpoint unchanged | **Works for the network path.** The resource configuration is created and the request reaches the Lattice service through the resource gateway. |
| R-a1: gateway signer through that path | **Target FAILED:** `Inference list-models call to https://<service-dns>/v1/models failed with HTTP 403: InvalidSignatureException: Signed payloads are not supported`. |
| R-a2, R-a4, R-a5, latency | Not reached (no READY target). |
| 6. Teardown | See `results/teardown.json`; verified by the listing in `spike.py teardown`. |

## Facts worth keeping (they apply to (d) and the MVP)

- **Inference provider targets run model discovery at creation**: the gateway calls `GET <endpoint>/v1/models`
  with its target credentials, and the target goes FAILED if that call fails. The router must serve
  `GET /v1/models` (behind the same auth) with a response the gateway accepts.
- `routingDomain` lets the managed private endpoint reach a private name (Route 53 private hosted zone in the
  target VPC) while SNI, Host and SigV4 still use the endpoint's domain. This is the documented pattern for a
  private API Gateway behind an `execute-api` VPC endpoint, which is exactly (d).
- Managed private endpoint subnets must be in AZ IDs apne1-az1/az2/az4. The resource gateway SG controls
  egress only. AgentCore reuses one managed resource gateway per (VPC, subnets, SGs, IP type). Resource
  connections have a 350 s idle timeout.
- Lattice authorizes a request only if both the identity policy and the auth policy allow it. A gate that probes
  with a role lacking an identity allow does not test the auth policy.

## Fallback (d) caveats to verify

From the API Gateway documentation:
- Response streaming (`responseTransferMode: STREAM`) works with `HTTP_PROXY` private integrations, for up to
  15 min. The idle timeout for private endpoints is 5 min (below the 350 s resource-connection idle timeout).
- Response data beyond 10 MB is throttled to 2 MB/s, and request streaming is not supported.
- The REST API request payload cap is 10 MB, below the gateway's 12 MB.

---

# V9d findings: fallback (d), private REST API hop (2026-11-04, ap-southeast-1)

Run by the parent session with `spikes/apigw-hop/spike.py` (stack `llmar-v9d`, `LLMAR_SPIKE_REGION=ap-southeast-1`,
`Purpose=spike`). No Bedrock calls. Topology: AgentCore Gateway (inference provider target, `iamCredentialProvider
{service: execute-api}`, `managedVpcResource.routingDomain` = execute-api VPC endpoint regional DNS) → execute-api
interface endpoint (private DNS off) → PRIVATE REST API (AWS_IAM, stage `v1`, `ANY /{proxy+}`, HTTP_PROXY over
VPC_LINK, `responseTransferMode: STREAM`, 900 s) → internal NLB → Fargate echo stub.

## Verdict: GO. (d) is the gateway → router hop.

| Check | Result |
|---|---|
| 1. Gate (no target) | **Passed.** Through the VPC endpoint from an in-VPC probe: unsigned → 403 `MissingAuthenticationToken` / explicit deny; a different role whose identity policy allows `execute-api:Invoke` → 403 "explicit deny in a resource-based policy" (API Gateway allows same-account calls if EITHER policy allows, so the resource policy carries explicit Denies: other VPC endpoints, other principals). Direct TCP to the task and to the NLB → timeout. From outside the VPC the private API hostname does not resolve. Anonymous gateway call → 403. VPC endpoint policy scoped to the API. |
| 2. Hop (R-a1 for (d)) | **Target READY**: model discovery `GET /v1/models` passes through stage `v1`. Messages, Chat Completions and Responses: 200, bodies byte-exact (sha256 equal). API Gateway accepts the gateway's signed payload. The router sees `x-router-caller-arn` = `arn:aws:sts::<account>:assumed-role/<gateway-role>/gateway-session-invocation`, `x-router-source-vpce` = the endpoint id (both mapped from `context.identity`), `x-amz-source-arn` = the gateway ARN, `x-amz-source-account`. `Authorization` is stripped. **`x-amz-security-token` (the gateway role's session token) is forwarded** unless the integration overwrites it (the MVP maps it to a static value). |
| 3. Forge (R-a4) | Client-sent `x-router-caller-arn`, `x-router-source-vpce`, `x-amz-source-arn` (allowlisted on the spike target only) are all overwritten. |
| 4a. Size (R-a5) | 1 / 7 / 9.5 MiB intact. 12 MiB → 413 "HTTP content length exceeded 10485760 bytes." from API Gateway (4xx: the 5XX fallback does not fire). The REST API caps requests at 10 MiB, below the gateway's 12 MB. |
| 4b. SSE cadence | 100 ms ticks preserved on all three APIs (31 chunks, median gap 100 ms). |
| 4b. Idle (R-a2) | 240 s silent gap survives. 330 s gap: **cut at ~302 s** (API Gateway private endpoint idle timeout, 5 min), clean close without error or final event. |
| 4b. Duration | 630 s stream completes. 960 s stream: **cut at ~901 s** (15 min streaming cap), clean close without error. |
| 5. Latency | TTFB p50 637 ms (min 585, max 668) from the dev box. The earlier Lambda URL baseline was in another region (854 ms in ap-northeast-1), so the hop adds no measurable cost but the delta is not exact. |
| Deploy | `TimeoutInMillis: 900000` with STREAM accepted without a quota request. |

## Consequences for the MVP

- Request cap 10 MiB (router `maxBodyBytes` = 10 MiB; documented).
- Streams are truncated **silently** after 5 min of silence or 15 min total. Mitigations: the router's 240 s
  upstream idle timeout records a mid-stream failure before API Gateway's 300 s; SSE comment heartbeats during upstream
  silence would keep the idle timer alive (follow-up); 15 min is a hard limit to document.
- The router trusts only the API Gateway-mapped identity headers plus `x-amz-source-arn` (inbound mode `apigw-iam`).
- Teardown: target → managed resource gateway → stack, then a verification listing.
