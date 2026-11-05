# LLM tier assessor 评估：做了什么、怎么做、结论与后续

> 状态：2026-11-05。本文汇总 `@auto-router/assessor` 的离线评估（pack v1 → v2 → v2.1）。完整数字、混淆矩阵和阈值扫描见
> [tasks/11-04-llm-tier-assessor/research/README.md](../tasks/11-04-llm-tier-assessor/research/README.md)；设计见
> [design.md §10、§13](../tasks/11-04-llm-tier-assessor/design.md)；assessor 在整体架构中的位置见
> [architecture/architecture.zh-CN.md §7](architecture.zh-CN.md#7-llm-tier-assessor)。
> 带 **合成数据** 标记的数字来自合成 trace，不是线上流量。

## 目录

1. [评估要回答的问题](#1-评估要回答的问题)
2. [被评估的对象](#2-被评估的对象)
3. [数据集](#3-数据集)
4. [评估方法](#4-评估方法)
5. [过程与结果](#5-过程与结果)
6. [结论](#6-结论)
7. [局限](#7-局限)
8. [后续怎么优化](#8-后续怎么优化)
9. [复现命令](#9-复现命令)
10. [文件索引](#10-文件索引)

## 1. 评估要回答的问题

hint、alias 和 policy 规则都没有给出 tier 时，core 可以咨询 assessor：用一个轻量 LLM 判断这一轮需要 fast、standard 还是
frontier。评估要回答五个问题：

| 问题 | 指标 | 为什么重要 |
|---|---|---|
| 判成 fast 的可信吗？ | **fast 精确率**（判成 fast 的里面金标确实是 fast 的比例） | 误判成 fast 会把需要推理的任务交给弱模型，直接损失质量。这是关键的安全指标 |
| 能认出 frontier 任务吗？ | frontier 召回 | 认不出就会把难任务降级；反过来，误升级（standard → frontier）会白白花钱 |
| 多少次能给出意见？ | 覆盖率（置信度 ≥ 阈值、给出 tier 的比例）、判对率（给出意见时判对的比例） | 无意见时决策回落到 pool 默认，安全但没有收益 |
| 放得进请求路径吗？ | p50 / p95 延迟、超过 1.5 s 的比例、每次成本 | 生产超时默认 1.5 s，超时视为无意见 |
| 多轮会话里稳定吗？ | 翻转率、误翻转率、降级后立即升回（振荡） | tier 来回切会破坏 prompt 缓存 |

最后再回答一个问题：这些误差放到路由里，成本和质量会怎样？这一步用 replay 离线模拟。

## 2. 被评估的对象

assessor 的管线：precheck → 构造 task card → 渲染 prompt pack → 调用模型 → 解析 → 校验 → `mapTier` → 记成本。它从不向请求路径抛错；超时、错误、无效输出都算"无意见"。

**模型不直接说 tier。** 它对 pack 里的每条规则判断是否命中，再给出一组事实（`scope`、`specification`、`reasoning_depth`、`prior_failures` 等）和一个置信度，由纯函数 `mapTier`（[map.ts](../../packages/assessor/src/map.ts)）映射成 tier，第一个命中的分支生效：

1. 置信度 < 阈值（默认 0.8）→ 无意见。
2. fast 规则和 frontier 规则同时命中 → 冲突，无意见。
3. frontier 规则命中，或 `reasoning_depth = deep`，或 `prior_failures ≥ 2` → **frontier**。
4. standard 规则命中，或（没有 fast 规则命中，且是多文件改代码）→ **standard**。
5. fast 规则命中，且 `specification = fully-specified`、`reasoning_depth` 是 lookup 或 routine → **fast**；否则无意见。
6. 什么规则都没命中 → 无意见。

**Prompt pack** 是版本化的目录（`packages/assessor/prompts/assessor/<版本>/`）：`instructions.md`（指令和事实定义）、`rules.json`（规则）、`examples.json`（few-shot 示例）、`pack.json`。四条规则是：

| 规则 | tier |
|---|---|
| `explore-readonly`：只读探索、查找 | fast |
| `mechanical-edit`：完全指定的机械修改 | fast |
| `bounded-change`：局部、有界的改动 | standard |
| `deep-investigation`：根因不明、跨模块、设计类 | frontier |

每条规则有自己的 `auto` 开关：关闭时意见只记录、不改变服务的模型（observe）。目前全部关闭。

被评估的模型：

- GPT-6 Luna（`global.openai.gpt-6-luna`，默认，effort `none`）；
- Claude Haiku 5.5（`global.anthropic.claude-haiku-5-5`，可选）；
- 另测了 Luna effort `low` 的变体。

## 3. 数据集

| 数据集 | 条数 | 金标 | 作用 |
|---|---|---|---|
| SWE-bench Verified | 500 | `<15 min`、`15 min–1 h` → standard（455）；`1–4 h`、`>4 h` → frontier（45） | 真实 issue：测误判 fast、1 小时边界上的 frontier 召回、校准 |
| 手工标注 | 80 | 40 fast / 22 standard / 18 frontier；含 6 条易混项和 4 条提示注入 | 覆盖 fast 场景（SWE-bench 里没有 fast 金标） |
| 轨迹 | 16 条 × 5 turn = 80 | 每个 turn 一个金标 | 多轮稳定性 |

- SWE-bench 的卡片：issue 文本同时作为最新和首条用户文本，root lineage，turn 0。
- **dev / test 切分**（从 pack v2 起）：按 instance id 的哈希切分（`sweSplit`）。
  - dev：117 条，其中 27 条 frontier，只用于调 pack；
  - test：383 条，其中 18 条 frontier，留出，给出最终数字。
- **数据规则**：
  - SWE-bench 的数据集卡片没有声明许可证，所以只做离线评估；
  - 原始行放在 gitignore 的 `packages/assessor/data/`，不分发；
  - 报告里只有 instance id 和聚合数字，不引用 issue 文本；
  - few-shot 示例从不取自 SWE-bench。
- 有测试保证手工标注集、轨迹集和每个 pack 的 few-shot 示例不重叠（规范化文本和 8-gram）。

## 4. 评估方法

### 4.1 在线评估（真实调用模型）

用 `node src/eval/cli.ts run` 运行（[cli.ts](../../packages/assessor/src/eval/cli.ts)、[harness.ts](../../packages/assessor/src/eval/harness.ts)）：

- **走生产代码路径**：每条数据通过 `createAssessor` 和生产用的适配器调用模型，只把 transport 换成 SigV4 签名的 live transport。Luna 走 Responses strict schema，Haiku 走 Messages 强制 tool。
- **超时放宽到 10 s**：为了量到真实的延迟分布，然后单独报告超过 1.5 s 的比例。
- **并发 4**。
- **账号检查**：第一次调用前确认当前账号等于 `LLMAR_SPIKE_ACCOUNT`，不一致或没设置就拒绝运行。
- **最小权限**：只调用 bedrock-runtime 的模型推理路径，只在一个区域（`--region`，否则用价格目录的区域）。
- **预算账本**（`data/eval-runs/ledger.json`，上限 $1.80）：每次调用前按最坏情况预留成本，`已花 + 预留 > 上限` 就停止；调用后按返回的 usage 用 `costOf` 记实际成本。
- **结果脱敏**：每条结果记 id、金标、状态、tier、置信度、basis、延迟、usage、成本和 pack 版本，写盘前去掉 12 位数字、ARN 和 request / response id。

### 4.2 报告（离线，不再调用模型）

`cli.ts report` 从记录的结果生成报告（[report.ts](../../packages/assessor/src/eval/report.ts)），按模型 × 数据集分组：

- 混淆矩阵：金标 × {fast, standard, frontier, 无意见, 不可用}；
- fast 精确率、frontier 召回、覆盖率、判对率；
- 延迟分位数、超过 1.5 s 的比例、每次成本、缓存命中；
- **阈值扫描**：用记录的置信度在 0.5–0.95 之间重算各项指标，不额外调用；
- 轨迹集的稳定性：翻转率、误翻转、边界上的翻转、振荡；
- 手工标注集分类别的结果。

### 4.3 对路由的影响（离线 replay，**合成数据**）

1. 用 replay 生成合成会话：400 个会话，seed 2026，30% 的 turn 需要另一档。两种 trace：
   - standard→fast：standard 为主，30% 的 turn 需要 fast；
   - frontier→standard：frontier 为主，30% 的 turn 需要 standard。
2. trace 里每个 turn 的 `hints.tier` 就是真实需求。`cli.ts hints` 按某个 pack + 模型的实测混淆矩阵，对每个（lineage，用户 turn）按金标那一行重新抽样（seed 7）。无意见或不可用就删掉 hint，回落到 pool 默认。
3. 用 replay 在原始 trace（完美 hint）、无 hint、和重采样后的 trace 上分别跑 `hint-blind` 和 `core-cost` 策略，比较成本和各档调用次数。

这一步完全离线，不调用模型。

### 4.4 调 pack 的纪律

- 只在 dev 切分上调；test 切分只跑一次，给出最终数字。
- 每个 pack 版本一个目录，旧版本保留可选（`packDirs`）。`packVersion = <pack id>+sha256(system)[:12]`，结果文件可追溯到具体的 prompt。
- 对比不同 pack 时用同一批数据（手工 + SWE test + 轨迹，共 543 条），replay 也用同一批数据的混淆矩阵。

## 5. 过程与结果

### 5.1 第一轮：pack v1，选模型（660 条，阈值 0.8）

| 模型 | 数据集 | 覆盖率 | fast 精确率 | frontier 召回 | p50 / p95 | > 1.5 s | $/次 |
|---|---|---|---|---|---|---|---|
| Luna | 手工 80 | 96.3% | 100% | 88.9% | 1.29 / 1.47 s | 3.8% | 0.00029 |
| Luna | SWE-bench 500 | 73.8% | 0%（8 条误判，金标都是 standard） | 0/45 | 1.27 / 1.95 s | 12% | 0.00064 |
| Luna | 全部 660 | 75.0% | 87.1% | 31.2% | 1.27 / 1.78 s | 10.4% | 0.00057 |
| Haiku 5.5 | 全部 660 | 66.5% | 96.2% | 23.4% | 2.61 / 10.0 s | 100% | 0.00039 |
| Luna effort low | 抽样 181 | 82.9% | 70% | 21.1% | 1.67 / 2.26 s | 63% | 0.00065 |

发现：

- **Luna 能放进 1.5 s 的预算，Haiku 不能**。Haiku 每次调用都超过 1.5 s，9% 在 10 s 内没有返回，只适合更长的预算或异步模式。effort `low` 每一项都更差。
- **fast 边界在手工数据上完美，在真实 issue 上不完美**。SWE-bench 的误判 fast 都带高置信度，提阈值几乎没用：Luna 要到阈值 0.95 精确率才到 96%，覆盖率只剩 8%。
- **两个模型都认不出 SWE-bench 的 frontier 任务（0/45）**：只看 issue 文本，看不出修复要 1 小时以上。手工标注的深度排查任务上召回是 83–89%。
- **提示注入影响小**：4 次注入，Luna 4/4 判对，Haiku 3/4。tier 来自事实和规则判断，卡片里的指令控制不了它。
- **稳定性**：约 80% 的翻转发生在任务真的变了的 turn 上；其他 turn 上的误翻转约 6–8%；没有观察到降级后下一轮立即升回。
- **replay（合成数据，standard→fast）**：Luna 评估的 hint 拿到了完美 hint 约 90% 的节省（−8.5% vs −9.4%）。在 frontier→standard 上，"节省"其实是质量损失：只保住了完美 hint 下 42% 的 frontier 调用。

这一轮的结论直接进了 core：默认模型 Luna、阈值 0.8、所有规则 observe、frontier 降级保护（assessor 只能把 standard 往下拉）。

### 5.2 第二轮：pack v2，收紧 fast 边界

改动：

- `mechanical-edit`：描述了错误行为、建议或勾勒了修法的 bug 报告，不算"完全指定的改动"；
- `deep` 的定义放宽：依赖多个组件交互或微妙语义、根因未定位、修法需要决定预期行为的 bug；
- 新增 3 个示例。

在 dev 上调了两轮，然后在留出的 test 上测：

| 指标（Luna，543 条） | v1 | v2 |
|---|---|---|
| fast 精确率 | 88.4%（69 次 fast） | 96.8%（63） |
| SWE test 上的误判 fast | 7 | 1 |
| frontier 召回 | 48.0% | 66.0% |
| **SWE test 上 standard → frontier** | 0/365 | **63/365（17.3%）** |
| 判对率 | 94.7% | 83.5% |

fast 边界变好了，但 frontier 信号太噪：在留出的 SWE-bench 上，frontier 精确率只有约 14%。离线也分不开真假升级：

- 深度排查规则和 `deep` 事实总是一起出现，要求两者同时成立不起作用；
- 单独给 frontier 设更高阈值，误升级和召回一起掉。

replay（**合成数据**）里，v2 在 standard→fast trace 上反而比无 hint 贵 15%：大量 standard turn 被升到 frontier。

### 5.3 第三轮：pack v2.1，组合两者

v2.1 只取 v2 的 fast 侧改动，frontier 侧保持 v1：

- 来自 v2：`explore-readonly`、`mechanical-edit` 的指令，`fully-specified` 的定义，"给出建议修法的 bug 报告 → standard"的示例；
- 来自 v1：`deep-investigation` 规则，`routine` / `deep` 的定义，frontier 示例；
- `bounded-change`：v1 的文本，加上"指出出错代码或建议修法的 bug 报告"。

v2.1 是用 dev 上已经测过的部件组装的，没有再做在线调参；test 上只跑了一次（543 次调用，$0.32）。

| 指标（Luna，阈值 0.8，543 条） | v1 | v2 | **v2.1** |
|---|---|---|---|
| fast 精确率 | 88.4%（69） | 96.8%（63） | **98.3%（60）** |
| 覆盖率 | 75.9% | 83.8% | 82.3% |
| frontier 召回 | 48.0% | 66.0% | 48.0% |
| SWE test 上 standard → frontier | 0/365 | 63/365 | **1/365** |
| 判对率 | 94.7% | 83.5% | **95.5%** |
| p50 / p95 延迟 | 1263 / 1778 ms | 1286 / 1434 ms | 1249 / 1435 ms |
| $/次 | 0.00055 | 0.00068 | 0.00060 |
| 轨迹上的翻转率（按服务的 tier） | 25.0% | 18.8% | 28.6% |
| 轨迹上的误翻转（金标没变） | 8.1% | 8.1% | 8.3% |

replay（**合成数据**，core-cost，三个 pack 都用同一批 543 条的混淆矩阵）：

| trace | 无 hint | 完美 hint | v1 | v2 | v2.1 |
|---|---|---|---|---|---|
| standard→fast，成本 $ | 630.41 | 570.80（−9.5%） | 571.80（−9.3%） | 723.36（+14.7%） | 583.61（−7.4%） |
| frontier→standard，服务的 frontier 调用 | — | 12,594 | 7,166（57%） | 11,498（91%） | 7,685（61%） |

- standard→fast 上 v2.1 比 v1 少省 $11.81，主要是质量而不是浪费：v1 把 53 个 standard turn 送到 fast，v2.1 只送了 6 个，对真正的 fast turn 也更谨慎。
- v2 的误升级成本消失了。

**决策（2026-11-05）**：v2.1 成为默认 pack（`defaultPackDir`），v1、v2 仍可按名字选择，所有规则保持 `auto: false`。

### 5.4 花费

在线评估一共花了 $1.69（上限 $1.80）：

- v1 两个模型的全量评估、轨迹和 effort 变体：$0.78；
- v2 的两轮 dev 调参和一次全量：$0.60；
- v2.1 的一次 test 运行：$0.32。

报告、阈值扫描、hint 重采样和 replay 都是离线的，不花钱。

## 6. 结论

1. **默认配置**：Luna、pack v2.1、阈值 0.8。每次咨询约 $0.0006，p95 约 1.4 s。
2. **assessor 只在 fast 边界可信**。v2.1 的 fast 精确率是 98.3%，但只有 60 次 fast 预测，而且手工标注集出自 pack 作者之手，数字偏乐观。所以规则仍然全部 observe。
3. **assessor 不能用来识别 frontier**。只看文本，看不出真实 issue 的难度。放宽 `deep`（v2）召回会上去，但误升级多到让成本反而更高。frontier 升级应主要来自显式信号（`prior_failures ≥ 2`、深度排查类措辞），core 的 frontier 降级保护要保留。
4. **对路由的价值**（合成数据）：在 standard→fast 型负载上，v2.1 的 hint 拿到完美 hint 约 78% 的节省（−7.4% vs −9.5%），送错到 fast 的 turn 极少。
5. **提示注入不是主要风险**，因为 tier 由代码从事实映射，而不是模型直接给出。
6. **稳定性可以接受，但不完美**。v2.1 多出的翻转大多在边界 turn 上，误翻转约 8%。

## 7. 局限

- **金标偏乐观**：手工标注集和轨迹由 pack 作者编写，fast 场景只来自这里（SWE-bench 没有 fast 金标）。
- **SWE-bench 的金标粗**：按修复时间分桶，部分 `15 min–1 h` 的 issue 可能真的需要深度推理，所以误升级里可能有标签噪声。
- **样本小**：SWE test 只有 18 条 frontier，轨迹只有 16 条，fast 预测只有约 60 次。
- **卡片和真实会话不同**：SWE-bench 卡片只有 issue 文本，没有会话历史、工具调用、失败次数这些真实会话里有的信号。
- **replay 的收益来自合成 trace**：负载形状是参数化生成的，不是线上数据。
- **单次运行**：每个 pack 在 test 上只跑了一次，没有测运行间的方差（v1 和 v2 在轨迹集上有 11/80 条结果不同）。

## 8. 后续怎么优化

### 8.1 先拿真实数据（最重要）

离线数据已经到头了：在线预算基本用完，留出集也已经用过。下一步的依据应来自 observe 模式下的真实会话。

1. **先补上 observe 的记录（前置条件）**。现在规则全部 `auto: false`，assessor 只在 basis 里的规则都开了 auto 时才返回 `tier`，所以决策对象里的 `assessment` 只有状态、置信度、延迟和成本，看不到"本来会给哪个 tier"。`proposedTier`、`basis`、`outcome` 只在 assessor 的 `audit` 里，而 `audit` 可能引用 prompt 文本，core 有意不带它，router 目前也不记录。要做的是：把这三个只含 id 和枚举的字段（不含任何文本）带进 `Decision.assessment` 或单独记一条日志。这是 core / router 的契约变更，需要评审。
2. **在 observe 模式上线**。有了上一步，每个决策都能对齐：assessor 的意见、`wouldChoose`、实际服务的模型和后续结果。
3. **建真实标注集**。抽样 observe 记录，由不写 pack 的人独立标 tier；按（规则，tier）分层抽样，保证 fast 预测有足够样本（目标每条 fast 规则至少 100–200 次预测）。标注数据要脱敏，只存结构化字段，不存 prompt 原文。
4. **加结果信号作弱标签**：同一 lineage 后续是否失败重试、是否被用户打断、是否切到更高档、工具错误率。它们可以发现误判 fast 的候选，再由人确认。

### 8.2 按规则逐条放开 auto

- 每条 fast 规则单独评估：真实数据上 fast 精确率 ≥ 95%、样本数够、置信区间下界也满足时，才把这条规则的 `auto` 打开。先开 `explore-readonly`（风险最低），再开 `mechanical-edit`。
- 按 [架构文档 §10.1](architecture.zh-CN.md#101-上线节奏) 的节奏一步一步改；任何指标变差，把 `auto` 关掉即可，不需要发版。
- frontier 规则不开 auto；`assessorDowngradeFrom` 维持只有 `['standard']`。

### 8.3 改进 pack 的流程

每次改 pack 都按同一流程：

1. 复制成新目录（如 `prompts/assessor/v2.2/`），在 `packDirs` 里登记，旧版本保留；
2. 一次只改一个方面（某条规则的文本、某个事实定义、某个示例），便于归因；
3. 示例自己写，不从任何评估集里取；跑测试确认不重叠、每个示例都映射到自己的标签；
4. **只在 dev 上迭代**；留出集只跑一次。SWE test 已经被 v2、v2.1 用过，下次需要新的留出集（如从真实标注集里留出一部分）；
5. 用同一批数据出报告，和当前默认 pack 对比；再用 `hints` + replay 看成本和质量；
6. 跑之前先估花费：每次约 $0.0006，543 条约 $0.33。

### 8.4 具体的改进方向

| 方向 | 做法 | 预期 |
|---|---|---|
| fast 覆盖率 | v2.1 对真正的 fast turn 偏谨慎（standard→fast trace 上 fast 调用 4,093，完美 hint 为 4,684）。看"fast-unsettled"和"低置信度"的样本，补充 `fully-specified` 的正例示例 | 在不降精确率的前提下多拿到 fast 节省 |
| frontier 信号 | 不再靠模型判断深度；改为让 card 带更多会话事实（前几轮工具错误数、同一问题的重试次数、上下文规模），由 `mapTier` 用确定性规则升级 | 召回来自可验证的信号，不带来 v2 那样的误升级 |
| 稳定性 | 测量在 core 的迟滞下，边界 turn 上 hint 驱动的降级是否可以豁免 count 门（架构文档 §14 的待决策项） | 少翻转，或者在边界上更快跟上 |
| 延迟 | Luna 的隐式缓存命中不稳定（手工 66%，SWE-bench 并发时 1%）。可以把系统前缀做得更稳定，或者测试显式缓存 | p95 再降、成本再降 |
| 失败的咨询 | 对超时 / 错误的缓存结果加短 TTL（架构文档 §14） | 避免一次超时让整个 turn 都没有意见 |
| 其他模型 | Haiku 精确率更高但太慢；如果改成异步（下一轮生效）或者放宽预算，可以重新评估 | 多一个更保守的选项 |
| 评估本身 | 同一 pack 跑 2–3 次测方差；给精确率报置信区间；扩充轨迹集（目前 16 条） | 区分真实改进和噪声 |

## 9. 复现命令

在线命令都会调用模型并计入账本，运行前先确认预算。环境变量：`set -a && . scripts/local.env && set +a`（需要 `LLMAR_SPIKE_ACCOUNT`）。

```bash
cd packages/assessor
# 准备数据（只需一次；写入 gitignore 的 data/）
node src/eval/cli.ts fetch swebench
# 只看会跑哪些条目，不调用模型
node src/eval/cli.ts dry-run --dataset hand,swebench,traj --swe-split test
# 在线评估（计入账本；--pack 默认 v2.1）
node src/eval/cli.ts run --models luna --dataset hand,swebench,traj --swe-split test --pack v2.1 --out data/eval-runs/<name>.jsonl
# 离线报告（含阈值扫描）
node src/eval/cli.ts report data/eval-runs/<name>.jsonl --swe-split test --out <dir> --name <base>
# 按实测混淆矩阵重采样合成 trace 的 hint
node src/eval/cli.ts hints --trace <trace.jsonl> --run data/eval-runs/<name>.jsonl --model luna --out <hinted.jsonl> --seed 7

cd ../replay
# 生成合成 trace（standard 为主，30% 的 turn 需要 fast）
node src/cli.ts synth agent <trace.jsonl> --sessions 400 --seed 2026 --alt-share 0.3 --pair standard-fast
# 在原始 / 重采样后的 trace 上对比策略
node src/cli.ts replay --trace <hinted.jsonl> --policy hint-blind,core-cost --hints cooperative --out <report.json> --md <report.md>
```

## 10. 文件索引

| 位置 | 内容 |
|---|---|
| [packages/assessor/src/eval/](../../packages/assessor/src/eval/) | 评估 CLI、harness、数据集解析、报告、hint 重采样、账本和脱敏 |
| [packages/assessor/eval/](../../packages/assessor/eval/) | 手工标注集和轨迹集（已提交） |
| [packages/assessor/prompts/assessor/](../../packages/assessor/prompts/assessor/) | prompt pack v1、v2、v2.1 |
| `packages/assessor/data/` | SWE-bench 原始数据和运行结果（gitignore，不提交） |
| [tasks/11-04-llm-tier-assessor/research/](../tasks/11-04-llm-tier-assessor/research/) | 各轮报告（`assessor-eval*.{json,md}`）和汇总 README |
| [tasks/11-04-llm-tier-assessor/design.md](../tasks/11-04-llm-tier-assessor/design.md) | 设计：评估方案（§10）、pack v2 / v2.1（§13） |
