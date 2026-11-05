# V9 spike: AgentCore Gateway → VPC Lattice (AWS_IAM) → Fargate

This spike answers option (a) of the router data-plane [design](../../docs/tasks/11-04-router-dataplane-mvp/design.md) §4.

```
source scripts/local.env                     # copy from scripts/local.env.example first (LLMAR_SPIKE_ACCOUNT, AWS_REGION)
uv run spikes/lattice-hop/spike.py deploy    # stack llmar-v9 (~10 min)
uv run spikes/lattice-hop/spike.py gate      # check 1 — must print GATE PASSED
uv run spikes/lattice-hop/spike.py hop       # check 2 (creates the private-endpoint gateway target)
uv run spikes/lattice-hop/spike.py forge     # check 3
uv run spikes/lattice-hop/spike.py size      # check 4a: 1 / 7 / 12 MB
uv run spikes/lattice-hop/spike.py cadence   # check 4b: SSE ticks, 300 s gap, 630 s stream (~11 min)
uv run spikes/lattice-hop/spike.py lat       # check 5
uv run spikes/lattice-hop/spike.py teardown  # check 6: target → resource gateway → stack, then verify
```

`all` runs gate through lat in one go. `verify` reruns only the teardown listing. `--print-template` prints the CloudFormation template without making any AWS calls.

## What it builds

| Part | Shape |
|---|---|
| Network | VPC `10.89.0.0/24`: two private subnets for the task, probe and resource gateway, plus one public subnet holding only the NAT. |
| Stub | One Fargate ARM64 task running `node:24-slim` from ECR Public with `stub/server.cjs`. It has no task role and no public IP. Its SG allows ingress on 8080 from the VPC Lattice prefix list only, and egress on 443 for the image pull and logs. |
| Lattice | Service network (association SG: 443 from `ClientSg` only). Service `llmar-v9-router` with `AWS_IAM` and idle 600 s, an HTTPS listener and an IP target group. ECS registers the task through `vpcLatticeConfigurations`. |
| Auth policy | Allows `vpc-lattice-svcs:Invoke` only for the gateway role. |
| Gateway | `llmar-v9-gw`, `AWS_IAM` inbound (spike only). The target `router` is an inference provider with `iamCredentialProvider {service: vpc-lattice-svcs}` and `privateEndpoint.managedVpcResource` in the private subnets. |
| Gate probe | A Lambda in the VPC whose role is **not** in the auth policy. Lattice needs an allow from both the identity policy and the auth policy, so the probe role's own policy allows `vpc-lattice-svcs:Invoke`; its 403 then comes from the auth policy. It sends unsigned, wrong-principal and payload-signed requests, and a direct TCP connect to the task IP. |

**Image pull: NAT, not a public IP.** The task stays in a private subnet with no public address, so nothing about its exposure depends on the SG alone. The NAT costs about $0.07/h for the spike. The MVP uses ECR plus VPC endpoints instead (design §3).

## Gate (check 1)

`gate` refuses to run if a gateway target exists, and waits for the Lattice target to be HEALTHY, so a denial cannot come from "no backend". It requires all of these:
- the probe's unsigned request gets 403;
- the probe's own-role request (valid SigV4 with `UNSIGNED-PAYLOAD`) gets 403;
- the direct TCP connect to `taskIp:8080` times out;
- an anonymous request to the gateway is denied;
- the service name does not resolve to a public address from outside.

Every later command refuses unless `results/gate.json` passed for the current stack's creation time.

## Outputs

`results/*.json` and `state.json` are gitignored, and 12-digit numbers are masked before they are written. Findings to record in [v9-findings.md](../../docs/tasks/11-04-router-dataplane-mvp/research/v9-findings.md):
- R-a1 `x-amz-content-sha256` as seen by the stub;
- R-a3 whether the target reaches READY and calls return 200;
- R-a4 whether forged headers reach the router;
- R-a5 sizes;
- R-a2 how the 630 s stream ends.

Note: AgentCore's managed private endpoint is a Lattice *resource* path. Lattice documents a 350 s idle timeout for resource connections, so the 300 s gap probe stays under it.

## Cost and cleanup

Roughly $0.15/h (NAT, EIP, Lattice service and resource gateway, one 0.25 vCPU task); no Bedrock calls. Teardown deletes the gateway target first, waits for AgentCore's managed resource gateway to leave the VPC, deletes the stack, then lists:
- tagged resources;
- gateways, Lattice networks, services, target groups and resource gateways;
- ECS cluster, VPC, NAT, EIP, log groups and IAM roles.

It exits 1 if anything remains.

Outcome: check 2 failed (VPC Lattice rejects the gateway's signed payloads), so fallback (d), a private REST API + VPC link + NLB, was built and verified as [`spikes/apigw-hop`](../apigw-hop/README.md) (V9d).
