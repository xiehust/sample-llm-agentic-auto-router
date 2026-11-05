# Gateway / Router Products — cache- and session-awareness survey

Research date: 2026-11-04. Sources are official docs/blogs fetched on that date (WebFetch only; no WebSearch was available, so discovery went through known doc URLs, sitemaps, and llms.txt). Quotes are verbatim from the page unless marked "paraphrase". Anything not confirmed in a primary source is marked **unverified**.

Legend for "cache awareness":
- **none**: routing ignores prompt-cache state.
- **sticky**: keeps a session/conversation on the same model or deployment (a proxy for cache warmth), but does not price the cache.
- **cost-modeled**: puts an explicit cache or switch cost into the stay/switch decision.

---

## 1. OpenRouter

Sources: https://openrouter.ai/docs/features/provider-routing · https://openrouter.ai/docs/features/prompt-caching · https://openrouter.ai/docs/guides/routing/routers/auto-router · https://openrouter.ai/docs/features/model-routing · https://openrouter.ai/docs/guides/routing/model-fallbacks

### 1a. Auto Router (`openrouter/auto`, plus `openrouter/auto-beta`)
- **Decision granularity:** per request (per turn), with best-effort session stickiness to the model chosen earlier.
- **Signals:**
  - A classifier: "A fast, lightweight classifier assigns each prompt one of ~30 fine-grained task types" (e.g. `code:debugging`, `math`, `qa_knowledge`).
  - Ranking from market data: "powered by the market: the aggregate spend of millions of people using OpenRouter, measured over a trailing 7-day window for each task type."
  - `cost_tier` band (`low|medium|high|xhigh|max`). "A tier is a band, not a ceiling, so models cheaper than the band are excluded as well as models above it."
  - Constraints: `allowed_models` / `excluded_models` wildcards, ZDR and guardrails, and `provider.max_price`. It also "considers factors like task type, model capabilities, tool support, and cost."
- **Not Diamond:** the current docs do **not** mention Not Diamond. The Auto Router was historically "powered by Not Diamond", but the 2026 docs describe a market/spend-ranked classifier. Treat "powered by Not Diamond" as **outdated/unverified for current behavior**. (Not Diamond's own API still accepts `type=openrouter` model IDs; see §10.)
- **Cache awareness:** **sticky, conditional.** The router "remembers the model a conversation landed on and prefers it on later turns" and "reuses the remembered model only while that model is still one of the top candidates for the new prompt." The prompt-caching page says: "Auto Router and Pareto Router can also reuse the resolved model, on a best-effort basis, if it stays in the candidate set." So the model is re-ranked every turn, and stickiness only breaks ties within the candidate set. It does not price cache cost.
- **Multi-turn / tool calls:** the session is identified by `session_id` or a "fingerprint of your messages". The docs don't say whether the classifier reads the last message or the whole history (**unverified**). Tool calling works with whichever model is selected, and tool support is a routing factor.
- **Open source:** no. **Deployment:** hosted gateway (model slug). Configure per request via `plugins: [{id: "auto-router", ...}]` (`auto-beta-router` for beta), or set account defaults on the Routing page. No extra fee.

### 1b. Provider routing (same model, different providers/endpoints)
- **Granularity:** per request.
- **Default signals:** OpenRouter weighs "effective price, throughput, time to first token, rate limits, reliability, and tool-call quality", and gives smaller providers some exploratory traffic.
- **Controls:**
  - `sort` (`price`, `throughput`, `latency`), or an object form `{by, partition}`, where `partition: "none"` sorts endpoints across all fallback models.
  - `order`, `allow_fallbacks` (default true), `max_price` (a hard cap that can block the request).
  - Shortcuts: `:nitro` sorts by throughput and allows the priority tier. `:floor` sorts by price and allows the flex tier.
- **Cache awareness: sticky, gated on price.** This is the most explicit provider-level cache stickiness found:
  - "route your subsequent requests to the same provider endpoint after a cached request."
  - Scope: "per account, per model, and per conversation". By default the conversation key is a hash of "the first system (or developer) message".
  - It activates "only when the provider's cache read pricing is cheaper than regular prompt pricing."
  - Works with implicit caching (OpenAI, DeepSeek, Gemini 2.5) and explicit caching (Anthropic `cache_control`).
  - Idle expiry: 10 minutes, reset on each successful request.
  - Failure handling: if the sticky provider fails, the next request can be re-routed. If it's unavailable, OpenRouter falls back to the next-best provider.
  - Override: "Sticky routing is not used when you specify a manual provider order."
  - `session_id` (body, or `x-session-id` header; body wins; max 256 chars): "OpenRouter uses it directly as the sticky routing key instead of deriving one from message hashing." Without it, `prompt_cache_key` is the sticky key.
  - Timing: "With `session_id`, stickiness starts on any successful request, before any cache hit. Without it, stickiness starts only after a cache hit is detected."
- **Multi-turn:** the conversation identity comes from a hash of the first system message, or from `session_id`. Sub-agents with different system prompts therefore get separate sticky keys automatically.

### 1c. Model fallbacks (`models: [...]`)
- Tries models in "priority order". By default any error triggers fallback (the page lists context-length validation, moderation flags, rate limiting, and downtime). "Requests are priced using the model that was ultimately used."
- Cache: a fallback lands on a different model, so the prompt cache is lost by construction. The docs don't discuss this.

---

## 2. AWS Bedrock Intelligent Prompt Routing

Sources: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html · https://aws.amazon.com/blogs/machine-learning/use-amazon-bedrock-intelligent-prompt-routing-for-cost-and-latency-benefits/ · https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html

- **Decision granularity:** per request. "For each incoming request, the system analyzes the prompt ... predicts the response quality of each specified model."
- **Model families:**
  - The current docs table lists only Amazon Nova (Lite, Pro) and Meta Llama (3.1 8B and 70B, 3.3 70B). The CLI example uses `anthropic.claude-sonnet-4-5-...` as a placeholder.
  - The GA blog lists Claude (3 Haiku, 3.5 Haiku, 3.5 Sonnet v1/v2), Llama, and Nova families.
  - Whether current Claude 4.x/5.x models are supported in configured routers is **unverified**.
  - Default routers cover the Nova and Llama families depending on Region. "You must choose exactly two models within the same family." Routing is pairwise: one model plus a fallback model.
- **Signals:** a learned response-quality predictor (a proprietary classifier) and cost.
  - Routing criteria: `responseQualityDifference`. "if you set a response quality difference of 10% and choose Amazon Nova Lite as the fallback model, the router switches to ... Nova Pro, only if its predicted response quality is more than 10% better."
  - The router "can't adjust routing decisions or responses based on application-specific performance data."
  - It is "only optimized for English prompts".
- **Overhead:** about 85 ms P90 (blog). Reported savings: 35% (Nova), 56% (Anthropic), 16% (Meta), about 60% in internal tests.
- **Cache awareness:** **none documented.**
  - Neither the prompt-routing page nor the prompt-caching page mentions prompt routers in relation to caching.
  - The prompt-caching page does note that cache entries are per-server: "A cache entry is stored on the server that processed the request ... Requests that are served by a different server, such as one in another Region ... write a new entry instead of reading one." It says the same about cross-Region inference.
  - A per-request router that flips between two models would therefore lose cache on every flip. Whether `cachePoint` is honored through a router ARN is **unverified**.
- **Multi-turn / tool calls:** the docs only say the system "analyzes the prompt to understand its content and context". Whether it reads the last user turn or the full history is **unverified**, as is tool-use support through a router (not documented on the routing page).
- **Open source:** no. **Deployment:** built into Bedrock. You pass a prompt-router ARN as `modelId` to Converse/InvokeModel. Manage routers with `CreatePromptRouter`, `GetPromptRouter`, `ListPromptRouters`, and `DeletePromptRouter`. The response reports which model served the request.

---

## 3. Azure AI Foundry Model Router (Microsoft Foundry)

Sources: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router (updated 2026-10-30) · https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router · https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router-how-it-works

- **Version:** `2025-11-18` is "Active (latest)" and updated in place. `2025-08-07` and `2025-05-19` are frozen.
- **Underlying models:**
  - About 35 models from OpenAI (gpt-6-astra, gpt-5.6-sol/terra/luna, gpt-5.x, gpt-4.1 family, o4-mini, gpt-oss-120b), Anthropic (claude-fable-5-1, opus-5, sonnet-5, opus-4-6/7/8, sonnet-4-5, haiku-4-5; these must be deployed separately), xAI grok, Fireworks GLM/Kimi, DeepSeek-V3.2, and Llama-4-Maverick.
  - "Model subset" restricts the pool. New models are excluded until you add them.
- **Decision granularity:** per request by default. "By default, model router repeats this selection process for each request. For stateless Chat Completions conversations, separate turns might therefore use different underlying models."
  - Agent docs: it "can select fast models for classification subtasks and reasoning models for analysis — dynamically, per step."
- **Signals:** a "purpose-built, trained machine-learning model ... It is not an LLM itself" that scores "complexity, reasoning, task type, and other attributes."
  - Modes:
    - **Balanced (default):** "considers all underlying models within a small quality range (for example, 1% to 2% compared with the highest-quality model for that prompt) and picks the most cost-effective model".
    - **Cost:** a 5–6% quality band.
    - **Quality:** "picks the highest quality rated model for the prompt, ignoring the cost."
  - Routing is constrained by eligibility (policy, capability, quota, data zone).
  - `reasoning_effort` is passed through when a reasoning model is selected.
- **Multi-turn / tools:**
  - "The router analyzes the full request — including system message, user message, tool definitions, and conversation history."
  - "Multi-turn conversations, where earlier turns provide context but the latest user message carries the most routing-relevant signal."
  - It is trained on "agentic and tool-calling workloads". Image inputs are accepted, but "the routing decision is based on the text input only."
- **Context window:** "The effective context window is limited by the smallest underlying model ... an API call with a larger context will succeed only if the prompt happens to be routed to the right model." The fix is to use model subset. This is a major pitfall for long-context agents.
- **Cache awareness:** **sticky (opt-in preview), explicitly not cost-modeled.**
  - "Because routing decisions might vary, caching benefits apply only when the same model handles consecutive requests with overlapping prompt prefixes."
  - Session affinity (preview, Chat Completions):
    - Enable with the header `Foundry-Features: ModelRouterControls=V1Preview`.
    - Request body: `routing_config.session_affinity = {mode: "sticky"|"none", session_id}`. Alternatively send the `x-ms-session-id` header (the body wins). IDs are 1–256 code points.
    - The association is created or updated only after a successful request and "expires after 30 minutes without a successful create or update."
    - The response reports `model_selection_details.model_router_details.session_affinity.{mode, source, decision}`, where decision is `initialize|retain|switch`.
    - "Policy, safety, capability, quota, availability, and fallback requirements take precedence over affinity."
  - Explicit disclaimer: affinity "doesn't inspect cache state, guarantee a cache hit, or adaptively switch models based on cache savings" / "doesn't inspect provider cache signals, compare the benefit of staying with switching."
- **Failover:** built in. It redirects to the "next most appropriate model" and respects the mode and subset.
- **Open source:** no. **Deployment:** built-in, deployed as a single "model" (Global Standard or Data Zone Standard). It is also usable as the base model of a Foundry Agent Service agent. The response `model` field reveals the served model.

---

## 4. LiteLLM Router / Proxy

Sources: https://docs.litellm.ai/docs/routing · https://docs.litellm.ai/docs/proxy/auto_routing · https://docs.litellm.ai/docs/response_api · source https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/pre_call_checks/prompt_caching_deployment_check.py

### 4a. Load-balancing strategies (`router_settings.routing_strategy`)
These strategies choose among deployments of the same `model_name` group.
- `simple-shuffle` (default; uses rpm/tpm and `weight`)
- `least-busy` (fewest in-flight calls)
- `usage-based-routing` (lowest TPM this minute; "not recommended for production")
- `usage-based-routing-v2` (async; filters out deployments over limits)
- `latency-based-routing` (lowest cached response time)
- `cost-based-routing` (cheapest deployment per cost map)

Also: `order` (lower = higher priority), per-deployment cooldowns ("Cooldowns apply to individual deployments, not entire model groups"), and `enforce_model_rate_limits`.

### 4b. Fallbacks
- `fallbacks` (generic), `context_window_fallbacks` ("Context window errors use a matching `context_window_fallbacks` rule before later orders"), and `content_policy_fallbacks` ("Content policy errors keep their separate fallback handling").

### 4c. Cache/session-aware pre-call checks (`optional_pre_call_checks`). **Verified.**
- **`prompt_caching` → `PromptCachingDeploymentCheck`. Prefix-affinity, verified in source.**
  - It builds the lookup key from system prompt + messages (rewritten "as they will be sent", including auto-injected Anthropic cache breakpoints) + tools.
  - It runs only if the prompt meets the lowest min-token threshold across the group ("The lowest can only cost a lookup that finds nothing").
  - On success it writes the prefix-to-`model_id` mapping to the router `DualCache` (Redis-shareable). On the next request with the same cacheable prefix, it narrows the healthy deployments to that `model_id`, unless that deployment already failed in this request.
  - It is skipped for priority groups, `_target_order`, or single-deployment groups.
  - It accounts for the 1-hour TTL (`_honors_one_hour_cache_ttl`). The exact TTL values live in `PromptCachingCache` (**unverified numbers**).
  - Note: this works at the *deployment* level within one model group (e.g. multiple Anthropic/Bedrock keys or regions), not across different models.
- **`session_affinity`:**
  - "Pin every request of a conversation to the deployment that served its first request." "Load balancing happens across sessions rather than across requests."
  - Session ID sources: the `x-litellm-session-id` header, `x-litellm-trace-id`, any `x-<vendor>-session-id` header (e.g. `x-claude-code-session-id`), or `metadata.session_id`.
  - Config: `deployment_affinity_ttl_seconds` (default 3600, idle TTL refreshed per request), `session_affinity_repin_on_failover`, and per-group `model_group_affinity_config`. Pins live in the router cache and are shared via Redis.
  - Inactive for sync methods, legacy `usage-based-routing`, and `priority` groups.
- **`deployment_affinity`:** pins by caller (virtual key or JWT user) instead of session. The session pin wins if both are set.
- **`responses_api_deployment_check`:** routes `previous_response_id` follow-ups to the original deployment.
- **`encrypted_content_affinity`:** LiteLLM rewrites encrypted output item IDs (e.g. `rs_...` reasoning items) to embed the originating `model_id`. It pins follow-ups to that deployment (bypassing rate limits), falls back to a peer with the same `api_base` and `api_key`, or else drops the encrypted payload but keeps the summary.

### 4d. Auto routers (cross-model)
- **Semantic auto router** (`auto_router/...`, embedding match on utterances, built on `semantic-router`):
  - Now **deprecated** ("deprecated but still works for existing configs").
  - It embeds "the newest user message alone". "A newest turn holding only tool results is embedded as an empty string". This is a known weakness for agent tool loops.
  - Whether it's built on the `semantic-router` library is not stated on the current page (**unverified**, historically yes).
- **Complexity router** (`auto_router/complexity_router`, Beta):
  - Tiers: SIMPLE, MEDIUM, COMPLEX, REASONING (a model or a random pool each).
  - Classifier: `heuristic` (default, no API calls), `llm`, `jev`, `custom`, plus keyword rules and semantic keyword matching.
  - Input is "the **last real human ask** and the **latest system prompt**":
    - Tool-output-only turns are skipped. `tool` role messages are never read. `<system-reminder>` blocks are stripped.
    - LLM/JEV classifiers get up to 3 prior user turns (8,000 chars). Assistant turns are opt-in.
    - If no human text is found, the request goes to `complexity_router_default_model`.
    - Net effect: a pure tool-result turn doesn't trigger reclassification on fresh content.
  - `adaptive: true` Thompson-samples within the tier pool. "Feedback from a later turn is attributed to the model that served the previous response."
  - **Session affinity (router-level):** off by default ("every turn is classified on its own merits"). When on, it "pins the first-turn model for the session and skips reclassification". "The trade is that the whole session inherits the first turn's tier." TTL defaults to 3600 s. "An escalation request can move the pin up a tier." It is ignored when routing `plugins` are configured.
  - These layers stack: model-level pin (complexity router) → `deployment_affinity` → `prompt_caching` (prefix → deployment).
- **Adaptive router (Beta):** linked from the docs but not read in detail (**unverified**).
- **Cache awareness overall:** **sticky** (session, caller, and prefix-hash based). No explicit cache-cost model in the stay/switch decision.
- **Open source:** yes (MIT core; enterprise features separate). **Deployment:** Python SDK `Router`, or the LiteLLM Proxy gateway.

---

## 5. Portkey AI Gateway

Sources: https://portkey.ai/docs/product/ai-gateway/load-balancing · https://portkey.ai/docs/product/ai-gateway/conditional-routing · https://portkey.ai/docs/product/ai-gateway/fallbacks · https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic

- **Decision granularity:** per request (config-driven). Strategies `loadbalance`, `fallback`, and `conditional` can nest arbitrarily ("Any strategy can nest inside any other").
- **Signals:** rules and weights only, with no learned router.
  - Conditional routing queries `metadata.<key>`, `params.<key>` (primitive values only, e.g. `model`, `temperature`, `max_tokens`), and `url.pathname`.
  - Operators: `$eq $ne $in $nin $regex $gt $gte $lt $lte $and $or`.
  - It can't match on the `messages` array (arrays and objects aren't supported).
  - Fallback triggers on non-2xx by default, or on a list via `on_status_codes`.
- **Cache awareness: sticky (generic), not cache-specific.**
  - Load balancing supports `strategy.sticky: {enabled, hash_fields: ["metadata.user_id"], ttl: 3600}`. It hashes the listed fields and caches the target assignment.
  - It uses a two-tier cache (in-memory + Redis). "Without it [Redis], stickiness only holds within a single gateway instance's memory."
  - No mention of provider prompt caching.
  - Portkey's own caching is *response* caching:
    - Simple: exact match.
    - Semantic: Enterprise only, cosine ≥ 0.95 default. It ignores the system prompt, needs at least one user message, ≤ 4 messages, and < 8,191 tokens. This makes it unsuitable for long agent transcripts.
- **Multi-turn / tools:** no content inspection for routing. Conversation identity comes only from whatever you put in `hash_fields` (e.g. `metadata.session_id`).
- **Open source:** the gateway core is open source (github.com/Portkey-AI/gateway). Whether sticky sessions and semantic cache are in OSS or only hosted/enterprise is **unverified**. **Deployment:** hosted or self-hosted gateway proxy, plus SDKs.

---

## 6. Kong AI Gateway (`ai-proxy-advanced`)

Sources: https://developer.konghq.com/plugins/ai-proxy-advanced/ · https://developer.konghq.com/plugins/ai-proxy-advanced/reference/ · https://developer.konghq.com/ai-gateway/load-balancing/

- **Decision granularity:** per request.
- **Algorithms** (`config.balancer.algorithm`, default `round-robin`):
  - `round-robin` (weighted)
  - `least-connections`
  - `lowest-latency`: EWMA. `latency_strategy` is `tpot` (default) or `e2e`. Keeps a small exploration share.
  - `lowest-usage`: `tokens_count_strategy` is `total-tokens` (default), `prompt-tokens`, `completion-tokens`, `cost`, or `llm-accuracy`.
  - `priority`: "always selects from the highest-priority group first". Lower groups serve only as fallback.
  - `semantic`: "Routes requests based on semantic similarity between the prompt and model descriptions."
    - Requires `config.embeddings` and `config.vectordb` (pgvector or redis, cosine or euclidean, `threshold`) plus `targets[].description`. `CATCHALL` marks the fallback target.
    - Which messages are embedded (last vs all) is **unverified**.
  - `consistent-hashing`: "Requests with the same header value are routed to the same model, enabling sticky sessions". `hash_on_header` defaults to `X-Kong-LLM-Request-ID`, which is per request. To get session stickiness you must set it to a session header.
- **Fallback/retry:**
  - `retries` (default 5). `failover_criteria` (default `["error","timeout"]`, add `http_429`, `http_502`, `non_idempotent`).
  - Circuit breaker via `max_fails` / `fail_timeout` (v3.13+).
  - Cross-format fallback (v3.10+).
- **Cache awareness:** **sticky only via consistent-hashing on a header.** No provider prompt-cache awareness is documented. (Kong separately has AI Semantic Cache *response* caching, not covered here.)
- **Multi-turn / tools:** not described. Docs say consistent-hashing helps "maintaining context across user interactions".
- **Open source:** Kong Gateway core is OSS. `ai-proxy-advanced` is an Enterprise/Konnect plugin (the basic `ai-proxy` is OSS). **Deployment:** gateway proxy plugin.

---

## 7. Cloudflare AI Gateway

Sources: https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/ · https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/ · https://developers.cloudflare.com/ai-gateway/features/caching/

- **Decision granularity:** per request, through a visual or JSON flow graph ("route" used in place of a model name).
- **Signals/nodes:**
  - Conditional (expressions over "request body, headers, or metadata", e.g. `user_plan == "paid"`)
  - Percentage split (A/B testing)
  - Rate Limit and Budget Limit (switch to fallback when exceeded)
  - Model
  - Routes are versioned (draft → deploy → rollback).
  - Dynamic routes "accept the OpenAI chat completions request shape only" (Anthropic Messages returns 400).
- **Fallbacks:**
  - The Universal endpoint takes an ordered array of steps `{provider, endpoint, headers, query}` and triggers on error or timeout.
  - Response header `cf-aig-step: N` shows which step served the request.
- **Caching:**
  - *Response* caching, exact match: the key is a SHA-256 of provider, endpoint, model, auth, and full body.
  - Headers: `cf-aig-cache-ttl` (60 s–1 month), `cf-aig-skip-cache`, `cf-aig-cache-key`.
  - Semantic caching is "planned". The docs note "Cache in AI Gateway is volatile."
- **Cache awareness (provider prompt cache):** **none.** No session affinity or sticky routing is documented. A Percentage node will split a single conversation across models.
- **Multi-turn / tools:** not specifically addressed. Conditions can read the body, but no guidance is given for conversations.
- **Open source:** no. **Deployment:** hosted edge gateway (proxy).

---

## 8. vLLM Semantic Router (vLLM-SR)

Sources: https://github.com/vllm-project/semantic-router · https://vllm-sr.ai/docs/intro · https://vllm-sr.ai/blog/session-aware-agentic-routing · https://vllm-sr.ai/docs/v0.3/tutorials/algorithm/selection/session-aware · https://vllm-sr.ai/docs/tutorials/learning/protection · https://vllm-sr.ai/docs/api/session-identification · https://vllm-sr.ai/docs/next/tutorials/signal/overview · https://vllm-sr.ai/docs/installation/model-reasoning · https://vllm-sr.ai/docs/tutorials/plugin/prompt-cache

- **Status:**
  - Releases: Iris v0.1 (2026-01), Athena v0.2 (2026-03), Themis v0.3 (2026-06, "From Signals to Stateful Production Routing"), Hermes v0.4 (2026-09-24, "Many Models, One Improving System").
  - Open "Decision 1.0/2.0/3.0" and "Vela 1.0/2.0" routing foundation models were released in 2026-09/10.
  - Tagline: "An open, programmable decision layer for models and compute ... Give your agent harness one API for many models."
- **Decision granularity:**
  - Per request through a "signal → decision → recipe" pipeline.
  - Session-aware selection adds a session-level stay/switch layer.
  - Recipes can select one model, "escalate through a cascade, run a bounded multi-model workflow", or attach retrieval, memory, tool filtering, caching, safety, or verification.
- **Signals (25 families):**
  - **Heuristic:** action, authz, conversation ("multi-turn, tool-heavy, or agentic structure"), context ("effective context-window needs"), event, input modality, keyword (incl. BM25/n-gram), language, metadata, structure.
  - **Learned:** classifier, complexity, decision (decision model), domain, embedding, modality, fact-check, hallucination, jailbreak, safety, PII, preference, reask ("a repeated question in recent conversation history"), knowledge base, user feedback.
  - Signals "can inspect request text, conversation history, images, caller metadata, or trusted identity depending on the family."
- **Classifier models:**
  - The current docs reference mmBERT-32k embedding models and Decision/Vela models.
  - **ModernBERT:** earlier versions documented ModernBERT/LoRA classifiers (14-category MMLU domain classification is confirmed in v0.1 docs). The specific model names are **not confirmed on the current pages (unverified)**.
- **Reasoning mode toggle:**
  - Per decision, set `use_reasoning`, `reasoning_mode`, and `reasoning_effort` on a model reference.
  - A "reasoning family" (e.g. `qwen3`) maps these to provider-native controls (`chat_template_kwargs`, `reasoning_effort`, etc.).
  - "An always-on family cannot be selected with `use_reasoning: false`."
- **Envoy ext_proc:**
  - Envoy is the data plane ("Envoy continues to carry traffic").
  - The sitemap has `extproc` and `streamed-extproc` tags, but no current page I read explicitly says "ext_proc". The ext_proc integration is **likely but unverified on current docs** (it was the original architecture).
- **Cache awareness: cost-modeled, the strongest found.**
  - **Session-Aware Agentic Routing (SAAR)**, v0.3+ `session-aware` selection algorithm:
    - It wraps a base selector (e.g. `hybrid`) and keeps per-session state: "last physical model, matched decision, phase (normal, tool-loop, provider-state, idle-reset, drift-reset), recent switch count, context length, cache evidence, and a replay ID."
    - **Hard locks:**
      - "Tool loops stay on the previous model while tool calls/results are still active" (`tool_loop_hard_lock`).
      - Provider-state continuations such as `previous_response_id` are pinned (`context_portability_hard_lock`).
      - These locks are not "bought out" by a cheaper model.
    - **Soft penalties:**
      - "Non-idle sessions pay a prefix-cache and handoff penalty before switching."
      - "Expensive/frontier models increase the prefix-cache penalty according to input checkout cost (`prompt_per_1m - cached_input_per_1m`)."
      - "Recent switch history increases the cost of another switch."
      - There are remaining-turn priors (expected future turns, per category/decision, decaying as the session advances).
      - Config keys: `prefix_cache_weight` (e.g. 0.20), `switch_history_weight` (0.04), `max_cache_cost_multiplier` (≥1), `remaining_turn_prior_weight`, `remaining_turn_prior_horizon`, `min_remaining_turn_prior_samples`.
    - **Reset boundaries:** `idle_timeout_seconds` (e.g. 300) and `decision_drift_reset` (e.g. coding → synthesis).
    - **Cache evidence:** "a cache hit is evidence only for the backend that reported it". Provider-reported cached tokens are kept separate from router-estimated reuse.
    - **Benchmark** (21,600 deterministic turns):
      - Versus single-turn routing: 79.29% fewer switches, unsafe switches 3,836 → 0, tool-loop violations 3,404 → 0, estimated cost −78.71%, quality delta −0.0453.
      - Plain sticky-session baseline: −98.65% cost but quality delta −0.1433.
      - p95 overhead is about 6–27 ms.
  - **Router Learning "protection"** (v0.4 docs):
    - A post-routing stability guard with scope `conversation` (`x-conversation-id`) or `session` (`x-session-id`).
    - Rule: "switch if proposal_gain >= switch_margin + stability_weight * switch_cost". `switch_cost` includes "cache, handoff, tool-loop, session, and switch-history cost".
    - Tuning: `min_turns_before_switch`, `switch_margin` (0.05), `stability_weight` (1.0), `idle_timeout_seconds` (300).
    - A `progress_gate` escalates only after consecutive same-category negative outcomes (window 8, cooldown 120 s, ≤ 2 switches per window).
    - A `rescue_switch` fires after repeated 429/5xx, and it "cannot override an active tool-loop lock".
  - **Session identity:**
    - Configurable headers `x-session-id` and `x-conversation-id`. Anthropic `x-claude-code-session-id` is recognized.
    - Fallback order: `x-session-id` → `x-claude-code-session-id` → `metadata.user_id` → derived fingerprints → hash of `x-request-id`.
    - It fails open (routes normally) if identity is missing.
  - **Prompt-cache plugin:** inserts Anthropic cache breakpoints (last instruction block + last tool) after routing ("does not influence route selection"), with TTL `5m` or `1h`.
  - **Response caching:** semantic cache (in-memory, Redis, Milvus, hybrid; "category-aware semantic caching") and a response-cache plugin.
- **Multi-turn / tools:**
  - Explicit "conversation" signal (multi-turn, tool-heavy).
  - Tool loops are treated "as part of a local execution loop, not as fresh prompts".
  - Semantic tool selection/filtering plugins exist.
  - Sub-agents are not specifically discussed. Separate `x-conversation-id` under one session acts as the natural mechanism (**design inference**).
- **Open source:** yes (Apache-2.0, vllm-project). **Deployment:** gateway (Envoy + router service), installable via script, pip, or uv, plus Kubernetes manifests. OpenAI- and Anthropic-compatible endpoints.

---

## 9. NVIDIA LLM Router (AI Blueprint)

Source: https://github.com/NVIDIA-AI-Blueprints/llm-router

- **Status:** **deprecated.** "The Switchyard library implements the same patterns as LLM Router v1 and LLM Router v2" (NVIDIA NeMo Switchyard is the successor; not researched here, **unverified** details).
- **v1 (main):** a Rust proxy plus a BERT-style classifier on Triton.
  - Policies cover *task* classification or *complexity* classification.
  - Pipeline: "Classification + Proxying to LLM". Text only.
  - Per request.
- **v2 (experimental):** NeMo Agent Toolkit (FastAPI).
  - Strategies: *intent-based* (Qwen 1.7B labels such as `hard_question`, `chit_chat`, `image_understanding`, `try_again`) or *auto-routing* ("CLIP embeddings to encode text/image pairs, then a trained neural network to predict the optimal model", with per-model thresholds and costs).
  - "v2 does not proxy requests ... It only returns model recommendations." So it acts as a recommender, not a proxy.
- **Multi-turn:** the router "analyzes the prompt content". Last vs full conversation is **unverified**. The `try_again` intent is the only conversational signal.
- **Cache awareness:** none.
- **Open source:** yes (Apache-2.0). **Deployment:** v1 is a proxy (Docker/K8s, Triton). v2 is a recommendation service plus a Gradio demo, with notebooks for training.

---

## 10. Not Diamond

Sources: https://docs.notdiamond.ai/docs/what-is-not-diamond · https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post.md · https://docs.notdiamond.ai/docs/router-training-quickstart.md · https://docs.notdiamond.ai/docs/how-prompt-optimization-works.md

- **Decision granularity:** per request (`POST /v2/modelRouter/modelSelect` returns the model; you call the model yourself).
- **Request fields:**
  - `messages` (OpenAI format), `llm_providers` (candidates), `tools` ("OpenAI-format function calling tools"), `hash_content` (privacy).
  - `metric` (default `accuracy`), `max_model_depth`, `tradeoff` (`cost` or `latency`) or `cost_quality_tradeoff` (0–10).
  - `preference_id` (custom/personalized router), `previous_session` ("Previous session ID to link related requests").
  - The `type=openrouter` query parameter accepts OpenRouter model IDs.
- **Response:** `providers` and `session_id`.
- **Signals:** a learned quality predictor (a pre-trained "chat" and "code" router) plus cost/latency tradeoff and user preferences.
  - **Custom routers:** `trainCustomRouter` takes prompts, per-model responses, and scores (≥ 15 samples, ≤ 10k) and returns a `preference_id`.
  - **Prompt adaptation/optimization** (`/v2/prompt/optimize`): "taking your existing prompt along with an evaluation dataset and metric ... automatically generating optimized prompts for one or more target models". It is LLM-agent driven, and the docs say "work with as few as three samples".
- **Multi-turn / tools:** it accepts the full `messages` array and `tools`. Whether it weighs all turns is **unverified**. `previous_session` links requests, but the docs don't say it causes stickiness (**unverified**; likely for feedback/analytics).
- **Cache awareness:** **none documented.**
- **Open source:** no for the router service. Python/TS SDKs and REST exist. (`RoRF` and other OSS research routers exist historically, **unverified** current status.) **Deployment:** hosted API/SDK (router as a recommender, not a proxy). VPC is **unverified**.

---

## 11. Martian

Sources: https://withmartian.com/ · https://docs.withmartian.com/ · https://docs.withmartian.com/gateway

- **Current state:**
  - The homepage now focuses on interpretability research ("feature geometry, long-horizon interpretability") and links "Thesean AI — A Lab Building Best Execution for LLMs".
  - The docs describe a **Gateway** ("200+ models", OpenAI and Anthropic API compatible) where you "simply populate the `model` field". This is manual selection.
  - Other products listed are ARES and K-Steering.
- **Model router:** the historical Martian Model Router (performance-prediction routing with `max_cost` / `willingness_to_pay`, and RouterBench) is **not present in current docs**. Old router URLs return 404. Treat it as **deprecated/unverified**.
- **Granularity / signals / cache / multi-turn:** **unverified** (no current router docs).
- **Open source:** RouterBench (historical) is **unverified** current. **Deployment:** hosted gateway.

---

## Summary table

| Product | Granularity | Signals | Cache awareness | Multi-turn / tools | OSS | Form |
|---|---|---|---|---|---|---|
| OpenRouter Auto | per request + session memory | task classifier (~30 types) + market spend ranking + cost_tier | sticky-if-still-top-candidate | session via `session_id` or message fingerprint; input scope unverified | no | hosted gateway |
| OpenRouter provider routing | per request | price, throughput, TTFT, reliability, tool-call quality | **sticky provider while cache warm, only if cache-read < prompt price**; 10-min idle | key = hash(first system msg) or `session_id` | no | hosted gateway |
| Bedrock IPR | per request | learned quality predictor, pairwise, `responseQualityDifference` | none documented | unverified | no | built-in |
| Azure Model Router | per request; opt-in session | trained ML router; Balanced/Cost/Quality bands | **sticky (preview `session_affinity`, 30-min)**; explicitly not cache-modeled | reads full request incl. tools + history; latest user msg weighted most | no | built-in deployment |
| LiteLLM | per request; session/caller/prefix pins | strategies (shuffle/latency/usage/cost), complexity router (heuristic/LLM/keyword), semantic (deprecated) | **sticky: `session_affinity`, `deployment_affinity`, `prompt_caching` prefix→deployment, encrypted-content affinity** | complexity router skips tool-only turns; semantic embeds last user msg only | yes | SDK + proxy |
| Portkey | per request | rules on metadata/params, weights, fallbacks | generic sticky (`hash_fields`, TTL) | no content inspection | gateway core OSS | gateway |
| Kong ai-proxy-advanced | per request | RR, latency (EWMA), usage/cost, semantic, priority, consistent-hash | sticky via header hash only | unverified | plugin is enterprise | gateway plugin |
| Cloudflare AI GW | per request | flow graph: conditions, % split, rate/budget limits | none (exact-match response cache only) | not addressed | no | edge gateway |
| vLLM Semantic Router | per request + session controller | 25 signal families, learned decision models, reasoning toggle | **cost-modeled: prefix-cache checkout cost, switch history, remaining-turn priors, tool-loop hard lock** | conversation signal, tool-loop lock, provider-state lock | yes | Envoy gateway |
| NVIDIA LLM Router | per request | task/complexity BERT (v1); intent LLM or CLIP+NN (v2) | none | unverified | yes | proxy (v1) / recommender (v2); deprecated → Switchyard |
| Not Diamond | per request | learned quality predictor, tradeoff, custom routers, prompt adaptation | none documented | takes messages + tools; scope unverified | no | API/SDK recommender |
| Martian | n/a (gateway manual) | unverified | unverified | unverified | no | gateway |

---

## Most interesting cache-aware / session-aware mechanisms

1. **vLLM-SR Session-Aware Agentic Routing and "protection".** This is the only product found that *prices* a model switch.
   - Rule: `switch if proposal_gain >= switch_margin + stability_weight * switch_cost`.
   - `switch_cost` includes the prefix-cache checkout cost (`prompt_per_1m - cached_input_per_1m` × context), handoff cost, switch history, and remaining-turn priors.
   - Hard locks cover tool loops and non-portable provider state. Resets happen on idle timeout or decision drift.
   - Its ablation shows plain sticky sessions save the most cost but lose quality (−0.143), while cost-modeled switching keeps most of the savings (−78.7%) with a smaller quality loss (−0.045).
2. **OpenRouter provider sticky routing.**
   - Stickiness is gated on economics: it applies "only when the provider's cache read pricing is cheaper than regular prompt pricing".
   - The default conversation key is a hash of the first system message, which separates sub-agents for free. An explicit `session_id` / `x-session-id` or `prompt_cache_key` can override it.
   - Pins start after the first cache hit (or immediately with `session_id`), expire after 10 minutes idle, and are disabled under a manual `order`.
3. **LiteLLM `prompt_caching` pre-call check.**
   - Prefix-hash → deployment affinity. It hashes system + messages + tools *after* auto cache-breakpoint injection, gates on the minimum cacheable tokens, and stores the mapping in Redis-backed DualCache.
   - Combined with `session_affinity`, `deployment_affinity`, and `encrypted_content_affinity`, it gives layered pinning: model → deployment → prefix.
4. **LiteLLM complexity router input hygiene.**
   - It classifies only the "last real human ask" (tool-result-only turns skipped, `<system-reminder>` stripped), with an optional prior-turn window.
   - Optional session pinning means "the whole session inherits the first turn's tier", with tier escalation allowed.
   - This is the right shape for agent loops, where most requests are tool results.
5. **Azure Model Router session affinity (preview).**
   - Uses `routing_config.session_affinity` or `x-ms-session-id`, a 30-minute idle TTL, and `initialize/retain/switch` telemetry in the response.
   - Microsoft is explicit that it is *not* cache-aware ("doesn't ... compare the benefit of staying with switching"), which is a clear gap.
   - Separately, its "context window = smallest underlying model" limitation is a hazard for long-context agents.
6. **OpenRouter Auto Router stickiness.** It re-ranks each turn and keeps the prior model only "while that model is still one of the top candidates". This is a soft stickiness that will still switch whenever the classifier's top-k changes, so it carries cache-loss risk in agent loops.
7. **Counter-examples (no prompt-cache awareness):** Bedrock IPR (per-request pairwise; Bedrock caches are per-server and per-model), Cloudflare (percentage splits and exact-match response cache only), Kong (stickiness only if you hash a session header), Portkey (generic `hash_fields` sticky), Not Diamond, and NVIDIA. With these, an agent-facing router must supply its own session identity and stay/switch economics.
