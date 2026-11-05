# Documentation

`docs/tasks/` holds the project's planning and design records, one directory per task: requirements
(`prd.md`), technical design (`design.md`), implementation plan (`implement.md`) and research notes
(`research/`). The architecture overview is in [architecture/](architecture/).

Start here:

| Document | What it is |
|---|---|
| [tasks/11-04-llm-auto-router/prd.md](tasks/11-04-llm-auto-router/prd.md) | Requirements, user decisions and the child-task map |
| [tasks/11-04-llm-auto-router/design.md](tasks/11-04-llm-auto-router/design.md) | Topology, package contracts, decision logic, spike outcomes |
| [tasks/11-04-gateway-frontdoor-spike/research/spike-findings.md](tasks/11-04-gateway-frontdoor-spike/research/spike-findings.md) | AgentCore Gateway front-door spike results (V0–V8) |
| [architecture/assessor-eval.zh-CN.md](architecture/assessor-eval.zh-CN.md) | LLM tier assessor evaluation: datasets, method, pack v1 → v2 → v2.1 results, conclusions, next steps (Chinese) |
| [tasks/11-04-llm-auto-router/research/](tasks/11-04-llm-auto-router/research/) | Research: provider caching (A, A2), router landscape (B), cache-aware routing (C), LLM tier assessor (D) |

Child tasks (each with `prd.md`, and `design.md` / `implement.md` once planned): `router-core`, `pricing-usage`,
`replay-evaluator`, `router-dataplane-mvp`, `llm-tier-assessor`.
