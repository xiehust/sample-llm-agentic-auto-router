# Spike design

## Resources

Base CloudFormation stack `llmar-spike` (stable parts, one-shot delete):

| Logical id | Type | Purpose |
|---|---|---|
| StubRole | IAM role | Lambda logging only (no Bedrock access) |
| StubFn | Lambda (nodejs22.x, inline CommonJS, response streaming) | echo stub for the three APIs |
| StubUrl | Lambda Function URL, `AuthType AWS_IAM`, `RESPONSE_STREAM` | the "router" endpoint |
| StubLogs | Log group, 3-day retention | request records |
| GatewayRole | IAM role trusted by `bedrock-agentcore.amazonaws.com` (SourceAccount condition) | Bedrock invoke (Haiku 5.5, GPT-6 Luna only), Bedrock list for connector discovery, invoke the stub URL |
| Gateway | AgentCore Gateway `llmar-spike-gw`, `AWS_IAM` inbound, `ExceptionLevel DEBUG` | front door |
| BedrockTarget | inference connector `bedrock-runtime`, `GATEWAY_IAM_ROLE` | real model path |
| Vpc + 2 subnets + SG | isolated VPC (no IGW/NAT, SG without ingress) | V1 acceptance test only |

API-created (recorded in `spikes/agentcore-gateway/state.json`, deleted before the stack):
stub targets (V0 inferred signing, V0 explicit `iamCredentialProvider{service: lambda}`), private target
(V1), fallback rule (V6).

## Stub behaviour

- Logs `{method, path, len, sha256(raw body), model, headers, query}` and echoes the same metadata.
- Valid minimal response shape per path: Messages, Chat Completions, Responses (`POST`, `GET /{id}`,
  `DELETE /{id}`); SSE when `stream: true`, 10 chunks 100 ms apart, each carrying a server timestamp.
- Model `*503*` → HTTP 503 (fallback test). Response headers `x-router-decision`, `x-router-model`,
  `x-stub-sha256` for V3.

## Client

`spikes/agentcore-gateway/client/spike.py` (uv inline deps: botocore, requests): SigV4
(`bedrock-agentcore`) requests to the gateway; anonymous probes; per-question test functions writing JSON
results to `spikes/agentcore-gateway/results/`.

## Order and safety

1. Deploy base stack; verify anonymous denial on the stub URL and the gateway (403 from the gate) first.
2. V0 (decides whether the rest uses the stub), then V2, V3, V4, V7 on the stub; V5, V8 on the
   Bedrock connector; V6 last (creates a rule); V1 acceptance test anytime (delete right after).
3. Teardown script deletes recorded targets/rules, then the stack; final tag-based listing must be empty.
