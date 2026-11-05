# C-notes-2: KV/prefix-cache-aware routing and KV sharing in inference-serving systems
Researched 2026-11-04. Sources are GitHub `main`/`dev`/`master` docs and source (read with `gh api .../contents`), plus arXiv.
"unverified" means I did not confirm it from a primary source. GH-doc shorthand:
- DYN = https://github.com/ai-dynamo/dynamo/blob/main/docs/fern/pages/developer-guide/knowledge-base/modular-components/router/
- AIB = https://github.com/vllm-project/aibrix/blob/main/

## 1. NVIDIA Dynamo KV router (ai-dynamo/dynamo, docs v1.6-era)
(a) Prefix identification: token-level **block hashing**.
- Tokens are split into fixed-size blocks ("e.g., 16 or 64 tokens per block"). Each block is hashed, and the LoRA name is folded into the hash. [DYN/router-design.md]
- Code: `LocalBlockHash = xxh3_64_with_seed(block_bytes, XXH3_SEED=1337)`. LoRA is applied as a seed mutation (`XXH3_SEED.wrapping_add(xxh3_64(lora_name))`). A parent-chained `SequenceHash` (`compute_seq_hash_for_block`) is used for active-block tracking. [https://github.com/ai-dynamo/dynamo/blob/main/lib/kv-router/src/protocols.rs ; https://github.com/ai-dynamo/dynamo/blob/main/lib/kv-hashing/README.md]
- Engines emit their own `ExternalSequenceBlockHash` (vLLM uses SHA256 over a Python tuple). The router re-derives `tokens_hash` so it can index. "Bytewise compatibility with vLLM's hashing is impossible." [lib/kv-hashing/README.md]
- Block size comes from the worker's model deployment card (MDC). [DYN/configuration-and-tuning.md]
- Experimental `--router-tracking-hash keyed-xxh3-v1` mixes a 32-byte provider key into tracking identities. The scope includes model, block size, `cache_salt`, and LoRA. Default is `public-xxh3-v1`. [DYN/configuration-and-tuning.md]
- Indexer:
  - Default is a `ConcurrentRadixTreeCompressed` with `--router-event-threads 4`; `1` selects a single-threaded RadixTree. [DYN/router-design.md]
  - KV events are `stored` / `removed`. Workers keep a local indexer and use monotonically increasing event IDs. The router detects gaps and replays from the worker buffer, or takes a full tree dump.
  - The event plane is NATS Core or ZMQ. [DYN/router-design.md]
(b) Cache vs load trade-off (built-in cost function, lowest cost wins) [DYN/routing-concepts.md]:
```
raw_prefill_blocks      = active_prefill_blocks + incoming_prompt_blocks
adjusted_prefill_blocks = max(0, raw_prefill_blocks - overlap_credit_blocks)
potential_decode_blocks = active_decode_blocks + incoming_active_blocks
cost = prefill_load_scale*adjusted_prefill_blocks + potential_decode_blocks + decode_active_request_weight*active_requests
```
- Policy-YAML defaults [DYN/configuration-and-tuning.md]:
  - `overlap_score_credit: 1.0` ("primary knob"; >1 can saturate the prefill term at 0)
  - `overlap_score_credit_decay: 0.0`
  - `prefill_load_scale: 1.0`
  - `decode_active_request_weight: 0.0`
  - `shared_cache_multiplier: 0.5` (only when a shared cache is enabled, else 0)
  - `router_temperature: 0.0`
- Lower cache tiers: `host_cache_hit_weight` 0.75 (CPU offload) and `disk_cache_hit_weight` 0.25.
- Legacy `--kv-overlap-score-weight` / `--router-kv-overlap-score-weight` now maps to `prefill_load_scale`. The old flags are deprecated and will be removed in v1.7. [same]
- `router_temperature > 0` gives softmax sampling over normalized cost logits instead of argmin. [DYN/routing-concepts.md]
- Decay: device credit is multiplied by `1/(1+decay*normalized_excess_prefill)`, where the excess is measured against the least-loaded worker and normalized by the incoming request size. It stops a cache-rich hot worker from always winning. [DYN/configuration-and-tuning.md]
- Alternative built-in policies [same]:
  - `dynamo-two-tier-cost-fn`: use the least-loaded worker if the active-request spread is >32 AND max/min >1.1. Otherwise use the worker with the largest device overlap if that overlap covers >50% of blocks. Defaults are `cache_threshold` 0.5, `balance_abs_threshold` 32, `balance_rel_threshold` 1.1, ported from the SGLang router `cache_aware`.
  - `dynamo-sticky-min-load`: sticky by session, least-loaded on first bind.
  - `thunderagent`: program-level.
- Runtime retune: PATCH `/router_policy` on the admin port 8002 (process-local, not persisted).
(c) When the cache holder is overloaded:
- The load terms dominate the cost, and the decay knob helps further.
- Busy filtering happens before scoring. Thresholds are `prefill_busy_threshold_frac` (fraction of `max_num_batched_tokens`) and `decode_busy_threshold_frac` (held KV blocks / `total_kv_blocks`), with OR semantics.
- If every eligible worker is busy, requests wait in policy-class queues (`fcfs` or `wspt`; WSPT key `(1+priority_jump)/max(1,isl-cached)`). Queue limits per worker give HTTP 529 when exceeded; a queue limit of 0 means fail fast with 529.
- Overlap is refreshed at dequeue (`DYN_ROUTER_OVERLAP_REFRESH_AFTER_SECS` 10). [DYN/configuration-and-tuning.md]
(d) Session affinity:
- Off by default. Enable with `--router-session-affinity-ttl-secs` (1..31536000, idle TTL) and header `X-Dynamo-Session-ID`.
- Modes: `hard` (default; exact dispatch, rebind once if the worker is gone) or `soft` (advisory).
- The parent-session group binding is experimental (v1.6). Subagents share the parent's binding through `X-Dynamo-Parent-Session-ID`, `x-claude-code-parent-agent-id`, `x-codex-parent-thread-id`, or `x-parent-session-id`. [DYN/configuration-and-tuning.md]
- `dynamo-sticky-min-load` holds at most 65,536 bindings, `max_idle_secs` 14400, ignores session IDs >256B.
(e) Router state and replicas:
- Prefix state comes from KV events, which every router consumes, so each replica builds the same index independently.
- Approximate mode (`--no-router-kv-events`): the router predicts the cache from its own routing decisions. `--router-ttl-secs` default is 120. `--router-approximate-cache-policy ttl` (experimental `lru` models per-rank `total_kv_blocks`).
- Predict-on-route side indexer: `--router-predicted-ttl-secs` (suggested 5). It closes the race for sibling/fan-out requests that arrive before any "stored" event; the per-worker score is the max of primary and side overlap. [same]
- `--router-replica-sync` is off by default. It is best-effort, fire-and-forget event-plane sync of active-sequence load only (`AddRequest`, `MarkPrefillCompleted`, `Free`). It does NOT sync prefix-cache state and gives no identical-decision guarantee. [DYN/router-design.md]
- Session bindings sync through the event plane on a first-live-wins, advisory basis. For strict affinity, docs recommend consistent hashing at ingress on the raw session header. [DYN/configuration-and-tuning.md]
- Request lease expiry: `DYN_ROUTER_ACTIVE_REQUEST_EXPIRY_SECS` 300.
- Cross-cluster (experimental Pool Relay): exports per-pool **Cuckoo-filter** projections of KV state over WAN gRPC instead of full event streams. [DYN/multi-dc-kv-routing.md] This is directly relevant to routing across endpoints with only summary state.
(f) Numbers:
- The NVIDIA launch blog shows TTFT/latency charts for the Smart Router: 2x HGX-H100, 8x R1-Distill-Llama-70B, 100K real R1 requests, ISL/OSL 4K/800. The text gives no numbers. [https://developer.nvidia.com/blog/introducing-nvidia-dynamo-a-low-latency-distributed-inference-framework-for-scaling-reasoning-ai-models/]
- The commonly cited "3x TTFT" figure is **unverified**.

## 2. Ray Serve LLM `PrefixCacheAffinityRouter` (alpha)
Source: https://github.com/ray-project/ray/blob/master/python/ray/llm/_internal/serve/routing_policies/prefix_aware/prefix_aware_router.py ; docs: https://docs.ray.io/en/latest/serve/llm/user-guides/prefix-aware-routing.html
(a) Prefix identification:
- A **character-level** multi-tenant approximate radix tree (`prefix_tree.py`, one tenant per replica).
- Text is `prompt`, or the concatenation of message `content`/`text` parts (no multimodal, no thinking).
- LoRA requests are namespaced as `"\0{model_id}\0"`.
- Only the prompt is inserted (`on_request_routed`), not the response.
(b) Trade-off and defaults (`initialize_state`):
- `imbalanced_threshold=inf`
- `match_rate_threshold=0.1`
- `do_eviction=False`
- `eviction_threshold_chars=400_000`
- `eviction_target_chars=360_000`
- `eviction_interval_secs=10`
- `multiplex_spill_threshold=64`
- Docs example: `imbalanced_threshold` 5, `match_rate_threshold` 0.15, eviction 500k/400k chars, interval 30s.
- Logic:
  1. If max-min queue length over candidates is > `imbalanced_threshold`, use pure Power-of-Two (P2C).
  2. Else, if `matched_chars/len(text)` >= `match_rate_threshold`, pick the replica(s) with the highest match.
  3. Else, pick the "smallest tenants", i.e. the replica with the fewest chars in the tree, as a KV-usage proxy.
  4. If there is no data, use P2C (2 random replicas, the shorter queue wins).
(c) Overload:
- Covered by the imbalance gate.
- `choose_replicas` returns ranked lists, and Serve tries the shortest queue inside a rank. If all replicas are at `max_ongoing_requests`, it backs off and retries. [https://docs.ray.io/en/latest/serve/advanced-guides/custom-request-router.html]
(d) Session affinity: none built in. Custom routers can implement it, e.g. the docs' `ConsistentHashRouter` example with `num_virtual_nodes` 100 and `num_fallback_replicas` 2. [custom-request-router doc]
(e) State and replicas:
- One prefix tree per deployment, held as a **Ray detached actor** (`LlmPrefixTreeActor`). Every router instance (one per proxy/handle) queries and inserts into it asynchronously, so state is shared and centralized. The cost is an actor round trip per request, overlapped with queue-length probes.
- Eviction is per-tenant LRU.
- Custom router API: subclass `RequestRouter`. Implement `async choose_replicas(candidate_replicas, pending_request) -> List[List[RunningReplica]]` and optionally `on_request_routed`. Mixins: `FIFOMixin`, `LocalityMixin`, `MultiplexMixin`.
- Configure through `@serve.deployment(request_router_config=RequestRouterConfig(request_router_class=..., request_router_kwargs=..., request_routing_stats_period_s, request_routing_stats_timeout_s))`. Replicas expose `record_routing_stats()`.
- Docs warn that per-router local views drift. [custom-request-router doc]
(f) Numbers: none found in the docs or the Anyscale blog; **unverified**.

## 3. AIBrix (vllm-project/aibrix) gateway
Docs: AIB/docs/source/features/gateway-routing/{prefix-cache-aware-routing,gateway-plugins,agentic-routing}.rst ; AIB/pkg/plugins/gateway/algorithms/prefix_cache_readme.md ; AIB/pkg/plugins/gateway/ENV_VARS.md
(a) Prefix identification:
- The gateway tokenizes the prompt (chat messages, with canonicalized `tools` prepended, `AIBRIX_PREFIX_CACHE_INCLUDE_TOOLS=true`).
- `AIBRIX_PREFIX_CACHE_TOKENIZER_TYPE`: `character` (UTF-8 bytes, default) or `tiktoken`. A remote engine tokenizer is optional.
- The tokens are split into fixed blocks, and each block hash chains the previous block hash. The trailing partial block is ignored.
- Hash is `cespare/xxhash/v2` with a seed (random unless `AIBRIX_PREFIX_CACHE_HASH_SEED`; 0 when state sync is on). [AIB/pkg/utils/prefixcacheindexer/hash.go]
- `AIBRIX_PREFIX_CACHE_BLOCK_SIZE`: built-in default 4 bytes, but the shipped manifest sets 128. Guidance: 128 for character, 16 for tiktoken.
- `BLOCK_NUMBER` 200000. Blocks expire after `EVICTION_DURATION_MINS` 20 without a refresh.
- Modes:
  - Standard: the index is built from the gateway's own routing decisions.
  - KV event sync (`AIBRIX_PREFIX_CACHE_KV_EVENT_SYNC_ENABLED=true`): uses vLLM block stored/removed events and the engine block size; requires the remote tokenizer.
(b) Trade-off (default auto-blend):
- Score = normalized prefix-match% with weight 5 plus normalized `load-balance` score with weight 4 (`AIBRIX_ROUTING_AUTO_BLEND_PREFIX_CACHE_WEIGHT`=5, `..._PREFIX_CACHE_LOAD_BALANCE_WEIGHT`=4).
- `load-balance`: `score=(running+λ·queued)/EWMA(output_tok/s)·(1+α(1−kv_free)²)` with λ=0 and α=2. Pods with kv_free<10% are skipped.
- With the blend off (`AIBRIX_ROUTING_AUTO_BLEND_LOAD_BALANCE_WEIGHT=0`), standalone selection:
  - Sort matches by match% desc, then running requests asc.
  - Pick the first pod with `running <= mean + f·σ` (f = `STANDARD_DEVIATION_FACTOR`, default 1, manifest 2) and `running <= max(c,1)·(mean+1)` (c = `LOAD_CAP_FACTOR` 1.5).
  - Otherwise fall back to the least-request pod.
- Central load-imbalance gate runs before any strategy: it fires if `max_req > 2.0·(mean+1)` (`AIBRIX_LOAD_BALANCE_IMBALANCE_FACTOR`) and the gap is >= 8 (`..._MIN_GAP`), then narrows candidates to the least-loaded pods.
- `prefix-cache-preble` implements the Preble cost model (`pkg/plugins/gateway/algorithms/prefixcache/preble.go`).
- Other strategies via the `routing-strategy` header, per-model `routingStrategy`, or `ROUTING_ALGORITHM`: `random`, `least-request`, `least-request-top-k` (K=5, ε=4, 300s warm-up ramp), `least-busy-time`, `least-latency`, `least-kv-cache`, `least-utilization`, `load-balance`, `throughput` (fewest weighted tokens), `power-of-two`, `vtc-basic`, `slo*`, `pd`, `session-affinity`, `external`.
- Weighted multi-strategy form: `prefix-cache:W1,load-balance:W2`.
(c) Overloaded holder: skipped by the σ / cap rules and the imbalance gate, and steered by the blended load score.
(d) Session affinity (`session-affinity`) has two headers:
- `x-session-id`: gateway-issued in the response, a base64 pod IP:port.
- `x-aibrix-session-key`: caller-supplied stable key; >256B is treated as unset.
- Mapping is through Redis (1h sliding idle TTL), or **rendezvous hashing over the ready pod set** when there is no Redis.
- No auto-blend: pinning is binary. [agentic-routing.rst, gateway-plugins.rst]
(e) Replicas:
- Each gateway replica holds its own prefix index.
- `AIBRIX_STATESYNC_ENABLED=true` syncs through Redis every 10s (`AIBRIX_STATESYNC_SYNC_PERIOD`): pull, then delta push, per-key `SETEX` TTL 2 min, no pub/sub. This is eventual consistency, and evicted-before-push entries are not propagated. [AIB/pkg/plugins/gateway/statesync/README.md]
(f) Distributed KV cache and numbers:
- arXiv 2504.03648 abstract: the distributed KV cache gives "50% increase in throughput and a 70% reduction in inference latency". [https://arxiv.org/abs/2504.03648]
- v0.2 blog [https://aibrix.github.io/posts/2025-02-20-vllm-control-plane/]:
  - Distributed KV cache with vLLM prefix caching vs prefix caching alone, Bird Text2SQL: peak throughput ~+50%, avg/P99 TTFT -60%/-70%, avg/P99 ITL -30%/-70%.
  - Routing strategies: mean latency -19.2%, P99 -79% on unnamed public datasets.
- KV pool internals (InfiniStore / Valkey backends): **unverified** here.

## 4a. LMCache (LMCache/LMCache, `dev`)
(a) Prefix identification: token **chunks** (`chunk_size: 256` in the examples) hashed into keys. The legacy docs need a matching `PYTHONHASHSEED` across processes.
- Router-facing controller `lookup` API (legacy in-process mode): `POST controller:9000/lookup {"tokens":[...]}` returns `{event_id, <instance_id>: (location e.g. "LocalCPUBackend", matched_prefix_length)}`.
- The router must tokenize first, e.g. through vLLM `/tokenize`. [https://github.com/LMCache/LMCache/blob/dev/docs/source/legacy/kv_cache_management/lookup.rst]
- This is the hook used by vLLM production-stack "kvaware" routing (**unverified** for current versions).
- Multi-process (MP) mode replaces it. The Coordinator handles membership only: "never sees KV data or participates in lookups." [https://github.com/LMCache/LMCache/blob/dev/docs/source/mp/p2p.rst]
(b), (c): LMCache is a cache layer, not a router, so there is no load trade-off. Routers combine `matched_prefix_length` with their own load metric.
- P2P sharing: on a miss, a node asks the owning peer to lock and locate, then does a one-sided RDMA read (NIXL) into its own L1. `--p2p-lookup-timeout` default is 30s.
- So a cache "holder" can serve KV to a less-loaded node instead of taking the request. This decouples affinity from load. [mp/p2p.rst]
- CacheBlend (`--engine-type blend`): reuses KV for non-prefix repeated chunks (RAG) by selectively recomputing a small token subset. [https://github.com/LMCache/LMCache/blob/dev/docs/source/kv_cache_optimizations/cacheblend.rst]
(d) No session concept. (e) The controller/coordinator is a single HTTP service per deployment. Its replication is **unverified**.
(f) Numbers:
- CacheBlend: TTFT 2.2-3.3x lower and throughput 2.8-5x higher vs full recompute, "without compromising generation quality". [https://arxiv.org/abs/2405.16444]
- LMCache with vLLM: "up to 15x improvement in throughput" on multi-round QA / document analysis. [https://arxiv.org/abs/2510.09665]

## 4b. Mooncake (Kimi; arXiv 2407.00079 / FAST'25)
Source: https://arxiv.org/html/2407.00079
(a) Prefix identification: 512-token blocks. Each key is the hash of the block's tokens concatenated with the previous block's key, mapped to global IDs. The hash function is not named.
(b) Conductor (Algorithm 1, a single global scheduler):
- For each prefill instance p:
  - `prefix_len` = match against p's cache keys.
  - `T_queue` = aggregate prefill time of p's queue.
  - `T_prefill` = f(request length, prefix_len).
- If `best_prefix_len/prefix_len < kvcache_balancing_threshold`: TTFT = T_queue + T_prefill, i.e. compute locally.
- Else: TTFT = T_transfer + T_queue + T_prefill, with `transfer_len = best_prefix_len - prefix_len`, i.e. pull KV from the best holder.
- Choose the argmin of TTFT. The decode instance is chosen by load balancing and returns an estimated TBT.
- "prefer to compute ... if the best remote prefix match length is no larger than" local × threshold. The threshold is tuned manually.
(c) Overloaded holder: the request goes to a less-loaded instance, which fetches (replicates) the hot KV. This is heuristic hot-spot replication.
- Reject (HTTP 429) if TTFT > TTFT_SLO or TBT > TBT_SLO.
- Early rejection uses the larger of prefill/decode pool load. Prediction-based early rejection assumes a uniform decode time t_d, to avoid anti-phase oscillation.
- Rejections at 2x replay, 8P+8D, ~23k requests: baseline 4183, early 3771, predictive 3589.
(d) No session affinity. (e) The paper describes one global Conductor and no replicas. How it learns per-instance cache keys is not described.
(f) Numbers:
- Up to +525% throughput in simulation (50%-525% range vs vLLM).
- Kimi handles ~75% more requests under SLOs.
- +20% (ArXiv Summarization) and +40% (L-Eval) vs vLLM.
- Trace hit ratio with a global LRU pool: 0.34 at 1k blocks, 0.46 at 10k, 0.55 at 50k or infinite. ">50% of cache blocks unused." Fig. 8 compares random / load-balance / cache-aware / KVCache-centric (no numbers in the text).
- Mooncake Store (distributed KV pool over Transfer Engine/RDMA) is now an L2/L3 backend for vLLM, SGLang HiCache, LMCache MP, TRT-LLM KVCMv2, and LMDeploy. Dynamo has an event-driven Mooncake shared-cache index (PR 11239). [https://github.com/kvcache-ai/Mooncake README news]

## 5. Preble (Srivatsa et al., ICLR 2025; arXiv 2407.00023)
Source: https://arxiv.org/html/2407.00023
(a) Prefix identification: a global radix tree over tokens. Each node stores its token count, the set of GPUs caching it, and per-GPU request counts within window H. Nodes are pruned when no GPU caches them and there are no recent hits.
(b) E2 (Algorithm 1):
- If `missed_len < cached_len`, **exploit**: go to the GPU(s) with the longest match, choosing the lowest load cost among them.
- Else **explore**: first send to any GPU whose decode ratio > `ImbalR`. Otherwise pick the argmin over all GPUs of `L_i+M_i+P_i`:
  - `L_i = Σ_{r∈window H}(PT_r+DT_r)` (H default 3 min)
  - `M_i = Σ_{j∈evicted} PT_j·N_j` (recompute cost × hit share)
  - `P_i` = prefill time of the missed tokens
(c) Overloaded holder:
- Post-assignment rebalancing: if load(max) - load(min) > `Th_bal`, future exploit requests for the heavy GPU are redirected to the light one.
- If a prefix stays hot (average queueing time doubles over H), it is replicated and its subtree is split by load.
- No numeric defaults for `Th_bal`/`ImbalR`; they are "deducted from profiling".
- Local scheduler: P priority groups by cached-token %, proportional batch fill (fairness).
(d) Sessions: none explicitly. (e) A single global scheduler "can scale to hundreds of GPUs" at 245 req/s (Toolbench) to 2931 req/s (VideoQA). It is not replicated; the paper suggests multiple Preble clusters instead. Local schedulers report evictions asynchronously.
(f) Workload stats (Table 1, mean): prompt tokens / output tokens / shared-prefix % / key-portion %
- Toolbench tool use: 1835 / 43 / 85% / 76%
- ALFWorld embodied agent: 2285 / 16 / 97% / 76%
- APPS programming: 3871 / 190 / 97% / 78%
- NExT-QA video QA: 9865 / 4 / 88% / 99%
- LooGLE long-document QA: 23474 / 16 / 91% / 94%
- Results: vs SGLang, average latency 1.5x-14.5x lower and p99 2x-10x lower (Mistral-7B and Llama-3-70B on A6000 and H100).

## 6. Agent-aware KV retention / scheduling (2025-2026)
- **KVFlow** (arXiv 2507.07400, Pan et al., Jul 2025):
  - Builds an Agent Step Graph and gives each agent a steps-to-execution value, which drives KV-node-level eviction (instead of LRU) in a tree cache.
  - Overlapped CPU→GPU prefetch for next-step agents.
  - Up to 1.83x (single workflow, large prompts) and 2.19x (many concurrent workflows) vs SGLang HiRadixCache. [https://arxiv.org/abs/2507.07400]
- **Continuum** (arXiv 2511.02230, Li, ..., Gonzalez, Stoica; v1 Nov 2025, v7 Sep 2026):
  - Pins the KV of tool-call-emitting requests in GPU for a TTL derived from reload cost and the queueing delay that eviction would cause; evicts on expiry.
  - Uses program-level FCFS.
  - Average job completion time improves >8x on SWE-Bench, BFCL, and OpenHands (Llama-3.1 8B/70B, Gemma-3 12B, GLM-4.5 355B). [https://arxiv.org/abs/2511.02230]
- **Dynamo ThunderAgent router** (experimental): program-level (agent run) scheduler with tool-boundary pause/resume, wrapping the KV router, "porting the scheduler from the ThunderAgent paper". [https://github.com/ai-dynamo/dynamo/blob/main/components/src/dynamo/thunderagent_router/README.md] The ThunderAgent paper itself is **unverified**.
- Dynamo `nvext.agent_hints` (`osl`, `priority`, `strict_priority`, `speculative_prefill`) feed router load/priority. [DYN/configuration-and-tuning.md]

## 7. Cross-system patterns for a router that cannot see backend KV state
1. **Approximate (predict-on-route) index is standard practice.**
   - Dynamo `--no-router-kv-events` (TTL 120s), AIBrix standard mode (20-min expiry, 200k blocks), and Ray (char tree, LRU) all index their own routing decisions.
   - Use TTL/LRU sized to the backend's likely retention. For providers, use the documented cache TTL (e.g. 5 min / 1 h).
2. **Prefix key.** All the systems hash chained fixed-size blocks of the *rendered* prompt: tokens (Dynamo 16/64, Mooncake 512, LMCache 256) or chars/bytes (AIBrix 128B, Ray chars).
   - Include tools ahead of messages (AIBrix `INCLUDE_TOOLS`) and model/LoRA (Ray/Dynamo namespace).
   - Without a tokenizer, char/byte blocks work (AIBrix and Ray default to them).
3. **Trade-off forms seen:**
   - (i) Additive cost with an overlap credit (Dynamo; Preble L+M+P; Mooncake TTFT estimate).
   - (ii) Gate-then-affinity (Ray `imbalanced_threshold` + `match_rate_threshold` 0.1; Dynamo two-tier 32/1.1/0.5; AIBrix σ-gate f=1-2, cap 1.5×(mean+1), imbalance gate 2×(mean+1) & gap≥8).
   - (iii) Weighted blend (AIBrix 5:4).
   - (iv) Exploit only if cached > missed (Preble E2).
4. **Overloaded holder:** every system has an escape hatch. Options are decaying the credit, P2C/least-request fallback, replicating the hot prefix (Preble/Mooncake), fetching KV peer-to-peer (LMCache/Mooncake), queueing (Dynamo), or early-rejecting at SLO (Mooncake 429).
5. **Sessions:** explicit header + TTL (Dynamo `X-Dynamo-Session-ID`, hard/soft modes, parent-agent grouping; AIBrix `x-aibrix-session-key`, 1h Redis TTL or rendezvous hashing). This is the most robust signal when backend state is invisible.
6. **Multi-replica routers:**
   - Nobody offers strong consistency.
   - Dynamo: every replica consumes events itself, plus best-effort load sync; it recommends ingress hashing for strict affinity.
   - AIBrix: Redis periodic delta sync (10s, 2 min TTL) or stateless rendezvous hashing.
   - Ray: a centralized actor.
   - Preble/Mooncake: a single global scheduler.
   - Dynamo Pool Relay: Cuckoo-filter summaries across clusters.
7. **Fan-out race:** siblings that arrive before cache state updates get scattered (Dynamo `--router-predicted-ttl-secs 5`). A router must record the decision at route time, not at completion.
