# B. LLM Router 现状调研：决策粒度 × Prompt-Cache 感知（面向 agent 的通用 router）

**版本**：v2，2026-11-04。

v1 只用 WebFetch 抓取已知 URL。v2 用 Exa web search 做了两轮补充：
- 逐条核验 v1 标记为 unverified 的条目；
- 补充 v1 漏掉的产品、工程博客和论文。

**细节文件**（逐条原文引用都在这些文件里）：
- `B-parts/gateways.md`：11 个网关
- `B-parts/agents-and-caching.md`：agent 产品，以及 Anthropic/OpenAI/Gemini/Bedrock 的缓存机制
- `B-parts/research.md`：约 60 篇论文
- `B-parts/exa-verification.md`：12 项核验结果
- `B-parts/exa-additions.md`：新增 24 个产品、10 条工程博客、7 组论文

**标注约定**
- 「unverified」：没有在一手来源确认。
- 「推断」：根据文档规则推出，原文没有写。
- 「厂商自测」：数据来自厂商自己的博客。

**缓存感知分级**（v2 把 v1 的 sticky 拆成三档，并单列 harness 内方案）

| 级别 | 含义 |
|---|---|
| none | 不考虑缓存。 |
| marker-only | 只自动打 `cache_control` 断点，路由决策本身不看缓存。 |
| sticky-session | 会话里做一次决策后硬钉住。 |
| sticky-per-model | 每个模型各自钉住 provider/deployment，允许切走再切回。 |
| boundary | 只在缓存边界切换：首轮、compaction 之后等。 |
| cost-modeled | 把缓存成本或切换成本显式计入 stay/switch 决策。 |

---

## 0. 一页结论

1. **跨模型从不共享缓存，没有例外。**
   - 证据：Claude Code 文档 "each model has its own cache"；Gemini 显式缓存绑定模型；OpenAI diagnostics 把 `model_changed` 列为一类 miss 原因；Bedrock 缓存只存在处理请求的那台服务器上。
   - 推论：换模型意味着**新模型要对整段上下文做一次冷写**。
   - 换模型**不会**让旧模型的缓存失效，TTL 内切回仍可命中。
   - effort/thinking、tools、fast mode 的变化在多数模型上也会让缓存失效。例外：Claude 5.5 代/Fable 5.1 走 Anthropic API 时；OpenAI GPT-6+ 用 `configuration_update` 时。
2. **agent 流量的缓存命中率很高，忽略缓存会让「换便宜模型」看起来比实际划算得多。**

   | 来源 | 发现 |
   |---|---|
   | TurnCost | SWE agent 98.6% 的输入命中缓存，平价计费约高估 7 倍 |
   | Copilot trace | turn 内约 90% 命中，跨 turn 约 55%，换模型后降到约 8% |
   | Kaminski | 逐 turn 路由 Opus→Haiku：naive 计算省 51%，计入缓存后只省 9%；Opus→Sonnet 5.5 反而贵 15.5%，因为两者 cache-read 价相同 |
   | Factory（厂商自测） | cache-blind 切换的成本是 always-frontier 的 2.1–2.4 倍 |

3. **经典 router 都按单请求决策，不感知缓存。** 这包括 RouteLLM、FrugalGPT、AutoMix、RouterDC、GraphRouter、Router-R1 等。2026 年的 step 级 agent router（AgentRouter、BoPO、R2V 等）也没把切换成本算进去。
4. **到 2026 下半年，主流产品已经收敛到「缓存感知」，几乎没人再做无保护的逐 turn 切换。**
   - **boundary 型**
     - GitHub Copilot Auto：只在首轮和 compaction 之后切换，中间保持模型不变（官方博客 2026-06）。
     - Copilot Fusion（2026-10-28）：主会话尽量不换模型，辅助模型只拿到它需要的上下文。
     - Cognition Devin Fusion：在 compaction 时切模型，因为 compaction 本来就会 miss，切换等于「免费」。
   - **cost-modeled 型**
     - 网关：vLLM-SR SAAR；Neural Router（按缓存温度算有效价格）；**Not Diamond Code**（2026-08，按 KV cache 状态逐步选模型和 effort，v1 写的「none」是错的）。
     - harness 内：Factory Router、Augment Prism。
   - **sticky 型**
     - 每会话一次后硬钉住：Requesty、NVIDIA Switchyard、TensorZero（按 episode）。
     - 每模型分别钉住：**Vercel AI Gateway**，每个会话最多同时保留 8 个模型的 pin，TTL = provider 缓存 TTL − 15s。
     - 仅 provider/deployment 层：OpenRouter、LiteLLM、Azure、Bifrost。
   - **none**：Bedrock IPR（目前只支持 Nova/Llama）、Cloudflare、Kong、Portkey、Helicone、Plano、Arcee、Cursor Router（官方论坛确认按请求选、换模型就丢缓存）、claude-code-router。
   - **退场**：ChatGPT 的自动切换先后对 Free/Go（2025-12）和 Plus/Pro（2026-09-14）关闭；OpenRouter Auto 在 2026-08-10 改为按市场花费排序，不再用 Not Diamond；Martian router 转为只做网关；NVIDIA blueprint 已弃用，改为 Switchyard；Goose lead/worker 已删除。
5. **最成熟的模式**：主会话不换模型，便宜模型通过「新上下文」的边界引入：子 agent、侧通道、compaction 之后、新会话。
   - Anthropic："if you need to switch models, the best way to do it is with subagents"。
   - Copilot 文档：子 agent 用便宜模型，因为它有自己的会话。
   - Factory：子 agent 拿到的是短规格说明，父会话缓存保持温热。
   - Claude Code 区分 fork 与 subagent：fork 共享缓存、保持同模型；subagent 是新上下文，可以换模型。
6. **切换成本不对称，而且受「碎片化」影响。**
   - 降级（贵→便宜）约 2 次调用内回本；升级在其评估价格下不回本（2610.19292）。
   - Kaminski 提出 **cache fragmentation**：模型闲置期间追加的 token，切回时要按写入价（1.25×）重写。所以来回切换的代价不只是第一次冷写。
   - 比较两个模型应当用**有效价格**：同一 cache-read 价的「便宜」模型可能净亏。
7. **反方观点（要实测，不能直接采信）。**
   - LiteLLM 2026-07 benchmark：切回旧模型时 97.4%/99.3% 的缓存仍热（5m/1h TTL），auto router 加缓存比单模型加缓存便宜 37–69%。据此 LiteLLM 把 `session_affinity` 改为默认关闭。
   - 核验后的问题：
     - 5 组数据里有 3 组的缓存命中是建模估算，不是实测；
     - 没有测质量；
     - 用的是旧价格（Opus/Sonnet 5.5 的读价已降到 0.05×，miss 的相对代价更高）；
     - 只测了同一家族的模型梯度。
   - 结论：作为我们回放评测要检验的假设。它和「每模型分别钉住」（Vercel）是一致的。
8. **新阵营：「路由应该放在 harness 里，而不是网关」。** Factory、Augment、Replit、Cognition 都有生产数据，认为网关拿不到任务状态，事后改写请求还会和按目标模型构造的工具/指令错配。这直接挑战了「agent 与模型之间的网关」这个定位。回应见 §2 P0。

---

## 1. 对比表

### 1.1 网关 / 路由服务

| 产品 | 决策粒度 | 信号 | 缓存感知 | 多轮 / tool call | 开源 | 形态 |
|---|---|---|---|---|---|---|
| **vLLM Semantic Router**（v0.4，2026-09） | 每请求 signal→decision→recipe，外加会话级 stay/switch 层 | 25 类信号（启发式和学习型），Decision/Vela 路由模型，reasoning 开关，cascade recipe | **cost-modeled**：SAAR 硬锁 tool loop 和 `previous_response_id`；软惩罚 = cached/normal 输入价差 × 上下文、handoff、切换历史、剩余轮数先验；idle 或 decision drift 时重置。"protection" 规则 `gain ≥ margin + w·switch_cost`。基准：成本 −78.7%、质量 −0.045；纯 sticky −98.7%、质量 −0.143 | conversation 信号；tool loop 视为局部执行循环；会话 ID 优先级链（含 `x-claude-code-session-id`） | 是 | Envoy 网关 |
| **Neural Router** | 每请求 | 质量/价格目标 | **cost-modeled**：按会话在各 endpoint 上的缓存温度，把 list 价和 cached 价混合成有效价格再排序；温度记录 TTL 5 分钟，只用真实测量刷新，失效时退回 list 价 | 未详查 | 否（unverified） | 托管网关 |
| **Not Diamond**（API + **Not Diamond Code** 2026-08） | API：每请求推荐；Code：编码 agent 会话内**逐步**选模型和 effort | API：学习型质量预测、tradeoff、custom router；Code：会话状态、消息/token 数、复杂度、隐式反馈、**KV cache 状态** | API：none（`previous_session` 是否会带来粘性仍未知）；Code：**cost-modeled**，"may stay on a more expensive model to preserve a warm cache… or break cache to upgrade"，按长期目标优化 | Code 是本地代理，只上传派生元数据；路由费 $0.05/M token | 否 | API 推荐器 / 本地代理 |
| **Vercel AI Gateway** Session Affinity | 每请求选 provider；模型由调用方指定或走 fallback | 会话 ID 优先级 `sessionId` > `x-session-id` > `x-session-affinity` > `prompt_cache_key` > `x-claude-code-session-id` > 指纹；指纹 = SHA-256(首条 system + 首条非 system 消息 + 工具集合 + team) | **sticky-per-model，默认开启**：每个会话最多保留 8 个模型的 pin，所以切走再切回能回到仍热的 provider；pin 寿命 = provider TTL − 15s（OpenAI/Azure 10m，DeepSeek 1h，其余 5m）；显式会话 ID 时 pin 到具体凭证；低于最小可缓存长度时不 pin；响应里返回 `affinity.outcome` | `caching:'auto'` 自动给 Anthropic 等加两个断点；`x-session-affinity` 转发给上游 | 否 | 托管网关 |
| **OpenRouter** Auto Router | 每请求，带会话记忆 | 2026-08-10 起：约 30 类 task-type 分类器 + 近 7 天社区花费份额 + `cost_tier`（**不再用 Not Diamond**）；分类器读末条还是全部历史仍未知，可用 `X-OpenRouter-Metadata` 实测 | sticky（有条件）：只有已选模型仍在 top 候选里才复用 | `session_id` 或消息指纹 | 否 | 托管网关 |
| OpenRouter provider routing | 每请求（同一模型选 provider） | 价格、吞吐、TTFT、可靠性、tool-call 质量 | **sticky + 价格门控**：只在 cache-read 价低于 input 价时启用；空闲 10 分钟过期；手动 `order` 时禁用 | 默认会话键 = hash(首条 system)，子 agent 因此自然分开 | 否 | 托管网关 |
| **LiteLLM** Router/Proxy | 每请求，外加会话/调用方/前缀 pin | 负载策略（shuffle/latency/usage/cost）、各类 fallbacks、complexity router | sticky：`session_affinity`（v1.97 起**默认关闭**）、`deployment_affinity`、`prompt_caching`（按前缀 hash 选 deployment）、encrypted-content 亲和；不计价 | complexity router 只看「最后一条真实用户请求」，跳过 tool-result 轮；semantic router 已弃用 | 是 | SDK + 代理 |
| **Requesty** Auto Routing（2026-10） | **每会话一次**（只在首请求决策） | 用户自定义 label；决策模型只读首条 user 消息，概率过阈值才采用 | **sticky-session**：按 `trace_id` 钉住 60 分钟，理由是 "prompt caches keep working"；`auto_cache` 自动加断点 | 后续轮次和 tool loop 跳过分类 | 否 | 托管网关 |
| **NVIDIA NeMo Switchyard**（取代 LLM Router blueprint） | 每请求，可开 sticky | `auto`、llm_classifier（可设按请求/按 user turn/按会话判定）、stage_router（看 tool 结果和进度）、escalation（N 次确认后锁定强模型）、plan_execute、advisor、**sub-agent-aware** | **sticky + 滞回**：opt-in affinity，键 = hash(system + 首条 user)；`affinity_warmup_turns`；低置信结果不 pin；`capable_hold_turns`。文档承认 "Each switch loses the prompt cache" | 面向 agent harness；pin 存在进程内 LRU，不跨 worker 共享 | 是（pre-1.0） | Rust 库/代理（也上架为 `nvidia/switchyard`） |
| **Azure Foundry Model Router** | 默认每请求，可开会话亲和 | 训练的 ML 打分器；Balanced/Cost/Quality 质量带 | sticky（preview `session_affinity`，30 分钟）；官方明说不比较 stay 和 switch 的收益 | 读整个请求（system、tools、历史）；**坑**：上下文窗口取池中最小的模型 | 否 | 内置 |
| **Bedrock Intelligent Prompt Routing** | 每请求，同一家族二选一 | 质量预测、`responseQualityDifference` | none；缓存只在单台服务器上，切换必然 miss；**当前只支持 Nova/Llama**（不支持 Claude）；文档没写能否配合 cachePoint 或 tools | 未写 | 否 | 内置 |
| **TensorZero** | 每个 episode 一个 variant | 静态权重或自适应 A/B（按反馈指标） | sticky-session（为实验有效性设计，客观上等于钉住） | 一个 episode 对应一个多步工作流 | 是 | 自托管网关 |
| **Bifrost**（Maxim） | 每请求选 provider/key | 企业版 adaptive routing（错误率、延迟、TPM） | key 级会话粘性（v1.4.12） | 不涉及 | 核心开源 | Go 网关 |
| Portkey | 每请求 | 规则、权重、嵌套策略 | 通用 sticky（`hash_fields`） | 不看内容 | 核心开源 | 网关 |
| Kong ai-proxy-advanced | 每请求 | RR/latency/usage/cost/semantic/priority/consistent-hash | 需要自己把 consistent-hash 配到会话 header 上 | 未描述 | 企业插件 | 网关插件 |
| agentgateway（LF） | 每请求 | failover 组 + P2C | marker-only（`promptCaching` 自动加断点） | 未描述 | 是 | 网关 |
| Envoy AI Gateway v1.0 / Higress | 先按模型名，再选副本 | EPP：KV 利用率、前缀亲和；Higress `prefix_cache` | 只做副本级 prefix 亲和，跨模型无 | — | 是 | 网关 |
| Cloudflare AI Gateway | 每请求 flow 图 | 条件、百分比分流、预算 | none（只有精确匹配的响应缓存） | — | 否 | 边缘网关 |
| Helicone / Plano（原 archgw）/ Arcee Conductor / Unify | 每请求或每 turn | 最便宜 provider / domain-action 策略 / 150M 分类器 / 质量+成本加权 | none | Plano 读历史（Arch-Router） | 部分开源 | 网关/API |
| Martian | — | 现在只有手动选模型的网关；router 已成历史，成本优化业务转到 Thesean | — | — | 否 | 网关 |

### 1.2 Agent / 编码产品内置的模型选择

| 产品 | 决策粒度 | 信号 | 缓存感知 | 多轮 / tool / 子 agent | 开源 |
|---|---|---|---|---|---|
| **GitHub Copilot Auto**（router 模型 HyDRA） | 每 prompt 评估，**只在首轮和 compaction 之后切换** | 用完整多轮对话训练：原始意图、最近的回复、元数据；健康度；成本档 | **boundary**："Between those points, the selected model stays in place"；"Switching models mid-session has shown increased cost without ample improvements in quality" | 子 agent 用更便宜的模型（因为它有自己的会话）；不超过主模型成本档 | 否 |
| **Copilot Fusion**（2026-10-28） | 每 prompt 选执行模式：Single / Cascade（草稿+裁判）/ Critique（并行批评） | effort 档 Standard/High/Max | **boundary + 窄上下文辅助**：主会话尽量保持同一模型，辅助模型只拿到需要的上下文 | 按实际使用的模型计费 | 否 |
| **Factory Router**（Droid `auto`） | **harness 内每 turn 决策**，子 agent 和 review 各自选 | 会话历史、**缓存状态**、tool 结果、任务状态（卡住、剩余工作量）、测试结果；同时选 effort | **cost-modeled**："Only the harness can judge when a model switch is worth the cache miss"；"Staying put is itself a routing decision"。报告成本 −58%/−63%（厂商自测） | 子 agent 拿短规格说明；validator 默认用不同家族的模型 | 否 |
| **Augment Prism** | 每 user turn（小 planner 模型） | 内容和复杂度；固定模型组合 | **cost-modeled（定性）**：预期收益超过缓存驱逐成本才切换；tool 跟进轮之间保持不变（96% 的 turn 是 tool 跟进） | "A 'cheaper' model isn't cheaper if it grinds for twice as many turns" | 否 |
| **Cognition Devin Fusion** | lead 与 sidekick 两个常驻 agent；运行中用分类器发出切换信号 | 任务类型、复杂度 | **boundary：在 compaction 时切换**，因为 compaction 本来就 miss；两个 agent 各自保留缓存，只交换 brief | 批评 advisor 式咨询的上下文没有被缓存共享 | 否 |
| **Replit** | 由核心 loop（模型自己）为每次子 agent 派发选 tier 和 effort | 模型自己判断 | 子 agent 可复用并保持温热；在新模型上 effort 可以中途调整而不 miss | "a router will always be less capable than the model it's choosing for" | 否 |
| **Claude Code** | 按会话（`/model`）、按模式（`opusplan`）、按子 agent（`model:`）、按 skill 轮 | 用户、plan mode、子 agent 定义、fallback 链 | **显式**：缓存热时切换才弹确认；`PreModelSwitch` hook 能拿到 `prompt_cache_warm`/`cache_ttl`/`estimated_cache_write_usd`；fork 共享缓存、subagent 独立；compaction 用 cache-safe fork | Explore 从 v2.1.198 起继承主模型（主模型是 Fable 时改用 opus） | 否 |
| Anthropic Advisor tool | executor 自己决定何时调 advisor | 模型判断 | advisor 读完整转录，有可选 caching 参数（细节 unverified） | 服务端在一次请求内完成 | 否 |
| Cursor Router | **每个 agent 请求** | ML 分类器 | **none**：官方论坛说 "prefix cache is tied to a specific model… that benefit resets"，建议手动钉住 | 子 agent 用干净上下文 | 否 |
| Amp（The Dial，2026-07） | 按模式 low/medium/high/ultra（每个模式绑定模型+effort+prompt+tools） | 用户 | 未写；子 agent 默认与线程同模型同 effort（推断对缓存一致性有利） | 有跨模型的 oracle reviewer | 否 |
| Cline Plan/Act、Roo 模式 | 按模式 | 用户 | none：Cline 带着全部历史切换，等于冷 prefill；Roo 子任务是新上下文 | Kilo 已弃用 Orchestrator | 是 |
| claude-code-router（CCR） | 每请求按场景分槽：default/background/think/longContext（默认超过 60K）/webSearch/image | 规则 + 自定义 JS；用 `<CCR-SUBAGENT-MODEL>` 标签指定子 agent 模型 | none（推断：越过 longContext 阈值会在会话中途冷切，think 与 default 交替会碎片化缓存） | 子 agent 标签等于在新上下文边界换模型 | 是 |
| OpenCode / Crush / Zed | 按 agent/角色配置（`small_model`、`subagent_model`、`compaction_model` 等） | 配置 | OpenCode 子 agent 继承父会话的 cache key，被报告同模型并行时互相驱逐缓存（unverified）；Zed 单独设置 `compaction_model` 会失去 cache-safe 压缩 | — | 是 |
| Aider | 按角色：architect/editor/weak | 固定 | 同一模型内 sticky，有 keepalive | weak 模型用于小的新上下文任务 | 是 |
| ChatGPT GPT-5 router | 每条消息（**已基本退场**） | 对话类型、复杂度、tool 需求、显式意图；训练信号："when users switch models, preference rates for responses, and measured correctness" | 未写 | 2025-12 对 Free/Go、2026-09-14 对 Plus/Pro 关闭自动升级到 Thinking；只剩 Business、安全和配额场景 | 否 |
| Codex CLI / Kiro / Goose | 按会话手选 / 按任务 auto / lead→worker（**已删除**） | — | 未写 / 未写 / none | — | 部分开源 |

### 1.3 学术研究

| 工作 | 方法一句话 | 粒度 | 信号 | 缓存 | 多轮 / tool | 开源 |
|---|---|---|---|---|---|---|
| RouteLLM / FrugalGPT / AutoMix / Hybrid LLM / RouterDC / GraphRouter / IRT-Router / Avengers / xRouter | 强弱二选一、级联、对比学习、GNN、IRT、聚类、RL | query | 分类器 / embedding / RL | none | 单轮 | 多数开源 |
| kNN 基线（2505.12601）/ Routing Plateau（2606.07587） | 只用 query 信号时，简单方法就能打平复杂 router；要突破需要轨迹等新信号 | query | 分析 | none | — | — |
| RouterBench / RouterEval / RouterArena | 单 query 基准 | query | — | none | 单轮 | ✔ |
| **Arch-Router**（2506.16655，→ Plano-Orchestrator） | 1.5B 模型把整段对话映射到 domain-action 策略 | 每 user turn | LLM-as-router，读全部历史 | none | 多轮已核实，没有 tool loop 评测 | ✔ |
| Router-R1（2506.09033） | RL 训练多轮的 think/route/聚合 | query | RL | none | 单个 query | ✔ |
| **MTRouter**（2604.23530） | 历史与模型的联合 embedding + 离线结果估计器，在预算内逐 turn 路由 | turn | embedding + 估计器 | 讨论了缓存丢失，声称切换次数更少，没有成本模型 | ScienceWorld | — |
| **RIVET**（2610.23239） | 多轮逐 turn 路由，训练时把事后响应当特权信息 | turn | 特权信息蒸馏 | none | MINT | — |
| SeqRoute（2605.25424） | 会话级预算 MDP，离线 RL | 会话内 turn | RL | none | 多轮聊天 | — |
| AgentRouter（2609.22951）/ BoPO / R2V / Hera / Sibyl / ProgRouter / GraphPlanner / OpenSquilla | 逐步选 tier（分类器、RL、verifier、进度预测） | step | 多种 | none | 是 | 少数 |
| **SWE-Router**（2607.00053）/ **TACIT-Switch**（2608.27911） | 先用便宜模型探索再决定一次 / 单向永久 handoff | trajectory | 学习型 | 隐式友好（只切一次） | SWE / ALFWorld | — |
| MasRouter / Switchcraft / COPE / BudgetMLAgent | 多 agent 路由 / tool-call 级路由 / 规划-执行级联 / expert lifeline | per agent / per tool call / stage | — | none | — | 部分 |
| TwinRouterBench（2605.18859）/ RouterWorld（2610.26511） | step 和 trajectory 级的 agent 路由基准 | step | 基准 | 实际花费是否按缓存计价 unverified | 是 | ✔ |
| **Whose turn is it?**（2610.19292） | user turn 边界上零样本、看历史、计成本的路由 | turn 边界 | LLM-as-router + 会话历史 | **cost-modeled**：降级约 2 次调用回本，升级不回本 | 多轮表格 agent | — |
| **Harness Tokenomics**（2609.28919） | 只在无需重建缓存的点路由：会话开始、侧通道、子 agent 启动；置信度低于 0.8 时保持不动 | session/subagent | 校准分类器 + 回本规则 | **cost-modeled + sticky**（建模了 TTL） | Claude Code 类 harness | 未开源 |
| **TurnCost**（2610.15093） | 600 条 SWE 轨迹的缓存计价分析，给出委派 break-even | step | 解析模型 | **cost-modeled**：一半设置里委派反而更贵 | SWE | Zenodo |
| **When Caching Meets Routing**（Kaminski，个人 PDF） | 逐 turn 缓存感知模拟器；600 个场景中位数只省 6.5%，16.2% 的场景亏钱 | turn | 模拟 | **cost-modeled**：提出 fragmentation 机制，规则是 "route at cache granularity" | 12 轮语音 agent | — |
| CarbonRouter（2610.35230） | 历史重算成本 + 「下轮可能回来就不走」的门控 | query + 会话门控 | 成本模型 | **cost-modeled + 防抖** | 多轮 | — |
| CacheRouter（2608.22708） | 主模型的 tool 列表固定，长尾 tool 交给侧通道 | 侧通道 | — | 靠前缀稳定设计（命中 91–95%） | tool 路由 | — |
| KV-Lingo / CacheBridge / MapFlow / **CacheLink**（2610.15509） | 跨模型 KV 翻译或迁移 | — | — | 降低切换惩罚，**仅适用于自托管开源权重** | — | 部分 |
| 副本级：Preble、SGLang、Dynamo、llm-d、AIBrix、Mooncake、SMetric、TOPAS、OpenAI `prompt_cache_key` | 同一模型内选副本 | — | — | 副本级 | — | 多数开源 |
| Workload-Router-Pool 愿景（2603.21354） | vLLM-SR 团队的 W×R×P 研究议程 | — | — | — | — | — |

---

## 2. 对 agent-facing、cache-aware router 最相关的模式

### P0.（新增）回应「路由应在 harness 内」的挑战
- Factory、Augment、Replit、Cognition 的论点：
  - 网关看不到任务状态（卡住没有、剩余工作量、测试结果）；
  - 网关看不到真实的缓存边界；
  - 请求里的工具接口和指令是按目标模型构造的，网关事后换模型会错配；
  - 跨家族切换还会丢掉 encrypted reasoning。
- 网关型 router 的生存条件：
  1. **harness 协作协议**：harness 透传 session lineage（父会话 / fork / 子 agent）、turn 序号、compaction 和子任务边界、失败计数，并允许 harness 锁定模型或给出提示。
  2. **双模式**：既能透明代理（启发式识别边界），也提供「建议 API」，让 harness 在构造请求前先问 router 用哪个模型。参考 Not Diamond API 和 NVIDIA Switchyard 的推荐模式。
  3. **跨家族切换受限**：默认只在同一家族内切；跨家族只在边界上切，并剥离或转换 provider 专属状态（thinking block、`cache_control`、tool 格式、encrypted reasoning）。LiteLLM PR #39210：给不支持缓存的模型发 `cachePoint`，Bedrock 返回 403。

### P1. 会话身份与「每模型分别钉住」
- **出处**：Vercel（每会话最多 8 个模型的 pin，TTL 对齐 provider 缓存 TTL − 15s，pin 到具体凭证）、OpenRouter（`session_id`，默认 hash(首条 system)）、LiteLLM、Azure、vLLM-SR、Switchyard，以及副本层的 `prompt_cache_key`/Dynamo/llm-d。
- **要点**：
  - **为每个 (session, model) 维护一个缓存状态**：provider、凭证、region、前缀 hash、最后访问时间、TTL。不要只记一个「当前模型」。
  - 会话 ID 要区分 lineage。已知的坑：
    - OpenCode 子 agent 继承父会话的 cache key，被报告同模型并行时互相驱逐缓存；
    - Vercel 和 Switchyard 的指纹基于 system + 首条 user，首条消息模板化时不同会话会撞键。
  - 选定模型后，把稳定的亲和键传给下游 provider 或副本。evanto 实测：缓存是「路径」的属性，不是模型的属性；不带 `cache_control` 时四家 router 的 Claude 命中都是 0/4。
- **单纯 sticky-session 的代价**（vLLM-SR）：成本 −98.7%，但质量 −0.143。所以钉住只是默认策略，还需要 P2 和 P3 提供逃逸路径。

### P2. 在缓存边界切换（boundary-gated）
- **出处**：
  - **Copilot Auto**：只在首轮和 compaction 之后，已核实；
  - **Cognition**：在 compaction 时切；
  - Harness Tokenomics：会话开始、子 agent 启动、侧通道、任务边界；
  - Claude Code：缓存热时才弹切换确认；
  - vLLM-SR：idle 或 drift 时重置。
- **天然的「免费切换点」**：
  1. 新会话或首轮；
  2. 新的子 agent 或子任务；
  3. **compaction 之后**（OpenAI diagnostics 把 `context_compacted` 单列为一类 miss）；
  4. 超过 TTL 的空闲之后：Anthropic 5m/1h；OpenAI GPT-5.6+ 30m/12h；OpenRouter 10m；Vercel 按 provider TTL − 15s；
  5. tool、system、effort 已经变了（缓存已经破了）；
  6. failover。
- 边界之内默认保持不动，tool loop 中间硬锁（P5）。

### P3. 切换成本模型（有效价格 + 碎片化 + 剩余调用期）
- **最小形式**（综合 Whose-turn、Harness Tokenomics、TurnCost、Kaminski、maxtokens.ai、vLLM-SR）：
  ```
  对每个候选模型 m，在剩余调用期 H 内：
  C_m(H) = Σ [ 新增 token × write_m 或 input_m
             + 已温热前缀 × read_m
             + 冷前缀（m 没有有效缓存的部分）× write_m
             + 输出 × out_m ]
           + 预期重试成本
  切换条件：C_new(H) + 质量风险 < C_stay(H) − margin
  ```
  - **冷前缀**要按每个模型分别计：TTL 内切回旧模型只需重写它闲置期间新增的部分（fragmentation）。
  - **有效价格**：比较 read 价，而不是 list 价。Opus 5.5 和 Sonnet 5.5 的 read 价都是 $0.20/M（0.05×），所以长会话里「降到 Sonnet」可能净亏（Kaminski）。顶价模型在长 tool-heavy 会话里也可能更便宜（Harness Tokenomics 的 crossover）。
  - 防抖手段：切换历史惩罚、「下轮可能回来就不走」门控（CarbonRouter）、`min_turns_before_switch`、`capable_hold_turns`（Switchyard）、低置信不切（Harness Tokenomics 0.8、Switchyard 低置信不 pin）。
- **价目（已核实）**：
  - Anthropic：写 1.25×（5m）/2×（1h）；读 0.1×；Opus/Sonnet 5.5 读 0.05×；Fable 5.1 读 0.025×。
  - OpenAI GPT-5.6+：写 1.25×（30m）/2.5×（12h，仅 Responses API）；读 0.1×；GPT-6.1 Sol/Terra 读 0.05×。
  - 读价越低，切换越难回本。
- **不对称**：升级要尽早、一次到位；降级要满足 `E[remaining] > k*`。

### P4. 子 agent 级路由（route sub-agents, not turns）
- **出处**：Claude Code `model:`、fork 与 subagent 的区分；Copilot（子 agent 用更便宜的模型）；Factory（子 agent 拿短规格说明）；Replit（模型自己选子 agent tier）；Roo；Cursor Explore；Devin sidekick；Aider weak；Harness Tokenomics；CCR 的子 agent 标签；Anthropic 原话。
- **规则**：
  - 带全量父上下文的 fork：继承父模型。
  - 只带短 prompt 的子 agent：可以自由选模型。
  - router 要识别「子 agent 的首请求」，信号可以是：新的 system hash、新的 conversation-id、上下文骤短、harness header。

### P5. tool loop 硬锁 + 输入卫生
- **出处**：vLLM-SR 两类硬锁；Augment（tool 跟进轮之间保持不变，96% 的 turn 是这类）；LiteLLM（只看最后一条真实用户请求，跳过 tool-result 轮）；Requesty（后续轮次直接跳过分类）。
- **规则**：
  - tool_result 必须回到发起 tool_use 的那个物理模型；
  - 纯 tool-result 轮不重新分类。

### P6. 级联 / 升级（单向、少次）
- **出处**：
  - FrugalGPT、AutoMix；
  - SWE-Router、TACIT-Switch（单向）；
  - Switchyard escalation（N 次确认后锁定）；
  - Copilot Fusion Cascade（便宜模型先草拟，judge 接受或升级）；
  - vLLM-SR `progress_gate`。
- **警告**：
  - 逐步路由论文报告的节省大多没计入缓存失效；
  - Augment 和 Amp 发现，便宜模型多跑轮次或多花 token 可能反而更贵；
  - Kaminski 发现，sticky escalation 会让 77.9% 的 turn 漂到 frontier。

### P7. planner-executor 与「窄上下文辅助模型」
- **出处**：
  - 窄上下文型：Copilot Fusion（辅助模型只拿需要的上下文）、Devin Fusion（lead 与 sidekick 各自持有缓存，只交换 brief）、Aider editor、Roo 子任务；
  - 全量历史型：`opusplan`、Cline。
- **规则**：executor 和辅助模型要做成**新上下文子任务**。在同一段全量历史上换模型，每次都是冷 prefill。

### P8. 先调 effort，再换模型
- **出处**：OpenAI GPT-6+ `configuration_update`（diagnostics 里 `reasoning_effort_changed` 可以避免）；Claude 5.5 代/Fable 5.1 走 Anthropic API 时换 effort 不 miss（Bedrock、Vertex 和网关上不成立）；Replit 逐步调 effort；Not Diamond Code 和 Factory 同时选模型和 effort。
- **规则**：在缓存安全的模型上，router 的动作空间优先级应为：同模型调 effort → 边界内换模型 → 边界外换模型。

### P9. prefix 字节稳定 + 可观测性
- **要求**：
  - router 自己不能改写 prefix；
  - 1h TTL 要转发 `anthropic-beta`；
  - 不要剥掉 `cache_control`；
  - 新工具追加在末尾（Factory）；
  - Bedrock 上，并行的兄弟请求要等首个响应开始后再发。
- **可观测**：
  - 把命中率做成 SLO（Anthropic 用 SEV 处理，Manus 称其为 "single most important metric"）；
  - 按 provider 实际 usage 计价；
  - 记录 miss 原因（参考 OpenAI diagnostics 的分类：`model_changed`、`tools_changed`、`context_compacted`、`reasoning_effort_changed`）；
  - 记录 affinity 结果（参考 Vercel 的 `affinity.outcome`、Azure 的 initialize/retain/switch）。

---

## 3. 开放问题

1. **网关还是 harness？**（P0）透明代理能拿到多少任务状态？harness 协作协议（lineage、边界、失败计数、锁定）的最小集合是什么？是否需要同时提供「建议 API」？
2. **剩余调用期 E[H] 的预测**：每个 break-even 规则都需要它，但没有现成的预测器。能否从 todo、plan、测试状态估出来？vLLM-SR 只用了先验。
3. **每模型缓存状态的估计**：provider 的缓存只能部分观测。能否用 usage 回传的 cached tokens 在线校准？TTL、驱逐、溢出路由（OpenAI 约 15 RPM/key）、Bedrock 单服务器缓存，这些情况下估计有多准？Neural Router 和 Vercel 的「TTL − 余量」是两种参考做法。
4. **LiteLLM 和 Vercel 的「切回仍热」假设，在我们的价格和流量下是否成立**？需要在真实 agent trace 上实测 fragmentation 成本，特别是 0.05× 读价和 OpenAI 写溢价出现之后。
5. **质量信号**：只看 query 的信号已到瓶颈（Routing Plateau）。agent 里可用的在线信号有 tool 失败、测试、reask、用户中断、轨迹前缀。怎么用来触发升级而不导致抖动？
6. **学习型路由加成本模型**：在「按缓存实际计价、状态里包含每模型缓存状态」的条件下训练策略，用规则包裹学习型质量预测器，还是端到端 RL？
7. **跨家族切换**：何时值得切？thinking、encrypted reasoning、tool 格式怎么转换？validator 是否应该刻意用不同家族的模型（Factory 的做法）？
8. **多 provider 缓存价目表**：TTL、写溢价、最小长度、API 差异（Bedrock 上 GPT 模型用 Converse 不能缓存）、作用域。由谁维护？能否自动校准？
9. **failover 与缓存**：遇到 429 时，换 provider（同模型）还是换模型？是否回迁？
10. **评测**：现有基准都不按「缓存实际计价 + TTL + 写溢价 + 碎片化」算成本。需要自建回放器，可参考 TurnCost 工具、Kaminski 模拟器、Harness Tokenomics 的重新计价方法。
11. **上下文窗口约束**和**用户可控性**：ChatGPT 的 autoswitcher 已退场，说明不可控的自动切换在消费端不被接受。要返回决策原因，并允许锁定模型。
12. **仍未核实**：
    - OpenRouter Auto 的分类器读哪部分输入（可用 `X-OpenRouter-Metadata` 实测）；
    - Bedrock IPR 能否配合 cachePoint 和 tools；
    - Not Diamond `previous_session` 是否带来粘性；
    - Anthropic Advisor caching 的细节；
    - OpenCode 缓存驱逐 issue；
    - Harness Effect（2607.06906）和 CacheWise（2606.16824）两篇论文只见于二手转引。

---

## 4. 来源 URL

### 产品 / 网关
- vLLM-SR：
  - https://vllm.ai/blog/2026-06-02-session-aware-agentic-routing
  - https://vllm-sr.ai/blog/session-aware-agentic-routing
  - https://vllm-sr.ai/docs/tutorials/learning/protection
  - https://vllm-sr.ai/docs/api/session-identification
  - https://github.com/vllm-project/semantic-router
- Neural Router：https://neuralrouter.ai/docs/features/prompt-caching
- Not Diamond：
  - https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents
  - https://code.notdiamond.ai/docs/
  - https://www.notdiamond.ai/blog/interactive-benchmarks-a-new-methodology-for-evaluating-model-routing
  - https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post
- Vercel：Session Affinity 文档，见 `B-parts/exa-additions.md`
- OpenRouter：
  - https://openrouter.ai/docs/guides/routing/routers/auto-router
  - https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/
  - https://openrouter.ai/docs/features/provider-routing
  - https://openrouter.ai/docs/features/prompt-caching
- LiteLLM：
  - https://docs.litellm.ai/docs/routing
  - https://docs.litellm.ai/docs/proxy/auto_routing
  - https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark
  - https://docs.litellm.ai/docs/auto_router/prompt_caching
  - https://github.com/BerriAI/litellm/pull/39210
- NVIDIA：
  - https://github.com/NVIDIA-NeMo/Switchyard
  - https://nvidia-nemo.github.io/Switchyard/routing_algorithms/sticky_routing/
  - https://github.com/NVIDIA-AI-Blueprints/llm-router
- Azure：
  - https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router
  - https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router
- Bedrock：
  - https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html
  - https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- 其他网关：
  - Portkey：https://portkey.ai/docs/product/ai-gateway/load-balancing
  - Kong：https://developer.konghq.com/plugins/ai-proxy-advanced/
  - Cloudflare：https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/
  - Martian：https://withmartian.com/ 、https://docs.withmartian.com/gateway
  - Requesty、TensorZero、Bifrost、agentgateway、Envoy AI Gateway、Higress、Helicone、Plano、Arcee、Unify：URL 见 `B-parts/exa-additions.md`

### Agent 产品
- GitHub Copilot：
  - https://github.blog/ai-and-ml/github-copilot/getting-more-from-each-token-how-copilot-improves-context-handling-and-model-routing/
  - https://docs.github.com/en/copilot/concepts/auto-model-selection
  - https://docs.github.com/en/copilot/concepts/models/copilot-fusion
  - https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion/
- Factory：
  - https://factory.com/news/model-routing-belongs-in-the-harness
  - https://factory.com/articles/cache-aware-model-routing
- Augment：https://www.augmentcode.com/blog/augment-prism-model-routing-to-reduce-cost-and-maintain-quality
- Cognition：
  - https://cognition.com/blog/devin-fusion
  - https://cognition.com/blog/local-fusion
- Replit：https://replit.com/blog/free-the-models
- Claude Code：
  - https://code.claude.com/docs/en/model-config
  - https://code.claude.com/docs/en/sub-agents
  - https://code.claude.com/docs/en/prompt-caching
  - https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/
- Cursor：
  - https://cursor.com/help/models-and-usage/cursor-router
  - https://forum.cursor.com/t/model-changes-mid-conversation-in-the-auto-routers/166831
- Amp：
  - https://ampcode.com/news/the-dial
  - https://ampcode.com/modes
- Cline：https://docs.cline.bot/features/plan-and-act
- Roo Code：https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks
- Aider：https://aider.chat/docs/usage/modes.html
- OpenAI / ChatGPT：
  - https://openai.com/index/gpt-5-system-card/
  - https://help.openai.com/en/articles/6825453-chatgpt-release-notes
  - https://www.wired.com/story/openai-router-relaunch-gpt-5-sam-altman/
- Manus：https://www.manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- 第三方实测：
  - evanto：https://evanto.de/en/blog/llm-routers-compared
  - TDS：https://towardsdatascience.com/the-hidden-cost-of-llm-routing-why-switching-models-costs-more/
  - maxtokens.ai：https://maxtokens.ai/posts/cache-aware-agent-routing/

### 缓存机制与定价
- Anthropic：
  - https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  - https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI：
  - https://developers.openai.com/api/docs/guides/prompt-caching
  - https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
  - https://developers.openai.com/cookbook/examples/prompt_caching_201
- Gemini：https://aistudio.google.com/docs/caching

### 副本级调度
- llm-d：https://github.com/llm-d/llm-d-inference-scheduler
- Dynamo：https://github.com/ai-dynamo/dynamo
- SGLang：https://github.com/sgl-project/sglang/tree/main/sgl-model-gateway
- AIBrix：https://github.com/vllm-project/aibrix

### 研究（完整列表、venue、核验级别见 `B-parts/research.md` 和 `exa-additions.md`）
- 经典路由：
  - RouteLLM https://arxiv.org/abs/2406.18665
  - FrugalGPT https://arxiv.org/abs/2305.05176
  - AutoMix https://arxiv.org/abs/2310.12963
  - Hybrid LLM https://arxiv.org/abs/2404.14618
  - RouterDC https://arxiv.org/abs/2409.19886
  - GraphRouter https://arxiv.org/abs/2410.03834
  - Arch-Router https://arxiv.org/abs/2506.16655
  - Router-R1 https://arxiv.org/abs/2506.09033
  - RouterBench https://arxiv.org/abs/2403.12031
  - RouterEval https://arxiv.org/abs/2503.10657
  - RouterArena https://arxiv.org/abs/2510.00202
  - kNN https://arxiv.org/abs/2505.12601
  - Routing Plateau https://arxiv.org/abs/2606.07587
- 多轮 / agent 路由：
  - MTRouter https://arxiv.org/abs/2604.23530
  - RIVET https://arxiv.org/abs/2610.23239
  - SeqRoute https://arxiv.org/abs/2605.25424
  - AgentRouter https://arxiv.org/abs/2609.22951
  - BoPO https://arxiv.org/abs/2602.21227
  - SWE-Router https://arxiv.org/abs/2607.00053
  - TACIT-Switch https://arxiv.org/abs/2608.27911
  - TwinRouterBench https://arxiv.org/abs/2605.18859
  - RouterWorld https://arxiv.org/abs/2610.26511
  - MasRouter https://arxiv.org/abs/2502.11133
  - Switchcraft https://arxiv.org/abs/2605.07112
- 缓存感知：
  - Whose turn https://arxiv.org/abs/2610.19292
  - Harness Tokenomics https://arxiv.org/abs/2609.28919
  - TurnCost https://arxiv.org/abs/2610.15093
  - Kaminski https://www.michael-kaminski.io/docs/papers/when-caching-meets-routing.pdf
  - CarbonRouter https://arxiv.org/abs/2610.35230
  - CacheRouter https://arxiv.org/abs/2608.22708
  - CacheLink https://arxiv.org/abs/2610.15509
  - KV-Lingo https://arxiv.org/abs/2609.32610
  - CacheBridge https://arxiv.org/abs/2609.00891
  - WRP 愿景 https://arxiv.org/abs/2603.21354
- 生产 trace：
  - Copilot https://arxiv.org/abs/2608.00101
  - M365 https://arxiv.org/abs/2610.22863
  - 企业编码 agent 经济学 https://arxiv.org/abs/2607.13080
