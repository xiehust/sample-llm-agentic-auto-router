# Cache-aware agentic LLM auto router

## Goal

A model router for agent traffic that saves cost without breaking prompt caching. Agents keep using
their native SDKs (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses). AgentCore Gateway
is the unified front door; a self-built router behind it chooses the model and forwards to Amazon
Bedrock. Region: a deployment parameter chosen by whoever deploys it (this project will be published). This
deployment uses ap-southeast-1 (user decision 2026-11-04; the V0–V9 spikes ran in ap-northeast-1). Account: the one named in `scripts/local.env` (treated as production: create only new,
tagged resources; never modify or delete anything this project did not create).

Background and evidence: `research/` (A: provider caching, A2: Bedrock GPT/Kimi + API matrix,
B: router landscape v2, C: inference-layer cache-aware routing). The design discussion that led
here is summarised in `design.md` §1.

## Requirements

### Functional

- R1 Front door: clients call AgentCore Gateway `/inference/v1/messages`, `/inference/v1/chat/completions`,
  `/inference/v1/responses`. Converse is out of scope.
- R2 Pass-through: the router forwards request bodies unchanged except the model identifier and
  opt-in cache hints; streaming (SSE) is preserved end to end.
- R3 Per-API model pools: Messages → Claude family; Chat Completions / Responses → GPT, Kimi and other
  OpenAI-compatible Bedrock models. No cross-API translation.
- R4 Hard locks (never switch): inside a tool loop (last message is a tool result); Responses requests
  with `previous_response_id`; history containing provider-specific state that the target cannot accept.
- R5 Decision points: free break points (session start, new sub-agent, idle > provider TTL, compaction)
  get a full routing decision; a new user turn gets a cost-gated decision with hysteresis; failover goes
  to the same model on another endpoint before any model change.
- R6 Cache state per (session lineage, model, endpoint), calibrated from response usage (closed loop).
- R7 Session identity: explicit headers first (`x-claude-code-session-id`, `x-session-id`, router
  lineage headers), prompt fingerprint otherwise; parent, fork and sub-agent lineages are distinct.
- R8 Two modes: transparent (heuristics only) and cooperative (harness sends lineage, boundary and
  lock hints). An advisory API is a later phase.
- R9 Policy: deterministic gate (pool, context window, modality, compliance) + rules (template
  family → tier) for MVP; versioned; `observe` (record only) before `auto`; every decision recorded
  with reason and policy version; decision returned in response headers.
- R10 Cost accounting: normalized usage (uncached, cache read, cache write by TTL, output), price
  catalog with long-context tiers, per-session cost and hit rate, miss attribution.
- R11 A concrete model ID sent by the client pins the model (no routing), still accounted.

### Non-functional

- N1 Router overhead (excluding network hops) p50 < 20 ms, p99 < 100 ms.
- N2 All AWS resources tagged `Project=llm-auto-router`, `Owner=<owner>`, `Purpose=<spike|mvp>`,
  named with prefix `llmar-`; every deployment has a matching teardown.
- N3 Security (builder-security policy): gateway → router hop authenticated with SigV4/AWS_IAM (no
  self-minted API keys); router not anonymously reachable; least-privilege IAM; verify anonymous
  denial before deploying anything.
- N4 Stack: TypeScript (Node 24, ESM, strict), pnpm workspace, vitest, AWS CDK for infra.
- N5 Publishable (decided 2026-11-04): region, account, resource prefix and tags (e.g. `Owner`) are deployment
  parameters with no project-specific defaults baked into code; price catalogs are per region (bundled for the
  regions we have captured, plus a documented read-only capture script); pools and failover profiles are
  validated against the chosen region's catalog at synth and at router boot (fail fast on a model the region
  lacks); no Amazon-internal systems, links or policies referenced in code or docs; auth uses mechanisms native
  to AWS (SigV4/IAM, Cognito JWT); no account ids, credentials or third-party dataset text in the repo.

## Child tasks

| Child | Deliverable | Depends on |
|---|---|---|
| `11-04-gateway-frontdoor-spike` | Go/no-go evidence for the front-door topology (V0–V8) + teardown | — |
| `11-04-router-core` | `@auto-router/core`: pure decision engine | contracts in `design.md` §3 |
| `11-04-pricing-usage` | `@auto-router/pricing`: price catalog, usage normalizers, cost | contracts in `design.md` §3 |
| `11-04-replay-evaluator` | `@auto-router/replay`: offline policy evaluation | core + pricing interfaces |
| `11-04-router-dataplane-mvp` | `@auto-router/router` service + CDK + gateway wiring | spike result, core, pricing |
| `11-04-llm-tier-assessor` | `@auto-router/assessor`: lite-model tier assessor (default GPT-6 Luna; Haiku 5.5 etc.) | core TierAssessor hook |

## User decisions (2026-11-04)

- Inbound auth: CUSTOM_JWT gateway (Cognito client-credentials); AWS_IAM gateway later for boto3/Strands.
- Gateway → router hop: VPC Lattice service with IAM auth policy (verified first in V9); fallback: private REST API.
  V9 outcome: Lattice is not viable (AgentCore signs payloads; Lattice rejects signed payloads), so the hop is the
  private REST API (fallback (d)), verified in V9d (`11-04-router-dataplane-mvp/research/v9-findings.md`).
- Region is a deployment parameter (2026-11-04): users choose it; nothing may hard-code a region. This deployment
  uses ap-southeast-1 because ap-northeast-1 is at its VPC quota in this shared account. Singapore has every pool
  model through `global.` profiles (no `jp.`/regional profiles, so failover is cross-model there), AgentCore
  Gateway and all three AZs for managed private endpoints.
- The project will be published (2026-11-04): see N5.
- Gateway fallback models: Sonnet 5.5 (Messages), GPT-6.1 Sol (Chat/Responses).
- Chat streams: inject `stream_options.include_usage` and strip the usage chunk (configurable).
- Responses GET/DELETE out of MVP. Budget for V9 + E2E ≤ USD 5. Dependencies approved (router, infra, e2e).
- Add an LLM tier assessor (default GPT-6 Luna, other lite models such as Haiku 5.5 configurable).

## Acceptance Criteria

- [ ] Spike report answers V0–V8 with evidence and a go/no-go for the topology; all spike resources removed.
- [ ] `@auto-router/core` unit tests cover hard locks, break points, lineage separation, cost-gated
      switching, hysteresis and switch-back (fragmentation) on synthetic agent traces.
- [ ] `@auto-router/pricing` normalizes real Bedrock responses (ap-northeast-1 fixtures) for the three
      APIs, streaming and non-streaming, and costs match hand calculations.
- [ ] `@auto-router/replay` reproduces the break-even table in `design.md` §1 and reports cost, switch
      count and hit rate per policy on at least one public agent trace.
- [ ] Data plane MVP: Claude Code (Messages) and an OpenAI SDK client (Chat Completions, Responses) work
      through Gateway → router → Bedrock with streaming; in `observe` mode the cache hit rate is within
      2 percentage points of calling Bedrock directly.

## Out of scope

Converse; cross-API translation; learned quality predictors; Anthropic/OpenAI first-party endpoints;
advisory API (later phase).
