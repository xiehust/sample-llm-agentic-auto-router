# LLM agentic auto router

A cache-aware model router for agent traffic, deployed behind Amazon Bedrock AgentCore Gateway. Clients send
`model: auto` (or `auto:<tier>`) on the Anthropic Messages, OpenAI Chat Completions or OpenAI Responses API. The
router picks a Bedrock model per request, but switches models only at cache break points, so an agent's prompt
cache is not thrown away mid-task. A downgrade must pass a cost check: the projected saving over the next calls
has to beat the cost of starting the cheaper model with a cold cache. An optional LLM tier assessor classifies turns in observe mode: its verdicts are logged, not applied.

> [!IMPORTANT]
> **This is sample code for demonstration and education. It is not production-ready as is.** Review its
> security, cost and Bedrock / API Gateway quotas against your own requirements before you deploy it in your
> account. You are responsible for the AWS costs it incurs.
>
> The stack has a **fixed cost of about USD 113/month in ap-southeast-1 while it is deployed**, even with the
> router scaled to 0 tasks (interface endpoints and the internal NLB), plus per-task, per-request and token
> charges. Other Regions differ. **Destroy the stack when you finish testing.** See
> [infra/README.md, "Cost and teardown"](infra/README.md#cost-and-teardown).

## Architecture

![System architecture](docs/architecture/diagrams/01-system-architecture.png)

Request path:

1. The client gets a JWT (Cognito client credentials) and calls **AgentCore Gateway**, which checks the JWT.
2. Requests for `auto` / `auto:*` go to the router target: a **private REST API** (AWS_IAM), which the gateway
   calls with SigV4 through its managed private endpoint.
3. The API forwards through a **VPC link** to an internal **NLB**, then to the router on **ECS Fargate**.
4. The router decides the model, rewrites only the top-level `model` field, SigV4-signs the call to
   **bedrock-runtime** over a VPC endpoint, and streams the response back.
5. If the router returns 5XX or cannot be reached, the gateway falls back to fixed models (Sonnet 5.5, then
   GPT-6.1 Sol).

The detailed design document is in Chinese: [docs/architecture/architecture.zh-CN.md](docs/architecture/architecture.zh-CN.md).
The English design and requirement documents are indexed in [docs/README.md](docs/README.md).

## Repository layout

| Path | Contents |
|---|---|
| [packages/pricing](packages/pricing/README.md) | Versioned Bedrock price catalogs per Region and usage-cost accounting |
| [packages/core](docs/tasks/11-04-router-core/design.md) | The routing decision: tiers, cache break points, cost check, failover (pure, no I/O) |
| [packages/assessor](docs/tasks/11-04-llm-tier-assessor/research/README.md) | Optional LLM tier assessor, its prompt packs and offline evaluation |
| [packages/router](packages/router/README.md) | The `node:http` data-plane service behind the gateway |
| [packages/replay](docs/tasks/11-04-replay-evaluator/design.md) | Offline replay of agent traces against routing policies |
| [infra](infra/README.md) | CDK app (TypeScript) for the gateway, private API, NLB, Fargate router and VPC |
| [spikes](spikes) | Verification experiments: gateway front door (V0–V8) and router hop options (V9 Lattice, V9d private REST API) |
| [docs](docs/README.md) | Architecture, design documents and research notes |

## Prerequisites and quick start

- Node.js 24 or later.
- pnpm through Corepack (`corepack enable`). The version is pinned in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r test
```

The tests need no AWS account: the router's integration tests use a local fake Bedrock.

To deploy, follow [infra/README.md](infra/README.md). Region and account are explicit deploy parameters; nothing
falls back to your shell's Region:

```bash
cd infra && npx cdk deploy -c region=<aws-region> -c account=<account-id> -c prefix=<unique-prefix> ...
```

The Region needs a price catalog: one is bundled for `ap-northeast-1` and `ap-southeast-1`, or you can capture
one for another Region (see [packages/pricing/README.md](packages/pricing/README.md)). The shipped default
policy runs in observe mode: it logs the decisions it would make and serves `auto` requests with a fixed model.

## Security

The router has no internet path: its subnets have no internet gateway or NAT, and AWS services are reached
through VPC endpoints. The gateway-to-router hop is SigV4-signed (AWS_IAM on the private REST API), and the
API's resource policy admits only the gateway's role through its own VPC endpoint. IAM is least-privilege: the
task role may invoke exactly the models in the router's policy, and the gateway role only the fallback models.
Credentials and tokens are never logged. Details are in [infra/README.md](infra/README.md#iam).

TLS ends at API Gateway. The last leg inside the VPC (VPC link → internal NLB → router task on port 8080) is plain
HTTP: the NLB's security group has no ingress rules and admits only VPC link traffic, and the router's security
group admits only the NLB. If your policy requires encryption on that leg as well, add a TLS listener with an
ACM certificate to the NLB and point the API Gateway integration at `https://`.

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

## Third-party data

- The offline assessor evaluations reference [SWE-bench Verified](https://www.swebench.com/) by instance id and
  aggregate results only. No dataset text is in this repository.
- The replay evaluator can use [TraceLab](https://github.com/uw-syfi/TraceLab) traces (CC BY 4.0). They are not
  committed; see [packages/replay/data/README.md](packages/replay/data/README.md) for how to fetch them and the
  attribution.
