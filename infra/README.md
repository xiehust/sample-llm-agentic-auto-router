# infra: router stack (CDK, TypeScript)

This is the CDK app for the router data plane (design: `docs/tasks/11-04-router-dataplane-mvp/design.md` §3/§4). The hop shape was verified end to end in spike V9d (`spikes/apigw-hop`).

```
pnpm install --frozen-lockfile                                       # from the repository root; versions are pinned in pnpm-lock.yaml
pnpm -C infra typecheck && pnpm -C infra test                        # assertions + cdk-nag (AwsSolutions) in-process
cd infra && npx cdk synth -c region=<aws-region> -c account=<account-id>   # any Region with a price catalog
```

## Shape

```
client --JWT (Cognito client credentials, scope <prefix>/invoke)--> AgentCore Gateway <prefix>-gw (CUSTOM_JWT)
  rule auto | auto:* -> target router: inference provider, SigV4 execute-api, managed private endpoint
                        (routingDomain = the execute-api VPC endpoint's DNS name)
       fallback on router 5XX / connection error / unroutable -> target bedrock: Sonnet 5.5, then GPT-6.1 Sol
  -> private REST API <prefix>-api (AWS_IAM, stage v1, ANY /{proxy+}, HTTP_PROXY, streaming, 15 min)
     resource policy: Allow the gateway role via this VPC endpoint; Deny any other endpoint; Deny any other principal
     integration headers: x-router-caller-arn <- context.identity.userArn, x-router-source-vpce <- context.identity.vpceId,
                          x-amz-security-token <- 'redacted' (the gateway session token never reaches the router)
  -> VPC link -> internal NLB (SG with no ingress rules; PrivateLink inbound rules not enforced)
  -> ECS Fargate <prefix>-router (ARM64, private isolated subnets; SG: 8080 from the NLB SG only)
  -> bedrock-runtime / ECR / Logs interface endpoints + S3 gateway endpoint (no IGW, no NAT)
```

## Deploy inputs

Nothing about a particular deployment is built into the code. These are all CDK context values (`-c key=value`):

| Key | Default | Notes |
|---|---|---|
| `region` | none | **Required, explicit.** There is no fallback to the shell's Region. It needs a bundled price catalog (`ap-northeast-1`, `ap-southeast-1`), or `catalogFile`. |
| `account` | none | **Required.** Sets the stack's `env.account`, so CDK refuses credentials for any other account. `-c account=env` explicitly opts in to the CLI credentials' account. |
| `azIds` | per-Region table in `src/settings.ts` | Two AZ IDs supported by AgentCore Gateway managed private endpoints. Required for Regions not in the table. |
| `prefix` | `llmar` | Prefix for physical names, the Cognito scope and the domain. **Use one unique per deployment** in an account and Region. The gateway role's trust policy is scoped to `gateway/<prefix>-gw-*` (it cannot name the gateway itself without a cycle), so two deployments sharing a prefix could assume each other's gateway role. |
| `tags` | `{"Project":"llm-auto-router","Purpose":"mvp"}` | A JSON object merged over the defaults, e.g. `-c tags='{"Owner":"team-x"}'`. |
| `policyFile` | `packages/router/config/policy.default.json` | Validated against the Region catalog at synth, and again by the router at boot. |
| `catalogFile` | bundled catalog | A catalog you captured for another Region (see `packages/pricing/README.md`). It is passed to the router. |
| `routerDesiredCount` | `0` | Deploy at 0, run the anonymous-denial checks (E0), then redeploy with 1. |
| `throttle` | `20,40` | API stage throttling `<rate>,<burst>`. API Gateway and Bedrock quotas are shared by everything in the account and Region, so size this to leave room for other workloads. |

Example:

```
npx cdk deploy -c region=<aws-region> -c account=<account-id> -c prefix=<unique-prefix> \
  -c tags='{"Owner":"<team>"}' --parameters S3PrefixListId=<pl-id>
```

The `S3PrefixListId` stack parameter is the Region's `com.amazonaws.<region>.s3` managed prefix list, used for ECR image layers. Look it up with `aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.<region>.s3`.

## IAM

- **Task role.** `bedrock:InvokeModel*` on exactly the router's allowed models: the policy's pool models, failover profiles and observe defaults. It follows the documented cross-Region inference pattern:
  - global profiles: the profile in the deploy Region, the foundation model in that Region, and `arn:aws:bedrock:::foundation-model/<id>` with `aws:RequestedRegion = unspecified`, all tied to the profile ARNs;
  - geographic profiles: the foundation model in any destination Region of the profile.
  There are no wildcard model ARNs for global profiles.
  - **Responses also needs the default project.** The Bedrock User Guide (Responses API, "Using the Responses API on the bedrock-runtime endpoint" > Permissions) says creating a response authorizes `bedrock:InvokeModel` on the account's default project, in addition to the inference target. So the stack grants `bedrock:InvokeModel` on `arn:aws:bedrock:<region>:<account>:project/*`, limited with `bedrock:ModelArn` to the Responses pool's inference profiles.
  - The gateway role gets the same grant for GPT-6.1 Sol, the Responses fallback.
  - Stored-response management (`GetInvoke`/`CancelInvoke`/`DeleteInvoke`) is not granted.
- **Endpoint policies.** The bedrock-runtime endpoint admits only the task role, for `bedrock:InvokeModel*`. The execute-api endpoint admits only the gateway role, for `execute-api:Invoke`.
- **Default security group.** It is stripped of all rules (`restrictDefaultSecurityGroup`, a small CDK custom resource).
- **Gateway role.** `execute-api:Invoke` on the router API stage, `bedrock:InvokeModel*` on the two fallback models (same pattern), and the List/Get calls the Bedrock connector target needs for discovery.

## In-VPC transport

TLS ends at API Gateway. The VPC link → internal NLB → router task leg is plain HTTP on port 8080, reachable only
through the VPC link (NLB security group without ingress rules, router security group admitting only the NLB).
To encrypt that leg too, add a TLS listener with an ACM certificate to the NLB and change the integration URI to
`https://`; the router itself does not terminate TLS.

## Deploy order

1. One-time: `cdk bootstrap aws://<account>/<region>`. The router image is a CDK Docker asset (ARM64).
2. `cdk deploy … -c routerDesiredCount=0`. Then run E0: anonymous, wrong token, direct API call, direct NLB and task IP. All must be denied.
3. `cdk deploy … -c routerDesiredCount=1`, and run E0 again.
4. Cognito generates the client secret, and it is never a stack output. Read it with `aws cognito-idp describe-user-pool-client`.
5. Teardown: `cdk destroy`. Then do the verification listing, which must be empty:
   - tagged resources;
   - `<prefix>-` gateways, REST APIs, VPC links, load balancers, VPC endpoints and resource gateways;
   - ECS clusters, VPCs and Cognito pools;
   - log groups `/<prefix>/*`, and `/aws/ecs/containerinsights/<prefix>-cluster/*` (normally absent, since Container Insights is off);
   - the default-SG custom resource's Lambda log group `/aws/lambda/<stack>-CustomVpcRestrictDefaultSG…`, which Lambda creates at runtime and `cdk destroy` leaves behind. Delete it by hand.

## Cost and teardown

- **Fixed cost while deployed,** even at `routerDesiredCount=0`. Estimate for ap-southeast-1 from the AWS Price List API (On-Demand, retrieved 2026-11-05, 730 hours/month); other Regions differ and prices change, so re-check with the [AWS Pricing Calculator](https://calculator.aws/) for your Region:
  - 5 interface endpoints (bedrock-runtime, ecr.api, ecr.dkr, logs, execute-api) × 2 AZs at USD 0.013 per endpoint-AZ-hour: about USD 94.90/month;
  - the internal NLB at USD 0.0252/hour: about USD 18.40/month;
  - total about USD 113/month, plus usage: endpoint data processing (USD 0.01/GB), NLB LCUs (USD 0.006/LCU-hour) and the VPC flow-log group, which is small. The S3 gateway endpoint is free.
- **Per task:** each Fargate router task (1 vCPU / 2 GB, ARM64) costs about USD 36/month in ap-southeast-1 (USD 0.04045 per vCPU-hour + USD 0.00442 per GB-hour, same Price List source).
- **Per request:** API Gateway requests and streaming, AgentCore Gateway requests and its data processing to the customer VPC (USD 0.006/GB on the AgentCore pricing page), and Bedrock tokens. The managed private endpoint has no hourly charge in your account: its resource configuration lives in the AgentCore service account.
- **Cognito.** Machine-to-machine token requests are billed per token issued. Clients should cache the 60-minute access token rather than fetch one per call.
- **What `cdk destroy` leaves behind.** The CDK bootstrap resources outlive it: the router image in the `cdk-…-container-assets-<account>-<region>` ECR repository, and staged files in the `cdk-…-assets-<account>-<region>` S3 bucket.
  - To remove only this app's assets, delete the image tags or objects listed in `cdk.out/*.assets.json`.
  - Remove the bootstrap stack only if nothing else in the account and Region uses it.

## Limits and things to check in E2E

- **Request size.** 10 MiB per request: the API Gateway REST payload cap, below the gateway's 12 MB. A larger request gets 413 from API Gateway, a 4xx, so the 5XX fallback does not apply.
- **Streams.** Up to 15 minutes. API Gateway's idle timeout for private endpoints is 5 minutes; the router's own idle timeout (240 s) fires first.
- **Fallback chain.** Rule `MatchPaths` only accepts one-segment prefixes (API pattern `/[\w\-.]+/\*`, e.g. `/inference/*`), so a rule cannot pick a model per API path. The chain is Sonnet 5.5 (Messages), then GPT-6.1 Sol on a 4XX (Chat/Responses reject Claude). E7 must confirm both paths.
  - On Chat/Responses each fallback makes one extra, rejected (unbilled) Sonnet call first.
  - If both fallback models fail, the client sees the last target's error.
  - The route's first-byte timeout (610 s, a fallback trigger) sits above the router's 600 s non-stream header deadline. That deadline covers all attempts, failover included, so the router always answers first.
- **Circuit breaker.** It is enabled explicitly on the fallback route (also the default). After repeated router failures the gateway takes the router out of the chain for a while. `auto*` traffic then goes **silently** to the pinned fallback model: no router decisions, no router logs or accounting for those requests. The gateway's documented CloudWatch metrics (`AWS/Bedrock-AgentCore`: Invocations, SystemErrors, UserErrors, Throttles, Latency, Duration, TargetExecutionTime, TargetType) have no fallback or circuit-breaker metric, so compare the gateway's `Invocations` with the router's `Requests`. E7b measures how long the breaker keeps skipping the router after it recovers.
- **Old bundled schema.** The `MatchModels` and `StaticRoute.Fallback` overrides follow the CloudFormation reference, but the schema bundled with aws-cdk-lib predates them (warning F3018 is acknowledged).
- **Model glob.** `auto:*` (`StringLike`) is covered by E5b: `auto:fast` on all three paths must reach the router, `auto:bogus` must reach it and get 400 `pin-not-allowed`, and `autox` must not reach it.
- **Pins bypass the router.** A concrete Bedrock model id doesn't match `auto*`, so the gateway's `bedrock` target serves it directly. The gateway role allows only the fallback models. Pins *through* the router use `x-router-hint: pin=<id>`.
- **Logging.** API Gateway access and execution logging need the account-level API Gateway CloudWatch role. The stack does not set it; the cdk-nag findings are acknowledged with that reason.
