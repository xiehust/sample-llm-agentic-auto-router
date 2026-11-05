# C-notes-1: How KV- and prefix-cache-aware LLM routers work (SGLang, vLLM production-stack, llm-d, GIE)
Researched 2026-11-04. Sources are GitHub `main` (raw files) plus the official docs and blogs, each cited inline.
"unverified" means I could not confirm the point from a primary source.

## 0. Repo landscape as of Nov 2026 (this changed a lot in 2025-26)
- SGLang now has two router codebases in-tree:
  - `sgl-router/` is the new "slim, KV-aware router". https://github.com/sgl-project/sglang/blob/main/sgl-router/README.md
  - `sgl-model-gateway/` is an "in-tree mirror of SMG ... the gateway being deprecated". https://github.com/sgl-project/sglang/blob/main/sgl-router/BENCHMARKS.md
  - SMG (Shepherd Model Gateway) itself now lives at https://github.com/smg-project/smg (crate `smg-mesh` 1.4.5, https://crates.io/crates/smg-mesh). It is engine-agnostic and also proxies cloud providers.
- The GIE (kubernetes-sigs/gateway-api-inference-extension) README says the EPP, InferenceObjective/InferenceModelRewrite and BBR "have moved" to `llm-d/llm-d-router`. GIE keeps the InferencePool API (v1, GA since v1.0), a lightweight round-robin LWEPP for conformance tests, and the conformance tests. https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/README.md , https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/pkg/lwepp/README.md
- `llm-d/llm-d-inference-scheduler` now redirects to `llm-d/llm-d-router` (checked with the GitHub API).
- `llm-d-kv-cache-manager` was renamed `llm-d/llm-d-kv-cache`; its KV-routing code "has moved to llm-d-router" (PR #1886). It is now under `pkg/kvcache`, `pkg/kvevents`. https://github.com/llm-d/llm-d-kv-cache/blob/main/README.md
- Practical meaning: "GIE EPP plugins" and "llm-d scheduler plugins" are now one codebase. Section 4 covers the historical GIE v1.0 design; section 3 covers the current one.

## 1. SGLang

### 1a. Legacy cache_aware (sgl-model-gateway / SMG / vllm-project/router fork)
Source: https://github.com/sgl-project/sglang/blob/main/sgl-model-gateway/src/policies/cache_aware.rs
- (a) **Prefix identification**
  - There is one approximate radix tree per model. Each node carries a set of tenants (workers).
  - It is built only from the router's own routing history. Workers send no cache state ("communication-free").
  - The HTTP path stores raw text characters "to avoid tokenization overhead". SMG also has a token tree for gRPC. https://lightseek.org/smg/concepts/architecture/high-availability
  - Trees are keyed `pool::model` (prefill/decode/regular), so the two PD legs do not evict each other.
- (b) **Trade-off formula** (in-tree code)
  - Imbalanced = `(max_load - min_load) > balance_abs_threshold && max_load > min_load * balance_rel_threshold`. `load` is the in-flight request count.
  - If imbalanced: shortest queue (random tiebreak). The tree is still updated.
  - Else, with `match_rate = matched_chars / input_chars`: if `match_rate > cache_threshold`, pick the highest-match worker; otherwise pick the min-load worker.
  - Note: the header comment says "smallest tree"; the code now uses min load.
- **Defaults** (`CacheAwareConfig::default`, https://github.com/sgl-project/sglang/blob/main/sgl-model-gateway/src/policies/mod.rs):

  | Parameter | Default |
  |---|---|
  | `cache_threshold` | 0.5 |
  | `balance_abs_threshold` | 32 |
  | `balance_rel_threshold` | 1.1 |
  | `eviction_interval_secs` | 30 |
  | `max_tree_size` | 10000 |

  - The vllm-router docs give `max_tree_size` = 2^25 characters per worker per model, and say the tree "may grow beyond it between cycles". https://github.com/vllm-project/router/blob/main/docs/load_balancing/README.md
  - Bucket policy defaults: abs=32, rel=1.0001, adjust interval 5s.
- **SMG v1.14 docs describe a newer overload rule.** A holder is overloaded when its load is > `balance-rel-threshold` × fleet **mean** and above the mean by an absolute margin. That margin "scales with pool load", capped by `balance-abs-threshold`. On a miss or overload, the request goes to the "lowest expected-wait worker among those not overloaded". https://lightseek.org/smg/concepts/routing/load-balancing
- (c) **When the cache holder is overloaded**
  - In-tree code: the cache is ignored only when the *whole fleet* is imbalanced. It does not check the specific holder.
  - SMG: the holder is excluded if it is overloaded against the mean.
- **Other SMG policies** (https://lightseek.org/smg/concepts/routing/load-balancing)
  - `consistent_hashing`
    - Key priority: `X-SMG-Target-Worker` > `X-SMG-Routing-Key` / `--routing-key-headers` > body `rid` > `X-Forwarded-For`/`Cookie` > random.
    - 150 virtual nodes per worker, one ring per model. Fails over to the next ring node.
  - `prefix_hash` (bounded-load consistent hashing on the prompt head)
    - Key: first `--prefix-token-count` tokens (example value 256), or 4× that in characters.
    - `--cache-boundaries 2048,8192` gives multi-depth keys.
    - Overloaded if `inflight > load_factor*avg AND > avg + abs`, with `--prefix-hash-balance-abs-threshold` default 10.
    - Fallback order: shallower boundary, then least-loaded non-overloaded worker, then the ring target.
  - `least_load`: `score = (queued+running+in_flight tokens)/throughput + 0.15*k/(1-k)`, where k = KV usage. Default throughput is 2000 tok/s. The router sends 503 + `Retry-After: 1` when every worker hits its waiting cap.
  - `manual`: an explicit sticky map, kept until the worker is unavailable or the key has been idle longer than `--max-idle-secs`.
- (e) **Multi-replica: yes, SMG has a mesh** (`--enable-mesh`, port 39527).
  - SWIM-style membership: probe 1 peer/s, 3 indirect probes.
  - One bidirectional gRPC stream per pair, sending updates every 1s. CRDT keys:
    - `worker:` is last-writer-wins by Lamport timestamp.
    - `td:` carries cache-tree deltas, each a hash of the prefix path plus the worker URL.
    - Repair pulls the full per-model tree in ~2 MiB pages.
  - Not shared: evictions, KV-event mode, the hash index, rate limits (so the cluster limit is ≈ N× the per-router limit), and `manual` sticky maps.
  - Dropped deltas are not resent. Mesh traffic is plaintext unless mTLS is configured. https://lightseek.org/smg/concepts/architecture/high-availability
  - The in-tree code has `apply_remote_tree_operation` / `restore_tree_state_from_mesh` (cache_aware.rs above).
- **PD** (gateway README): `--pd-disaggregation` with `--prefill-policy` / `--decode-policy` (e.g. `power_of_two`). https://github.com/sgl-project/sglang/blob/main/sgl-model-gateway/README.md
- (f) **Published benchmark** (SGLang v0.4 blog, Dec 2024): up to 1.9× throughput (82,665 → 158,596 tok/s) and cache hit rate 20% → 75% (3.8×).
  - Setup: 8×A100, Llama-3.1-8B, dp=8, `generated-shared-prefix` dataset, compared with no router.
  - The blog warns this workload is favorable ("perfectly balanced" prefix groups). https://lmsys.org/blog/2024-12-04-sglang-v0-4/

### 1b. New `sgl-router` (`--chat-routing reorg`)
Sources: https://github.com/sgl-project/sglang/blob/main/sgl-router/README.md , ARCHITECTURE.md, REFERENCE.md (same directory)
- (a) **Prefix identification: precise, event-driven.**
  - Engines publish ZMQ KV events plus load reports.
  - The router tokenizes and renders the chat itself, and forwards `input_ids` so its hashes match the engine's.
  - The router-local radix tree is keyed by block hashes. An optional external `sgl-kv-indexer` can replace it (`--cache-prefix-provider indexer --kv-indexer-endpoint`, query timeout 100ms in the example).
  - Hash scheme (https://github.com/sgl-project/sglang/blob/main/sgl-router/src/state/kv_events/hash.rs):
    - Per page of `block_size` tokens: SHA256 over (previous page's full 32-byte digest ‖ tokens as u32 little-endian).
    - Truncated to the top 64 bits as a signed i64.
    - `cache_salt` seeds the chain (`"sglang-cache-salt-v1\0"+salt`). LoRA requests are namespaced by `lora_name`. EAGLE workers use a bigram variant.
  - The legacy `--cache-threshold/--balance-abs-threshold/--balance-rel-threshold` were **removed**, as was `cache_aware_zmq`. They have "no one-to-one replacements" (REFERENCE.md "Upgrading").
- (b) **Policy split** (ARCHITECTURE.md §1.4)
  - Default `--policy power_of_two`. For prefill engines it compares a lexicographic load vector: est. prefill queue time > waiting uncached tokens > waiting reqs > running > in-flight. Decode compares waiting > running > KV usage.
  - `cache_aware`: preferred engine A = best prefix owner with ≥ `--cache-affinity-min-matched-tokens` (default **1024**) and optionally ≥ `--cache-affinity-min-match-ratio`.
  - `--affinity-mode prefer` (default): use A if A passes admission.
  - `--affinity-mode balanced`: also sample B via power-of-two. Switch only if `load(A) > load_factor*load(B)` **AND** `load(A)-load(B) > load_gap`.
    - Defaults: factor 2; gap 1024 tokens or 4 requests.
    - Load metric `--affinity-balanced-by prefill-tokens` (default) = reported waiting uncached tokens + this request's *uncached* tokens on that engine. So A's cache hit lowers its own cost.
- (c) **Overload / admission.** An engine at any per-engine cap is skipped, falling back to power-of-two among the rest. Caps:
  - `--max-inflight-requests`, `--max-waiting-requests`, `--max-pending-prefill-tokens`, `--max-running-usage`, `--max-kv-usage`.
  - Engine-reported caps lag by one report; the in-flight cap counts at dispatch time.
  - If nothing is admitted in any bucket → 503. If no bucket fits the request length → 400.
  - Retries exclude the failed engine.
- **Pending prefixes** (`--cache-pending-prefix-ttl-ms`, off by default)
  - Credits the chosen worker with the prompt prefix before KV events arrive, so fan-out bursts (RL rollouts, agents, n>1) stay together.
  - `--cache-pending-prefix-consult-below <ratio>` (0.5 suggested) consults this only when the confirmed match is shallow.
  - `--cache-pending-prefix-max-followers` caps the herd. It is charged on the deepest matched block, so a shared system prompt never trips it.
  - This idea is directly reusable for a provider-agnostic router (an optimistic, TTL-bound affinity "stake").
- (d) **Session affinity:** `session_aware`, header `--session-id-header` (default `x-session-id`).
  - It rebinds when the bound engine fails admission (src/policies_reorg/session_aware.rs).
  - The idle-timeout flag name is unverified.
  - DP-rank choice: hash of the session/routing key, then deepest cached prefix, then fewest in-flight. The hash step means "router replicas agree" (REFERENCE.md DP-rank routing).
- (e) **Replicas: "Routers are stateless: nothing is persisted or shared between replicas."**
  - Each replica rebuilds load and the KV tree from engine events. Every replica subscribes to all engines, so the state converges without gossip.
  - A new replica can copy the tree from a sibling: `--kv-peer-selector` → `/internal/kv_snapshot`. `/readyz` stays 503 until done (`--kv-bootstrap-timeout-ms` 600000).
  - KV-event gap replay uses `replay_endpoint`.
  - Session bindings are per-replica, so put an LB that is sticky on the session header in front.
- (f) Only CPU microbenchmarks so far: tree match ≈47 ns. "E2E ... tracked separately" (BENCHMARKS.md). No published hit-rate or TTFT numbers.

## 2. vLLM production-stack router (Python)
Source: https://github.com/vllm-project/production-stack/blob/main/src/vllm_router/routers/routing_logic.py
- Routing logics: `roundrobin`, `session`, `kvaware`, `loadaware`, `prefixaware`, `disaggregated_prefill`, `disaggregated_prefill_orchestrated`, `priority`.
- `session`
  - `session_key` comes from a header, or else the same-named JSON body field.
  - Sessions map to endpoints through a `uhashring` consistent-hash ring, so endpoint churn moves only ~1/N of sessions.
  - A request without a session id goes to the endpoint with the lowest QPS.
  - Because it is a ring over the same endpoint list, multiple router replicas agree with no shared state (inferred from code).
- `prefixaware`
  - Uses `HashTrie(chunk_size=128)` over **characters**. Each node is `xxh64(128-char chunk)`; each node holds a set of endpoints.
  - Chat prompt = all message `content` strings joined with `\n`. The template, roles and tools are ignored.
  - "We assume that there is no eviction of prefix cache": the trie is unbounded and never evicted. https://github.com/vllm-project/production-stack/blob/main/src/vllm_router/prefix/hashtrie.py
  - If `match_length < prefix_min_match_length` (default 0): least in-flight endpoint (random tiebreak), and the trie is still seeded.
  - Otherwise: random among the endpoints that hold the longest match.
  - (c) **No load check on the holder at all.**
- `kvaware`
  - The router tokenizes the prompt (a local HF tokenizer, falling back to remote `/tokenize`). It asks the **LMCache controller** (`LMCacheControllerManager`, hosted inside the router on ZMQ pull/reply/heartbeat ports) for `layout_info` {instance_id → (…, matched_tokens)}.
  - Picks the holder with the max matched tokens.
  - Falls back to session ring/QPS if there is no holder or `matched_tokens < len(tokens) - kv_aware_threshold` (default **2000** tokens). That means "use the cache only if the uncached tail ≤ 2000 tokens".
  - Instance id to IP is resolved lazily by querying each endpoint.
  - No load term.
- `loadaware` (subclass of kvaware)
  - `score(i) = matched_tokens(i)/prompt_tokens - beta * (load(i)-mean_load)/max(1,mean_load)`, argmax over **all** endpoints.
  - `load` = in-prefill + in-decoding requests from the router's own request stats. These stats are event-driven; the scrape-lagged engine stats are not used.
  - `beta` default 1.0 (`--loadaware-beta` or env `LOADAWARE_BETA`). beta=0 means cache-only; a large beta means least-loaded. The `kv_aware_threshold` is not applied.
  - Docs: "a warm-but-saturated instance can lose to a cold-but-idle one". https://github.com/vllm-project/production-stack/blob/main/docs/source/use_cases/loadaware-routing.rst
  - This is the cleanest normalized trade-off formula of the four systems.
- `disaggregated_prefill`
  - A request is treated as a prefill if `max_tokens==1`. It goes to the first endpoint with a prefill model label; otherwise to the first decode-labeled endpoint.
  - It is naive: always `[0]`, no load balancing.
- (e) **State:** in-process singletons (the trie and the LMCache manager). No cross-replica sync is visible in the code. Running multiple router replicas with the kvaware controller embedded is unverified/unclear.
- (f) The LMCache blog (Jan 2025) claims "3-10x lower response delay & 2-5x higher throughput" versus vLLM+KServe and a commercial endpoint, on a multi-round QA workload. Exact numbers are only in the charts. https://blog.lmcache.ai/2025-01-21-stack-release/
- **vllm-project/router (Rust, "vllm-router")** (https://github.com/vllm-project/router/blob/main/docs/load_balancing/README.md)
  - A fork in the SGLang-router lineage, with the same `cache_aware` defaults (0.5 / 32 / 1.1 / 30s / 2^25 chars).
  - `consistent_hash` key priority: `X-Session-ID` > `X-User-ID` > `X-Tenant-ID` > `X-Request-ID` > `X-Correlation-ID` > `X-Trace-ID` > body `session_params.session_id` > `session_id`.
  - Also `kv_aware`, driven by KV events (`--kv-event-source WORKER=tcp://...`, `--kv-event-block-size`); without KV info it falls back to load.
  - Has "Program scheduling" for agent workloads (the details were not explored).
- vLLM semantic-router picks a *model*; it is not a KV-aware router. Not covered here.

## 3. llm-d router (formerly llm-d-inference-scheduler; now also hosts the GIE EPP)
Base: https://github.com/llm-d/llm-d-router (plugin READMEs under `pkg/epp/framework/plugins/...`)
- **Pipeline:** request handling (parsers, data producers) → filters → weighted scorers → picker.
  - A scorer's weight defaults to 1.0. `max-score-picker` is the default picker. Each scorer output is clamped to [0,1] before weighting. https://github.com/llm-d/llm-d-router/blob/main/docs/architecture.md
- (a) **Prefix identification.** There are two producers; both write `PrefixCacheMatchInfo{MatchBlocks, TotalBlocks, BlockSizeTokens, ConfirmedCachedBlockCount, CachedBlocksByTier}`.
  - `approx-prefix-cache-producer` (https://github.com/llm-d/llm-d-router/blob/main/pkg/epp/framework/plugins/requesthandling/dataproducer/approximateprefix/README.md)
    - Hashes `TokenizedPrompt` into chained blocks and keeps a per-pod LRU of blocks it *routed* there.
    - Defaults: `blockSizeTokens` 64 (min 64), `lruCapacityPerServer` 31250, `maxPrefixTokensToMatch` 131072, `autoTune` true (infers block size and capacity from engine metrics).
    - Tokens come from `token-producer`. The default `estimate` backend is tokenizer-free byte packing, about 4 bytes/token, so its "token IDs do not correspond to engine tokens". The `vllm` backend calls `/render`. https://github.com/llm-d/llm-d-router/blob/main/pkg/epp/framework/plugins/requesthandling/dataproducer/tokenizer/README.md
    - The older char-based `blockSize` parameter is deprecated.
  - `precise-prefix-cache-producer` (https://github.com/llm-d/llm-d-router/blob/main/pkg/epp/framework/plugins/requesthandling/dataproducer/preciseprefixcache/README.md)
    - Subscribes per pod to vLLM/SGLang **ZMQ KV events** (BlockStored/BlockRemoved/AllCleared) and keeps a `kvblock.Index` (block key → {pod, device tier}).
    - Backends: in-memory LRU, cost-aware memory, or **Redis** (shared across replicas). https://github.com/llm-d/llm-d-router/blob/main/pkg/kvcache/kvblock/README.md
    - Removals are reference-counted and deduplicated. https://github.com/llm-d/llm-d-router/blob/main/pkg/kvevents/README.md
    - `speculativeIndexing` (default false, `speculativeTTL` 2s) seeds the chosen pod before events arrive (the same idea as SGLang pending prefixes).
    - Experimental snapshot warm-up for joins and restarts needs vllm#57789.
  - **Block hash** (https://github.com/llm-d/llm-d-router/blob/main/pkg/kvcache/kvblock/token_processor.go)
    - Default block size 16 tokens ("default value used by vLLM").
    - Default algorithm `cbor-fnv`: FNV-64a over canonical CBOR of `[parent, tokens, extra]`. Optional `xxh64`.
    - `HashSeed`: the code comment says "should be aligned with vLLM's PYTHONHASHSEED".
    - **But the current README says** the EPP recomputes keys from the `token_ids` in events *and* from requests. Engine hashes are only opaque keys, so "`blockSizeTokens`/`hashSeed` need not match the engine".
    - What still must match: the engine must emit `token_ids` plus `extra_keys` (multimodal ids, `cache_salt`). vLLM does. SGLang does not emit `extra_keys`, so salted requests miss.
    - Precise mode needs real tokens, i.e. the `vllm` token-producer.
- (b) **Scorers** (formulas and defaults from each README):

  | Scorer | Formula | Defaults |
  |---|---|---|
  | `prefix-cache-scorer` | `w*min(1,matchedTokens/scale)^2 + (1-w)*matchBlocks/totalBlocks` | `matchLengthWeight` w=0, scale 8192 (tune to P95 prompt length). The square reflects quadratic attention cost. |
  | `queue-scorer` | `(maxQ - q)/(maxQ - minQ)` | 1.0 if all equal |
  | `kv-cache-utilization-scorer` | `1 - kvUsage` | — |
  | `load-aware-scorer` | 0.5 at an empty queue, linear to 0 at `threshold` | threshold 128; max is 0.5 by design |
  | `active-request-scorer` | 1.0 at or below `idleThreshold`, then scaled into [0, `maxBusyScore`] | — |
  | `token-load-scorer` | `1 - min(1, inflightTokens/queueThresholdTokens)` | — |
  | `no-hit-lru-scorer` | Spreads *cold* (zero-hit) requests LRU-wise to even out cache growth | example `lruSize` 1024 |
  | `session-affinity-scorer` | See (d) | — |

- **Recommended composition** ("optimized-baseline")
  - `prefix-cache-affinity-filter` + one load scorer (`token-load-scorer` for prefill-bound, `active-request-scorer` for decode-bound) + max-score picker, with **no separately weighted prefix scorer**.
  - Reason: the weighted sum bounds how far a load scorer can move a request (≤ loadWeightSum/prefixWeight in score difference). https://github.com/llm-d/llm-d/blob/main/guides/optimized-baseline/README.md
- (c) **Hot-spot handling: `prefix-cache-affinity-filter`** (https://github.com/llm-d/llm-d-router/blob/main/pkg/epp/framework/plugins/scheduling/filter/prefixcacheaffinity/README.md)
  - Keeps only endpoints with prefix score ≥ `affinityThreshold` (0.80). If none qualify, it keeps all.
  - With probability `explorationProbability` (0) it skips the gate.
  - **TTFT load gate:** if the best sticky endpoint's estimated TTFT exceeds the best non-sticky one by more than `maxTTFTPenaltyMs` (18000), it breaks stickiness and keeps all.
    - TTFT estimate = `inFlightTokens/peakPrefillThroughput*1000`, with `peakPrefillThroughput` 15928 tok/s calibrated for Qwen3-32B on H100 TP2. Alternatively it comes from the latency predictor.
  - The recommended load scorers count *uncached* tokens, so cache warmth stays priced in after a break.
  - **Saturation:** `utilization-detector` is the default and is auto-appended as a filter.
    - `EndpointScore = max(queue/5, kv/0.8)` (`queueDepthThreshold` 5, `kvCacheUtilThreshold` 0.8, `headroom` 0).
    - It drops endpoints with metrics staler than 200ms, or with queue ≥5, or KV ≥0.8. If that would drop all, it keeps all.
    - Pool saturation = the average of endpoint scores. It drives flow control (off by default, `featureGates: [flowControl]`) and applies proportional backpressure.
    - Stale metrics count as saturated by default. https://github.com/llm-d/llm-d-router/blob/main/pkg/epp/framework/plugins/flowcontrol/saturationdetector/utilization/README.md , architecture.md
- (d) **Session affinity:** `session-affinity-scorer`, two strategies.
  - `encoded_endpoint_header`: header `x-session-token` carries a base64 pod token round-tripped via the response.
  - `session_id`: sources default to header `x-session-id`; `evictionTtlSeconds` 300, sweep 10s.
  - The highest score goes to the previous pod; all others get 0.
- (e) **Replicas** (https://github.com/llm-d/llm-d-router/blob/main/docs/operations.md)
  - Active-passive mode: leader election or priority routing.
  - Active-active mode: "EPP replicas do not share routing state by default".
  - Without sync, the approx producer learns only from its own traffic, so the hit rate drops.
  - Alpha `redis-syncer` (Redis ≥7.4, `stateTTL` 2s, eventually consistent)
    - Shares in-flight load.
    - With `syncCrossReplicaState=true` (default) it also shares a capped recent window of per-endpoint prefix block hashes (`maxSyncedTokens` 2,000,000). This is not full LRU replication.
  - Flow-control queues and fairness are per replica.
  - Precise mode: each replica subscribes to the events independently, or uses the shared Redis index.
- **Multi-cluster** variants exist (`multicluster-prefix-cache-scorer`, `multicluster-approx-prefix-cache-producer` with 64-token blocks, queue/KV scorers on pool-aggregate metrics). They home a prefix to a *cluster*. This is the closest analogue to "route across endpoints you don't control".
- (f) **llm-d blog** (8 vLLM pods, 16×H100, Qwen-32B, 150 tenants × 6000-token shared prefix, 3→60 QPS) https://llm-d.ai/blog/kvcache-wins-you-can-see

  | Scheduler | TTFT P90 | Throughput |
  |---|---|---|
  | precise | 0.542 s | 8,730 tok/s |
  | approximate | 31.08 s | 6,944 tok/s |
  | load-only | 94.9 s | 4,429 tok/s |
  | random | 92.6 s | 4,429 tok/s |

  - That is roughly 57× better P90 TTFT than approximate and 25% more throughput.
  - The workload is deliberately sized at ~6× one pod's KV capacity (73% of the cluster's), so it favors precise mode.
  - The index needs about 8 bytes per block.

## 4. Kubernetes Gateway API Inference Extension (GIE)
- **APIs**
  - `InferencePool` (`inference.networking.k8s.io/v1`, GA v1.0): a pod selector plus `endpointPickerRef` (optional since v1.5) with `failureMode: FailOpen|FailClose`. FailOpen lets the gateway pick a pod itself when the EPP is down. https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/site-src/api-types/inferencepool.md
  - InferenceModel was renamed and slimmed to `InferenceObjective`, a per-request objective that keeps criticality/priority (proposal 1199). https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/docs/proposals/1199-inferencemodel-api-evolution/README.md
  - The model-name rewrite became `InferenceModelRewrite`.
- **EPP protocol:** Envoy ext_proc. The EPP sets the destination endpoint header (`x-gateway-destination-endpoint`, with multiple fallbacks since v0.4). The data plane may pass a candidate subset via metadata `envoy.lb.subset_hint` → `x-gateway-destination-endpoint-subset`. https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/docs/proposals/004-endpoint-picker-protocol/README.md
  - This is a clean "router proposes, proxy disposes" contract that is reusable across providers.
- (a) **Historical prefix plugin**, design proposal 0602 and v1.0 code (https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/main/docs/proposals/0602-prefix-cache-aware-routing-proposal/README.md , https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/release-1.0/pkg/epp/scheduling/framework/plugins/multi/prefix/plugin.go)
  - **No tokenization.** The prompt bytes are split into `hashBlockSize`=**64 bytes** (≈16 tokens at 4 chars/token, matching vLLM's 16-token block).
  - `hash(0)=hash(model name)`; `hash(i)=xxhash(block_i ‖ hash(i-1))`, so it is LoRA/model-aware. It uses `request.Prompt`, i.e. the prompt as parsed from the body.
  - `maxPrefixBlocksToMatch` 256 (≈16K chars ≈ 4K tokens). `lruCapacityPerServer` 31250, sized as `(HBM-weights)/kv_bytes_per_token * chars_per_token / block_size`.
    - Worked example: Llama3-8B on H100 → 500k tokens → 31250 blocks.
  - The EPP index should be "as close as possible to the HBM cache size": too small means false misses, too large means false hits. https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/release-1.0/site-src/guides/epp-configuration/prefix-aware.md
  - Alternatives the proposal considered: session affinity; prefix consistent hashing (KubeAI CHWBL with `prefixCharLength`, production-stack simhash — "mixed results"); engine-reported indexes.
- (b) **v1.0 default profile:** `queue-scorer` + `kv-cache-utilization-scorer` + `prefix-cache-scorer`, all with weight 1 (the omitted-weight default), and `max-score-picker`. https://github.com/kubernetes-sigs/gateway-api-inference-extension/blob/release-1.0/config/charts/inferencepool/templates/epp-config.yaml , config-text.md
  - Prefix score = matched blocks / total blocks. The load terms are min-max queue and 1-KV.
  - (c) There is no explicit holder-overload rule. It relies on additive scores plus the saturation detector / flow control (now in llm-d, §3).
- (e) Each EPP replica had its own in-memory LRU. The proposal admits that "cache hit performance decreases with multiple active EPP replicas" and that state is lost on restart.
  - Suggested mitigation: when there is no match, use consistent hashing so that independent EPPs pick the same pod.
  - HA was via leader election (active-passive). Later: the Redis syncer in llm-d (§3e).
- (f) The K8s blog (2025-06-05) gives only qualitative results: throughput on par with a k8s Service, lower p90 latency at 400–1000 QPS. Setup: 10 Llama2 vLLM replicas on H100, ShareGPT. No prefix-specific numbers. https://kubernetes.io/blog/2025/06/05/introducing-gateway-api-inference-extension/

## 5. Cross-cutting takeaways for a router that cannot see backend KV state
1. **Two families.**
   - Approximate: the router's own routing history (char/byte or estimated-token block chains, or a radix tree with LRU sized to the backend KV). This is the only option across providers.
   - Precise: ZMQ KV events. The benchmark gap (57× P90 TTFT in llm-d's favorable test) shows how much an approximate index can drift under KV pressure.
2. **Hash design consensus:** a chained block hash (`h_i = H(block_i, h_{i-1})`, seeded by model/LoRA/salt). Block ≈ 16 tokens or 64 bytes. Cap the depth (4K–128K tokens). Hash the *rendered* prompt if possible: production-stack ignores templates; SGLang renders.
3. **Trade-off patterns, with defaults**
   - Global imbalance gate: SGLang legacy, 32 / 1.1 / threshold 0.5.
   - Holder vs mean bounded load: SMG, `prefix_hash` with abs 10.
   - Pairwise A vs B with factor 2 AND gap 1024 tokens: sgl-router "balanced".
   - Normalized `hit_frac - beta*rel_load`: production-stack, beta 1.
   - Sticky-set filter + TTFT-penalty breaker (18 s): llm-d.
   - Pricing load in uncached tokens: sgl-router and llm-d. This makes the cache hit and the load commensurable, which is the most principled approach.
4. **Cold-burst problem:** pending/speculative stakes with a short TTL (sgl-router pending prefixes; llm-d `speculativeTTL` 2s) plus a follower cap.
5. **Session affinity** is everywhere, via a header (`x-session-id` is common) and consistent hashing (150 vnodes in SMG; uhashring in production-stack). It is per-replica unless it is hashing-based. Hashing is the only zero-sync way for router replicas to agree.
6. **Multi-replica**
   - SGLang new: stateless, rebuilt from events, with peer bootstrap.
   - SMG: SWIM + CRDT gossip of tree deltas, best-effort.
   - llm-d: Redis syncer for a recent window plus load; eventually consistent.
   - production-stack and GIE v1: no sync.
   - Rate limits and fairness queues are per-replica in SMG and llm-d.
