# Router data plane MVP behind AgentCore Gateway

> Revised 2026-11-04 with the spike results (`../11-04-gateway-frontdoor-spike/research/spike-findings.md`) and
> the landed `@auto-router/core` / `@auto-router/pricing` packages. Planning only: the user must review this
> plan before `task.py start`. Every AWS write is executed by the parent session (0c).

## Goal

Build `packages/router` (`@auto-router/router`). It is a container HTTP service behind AgentCore Gateway that:
- runs `@auto-router/core` decisions;
- forwards Messages, Chat Completions and Responses requests to `bedrock-runtime` in ap-northeast-1, changing only the model id;
- streams responses back;
- accounts usage with `@auto-router/pricing`.

`infra/` (CDK, TypeScript) deploys the service, the gateway, its targets and rules, and inbound auth. An end-to-end check with real agent clients closes the MVP.

## Facts from the spike that constrain this plan

- Gateway SigV4 works with an explicit `iamCredentialProvider {service, region}` and fails with inferred signing. `CALLER_IAM_CREDENTIALS` does not work for custom endpoints.
- A Lambda URL caps bodies at about 4.5 MB, while the gateway passes at least 12 MB. **The router runs in a container (ECS Fargate).**
- `privateEndpoint` is accepted on inference and HTTP passthrough targets, but no private end-to-end path has been proven yet.
- Bodies are byte-identical, SSE is incremental, and the hop adds about 80 ms TTFB. At most 10 request and 10 response headers are allowlisted per target. `target/model` ids have the prefix stripped.
- The gateway fallback rule (router 5XX → Bedrock pinned model) works for streaming. Responses `GET`/`DELETE` are only routable through an HTTP passthrough target.
- `cache_control` and the 1h TTL survive the gateway. `anthropic-beta` is forwarded and validated by Bedrock.
- The target sees the gateway role session (`x-amz-source-arn` = gateway ARN), **not** the end client. Client `user-agent` and `x-forwarded-for` are not forwarded.

## Requirements

### Functional

- **D1 Routes.**
  - `POST /v1/messages`, `/v1/chat/completions` and `/v1/responses` reach the router through an **inference provider target**.
  - Optionally, `GET`/`DELETE /v1/responses/{id}` and `POST /v1/responses/{id}/cancel` go through an **HTTP passthrough target** on the same service.
  - Upstream paths are `bedrock-runtime` `/anthropic/v1/messages`, `/openai/v1/chat/completions` and `/openai/v1/responses`.
- **D2 Pass-through.**
  - The forwarded body equals the client body byte for byte except the top-level `model` value, plus opt-in hints (D7).
  - Response bytes (JSON or SSE) are relayed unchanged, chunk by chunk.
- **D3 Model ids.**
  - Clients send `router/auto`, `router/auto:<tier>` or `auto*`; the router sees `auto…`.
  - A concrete Bedrock id pins the model (R11).
  - The router target never registers globs that overlap Bedrock ids.
- **D4 Hop authentication (V9).** The gateway → router hop is authenticated by an AWS-verified mechanism chosen in V9 (design §4). The router is never anonymously reachable, and no self-minted API keys are used.
  - Defence in depth: the router checks `x-amz-source-arn` equals the configured gateway ARN and, on the Lattice path, that the Lattice-asserted principal is the gateway role.
  - The router fails closed when misconfigured.
- **D5 Inbound auth for clients.** A gateway authorizer serves Claude Code (Messages) and the OpenAI SDK (Chat, Responses) with their native configuration (design §5).
- **D6 Decisions.**
  - `core.summarize → decide`, then forward the decided model, then `core.record` with served model, status, usage and response id.
  - `observe` mode by default; `auto` behind policy configuration.
  - Decision headers on every response: `x-router-decision`, `x-router-model`, `x-router-reason`.
  - Cooperative hints come from the allowlisted headers: `x-router-session`, `x-router-parent-session`, `x-router-agent-id`, and `x-router-hint` (a compact `k=v;…` form of pin, tier and boundary).
- **D7 Opt-in hints, configured per hint.**
  - `stream_options.include_usage` injection for Chat streams. The usage-only chunk is stripped again unless the client asked for it.
  - Claude automatic caching flag.
  - Claude cache TTL selection.
- **D8 Beta-header compatibility.**
  - `anthropic-beta` and `openai-beta` are passed through.
  - A switch to a model that is not known to accept every beta value is vetoed (retain, with reason `beta-incompatible`).
- **D9 Failover.**
  - On 429/5xx before the first byte is sent, retry once with the **same model on the next profile** from the policy pool (e.g. `jp.` ↔ `global.`). Then report to core (`point: failover`).
  - Router-side failures return 5xx so the gateway fallback rule serves the request from a pinned standard-tier Bedrock model. Core treats unseen turns as break points.
- **D10 State.** `core.InMemoryStateStore` runs behind the `StateStore` interface, with a single task for the MVP. An external store is a later task.
- **D11 Observability.**
  - One structured JSON log line per request. It never contains bodies, prompts, `authorization`, `x-amz-security-token`, `x-api-key` or cookies.
  - EMF metrics: requests, cost, cache read/write tokens, hit rate, switches, misses by cause, router overhead, upstream TTFB, errors.
- **D12 Limits.** Request body up to 16 MiB (configurable; 413 beyond that). Streams can last up to the hop's connection limit (Lattice: 10 min, see design §4).

### Non-functional

- **N1** Router overhead (receive complete → upstream request start, plus header write) p50 < 20 ms, p99 < 100 ms.
- **N2** Every resource is tagged `Project=llm-auto-router`, `Owner=<owner>`, `Purpose=mvp`, prefixed `llmar-`, and removed by teardown.
- **N3** Security (builder-security):
  - The router lives in private subnets with no internet egress.
  - Ingress is only from the hop mechanism.
  - IAM is least privilege.
  - Anonymous denial is verified before any traffic or real configuration is deployed.
- **N4** The stack is Node 24, ESM and TypeScript strict, with node:http (no web framework), vitest and CDK TypeScript.

## Acceptance Criteria

- [ ] V9 report: the chosen hop mechanism is verified end to end, covering anonymous denial, non-gateway principal denial, 12 MB body, incremental SSE, the long-stream limit and header spoofing. The rejected options are recorded with evidence.
- [ ] Unit and integration tests (local fake Bedrock on 127.0.0.1, pricing fixtures) cover: model splice byte fidelity, three dialects streaming and non-streaming, usage accounting, include_usage inject/strip, beta veto, failover, fail-closed inbound check, and log redaction.
- [ ] Claude Code (Messages, `router/auto`) and an OpenAI SDK client (Chat Completions and Responses) work end to end through the gateway with streaming. Decision headers come back and per-request cost is logged.
- [ ] In `observe` mode, the cache hit rate over a scripted 20-turn agent session is within 2 pp of calling Bedrock directly with the same model. Decision records show `wouldChoose`.
- [ ] With the router scaled to 0, the gateway fallback rule serves requests from the pinned Bedrock model.
- [ ] Router overhead p50 < 20 ms and p99 < 100 ms over ≥ 200 requests, measured from router logs.
- [ ] Teardown removes every deployed resource, verified by a tag scan plus the gateway/Lattice/ECS/VPC/Cognito listings.

## Out of scope

Converse; cross-API translation; an external state store; multi-task session affinity; per-tenant routing based on end-user identity (the router does not see it on the inference target path, see design §5.4); the advisory API.
