# V9d spike: AgentCore Gateway → private REST API (AWS_IAM) → VPC link → NLB → Fargate

This is fallback (d) for the router data plane ([design](../../docs/tasks/11-04-router-dataplane-mvp/design.md)). Option (a) failed in V9: Lattice rejects the gateway's signed payloads ([v9-findings.md](../../docs/tasks/11-04-router-dataplane-mvp/research/v9-findings.md)).

```
source scripts/local.env                     # copy from scripts/local.env.example first
uv run spikes/apigw-hop/spike.py deploy     # stack llmar-v9d, then an update pass that scopes the VPCE policy to the API
uv run spikes/apigw-hop/spike.py gate       # check 1 — must print GATE PASSED (no target exists yet)
uv run spikes/apigw-hop/spike.py hop        # check 2: creates the target (model discovery GET /v1/models runs here)
uv run spikes/apigw-hop/spike.py forge      # check 3
uv run spikes/apigw-hop/spike.py size       # check 4a: 1 / 7 / 9.5 / 12 MB (10 MB REST cap)
uv run spikes/apigw-hop/spike.py cadence    # check 4b: SSE; 240/330 s gaps; 630/960 s streams (~17 min)
uv run spikes/apigw-hop/spike.py lat        # check 5
uv run spikes/apigw-hop/spike.py teardown   # check 6: target → managed resource gateway → stack, then verify
```

Other commands:
- `all` runs gate through lat.
- `untarget` deletes only the gateway target.
- `verify` reruns the teardown listing.
- `--print-template` prints the template without making any AWS calls.

## Shape

| Part | Shape |
|---|---|
| Network | VPC `10.91.0.0/24`. Private subnets use AZ IDs apne1-az1/az2, which managed private endpoints require; a public subnet holds only the NAT, used for the ECR Public pull. |
| Stub | One Fargate ARM64 task (`stub/server.cjs`) with no task role and no public IP. Task SG: 8080 only from the NLB SG. It serves `GET /v1/models` as a list valid in both the OpenAI and the Anthropic shape. Discovery requests are logged as header names plus masked x-amz*/x-router-* values only. |
| NLB | Internal, TCP 8080, IP target group (ECS `loadBalancers`). NLB SG has **no ingress rules** and `EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic=off`, so only VPC link (PrivateLink) traffic gets in. Egress is 8080 to the task SG only. |
| VPC endpoint | `execute-api`, private DNS **off**. SG: 443 only from `ClientSg` (probe and resource gateway). The endpoint policy allows `execute-api:Invoke` on this API only; `deploy` sets it in its second pass. |
| REST API | `PRIVATE`, `AWS_IAM`, stage `v1`, `ANY /{proxy+}`. Integration: `HTTP_PROXY` over `VPC_LINK` to `http://<nlb>:8080/v1/{proxy}`, `ResponseTransferMode: STREAM`, timeout 900 s. Integration headers `x-router-caller-arn` = `context.identity.userArn` and `x-router-source-vpce` = `context.identity.vpceId`. |
| Resource policy | Allows the gateway role only through this VPCE. Explicit Deny for any other VPCE, and explicit Deny for any other principal: in the same account, an identity-policy Allow alone would be enough. |
| Gateway | `llmar-v9d-gw`, `AWS_IAM` inbound (spike only). The target is an inference provider. Endpoint: `https://<api>.execute-api.ap-northeast-1.amazonaws.com`. Credentials: `iamCredentialProvider {service: execute-api}`. `managedVpcResource.routingDomain` is the VPCE regional DNS name. |

**Why an NLB rather than an ALB with VPC link v2.** REST private integrations with an NLB over VPC link v1 are the long-documented path, and the one where streaming private `HTTP_PROXY` integrations are documented. The NLB SG trick (no ingress, PrivateLink inbound rules not enforced) admits VPC link traffic only. That gives the same isolation an ALB SG would, without a second load-balancer type.

## Gate (check 1, before any target)

The probe Lambda runs in the VPC and goes through the VPCE with `Host` set to the API hostname. Its identity policy allows `execute-api:Invoke` on this API, so any deny it gets comes from the resource policy. The gate requires all of these:
- probe, unsigned `GET /v1/models` and `POST /v1/messages`: 403;
- probe, the same calls signed by its own role: 403 from the explicit Deny;
- direct TCP to `task:8080` and to every NLB IP on 8080: timeout;
- from outside the VPC, the public API hostname: 403 both unsigned and signed by the operator's own role;
- anonymous gateway call: denied;
- the VPCE policy names this API.

## Outputs to record in `research/v9-findings.md` (V9d section)

- **hop.** Target READY (discovery passed); the discovery headers seen at the stub; `x-router-caller-arn` is the gateway role session; `x-router-source-vpce` is ours; `x-amz-source-arn` is the gateway; `x-amz-content-sha256` at the stub (R-a1 for (d) is whether execute-api accepts the gateway's signed payload).
- **forge.** Whether client-sent `x-router-caller-arn`, `x-router-source-vpce` or `x-amz-source-arn` reach the stub as sent.
- **size.** 12 MB is expected to fail at the 10 MB cap; record the status, the error type, and whether the stub saw it.
- **cadence.** 240 s should survive and 330 s should be cut by the 5-min private idle timeout. 630 s should survive, and 960 s should be cut near 900 s.
- **lat.** p50 compared with the agentcore spike's Lambda URL path.

## Cost

Roughly $0.15–0.20/h: NAT, NLB, two VPCE ENIs, the managed resource gateway and one 0.25 vCPU task, plus API Gateway request and streaming charges (cents). No Bedrock calls. A full run with the ~17 min cadence check costs about $0.3–0.5.
