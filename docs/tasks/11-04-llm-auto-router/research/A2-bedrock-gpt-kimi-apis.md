# A2. Bedrock GPT / Kimi details + support matrix for 4 pass-through APIs + switching cost

> Compiled 2026-11-04. Sources: official AWS Bedrock docs, model cards, AWS blogs, and the AWS Price List API, all fetched the same day. **[unverified]** = not confirmed in official docs. **[conflict]** = official pages disagree.
> Prices are USD per 1M tokens, Standard tier, us-east-1 source region.
> Raw model-card extract (per-model detail, verbatim quotes): `/tmp/llm-router-research/raw/A2-model-cards.md`. Raw HTML: `raw/cards_html/`.

---

## 0. Key conclusions (read first)

1. **Under pass-through, each API reaches a different set of models on Bedrock. The pools barely overlap:**

   | Pass-through API | Models reachable on Bedrock |
   |---|---|
   | Anthropic Messages | **Claude only** |
   | OpenAI Chat Completions | **No Claude, no Nova.** GPT, Kimi, and open-weight models only |
   | OpenAI Responses | **No Claude, no Nova.** GPT-6.x/5.x, Kimi K3, Grok, GLM 5.3, Gemma 4, gpt-oss (mantle only) |
   | Bedrock Converse | **Widest pool**: Claude + Nova + GPT-6.x/5.6 (not 5.5/5.4) + Kimi + most open-weight models. **But GPT and Kimi K3 get only implicit caching on Converse** (`cachePoint` explicit is not supported for them) |

2. **Can Claude be called through Chat Completions or Responses? No.** The Opus 5.5 card and the API compatibility page both mark Chat Completions = ✘ and Responses = ✘ on runtime and on mantle.
   **Can GPT or Kimi be called through the Messages API? No.** Every OpenAI card and every Kimi card marks Messages = ✘.
   So "Claude ↔ GPT/Kimi" routing **is only possible inside Converse**. Inside Messages, Chat, or Responses, the router can only switch between tiers of the same family.

3. **Responses on Bedrock is stateful:**
   - `store` defaults to `true` and responses are kept **30 days**. `previous_response_id` works on both runtime and mantle.
   - On runtime, **`model` is required on every request**, even when `previous_response_id` is set. This gives the router a natural hook: it can change models while continuing the same stored chain. Cross-model behavior is not verified.
   - On runtime, **a stored response belongs to the Region that served it**. A `global.` profile can store data in any commercial Region, and the continuation request has to be handled by that Region. Whether the router can still pick a model freely under a global profile is **[unverified]** (see §2.3).

4. **Price structure flips the intuition.** With a long cached context, the cost per warm step is dominated by output. Switching to a cheaper model often still costs more on the first step.
   - **Moving up (cheap → expensive) is never recovered in cost.** At 150K context, Sonnet 5.5 → Kimi K3 adds a one-time $0.56; GPT-6.1 Sol → GPT-6 Astra adds $1.92.
   - **Kimi K3 at 150K context is more expensive per warm step than Opus 5.5** ($0.0675 vs $0.0600). Its cache read is 0.30 vs 0.20, which outweighs its cheaper output.
   - Details in §3.

---

## 1. GPT and Kimi models on Bedrock

### 1.1 Rules common to all OpenAI GPT models
- **Runtime does not allow in-Region model IDs.** You must use a `us.` or `global.` system inference profile (`us-gov.` in GovCloud). In-Region only works on mantle (path `/openai/v1`). Application inference profiles are rejected with 400 on the runtime Responses API.
- **Messages API = ✘** on both endpoints. **Mantle supports only Responses + Chat Completions.**
- **Long-context tier: >272K input tokens** puts the whole request at roughly 2× input and 1.5× output.
- Price premium: US geo and mantle in-Region = global +10%.
- No Priority or Flex tiers. GPT-6 Astra and GPT-6.1 Sol also have **Ultrafast** (6× Standard).

### 1.2 OpenAI GPT models (from the model cards; global prices cross-checked against the Price List API for Astra)

| Model | Global ID | Context / max out | Runtime API support (Msg / Resp / Chat / Conv / Invoke) | Explicit caching (which APIs) | Global price in / out / cache read / cache write (30m) | >272K global |
|---|---|---|---|---|---|---|
| GPT-6 Astra | `global.openai.gpt-6-astra` | 1.05M / 128K | ✘/✔/✔/✔/✔ **[conflict: the API compatibility page says Invoke ✘]** | Resp, Chat, Invoke. **Not Converse** | 10 / 50 / 1.00 / 12.50 | 20 / 75 / 2.00 / 25 |
| GPT-6.1 Sol | `global.openai.gpt-6.1-sol` | 1M / 131K | ✘/✔/✔/✔/✔ | Resp, Chat, Invoke | 2 / 10 / **0.10** (0.05×) / 2.50 | 4 / 15 / 0.20 / 5 |
| GPT-6.1 Terra | `global.openai.gpt-6.1-terra` | 1.05M / 128K | ✘/✔/✔/✔/✔ | **Responses only** | 1 / 5 / 0.05 / 1.25 | 2 / 7.5 / 0.10 / 2.50 |
| GPT-6 Sol | `global.openai.gpt-6-sol` | 1.05M / 128K | ✘/✔/✔/✔/✔ | Resp, Chat, Invoke | 2 / 10 / 0.20 / 2.50 | 4 / 15 / 0.40 / 5 |
| GPT-6 Luna | `global.openai.gpt-6-luna` | 1.05M / 128K | ✘/✔/✔/✔/✔ | Resp, Chat, Invoke | 0.10 / 0.50 / 0.01 / 0.125 | 0.20 / 0.75 / 0.02 / 0.25 |
| GPT-5.6 Sol | `global.openai.gpt-5.6-sol` | 1.05M / 128K | ✘/✔/✔/✔/**✘** | Responses only | 4 / 20 / 0.40 / 5 | 8 / 30 / 0.80 / 10 |
| GPT-5.6 Terra | `global.openai.gpt-5.6-terra` (also `in.`) | 1.05M / 128K | ✘/✔/✔/✔/✘ | Responses only | 2 / 12 / 0.20 / 2.50 | 4 / 18 / 0.40 / 5 |
| GPT-5.6 Luna | `global.openai.gpt-5.6-luna` (also `in.`) | 1.05M / 128K | ✘/✔/✔/✔/✘ | Responses only | 0.20 / 1.20 / 0.02 / 0.25 | 0.40 / 1.80 / 0.04 / 0.50 |
| GPT-5.5 | `global.openai.gpt-5.5` | 1.05M **including output** / 128K | ✘/✔/✔/✔/✘ **[conflict: the API compatibility page says Converse ✘]** | **None** (implicit on Responses only, no write fee) | Global price not on card. In-Region (mantle): 5.50 / 33 / 0.55 / — | In-Region: 11 / 49.5 / 1.10 |
| GPT-5.4 | `global.openai.gpt-5.4` | same | same as 5.5 | same as 5.5 | Global price not on card. In-Region: 2.75 / 16.5 / 0.275 / — | In-Region: 5.50 / 24.75 / 0.55 |

- Explicit caching parameters: `prompt_cache_options: {mode: implicit|explicit, ttl: "30m"}` (30m is the only value) and `prompt_cache_breakpoint: {mode: "explicit"}`. Minimum 1,024 tokens. ≤4 writes per request. Write price 1.25×.
  - Chat Completions puts the breakpoint on `text` content parts. Responses puts it on `input_text` / `input_image` / `input_file`.
  - The Bedrock prompt-caching doc's Responses example also uses `prompt_cache_key`. The blog says it "routes requests to the same cache". **Unlike the OpenAI 1P docs, it does not say whether 5.6+ ignores the key** [unverified].
- **Converse = implicit caching only** (6.1 Sol / 6 Sol card text: "Converse supports implicit caching … The native `cachePoint` field isn't supported for explicit caching with this model"). For 5.6 Terra and Luna, the card says runtime implicit caching covers Responses / Chat / Invoke / Converse.
- Usage fields:
  - Responses: `usage.input_tokens_details.cached_tokens` / `cache_write_tokens`. `input_tokens` includes both.
  - Chat Completions: probably `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens` **[unverified field name on Bedrock]**.
  - Converse: `usage.cacheReadInputTokens` / `cacheWriteInputTokens` **[whether they are filled for GPT is unverified]**.
- Reasoning: effort values `none|low|medium|high|xhigh|max`, default `medium` (stated explicitly on the GPT-6 Sol / Luna cards; also in the 5.6 blog).
  - Reasoning summaries are available on runtime through Responses / Converse / ConverseStream. On Converse, use `additionalModelRequestFields.reasoning.summary`.
  - On mantle, summaries are Responses only.

### 1.3 Kimi (Moonshot) on Bedrock

| Model | IDs | Context / max out | API support | Caching | Price |
|---|---|---|---|---|---|
| **Kimi K3** (launched 2026-09-18) | `moonshotai.kimi-k3`; `us.` / `in.` / `global.moonshotai.kimi-k3`. **Runtime only (not on mantle), no in-Region** | 1M / not stated | Resp ✔, Chat ✔, Converse ✔, Invoke ✔, Messages ✘ | Implicit by default. Explicit on Resp / Chat / Invoke, **not Converse**. Min 256 tokens. TTL ≥30m | Global 3.00 / 15.00 / read 0.30 / write(30m) 3.75. US/IN: 3.30 / 16.50 / 0.33 / 4.125. Priority 1.75×, Flex 0.5× |
| Kimi K2.5 | `moonshotai.kimi-k2.5`. **In-Region only** (13 regions) | 256K / 16K | Chat ✔, Converse ✔, Invoke ✔, Responses ✘ | **None** (no cache SKU in the Price List) | us-east-1: 0.60 / 3.00 (Price List) |
| Kimi K2 Thinking (Legacy, EOL 2027-03-30) | Runtime `moonshot.kimi-k2-thinking` / mantle `moonshotai.kimi-k2-thinking` (**different prefixes**). In-Region only | 256K / 16K, text only | Converse ✔, Invoke ✔, Chat ✔ per the card **[conflict: the API compatibility page says Chat ✘]** | None | us-east-1: 0.60 / 2.50 |

- K3 reasoning is on by default. Effort is `none…max`, default **`max`**. `minimal` is not supported.
  - Parameters: Responses `reasoning.effort`; Chat / Invoke `reasoning_effort`.
  - **Converse accepts `reasoning_effort` in `additionalModelRequestFields` but doesn't validate it.**
- **Known K3 issue on Converse:** a multi-turn request that includes earlier-turn reasoning content fails with `InternalServerException`. This affects LangChain and Strands in their default setup. You must "remove reasoning blocks from prior turns". The card recommends Responses / Chat Completions over Converse.
- K3 output tokens burn quota at 10×.

### 1.4 Multi-turn reasoning replay requirements and their effect on caching

| API | Required replay behavior | Effect on caching |
|---|---|---|
| Messages (Claude) | Thinking blocks carry a `signature` and must be sent back **unmodified**, especially in tool-use loops. Opus 4.5+, Sonnet 4.6+, and Haiku 5.5 keep earlier thinking by default (see A). | Changing or dropping thinking blocks changes the prefix and misses from that point. Changing thinking or effort parameters invalidates the messages layer. |
| Converse | `reasoningContent` = `reasoningText{text, signature}` or `redactedContent`. "If you pass a reasoning block back … include the text and its signature unmodified" (API reference). **Kimi K3 is the exception: earlier-turn reasoning must be removed.** | The router must keep a **consistent** strip or keep policy per model. If it is consistent, the prefix stays stable. Mixing policies, or switching models (which forces a strip), causes misses. |
| Responses | `store=true` + `previous_response_id`: the server keeps reasoning and feeds it back automatically. `store=false`: request `include=["reasoning.encrypted_content"]` and pass the item back in the next input (Bedrock Grok blog; OpenAI docs). OpenAI 1P: 5.6+ defaults to `reasoning.context: all_turns`; reasoning **does not carry over between model families**. | Switching families drops earlier reasoning automatically, so the prefix changes. OpenAI 1P docs say GPT-6+ `configuration_update` items can change effort without breaking the prefix **[support on Bedrock unverified]**. |
| Chat Completions | Grok on Bedrock does not return reasoning through Chat (blog). Whether GPT / Kimi on Bedrock Chat return a `reasoning_content` field, and whether it should be sent back, is **[unverified]**. | Chat is stateless and reasoning is usually not replayed. The prefix is just the messages you send, so it stays stable. |

---

## 2. Bedrock API surface matrix

### 2.1 Endpoints, paths, auth, and streaming (all hosts take Region `{r}`)

| API | bedrock-runtime (`bedrock-runtime.{r}.amazonaws.com`) | bedrock-mantle (`bedrock-mantle.{r}.api.aws`) | Auth | Streaming |
|---|---|---|---|---|
| **Anthropic Messages** | `POST /anthropic/v1/messages` (Anthropic SDK `base_url=…/anthropic`). Header `anthropic-version: 2023-06-01`. Model can be a `global.` / `us.` profile. **Or** InvokeModel `POST /model/{id}/invoke` with body `anthropic_version: "bedrock-2023-05-31"` | `POST /anthropic/v1/messages`, header `anthropic-version: 2023-06-01`. Bare model ID only (no CRIS). Supports Workspaces and `count_tokens` | Runtime: SigV4 / Bedrock API key / short-term bearer token (`aws-bedrock-token-generator`); the docs' `/anthropic` example sends it as `x-api-key`. Whether SigV4 works on the `/anthropic` route is **[unverified]** (the SigV4 example uses `/model/{id}/invoke`). Mantle: API key (`x-api-key`) or SigV4 | `/anthropic` route with `stream:true`: Anthropic SSE events **[SSE format inferred]**. InvokeModelWithResponseStream: AWS eventstream, each chunk's `bytes` is an Anthropic event JSON |
| **Converse / ConverseStream** | `POST /model/{modelId}/converse`, `/converse-stream` | ✘ | SigV4 or Bedrock API key (`Authorization: Bearer`) | AWS eventstream (`application/vnd.amazon.eventstream`) **[common knowledge, not re-checked this session]** |
| **Chat Completions** | `POST /openai/v1/chat/completions` | `POST /v1/chat/completions` **or** `/openai/v1/...` (varies by model; OpenAI GPT uses `/openai/v1`). A wrong prefix is rejected with "isn't supported on this route" | SigV4 or Bedrock API key (`Authorization: Bearer`) | SSE `data:` chunks (OpenAI format) |
| **Responses** | `POST /openai/v1/responses`; `GET`/`DELETE /openai/v1/responses/{id}`; `POST …/{id}/cancel` | `POST /v1/responses` (OpenAI GPT: `/openai/v1`) | Same as above. Runtime IAM needs `bedrock:InvokeModel` on both the inference target **and the default project**. Mantle needs `bedrock-mantle:CreateInference` | SSE typed events (`response.output_text.delta`, etc.) |
| **InvokeModel (native)** | `POST /model/{id}/invoke`, `/invoke-with-response-stream` | ✘ | SigV4 or API key | AWS eventstream |

Other endpoint differences:
- **Cross-region inference: runtime only** (mantle ✘).
- Guardrails: runtime only.
- Server-side tools, `background=true`, custom Projects, Workspaces: mantle only.
- Prompt caching works on both endpoints, but **mantle support depends on the model**. For example, Kimi K3 is not on mantle at all.
- Per-token prices are identical on runtime and mantle (excluding the CRIS / in-Region differences).

### 2.2 Model family × API (✔ = supported; R = runtime only; M = mantle only)
Sources: `models-api-compatibility.html` (combined across endpoints) plus the per-model cards. Cache column: E = explicit, I = implicit.

| Model family | Messages | Converse | Chat Completions | Responses | InvokeModel | Caching / usage notes |
|---|---|---|---|---|---|---|
| Claude 5.x (Opus/Sonnet/Haiku 5.5, Opus 5, Sonnet 5, Fable 5.x) + Opus 4.7 / 4.8 / Haiku 4.5 | ✔ (R+M) | ✔ (R) | ✘ | ✘ | ✔ (R) | E (`cachePoint` / `cache_control`, 4 points, 5m/1h). Converse usage: `cacheRead/WriteInputTokens`; Messages: `cache_read/creation_input_tokens`. **Mantle has no implicit caching** |
| Claude Opus 4.5 / 4.6, Sonnet 4.5 / 4.6, Sonnet 4, Opus 4.1 | **✘** (per the compatibility page) | ✔ | ✘ | ✘ | ✔ | E |
| Nova (Pro / Lite / Micro / Nova 2 Lite) | ✘ | ✔ | ✘ | ✘ | ✔ | I + E (5m, ≤20K cached, free writes; implicit hits not reported in usage) |
| GPT-6.x / GPT-5.6 | ✘ | ✔ (R, implicit only) | ✔ | ✔ | 6.x ✔ (Astra **[conflict]**); 5.6 ✘ | I + E (Resp / Chat / Invoke). Runtime needs `us.` / `global.` |
| GPT-5.5 / 5.4 | ✘ | per card ✔ **[conflict: compatibility page ✘]** | ✔ | ✔ | ✘ | I (Responses only, no write fee) |
| gpt-oss-120b / 20b, Safeguard | ✘ | ✔ (R) | ✔ (R: `openai.gpt-oss-120b-1:0`; M: `openai.gpt-oss-120b`) | **M only** | ✔ (R) | None (no cache feature in docs or price list) |
| Kimi K3 | ✘ | ✔ (implicit only; strip earlier reasoning) | ✔ | ✔ | ✔ | I + E (Resp / Chat / Invoke, 256 min, ≥30m). Runtime only |
| Kimi K2.5 / K2 Thinking | ✘ | ✔ | ✔ (K2 Thinking **[conflict]**) | ✘ | ✔ | None. In-Region only |
| DeepSeek V3.2 / V3.1 | ✘ | ✔ | ✔ | ✘ | ✔ | None |
| DeepSeek-R1 | ✘ | ✔ | ✘ | ✘ | ✔ | None |
| Qwen3 (235B, 32B, Coder 480B, Coder Next, Next 80B, VL) | ✘ | ✔ | ✔ | ✘ | ✔ | None |
| MiniMax M2 / M2.1 / M2.5 | ✘ | ✔ | ✔ | ✘ | ✔ | **[unverified]** |
| Z.AI GLM 4.7 / 5 | ✘ | ✔ | ✔ | ✘ | ✔ | **[unverified]** |
| GLM 5.3 | ✘ | ✔ | ✔ | ✔ | ✔ | **[unverified]** |
| xAI Grok 4.6 / 4.7 | ✘ | ✔ | ✔ | ✔ | ✔ | **[unverified]**; reasoning is encrypted (Responses `include`) |
| Grok 4.3 | ✘ | ✘ | ✔ | ✔ | ✘ | **[unverified]** |
| Gemma 4 (31B / 26B-A4B / E2B) | ✘ | ✘ | ✔ | ✔ | ✘ | **[unverified]** |
| Mistral (Large 3, Devstral 2, Ministral, etc.) | ✘ | ✔ | Some ✔ | ✘ | ✔ | **[unverified]** |
| Llama 3.x / 4 | ✘ | ✔ | ✘ | ✘ | ✔ | None |

Note: I fully checked caching only for Claude / Nova / GPT / Kimi / DeepSeek V3.2 / Qwen3 Coder Next / gpt-oss-120b. For the other families, caching is unverified, not confirmed absent. The A-stage Price List scan found only Kimi K3 and Nova 2 Lite with cache SKUs among non-Claude models (GPT-6 Astra cache SKUs also appear in the `AmazonBedrockFoundationModels` service).

### 2.3 Specific checks the router asked for
- **Claude via Chat Completions / Responses:** ✘ (runtime and mantle). Use only Messages / Converse / Invoke.
- **GPT / Kimi via Messages:** ✘.
- **Statefulness of Bedrock Responses:**
  - `store` defaults to true, retained 30 days, chained with `previous_response_id`.
  - `store=false` is not retained and `previous_response_id` can't be used. An account-level data retention mode of `none` rejects `store=true` outright.
  - Stored responses are scoped to a Project; runtime has only the default project.
  - **Runtime: the response is stored in the Region that actually processed it (under a global profile, possibly any commercial Region), and the continuation is handled by that Region.** Whether Bedrock forwards the continuation there automatically, or a mismatched Region returns 404, is not stated **[unverified, needs an experiment]**. The docs say a "not found" response ID returns 404 in every case.
  - Runtime: `model` is required on every request, so the model can't be inherited.
  - **Whether a continuation can switch to a different model** (for example GPT-6.1 Sol → GPT-6 Luna with the same `previous_response_id`) is **[unverified]**. Even if it's allowed, reasoning doesn't cross families, and a different model is always a cold cache.
- **Pass-through and inference profiles:** the router only changes the `model` field.
  - Claude / GPT / Kimi K3 must use a `global.` / `us.` profile ID on runtime. Mantle has no CRIS.
  - Kimi K2.x and most open-weight models (DeepSeek / Qwen / gpt-oss) are in-Region only.
  - Model ID prefixes are inconsistent: Kimi K2 Thinking is `moonshot.` on runtime vs `moonshotai.` on mantle; gpt-oss runtime IDs have the `-1:0` suffix and mantle IDs don't.
  - The router needs a mapping table of (API, endpoint) → model ID.

---

## 3. One-time switching cost (Bedrock global prices; context C; each step adds 2K new input and produces 1K output)

Model (`/tmp/llm-router-research/scripts/a2_switch_cost.py`):
- Warm step = C·read + 2K·write + 1K·output.
- First step after a switch (cold) = (C+2K)·write + 1K·output.
- One-time extra = cold_B − warm_A.
- Recovery steps = extra / (warm_A − warm_B).
- **Haiku 5.5 is billed at the >100K tier when C=150K.** Kimi K2.5 has no cache, so every step is billed at full input.

| C | From → to | Stay warm on A $/step | First step on B $ | One-time extra $ | Warm on B $/step | Steps to recover |
|---|---|---|---|---|---|---|
| 50K | GPT-6 Astra → GPT-6.1 Sol | 0.1250 | 0.1400 | +0.015 | 0.0200 | 0.1 |
| 50K | GPT-6.1 Sol → GPT-6 Astra | 0.0200 | 0.7000 | **+0.680** | 0.1250 | Never (quality decision) |
| 50K | GPT-6.1 Sol → 6.1 Terra | 0.0200 | 0.0700 | +0.050 | 0.0100 | 5 |
| 50K | GPT-6.1 Terra → 6.1 Sol | 0.0100 | 0.1400 | +0.130 | 0.0200 | Never |
| 50K | GPT-6.1 Sol → GPT-6 Luna | 0.0200 | 0.0070 | −0.013 | 0.0013 | Cheaper immediately |
| 50K | GPT-6 Luna → 6.1 Sol | 0.0013 | 0.1400 | +0.139 | 0.0200 | Never |
| 50K | GPT-5.6 Sol → 5.6 Terra | 0.0500 | 0.1420 | +0.092 | 0.0270 | 4 |
| 50K | GPT-5.6 Terra → 5.6 Sol | 0.0270 | 0.2800 | +0.253 | 0.0500 | Never |
| 50K | GPT-5.6 Sol → 5.6 Luna | 0.0500 | 0.0142 | −0.036 | 0.0027 | Cheaper immediately |
| 50K | Kimi K3 → Sonnet 5.5 | 0.0375 | 0.1400 | +0.103 | 0.0200 | 5.9 |
| 50K | Sonnet 5.5 → Kimi K3 | 0.0200 | 0.2100 | +0.190 | 0.0375 | Never |
| 50K | Kimi K3 → Haiku 5.5 | 0.0375 | 0.0070 | −0.031 | 0.0013 | Cheaper immediately |
| 50K | Haiku 5.5 → Kimi K3 | 0.0013 | 0.2100 | +0.209 | 0.0375 | Never |
| 50K | Opus 5.5 → Kimi K3 | 0.0400 | 0.2100 | +0.170 | 0.0375 | **68** |
| 50K | Sonnet 5.5 → Kimi K2.5 (no cache) | 0.0200 | 0.0342 | +0.014 | 0.0342 | Never (more expensive per warm step) |
| 50K | (reference) Opus 5.5 → Sonnet 5.5 | 0.0400 | 0.1400 | +0.100 | 0.0200 | 5 |
| 150K | GPT-6 Astra → GPT-6.1 Sol | 0.2250 | 0.3900 | +0.165 | 0.0300 | 0.8 |
| 150K | GPT-6.1 Sol → GPT-6 Astra | 0.0300 | 1.9500 | **+1.920** | 0.2250 | Never |
| 150K | GPT-6.1 Sol → 6.1 Terra | 0.0300 | 0.1950 | +0.165 | 0.0150 | 11 |
| 150K | GPT-6.1 Terra → 6.1 Sol | 0.0150 | 0.3900 | +0.375 | 0.0300 | Never |
| 150K | GPT-6.1 Sol → GPT-6 Luna | 0.0300 | 0.0195 | −0.011 | 0.0022 | Cheaper immediately |
| 150K | GPT-6 Luna → 6.1 Sol | 0.0022 | 0.3900 | +0.388 | 0.0300 | Never |
| 150K | GPT-5.6 Sol → 5.6 Terra | 0.0900 | 0.3920 | +0.302 | 0.0470 | 7 |
| 150K | GPT-5.6 Terra → 5.6 Sol | 0.0470 | 0.7800 | +0.733 | 0.0900 | Never |
| 150K | GPT-5.6 Sol → 5.6 Luna | 0.0900 | 0.0392 | −0.051 | 0.0047 | Cheaper immediately |
| 150K | Kimi K3 → Sonnet 5.5 | 0.0675 | 0.3900 | +0.323 | 0.0300 | 8.6 |
| 150K | Sonnet 5.5 → Kimi K3 | 0.0300 | 0.5850 | +0.555 | 0.0675 | Never |
| 150K | Kimi K3 → Haiku 5.5 (>100K tier) | 0.0675 | 0.0975 | +0.030 | 0.0112 | 0.5 |
| 150K | Haiku 5.5 → Kimi K3 | 0.0112 | 0.5850 | +0.574 | 0.0675 | Never |
| 150K | Opus 5.5 → Kimi K3 | 0.0600 | 0.5850 | +0.525 | 0.0675 | **Never (K3 is more expensive per warm step)** |
| 150K | Kimi K3 → Opus 5.5 | 0.0675 | 0.7800 | +0.713 | 0.0600 | 95 |
| 150K | Sonnet 5.5 → Kimi K2.5 (no cache) | 0.0300 | 0.0942 | +0.064 | 0.0942 | Never |
| 150K | (reference) Sonnet 5.5 → Haiku 5.5 (>100K) | 0.0300 | 0.0975 | +0.068 | 0.0112 | 3.6 |

Takeaways:
- **Cold-write premium ≈ C × (write_B − read_B).** At 150K: GPT-6 Astra ≈ $1.73, Opus 5.5 ≈ $0.72, Kimi K3 ≈ $0.52, Sonnet 5.5 / GPT-6.1 Sol ≈ $0.36, GPT-6.1 Terra ≈ $0.18, Haiku 5.5 (>100K) ≈ $0.09, GPT-6 Luna ≈ $0.02.
- **Downgrading to the Luna / Haiku tier is cheaper from the first step** because their write price is far below the expensive model's warm step. This is the most practical cost-saving direction.
- **A same-family step down one tier (Sol → Terra, Opus → Sonnet) takes 4–11 steps to recover.** If a task phase has fewer than about 10 remaining steps, don't switch.
- **Kimi K3 doesn't save money with long cached contexts.** It is more expensive than Sonnet 5.5 and GPT-6.1 Sol per warm step, and more expensive than Opus 5.5 at 150K. Its value is quality and diversity, not cost.
- **Kimi K2.5 and other no-cache open-weight models cost more than Sonnet 5.5 at 50K context and above**, because they pay full input every step.
- Under pass-through, "Claude ↔ Kimi/GPT" switching only happens inside Converse. There GPT / K3 only get implicit caching, and whether implicit-cache billing is reflected in Converse usage is **[unverified]**, so the real cost may be higher than this table.

---

## 4. Sources
- APIs supported: https://docs.aws.amazon.com/bedrock/latest/userguide/apis.html
- Endpoints (runtime vs mantle comparison, Responses behavior differences): https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html
- API compatibility matrix: https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html
- Messages API: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html
- Responses API (statefulness, store / previous_response_id, runtime differences): https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html
- Chat Completions: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html
- Prompt caching: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- Model cards: https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards-openai.html and `model-card-openai-gpt-6-astra.html`, `-gpt-6-1-sol`, `-gpt-6-1-terra`, `-gpt-6-sol`, `-gpt-6-luna`, `-gpt-56-sol/terra/luna`, `-gpt-55`, `-gpt-54`, `model-card-moonshot-ai-kimi-k3.html`, `-kimi-k2-5`, `-kimi-k2-thinking`, `model-card-anthropic-claude-opus-5-5.html`, `model-card-openai-gpt-oss-120b.html`
- Converse reasoning: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningContentBlockDelta.html
- Blogs: https://aws.amazon.com/blogs/machine-learning/introducing-explicit-prompt-caching-for-openai-gpt-5-6-models-on-amazon-bedrock/ ; https://aws.amazon.com/blogs/machine-learning/introducing-grok-on-amazon-bedrock/ ; https://aws.amazon.com/blogs/machine-learning/xais-grok-4-6-is-now-available-in-amazon-bedrock/
- Prices: AWS Price List API `pricing:GetProducts` (`AmazonBedrockFoundationModels`: GPT-6 Astra and Claude; `AmazonBedrock`: Kimi). Other GPT prices come from the model-card pricing tables. 2026-11-04.

### Open items to verify (recommend experiments)
1. Runtime Responses: under a global profile, does a continuation with `previous_response_id` reach the Region that stored it automatically? Can `model` change between turns?
2. GPT / Kimi K3 on Converse: is implicit caching reported in `cacheReadInputTokens` and billed at the cache-read price?
3. Bedrock Chat Completions: exact usage field names and the `reasoning_content` round-trip behavior for GPT / Kimi.
4. Compatibility page vs model card conflicts: GPT-6 Astra Invoke, GPT-5.5 / 5.4 Converse, Kimi K2 Thinking Chat, Claude 4.5 / 4.6 Messages.
5. Whether SigV4 is accepted on the `/anthropic/v1/messages` route, and its stream format.
6. Global price for GPT-5.5 / 5.4 (the cards only show in-Region / mantle prices).
