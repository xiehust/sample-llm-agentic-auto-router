# 73: assessor runtime settings, pack manifest, decision-record display

Research note for design §3 (assessor part) and R3/R4. Author 73, 2026-11-08. Design only: no code, AWS or commits.
Companion file: `decision-codes.json` (code → en/zh-CN label + one-line description, plus parse patterns).

Sources read: `packages/router/src/{assessor,account,config,main,server,beta}.ts`, `packages/assessor/src/{assessor,pack,map,schema}.ts`,
the four packs, `packages/core/src/{types,decide,assess,record,engine}.ts`, `packages/router/Dockerfile`, `infra/src/stack.ts`.

## 0. Findings that shape the design

1. **Records cannot resolve rule text today.** `AssessorLog` has `id` = `assessor/v2.2@<model>` but no `packVersion`.
   All four packs use the same four rule ids, but the text differs: v2.2 `deep-investigation` means "open-ended design
   or repeated failure", v1's means "unclear root cause across modules, …". v2.2's content also changed on 2026-11-07
   under the same pack id. So resolving needs `packVersion` (`<pack id>+<sha256[:12]>`) in every assessor record (A5).
2. **The assessor is an engine option.** Core takes `assessor`, `assessorMode`, `assessorTimeoutMs`,
   `assessorMinConfidence` in `createEngine`, and the memo lives inside the engine. Changing the assessor at runtime
   means building a new engine. The same holds for a policy swap, so both should use one "generation" mechanism
   with 0d's policy swap (A3). No core change is needed: `createEngine` is pure and cheap, and the state store is shared.
3. **Per-turn reuse is keyed only by `pack.id@model`.** Core's memo and `SessionState.assessed` are matched on
   `assessorId`. A change to threshold, autoRules or pack content (same id) would reuse the old opinion for a turn that
   is already in progress, and `assessed.tier` was computed under the old autoRules (the tier is present only when
   auto-eligible). A settings fingerprint in the id passed to core fixes this (A4).
4. **`decision.reason` is free text with a stable grammar** (`<code>[:<variant>]: <text>; family=… est=…[; flags]`).
   The console needs a tested parser, not ad-hoc regexes (§3.1). The text holds model ids, `previous_response_id`
   values and an `est=` count. These are client-influenced, so the console renders them as text only.
5. Current pack versions (computed from HEAD with `renderSystem`):
   `assessor/v1+ee49d3c06e8d`, `assessor/v2+3893290b1a13`, `assessor/v2.1+2696c56a9c6c`, `assessor/v2.2+e2183dce2cb9`.

## 1. Assessor settings at runtime

### 1.1 Fields

All fields are required in the config document, so the diff shows real values. The console pre-fills
`ASSESSOR_DEFAULTS`.

```json
"assessor": { "mode": "observe", "pack": "v2.2", "packVersion": "assessor/v2.2+e2183dce2cb9",
              "model": "global.openai.gpt-6-luna", "threshold": 0.8, "timeoutMs": 5000, "autoRules": "pack" }
```

| Field | Runtime? | Validation (reject unless noted) | Console warning (save allowed) |
|---|---|---|---|
| `mode` | yes | `off \| observe \| auto` | off→observe/auto: "starts paid calls; adds up to timeoutMs+100 ms on each consulted turn". Show the mean assessor cost/consult from records |
| `pack` | yes | a pack name bundled in the **running image** (manifest §2) | the pack's mapping differs from the current one (e.g. v2.2 drops `fact:deep` from frontier) |
| `packVersion` | written by the console | must equal the manifest entry for `pack` at save time. Router-side mismatch: warn and apply (§1.2) | — |
| `model` | yes | in the region catalog; `selectAdapter` succeeds; in the task role's invokable set (`allowedModelUniverse` from design §3, today the policy's models, as `config.ts` checks) | a frontier-priced model as assessor |
| `threshold` | yes | finite, 0 ≤ t ≤ 1. It is both the pack mapping's low-confidence cut and core's `minConfidence` (same value, as today) | outside 0.6–0.95 |
| `timeoutMs` | yes | integer 100–10000 | < 2000 ("most Codex-sized cards time out": p50 ~1.5 s, p95 ~2.1 s); > 5000 (latency) |
| `autoRules` | yes | `pack \| all` | `all` = experiment switch: requires a change comment and is shown with an amber badge |
| cross-field | — | `mode=auto` ∧ `autoRules=pack` ∧ no rule with `auto:true` in the pack → reject (today's `config.ts` rule: shipped v2.1/v2.2 have none, so auto would do nothing) | `mode=off`: the other fields are kept (so off→observe restores them) but ignored |

Not runtime-editable, and why:
- **Per-rule `enabled`/`auto` toggles:** `enabled` changes the rendered prompt, so it would create a pack no image ships
  and nothing calibrated. `auto` changes behaviour without a version. Ship a new pack instead; `autoRules: all` covers
  the experiment case. The console shows the flags read-only.
- **`assessorDowngradeFrom`** (core default `['standard']`), `maxOutputTokens`, `reasoningEffort`, `api`, `cache`:
  code constants that eval results depend on. Changing them is a code review, not a toggle.
- **Widening the invokable model set:** IAM, so it stays a CDK deploy (design §3).

### 1.2 What happens on a change

Rule: a request takes one snapshot of the generation (`{configVersion, policy, engine, assessor?}`) when it starts and
uses it to the end. A swap only affects requests that start after it.

| Change | In-flight request | Next requests | Per-turn reuse (memo / `state.assessed`) |
|---|---|---|---|
| any | finishes on its snapshot. A running consultation completes or times out under the old settings. Its log line shows the old settings and `configVersion`, which is what actually happened | new generation | new engine ⇒ new, empty memo. The old memo is garbage-collected |
| off → observe/auto | no assessor in the snapshot | consulted at the next eligible point (start points; user-text turns) | n/a |
| observe → auto | — | the next consultation's auto-eligible opinion may act. Lineages are re-judged only at their next consultation point; nothing moves retroactively | **kept** (the opinion does not depend on mode) |
| auto → observe | — | no further moves by the assessor. Lineages it moved stay on their model until their next break point (core never switches in observe) | kept |
| * → off | — | no consultations; records stop carrying `assessor` | n/a |
| pack / model / threshold / autoRules | — | new id fingerprint | **invalidated** (A4): a retry of the current turn consults again (at most one extra call per active turn) |
| timeoutMs | — | new bound | kept (a cached `timeout` status for the same turn is reused; the next turn uses the new bound) |

- **Concurrency:** a turn whose first call ran on the old generation and whose retry runs on the new one can be consulted
  twice. Spend for that is bounded by one call per active turn and shows in the record's `costUsd`.
- **Spend safety:** off→observe is the only change that starts spending. The console asks for confirmation and shows
  the expected cost per 1000 consulted turns from recent records.
- **Pack drift** (the active config names `pack` X with packVersion H, but the image now bundles X with packVersion H′,
  e.g. after an image deploy that changed v2.2's content): **warn and apply**. The router runs the bundled X, sets
  `drift` on its `config` line (A6), and emits a `ConfigWarnings` metric. The console shows a banner: "the image's v2.2
  differs from the version approved in config v#n; review the rules and re-save". Rejecting would be worse. At boot
  it would drop the admin's whole config (policy included) for a CDK fallback, and records stay correct anyway
  because each one carries the packVersion actually used.
- **Precedence at boot** (0d owns the rule; proposal): the active config document wins over `ROUTER_ASSESSOR_*` env.
  The env vars are the fallback when no document exists, which is today's behaviour.

### 1.3 Router-side change (proposal for the runtime-config child task)

- **A1. Preload packs at boot.** Add `bundledPacks(): ReadonlyMap<PackName, { pack, packVersion }>` to
  `@auto-router/assessor`, built with `loadPack` + `renderSystem` over `packDirs`. An invalid pack exits with 1 (image
  bug, caught by the deployment circuit breaker). Boot also checks the computed packVersions against `manifest.json`
  (§2) and exits with 1 on a mismatch. With A1 a swap never reads the filesystem, and off→observe is just
  `createRouterAssessor(settings, bootDeps)` with a preloaded pack.
- **A2. One validator for env and document.** Split `assessorSettings(env, …)` in `config.ts` into env → raw object →
  `validateAssessorSettings(raw, ctx)`. `ctx` = `{ catalog, invokableModels: ReadonlySet<string>, packs: ReadonlyArray<{ name,
  packVersion, autoCapable }> }`. The function returns `{ ok: true, value } | { ok: false, issues: string[] }`. It is pure
  (no `node:fs`, no pack bodies), so the console Lambda imports the same function and passes manifest entries (R3:
  "validated with the router's own validators"). Export it from a subpath (`@auto-router/router/settings`) next to 0d's
  document validator.
- **A3. Generation holder.** `runtime.ts`: `RuntimeRef { current(): Generation; apply(doc): { ok: true } | { ok: false, issues } }`,
  where `Generation = { configVersion, policy, engine, assessor?, allowed }`. `apply` validates the document,
  builds `createRouterAssessor` (try/catch → issues) and `createEngine({ policy, catalog, store, ...assessor?.engineOptions })`
  with the boot-scoped signer, transport, catalog and store, then swaps the reference. `server.ts` reads
  `deps.runtime.current()` once per request instead of the `engine`/`assessor`/`config.policy` captured at
  construction. `main.ts` builds generation 0 from the document or env. This is the same holder 0d needs for policy
  swaps, so it should be one change, not two.
- **A4. Settings fingerprint in the consultation key.** The `TierAssessor.id` given to core becomes
  `${inner.id}#${fp}`, where `fp = sha256(packVersion|model|threshold|autoRules)[:8]`. `assessorLog` writes
  `id: inner.id` (the part before `#`), so log consumers and experiments see an unchanged `id`. Mode and timeout are
  not in `fp`.
- **A5. Log fields.** `AssessorLog.packVersion` (always present, cached records included) and a top-level
  `RequestLog.configVersion` (0d may name it). Both are our own values, not client text.
- **A6. `kind: 'config'` log line** at boot and on every apply or reject: `{ configVersion, outcome: 'applied' | 'rejected',
  issues?: code[], assessor: { mode, pack, packVersion, model, threshold, timeoutMs, autoRules } | { mode: 'off' }, packs:
  [{ name, packVersion }], drift?: { pack, expected, loaded } }`. The design §4 subscription filter must also take
  `kind = "config"` (and `"boot"`). That is how the console shows "active on router: v#n since …, per task" and detects
  pack drift. The router has no inbound status API.
- **A7. Tests:** validator table (each issue above; env and document give the same result); swap during an in-flight
  consultation (the old snapshot is logged); off→observe→off; A4 (a threshold change re-consults the same turn, a mode
  change reuses it); drift warn-and-apply; a rejected document keeps the last good generation; `server.ts` uses one
  snapshot per request.

## 2. Pack manifest

### 2.1 Generation and location
- Script `packages/assessor/scripts/pack-manifest.ts` (Node type stripping; `pnpm --filter @auto-router/assessor manifest`)
  writes **`packages/assessor/prompts/assessor/manifest.json`, committed**. A golden test (`manifest.test.ts`, like
  `map.golden.test.ts`) regenerates it in memory and fails when a pack changes without regeneration.
- Why committed rather than generated in the Docker build: deterministic; rule-text changes show up as reviewable diffs;
  the console build and CDK read it without running the assessor; no build step in the image. The Dockerfile already
  copies `packages/assessor/prompts`, so the image contains it (`/app/packages/assessor/prompts/assessor/manifest.json`),
  and A1 verifies it at boot.
- No git commit or timestamp in the file (the golden test would churn, and it adds nothing beyond packVersion).

### 2.2 Shape

```json
{
  "schemaVersion": 1,
  "default": "v2.2",
  "packs": [{
    "name": "v2.2", "id": "assessor/v2.2", "packVersion": "assessor/v2.2+e2183dce2cb9",
    "card": "card/v1", "output": "assessment/v1",
    "mapping": { "frontierFacts": ["prior-failures"], "priorFailuresMin": 2, "standardFacts": ["multi-file-edit"],
                 "fastSpecifications": ["fully-specified"], "fastDepths": ["lookup", "routine"], "fastBeatsStandard": false },
    "mappingSource": "pack",
    "rules": [{ "id": "explore-readonly", "tier": "fast", "enabled": true, "auto": false, "instruction": "Read-only exploration …" }],
    "autoCapable": false,
    "examples": { "count": 11, "byTier": { "fast": 4, "standard": 5, "frontier": 2 } },
    "systemChars": 16579
  }]
}
```
- `mapping` is always the **effective** mapping. `mappingSource: "default"` marks packs without a block (v1–v2.1 use
  `DEFAULT_MAPPING`). The console can then show "fact:deep supports frontier" for v2.1 and not for v2.2 without knowing
  the default.
- `autoCapable` = some enabled rule has `auto: true`; the A2 cross-field rule uses it.
- Example cards and outputs are left out (count only). Instruction text is public repo content.
- Current values: v1 10 examples (4/3/3), v2 13 (4/4/5), v2.1 11 (4/4/3), v2.2 11 (4/5/2); all rules enabled, none auto.

### 2.3 Keeping the console in sync with the deployed image
- CDK synth reads `manifest.json` from the same worktree it builds the image from (deploy-from-clean-worktree rule),
  so image and manifest come from the same commit. It deploys:
  - `packs/current.json` (the manifest) to the console bucket, with its sha256 in the console-api env;
  - **one `packs/<packVersion>.json` per pack into an append-only archive** (BucketDeployment `prune: false`, never
    deleted, a few KB each). This archive is what lets old records resolve.
- The console's pack picker lists `packs/current.json`. The router's `config` lines (A6) report the packVersions the
  running tasks actually loaded. If they differ from `current.json` (console deployed separately, or a rollout in
  progress), the Assessor page shows "image and console disagree" and save is blocked until they match. Records keep
  resolving through the archive either way.
- Backfill (optional): the script takes `--rev <git rev>` to emit the manifest of an older commit (through a temporary
  worktree), for packVersions seen in imported pre-console logs.

### 2.4 Resolving a record's basis to rule text
1. `assessor.packVersion` present (every record after A5) → `packs/<packVersion>.json` → rule by id → tier, instruction,
   `enabled`/`auto` at that version. Exact.
2. Absent (records before A5): usage-ingest fills it from the same ECS task's log stream. The `boot` line already
   carries `assessor.packVersion` (main.ts), and ingest keeps `STREAM#<logStream> → packVersion` from the `boot`/`config`
   lines it sees. Exact when the boot line was ingested.
3. Otherwise: take the pack id from `assessor.id` (before `@`) and use the archive entries with that id. If there is
   exactly one, it is used. If there are several, show the newest with an "approximate: record predates pack-version
   logging" badge and list the alternatives.
4. Pack-independent basis codes (`fact:*`, `low-confidence`, `conflict:fast+frontier`, `fast-unsettled`, `no-rule`,
   `other`) come from `decision-codes.json`. Their meaning depends on the pack's mapping, so the tooltip quotes the
   archive's mapping (e.g. `fact:deep` cannot appear under v2.2).
5. A rule id missing from the resolved pack → raw id plus "not in <packVersion>" (notice tone).
- Display: rule title (`ruleTitles`, en/zh) · tier chip · the English instruction, untranslated (it is the prompt the
  model saw) · packVersion short hash. Example: *Basis: deep-investigation [frontier]: "Open-ended design or
  architecture work …" (v2.2 · e2183dce2cb9)*.

## 3. Decision record display

### 3.1 `decision.reason` grammar and parser

```
reason  := [ "observe-default: " ] core [ " [would-choose beta-incompatible: " beta "]" ]
         | "beta-incompatible: " beta                                   (auto-mode beta veto replaces the reason)
core    := code [ ":" variant ] ": " text "; family=" fam " est=" int
           [ "; gate-fallback" [ ":current" | ":cheapest" ] ] [ "; assessor-downgrade-guarded " tier "→" tier ]
```
- `code` = text before the first `:` (core's `reasonCode()`); `variant` = text between the first `:` and the first
  `": "` when the two differ (`upgrade:rule:my-rule: …` → variant `rule:my-rule`; `downgrade-rejected:cost`;
  `compaction:hint`).
- Codes whose variant is only in the text: `pin` (`x-router-pin` → `pin:hint`, `concrete model` → `pin:concrete`,
  `no pool for` → `pin:no-pool`); `retain` (`retain: prefill | boundary-gated | same-tier | no-higher-tier |
  no-lower-tier`); `failover` (`profile` / `sibling` / `exhausted`). `hard-lock` is told apart by `decision.point`.
- Tier source: `via (\S+)` in break-point and forced-move texts, or the `upgrade:` variant. Values: `hint`, `alias`,
  `rule:<id>`, `session-tier`, `session-tier:pending`, `assessor(<conf>)`, `default`.
- **Proposal:** `parseReason(reason) → { key, code, variant?, source?, flags[], family?, est?, observeDefault, text }`
  in `@auto-router/core` next to `reasonCode`. It is tested against every reason `decide.test.ts` produces, and
  usage-ingest stores its output (key, source, flags) next to the raw text so the console filters on codes. A later,
  optional step is to log `decision.code`/`variant` directly; that is not needed for v1.

### 3.2 Code table (labels; full en/zh-CN descriptions in `decision-codes.json`)

| Group | Code | en | zh-CN |
|---|---|---|---|
| action | initialize · retain · switch · pin | Initialize · Retain · Switch · Pinned | 初始选择 · 保持 · 切换 · 固定 |
| point | pinned | Pinned | 固定 |
| | hard-lock-tool-loop · -response-chain · -state | Locked: tool loop · response chain · non-portable state | 锁定：工具循环 · 响应链 · 不可迁移状态 |
| | session-start · subagent-start · task-start | Session start · Sub-agent start · Task start | 会话开始 · 子代理开始 · 任务开始 |
| | idle-expired · compaction · prefix-reset | Cache expired (idle) · Compaction · Prefix reset | 缓存过期（空闲）· 上下文压缩 · 前缀重置 |
| | user-turn · failover | User turn · Failover | 用户轮次 · 故障转移 |
| mode | observe · auto | Observe · Auto | 观察 · 自动 |
| reason | pin:hint · pin:concrete · pin:no-pool | Pinned by x-router-pin · concrete model · no pool for dialect | 由 x-router-pin 固定 · 具体模型 · 该协议无模型池 |
| | session-start · subagent-start[:hint] · task-start | Chosen at session / sub-agent (hint) / task start | 会话/子代理（提示）/任务开始时选择 |
| | compaction:hint · compaction:shrink · idle-expired · prefix-reset | Chosen after compaction (hint / prompt shrank) · idle expiry · prefix reset | 压缩后选择（提示/提示缩短）· 空闲过期后 · 前缀重置后 |
| | gate-forced · gate-recover · ineligible | Forced by context size · Recovered after context gate · Current model not eligible | 因上下文长度被迫切换 · 限制解除后恢复 · 当前模型不可用 |
| | chain-state-missing · hard-lock | Response chain without router state · Locked | 响应链缺少路由状态 · 锁定 |
| | retain:prefill · boundary-gated · same-tier · no-higher-tier · no-lower-tier | Retained: prefill · switches only at break points · already on tier · no higher · no lower tier | 保持：预填充 · 仅在决策点切换 · 已在目标层级 · 无更高 · 无更低层级 |
| | upgrade · downgrade | Upgraded · Downgraded (pays off) | 升级 · 降级（划算） |
| | downgrade-rejected:min-turns · max-switches · cost | Downgrade held: too soon · switch limit · saving too small | 暂缓降级：距上次切换太近 · 已达上限 · 节省不足 |
| | failover:profile · sibling · exhausted | Failover: other profile · same-tier model · exhausted | 故障转移：其他推理配置 · 同层级模型 · 已用尽 |
| | failover-cross-model · failover-chain-locked · beta-incompatible | Failover inside a tool loop · blocked by response chain · Changed for a beta feature | 工具循环内转移 · 响应链阻止转移 · 因 beta 功能调整 |
| flag | observe-default · gate-fallback[:current\|:cheapest] · assessor-downgrade-guarded · would-choose-beta-incompatible | Observe default served · Context gate fallback · Assessor downgrade blocked · Projection adjusted for beta | 按观察默认模型提供 · 上下文门控回退 · 已阻止评估器降级 · 预测已按 beta 调整 |
| source | hint · alias · rule:<id> · session-tier[:pending] · assessor(<c>) · default | Client tier hint · Model alias · Policy rule <id> · Session tier · Assessor (confidence c) · Pool default | 客户端层级提示 · 模型别名 · 策略规则 · 会话层级 · 评估器（置信度）· 模型池默认 |
| field | wouldChoose · estimate.stayUsd · switchUsd · horizonCalls | Auto would choose · Est. cost if staying · if switching · Horizon (calls) | 自动模式将选择 · 保持估算成本 · 切换估算成本 · 评估窗口 |
| miss | model_changed · ttl_expired · prefix_changed · unknown | Model changed · Cache TTL expired · Prompt prefix changed · Unexplained miss | 模型已变更 · 缓存 TTL 已过期 · 提示前缀已改变 · 原因不明 |
| assessor.status | ok · unavailable · timeout · error · invalid | Answered · Unavailable · Timed out (router bound) · Error · Invalid result | 已回答 · 不可用 · 超时（路由器上限）· 错误 · 结果无效 |
| assessor.outcome | fast · standard · frontier | Proposed fast / standard / frontier | 建议 fast / standard / frontier |
| | low-confidence · conflict · fast-unsettled · no-rule | No opinion: low confidence · conflicting rules · fast not settled · no rule | 无意见：置信度低 · 规则冲突 · fast 未确认 · 未命中规则 |
| | skipped:no-user-text · skipped:trivial-followup | Skipped: no user text · acknowledgement | 跳过：无用户文本 · 简单确认 |
| | unavailable:{timeout,transport,http-NNN,parse,invalid,refusal,incomplete,card-invalid,aborted,internal} | Unavailable: assessor timeout · network · HTTP NNN · unreadable · failed validation · refused · truncated · card invalid · aborted · internal | 不可用：超时 · 网络 · HTTP · 无法读取 · 未通过校验 · 拒答 · 截断 · 任务卡无效 · 中止 · 内部错误 |
| assessor.basis | <rule id> | from pack archive (§2.4) | 来自评估包存档 |
| | fact:deep · fact:prior-failures · fact:multi-file-edit | Fact: deep reasoning · repeated failure · multi-file edit | 事实：深度推理 · 多次失败 · 多文件修改 |
| | low-confidence · conflict:fast+frontier · fast-unsettled · no-rule · other | (no-opinion codes) · Sanitized value | （无意见代码）· 已清洗的值 |
| assessor.guard | assessor-downgrade-guarded | Downgrade blocked | 已阻止降级 |
| assessor.autoRules | pack · all | Pack flags · All rules and facts (experiment) | 按评估包标记 · 全部规则与事实（实验） |
| assessor fields | proposedTier · tier · applied · cached · called | Proposed tier · Opinion seen by the router · Applied · Reused · Model called | 建议层级 · 路由器采纳的意见 · 已应用 · 复用 · 已调用模型 |
| request.reason | not-found · hop-auth-unconfigured · principal-not-gateway · source-account-mismatch · body-too-large · invalid-json · pin-not-allowed · decide-failed · client-aborted · client-abort · stream-duration-cap · mid-stream · upstream-* · internal · expect-continue-forbidden · fault-inject:* | see JSON | 见 JSON |

Explanations of the subtler fields (also in the JSON):
- `proposedTier` vs `tier`: proposedTier is what the pack's mapping concluded. `tier` is what core saw, and is absent
  unless every basis entry is auto-eligible (`autoRules`). Under shipped packs with `autoRules: pack`, `tier` is
  always absent: the assessor only advises.
- `applied` is true only in auto mode when the opinion changed the chosen model. A guarded opinion is never applied.
- `cached`: same user turn (retry or parallel call). No call, no cost; `basis`/`outcome` are not repeated, and the console
  links to the record that consulted.
- `skipped:*` has status `ok` with confidence 0, `called: false` and cost 0.

### 3.3 Frontend JSON contract (`decision-codes.json`)
- `groups[<group>].codes[<key>] = { label: {en, zh-CN}, desc: {en, zh-CN}, tone }`, with tone ∈ neutral | positive |
  notice | warning | error (badge colour).
- `patterns[] = { group, match (regex), label, desc, tone }` for parametrized codes (`rule:<id>`, `assessor(<c>)`,
  `unavailable:http-NNN`, `upstream-*`, `beta:<name>`, `chatIncludeUsage:<v>`). `{1}` = capture group.
- Lookup: exact key, then the first matching pattern, then `fallback` ("Unrecognized code: {code}"), so a newer router
  never breaks an older console.
- `ruleTitles[<rule id>]` = short en/zh titles for list views. Authoritative rule tier and text always come from the archive.
- Ownership: keys are the contract (73/0d keep them in step with core and router). Copy is a draft for 4f. Ship the file
  with the SPA and add a test that every code literal in `decide.ts`/`assessor.ts`/`map.ts`/`server.ts` has an entry.

### 3.4 Suggested record layout (R4)
`Decision` card: action chip · point · reason label (+ source chip, flags), then the raw reason in monospace on expand ·
model / wouldChoose · estimate (stay vs switch, horizon) · miss badge. `Assessor` card: mode + autoRules · status/outcome ·
proposed → seen tier · confidence vs threshold · basis list (rule title, tier, instruction, packVersion) · guard ·
applied · latency · cost · cached link. Session timeline: one row per record with action and tier chips. A switch row
is followed by any `model_changed` miss on the next record of the same lineage.

## 4. Open points for 0c / 0d
- 0d: confirm one generation holder for policy and assessor (A3), and the document-over-env precedence.
- a3: the subscription filter must include `kind = "config"`/`"boot"` (A6, §2.4 step 2).
- 4f: final copy for `decision-codes.json`; whether rule instructions get a zh gloss (recommendation: no, show the
  English prompt text plus the zh title).
