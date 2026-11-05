# Spike implement plan

1. [x] Write `spikes/agentcore-gateway/template.yaml` (base stack) with the stub inline.
2. [x] Deploy stack via AWS MCP (CreateStack, wait), record outputs in `state.json`.
3. [x] Security gate: anonymous POST to stub URL and gateway → expect 403 from IAM; stop if 2xx.
4. [x] V0: create stub target with inferred signing; if it fails, explicit `iamCredentialProvider`;
       call `/inference/v1/messages` with `stub-echo`.
5. [x] V1: create private provider target in the spike VPC; record accept/reject; delete.
6. [x] V2/V3/V4/V7 against the stub (sha compare, SSE gaps, headers, model ids, GET/DELETE).
7. [x] V5 size ladder (1, 5, 7, 10 MB) on stub and Bedrock paths with `max_tokens: 1`.
8. [x] V8 cache: Haiku 5.5 Messages with a ~3K-token cached system prompt, twice; with and without
       `anthropic-beta`.
9. [x] V6 fallback rule (stub-503 → Bedrock Haiku 5.5), call, inspect response.
10. [x] Write `research/spike-findings.md`; recommendation for MVP.
11. [x] Teardown; verify tag-based listing empty; note spend.

Validation: every step's raw request/response saved under `spikes/agentcore-gateway/results/`.
Rollback: teardown script is idempotent and can run at any step.
