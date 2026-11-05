# Spike: AgentCore Gateway front door with self-built router target (ap-northeast-1)

## Goal

Decide, with evidence, whether AgentCore Gateway can front a self-built router as an inference
provider target (parent `design.md` §2), and which constraints the data-plane MVP must design around.

## Questions (each needs a recorded answer with evidence)

- V0 Outbound auth: can the gateway SigV4-sign to a custom endpoint on an inference provider target
  (Lambda Function URL with `AuthType AWS_IAM`), with the signing service inferred or set explicitly via
  `iamCredentialProvider`? (Self-minted API keys are not allowed by policy.)
- V1 Private connectivity: does an inference provider target accept `privateEndpoint` (managed VPC Lattice)?
- V2 Pass-through fidelity: are request bodies byte-identical at the target for `/v1/messages`,
  `/v1/chat/completions`, `/v1/responses`? Are SSE chunks delivered incrementally (no buffering), and what
  latency does the extra hop add?
- V3 Headers: which client headers reach the target by default; does `metadataConfiguration`
  allowlisting work on inference targets (`x-claude-code-session-id`, `x-session-id`, `anthropic-beta`,
  `x-router-*`); do allowlisted response headers come back?
- V4 Model ids: is a target-qualified id (`stub/xyz`) stripped before forwarding; do glob model entries
  match; what happens on collision with the Bedrock connector?
- V5 Body size: the gateway's request-size limit for inference (stub and Bedrock connector paths).
- V6 Fallback: a rule that falls back from the router target to the Bedrock target with a pinned model —
  does it trigger on 5xx before the first byte, and can the caller tell?
- V7 Responses: do `GET`/`DELETE /v1/responses/{id}` route through the gateway (no model in body)?
- V8 Cache through the gateway: does `cache_control` survive to Bedrock (second call shows cache reads);
  does `anthropic-beta` reach Bedrock on the connector path?

## Acceptance Criteria

- [ ] `research/spike-findings.md` answers V0–V8 (yes/no/partial + evidence: request, response, logs).
- [ ] Anonymous requests to the stub URL and to the gateway are denied (observed 403 from the IAM gate)
      before any test traffic.
- [ ] Recommendation for the MVP: hosting option, auth path, header list, size limits, fallback config.
- [ ] Teardown done: API-created targets/rules deleted, then the CFN stack deleted; resource listing shows
      nothing tagged `Project=llm-auto-router, Purpose=spike` remains.
- [ ] Bedrock spend under USD 2.

## Constraints

- Account from `scripts/local.env` (`LLMAR_SPIKE_ACCOUNT`), region ap-northeast-1, treated as production: create only new resources named
  `llmar-spike-*` and tagged `Project=llm-auto-router, Owner=<owner>, Purpose=spike`; never modify or
  delete anything else.
- The stub never holds Bedrock permissions; it only echoes. Real model calls go through the gateway's
  own Bedrock connector target, limited by IAM to Claude Haiku 5.5 and GPT-6 Luna.
