# infra: router stack and admin console stack (CDK, TypeScript)

This is the CDK app for the router data plane (design: `docs/tasks/11-04-router-dataplane-mvp/design.md` §3/§4). The hop shape was verified end to end in spike V9d (`spikes/apigw-hop`).

```
pnpm install --frozen-lockfile                                       # from the repository root; versions are pinned in pnpm-lock.yaml
pnpm -C infra typecheck && pnpm -C infra test                        # assertions + cdk-nag (AwsSolutions) in-process
cd infra && npx cdk synth -c region=<aws-region> -c account=<account-id>   # any Region with a price catalog
```

## Shape

```
client --Cognito access token in Authorization and x-api-key (scope <prefix>/invoke)--> AgentCore Gateway <prefix>-gw
  (CUSTOM_JWT, scope-only: it authenticates Authorization; members use the `cli` app client, service clients client credentials)
  catch-all rule (every model name) -> target router: inference provider, SigV4 execute-api, managed private endpoint
                        (routingDomain = the execute-api VPC endpoint's DNS name); x-api-key is forwarded unchanged
       fallback on router 5XX / connection error / unroutable -> target bedrock: Sonnet 5.5, then GPT-6.1 Sol
                        (the bedrock target's header allowlist excludes x-api-key: Bedrock rejects both headers together)
  -> private REST API <prefix>-api (AWS_IAM, stage v1, ANY /{proxy+}, HTTP_PROXY, streaming, 15 min)
     resource policy: Allow the gateway role via this VPC endpoint; Deny any other endpoint; Deny any other principal
     integration headers: x-router-caller-arn <- context.identity.userArn, x-router-source-vpce <- context.identity.vpceId,
                          x-amz-security-token <- 'redacted' (the gateway session token never reaches the router)
  -> VPC link -> internal NLB (SG with no ingress rules; PrivateLink inbound rules not enforced)
  -> ECS Fargate <prefix>-router (ARM64, private isolated subnets; SG: 8080 from the NLB SG only)
     verifies the x-api-key JWT in process (keys, block lists and caller list polled from the config bucket)
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
| `allowedModelUniverse` | `policy` | Models the router may invoke, and so the models an admin can put in a console policy. `policy` is the policy file's models; `catalog` is every model in the Region catalog; a comma list adds those catalog model ids to the policy file's models. The task role's grants, `ROUTER_MODEL_UNIVERSE` and the console's allowed list all follow it. Pass the same value on every router deploy: after a narrower one, requests that the active console policy routes to a dropped model fail with 400 `pin-not-allowed`, so remove those models from the policy first. Redeploy the console after the router, since it reads the list at deploy. |
| `routerDesiredCount` | `0` | Deploy at 0, run the anonymous-denial checks (E0), then redeploy with 1. |
| `throttle` | `20,40` | API stage throttling `<rate>,<burst>`. API Gateway and Bedrock quotas are shared by everything in the account and Region, so size this to leave room for other workloads. |
| `identityMode` | `observe` | Deploy default for the router's identity mode (`off`, `observe`, `require`). The console can override it per config version. |
| `cliRedirectPorts` | `52817,52818,52819` | Loopback callback ports registered on the `cli` app client for `llmar login` (127.0.0.1 only). |
| `codexOauthPort` | `52820` | The callback port registered for Codex's own sign-in (`gateway_oauth`). Must differ from `cliRedirectPorts`. |
| `cliRefreshDays` | `30` | Refresh-token lifetime of the `cli` client: how long a member's `llmar` sign-in lasts. |
| `packsArchive` | on | `off` skips staging the assessor packs archive that the console reads. |

Example:

```
npx cdk deploy -c region=<aws-region> -c account=<account-id> -c prefix=<unique-prefix> \
  -c tags='{"Owner":"<team>"}' --parameters S3PrefixListId=<pl-id>
```

The `S3PrefixListId` stack parameter is the Region's `com.amazonaws.<region>.s3` managed prefix list, used for ECR image layers. Look it up with `aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.<region>.s3`.

## IAM

- **Task role.** `bedrock:InvokeModel*` on exactly the router's allowed models: the policy's pool models, failover profiles and observe defaults, plus the models `allowedModelUniverse` adds. It follows the documented cross-Region inference pattern:
  - global profiles: the profile in the deploy Region, the foundation model in that Region, and `arn:aws:bedrock:::foundation-model/<id>` with `aws:RequestedRegion = unspecified`, all tied to the profile ARNs;
  - geographic profiles: the foundation model in any destination Region of the profile.
  There are no wildcard model ARNs for global profiles.
  - **Responses also needs the default project.** The Bedrock User Guide (Responses API, "Using the Responses API on the bedrock-runtime endpoint" > Permissions) says creating a response authorizes `bedrock:InvokeModel` on the account's default project, in addition to the inference target. So the stack grants `bedrock:InvokeModel` on `arn:aws:bedrock:<region>:<account>:project/*`, limited with `bedrock:ModelArn` to the inference profiles of the allowed models that serve Responses (with the default universe, the Responses pool's models).
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
3. `cdk deploy … -c routerDesiredCount=1`, and run E0 again. The identity mode starts at `-c identityMode` (default
   `observe`). The `jwks-sync` Lambda copies the user pool's signing keys into the config bucket every hour; the
   router reads them from there, since it has no internet access.
4. Cognito generates the client secret, and it is never a stack output. Read it with `aws cognito-idp describe-user-pool-client`. With the console, admins create service clients there instead.
   The admin console stack is deployed after this one (see [Admin console](#admin-console-console-stack)) and destroyed before it.
   Full order: router stack; console stack with `consoleBundle` and `ingest` off; then `consoleBundle=true`; then `ingest=true`.
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
- **Cognito.** Machine-to-machine token requests are billed per token issued. Service clients should cache the 60-minute access token rather than fetch one per call. Member sign-ins (`cli` app client) count as monthly active users.
- **What `cdk destroy` leaves behind.** The CDK bootstrap resources outlive it: the router image in the `cdk-…-container-assets-<account>-<region>` ECR repository, and staged files in the `cdk-…-assets-<account>-<region>` S3 bucket.
  - To remove only this app's assets, delete the image tags or objects listed in `cdk.out/*.assets.json`.
  - Remove the bootstrap stack only if nothing else in the account and Region uses it.

## Admin console (console stack)

`-c console=true` adds a second stack, `<prefix>-console`, to the same app (design:
`docs/tasks/11-08-admin-console/design.md`; user guide: [docs/console/README.md](../docs/console/README.md)). It reads
the router stack's values from SSM parameters under `/<prefix>/router/`, never from stack exports, so the two stacks
deploy and destroy on their own. Deploy it after the router stack and destroy it first.

```
browser --HTTPS--> CloudFront -+- /*     --OAC--> S3 site bucket (private, Block Public Access; SPA bundle + config.json, no data)
                               +- /api/* -------> HTTP API (JWT authorizer: user pool, console client, scope <prefix>/console)
                                                    -> console-api Lambda -> DynamoDB console + usage tables, Cognito admin (this pool),
                                                                             S3 config bucket (config/, identity/), AgentCore Get/List,
                                                                             CloudWatch GetMetricData
router log group --subscription (kind model|error|rejected|config)--> usage-ingest Lambda -> DynamoDB usage (+ SQS dead-letter queue)
```

### Console inputs

| Key | Default | Notes |
|---|---|---|
| `console` | off | `true` adds the console stack. |
| `consoleBundle` | `false` | Upload the built web app (`pnpm -C packages/console-web build`). Leave it off for the first deploy. |
| `consoleBundleDir` | `packages/console-web/dist` | A path inside the repository. |
| `ingest` | `false` | Subscribe usage-ingest to the router log group, so usage data starts flowing. |
| `adminEmail` | none | Creates the first admin user (see "First admin" below). |
| `recordRetentionDays` | `90` | Per-request records expire after this many days. Daily totals are kept 400 days. |
| `budgets` | `on` | `off` hides budgets and stops budget evaluation. |
| `consoleThrottle` | `20,40` | HTTP API stage throttling `<rate>,<burst>`. |

**Repository links in the web app.** Build the bundle with `VITE_CONSOLE_REPO_URL=https://github.com/<owner>/<repo>`
(and `VITE_CONSOLE_REPO_BRANCH`, default `main`) so Get started shows a working `curl` for the `llmar` CLI (the raw
URL of `tools/llmar/llmar`) and repository paths become links. Without it the console shows placeholders, so no
repository is baked in:

```bash
VITE_CONSOLE_REPO_URL=https://github.com/<owner>/<repo> pnpm -C packages/console-web build
```

**Invite e-mail.** Invites use Cognito's default e-mail sender, which has a low daily quota. For larger teams,
configure Amazon SES as the user pool's e-mail sender (a verified SES identity in the same Region) before inviting
many members.

**First admin.** `-c adminEmail=<e-mail>` creates the first admin through a custom resource: Cognito e-mails a
temporary password, and the address is added to the `admin` group. Use it on the first console deploy, or again
later if no admin is left. The admin then invites everyone else from the Members page.

### Console deploy order

Anonymous denial is verified before any restricted content exists (design §4 security checklist):

1. `cdk deploy <prefix>-console -c console=true -c adminEmail=<e-mail> …` with `consoleBundle` and `ingest` off. This
   creates the API, the tables and an empty site bucket.
2. Check: every `/api/*` route answers 401 without a token, and the site bucket answers 403 when called directly
   (only CloudFront can read it).
3. Deploy again with `-c consoleBundle=true` to upload the web app. Sign in as the first admin (set a new password)
   and check the pages.
4. Deploy again with `-c ingest=true`. Usage data starts flowing from the router log group.
5. Identity rollout, in the console (Settings, Deployment): keep `observe` while members set up their tools, check
   that the unattributed share on the Overview is near zero, then switch to `require`. The console refuses
   `require` until the router reports that its signing keys are loaded.

Outputs: `ConsoleUrl`, `ApiUrl`, `ConsoleClientId`, `SiteBucketName`, `ConsoleTableName`, `UsageTableName`,
`IngestDlqUrl`.

### Production hardening: MFA

The user pool ships with MFA off. For production, require TOTP MFA (an authenticator app) for every sign-in. Set it
on the pool in the router stack (`infra/src/stack.ts`): `mfa: cognito.Mfa.REQUIRED` and
`mfaSecondFactor: { otp: true, sms: false }`, then deploy. Make the change in the stack rather than with
`aws cognito-idp set-user-pool-mfa-config`, so the template and the pool stay the same. Users then set up an
authenticator app at their next sign-in; the console and `llmar login` use Cognito's managed login pages, which
handle the setup and the code prompt.

### Console cost

Estimate from list prices (us-east-1 used as the reference; other Regions differ a little, and prices change):

- **Idle: under USD 1/month.** CloudFront, the HTTP API, Lambda, SQS and DynamoDB on demand cost nothing without
  traffic; DynamoDB storage is cents; about six CloudWatch alarms are about USD 0.60. The router's polling of the
  config and identity objects is about USD 0.10 per task per month.
- **Console use:** about USD 2–3 per million console API calls.
- **Usage ingest:** about USD 8 per million router requests (mostly DynamoDB writes), under 0.1% of the Bedrock
  spend for the same requests.
- **Cognito:** member sign-ins count as monthly active users (free tier, check the current tier on the pricing
  page); service clients pay per issued token.
- WAF on CloudFront is not deployed. Adding it costs about USD 5/month plus USD 1 per rule.

These are estimates from published list prices, not measured bills; check them with the
[AWS Pricing Calculator](https://calculator.aws/) for your Region.

### Console teardown

1. **Export first if the data matters.** Destroying the console stack deletes both tables: the console table
   (config versions, the audit log, member profiles with budgets and tier limits) and the usage table (request
   records and daily totals). Point-in-time recovery does not outlive the table. Export them before you destroy,
   for example with a DynamoDB export to S3 (`aws dynamodb export-table-to-point-in-time`) or a scan.
2. `cdk destroy <prefix>-console`, before the router stack.
3. Then `cdk destroy` the router stack as above.
4. Verification listing, in addition to the router stack's: CloudFront distributions and the site bucket named
   `<prefix>-`, HTTP APIs `<prefix>-`, DynamoDB tables `<prefix>-`, SQS queues `<prefix>-usage-ingest-dlq`, the
   SSM parameters under `/<prefix>/router/`, and Lambda log groups `/aws/lambda/<prefix>-*`.
5. The tables, the site bucket (emptied automatically) and the stack's own log groups are deleted with the stack.
   Lambda functions that CDK adds for its own custom resources (for example the web app upload) create their log
   groups at runtime, and `cdk destroy` leaves those behind: list `/aws/lambda/<prefix>-console-*` and delete them.

### Deploy notes and troubleshooting

Found and fixed in the first live deploy; listed so you recognise them:

- **Gateway target updates call the router.** Creating or updating the router target runs model discovery
  (`GET /v1/models`) against the router, so the targets wait for the ECS service, and discovery requests carry no
  source ARN. A target stuck in a failed state usually means the router was not up yet: deploy again.
- **Refresh-token rotation.** Cognito refuses the `ALLOW_REFRESH_TOKEN_AUTH` flow on a client with refresh-token
  rotation on, so the console and `cli` clients do not list it.
- **The web app's `config.json`** must match the SPA's schema (a contract test checks it). A mismatch shows "This
  console is not configured" in the browser.
- **Lambda code runs under Node type stripping**, so TypeScript parameter properties are not allowed;
  `scripts/node-strip-check.mjs` catches them.
- **Deploy-time defaults.** Settings that no console config version sets come from `config/baked.json` in the
  config bucket. The console shows each value's source; if it cannot read that file, it says so and does not guess.
- **`require` needs fresh router state lines.** Each router task reports its state every 5 minutes. The console
  refuses `require` unless every running task reported within 15 minutes with its signing keys loaded.
- **The gateway answers an expired access token with 403, not 401.** The body is `insufficient_scope` ("The request
  requires higher privileges than provided by the access token"), and Claude Code shows it as "Please run /login".
  The `AWS/Bedrock-AgentCore` metric `InboundAuthorizationFailure` tells the causes apart by `ExceptionType`:
  `InvalidInboundTokenException` (401: missing or malformed token), `ForbiddenAccessInboundTokenException` (403:
  valid token without the invoke scope, such as an ID token) and `UnauthorizedInboundTokenException` (403: expired
  token). `llmar` refreshes when a client asks again for the same token right away (see
  [tools/llmar/README.md](../tools/llmar/README.md)).
- **Ingest failures** go to the dead-letter queue (`IngestDlqUrl`, with an alarm). Replay them after the fix as
  described in [packages/usage-ingest/README.md](../packages/usage-ingest/README.md#failures-and-replay).

### Verified end to end (2026-11-08, ap-southeast-1)

Router and console stacks deployed, identity mode at its `observe` default:

- Gateway: anonymous and bad tokens get 401; client-credentials and member tokens are served on Messages, Chat and
  Responses; the router logs the verified caller; a concrete model id is pinned through the router.
- Console API: all 41 `/api` routes answer 401 anonymously and with a junk bearer, through CloudFront and directly;
  a member gets 403 on admin routes and 404 on another member's record; a console token gets 403 at the gateway.
- Web app: security headers present; the site bucket answers 403 directly and 200 through CloudFront; no tokens in
  `localStorage`; English and Chinese pages; "Sign out" and "Sign out everywhere" revoke the tokens.
- Member path: invite, `llmar configure`, `llmar login` on a headless host (127.0.0.1 callback), calls on all three
  APIs, Claude Code (`apiKeyHelper`) and Codex (`auth.command` plus `x-api-key`). All five test requests were
  attributed to the member in records and usage within about 10 seconds.
- Runtime changes: a config edit reached the router in at most 32 seconds and rolled back. In `require`, a call
  without `x-api-key` got 401 `identity-missing`. Disable gave 403 `identity-blocked` after 16 seconds, enable served
  again after 32 seconds. A hard-stop budget gave 429 `budget-exceeded` after 23 seconds and was lifted 45 seconds
  after removal (these budget times include ingest; expect a few minutes in general).
- Router-measured Bedrock spend for the whole test: under USD 0.01.

## Experiment runner (`<prefix>-runner`, separate app)

`src/runner-app.ts` is a second CDK app with one stack, `<prefix>-runner`. It shares nothing with the router stack, and you deploy and destroy it on its own. It holds **N identical x86 EC2 instances** (`runnerCount`, default 1), which run third-party amd64 task images for the Codex experiments (R2E-Gym; DeepSWE v1.1 via Harbor, one task shard per runner).

- **Why one stack with N instances, not N stacks.** The runners share one VPC, SG, role, secret grant and flow-log group. So there is one deploy, one destroy and one teardown listing, and the instances can't drift apart: they get the same instance type, the same AMI parameter (resolved once per deploy) and the same bootstrap. Only `RUNNER_INDEX` in the env file differs. Each runner is still **stopped on its own** with `aws ec2 stop-instances` when its shard is done. A stopped runner keeps its disk (results, images) and pays only for the volume. User data does not re-run on start; Docker and the firewall come back on boot.
- **Network.** A new VPC (`10.91.0.0/24`) with one public subnet, placed by AZ ID, an internet gateway, no NAT, no VPC endpoints, and flow logs (all traffic, `/<prefix>/runner-vpc-flow`, 1 week). Each instance has a public IPv4 address. The subnet does not assign one by default.
- **Security group.** No inbound rules; egress TCP 443 and 80 only. There is no key pair, so the only way in is SSM Session Manager or Run Command.
- **Instances.**
  - Type: `m7i.2xlarge` by default. Arm (Graviton) types are refused, because the task images are amd64.
  - Image: the latest AL2023 x86_64 AMI from its public SSM parameter, resolved at deploy time.
  - Disk: a gp3 root volume (`runnerVolumeGb`, default 300 GB per runner), encrypted and deleted with the instance.
  - Optional swap file (`runnerSwapGb`).
  - Basic monitoring.
  - Each has the tags Name `<prefix>-runner-<i>` and `RunnerIndex=<i>`.
- **Bootstrap (user data, host only; nothing is fetched from inside a container).**
  - `dnf install docker git tar gzip` (Docker 25). AL2023's docker package has no compose plugin, and its buildx (0.12) is too old for compose v5 `build` (needs ≥ 0.17).
  - The `docker compose` plugin v5.7.0, buildx v0.38.2 and uv 0.13.6, the same versions as the Harbor dry run. Each is a GitHub release asset checked against its pinned sha256 before use. The plugins go to `/usr/local/lib/docker/cli-plugins`, which the CLI searches before the package's directory, and user data checks both versions at the end.
  - sshd is disabled, and user data fails unless nothing listens on port 22. The only way in is SSM.
  - Harbor 0.25.0 as a uv tool with uv-managed Python 3.13 (`--managed-python`, so never a system Python). It is resolved with `--exclude-newer 2026-11-05T00:00:00Z`, so its dependencies don't drift. It is on PATH as `/usr/local/bin/harbor`.
  - `/etc/docker/daemon.json` pins docker0's address (`bip` 172.17.0.1/16). It sets the containers' upstream DNS to `192.0.2.53` (TEST-NET-1, which never answers): compose service names still resolve, external names fail, and because the upstream isn't a loopback address, dockerd never forwards container queries from the host's namespace. It also sets `default-address-pools` to 10.200.0.0/16 in /24s: 256 networks instead of Docker's default of about 30. Harbor creates a compose network per trial for the agent and another for the verifier, and crashed trials can leak them. The pool doesn't overlap the VPC (10.91.0.0/24) or docker0.
  - The firewall (below), then Docker. The pins are `RUNNER_TOOLS` in `src/runner.ts`.
- **Driver contract** (for the orchestration around `harbor run`):
  - `/etc/llmar-runner.env` (sourceable) holds:
    - `RUNNER_INDEX` and `RUNNER_COUNT`;
    - `PROXY_ADDR=172.17.0.1` and `PROXY_PORT`;
    - `HARBOR_VERSION` and `WORK_DIR=/srv/runner`;
    - `RESULTS_PREFIX=runs/<i>/`, the only prefix this runner may write in the results bucket (`ResultsBucketName`);
    - `UV_PYTHON_INSTALL_DIR` and `UV_TOOL_DIR`;
    - `PREPULL_IMAGES`, Harbor's own images by digest (`HARBOR_PREPULL_IMAGES`);
    - `DRIVER_PYTHON`, the path of that uv-managed Python 3.13, for a stdlib-only driver.
  - `/srv/runner` is an empty root-only work dir.
  - `/usr/local/bin/runner-metrics` (root, system python3, no network) prints one JSON line of cumulative counters. Read it before and after each trial (and periodically) and diff:
    - `load` (1/5/15) and `ncpu`;
    - `cpu_jiffies` from `/proc/stat`, including `steal`;
    - `mem_available_kb`, `swap_total_kb` and `swap_free_kb`;
    - `pswpin` and `pswpout` (pages swapped in and out, from `/proc/vmstat`);
    - `psi`: the PSI `some_total_us` and `full_total_us` from `/proc/pressure/{cpu,memory,io}` (cpu has `some`, and `full` on newer kernels). With swap, memory pressure shows up as slowdown rather than OOM kills, and timeouts are scored;
    - the kernel's `oom_kill` count;
    - `docker_free_bytes`;
  - Per-container OOM comes from the container state (`docker inspect … .State.OOMKilled`) before teardown, not from runner-metrics.
- **No instance credentials inside containers.**
  - IMDSv2 is required with a hop limit of 1, and the IPv6 IMDS endpoint and instance tags in IMDS are off. A token response cannot cross the extra hop to a container on a Docker bridge network.
- **Host firewall for the container bridges** (`docker0` and every user-defined `br-*` bridge, which includes Harbor's per-trial compose networks). User data installs `/usr/local/sbin/runner-firewall` as a `docker.service` `ExecStartPost`, so it is re-applied on every Docker start. Containers with a restart policy could start before it is applied, so don't give task containers one. If any rule fails, `docker.service` fails and nothing runs (fail-closed).
  - **Forwarded** (`DOCKER-USER`): everything entering from a bridge is dropped, plus `169.254.169.254` from anywhere. Containers get no internet, no IMDS, no VPC hosts and no external DNS. Docker's embedded resolver answers compose names only; its upstream is `192.0.2.53`, and those queries leave from the container's namespace and are dropped, so there is no DNS exfiltration through dockerd. They also get no container-to-container traffic: the script loads `br_netfilter` and sets `net.bridge.bridge-nf-call-ip{,6}tables=1` before any rule, so bridged traffic is filtered too.
  - **To the host** (`INPUT`, chain `RUNNER-BRIDGE-IN`): from a bridge, only replies and TCP to **172.17.0.1:`runnerProxyPort`** (default 8088). Everything else is dropped, including the proxy port on any other host address. Containers on any compose network reach 172.17.0.1 through their own gateway, because it is a host-local address. The host-side proxy must bind exactly there.
  - **IPv6**: everything from a bridge is dropped (`INPUT` and `FORWARD`), so link-local IPv6 can't reach host services either. The VPC has no IPv6.
  - **Harbor's egress sidecar.** The sidecar is gost plus nftables, with `NET_ADMIN`/`NET_RAW`, in the trial's own network namespace, which the `main` container shares. It enforces the per-trial allowlist (the IP literal 172.17.0.1) as a second layer. The host rules bound it from outside: gost's allowed connection to 172.17.0.1:8088 is the only one the host admits. The sidecar needs no other egress: with an IP-literal allowlist it does no DNS, and its image build has no `RUN` network step. Its caps act only on that namespace. The agent process in `main` does not get them.
  - **Raw sockets bypass the sidecar.** `main` and the verifier keep Docker's default `NET_RAW`, and a raw `AF_PACKET` frame from the shared namespace skips the sidecar's nftables (security review F1). The host rules above are the actual boundary: such a frame still gets only 172.17.0.1:8088. The Harbor integration therefore runs the verifier (and oracle and no-op runs) with `network_mode: none` (loopback only), and the agent container drops `NET_RAW`. A custom seccomp profile that denies `AF_PACKET` was considered and not added: it adds nothing on top of that, and it would have to match Docker 25.0.18's built-in default exactly.
  - Through the sidecar, the allowlisted 172.17.0.1 is reachable on every port. So the host rule, TCP 8088 only, is the port boundary, and sshd is off as well.
  - **Image pulls** are made by `dockerd` on the host (OUTPUT), so these rules don't affect them. **BuildKit `RUN` steps are different**: they run in their own network namespace on docker0 (checked on Docker 25.0.18), so `DOCKER-USER` drops their traffic. The DeepSWE verifier image (`tests/Dockerfile`: `FROM` the task image, `COPY`, `RUN chmod`) needs no network. A `RUN` step that does need the network (apt, npm, curl) **fails here by design**. Stage such artifacts on the host instead; for example, the Codex binary is mounted read-only.
  - What hop limit 1 does not cover is a process on the host: the host-side proxy can reach IMDS. **It must refuse `169.254.0.0/16` and `fd00:ec2::254` as destinations.**
- **Agent binaries (Codex, Claude Code) are staged by the harness, not by this stack.** The Harbor harness downloads each pinned agent release on the host and checks its sha256 (`experiments/deepswe-harbor`, its `stage-*` commands run by the fleet's setup step). It bind-mounts the binary read-only into the agent container, so Harbor finds the requested version and installs nothing. The user data fetches no agent, so a version bump needs no redeploy and doesn't restart the instances. With egress `none`, anything an agent sends other than its model calls fails closed whatever its own settings say: telemetry, auto-update, error reporting, any vendor endpoint. External names resolve through `192.0.2.53`, which never answers, everything forwarded from a bridge is dropped, and the only host port it reaches is `172.17.0.1:8088`. The model calls go to the host proxy there, with a dummy key. The worst case is a DNS timeout inside the trial. With egress `internet` (below), the agent's environment settings turn that traffic off, not the firewall. Blocking vendor hosts at the firewall would mean IP denies on shared CDN and cloud addresses that tasks also download from.
- **Container egress `internet` (`-c runnerContainerEgress=internet`; Terminal-Bench, whose tasks are network_mode `public`).** The default `none` is everything above, byte for byte. `internet` adds one network, and every other bridge keeps the rules above.
  - **The online network** `llmar-online`: Linux bridge `br-llmon`, `10.201.0.0/24` (outside the VPC, docker0 and the compose pool), `enable_icc=false`, Docker's MASQUERADE, IPv4 only. The user data creates it after Docker starts and checks its options. The driver attaches the trial's container to it (compose overlay, `external: true`), sets the container's DNS to `ONLINE_DNS`, and refuses to start if the network is missing or differs.
  - **From `br-llmon`** (`RUNNER-ONLINE-OUT`, jumped to from the top of `DOCKER-USER`, above the drops): replies; DNS (UDP/TCP 53) to the VPC resolver `169.254.169.253` only; new TCP connections to **public IPv4 on 443 and 80**, the security group's ports. Never another container (same bridge or any other bridge) or a non-public address: every non-global block of the IANA special-purpose registry (`RUNNER_NON_PUBLIC_V4`: IMDS and the rest of 169.254/16, the VPC and all of 10/8, 172.16/12, 192.168/16, 100.64/10, documentation and benchmarking ranges, multicast and reserved) is dropped. Other public TCP ports get a TCP reset, other protocols (QUIC included) ICMP admin-prohibited, so they fail at once instead of timing out on the SG.
  - **To `br-llmon`** (`RUNNER-ONLINE-IN`): replies only, so no inbound connection, published port or not. To the host and over IPv6, unchanged: only `172.17.0.1:8088`.
  - **DNS.** Security groups and network ACLs can't filter traffic to the Amazon DNS server, and with egress limited to TCP 80/443 public resolvers are unreachable, so the online network uses the VPC resolver. daemon.json is unchanged: every other network still gets `192.0.2.53`.
  - **Connection log.** Each new TCP connection from `br-llmon`, accepted or rejected, is logged to the kernel log with the prefix `llmar-online: ` (interfaces, source and destination address and port; no payload): `journalctl -k --grep llmar-online -o short-iso-precise`. VPC flow logs record container traffic under the instance's private IP, so they can't tell a container from the host.
  - **Env file:** `CONTAINER_EGRESS=internet`, `ONLINE_NETWORK=llmar-online`, `ONLINE_DNS=169.254.169.253`. With `none` none of these keys is written; absent means `none`.
  - **Switching a running runner** (no redeploy): `runner-ssm/runner-egress-internet.sh` and `runner-egress-none.sh`, generated from `src/runner.ts` (`node src/runner-ssm.ts`; a test fails if they differ). Run one as root through Run Command (`AWS-RunShellScript`) while **no container runs**: it refuses otherwise. It backs up the firewall script and env file under `/var/lib/llmar-runner/egress-backup/`, installs what a fresh deploy with that mode has, applies it (dockerd keeps running), creates or checks the online network, and checks every rule. `none` restores the deployed rule set exactly and leaves the (now offline) network in place. Both are idempotent; each undoes the other. The scripts assume proxy port 8088 and fail if the env file says otherwise.
  - **Tests without a runner.** `test/runner-netns/packets.sh` runs a firewall script in an unprivileged user and network namespace (real iptables-nft, veth, bridges, `br_netfilter`, conntrack and NAT, with Docker 25's bridge rules) and probes what containers on each bridge reach; `switch.sh` dry-runs the switch scripts. `runner-egress.test.ts` runs both where the kernel allows it.
- **Instance role** (one, shared by the instances).
  - The SSM Agent minimum for Session Manager and Run Command, inline on `*`: `ssm:UpdateInstanceInformation`, `ssmmessages:{Create,Open}{Control,Data}Channel`, and `ec2messages:{AcknowledgeMessage,DeleteMessage,FailMessage,GetEndpoint,GetMessages,SendReply}`. It does not get `AmazonSSMManagedInstanceCore` and its `ssm:GetParameter(s)`, document and association reads on `*`. State Manager associations and Session Manager logging to S3 or CloudWatch are therefore not available.
  - `secretsmanager:GetSecretValue` on exactly one secret ARN.
  - Only with a direct model (`runnerDirectModel`, default GPT-6.1 Sol, for arm D of the R2E-Gym run: Codex straight to bedrock-runtime Responses): `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on that model only. This uses the same global-profile pattern as the task role, plus the Responses default-project grant limited by `bedrock:ModelArn` to it. **With `-c runnerDirectModel=none` (DeepSWE: no direct arm) the role has no Bedrock action at all.**
  - `s3:PutObject` on the runner's own results prefix (below).
  - Nothing else. The secret must use the default `aws/secretsmanager` key; a customer-managed key would also need `kms:Decrypt`, which is not granted.
- **Results bucket** (private; for fetching the full trial dirs).
  - Block Public Access (all four), SSE-S3, TLS only (`enforceSSL`) and `BucketOwnerEnforced` (no ACLs). The bucket policy holds only the TLS deny, so there are no public grants.
  - Not versioned. Objects expire after 30 days; incomplete multipart uploads are aborted after 1 day. The name is generated.
  - **Runner `i` may only `s3:PutObject` under `runs/<i>/`.** This is per instance, not just per role: the policy `PutRunResults` on the shared role has one statement per runner, conditioned on the global key `ec2:SourceInstanceARN` (present on every request signed with instance-profile credentials) equal to that runner's instance. The policy names the instances, so it is a separate `AWS::IAM::Policy`; inline on the role it would be a cycle.
  - No runner can get, list, delete or set ACLs. So upload with `aws s3 cp` (`--recursive`) or a tarball, **not `aws s3 sync`**, which needs `ListBucket`. Reads happen from the operator's credentials.
  - No `autoDeleteObjects` (no extra Lambda): **empty the bucket before `cdk destroy`** (below).
- **Output.**
  - `InstanceIds`: a comma list ordered by `RunnerIndex`.
  - `ResultsBucketName`.

| Key | Default | Notes |
|---|---|---|
| `region`, `account`, `prefix`, `tags` | as for the router stack | `tags` merge over `{"Project":"llm-auto-router","Purpose":"experiment-runner"}`. The Region needs a bundled price catalog unless `runnerDirectModel=none`. |
| `runnerSecretArn` | none | **Required.** The full ARN, including the 6-character suffix, of a secret in the deploy Region and account. Create it before deploying. |
| `runnerCount` | `1` | 1–8 identical runners. Above 1, `runnerInstanceType` is **required**: a fleet never falls back to the 32 GiB default. |
| `runnerDirectModel` | `global.openai.gpt-6.1-sol` | The one model the role may invoke directly (must be in the Region catalog, with Responses), or `none` for no Bedrock grant. |
| `runnerAzId` | the first AZ ID in the Region's table | E.g. `apse1-az1`. Pick one that offers the instance type. |
| `runnerInstanceType` | `m7i.2xlarge` | x86_64 only. |
| `runnerVolumeGb` | `300` | Per runner, 50–4000. |
| `runnerSwapGb` | `0` | Swap file on the root volume, at most half of `runnerVolumeGb`. |
| `runnerProxyPort` | `8088` | The only host port that containers on the bridges can reach, on 172.17.0.1 only. The host-side proxy listens on it. |
| `runnerContainerEgress` | `none` | `none`: nothing forwarded from any bridge (DeepSWE). `internet`: the `llmar-online` network also reaches public IPv4 on TCP 80/443 and the VPC resolver (Terminal-Bench); see above. |
| `runnerAmiId` | none | Pins the AMI. Without it, a redeploy after a new AL2023 release **replaces the instances**, and their disks with them. Pin it, or don't redeploy during a run. |

```
cd infra                                   # same R, A, P, OWNER as the router deploy; same CDK bootstrap
RCTX="-c region=$R -c account=$A -c prefix=$P -c tags={\"Owner\":\"$OWNER\"} -c runnerSecretArn=<secret-arn>"
# DeepSWE v1.1 via Harbor (design §6/§9): 4 runners, 8 vCPU / 64 GB, sized for one ~28-task shard each
RCTX="$RCTX -c runnerCount=4 -c runnerInstanceType=r7i.2xlarge -c runnerVolumeGb=250 -c runnerSwapGb=32 -c runnerDirectModel=none"
npx cdk deploy  --app 'node src/runner-app.ts' $RCTX     # synth runs cdk-nag
aws s3 rm "s3://<ResultsBucketName>" --recursive         # first: the bucket must be empty (no autoDeleteObjects)
npx cdk destroy --app 'node src/runner-app.ts' $RCTX
```

**Sizing for DeepSWE v1.1** (one shard per runner, 6 concurrent trials plus their verifiers):
- **Task images.** The 113 images `public.ecr.aws/d3j8x8q7/swe-bench-202605:<ext_id>-v1.1` are single-platform linux/amd64 manifests (measured from the registry manifests on 2026-11-05, without pulling). Per image, the compressed size is 0.76–2.55 GB (median 0.85), but most of that is a shared base (about 0.75 GB in every image). The unique compressed layers of all 113 images come to 24.3 GB. For one shard:
  - random 4-way splits: 8.9 GB median, 13.4 GB worst;
  - bound: the 29 largest images together are 18.3 GB.
  Unpacked on overlay2 that is roughly 3× (2.5–4×), so up to about **75 GB** per shard.
- **Running containers.** Harbor 0.25.0 limits CPU and memory, but not storage (the tasks' `storage_mb = 20480` is not enforced on overlay2/xfs). So the writable layers of 6 agent and 6 verifier containers are budgeted at 8 GB each: **96 GB**. Harbor deletes trial environments by default; keep it that way.
- **Verifier images** add a few MB each on top of the task image (layers are shared).
- **Other:** swap 32 GB; Harbor trial outputs, logs, uv, Python and the OS about 20 GB.
- **Total:** about 223 GB in the bad case, about 115 GB typically. So **250 GB per runner**.
- **Memory.** 6 trials at 2 CPU / 8 GB each, plus verifiers (8 GB limits), can exceed 64 GB briefly. The 32 GB swap (swappiness 10) is a buffer against OOM kills. `runner-metrics` reports swap-in/out, memory/cpu/io PSI, `steal` and `oom_kill`, so the driver can log them per trial.
- **Concurrency: 6 or 5, decided by the pilot, then fixed.** Start the pilot at 6 concurrent trials per runner. Drop to **5** if, during agent phases, there is sustained swap-in (`pswpin` rising across samples) or memory PSI (`psi.memory.some_total_us` growing by a noticeable share of wall time). Whichever value the pilot picks is used **on all runners for the whole run**: it is part of the setup, not a knob to change mid-run, because concurrency changes per-trial latency and so the scored timeouts.
- **Pre-pull** on each runner, by host `dockerd`:
  - `PREPULL_IMAGES` from the env file: `alpine:3.23.4@sha256:5b10f4…` (Harbor's nftables kernel probe) `gogost/gost:3.2.7-nightly.20260602@sha256:afc013…` (the sidecar base) and `python:3.13-alpine@sha256:7984cf…` (the isolation suite's probe image);
  - the shard's task images.
  On this kernel, `nft_fib_inet` is a module and `/proc/config.gz` is absent, so Harbor's probe passes and the modules load on demand. The pilot must confirm that the sidecar starts.

- **After deploy, check (each runner):**
  - no inbound rules on the SG;
  - `MetadataOptions` with `HttpTokens=required` and `HttpPutResponseHopLimit=1` (`aws ec2 describe-instances`);
  - `sudo iptables -S DOCKER-USER`, `sudo iptables -S RUNNER-BRIDGE-IN` and `sudo ip6tables -S INPUT` show the rules above;
  - `swapon --show`, `docker compose version`, `harbor --version`, `cat /etc/llmar-runner.env` and `sudo runner-metrics`;
  - from a container on the default bridge and on a compose network, `curl -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'` gets no token, an external host and the VPC resolver time out, `getent hosts example.com` fails (while the compose service name resolves), `172.17.0.1:22` and `<gateway>:8088` are refused or time out, and `172.17.0.1:8088` reaches the proxy.
- **Wait for cloud-init first.** Run `sudo cloud-init status --wait` (it should end with `status: done`) before any check or run. Until the user data finishes, Docker is inactive and the firewall isn't applied yet; a probe in that window may also see `iptables` call the chains "incompatible", which is transient. The tool installs make the first boot take a few minutes. Afterwards, `systemctl status docker` shows the `ExecStartPost` (`runner-firewall`) exited 0.
- **Pilot checks, before any task image runs.**
  - Never run a task container with `--network host` or `--privileged`. Either one bypasses the bridge firewall, and host networking also bypasses hop limit 1. Don't add capabilities like `NET_ADMIN` or a `--restart` policy either. The one exception is Harbor's own egress sidecar (`NET_ADMIN`/`NET_RAW` in the trial's namespace; see above). A task's own `docker-compose.yaml` must not add any; DeepSWE v1.1 tasks ship none.
  - `/usr/sbin/iptables` and `ip6tables` exist, and `systemctl is-active docker` reports active. The user data fails early if either is missing.
  - With Harbor's allowlist set to 172.17.0.1, the agent container reaches the proxy, and nothing else: an external host, a hostname, the VPC resolver and IMDS must all fail. The verifier (no network) reaches nothing.
- **After destroy,** nothing `<prefix>-runner*` is left: the instances, VPC, role, instance profiles, flow-log group and results bucket. If the bucket was not empty, `cdk destroy` fails on it; empty it and run the destroy again. The exception is the default-SG custom resource's Lambda log group, as for the router stack. The secret is not part of the stack; delete it separately.
- **Running the experiment router.**
  - Policy: `-c policyFile=packages/router/config/policy.experiment.ap-southeast-1.json`, which is the default policy in `auto` mode.
  - Assessor: `-c assessorMode=auto -c assessorAutoRules=all`.

**Cost while deployed, per runner.** On-demand prices for ap-southeast-1 from the AWS Price List API, retrieved 2026-11-05. Prices change, so re-check before relying on them.
- r7i.2xlarge (8 vCPU / 64 GiB): USD 0.6384/h. It is offered in apse1-az1, az2 and az3.
- gp3: USD 0.096/GB-month. 250 GB is USD 24/month, or about USD 0.033/h, and is still paid while the instance is stopped.
- Public IPv4 address: USD 0.005/h, only while the instance is running.
- Flow logs: CloudWatch Logs ingestion, small. Results bucket: S3 storage and PUT requests, small.
- Image pulls are inbound, so free. Egress to the internet is billed per GB.
- Total for 4 × (r7i.2xlarge + 250 GB): about **USD 2.69/h**, or USD 2.71/h with the four public IPv4 addresses. That is about USD 65/day. A stopped runner costs about USD 0.033/h.
- The default `m7i.2xlarge` (32 GiB) is cheaper. Check its price for the Region.

## Limits and things to check in E2E

- **Request size.** 10 MiB per request: the API Gateway REST payload cap, below the gateway's 12 MB. A larger request gets 413 from API Gateway, a 4xx, so the 5XX fallback does not apply.
- **Streams.** Up to 15 minutes. API Gateway's idle timeout for private endpoints is 5 minutes; the router's own idle timeout (240 s) fires first.
- **Fallback chain.** Rule `MatchPaths` only accepts one-segment prefixes (API pattern `/[\w\-.]+/\*`, e.g. `/inference/*`), so a rule cannot pick a model per API path. The chain is Sonnet 5.5 (Messages), then GPT-6.1 Sol on a 4XX (Chat/Responses reject Claude). E7 must confirm both paths.
  - On Chat/Responses each fallback makes one extra, rejected (unbilled) Sonnet call first.
  - If both fallback models fail, the client sees the last target's error.
  - The route's first-byte timeout (610 s, a fallback trigger) sits above the router's 600 s non-stream header deadline. That deadline covers all attempts, failover included, so the router always answers first.
- **Circuit breaker.** It is enabled explicitly on the fallback route (also the default). After repeated router failures the gateway takes the router out of the chain for a while. Traffic then goes **silently** to the pinned fallback model: no router decisions, no router logs or accounting for those requests. The gateway's documented CloudWatch metrics (`AWS/Bedrock-AgentCore`: Invocations, SystemErrors, UserErrors, Throttles, Latency, Duration, TargetExecutionTime, TargetType) have no fallback or circuit-breaker metric, so compare the gateway's `Invocations` with the router's `Requests`. E7b measures how long the breaker keeps skipping the router after it recovers.
- **Old bundled schema.** The `MatchModels` and `StaticRoute.Fallback` overrides follow the CloudFormation reference, but the schema bundled with aws-cdk-lib predates them (warning F3018 is acknowledged).
- **Catch-all rule.** Every model name goes to the router (lowest-priority rule; verified in the identity spike, S7). A concrete Bedrock model id is a pin there: served if it is in the policy and within the caller's tier limit, otherwise 400 `pin-not-allowed` or `access-cap`. Only the 5XX fallback still reaches Bedrock without the router, and those calls are unattributed.
- **Logging.** API Gateway access and execution logging need the account-level API Gateway CloudWatch role. The stack does not set it; the cdk-nag findings are acknowledged with that reason.
