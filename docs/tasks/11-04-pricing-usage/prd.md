# Price catalog and usage normalization (Bedrock, three pass-through APIs)

## Goal

`packages/pricing` (`@auto-router/pricing`): versioned price catalog, usage normalizers and cost
calculator implementing the contracts in `../11-04-llm-auto-router/design.md` §3.

Read first: parent `prd.md`, `design.md`; research `A-provider-caching.md`, `A2-bedrock-gpt-kimi-apis.md`.

## Requirements

- Catalog (bundled JSON + typed loader) for models reachable from **ap-northeast-1** on bedrock-runtime
  through Messages, Chat Completions or Responses: Claude (Opus/Sonnet/Haiku 5.5, Fable 5.1, Opus 5,
  Sonnet 5, others present in the region), GPT (6.x, 6.1, 5.6), Kimi K3. One entry per profile scope that
  exists in the region (`global.`, `jp.`). Prices from the AWS Price List API for the Tokyo source region
  (do not assume us-east-1 prices); record `asOf` and `source`. Include long-context tiers, cache write
  price per TTL, cache read, min cacheable tokens, context window, cache mode, tier label.
- `normalizeUsage` and `createStreamUsageAccumulator` for Messages (`input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_*`), Chat
  Completions and Responses (`input_tokens_details.cached_tokens`, `cache_write_tokens`, reasoning
  tokens; `input_tokens` includes cached on OpenAI shapes). Streaming: usage arrives in
  `message_start`/`message_delta` (Messages), final chunk with `stream_options.include_usage` (Chat),
  `response.completed` (Responses).
- `costOf` with base vs long-context tier selection on `promptTokens`.
- Fixtures: capture real responses (non-streaming and streaming) from bedrock-runtime in ap-northeast-1
  for one cheap model per dialect, including one cache write and one cache read. Strip account ids and
  request ids from fixtures.

## Acceptance Criteria

- [ ] Fixture-based tests for all three dialects, streaming and non-streaming, including cache read/write.
- [ ] Cost tests that match hand calculations (include a Haiku 5.5 >100K-tier case and a GPT >272K case).
- [ ] Catalog validation test: every model id exists as a model or inference profile in ap-northeast-1
      (recorded snapshot of the list call; the test itself is offline).
- [ ] `pnpm -C packages/pricing typecheck && pnpm -C packages/pricing test` green; no runtime dependencies.

## Constraints

- Work only inside `packages/pricing/` and this task directory.
- AWS usage: read-only calls (Price List, ListInferenceProfiles, ListFoundationModels) and small model
  invocations for fixtures in ap-northeast-1, total spend under USD 1. No resource creation.
- No commits.
