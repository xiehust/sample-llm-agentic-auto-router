# Status / handoff (updated 2026-11-08: admin console live)

Read this first after a context reset. Details: `prd.md` (requirements, user decisions, **N5 Publishable**),
`design.md` (topology, §3 contracts), child task docs, `research/`. Chinese architecture doc:
`docs/architecture/architecture.zh-CN.md`.

## What we are building
Cache-aware model router for agent traffic. AgentCore Gateway is the front door for Messages / Chat Completions /
Responses (no Converse); a self-built router behind it picks the model and forwards byte-exact to Bedrock runtime.
Switching only at cache break points, cost-gated downgrades, per-model cache state from usage. An LLM tier assessor
(default GPT-6 Luna, observe-first) supplies task intent. **The repo will be published; region is a deploy parameter.**

## User decisions (all approved)
- CUSTOM_JWT (Cognito client credentials) inbound.
- **Gateway → router hop = private REST API** (AWS_IAM, resource policy pinned to the gateway role + execute-api VPC
  endpoint, identity headers mapped from context.identity) → VPC link → internal NLB → ECS Fargate. VPC Lattice was
  ruled out in V9 (AgentCore signs payloads; Lattice rejects signed payloads). Verified in V9d.
- Gateway fallback chain: router →(5XX / connection / 610 s first byte) Sonnet 5.5 →(4XX) GPT-6.1 Sol (per-path rules
  impossible: MatchPathPattern is single-segment).
- Chat `include_usage` inject-strip; Responses GET/DELETE out of MVP; budget V9 + E2E ≤ $5 (stop at $4.50), assessor
  eval ≤ $2 (spent $0.78); SWE-bench for internal eval only (ids + aggregates).
- No vLLM Semantic Router as a component. `.trellis/` is NOT committed: docs mirrored by `scripts/sync-docs.sh`.
- **Region is a deploy parameter** (users choose). This deployment: **ap-southeast-1** (Tokyo at VPC quota in this
  shared account). Region, account, prefix, tags explicit; per-region price catalogs; no internal references (N5).
- Defaults decided by the parent: count gates minTurns 1 for cost-modeled presets (v2); assessor may not downgrade out
  of frontier (`assessorDowngradeFrom: ['standard']`); default policy one model per tier, global profiles only, no
  siblings; pins outside the policy → 400; beta table is a deny-list and never changes the served model in observe.
- **Failover (user, 2026-11-05):** same-model profile rotation (global. ↔ geo) only on 429 (`failover.profileRotateOn`,
  default [429]); 5xx/connection errors go to a same-tier sibling or the gateway fallback (cf45b3f).

## Rules of engagement
- Peers (ListAgents `sample-llm-agentic-auto-router-*`): a3 = pricing + data plane + infra; 0d = core + independent
  reviewer; 73 = replay + assessor; 4f = architecture doc. Peers don't commit; the parent commits per package after
  checks. Only the parent does AWS writes. Account from `scripts/local.env` (`LLMAR_SPIKE_ACCOUNT`); never in docs/code.
  Treat the account as production: only new `llmar-*` resources, tagged, verified teardown.
- builder-security: SigV4/IAM service-to-service, verify anonymous denial first, never log credentials.
- Every infra/router change gets an independent review by a peer that did not write it (0d) before deploy.

## Task status
| Task | State | Next |
|---|---|---|
| gateway-frontdoor-spike | done (V0–V8, Tokyo) | archive |
| pricing-usage | done; per-region catalogs (apne1, apse1) + capture script | archive |
| router-core | done; 167 tests; TierAssessor hook, guards, exported checkPolicyAgainstCatalog | follow-ups in core design §11 |
| replay-evaluator | done; final report in research/README.md | archive |
| llm-tier-assessor | v1 done (eval README); 73 on pack v2 (Luna-only re-eval ≤ ~$1) + N5 audit | commit after report |
| router-dataplane-mvp | **MVP deployed to ap-southeast-1 and E2E run** (E0–E12 pass except E6 assertion, fixed in d1debcf; spend $0.036); destroyed and verified | re-run E6, e5b, e7b on next deploy (0d review of cf45b3f first) |
| architecture doc (zh) | committed f63b4dd | 4f updates §13/§14 with E2E results |
| codex-deepswe-eval | done: 580 runs; report withdrawn 2026-11-07 (R2E tasks too easy to be useful); core-gate-fixes merged 2834b91 | archive |
| deepswe-harbor-eval | **done**: 112 tasks × 4 arms × 5 runs; report `docs/experiments/deepswe-harbor.zh-CN.md` (6a3f454); Bedrock $4,597 | archive |
| tbench-harbor-eval | **done**: 84 tasks × 4 arms × 3 runs; report `docs/experiments/tbench-harbor.zh-CN.md` (b4f73e5); Bedrock $532; runners torn down and verified 2026-11-07 | archive |
| harbor summary | **done**: `docs/experiments/harbor-summary.zh-CN.md` (20dbfd6) | — |
| assessor-pack-v2-2 | **done**: report `docs/experiments/assessor-v2.2.zh-CN.md`; released v2.2 = the frozen v2.2-D content (frontier narrowed, no fast rule) as the default pack (db02ed5), router redeployed in observe mode, E0 7/7; spend $0.84 of $5 | archive |
| escalation-experiment | **no-go at the $0 gate** (d33e3f5, design §3, §7.8): none of 16 router-observable prefix-only rules fires selectively on failures; Sol→Astra +0.7/0.0 pp at ×2.2–2.6, Luna→Sol −12 to −20 pp; no live run, budget not requested | archive; untested: mid-session re-consult, transcript judgement, restart policy |
| admin-console (11-08) | **done, live**: ConsoleStack + RouterStack in ap-southeast-1 (main 49e3760); E2E r/c1/c2/c3/id pass, browser spec 11/11; first admin seeded via -c adminEmail (user request); Chat max_tokens → max_completion_tokens fix deployed (22ff639); router-measured E2E spend $0.0057 | Trellis finish (spec, journal, archive); publish via `publish` branch when asked |

## Commits (this session)
core df20bf1, 04d54a2, e0c651c, 246aecb, b199464, 823d3d8, aff804a · replay 135d2ec · assessor a83da2f ·
router c36ae50, 5396530, 4c211b0, 83b8196 · failover 429-only cf45b3f · pricing b725e20 · infra ab2947f. Uncommitted: spikes/lattice-hop,
spikes/apigw-hop, assessor/replay WIP (73), docs/architecture (4f), docs/tasks sync.

## AWS state
**2026-11-08 (admin console):** llmar-router redeployed from clean worktrees (final image caf0290: identity observe, baked config staged as config/baked.json, router state line every 5 min, Chat max_completion_tokens fix); llmar-console deployed (ee06653: CloudFront + private S3 + HTTP API JWT, console-api, usage-ingest subscription, DLQ empty; seed-admin for the first admin). Deploy context adds -c console=true -c consoleBundle=true -c ingest=true -c adminEmail=<admin> (keep adminEmail on later deploys or omit it: the seed's Delete is a no-op). E2E test users deleted.

Deployed (stays up, user decision 2026-11-05): llmar-router in ap-southeast-1, image 2834b91 (task def :11, deployed
from a clean worktree), since 2026-11-07 the default observe config (policy.default, assessor observe; user decision after the
Harbor runs), redeployed from a clean worktree of 554d4be; E0 7/7 pass, probe torn down. Torn down and verified 2026-11-05: llmar-runner (instance, VPC,
volume, role, custom-resource log group), secret llmar-runner/client, the leftover llmar-e2e-probe stack (and its ingress
rule on the execute-api endpoint SG). Previously: V9 (Tokyo), V9d and the MVP (Singapore) torn down and verified. Left in the shared CDK
bootstrap repo/bucket (Singapore): our router image (83 MB) and 2 small file assets (≈ $0.01/month) — user decided
2026-11-05 to keep them for the next deploy.

## E2E (MVP, ap-southeast-1, 2026-11-04)
E0 gate (desired 0 and 1), E1 OpenAI Chat SDK, E2 Responses (+chain hard lock, stored responses deleted), E3 scripted
Claude Code-style tool loop (12/12, hard-locked tool turns), E4 hit rate within 2 pp of direct, E5 pins, E7 fallback
chain, E8 10 MiB/413, E9 token redacted, E10 heartbeat through a 330 s pause, E11 overhead p50 0 ms / p99 3 ms, E12 log
hygiene: PASS. E6: router 503 → gateway fallback PASS; next-turn assertion wrong for a first-call fault (fixed, re-run
next deploy). First deploy failed: gateway targets raced the role's DefaultPolicy (fixed 88d879f).

## E2E re-run (ap-southeast-1, 2026-11-05, image 1285e0f, deployed from a clean worktree)
E0 (0 and 1 task) 7/7, E1–E5, E8, E9, E11, E12 PASS. E5b PASS after a harness fix (its calls had no session header,
so they joined the fingerprint lineage of earlier checks; router correct). E6 PASS 6/6 (router 503 → gateway fallback
Sonnet; next turn retain `failover: exhausted`). E7b (informational): router at 0 tasks → all 30 `auto` requests served
by the gateway fallback, each with TTFB ≈ 12.2 s (first 5 = last 5: no circuit-breaker short-cut observed over 6 min);
router served again as soon as its NLB target was healthy (no hold-off); the gateway publishes only
InboundAuthorization* metrics (no fallback/breaker metric). E2E spend ≈ $0.07.
Now deployed: experiment config (policy.experiment auto, assessor auto, autoRules all). Smoke: `auto` mechanical edit →
assessor fast (1.1 s) → Luna; pinned Sol → no assessor, overhead 1 ms. Stack stays up (user decision).

## Codex × R2E-Gym experiment (ap-southeast-1, 2026-11-05)
200 tasks, 580 runs + 9 pilot, 0 errors. Solved: A Sol 79.5% ($9.42) · F Luna 72.0% ($0.90) · C Astra (60) 81.7%
($14.69) · B auto+assessor (30) 86.7% · D direct (10) 60%. F−A −7.5 pp [−12.0, −3.1], McNemar p=0.0015, ΣF/ΣA 0.095.
C = A on all 60 (0 discordant) at 5.4× cost. Assessor (v2.1, Luna) said standard on every task, so the hindsight
per-task tier choice (same solves at 0.18× always-Sol) was not captured. Router transparent: cache retention 100%, no
fallbacks/failovers, overhead p50 1 ms; assessor ~1.2 s once per session. Spend ≈ $34 router-priced incl. runner (~6.6 h, $3.86).

## Key facts
- V9d: hop 200 on all APIs, byte-exact; 10 MiB request cap (413); SSE cadence kept; >300 s silence and 15 min total
  cut cleanly (router heartbeat 60 s + 240 s detector + stream-cap logging added); TTFB p50 ~637 ms.
- API Gateway forwards the gateway's x-amz-security-token unless mapped (MVP maps it to 'redacted'; router logs hopToken).
- Idle MVP cost ≈ $115/month (endpoints + NLB) even at desiredCount 0: destroy after E2E.
- Assessor: Luna fast precision 87% overall, p50 1.3 s; both lite models miss frontier work (0/45) → guard.
