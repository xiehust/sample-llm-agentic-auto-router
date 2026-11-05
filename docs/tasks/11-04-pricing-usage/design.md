# Design: @auto-router/pricing

Implements the `@auto-router/pricing` contract in parent `design.md` §3 without changing any names.
Additive exports are listed in §6. The package has no runtime dependencies.

## 1. Facts gathered for ap-northeast-1 (2026-11-04)

Source calls (read-only):
- `bedrock:ListInferenceProfiles` (SYSTEM_DEFINED) and `bedrock:ListFoundationModels` in ap-northeast-1.
- `pricing:GetProducts` with `regionCode=ap-northeast-1`, services `AmazonBedrockFoundationModels` and `AmazonBedrock`.

Profiles present in Tokyo that the three pass-through APIs can reach:
- **Messages (Claude only):** `global.` and `jp.` for Opus 5.5, Haiku 5.5, Opus 4.8, Opus 4.7 and Haiku 4.5. `global.` only for Sonnet 5.5, Fable 5.1, Fable 5, Opus 5 and Sonnet 5.
  - Opus 4.6/4.5 and Sonnet 4.6/4.5/4 have Tokyo profiles but Messages = ✘ on the compatibility page, so they are excluded (Converse is out of scope).
- **Chat Completions and Responses:** `global.` only for GPT-6 Astra, 6.1 Sol, 6.1 Terra, 6 Sol, 6 Luna, 5.6 Sol/Terra/Luna, 5.5, 5.4 and Kimi K3. `moonshotai.kimi-k2.5` is in-Region on-demand (Chat only).

Price data issues found:
- **Sonnet 5.5 has no Tokyo SKU.** The Price List carries Sonnet 5.5 in 33 regions but not ap-northeast-1 or ap-northeast-3, even though `global.anthropic.claude-sonnet-5-5` is ACTIVE in Tokyo.
  - Global prices are identical across source regions for every other Claude 5.x model I checked (Opus 5.5 Tokyo = us-east-1).
  - So I use the us-east-1 global SKU: 2 / 10 / write 2.50 (5m) / 4.00 (1h) / **read 0.10**. The entry is marked `priceSource: "price-list:us-east-1 (no ap-northeast-1 SKU)"`.
- **The Sonnet 5.5 cache-read conflict (B says 0.20) is resolved as 0.10.** Evidence:
  - the Price List says 0.10;
  - Anthropic's pricing page footnote says 0.05× base;
  - the Bedrock pricing page notes "cache read pricing for Claude Sonnet 5.5 drops by 50% starting October 7, 2026".
  - 0.20 is **Sonnet 5's** read price, which is probably where B's number came from.
- **GPT has only GPT-6 Astra in the Tokyo Price List.** For the other GPT models I take the global prices from the model-card pricing tables (A2 raw extract) and mark `priceSource: "model-card"`.
  - GPT-5.5 and 5.4 have no global price anywhere (the cards only show In-Region/mantle prices), so they are **excluded** and recorded under `excluded`.
- **Kimi K3 / K2.5:** prices come from the Tokyo Price List. Its usagetype names say `mantle`, but the card lists K3 as runtime-only; the price is the same.

## 2. Catalog

### 2.1 Files
- `packages/pricing/data/catalog.ap-northeast-1.json` is the canonical, human-reviewed data. Raw Price List and list-call snapshots go in `data/snapshots/`.
- `packages/pricing/src/catalog.data.ts` is generated from the JSON by `scripts/gen-catalog.ts`, run with plain `node`, which strips types natively on Node 24.
  - A test fails if the JSON and the generated module drift apart.
  - Reason: `core`/`replay` import pricing as TS source, so a JSON import would force `resolveJsonModule` on their tsconfigs. A generated TS module also bundles cleanly into Lambda.
- `loadCatalog()` returns a validated, frozen copy of the generated data. Validation is hand-written: required fields, non-negative finite prices, `defaultTtl ∈ ttls` unless `mode: 'none'`, `longContext.aboveTokens < contextWindow`, and unique `modelId`. A violation throws `CatalogError`.

### 2.2 JSON schema (superset of `PriceCatalog`)

```jsonc
{
  "version": "2026-11-04.1",        // date + revision; bump when any price changes
  "asOf": "2026-11-04",
  "source": "AWS Price List API (regionCode=ap-northeast-1) + Bedrock model cards",
  "region": "ap-northeast-1",
  "models": [{
    "modelId": "global.anthropic.claude-haiku-5-5",
    "family": "claude", "tier": "fast",
    "dialects": ["anthropic-messages"],
    "endpointScope": "global",                 // global. → global, jp. → geo, bare id → in-region
    "contextWindow": 1000000,
    "price": { "input": 0.10, "output": 0.50, "cacheRead": 0.01, "cacheWrite": { "5m": 0.125, "1h": 0.20 } },
    "longContext": { "aboveTokens": 100000, "price": { "input": 0.50, "output": 2.50, "cacheRead": 0.05, "cacheWrite": { "5m": 0.625, "1h": 1.00 } } },
    "cache": { "mode": "explicit", "minTokens": 512, "ttls": ["5m", "1h"], "defaultTtl": "5m" },
    "priceSource": "price-list:ap-northeast-1"   // additive optional field (§6)
  }],
  "excluded": [{ "modelId": "global.openai.gpt-5.5", "reason": "no global price published" }]  // additive, informational
}
```

### 2.3 Model list (25 entries; prices are USD/MTok, Tokyo source region)

| Model id | Tier | Dialects | Cache (mode / min / TTLs) | Long ctx |
|---|---|---|---|---|
| global. / jp. anthropic.claude-opus-5-5 | frontier | messages | explicit / 512 / 5m,1h | — |
| global.anthropic.claude-sonnet-5-5 | standard | messages | explicit / 512 / 5m,1h | — |
| global. / jp. anthropic.claude-haiku-5-5 | fast | messages | explicit / 512 / 5m,1h | >100K |
| global.anthropic.claude-fable-5-1, global.anthropic.claude-fable-5 | frontier | messages | explicit / 512 / 5m,1h | — |
| global.anthropic.claude-opus-5 | frontier | messages | explicit / 512 | — |
| global.anthropic.claude-sonnet-5 | standard | messages | explicit / 1024 | — |
| global. / jp. anthropic.claude-opus-4-8 | frontier | messages | explicit / 1024 | — |
| global. / jp. anthropic.claude-opus-4-7 | frontier | messages | explicit / 4096 (Bedrock table) | — |
| global. / jp. anthropic.claude-haiku-4-5-20251001-v1:0 | fast | messages | explicit / 4096 | — |
| global.openai.gpt-6-astra, gpt-5.6-sol | frontier | chat, responses | both / 1024 / 30m | >272K |
| global.openai.gpt-6.1-sol, gpt-6-sol, gpt-6.1-terra, gpt-5.6-terra | standard | chat, responses | both / 1024 / 30m | >272K |
| global.openai.gpt-6-luna, gpt-5.6-luna | fast | chat, responses | both / 1024 / 30m | >272K |
| global.moonshotai.kimi-k3 | standard | chat, responses | both / 256 / 30m | — |
| moonshotai.kimi-k2.5 (in-region) | fast | chat | none / 0 / — | — |

Notes:
- `jp.` entries use the Price List `*_standard` SKU, which is +10%.
- GPT-6.1 Terra and the 5.6 models only take explicit breakpoints on Responses. `cache.mode` stays `both` because implicit caching works on both dialects. The per-dialect detail goes in an optional `notes` field.
- **Tier labels are a policy input, not a fact.** I'll keep them in the JSON so router-core can override them.
- `contextWindow` comes from the model cards. Where the A/A2 sources don't state it, I fetch the card during implementation; anything still unknown is flagged with `"contextWindowSource": "unverified"`.
- For `cache.mode: 'none'` the contract still requires `defaultTtl`. It is set to `"5m"` and documented as ignored. `ttls` is `[]`.

## 3. Usage normalization

Common rules:
- `promptTokens = uncached + read + Σwrite`.
- Missing or null counters count as 0.
- If OpenAI-shape counters are inconsistent (cached + write > input), uncached is clamped to 0 and the original values are kept in `promptTokens`.
- `normalizeUsage` throws `UsageNotFoundError` when the body has no usage object.

| Dialect | Non-streaming body | Mapping |
|---|---|---|
| anthropic-messages | `usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, output_tokens}` | `uncached = input_tokens` (already excludes the cache). Writes are split by `cache_creation`; anything left over from `cache_creation_input_tokens` goes to `5m`. `reasoningTokens` is undefined (thinking is inside output). |
| openai-chat | `usage.{prompt_tokens, completion_tokens, prompt_tokens_details.{cached_tokens, cache_write_tokens}, completion_tokens_details.reasoning_tokens}` | `uncached = prompt − cached − write`. Writes are split by `cache_write_tokens_details.ttl_30m_tokens / ttl_12h_tokens` when present, otherwise all to `30m` (the only Bedrock TTL). |
| openai-responses | `usage.{input_tokens, output_tokens, input_tokens_details.{cached_tokens, cache_write_tokens}, output_tokens_details.reasoning_tokens, cache_write_tokens_details?}` | Same as chat (input includes cached and written tokens). |

Streaming (`push({event?, data})`; `data` is the raw SSE data string; the type comes from `data.type`, then from `event`):
- **Messages:** `message_start.message.usage` is the base. Every `message_delta.usage` overwrites the fields it carries (counts are cumulative). Result is available once `message_start` is seen. `ping`/`error`/content events are ignored, and non-JSON data is ignored.
- **Chat:** the last chunk with a non-null `usage` wins (sent with `stream_options.include_usage`). `[DONE]` is ignored. Without usage, `result()` returns `undefined`.
- **Responses:** `response.completed`, `response.incomplete` or `response.failed` → `data.response.usage`.
- Malformed JSON never throws from `push`; it is silently ignored. The `skipped` counter was dropped because nothing outside the package can see it.
- As implemented, Messages also returns a result from a `message_delta` without a prior `message_start`. Null fields in a delta never overwrite values from `message_start` (regression test added after review).

**Data-plane note: Chat Completions streams without `stream_options.include_usage` carry no usage.**
- Verified on 2026-11-04 with fixture `openai-chat/stream-no-include-usage.sse.txt`: `global.openai.gpt-6-luna` in ap-northeast-1 sent no `usage` key in any chunk, not even `usage: null`, before `[DONE]`.
- In that case `result()` is `undefined`. The router (router-dataplane-mvp) has to decide between:
  - injecting `stream_options: {include_usage: true}`. That changes the client-visible stream by adding one extra final chunk with `choices: []`, so a strict client may need it stripped again.
  - accepting unknown usage for those requests, for example by falling back to a token estimate.
- Messages and Responses streams always carry usage.

Observed field details (fixtures, 2026-11-04):
- **Messages:**
  - `usage.output_tokens_details.thinking_tokens` exists, and it maps to `reasoningTokens`.
  - `message_start.usage` carries the `cache_creation.{ephemeral_5m,1h}` split.
  - `message_delta.usage` repeats the cumulative totals without the split. So the TTL split is kept from `message_start`, and any difference against the final `cache_creation_input_tokens` goes to `5m`.
- **Chat / Responses:**
  - `prompt_tokens_details.cache_write_tokens` and `input_tokens_details.cache_write_tokens` are present with Bedrock's explicit breakpoints.
  - No TTL breakdown field is returned, so writes are attributed to `30m`.
  - Responses streams send only `data:` lines with no `event:` lines, so the type is read from `data.type`.

## 4. Cost

- Tier selection: `tier = longContext && usage.promptTokens > longContext.aboveTokens ? 'long' : 'base'`. The whole request is priced from that tier.
  - Haiku 5.5: "prompts over 100,000 tokens", strictly greater than.
  - GPT: ">272K". **[unverified whether the boundary is >272,000 or ≥]**. I use strictly greater and record that in a test name.
- `input = uncached·p.input`, `cacheRead = read·p.cacheRead`, `cacheWrite = Σ tokens[ttl]·p.cacheWrite[ttl]`, `output = outputTokens·p.output`, all divided by 1e6. `total` is the sum, with no rounding (callers format).
- A write TTL that is missing from the price table falls back to `p.cacheWrite[cache.defaultTtl]`. If that is missing too, `costOf` throws `PricingError`. This catches catalog mistakes loudly.

## 5. Fixtures (real ap-northeast-1 responses)

Endpoints:
- Messages: `POST https://bedrock-runtime.ap-northeast-1.amazonaws.com/anthropic/v1/messages`, model `global.anthropic.claude-haiku-5-5`.
- Chat Completions and Responses: `/openai/v1/chat/completions` and `/openai/v1/responses`, model `global.openai.gpt-6-luna`. Responses calls send `store: false`.

Capture script: `.trellis/tasks/11-04-pricing-usage/scripts/capture_fixtures.py`.
- uv inline-deps Python script using botocore `SigV4Auth` (service `bedrock`), per the parent's review.
- Credentials come from the default profile `credential_process`, the same role as the MCP session.
- The account is verified to be the expected one with `sts:GetCallerIdentity` before any call.
- The pre-set `AWS_BEARER_TOKEN_BEDROCK` is **not** used, because its account is unknown.

Per dialect, a ~1,500-token static system/developer prefix, `max_tokens` 32:
1. non-stream cold (cache write)
2. non-stream warm (cache read)
3. stream warm (read)
4. stream with a fresh prefix (write)
5. Messages only: one `ttl: "1h"` write, to capture `ephemeral_1h_input_tokens`

That is 13 calls with an estimated spend under $0.01 (Haiku 5.5 / GPT-6 Luna at about $0.10/MTok input).

Scrubbing:
- Drop all response headers except the content type.
- Replace any `id`, `msg_*`, `resp_*`, `chatcmpl-*`, request ids and 12-digit numbers with stable placeholders.
- A test asserts that no fixture matches `/\d{12}/`.

Saved as `packages/pricing/src/__fixtures__/<dialect>/<case>.json`, or `.sse.txt` for streams (raw SSE text, parsed by a small test helper).

## 6. Additive exports and optional fields (no changes to §3 names)

- Exports: `findModel(catalog, modelId)`, `CatalogError`, `PricingError`, `UsageNotFoundError`, `parseSse(text)` (test helper, also useful for replay).
- Optional fields on `ModelPrice`: `priceSource?: string`, `notes?: string`, `contextWindowSource?: string`. These are additive optional fields, so existing consumers are not affected.
- Optional field on `PriceCatalog`: `excluded?: {modelId, reason}[]`.
