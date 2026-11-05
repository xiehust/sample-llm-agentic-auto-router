# A. Prompt caching facts by LLM provider (for router design)

> Compiled 2026-11-04. Sources are official docs and the AWS Price List API, fetched the same day. Anything not confirmed in official docs is marked **[unverified]**.
> Prices are USD per 1M tokens unless noted otherwise.

---

## 1. Provider comparison

| Provider / model family | Mechanism | Min cacheable tokens | Breakpoints | TTL | Write premium | Read price (× base input) | Cache scope | Affinity controls | Invalidated by | Usage fields |
|---|---|---|---|---|---|---|---|---|---|---|
| **Bedrock · Claude** (Converse `cachePoint` / InvokeModel `cache_control`) | Explicit. No cache unless you add a cache control. Also supports **automatic caching**: one top-level `cache_control` (Converse puts it in `additionalModelRequestFields`). | 512 (Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Opus 5 / Fable 5.x). 1,024 (Opus 4.8 / Sonnet 5 / Sonnet 4.6). 4,096 (Opus 4.5–4.7 / Haiku 4.5). Counted cumulatively over tools+system+messages. | 4 (automatic caching takes 1 of them). About 20-block lookback. | 5m (default) / 1h (`"ttl":"1h"`). Every hit resets the TTL. A 1h entry must come before any 5m entry. | 5m = 1.25×, 1h = 2× | 0.1× normally. **Opus 5.5 / Sonnet 5.5 = 0.05×**, Fable 5.1 = 0.025× | **Stored on the server that handled the request.** Organization (account) level. A different server or Region writes a new entry. | None. No affinity key on Bedrock Claude **[unverified: no key-like parameter found in the docs]** | Order is tools→system→messages. Changing an earlier layer invalidates every later layer. Same invalidation table as the Anthropic API (see next row). | Converse: `usage.cacheReadInputTokens` / `cacheWriteInputTokens` / `cacheDetails` (write tokens by TTL). `inputTokens` covers only uncached tokens. Total = sum of all three. |
| **Bedrock · Nova** (Pro / Lite / Micro / Nova 2 Lite) | Implicit (automatic, all text prompts) plus explicit `cachePoint`. | 1K. Max **20K** tokens can be cached. | 4 | 5m only. Passing `ttl` can cause a ValidationException. | **$0** (cache write is free) | 0.25× (Pro 0.20/0.80, Lite 0.015/0.06) | Same as above | None | Same prefix rules. Checkpoints allowed in system and messages only, **not tools**. | Same as above. **Implicit hits are not reported in usage and not billed at the cache price** (latency benefit only). |
| **Bedrock · OpenAI GPT-5.6+ / GPT-6.x** | Implicit by default plus explicit `prompt_cache_breakpoint`. `prompt_cache_options.mode = implicit \| explicit`. | 1,024 | Up to 4 cache writes per request | **30m minimum** (`ttl:"30m"`, the only allowed value) | 1.25× | Model-specific | Same as above | `prompt_cache_key` is accepted (seen in the Responses example) | Exact prefix match. **Converse does not support explicit caching for these models.** Use Responses / Chat Completions / InvokeModel. | `input_tokens_details.cached_tokens` / `cache_write_tokens` |
| **Bedrock · GPT-5.5 and earlier** | Implicit only | 1,024 | — | Not stated | None | Discounted | Same as above | — | Prefix | `cached_tokens` |
| **Bedrock · Kimi K3** | Implicit by default plus explicit (Responses / Chat / Invoke only, **not Converse**) | 256 | — | At least 30m | 1.25× (global: write 3.75 vs input 3.00) | 0.1× (0.30) | Same as above | — | Prefix | **[unverified]** probably the OpenAI-style fields |
| **Bedrock · DeepSeek V3.2 / Qwen3 (Coder Next, etc.) / gpt-oss-120b** | **Model cards list no prompt caching**, and the price list has no cache SKUs for them | — | — | — | — | No discount | — | — | — | — |
| **Anthropic API (1P)** | Explicit block-level `cache_control` plus **automatic caching** (top-level `cache_control`, breakpoint moves forward automatically). Managed Agents: always on. | 512 / 1,024 / 2,048 / 4,096, depending on model (see §1.1) | 4. Writes happen only at breakpoints. Reads look back ≤20 blocks (consecutive tool_use or tool_result blocks count as one). | 5m / 1h. Timed from the **start** of the request, so streaming time counts against it. | 5m 1.25×, 1h 2× | 0.1×. Opus 5.5 / Sonnet 5.5 0.05×. Fable/Mythos 5.1 0.025× | Organization **plus workspace** isolation. Never shared across organizations. | None. Only "identical prefix" | See §1.2 | `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens` (after the last breakpoint only), `cache_creation.ephemeral_5m/1h_input_tokens` |
| **OpenAI API · GPT-5.6+** | Implicit by default (breakpoint at the end of the newest message) plus explicit breakpoints (≤4 writes). `prewarm:true` warms the cache. | 1,024 visible tokens | 4 writes. Reads check the first 2 and latest 50 explicit breakpoints, plus up to 20 earlier message ends. | `"30m"` (default) / `"12h"` | 30m 1.25×, 12h 2.5× | 0.1×. GPT-6.1 Sol/Terra 0.05× | Organization plus **processing region**. Lives on individual machines. | OpenAI routes automatically. `prompt_cache_key` is optional and mainly for per-tenant cache accounting and preventing cache probing. | `model`, `tools`, `parallel_tool_calls`, `text.format`, `reasoning.effort`, `text.verbosity`, `context_management` (compaction). GPT-6+ can change effort and schema without breaking the prefix via `configuration_update` items. | `input_tokens_details.cached_tokens` / `cache_write_tokens` / `cache_write_tokens_details.ttl_30m_tokens/ttl_12h_tokens` |
| **OpenAI API · before GPT-5.6** | Implicit automatic prefix cache. Implicit breakpoints every 2,048 tokens on GPT-5.5; model-dependent on others. | Varies with request settings. 1,024 was the usual value **[old figure, now model-dependent]** | — | `prompt_cache_retention`: `in_memory` (5–10 min idle, max 1h) / `24h` (usually ~30 min, max 24h). Non-ZDR orgs default to 24h. GPT-5.5 supports 24h only. | **None** | Model-specific cached-input price | Organization plus processing region | **`prompt_cache_key` plus a hash of the leading tokens decides machine routing.** About **15 RPM per prefix+key**; above that, requests overflow to machines without the cache. Spread high volume across several keys with a deterministic mapping. | Same as above | `cached_tokens` (rounded down to a multiple of 128) |
| **Google Gemini API** | **Implicit** (on by default for 2.5+ models) plus **explicit CachedContent** (generateContent only, Gemini 3 / 2.5 only. **Gemini 4 Argon and the Interactions API: implicit only**) | Gemini 4 Argon / 3.8 Flash / 3.6 Flash / 3.1 Pro: 4,096. 2.5 Pro/Flash: 2,048. | Explicit: one cache object per request (via `cachedContent`) | Implicit: unspecified. Explicit: `ttl` / `expireTime`; only expiry can be updated. Default TTL and limits **[unverified]**. Older docs said default 1h. | Implicit: none. Explicit: **storage fee** per 1M tokens per hour (3.8 Flash $0.50→$1.00 from 2027-01; 3.1 Pro $4.50) | About 0.1× (3.8 Flash 0.075/0.75; Argon 0.10/2.00) | Explicit cache is **bound to the model it was created for**, and model/contents/tools/system are immutable | None | Prefix. **Gemini 4 multi-turn: if the new request adds <2,050 tokens, the last 2,050 tokens of the previous request are reprocessed at full price.** | `usage.total_cached_tokens` (SDK); explicit uses `usageMetadata` **[field name differs by SDK version]** |
| **DeepSeek API** | Implicit disk KV cache, on by default | Not stated (old "64-token unit" is **[unverified]**) | — | Unused entries are cleared automatically, usually within hours to days | **None** (miss is billed at normal input price) | About 0.02× (Flash 0.003 / 0.15 off-peak; Pro 0.022 / 0.66) | **[unverified]** probably per user | None | Only a full match on a "cache prefix unit" counts. Prefixes are persisted at request ends, on detected common prefixes, and at fixed intervals. Building takes seconds. | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| **Alibaba Model Studio (Qwen)** | Implicit (cannot be disabled) **or** explicit `cache_control` (mutually exclusive) | 1,024 (512 for GLM) | Explicit: 4, 20-block lookback | Explicit 5m (hit resets). Implicit: not fixed. | Explicit 1.25×. Implicit: no premium. | Explicit 0.1×. Implicit usually 0.2× | **Account + model** isolation | None | Breakpoints on tools are ignored. Tools are cached as part of system. | `prompt_tokens_details.cached_tokens` / `cache_creation_input_tokens` |
| **Kimi / GLM official APIs** | **[unverified]** (no caching docs found) | | | | | | | | | |

### 1.1 Anthropic per-model minimum cacheable length (1P docs; Bedrock publishes its own table, which mostly matches)
- **512**: Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Fable 5, Mythos 5, Haiku 5.5
- **1,024**: Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4
- **2,048**: Mythos Preview, Opus 4.7 (**Bedrock lists Opus 4.7 at 4,096**), Haiku 3.5
- **4,096**: Opus 4.6, Opus 4.5, Haiku 4.5

### 1.2 What invalidates the Anthropic / Bedrock-Claude cache (✘ = that layer is invalidated)
| Change | tools | system | messages |
|---|---|---|---|
| Tool definitions (name, description, parameters) | ✘ | ✘ | ✘ |
| Web search / citations / speed (fast) toggle | ✓ | ✘ | ✘ |
| `tool_choice` | ✓ | ✓ | ✘ |
| Adding or removing images | ✓ | ✓ | ✘ |
| Thinking parameters (mode, budget_tokens), `output_config.effort` | model-dependent | model-dependent | ✘ |
| Non-tool-result user content (thinking enabled) | ✓ | ✓ | model-dependent |
| Dropped thinking blocks (Claude 5.1+) | ✓ | ✓ | ✘ |

- Opus 4.5+, Sonnet 4.6+, and Haiku 5.5 **keep earlier thinking blocks by default**, so new user turns don't break the cache. Older models strip them, which invalidates the cache from that point.
- To add system instructions mid-conversation, append a `{"role":"system"}` message to `messages` instead of editing the top-level `system` (supported on Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Opus 5 / Opus 4.8 and others; not on Sonnet 5).
- The `inline-tools-2026-09-15` beta lets you add tools mid-conversation with a `tool_addition` block in a system message, without editing `tools`. This avoids invalidating the whole cache. **[1P beta; Bedrock support unverified]**
- Unstable key order in `tool_use` JSON also causes misses.

---

## 2. Current prices: Bedrock, us-east-1, Standard tier, on-demand
Source: AWS Price List API (`AmazonBedrockFoundationModels` / `AmazonBedrock`), queried 2026-11-04. USD per 1M tokens.

| Model | Endpoint | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|---|---|---|---|---|---|---|
| Claude Opus 5.5 | Global (`global.`) | 4.00 | 20.00 | 5.00 | 8.00 | 0.20 |
| Claude Opus 5.5 | Regional/Geo (`us.` / in-region) | 4.40 | 22.00 | 5.50 | 8.80 | 0.22 |
| Claude Sonnet 5.5 | Global | 2.00 | 10.00 | 2.50 | 4.00 | 0.10 |
| Claude Sonnet 5.5 | Regional/Geo | 2.20 | 11.00 | 2.75 | 4.40 | 0.11 |
| Claude Haiku 5.5 (≤100K prompt) | Global | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| Claude Haiku 5.5 (≤100K) | Regional/Geo | 0.11 | 0.55 | 0.1375 | 0.22 | 0.011 |
| Claude Haiku 5.5 (>100K prompt) | Global | 0.50 | 2.50 | 0.625 | 1.00 | 0.05 |
| Claude Haiku 5.5 (>100K) | Regional/Geo | 0.55 | 2.75 | 0.6875 | 1.10 | 0.055 |
| Nova Pro | In-region | 0.80 | 3.20 | 0.00 | n/a | 0.20 |
| Nova Lite | In-region | 0.06 | 0.24 | 0.00 | n/a | 0.015 |
| Nova 2 Lite | In-region | 0.33 | 2.75 | 0.00 | n/a | 0.0825 |
| Nova 2 Lite | Global | 0.30 | 2.50 | 0.00 | n/a | 0.075 |
| (reference) Kimi K3 | Global / US | 3.00 / 3.30 | 15.00 / 16.50 | 3.75 / 4.125 (30m) | n/a | 0.30 / 0.33 |

Notes:
- The "Regional/Geo" price is the `*_standard` usagetype in the price list, a 10% premium over global. Anthropic's pricing page says the same: "Regional and multi-region endpoints include a 10 percent premium over global endpoints". The Price List doesn't separate geo from in-region, so **treating them as the same price is my inference**.
- The Bedrock pricing page says Sonnet 5.5's cache-read price dropped 50% starting 2026-10-07. The 0.10 above already includes that drop.
- Bedrock Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5 prices match the Anthropic 1P prices exactly.
- Haiku 5.5 is billed in tiers above a 100K-token prompt, which matters a lot for long agent contexts: going over 100K multiplies every price by 5.
- Claude 4.7+ uses a new tokenizer that produces about 30% more tokens for the same text. Compare models on effective price per character, not per token.

---

## 3. What this means for router design

1. **Cache is bound to the exact model × prefix × server.** No official doc says caches are shared across models or versions. Gemini says outright that explicit caches can only be used with the model they were created for. Alibaba isolates by model. OpenAI lists `model` as a prefix-changing setting. Bedrock caches live on the server that handled the request. **Conclusion: every model switch, including between versions in the same family (Sonnet 5 → 5.5), means one full cold write.** (Anthropic has no sentence saying "caches are not shared across models", but cache keys are prefix hashes and KV tensors are model-specific, so the risk of being wrong is essentially zero.)
2. **Switching cost formula.** On a switch, extra cost ≈ `context_len × (write_mult_new × in_price_new − read_mult_old × in_price_old)`. Example: a 200K context moving from Opus 5.5 (read 0.20) to Sonnet 5.5 costs one write of 200K × $2.50/M = $0.50, versus staying on Opus at 200K × $0.20/M = $0.04. You need to save more than about $0.46 in output cost before the switch pays off. Moving down to Haiku 5.5 crosses the 100K long-context tier, so the write is 200K × $0.625/M = $0.125, but quality risk is higher. **The router should estimate break-even before switching models, with a hard rule like "only switch while context is under N tokens or at a natural break (after compaction or summarization)".**
3. **Prefer session-level stickiness (model, profile, region).** Decide the model once per session or task phase, not per turn. If you must switch per turn, use **sub-agents with short contexts** (a cheap model on a fresh, short prompt) instead of switching the main thread.
4. **Cross-region / global inference profiles lower hit rates.** The Bedrock docs say requests "served by a different server, such as one in another Region … write a new entry" and that CRIS "may lead to increased cache writes" under high demand. Global is 10% cheaper, but caches are scattered across Regions. The router should:
   - Always use the **same inference profile ID** for one session; don't alternate between `global.` and `us.`.
   - Track hit rate on `cacheReadInputTokens / (cacheRead + cacheWrite + inputTokens)`. Bedrock gives no region-affinity control, so if hit rates drop under load, consider pinning the session to an in-region or geo profile (paying the 10%) **[benefit unverified; needs a load test]**.
5. **Concurrency and fan-out: warm the cache before fanning out.** Anthropic: a cache entry only becomes available after the first response starts. Bedrock: requests "sent before an identical request has started its response, write a new entry". Neither returns an error for concurrent writes; each one is simply billed as a write. **For parallel tool calls or parallel sub-agents, send one request first (or `max_tokens:0` / OpenAI `prewarm:true`), wait for the first token, then fan out.**
6. **TTL policy.** Agent turns usually come within 5 minutes, so 5m (refreshed free on each hit) is enough. Human-in-the-loop waits and long tool runs (>5 min) need the 1h TTL (2× write). Anthropic TTL is timed from the start of the request, so long outputs eat into the window. The OpenAI 5.6+ and Bedrock GPT / Kimi K3 minimum of 30m is friendly to agents.
7. **Prompt layout must stay stable for the router.** Don't change tool definitions or `tool_choice` per request. Don't toggle thinking or effort per request (both invalidate the cache on Claude). If the router wants to change effort dynamically, OpenAI GPT-6+ `configuration_update` keeps the prefix; on Claude it costs at least the messages layer (some models also invalidate tools and system). Use the system-message and `tool_addition` mechanisms for incremental changes.
8. **Bedrock Intelligent Prompt Routing doesn't fit this scenario.** It only supports Nova Lite/Pro and Llama 3.x (pick two models from the same family). It is optimized for English only and decides per request. The DeepSeek, Qwen, gpt-oss, and Kimi K3 model cards all list it as "Not supported". **Its interaction with prompt caching is not documented [unverified]**, but since it picks a model per request, it inherently switches models between turns, which conflicts with caching.
9. **Normalize usage across providers.** Field semantics differ:
   - Bedrock Converse `inputTokens` and Anthropic `input_tokens` exclude cached tokens (total = sum of all three).
   - OpenAI and Bedrock Responses `input_tokens` **include** cached and write tokens.
   - Alibaba's OpenAI-compatible mode puts cached tokens inside `prompt_tokens`.
   - Bedrock Nova implicit hits are not reported at all.
   The router needs a unified usage adapter (`uncached / cache_read / cache_write{ttl}`) to compute real cost.
10. **Open-weight models on Bedrock (DeepSeek V3.2 / Qwen3 / gpt-oss) have no cache discount.** Long-context agents on them pay full input price every turn, so their "cheap" advantage disappears at large context. For example, a 200K-token context run 50 turns costs 10M input tokens. Kimi K3 is the exception (cache read 0.1×). DeepSeek's own API has a very cheap cache hit price (about 2% of input), but it's a different provider with different compliance.
11. **Cached tokens and rate limits.** Bedrock Claude, GPT, and Anthropic 1P: cache hits don't count against rate limits / ITPM. OpenAI 1P: cached tokens **still count** against TPM. A high hit rate effectively raises Bedrock throughput.
12. **The minimum-length threshold rarely binds for agents** (contexts of tens of thousands of tokens are far above 512–4,096). The real problems are lookback windows (Anthropic 20 blocks; when a conversation grows past 20 blocks per turn, move the breakpoint or use automatic caching) and Nova's 20K cache cap (Nova is not suitable as a long-context agent main model).

---

## 4. Sources
- Bedrock prompt caching: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- Bedrock cross-Region inference: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
- Bedrock Intelligent Prompt Routing: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html
- Bedrock model cards: https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html , …/model-card-deepseek-deepseek-v3-2.html , …/model-card-moonshot-ai-kimi-k3.html , …/model-card-openai-gpt-oss-120b.html , …/model-card-qwen-qwen3-coder-next.html
- Bedrock pricing: https://aws.amazon.com/bedrock/pricing/ (page tables didn't fully render; numbers come from the AWS Price List API `pricing:GetProducts`, ServiceCode `AmazonBedrockFoundationModels` / `AmazonBedrock`, regionCode `us-east-1`, 2026-11-04)
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI conversation state: https://developers.openai.com/api/docs/guides/conversation-state
- OpenAI reasoning: https://developers.openai.com/api/docs/guides/reasoning
- Gemini caching: https://aistudio.google.com/docs/caching ; API reference: https://aistudio.google.com/api-reference/caching ; pricing: https://aistudio.google.com/docs/pricing
- DeepSeek KV cache: https://api-docs.deepseek.com/guides/kv_cache ; pricing: https://api-docs.deepseek.com/quick_start/pricing
- Alibaba Model Studio context cache: https://www.alibabacloud.com/help/en/model-studio/context-cache

### Unverified / gaps
- OpenAI `previous_response_id` and caching: the docs only say that **earlier input in the chain is still billed as input tokens**. Nothing says previous_response_id improves hit rates. Presumably it just renders the same prefix server-side, so the normal prefix cache applies **[unverified]**.
- OpenAI reasoning items: GPT-5.6 / GPT-6.1 Sol default to `reasoning.context: all_turns`, which renders earlier-turn reasoning. Reasoning doesn't carry over between model families (it's dropped when switching families, which changes the prefix again). The docs don't say directly how reasoning items affect caching **[unverified]**. Recommendation: always pass back the full `output` (including encrypted reasoning) so the prefix stays stable.
- Default TTL and min/max for Gemini explicit cache; whether Gemini implicit hits get the same price as explicit **[unverified]**.
- Whether Bedrock Claude supports anything like OpenAI `prompt_cache_key` affinity: none found **[unverified]**.
- Whether Bedrock geo and in-region prices are the same (the price list has only one `standard` SKU): **[inferred]**.
- Kimi / GLM official API caching; the DeepSeek prefix unit size and isolation scope **[unverified]**.
- Price list pagination: the full OSS cache-SKU scan in us-east-1/us-west-2 found only Nova 2 Lite and Kimi K3, but one page hit the 1,000-item cap, so the scan is **probably but not certainly** complete. The model cards are the primary evidence.
