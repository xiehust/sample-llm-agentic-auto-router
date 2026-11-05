# B 报告的 Exa 补充：遗漏的路由器、工程博客与 2026 论文

> 检索日期 2026-11-04，工具为 Exa web search/fetch。只收录实际打开或在搜索摘要里看到原文的条目，每条都附 URL。标 "unverified" 的是推断，或只见到二手来源。
> 与 B-router-landscape.md 第 0–1 节重复的条目（OpenRouter、LiteLLM、Azure、Bedrock、Portkey、Kong、Cloudflare、vLLM-SR SAAR、Neural Router、Copilot、Cursor、Claude Code、Whose-turn、TurnCost、Harness Tokenomics、Unified AI Gateway 等）不再展开，只写增量。

---

## 1. 新增产品对比表

### 1.1 网关 / 路由服务

| 产品 | 决策粒度 | 信号 | 缓存感知 | 多轮 / tool | 开源 | 形态 |
|---|---|---|---|---|---|---|
| **Vercel AI Gateway — Session Affinity** | 每请求选 provider；模型由调用方选，或走 model fallbacks | 会话 ID 按优先级取：`sessionId` > `x-session-id` > `x-session-affinity` > `prompt_cache_key` > `x-claude-code-session-id` > 指纹。指纹 = SHA-256(首条 system + 首条非 system 消息 + 工具集合，与工具顺序无关，再加 team ID) | **sticky，按模型分别 pin，默认开启**。每个会话最多同时保留 **8 个模型**各自的 pin，所以「切走再切回」时能回到仍持有旧模型缓存的 provider。pin 寿命 = provider 缓存 TTL − 15s：OpenAI/Azure 10 分钟，DeepSeek 1 小时，其余 5 分钟；跟随 1h/24h TTL，但上限 1 小时。显式 session ID 时 pin 到具体**凭证**（每个账号的缓存相互独立）。prompt 低于可缓存最小长度时不 pin。响应里带 `affinity.outcome`（promoted/confirmed/no_pin/pin_expired/…）。`x-session-affinity` 会转发给上游 provider，供其做集群路由 | 指纹「不受后续轮次影响」，同一会话稳定。`caching:'auto'` 自动给 Anthropic/MiniMax/Alibaba 打两个断点：最后一条消息，以及最后一条 user 之前的那条 | 否 | 托管网关 |
| **Requesty Auto Routing**（2026-10-27） | **每会话一次**：只在首个请求做决策 | 用户自写 question + 若干 route label；decision model **只读第一条 user 消息**（不看 system、后续轮、tool result），返回每个 label 的概率，过阈值才采用，否则走 fallback | **sticky（会话级硬 pin）**：按 `trace_id`（或会话本身）pin 60 分钟，会话内不再切换，官方理由是 "prompt caches keep working"。另有 `auto_cache` 自动为 Anthropic 加断点 | 后续轮次和 tool loop 跳过分类器 | 否 | 托管网关 |
| **Bifrost**（Maxim） | 每请求选 provider 和 key | 企业版 Adaptive Routing：每 5 秒按错误率（时间衰减）、token 感知延迟、TPM 命中重算权重，带 healthy/degraded/recovering/failed 状态机 | **sticky（key 级）**：v1.4.12（2026-03）加入 key 选择的 session stickiness；session affinity 在 adaptive routing **之后**执行，不会把会话留在被判故障的 key 上 | 不涉及内容 | 核心 OSS，adaptive routing 为企业版 | Go 网关 |
| **TensorZero** | 每个 **episode** 一个 variant | 静态权重或自适应 A/B（track-and-stop 最优臂识别），依据反馈指标 | **episode 级一致**："multiple inference requests to the same function will receive the same variant (unless fallbacks are necessary)"。设计目的是实验的统计有效性，但客观上等于会话 pin | 一个 episode 对应一个多步工作流；fallback 导致 variant 混用的 episode 会被排除出实验 | 是 | 自托管网关 |
| **agentgateway**（Linux Foundation，kgateway 生态） | 每请求 | 虚拟模型：failover 优先级组，组内按健康和延迟做 P2C；也支持 weighted/conditional | **只做 marker，不做 pin**：`promptCaching` 策略自动打 Anthropic/Bedrock 断点（system、上一条消息，`cacheTools` 默认关）。跨模型路由时不感知缓存（据文档推断） | 未描述 | 是 | 网关（k8s + standalone） |
| **Envoy AI Gateway / "Envoy Agent Router"**（2026-06-23 发布 v1.0 GA） | Tier-1 按模型名，Tier-2 按副本 | `model` 字段；Tier-2 通过 Inference Extension EPP 看 KV 利用率、队列、前缀亲和、LoRA | **副本级 prefix-aware**；跨模型无。提供统一的 `cache_control` API | — | 是 | Envoy 网关 |
| **Higress** `ai-load-balancer` | 每请求选 endpoint / cluster | `prefix_cache`（Redis 记录前缀到 pod 的映射，TTL 1800s）、global least-request、endpoint metrics、`cluster_hash`（按请求头做一致性 hash） | **副本级 prefix 亲和 + 头部 hash 可做会话 pin**；跨模型无 | — | 是 | Wasm 插件 |
| **Helicone AI Gateway** | 每请求选 provider | 默认选最便宜的 provider，同价负载均衡；429/401/400/408/5xx 时 failover | **none（跨模型）**。`prompt_cache_key` 映射为 Anthropic `user_id`；不支持 tools 缓存（文档自述） | 未涉及 | 是 | 网关 |
| **Plano**（原 archgw，Katanemo） | 每请求 / 每 turn | Plano-Orchestrator（Arch-Router 的后继），按 domain-action 偏好映射模型；模型列表第一个为主，其余在 429/5xx 时 fallback | **none**（文档未提及缓存） | 依据 Arch-Router 论文，读对话历史 | 是 | 代理 / dataplane |
| **Arcee Conductor** `auto` | 每 prompt | 150M 分类器（task type / domain / complexity 1–10 / language），约 150ms | none | 未涉及 | 否 | 托管 API |
| **Unify** | 每 prompt | BERT 类神经打分（质量），加上实时成本、TTFT、ITL 的线性加权 | none（2024 资料，2025–26 现状 unverified） | — | 否 | 托管 |
| **NVIDIA NeMo Switchyard**（修正：报告中原标 unverified） | 每请求，可开 sticky | LLM 分类器路由 | **opt-in sticky**：键 = hash(system + 首条 user)，无需 session ID；`affinity_warmup_turns: N` 让前 N 轮不 pin；低置信或弃权的结果**不 pin**；pin 存在进程内 LRU，不跨 worker 共享；harness 若在前缀里插入每轮变化的内容，会自动退化为逐轮路由 | 设计面向 agent harness | 是 | 路由服务 |

### 1.2 Agent / 编码产品内置路由（报告 1.2 节遗漏或需要更新的）

| 产品 | 决策粒度 | 信号 | 缓存感知 | 多轮 / tool / 子 agent | 开源 | 形态 |
|---|---|---|---|---|---|---|
| **Factory Router**（Droid，`model:"auto"`；2026-08 生产上线） | **在 harness 里每 turn 决策**（SDK 说明 "the selected model can change between turns"）；子 agent 和 review job 各自选模型 | 会话历史、**缓存状态**、tool 结果、任务状态（是否卡住、剩余工作量）、测试/产物结果；router 同时选 reasoning effort | **cost-modeled（在 harness 内）**："Only the harness can judge when a model switch is worth the cache miss"；"Staying put is itself a routing decision"。Prisma 案例 67 轮全程留在 frontier（节省 0%），因为 "never offered a safe place to step down" | 子 agent 拿短规格说明、不带父会话缓存，父会话保持温热；validator 默认用与 implementer **不同家族**的模型 | 否 | SaaS / CLI |
| **Augment Prism**（2026-05-02） | **每 user turn**（planner 小模型） | 请求内容 / 复杂度；可选模型池为固定组合（Opus 4.7 / Sonnet 4.6 / Gemini Flash 3.0，或 GPT 5.5 / 5.4 / Kimi K2.6） | **cost-modeled（定性描述）**："switch only when the expected win … exceeds the cost of the cache eviction"；进行中的 turn 不改判；决策在 tool-call 跟进轮之间 sticky；切换时 "manage the context handed to the new model" | planner 只在约 4% 的 turn 触发，其余 96% 是 tool-result 跟进轮，复用决策；p50 2.6s | 否 | IDE / CLI |
| **Replit Intelligent Model Routing**（2026-08-26） + "Free the models" harness（2026-09-29） | 按任务；核心 loop **自己**为每次子 agent 派发选 tier（small/standard/large）和 effort | 由模型自身判断；逐步的 effort 升级系统 | 可复用子 agent 保持温热（"any number of subagents stay warm"），依赖 OpenAI 新模型更长的缓存寿命；"Effort … changes mid-turn without a cache miss"（OpenAI `configuration_update`）。称 router "will always be less capable than the model it's choosing for" | 声称在 DeepSWE、Terminal-Bench 上比 sidekick 架构高 11 和 16 分（厂商自测） | 否 | SaaS |
| **Cognition Devin Fusion**（更新：报告原写「缓存未文档化」） | lead + sidekick 两个常驻 agent；运行中用轻量分类器发出「转回 lead / 换模型」信号 | 任务类型、复杂度、运行中信号 | **在 compaction 时切换**："We accomplish this by switching the model during context compaction, which would trigger a cache miss anyway … effectively getting model switching 'for free'"；两个 agent 各自保有持久缓存，只交换 brief 和结果 | 明确批评 "Smart Friend"/Advisor 式咨询："context … is not shared in a way that is cached" | 否 | 桌面 / CLI |
| **Anthropic Advisor tool**（`advisor_20260301`） | executor 模型自己决定何时调用 | 由模型判断（常见时机：动手前、反复报错时、宣布完成前） | advisor 读取 executor 的**完整转录**作为引用上下文；提供可选的 `caching` 参数，为 advisor 自己的转录跨调用缓存（细节 unverified）。Claude Code 版只能走 Anthropic API，不支持 Bedrock/Vertex/Foundry | 在单次 `/v1/messages` 内由服务端完成 | 否 | 服务端工具 |
| **Amp**（Sourcegraph） | 按 mode（low/medium/high/ultra）；子 agent | 用户选 mode | 子 agent 默认用与线程**相同**的模型和 effort；oracle/librarian/finder 改为插件后才能单独设模型（推断：有利于缓存一致） | `rush`（Haiku 4.5）的结论："on complex tasks it often spends more tokens"，复杂重构只便宜 19% 却慢 2 倍 | 否 | CLI / IDE |
| **claude-code-router**（musistudio，CCR） | 每请求，按场景分槽 | `default` / `background`（识别 Haiku 类后台请求）/ `think`（plan/thinking）/ `longContext`（tiktoken 计数，超过 `longContextThreshold` 默认 60K）/ `webSearch` / `image`；`CUSTOM_ROUTER_PATH` 可挂自定义 JS；子 agent 通过 prompt 内的 `<CCR-SUBAGENT-MODEL>` 标签指定模型 | **none**。推断：会话一旦越过 longContext 阈值，就在会话中途换模型并冷 prefill；think 与 default 交替也会碎片化缓存（unverified，文档没有讨论缓存） | 子 agent 标签机制天然是「在新上下文边界换模型」；CCR 会改写 Agent/Task 工具描述 | 是 | 本地代理（现为 Desktop 控制面） |
| **OpenCode** | 按 agent（primary/subagent 各自 `model`）；`small_model` 负责标题等 | 配置 | `setCacheKey`。**注意坑**：子 agent 沿用父会话 ID 作为 prompt cache key 和 `x-session-affinity`（#51923，目的是落到同一 provider 路由）。同模型并行的父/子 agent 因此被报告互相驱逐缓存（issue #61318，2026-11-03，未确认） | 子 agent 是新上下文 | 是 | CLI |
| **Crush**（Charm） | 按角色：large = coder，small = task 子 agent 和摘要 | 配置 | 未文档化 | task 子 agent 默认用 small 模型（PR #914） | 是 | CLI |
| **Zed Agent** | 按 profile / 子 agent / 辅助功能 | 配置：`subagent_model`、`thread_summary_model`、`compaction_model`、`commit_message_model` | 未文档化。推断：单独设置 `compaction_model` 会丢掉 Claude Code 那种「cache-safe fork」式压缩的缓存收益 | 显式设置的子 agent 模型不跟随父线程后来的改动 | 是 | 编辑器 |
| **Goose lead/worker** | 前 N 轮（默认 3）用 lead，之后切 worker；worker 连续失败 2 次就回退到 lead 跑 2 轮 | 轮数、失败计数 | none（每次切换都是冷 prefill） | **已在 PR #7989 中整体删除** | 是 | CLI |

---

## 2. 工程博客关键论断（原文引用）

1. **Anthropic《Lessons from building Claude Code: Prompt caching is everything》**（Thariq Shafi；镜像注明 2026-04-30，二手转述最早 2026-02）
   - "we run alerts on our prompt cache hit rate and declare SEVs if they're too low."
   - "if you're 100k tokens into a conversation with Opus … it would actually be more expensive to switch to Haiku than to have Opus answer."
   - "If you need to switch models, the best way to do it is with subagents … prepare a 'hand-off' message."
   - Plan Mode 不换工具集，而是做成 `EnterPlanMode`/`ExitPlanMode` 两个工具。工具用 `defer_loading` 存根，不删除。compaction 用 "cache-safe forking"。
   - https://github.com/RobGruhl/anthropic-docs-mirror/blob/main/claude-blog/lessons-from-building-claude-code-prompt-caching-is-everything.md
2. **Manus《Context Engineering for AI Agents》**
   - "KV-cache hit rate is the single most important metric for a production-stage AI agent."
   - 输入输出比约 100:1；"Mask, Don't Remove"（用 logit masking 代替动态增删工具）；自托管时要 "using techniques like session IDs to route requests consistently across distributed workers"。
   - https://www.manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
3. **Factory《Why model routing must be in the harness》**（2026-08-24）
   - 相对 always-frontier，总成本 −58%；会话中位数 −76%；turn 延迟中位数从 81s 降到 49s；TB2 达到 frontier 通过率的 99%。
   - **cache-blind 量化**："the modeled fully uncached cost exceeds an all-frontier single-model baseline by turns 6–20, then reaches 2.12 times … at turns 61–150 and 2.37 times at turns 151–200. Actual cache-aware routing remains between 0.19 and 0.28 times."
   - "The same switch can be cheap at turn five and expensive at turn ninety."
   - "switching families can also discard encrypted reasoning content."
   - Missions：中位数 423 轮、10 个会话，节省 37.8%。
   - https://factory.com/news/model-routing-belongs-in-the-harness
   - 姊妹篇（2026-09-24）："Treat switching as a decision tied to the current request and remaining work, rather than a permanent rule that one model is cheaper for one task label." 文档现报 −63%。https://factory.com/articles/cache-aware-model-routing
4. **Factory Droid 1.0**（二手转述，unverified）："typical request reads 98% of its input from cache, and 98.6% of requests are strictly append-only"；有一个监控器逐请求 diff，指出是什么破坏了缓存。新发现的工具**追加在请求末尾**。https://www.harelasaf.com/articles/factory-droid-1-0-programmatic-tool-calling-prompt-cache
5. **Cognition《Devin Fusion》**（2026-06-29）与《Fusion in Devin Desktop & CLI》（2026-09-11）
   - "switching the model during context compaction, which would trigger a cache miss anyway … model switching 'for free'"
   - "you break prompt caches by switching models mid-task, incurring $$$ for frontier models and defeating the purpose of routing."
   - https://cognition.com/blog/devin-fusion ，https://cognition.com/blog/local-fusion
6. **Augment《Introducing Prism》**（2026-05-02）
   - "the top 10% of user turns consumed about 57% of all LLM rounds."
   - "A naive router that re-routes every turn would burn most of its potential savings on cache misses."
   - "A 'cheaper' model isn't cheaper if it grinds for twice as many turns."（Prism Claude+Gemini 在 TB2 上反而比 Opus 4.7 贵）
   - https://www.augmentcode.com/blog/augment-prism-model-routing-to-reduce-cost-and-maintain-quality
7. **Replit《Free the models》**（2026-09-29）
   - "a router will always be less capable than the model it's choosing for. Replit Agent lets the model decide instead."
   - "Effort is set step by step and, on the latest models, changes mid-turn without a cache miss."
   - https://replit.com/blog/free-the-models
8. **OpenAI Prompt Caching 201 cookbook 与 cache diagnostics**
   - 路由按 "a hash of the first ~256 tokens"，每个 prefix+key 约 15 RPM。`prompt_cache_key` 使某客户命中率从 60% 升到 87%。Responses API 比 Chat Completions 缓存利用率高 40–80%（因为保留了推理 token）。
   - **GPT-5.6 起自动做缓存路由，不再需要 key**。
   - diagnostics 的 miss 原因枚举里有 `model_changed`（"because routing, an A/B test, or a fallback selected another model"）、`reasoning_effort_changed`（GPT-6+ 可以用 `configuration_update` 避免）、`tools_changed`、`context_compacted`。
   - https://developers.openai.com/cookbook/examples/prompt_caching_201 ，https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
9. **evanto《LLM Routers Compared – Measured》**（2026-10-30，第三方实测）
   - Cortecs、EU Router、Requesty、OpenRouter 四家：不带 `cache_control` 时 Claude **0/4** 命中，带上后 4/4。
   - "caching isn't a property of the model but of the path"。Cortecs 默认落到不缓存的 Vertex。同一 prompt 在不同上游计出的 token 数不同（5,426 vs 7,238）。
   - https://evanto.de/en/blog/llm-routers-compared
10. **TDS《The Hidden Cost of LLM Routing》**（2026-10-20，vLLM 单机实验，作者自测）
    - 20 轮会话：per-request 交替路由的重算 token 是 sticky 的 1.9 倍。
    - 按价目折算：gateway 交替只省 13%（理论值 40%），phase 边界切换省 29%；cache-blind frontier 是基线的 4.88 倍。
    - 引用 Copilot trace（2608.00101）：换模型后缓存复用降到 8%，约 6.4% 的会话会换模型，多数因为报错或限流。
    - https://towardsdatascience.com/the-hidden-cost-of-llm-routing-why-switching-models-costs-more/

---

## 3. 新论文（不在已知列表中）

| 论文 | 一句话 | 与本设计的关系 |
|---|---|---|
| **When Caching Meets Routing**（M. Kaminski，价格取自 2026-09-28；个人 PDF，非 arXiv）https://www.michael-kaminski.io/docs/papers/when-caching-meets-routing.pdf | 逐 turn 缓存感知模拟器（12 轮语音 agent）。逐 turn 路由 Opus 5.5→Haiku 4.5：naive 模型算出省 51.3%，计入缓存后只省 9.2%。Opus→Sonnet 5.5 **反而贵 15.5%**，因为两者 cache-read 价同为 $0.20/MTok。600 个场景的中位数节省 6.5%，16.2% 的场景亏钱 | 提出 **"cache fragmentation"** 机制：模型闲置期间追加的 token 回来时必须按 1.25× 重写。设计规则是 "route at cache granularity"。sticky escalation 会让 77.9% 的 turn 漂到 frontier |
| **MTRouter**（2604.23530，2026-04）https://arxiv.org/abs/2604.23530 | 用历史-模型联合 embedding 加离线结果估计器，做预算约束下的逐 turn 路由。ScienceWorld 上超过 GPT-5 且成本 −58.7% | 正文讨论切换导致缓存丢失；声称比 Router-R1 「切换更少」。没有显式成本模型 |
| **RIVET**（2610.23239，2026-10）https://arxiv.org/abs/2610.23239 | 多轮逐 turn 路由；训练时用事后响应作为特权信息，部署时只看调用前信息。MINT 上调用成本 −74.7% | 有利于离线训练 turn 级价值估计器；缓存未建模（据摘要） |
| **CacheLink**（2610.15509，2026-10）https://arxiv.org/abs/2610.15509 | 跨模型「零 prefill」KV 传输，指出 "reconstruction fidelity is a poor proxy" | 与 KV-Lingo 等同类，**只适用于自托管开源权重** |
| **Workload-Router-Pool 愿景论文**（2603.21354，vLLM-SR 团队，2026-03）https://arxiv.org/abs/2603.21354 | 把 vLLM-SR 一系列工作归纳为 W×R×P 矩阵，提出 21 个方向（含 warm vs cold workload） | SAAR 的理论背景 |
| SMetric（2607.08565）https://pubdb.com/paper/2607.08565 ；TOPAS（2608.25523）https://arxiv.science/abs/2608.25523 | 副本级：会话首请求按负载均衡、后续请求按缓存亲和（agent trace 里 KV 复用 >80%）；多 agent 前缀驻留调度 | 只涉及副本 / 调度层，可放进 C 报告 |
| The Harness Effect（2607.06906）、CacheWise（2606.16824） | 经 TDS 文章转引，**未直接核实** | — |

---

## 4. 这些发现对报告的影响

1. **「主流产品只做 sticky」需要细化成三档**：
   - 会话级一次决策后硬 pin：Requesty、Switchyard、TensorZero episode。
   - **按模型分别 pin、允许往返**：Vercel 每会话最多 8 个模型的 pin，TTL 对齐到 provider 缓存寿命。这是 LiteLLM 「切回仍热」数据在产品层面的直接落地，可作为我们「每模型分别维护缓存状态」的参考实现。
   - harness 内 cost-modeled：Factory、Augment Prism、Cognition（在 compaction 时切）。
2. **新增「harness 内路由」阵营，且有生产数据**。Factory（−58/−63%，cache-blind 达 2.1–2.4×）、Augment（turn 级加缓存门控）、Replit（由模型自己选子 agent tier）、Cognition（compaction 边界）。这几家都认为**网关拿不到任务状态**，Factory 还给出理由：请求的工具接口和指令是按目标模型构造的，网关事后替换模型会导致接口错配。这对「agent 和模型之间的网关」定位是直接挑战，报告应给出回应：
   - 要求 agent 透传任务状态信号，如 session ID、轮次、失败计数、compaction 和子 agent 边界；
   - 或把 router 做成 harness 可调用的「建议 API」，而不是事后改写请求。
3. **P2「在缓存边界切换」获得第二个公开实现**：Cognition 明确在 compaction 时切模型。OpenAI diagnostics 把 `context_compacted` 列为独立的 miss 原因，佐证 compaction 本来就是一次 miss，所以是零额外成本的切换点。
4. **新增强反例**：Kaminski 论文和 TDS 实验都量化了逐 turn 路由在缓存下的「节省蒸发」（51%→9%，40%→13%）。另外，同 cache-read 价的「便宜」模型可能净亏，说明比较应基于有效价格。建议在 P3 中加入 **fragmentation（回切重写）项**，并要求 router 用**有效价格**比较。
5. **会话键设计有新的坑**：
   - OpenCode 让子 agent 继承父会话的 cache key，同模型并行时疑似互相驱逐缓存；
   - Vercel 和 Switchyard 的指纹都基于「system + 首条 user (+ tools)」，模板化的首条消息会让不同会话撞键。

   结论：router 的会话 ID 要区分 lineage，即父会话、fork、子 agent 各自独立。
6. **effort 切换不再必然 miss**。OpenAI GPT-6+ 的 `configuration_update`、Replit 的逐步调 effort 都说明，「换 effort」在部分模型上已是免费动作。router 的动作空间应把「同模型调 effort」排在「换模型」之前。
7. **路由路径本身决定缓存**（evanto）：同一模型经不同上游可能完全不缓存，计费 token 也不同。provider 层的 pin 和上游可观测性（响应头）是前提条件，不是可选优化。
8. **小修正**：NVIDIA Switchyard 的状态从 unverified 改为已核实（有 sticky、warmup 轮、低置信不 pin）；Goose lead/worker 已被删除；Devin Fusion 的缓存策略已有文档（在 compaction 时切）。

---

## 5. 未找到 / 未深入

- **Glide**、**Continue**、**RouteLLM 的直接后继**：没检索到 2025–26 年与缓存或会话路由相关的新内容，未收录。
- **Kgateway** 的 LLM 能力即 agentgateway，已并入上表。
- **Not Diamond 的竞品**：Unify、Arcee Conductor 已列入，均按 prompt 路由且不感知缓存。Martian 没有新信息。
