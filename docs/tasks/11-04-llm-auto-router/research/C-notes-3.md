# C-notes-3: Prefix/KV-cache reuse in AGENT workloads (for a cache-affinity LLM router)

Compiled 2026-11-04. Method: WebFetch of primary pages (arXiv abs/HTML, vendor blogs/docs, GitHub). WebSearch was not
available, so discovery used the arXiv API search. Most arXiv numbers come from a summarizer reading the paper's HTML
full text; I did not check them against the figures myself. Where a number appears only in an abstract, it is marked
[abs]. "unverified" means it was not confirmed from a primary source. I computed the Section 4b numbers myself by
streaming the public trace files (method given there).

Legend: [abs] = from the abstract only. [html] = from the paper's full-text HTML. [doc] = vendor doc or blog.

---------------------------------------------------------------------------------------------------------------------
## 1. Tool-call loops: append-only prefix, inter-request gaps vs TTL, measured hit rates
---------------------------------------------------------------------------------------------------------------------
### Practitioner claims
- Manus, "Context Engineering for AI Agents" [doc] https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
  - "the KV-cache hit rate is the single most important metric for a production-stage AI agent."
  - Average input:output token ratio is about 100:1. A typical task makes about 50 tool calls.
  - Rules: keep the prefix stable (no second-precision timestamp at the top of the system prompt); keep context
    append-only (never edit past actions or observations); serialize deterministically (JSON key order can silently
    break the cache); put manual breakpoints at least at the end of the system prompt and account for expiry.
  - Self-hosted vLLM: turn on prefix caching and "use session IDs to route requests consistently across distributed
    workers". This is the sticky-routing recommendation, stated directly.
- Anthropic, "Lessons from building Claude Code: Prompt caching is everything" (T. Shihipar, 2026-04-30) [doc]
  https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/
  - The team alerts on cache hit rate and declares SEVs when it drops. "a few percentage points of cache miss rate"
    has a large effect on cost and latency. No target hit rate is published.
  - Prompt layout, from most to least stable: static system prompt and tools (cached globally) -> CLAUDE.md (per
    project) -> session context (per session) -> messages.
  - Past cache breaks came from: a detailed timestamp in the system prompt, non-deterministic tool ordering, and
    changed tool parameters (for example, the list of agents the Agent tool can call).
  - Dynamic state (time, file edits) goes into `<system-reminder>` blocks in the next user message or tool result,
    not into the system prompt.
- Claude prompt-caching docs [doc] https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  - Default TTL is 5 minutes, refreshed on every hit. A 1-hour TTL is optional. TTL counts from the START of the
    request that wrote or read the entry, so a 4-minute streamed response leaves about 1 minute.
  - Up to 4 explicit breakpoints. Reads look back at most 20 blocks. Matching is exact. Minimum cacheable length is
    512-4096 tokens depending on the model.
  - Isolation is per organization (and per workspace on the Claude API). Bedrock and Vertex isolate per org only.
  - "For parallel requests to hit the cache, send one request first, wait for it to begin responding, then send the
    rest." Pre-warming with `max_tokens: 0` is supported.

### Measured data (production and large traces)
- GitHub Copilot agent traces, June 2026: 3.2M users, 13M sessions, 761M calls, 95T tokens [html]
  https://arxiv.org/abs/2608.00101 (Microsoft Research authors: Liu, Qiu, Goiri, Fonseca, Bianchini, Choukse)
  - Within a turn: median hit rate about 98% but bimodal (about 10% of calls below 20%). By position in the turn,
    call 1 averages about 45%, call 2 about 86%, and call 3 onward plateaus at 92-94%. The abstract gives about 90%
    within a turn and about 55% across turn boundaries.
  - Hit rate vs idle gap: median >=95% for gaps under 2 minutes; about 70% (tail down to 0) for 2-10 minutes; about
    0-5% beyond 10 minutes. This is a cliff between 2 and 10 minutes, consistent with the 300 s provider TTL.
  - Gaps: tool execution median 166 ms, P90 4.4 s, P99 79 s, mean 16.7 s. Idle time between LLM calls within a turn
    (KV idle) median 1.2 s, P95 37 s. Cross-turn KV idle median 172 s, P95 about 4,500 s. User idle median about
    25 min, with a tail beyond a day.
  - Size: median prompt about 68K tokens, of which about 63K cached. Median output 247 tokens (ratio above 275:1).
    Prompt mix: history 48%, function-call messages 28%, system 14%, other 10%.
  - Volume: per session, median 15 calls (mean 40.6). Per user turn, mean 6.6 calls; about 87% of calls are
    autonomous.
  - The paper built a LightGBM idle-time predictor (about 2 MB, under 3 ms per turn boundary, ROC-AUC 0.73 for idle
    above 60 s). It recommends a keep-alive just before TTL expiry when predicted idle straddles 300 s, and higher
    retention priority for "Deep-loop" users, whose miss re-prefills about 1.1M tokens versus about 23K for chat-only
    users.
- TraceLab (UW): about 4.3K Claude Code and Codex sessions, 350K LLM steps, 430K tool calls, data released [html]
  https://arxiv.org/abs/2606.30560 | data: https://github.com/uw-syfi/TraceLab
  - Prefix hit rate is about 95.7% overall: 97.5% on tool-result steps, 84.4% on user-initiated steps (Codex 78.2%).
  - Under idealized timeout eviction, achievable hit rate is about 85.4% at a 1-minute timeout, about 94% at
    5 minutes, and about 98.6% at 1 hour. Misses start above 5-minute human gaps, and after 1 hour nearly every step
    misses.
  - Tool latency per call: median 0.3 s, p90 13.6 s, p99 3.6 min. Calls over 1 minute are about 5% of calls but about
    92% of Claude tool time.
  - Human pauses: median 1.4 min, p90 20.6 min.
  - Append per step: median about 860 tokens, but p99 120-230K. Over 90% of steps append under 1K tokens. Context per
    step: median about 116-126K tokens (Claude p99 about 918K). Output median 184-252 tokens.
  - Only 19% of append tokens are fresh, giving prefill amplification of 5.3x (8.1x on Claude). Parallel tool calls
    average 1.2 per step (p99 4).
  - Compaction occurs in 9.7% of sessions (Claude 4.5%, Codex 18.4%).
- Production general-agent platform: 11.7M requests over 2 weeks, more than 10K GPUs, GLM and DeepSeek models [html]
  https://arxiv.org/abs/2609.34432
  - Median cached-input fraction is 98.1%, and 6.34% of requests have zero cache. Same-model, same-instance
    continuations reach 93% reuse.
  - Input P50 is 70K tokens (P90 229K). Output P50 is 188 tokens.
  - Start-to-start gaps: tool loops P50 8.3 s, P90 51 s. User messages P50 17 s, P90 309 s.
  - Reuse is very skewed: the top 14.3% of sessions hold 98.5% of context residency. Median session has 2 requests;
    P99 has 250.
- Microsoft M365 agent traces: 4 workloads, more than 121M calls [abs] https://arxiv.org/abs/2610.22863
  - Deep Research median context grows from about 10K to about 68K tokens by the 30th call. About 80% of context
    tokens are served from the prefix cache.
  - The GPU is running inference only 5.6% of the time KV state is retained. A P99 session already exceeds one H100's
    80 GB.
- Continuum (Berkeley, Stoica group) [html] https://arxiv.org/abs/2511.02230
  - Tool time on SWE-bench averages about 0.9 s (std 3.6 s); on BFCL web search about 1.9 s. The slowest 10% of calls
    account for 52-94% of tool delay.
  - Jobs average about 10.9 turns (SWE-bench) and about 6.3 turns (BFCL), at 70-93K tokens per program.
- Also: "Serving Agentic Robot Fleets" (arXiv 2611.01404) [abs] reports 215K-token contexts, a median agent request
  of 7.78 s, and a 1.0 s environment step gap.

### Implications for router
- Intra-loop gaps (median about 1 s, P95 under 1 minute) are far below any provider TTL. If the next call reaches the
  same KV holder, within-turn hit rates of 90-98% are achievable. Session-sticky routing is therefore the main lever.
  Key on a session ID or on a hash of the first N KB of the prefix.
- Expect warmth to be lost at user-turn boundaries. Model P(warm) as a function of (time since last call, provider TTL):
  above 95% under 2 minutes, a cliff from 2-10 minutes, and roughly cold beyond 10 minutes (Copilot data). After
  about 5 minutes (Anthropic default TTL) or about 1 hour (1h TTL), stickiness has little value, so rebalancing is
  nearly free.
- Treat the first call of a turn specially: it gets about 45% hits. A cold-session first call is the cheapest time to
  move a session to another provider.
- Weight affinity by session size. Prompts are 68-126K tokens at the median, so a miss costs about 60-120K tokens of
  re-prefill, or about 1M for deep loops. A per-session cached-token estimate makes a good stickiness weight.
- For self-hosted endpoints, a keep-alive or pre-warm is worthwhile when predicted idle falls just past the TTL
  (Copilot recommendation). The router can issue it because it sees the inter-request timing.

---------------------------------------------------------------------------------------------------------------------
## 2. Sub-agents, multi-agent, parallel tool calls, fan-out from a shared prefix
---------------------------------------------------------------------------------------------------------------------
- Real fan-out is rarer than papers assume.
  - Copilot [html] https://arxiv.org/abs/2608.00101: 93% of tool batches contain a single tool, median parallel
    width is 2, and the tail reaches 108. LLM concurrency within a turn is median 1.15, P90 1.4. 63% of turns show some
    LLM-call overlap. Read-only tools are batched; write and run tools run serially.
  - Production agent platform [html] https://arxiv.org/abs/2609.34432: only 0.225% of logical sibling requests
    overlap in service, and 83.9% of sibling pairs launch more than 10 s apart. Sessions with graph width above 1 are
    16.8% of sessions but 68% of requests. Sub-agent wait is P50 1.4 s, P99 876 s. 10.7% of sub-agent successors and
    22.8% of ask-user successors have less than half their input cached.
  - TraceLab: 1.2 tool calls per step on average.
- Anthropic context engineering (2025-09-29) [doc] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - Sub-agents burn "tens of thousands of tokens or more" and return 1-2K-token summaries. The sub-agent's prefix (its
    own system prompt) differs from the parent's. Its reuse is the shared system and tools, not the parent history.
- Claude Code [doc] (blog above): use sub-agents to switch models. Example: Opus hands off to Haiku Explore agents,
  because caches are model-specific and switching models mid-session forfeits the cache. Side calls (compaction,
  summaries, skills) are "cache-safe forks" that reuse the parent's exact system prompt, tools, and messages plus one
  appended prompt.
- Copilot: 6.4% of sessions switch models, mostly in reaction to errors or rate limits. Average hit rate after a
  switch is about 8% (about a 67% drop), versus a 26% drop at same-model turn boundaries.
- Systems papers on multi-agent and multi-call workloads:
  - KVFlow [abs] https://arxiv.org/abs/2507.07400: an Agent Step Graph tracks each agent's steps-to-execution to drive
    eviction in the radix tree and to prefetch CPU->GPU. Up to 1.83x faster for a single workflow and 2.19x with
    concurrent workflows, versus SGLang HiCache.
  - Autellix [html] https://arxiv.org/abs/2502.13965: hit rate within one program stays above 90% at all input
    lengths. Across programs it decays exponentially with length, since only the system prompt is shared. Requests of
    2048 tokens or fewer reach at least 75% on any engine.
    - Load balancer: requests of 2048 tokens or fewer go to the least-used engine. Longer requests are pinned to the
      program's engine. This gains 1.4-1.5x over round-robin or least-used.
    - Program throughput is 4-15x vLLM. Workloads: BFCL averages 10.75 calls per program; LATS (tree search) averages
      159.7 calls per program.
  - Continuum [html] https://arxiv.org/abs/2511.02230 pins KV across a tool call for a TTL that maximizes
    P(tool finishes within tau) x (queueing delay x eta + reload cost) - tau. It uses a per-tool empirical CDF and
    falls back to global records when a tool has fewer than 100 samples. Delay improves 1.12-3.66x on benchmarks and up
    to 8.18x on a production SWE-agent. OpenHands RL rollout: 144.9 steps/min vs 93.4 for vLLM.
  - TokenCake (EuroSys'27) [abs] https://arxiv.org/abs/2510.18586 offloads KV during function calls and uploads it
    predictively, and reserves memory for critical-path agents. Up to 47% lower end-to-end latency.
  - SGLang RadixAttention [html] https://arxiv.org/abs/2312.07104: hit rates of 50-99% across ReAct, generative
    agents, ToT, SoT, and few-shot workloads. Longest-prefix-first scheduling reaches about 96% of optimal hit rate.
    Throughput up to 6.4x. A data-parallel router keeps a meta radix tree of the workers' trees, updated from eviction
    reports (weakly consistent).
  - Parrot (OSDI'24) [abs] https://arxiv.org/abs/2405.19888 uses Semantic Variables to expose cross-request DAGs,
    for up to an order of magnitude gain. Its prefix-share percentage was not extracted.
  - "Hyperion" (arXiv 2511.14450) is edge pipeline partitioning and is NOT relevant to agent KV caching.

### Implications for router
- Group requests by prefix family, not just by session. Sub-agents share tools and system prompt (a global or
  per-project prefix) with siblings, but not the parent's history. Route a sub-agent family to the replica or provider
  holding that system-prompt prefix. A sub-agent's own loop then behaves like a section 1 session.
- For true fan-out (rare, but up to 100+ wide): send ONE request first, then release the siblings once it starts
  streaming (provider caches only become readable after the first response begins). Alternatively, pre-warm with
  max_tokens=0. Otherwise N parallel requests all pay for a cache write.
- Model switches are cache resets (about 8% hit rate afterward). A router that "downgrades to a cheaper model for an
  easy turn" must charge the full re-prefill of the session context to the cheaper option. Default to model pinning
  per session. Route cheaper models only through sub-agent hand-offs, which carry a small context.
- Long requests (above about 2K tokens) gain the most from affinity; short ones can be load-balanced freely
  (Autellix). This gives a simple 2-class policy.

---------------------------------------------------------------------------------------------------------------------
## 3. Compaction, summarization, context editing, and dynamic tool lists
---------------------------------------------------------------------------------------------------------------------
- Measured effect (Copilot) [html] https://arxiv.org/abs/2608.00101
  - Compaction appears in 7.8% of sessions (22.6% of long-context sessions). Those sessions carry 44.2% of all tokens.
  - A median event removes 72.8% of prompt tokens. The next call's hit rate drops by a median 66.1%. 34% of events
    erase at least 90% of cache hits, and 21% erase at least 99%.
  - Compaction takes about 22% of turn time at the median (P90 34%). Triggers cluster at 50%, about 65%, 80%, and
    about 100% of context utilization.
  - Recommendation: incremental, prefix-preserving compaction.
- "The Physical Cost of Context" (NeurIPS'26 workshop) [abs] https://arxiv.org/abs/2610.34763
  - "A shorter prompt can therefore cost more if it rewrites cached history." On SWE-bench Verified, keeping only the
    last 5 observations cut prompt volume but sharply increased uncached prefill. The arXiv listing summary gives
    +608.5% (unverified beyond that summary).
- "Beyond Token Savings" [abs] https://arxiv.org/abs/2609.32961: about 35K runs on SWE-bench Verified and
  Terminal-Bench. Compression to about one third of the tokens made runs 20-80% slower.
- "Cache Engineering for Agents" (AKV) [abs] https://arxiv.org/abs/2610.28577: drops KV entries and re-adjusts
  RoPE instead of rewriting text. 27.7% cheaper than threshold summarization and +1.7 points on benchmarks. It notes
  that identical token sequences can produce different cache states, so plain prefix matching is insufficient. This is
  research-only, self-hosted.
- "Rethinking KV Cache Eviction for Agentic LLM Serving" (Penelope) [abs] https://arxiv.org/abs/2611.00391: keeps the
  shared prefix, evicts from the start of the remaining history, and keeps the suffix. Up to 60% (GPU) and 76%
  (GPU+CPU) lower TTFT vs SGLang.
- Anthropic patterns [doc]
  - Claude Code compaction is a cache-safe fork: same system, tools, and messages plus an appended compaction prompt.
    The fork costs one tenth the price and returns a summary of about 20K tokens. Space is reserved for a "compaction
    buffer".
    https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/
  - Server compaction API: on-demand or at a threshold, with keep-recent-turns and background modes.
    https://platform.claude.com/docs/en/build-with-claude/compaction
  - Context editing (tool-result clearing) "invalidates cached prompt prefixes whenever content is cleared". Use
    `clear_at_least` so each invalidation is worth the cache write. Defaults: trigger at 100K tokens, keep 3 tool uses.
    https://platform.claude.com/docs/en/build-with-claude/context-editing
  - Invalidation hierarchy is tools -> system -> messages. Changing tool definitions invalidates everything; changing
    tool_choice or images invalidates messages; changing thinking or effort parameters invalidates messages.
    https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Dynamic tool lists
  - Claude Code keeps every tool in the request. Plan mode is itself a tool, and MCP tools are sent as
    `defer_loading` stubs so the prefix stays stable.
  - Manus masks tool logits and never removes tools mid-loop.
  - Cursor (2026-01-06) loads MCP tool descriptions from files on demand: -46.9% total agent tokens in MCP-using runs.
    It also writes long tool output to files.
    https://cursor.com/blog/dynamic-context-discovery
- OpenHands condenser (2025-04-09) [doc] https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents
  - Summarizes older history and keeps recent events. Up to 2x lower per-turn cost; cost grows linearly instead of
    quadratically. Solve rate 54% vs 53% baseline.
  - It condenses only at a size threshold "to keep caching useful between condensations" (the cost is amortized).

### Implications for router
- A compaction or context-edit event ends affinity. The new prefix is cold everywhere except for the system and tools
  part. The router can detect it as a large drop in prompt length or a mismatch in the prefix hash after the system
  block. At that point it can re-place the session on a less loaded or cheaper endpoint at no affinity cost.
- If the router (or a gateway) performs compaction, use the cache-safe fork: the same endpoint and model, with the
  parent prefix plus an appended instruction. A summary call on a different model or system prompt pays full price.
- Stage the post-compaction prefix: the first call after compaction is a cache write. Count it in the cost model,
  since it is about 1.25x input on Anthropic's 5-minute TTL (pricing is covered elsewhere).
- Lint requests passing through the router for cache breakers, and ideally export a metric for them:
  - timestamps or UUIDs in the system prompt;
  - non-deterministic tool or JSON key ordering;
  - tools added or removed mid-session;
  - changes to tool_choice, thinking, or effort.
  The router can normalize tool ordering and JSON key order before forwarding, which is a cheap, high-value feature.

---------------------------------------------------------------------------------------------------------------------
## 4. Public traces with prefix-sharing info, and reuse-time distributions
---------------------------------------------------------------------------------------------------------------------
### 4a. Inventory
| Trace | Prefix info | Agentic? | Notes / URL |
|---|---|---|---|
| Mooncake FAST'25 (Kimi): conversation 12,031 req; toolagent 23,608 req; synthetic | hash_ids per 512-token block | "tool&agent" trace | 1 h, ms timestamps. https://github.com/kvcache-ai/Mooncake/tree/main/FAST25-release |
| Qwen Bailian (Alibaba, ATC'25 "KVCache Cache in the Wild"): traceA (to-C), traceB (to-B API), thinking, coder | SipHash per 16-token block, chat_id/parent_chat_id/turn | API/coder (not explicitly agent) | 2 h sample, Git LFS. https://github.com/alibaba-edu/qwen-bailian-usagetraces-anon |
| TraceLab (UW): 4.3K Claude Code/Codex sessions | per-step context/append/hit stats, tool timings | yes, coding agents | https://github.com/uw-syfi/TraceLab |
| GAIATrace (arXiv 2606.01725) | token-level agent traces + Vidur-Agent simulator | yes (GAIA) | [abs] https://arxiv.org/abs/2606.01725, not inspected |
| Azure LLM inference 2023/2024 | NONE (timestamp, ContextTokens, GeneratedTokens) | no | https://github.com/Azure/AzurePublicDataset/blob/master/AzureLLMInferenceDataset2024.md |
| BurstGPT v2 | NONE (has Session ID for conversation logs and Elapsed time; no hashes) | no | https://github.com/HPMLL/BurstGPT |
| ServeGen (Alibaba, NSDI'26) | workload generator; prefix data not confirmed | no | https://arxiv.org/abs/2505.09999 |
| M365 KV residency | trace generator + replay "planned" | yes | https://arxiv.org/abs/2610.22863 |

### 4b. Numbers I computed from the public trace files
Method: I streamed each file over HTTPS into an in-memory Python script, so nothing was stored. The cache model is an
infinite cache with a contiguous prefix match over hash_ids. The "idle-TTL" variant counts a block as a hit only if it
was last touched within T seconds, which is a refresh-on-hit model like Anthropic's.

| Trace | Infinite-cache block hit | TTL 5 s | 30 s | 60 s | 300 s | 600 s | 3600 s |
|---|---|---|---|---|---|---|---|
| Mooncake toolagent (1 h) | 55.3% | 33.7% | 35.1% | 38.2% | 51.2% | 54.7% | 55.3% |
| Mooncake conversation (1 h) | 36.6% | 4.2% | 5.9% | 10.3% | 28.8% | 34.3% | 36.6% |
| Qwen coder (2 h, 43K req, input p50 4.5K) | 66.4% | 28.5% | 39.3% | 44.0% | 57.3% | 61.1% | 66.1% |
| Qwen traceB API (2 h, 173K req, input p50 574) | 54.2% | 30.1% | 43.6% | 47.1% | 51.6% | 52.7% | 54.1% |

- Mooncake toolagent: 33.8% of all blocks are hits on 18 "hot" shared blocks (each in 50 or more requests, i.e. system
  prompts). Only 4 distinct first blocks exist, and the top one covers 46% of requests. Only 21.4% of blocks are
  session-private reuse.
  - Gap distribution for session-private reuse (time since the deepest private matched block was last touched):
    p10 39 s, p25 66 s, p50 117 s, p90 423 s, p99 819 s.
  - Share of those reuses within a given gap: 6.4% within 30 s, 23% within 60 s, 52% within 2 min, 82% within 5 min,
    97% within 10 min.
  - Conversation trace is similar: p50 123 s, 79% within 5 min.
  - Caveat: these gaps are much longer than the Copilot and TraceLab intra-turn gaps of about 1 s. Most likely the
    trace is sampled or the "toolagent" traffic is not a tight loop. Treat it as an API-level mix, not as a model of an
    agent loop.
- Qwen coder: 38.6% of requests have their parent in the trace. Parent-to-child start-to-start gap: p10 6 s, p50 118 s,
  p90 942 s. 32% of children arrive within 60 s, 72% within 5 min, 84% within 10 min.
  - A 5-minute refresh TTL captures 57.3/66.4, or about 86% of the ideal hit; a 1-hour TTL captures about 99.5%.
- The Qwen paper's own figures [html] https://arxiv.org/abs/2506.02634 (ATC'25):
  - Ideal hit is 62% (to-C) and 54% (to-B). Reuse is skewed: 10% of blocks account for 77% of reuses.
  - On to-B, 97% of hits come from single-turn requests (shared system prompts). Cross-user hits are rare.
  - 80% of reuse falls within 10 min (to-C) or within 10 s (to-B).
  - Per-category reuse probability fits an exponential and is predictable by category.
  - A workload-aware eviction policy gets 1.5-3.9% higher hit ratio than the best baseline and cuts queued TTFT by
    28-42%.
- Mooncake paper [html] https://arxiv.org/abs/2407.00079: about 50% upper-bound reuse on its trace; more than 50% of
  blocks are never reused; LRU beats LFU. Hit ratio vs capacity: 1K blocks gives 30%, 10K gives 40%, 50K gives 50%.
  The paper's "input:output ratio about 720" conflicts with its own averages (about 42), so treat it as unverified.

### 4c. Reuse-time and TTL evidence from agent-specific studies
- Copilot: hit rate vs idle has a 2-10 minute cliff. Cross-turn KV idle median 172 s (P95 75 min). Intra-turn median
  1.2 s.
- TraceLab: an idealized timeout of 1 min, 5 min, or 1 h yields about 85%, about 94%, or about 98.6% hit rate.
- Production agent platform [html] https://arxiv.org/abs/2609.34432: 300 s is used as the episode boundary.
  Type-specific TTLs (by wait type: command, sub-agent, ask-user, user) cut recompute by 1-14% vs uniform 5, 15, or
  25-minute TTLs. Cross-task continuations retain 80.6% reuse; same task across episodes retains 44.7%.
- M365 [abs]: a 1-hour idle cap cuts peak retention by 3.6x while recompute rises only from 4.07% to 4.53%.
  - At one tenth of peak-hour memory, the share of calls that must recompute is 63% under LRU, 31% under a clairvoyant
    policy, and 13.6% when cold KV is compressed to int4.
  - When the next call lands on a different deployment, cached-context reuse falls from 89% to 29%. Treating KV as
    tied to one deployment raises the recompute floor from 5.4% to 20.2% even with unlimited memory.
- WAKMan [abs] https://arxiv.org/abs/2610.36355: agentic steps return "within seconds", which favors recency. LRU
  beats S3FIFO by 12% on agent-heavy mixes but trails it by up to 22% on others.
- FlatCake [abs] https://arxiv.org/abs/2610.38355: on a production Claude Code trace (served with DeepSeek-V4-Flash),
  hit rate is 94% vs 64% for Mooncake under load. Agent sessions are multi-GB, beyond DRAM capacity.
- llm-d precise prefix-aware routing (2025-09-24) [doc] https://llm-d.ai/blog/kvcache-wins-you-can-see
  - The router keeps a KV-event-fed block index: 8 B per 128-token block. P90 TTFT is 0.54 s vs 31 s (approximate)
    vs 93 s (random). Throughput is 8.7K vs 4.4K tok/s.
  - The workload is multi-tenant SaaS with a 6K shared prefix, NOT agentic, and the results are self-reported.

### Implications for router
- Reuse-time is bimodal for agents: about 1 s within a turn, then minutes to hours across turns. For each session,
  estimate P(warm at t) = P(gap < provider TTL, with refresh) and use it to decide when affinity is worth anything.
  - Practical cut points: under 2 min, almost surely warm; 2-10 min, uncertain (consider a keep-alive if the session's
    cached prefix is large); over 10 min (5-minute TTL) or over 1 h (1-hour TTL), assume cold and route freely.
- Cross-deployment placement destroys reuse (89% to 29% in M365; about 8% after a model switch in Copilot).
  Affinity should key on (provider, region or deployment, model) together, not just on provider.
- Shared system-prompt blocks are a large, cross-session hit source: 34% of blocks in Mooncake toolagent, and 97% of
  hits in Qwen to-B. Steering sessions that share an agent template toward the same endpoint pool gives a hit floor
  even for new sessions. For providers with org-level caches (Anthropic, Bedrock), only org and model matter for
  this, not the replica.
- For simulating router policies, the two qualifying public traces are Qwen coder/traceB (16-token hashes,
  parent_chat_id) and Mooncake toolagent (512-token hashes). TraceLab is the best agent-realistic source for gap and
  append distributions. Azure and BurstGPT lack prefix data; use them only for arrival burstiness.
- Self-reported cache hit rates from agent builders, for calibration:
  - Copilot: about 90% within a turn and about 55% across turns.
  - Claude Code and Codex (TraceLab): 95.7%.
  - Production general-agent platform: 98.1% median cached fraction.
  - M365: about 80% of tokens.
  - Manus: none published, but called the #1 metric.
  - Claude Code team: SEVs on drops; no number published.
