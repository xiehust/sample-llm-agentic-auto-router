# 0d research: cost-saving methodology (design §5) and core policy hot swap (design §3)

Author 0d, 2026-11-08. Scope: design only; replaces 0c's draft §5 and fills the core part of §3. Code read:
`packages/core/src/{engine,decide,record,warmth,cost,assess,policy,types}.ts`, `packages/pricing/src/{cost,types}.ts`,
`packages/router/src/{account,server,main}.ts`, `packages/router/config/policy.default.json`. Fixture figures were
computed with the real `costOf` (scratch script outside the repo) and match the hand calculation.

## 0. Decisions in one screen

- **Savings = repricing the same token classes per request, against a static baseline that never switches.**
  Per line: actual `A`, warm-equivalent actual `A*`, baseline `B`, assessor `X`. Routing effect `R = B − A*`,
  switch penalty `S = A − A*`, net `N = B − A − X = R − S − X`. Negative values are shown, never floored.
- **Default baseline `static`**: the alias's own tier (`auto` → the pool's `defaultTier`, i.e. standard;
  `auto:fast` → fast). This answers the user's question ("routed to fast instead of standard") without counting
  as saved what the client chose itself. Also offered: `tier:standard`, `tier:frontier`, `observe-default`.
- **The switch penalty cannot be derived from today's log line** (§1.2). The router adds one field on switch
  lines only: `switchedFrom: { model, warmTokens }`, computed in `record()` from lineage state.
- **The router adds `catalogVersion` to every model line.** Repricing with a different catalog than the one behind
  `costUsd` corrupts every difference.
- **Observe "projected if auto" must carry forward along the lineage.** The per-request `wouldChoose` equals the
  served model on every hard-locked call, which is most calls in agentic sessions. Core adds
  `decision.projected: { model, switch }` (from an optional `SessionState.projected`). The result is exact for the
  shipped `userTurn: 'retain'` policy and approximate under `cost-gated` (§1.6).
- **Prompt-cache saving is a separate KPI, net of the write premium**: `Cnet = costOf(noCache(u)) − A`.
- **Hot swap = a new `Engine` over the same `StateStore`, taken as one snapshot per request.** No
  `engine.setPolicy`: core's `Engine` stays immutable, and every request is decided, forwarded and recorded under
  one snapshot. State needs no migration.
- **Semantics: a swap never breaks a hard lock.** A lineage keeps its served model until a decision point at which
  the new policy may move it. Two existing defects must be fixed before hot swap ships:
  1. The router's allowed-model check is fixed at boot (`server.ts:98`, `:211`). A lineage hard-locked on a
     removed model would get a 400 mid-tool-loop.
  2. Observe mode serves `observeDefaults` on every call (`decide.ts:100`). Changing the default, or flipping
     auto→observe, would move every lineage mid-tool-loop.
- **The router accepts any document that is valid on its own and never rejects based on a diff.** Tasks boot with
  no previous version, and rollback must always work. Disruptive diffs are a console confirmation, computed by a
  pure core function `policySwapEffects(prev, next)`.

---

## 1. Design §5: cost-saving methodology (frozen proposal)

### 1.1 Figures

| Figure | Definition (sums over the selected lines) | Answers |
|---|---|---|
| Spend `ΣA` | `costUsd.total`, all model/error lines with usage | what the router's traffic cost at list price |
| Baseline `ΣB_K` | same requests repriced on baseline model `b_K` (§1.4), warm-equivalent usage | what a non-routing proxy would have paid for these tokens |
| Routing effect `ΣR` | `B − A*` | price difference of the chosen models, cold-cache effects removed |
| Switch penalty `ΣS` | `A − A*` on routing switches | extra cache writes caused by moving a warm lineage |
| Assessor overhead `ΣX` | `assessor.costUsd` (uncached consultations) | spend on the tier assessor |
| **Net saving `ΣN`** | `ΣB − ΣA − ΣX = ΣR − ΣS − ΣX` | headline; may be negative |
| Net saving rate | `ΣN / ΣB` | headline as % |
| Tier matrix | `ΣR`, n and tokens per (baseline tier → served tier) cell | "sent to fast instead of standard: n requests, $R" |
| Other cold-cache cost | `A − A*` on non-routing switches (failover, policy-forced, client) | informational, not in `N` |
| Projected (observe) `ΣN̂` | §1.6 | "if auto had been on" |
| Prompt-cache saving `ΣCnet` | §1.7 | separate KPI, not a routing saving |

### 1.2 Inputs, and the three fields the router must add

Used as logged today (`RequestLog`, `account.ts:9`): `kind`, `status`, `dialect`, `requested`, `lineage`,
`decision.{action, point, mode, model, reason, policyVersion, wouldChoose}`, `servedModel`, `usage`, `costUsd`,
`failover`, `assessor.{costUsd, cached}`. Plus `principal` (design §2).

**Why the switch penalty cannot be derived from the existing fields:**
- `miss` only covers a decided model that was expected warm (`record.ts:72`, `:168`). A planned switch targets a
  cold model, so `expected = 0` and no miss is logged. `miss.reason = 'model_changed'` covers only served ≠
  decided.
- Reconstructing it at ingest would need, per lineage in order: the previous line's cached tokens, its TTL, and
  whether the prefix chain still matches. A compaction or fork makes "previous read + write" overstate the warm
  prefix. Log batches can arrive out of order, and the ingest Lambda would need lineage state.
- `record()` already holds the exact answer: `warmTokens(pre, pre.current, …)` is hash-chain matched,
  TTL-checked, and measured at `receivedAt`, the same view `decide()` used.

**New fields (router, both optional, ids and numbers only):**

| Field | When present | Source |
|---|---|---|
| `catalogVersion: string` | every `kind: 'model'` line | `config.catalog.version` |
| `switchedFrom: { model: string; warmTokens: number }` | status < 400 and lineage had `current` ≠ `servedModel` | new `RecordResult.switchedFrom` in core `record()`: `model = pre.current`, `warmTokens = warmTokens(pre, pre.current, s, s.receivedAt, {marginMs, minTokens(pre.current), blocks})` |
| `decision.projected: { model: string; switch: boolean }` | `decision.mode === 'observe'` and the request is an alias | core `decide()` (§1.6) |

`switchedFrom.model` is always a policy or universe model, so it is safe to log. The cost is one `warmTokens()` call
on switch lines only.

### 1.3 Scope and exclusions

A line is **priced** when it has `usage` and `costUsd`. It is **routable** when, in addition:
`decision` is present, `decision.action ≠ 'pin'`, and `requested` is an alias of the policy `decision.policyVersion`.
Concrete-model requests are served as asked in both modes, so they are not routing.

Excluded lines are counted by reason, and their `A` stays in spend:

| Reason | Condition |
|---|---|
| `pin` | `decision.action === 'pin'` or `requested` not an alias |
| `unmetered` | no `usage` (e.g. Chat stream without `include_usage`). With design 0.3c the line carries `usageMissing: true` and `costBoundUsd` (no `costUsd`): count n and `ΣcostBoundUsd` separately; never added to `ΣA`. |
| `unpriced` | `usage` present but `costUsd` absent (pricing error) |
| `catalog-mismatch` | `catalogVersion` ≠ the ingest's catalog version (normally only transiently during a deploy) |
| `policy-unknown` | `policyVersion` not in the config store. The console must seed the CDK-baked boot policy as a version. |
| `no-baseline` | `b_K` undefined (no pool for the dialect; `observe-default` with no default) |
| `baseline-infeasible` | `usage.promptTokens > contextWindow(b_K)` |

Error lines without usage contribute only `X` (an assessor consultation before a failed upstream call is still
spend).

### 1.4 Baselines

All baselines are static: a fixed model per (policy version, dialect, requested alias) that never switches.
Resolution uses the policy of the line's `policyVersion`, with core's own tier picker (new pure export
`modelForTier(policy, catalog, dialect, tier)` = `pickForTier` over the pool ∩ catalog ∩ dialect, so ingest and
router agree).

| `K` | `b_K` | Use |
|---|---|---|
| `static` (default) | `t = aliases[requested]`; `t = 'default'` → `pools[dialect].defaultTier`; `modelForTier(…, t)` | "what routing changed"; client-chosen tiers save nothing |
| `tier:standard` | `modelForTier(…, 'standard')` | the user's literal question; equals `static` for `auto` when `defaultTier = standard` |
| `tier:frontier` | `modelForTier(…, 'frontier')` | "vs always the best model" |
| `observe-default` | `observeDefaults[dialect]` | "vs what we served before auto". In observe mode it equals actual, so `N = −X`. |

Known limitation: an `x-router-hint` tier is a client choice but counts as routing under every `K`. The log does not
carry the hint tier, and parsing `reason` is not a contract.

### 1.5 Formulas

Notation: `u = line.usage` (`NormalizedUsage`); `P = price(servedModel)`, `Q = price(b_K)` from catalog
`catalogVersion`; `costOf` is `@auto-router/pricing` (applies the long-context tier by `promptTokens` per model).
All values are unrounded USD. Rounding happens only for display (6 decimals in the API).

**reshape(u, M)**: the same token classes as model M would bill them (`promptTokens` and `outputTokens` never
change):
1. `M.cache.mode === 'none'` or `u.promptTokens < M.cache.minTokens`: `{uncached: promptTokens, read: 0, writes: {}}`.
2. `M.cache.mode === 'implicit'`: `uncached += Σwrites`, `writes = {}` (no write premium), `read` unchanged.
3. Otherwise unchanged. A write TTL M does not offer is priced at M's default TTL (`costOf` already does this).

**warmAdj(u, w)**: what the lineage would have read had it not switched.
`k = max(0, min(w, promptTokens) − u.cacheReadTokens)`. Move `k` tokens to `cacheReadTokens`: first from
`cacheWriteTokens` in descending TTL order (12h, 1h, 30m, 5m; the prefix carries the longest TTL), then from
`uncachedInputTokens`.

**coldAdj(u, ttl)** (projection only): `cacheWriteTokens[ttl] += cacheReadTokens`, `cacheReadTokens = 0`.

**Routing switch** := `switchedFrom` present ∧ `decision.mode === 'auto'` ∧ `decision.action === 'switch'` ∧
`decision.point ≠ 'failover'` ∧ no `failover` field ∧ `servedModel === decision.model` ∧ reason code ≠
`ineligible` (policy-forced). Every other line with `switchedFrom` is a non-routing switch.

Per routable line:
```
u*   = routing switch ? warmAdj(u, switchedFrom.warmTokens) : u
A    = costUsd.total                     (ingest asserts |A − costOf(u, P).total| < 1e-9, else flag)
A*   = costOf(reshape(u*, P), P).total
S    = A − A*                            (≥ 0; 0 unless routing switch)
B_K  = costOf(reshape(u*, Q_K), Q_K).total
R_K  = B_K − A*
X    = (assessor present ∧ !assessor.cached) ? (assessor.costUsd ?? 0) : 0
N_K  = B_K − A − X  = R_K − S − X
coldOther = non-routing switch ? A − costOf(reshape(warmAdj(u, switchedFrom.warmTokens), P), P).total : 0
```
Why `u*` for the baseline: a static baseline never left its model. Under the same-trajectory assumption (§1.8), its
cache would mirror the lineage's warm prefix, so the cold writes on the switch line would have been reads. The
penalty is measured at the served model's prices, where it was really paid.

### 1.6 Observe mode: "projected if auto"

**Why per-request `wouldChoose` is wrong.** In observe mode `record()` sets `state.current = servedModel`
(`record.ts:82`), so auto is always evaluated against the observe default. On every hard-locked call (tool loop,
response chain) `wouldChoose = current = served`. A session that auto would start on fast therefore shows fast for
one request and standard for the whole tool loop that follows.

**Rule (core, `decide()` observe branch; persisted by `record()` as `SessionState.projected`):**
```
prev = state.projected ?? state.current            (undefined for a new lineage)
free = auto.point ∈ {session-start, subagent-start, task-start, compaction, idle-expired, prefix-reset}
       ∨ auto.action ∈ {initialize, switch}
projected.model  = (free ∨ prev === undefined) ? auto.model : prev
projected.switch = prev !== undefined ∧ projected.model ≠ prev
```
`record()` deletes `state.projected` on auto-mode decisions, so a later auto→observe flip starts from the true
current model. A pure ingest-side implementation of the same rule over (lineage, ts) is the fallback if 0c wants no
core change. The fixtures carry `projected`, so both give the same answer.

Per observe routable line, with `M̂ = price(projected.model)`:
```
Â     = costOf(reshape(u, M̂), M̂).total
Â_pen = projected.switch ? costOf(reshape(coldAdj(u, writeTtlFor(policy, projected.model)), M̂), M̂).total : Â
R̂_K  = B_K − Â ;  Ŝ = Â_pen − Â ;  N̂_K = B_K − Â_pen − X
```

**Exactness:**
- Under `userTurn: 'retain'` (the shipped default) the rule matches auto's trajectory: user turns retain in both
  worlds, and break points choose fresh.
- Under `cost-gated` it is approximate:
  - An upgrade back after a projected downgrade is missed. Observe sees current = desired and returns
    `retain: same-tier`.
  - Downgrade hysteresis is evaluated against the served model's warmth and counters.
- Also approximate:
  - `sessionTier: 'root'`: the inherited tier comes from the served root model.
  - Failover points: always carried.
- The projected penalty assumes the target model is cold on a projected switch. This overstates the penalty when
  the projection returns to a model visited within its TTL.
- The projection reflects the assessor mode in force. To project "policy auto + assessor auto", set the assessor to
  `auto` while the policy stays `observe`: the served model is unaffected, and `wouldChoose` then includes applied
  opinions (`decide.ts:94–107`).
- The authoritative pre-flip estimate remains replay (`packages/replay`, the R7 what-if).

### 1.7 Prompt-cache saving (separate KPI)

`noCache(u) = {uncached: promptTokens, read: 0, writes: {}}`; `Cnet = costOf(noCache(u), P).total − A`.
This is net of the write premium, so a first call that writes the prefix is negative (fixture F1). Gross read
saving (0c's `read × (input − cacheRead)`) can be shown as a secondary number. Cache hit rate stays
`cacheRead / promptTokens` (the existing `hitRate`). `Cnet` is never added to `N`.

### 1.8 Assumptions, and what each figure may and may not claim

| Assumption | Consequence |
|---|---|
| List price, catalog `catalogVersion`, region of the deployment | Not an invoice: no discounts, credits, taxes or private pricing. Label every figure "list price, catalog <v>". |
| Same usage: each request keeps its token counts on the baseline model, and the request sequence is unchanged | A different model produces different outputs, reasoning tokens, tool calls and turn counts. Per-request repricing ignores that. |
| Same cache trajectory: the baseline's cache mirrors the lineage's warm prefix; TTL and `minTokens` differences beyond `reshape` are ignored | Small for same-family pools (all shipped pools are). |
| Quality not measured | No figure says anything about task success. |

| Figure | May claim | May not claim |
|---|---|---|
| `ΣN`, `ΣR`, tier matrix | "At list price, these requests' tokens would have cost `$ΣB` on `b_K`; the router's choices changed that by `$ΣN`." | "The router saved `$N` on these tasks" or "with no quality loss". |
| `ΣS`, `ΣX` | Exact spend attributable to switches and the assessor (given the field contract) | — |
| `ΣN̂` | "Indicative, if auto had run with the same requests" | A forecast of auto's spend |
| `ΣCnet` | Prompt-cache effect on actual spend | A routing saving |

**Evidence that the same-usage assumption can flip the sign.** These links appear next to every savings figure:
- Harbor experiments (`docs/experiments/harbor-summary.zh-CN.md` §2): auto + assessor v2.1 cost **×4.06**
  (DeepSWE, `docs/experiments/deepswe-harbor.zh-CN.md`) and **×2.64–2.93** (TB 2.1,
  `docs/experiments/tbench-harbor.zh-CN.md`) the fixed-Sol (standard) arm per task. Resolve rate was not better.
- Fixed Luna (fast) was **−17.1 pp / −14.3 pp** below Sol.
- The offline Claude 5 analysis in the same summary (§6): the frontier model was cheaper per task (×0.82) despite
  higher per-token prices, because it needed fewer turns.
- Per-request repricing would have reported those runs differently. It measures prices, not outcomes.

### 1.9 Worked fixtures (for the ingest tests)

Fixture catalog `fx-1` (region `fx`). All models use family `claude`, dialect `anthropic-messages`, endpoint scope
`global`, context window 1,000,000, cache `explicit`, minTokens 512, ttls `[5m, 1h]`, defaultTtl `5m`. Prices in USD
per MTok:

| model | tier | input | output | cacheRead | write 5m | write 1h |
|---|---|---|---|---|---|---|
| `fx.frontier` | frontier | 5 | 25 | 0.5 | 6.25 | 10 |
| `fx.standard` | standard | 2 | 10 | 0.2 | 2.5 | 4 |
| `fx.standard-geo` | standard | 2 | 10 | 0.2 | 2.5 | 4 |
| `fx.fast` | fast | 0.5 | 2.5 | 0.05 | 0.625 | 1 |

Policies:
- `fx-auto-1`: mode `auto`, `userTurn: 'cost-gated'` (F2 needs a user-turn downgrade), default aliases. One pool, `anthropic-messages`, defaultTier
  `standard`, models `[fx.frontier, fx.standard (failover [fx.standard-geo]), fx.fast]`. observeDefaults
  `anthropic-messages: fx.standard`.
- `fx-observe-1`: identical except mode `observe` and `userTurn: 'retain'` (the case where the projection is exact).

Lines show only the fields ingest reads (plus `ts`/`reqId`). `costUsd` is the router's value. Expected figures use
`K = static` (b = `fx.standard` for `auto`), with `B` for `tier:frontier` where useful.

**F1: auto, session start routed to fast (no switch).**
```json
{"ts":"2026-11-08T01:00:00.000Z","reqId":"f1","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L1","catalogVersion":"fx-1","decision":{"action":"initialize","point":"session-start","mode":"auto","model":"fx.fast","reason":"session-start: tier=fast via rule:r1 → fx.fast","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","usage":{"uncachedInputTokens":500,"cacheReadTokens":0,"cacheWriteTokens":{"5m":19500},"outputTokens":1000,"promptTokens":20000},"costUsd":{"input":0.00025,"cacheRead":0,"cacheWrite":0.0121875,"output":0.0025,"total":0.0149375,"tier":"base"}}
```
Expected: `A = 0.0149375`, `A* = A`, `B = 0.05975`, `R = 0.0448125`, `S = 0`, `X = 0`, **`N = 0.0448125`**;
`B_frontier = 0.149375`, `N_frontier = 0.1344375`; `Cnet = −0.0024375` (first-call write premium); tier matrix
cell standard→fast: n = 1, R = 0.0448125.

**F2: auto, user-turn downgrade standard → fast with a cold cache, then one warm call (payback).**
```json
{"ts":"2026-11-08T02:00:00.000Z","reqId":"f2a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L2","catalogVersion":"fx-1","decision":{"action":"switch","point":"user-turn","mode":"auto","model":"fx.fast","reason":"downgrade: standard→fast fx.standard → fx.fast saving=$0.0500 need=$0.0200 H=15","policyVersion":"fx-auto-1","estimate":{"stayUsd":0.09,"switchUsd":0.04,"horizonCalls":15}},"servedModel":"fx.fast","switchedFrom":{"model":"fx.standard","warmTokens":40000},"usage":{"uncachedInputTokens":500,"cacheReadTokens":0,"cacheWriteTokens":{"5m":41500},"outputTokens":800,"promptTokens":42000},"costUsd":{"input":0.00025,"cacheRead":0,"cacheWrite":0.0259375,"output":0.002,"total":0.0281875,"tier":"base"}}
{"ts":"2026-11-08T02:00:20.000Z","reqId":"f2b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L2","catalogVersion":"fx-1","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"auto","model":"fx.fast","reason":"hard-lock: tool loop","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","usage":{"uncachedInputTokens":300,"cacheReadTokens":41500,"cacheWriteTokens":{"5m":1200},"outputTokens":600,"promptTokens":43000},"costUsd":{"input":0.00015,"cacheRead":0.002075,"cacheWrite":0.00075,"output":0.0015,"total":0.004475,"tier":"base"}}
```
Expected f2a (routing switch): `u* = {uncached 500, read 40000, write5m 1500, out 800}`, `A = 0.0281875`,
`A* = 0.0051875`, **`S = 0.023`**, `B = 0.02075`, `R = 0.0155625`, **`N = −0.0074375`**; `B_frontier = 0.051875`;
`Cnet = −0.0051875`.
Expected f2b: `A = A* = 0.004475`, `B = 0.0179`, `R = N = 0.013425`; `B_frontier = 0.04475`; `Cnet = 0.018525`.
Lineage L2 totals: `ΣR = 0.0289875`, `ΣS = 0.023`, **`ΣN = 0.0059875`**. The switch pays back after one warm call.
If ingest ignored `switchedFrom`, f2a would show `N = +0.0418125` and hide the penalty.

**F3: assessor overhead, and a failover switch (non-routing).**
```json
{"ts":"2026-11-08T03:00:00.000Z","reqId":"f3a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L3","catalogVersion":"fx-1","decision":{"action":"initialize","point":"session-start","mode":"auto","model":"fx.fast","reason":"session-start: tier=fast via assessor(0.91) → fx.fast","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","assessor":{"id":"assessor/fx","mode":"auto","autoRules":"pack","status":"ok","tier":"fast","confidence":0.91,"latencyMs":900,"costUsd":0.0004,"applied":true},"usage":{"uncachedInputTokens":300,"cacheReadTokens":0,"cacheWriteTokens":{},"outputTokens":200,"promptTokens":300},"costUsd":{"input":0.00015,"cacheRead":0,"cacheWrite":0,"output":0.0005,"total":0.00065,"tier":"base"}}
{"ts":"2026-11-08T03:05:00.000Z","reqId":"f3b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L3b","catalogVersion":"fx-1","decision":{"action":"switch","point":"failover","mode":"auto","model":"fx.standard-geo","reason":"failover: profile fx.standard → fx.standard-geo after 429","policyVersion":"fx-auto-1"},"servedModel":"fx.standard-geo","switchedFrom":{"model":"fx.standard","warmTokens":30000},"usage":{"uncachedInputTokens":200,"cacheReadTokens":0,"cacheWriteTokens":{"5m":30800},"outputTokens":500,"promptTokens":31000},"costUsd":{"input":0.0004,"cacheRead":0,"cacheWrite":0.077,"output":0.005,"total":0.0824,"tier":"base"}}
```
Expected f3a: `A = 0.00065`, `B = 0.0026`, `R = 0.00195`, `X = 0.0004`, **`N = 0.00155`**; `Cnet = 0` (300 tokens <
minTokens). A second line on the same turn with `assessor.cached: true` must add `X = 0`.
Expected f3b (failover, so not a routing switch): `u* = u`, `S = 0`, `A = B = 0.0824`, `R = N = 0`,
**`coldOther = 0.069`**; `Cnet = −0.0154`.

**F4: observe mode, carry-forward projection (lineage L4, policy `fx-observe-1`).**
```json
{"ts":"2026-11-08T04:00:00.000Z","reqId":"f4a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L4","catalogVersion":"fx-1","decision":{"action":"initialize","point":"session-start","mode":"observe","model":"fx.standard","reason":"observe-default: session-start: tier=fast via rule:r1 → fx.fast","policyVersion":"fx-observe-1","wouldChoose":"fx.fast","projected":{"model":"fx.fast","switch":false}},"servedModel":"fx.standard","usage":{"uncachedInputTokens":500,"cacheReadTokens":0,"cacheWriteTokens":{"5m":19500},"outputTokens":1000,"promptTokens":20000},"costUsd":{"input":0.001,"cacheRead":0,"cacheWrite":0.04875,"output":0.01,"total":0.05975,"tier":"base"}}
{"ts":"2026-11-08T04:00:15.000Z","reqId":"f4b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L4","catalogVersion":"fx-1","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"observe","model":"fx.standard","reason":"observe-default: hard-lock: tool loop","policyVersion":"fx-observe-1","wouldChoose":"fx.standard","projected":{"model":"fx.fast","switch":false}},"servedModel":"fx.standard","usage":{"uncachedInputTokens":300,"cacheReadTokens":19500,"cacheWriteTokens":{"5m":1200},"outputTokens":600,"promptTokens":21000},"costUsd":{"input":0.0006,"cacheRead":0.0039,"cacheWrite":0.003,"output":0.006,"total":0.0135,"tier":"base"}}
{"ts":"2026-11-08T04:20:00.000Z","reqId":"f4c","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L4","catalogVersion":"fx-1","decision":{"action":"retain","point":"compaction","mode":"observe","model":"fx.standard","reason":"observe-default: compaction:shrink: tier=standard via default → fx.standard","policyVersion":"fx-observe-1","wouldChoose":"fx.standard","projected":{"model":"fx.standard","switch":true}},"servedModel":"fx.standard","usage":{"uncachedInputTokens":200,"cacheReadTokens":4000,"cacheWriteTokens":{"5m":6000},"outputTokens":2000,"promptTokens":10200},"costUsd":{"input":0.0004,"cacheRead":0.0008,"cacheWrite":0.015,"output":0.02,"total":0.0362,"tier":"base"}}
```
Expected actual: `N = 0` on each line (served = static baseline, `X = 0`).
Expected projection:
- f4a: `Â = 0.0149375`, `N̂ = 0.0448125`.
- f4b: `Â = 0.003375`, `N̂ = 0.010125`. Literal per-request `wouldChoose` gives 0 here: this is the carry-forward.
- f4c: projected switch fast→standard, cold on standard, so `û = {uncached 200, read 0, write5m 10000, out 2000}`.
  `Â = 0.0362`, `Â_pen = 0.0454`, `R̂ = 0`, `Ŝ = 0.0092`, `N̂ = −0.0092`.
- Lineage: **`ΣN̂ = 0.0457375`** (literal `wouldChoose` would give 0.0448125, and diverges much more on long tool
  loops).

`Cnet`: f4a −0.00975, f4b 0.0345, f4c 0.0042.

**F5: exclusions.**
```json
{"ts":"2026-11-08T05:00:00.000Z","reqId":"f5a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"fx.frontier","lineage":"L5","catalogVersion":"fx-1","decision":{"action":"pin","point":"pinned","mode":"auto","model":"fx.frontier","reason":"pin: concrete model fx.frontier","policyVersion":"fx-auto-1"},"servedModel":"fx.frontier","usage":{"uncachedInputTokens":1000,"cacheReadTokens":0,"cacheWriteTokens":{},"outputTokens":100,"promptTokens":1000},"costUsd":{"input":0.005,"cacheRead":0,"cacheWrite":0,"output":0.0025,"total":0.0075,"tier":"base"}}
{"ts":"2026-11-08T05:00:01.000Z","reqId":"f5b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L5b","catalogVersion":"fx-1","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"auto","model":"fx.standard","reason":"hard-lock: tool loop","policyVersion":"fx-auto-1"},"servedModel":"fx.standard","usageMissing":true,"costBoundUsd":0.05}
{"ts":"2026-11-08T05:00:02.000Z","reqId":"f5c","kind":"error","status":503,"dialect":"anthropic-messages","requested":"auto","error":"NoEligibleModelError","reason":"decide-failed"}
{"ts":"2026-11-08T05:00:03.000Z","reqId":"f5d","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L5d","catalogVersion":"fx-0","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"auto","model":"fx.fast","reason":"hard-lock: tool loop","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","usage":{"uncachedInputTokens":100,"cacheReadTokens":0,"cacheWriteTokens":{},"outputTokens":10,"promptTokens":100},"costUsd":{"input":0.00005,"cacheRead":0,"cacheWrite":0,"output":0.000025,"total":0.000075,"tier":"base"}}
```
Expected: spend `ΣA = 0.0075 + 0.000075 = 0.007575`. Routable none. Excluded `{pin: 1, unmetered: 1,
catalog-mismatch: 1}`; unmetered bound `ΣcostBoundUsd = 0.05` (f5b: 10,000 est. prompt × $4 (max of input and write rates on fx.standard) + 1,000 max_tokens × $10; shown apart from spend). f5c adds nothing (no usage, no assessor). No B/N contributions.

**Totals over F1–F5 (static):** `ΣA = 0.247675`, `ΣN = 0.05235`.
- `ΣA` = F1 0.0149375 + F2 0.0326625 + F3 0.08305 + F4 0.10945 + F5 0.007575.
- `ΣN` = F1 0.0448125 + F2 0.0059875 + F3 0.00155 + F4 0 + F5 0.
- `ΣS = 0.023`, `ΣX = 0.0004`, `coldOther = 0.069`.

### 1.10 Ingest and rollup implications (for a3)

- Compute at ingest, per line: `A, A*, X, Cnet, coldOther`, and `B_K` for all four `K`; for observe lines also
  `Â, Â_pen`. Store the resolved `b_K` model ids. `R` and `N` derive at query time. Changing the baseline in the UI
  needs no recompute.
- Rollup key adds `baselineTier(static)` so the tier matrix is a rollup read. Store `n` and token classes per cell.
- Ingest needs the policy by `policyVersion` (cache in Lambda memory) and the pricing catalog of the same version.
  It ships in the same commit as the router image, so mismatch only happens during a deploy (`catalog-mismatch`).
- Reconciliation test: `ΣA` per member and model equals the sum of `costUsd.total` exactly (PRD acceptance), and
  `|A − costOf(u, P).total| < 1e-9` per line.

---

## 2. Design §3: core semantics of a policy hot swap

### 2.1 What today's code already does

- `createEngine` closes over one `ctx = {policy, catalog, store, assessor}` (`engine.ts:43`). `decide()` and
  `record()` read it on every call, and nothing else holds policy state.
- `SessionState` holds only model ids, counters and cache records, and is policy-independent. `assessed` is keyed by
  `assessorId`, so a pack change invalidates reuse by itself (`assess.ts` `cachedAssessment`). A threshold change
  applies to a reused raw record, because `opinionOf` runs at read time.
- Robust to models leaving a pool:
  - `failover()` returns undefined for a non-pool model, with the comment "a policy change" (`decide.ts:343–346`).
  - At a user turn, a current model outside the pool is a forced `ineligible` move (`decide.ts:240–246`).
  - `tierOfModel` falls back to the catalog tier (`gateForced.from` stays readable).
  - Hard locks retain `current` whatever the pool (`decide.ts:209–213`). With non-portable state and an empty
    eligible set, `eligible.every(…)` is vacuously true, so the lineage retains rather than throwing.
- **Defect 1 (router):** `allowed`, `aliases` and `config.policy` are captured at server creation (`server.ts:98–100`).
  They are used for the pin check, the defensive check that `decision.model` is allowed (`:211`), `poolTiers` (`:205`),
  `profileRotateOn` and `failoverTargets` (`:274–276`), and `/models` (`:126`). After a swap that removes model M, a
  lineage hard-locked on M gets `retain M`, the defensive check fails, and the request returns 400 mid-tool-loop.
- **Defect 2 (core, observe):** an alias request is always served `observeDefaults[dialect]` (`decide.ts:100`), with no
  regard to the lineage. Changing the observe default, or flipping auto→observe, moves every active lineage on its
  next call, tool loops included. That means a cold cache, and across families a non-portable-state 400 from Bedrock.
- Multiple router tasks each have their own `InMemoryStateStore` (`main.ts:16`), so a lineage's state lives in one
  task. Version skew between tasks during the poll window therefore cannot mix two policies within one lineage's
  state.

### 2.2 API: swap = new Engine, one snapshot per request (no `setPolicy`)

```ts
// router (0c's runtime-config child); core unchanged in shape
interface ActiveConfig {
  seq: number                       // console version number, monotonic
  policy: Policy                    // validated
  engine: Engine                    // createEngine({ policy, catalog, store: sharedStore, ...assessorOptions })
  pinAllowed: ReadonlySet<string>   // allowedModels(policy, catalog): client-supplied concrete ids
  aliases: ReadonlySet<string>
  assessor?: RouterAssessor         // 73's settings
}
let active: ActiveConfig            // replaced by one assignment; never mutated
// handle(): const cfg = active  — once, right after hop auth; every later step uses cfg only.
```
Why not `engine.setPolicy()`: a mutable `ctx` lets a request be decided under v1 and recorded under v2. `record()`
reads `writeTtl`, `failover.windowMs` and the pool size, and the router reads `profileRotateOn` and the failover
targets between the two. Versioned lookups inside the engine are more code for the same guarantee. Building an
engine is cheap: one `Map` over the catalog plus validation.

The one cost: the assessor's in-process memo is per engine. Two requests of the same turn that straddle the swap
instant may consult twice. This is bounded and harmless, because `state.assessed` in the shared store still gives
reuse.

### 2.3 Invariants (testable)

- **I1 One snapshot per request.** Decide, beta veto, allowed checks, profile retry, failover targets, `record()` and
  the log's `policyVersion` all use the `ActiveConfig` taken at request start.
- **I2 No in-flight effect.** A swap never aborts, delays or alters a request already past hop auth, including
  streams.
- **I3 Hard locks hold.** A swap never changes the served model of a call that is a hard lock (tool loop, response
  chain, non-portable state) in either mode. A lineage changes model only at a decision point where the new policy
  is allowed to move it (§2.4).
- **I4 Universe.** Every model any accepted config can name (pools, failover, observe defaults, assessor model) is
  in the deploy-time `allowedModelUniverse` (= the IAM grant). The router's defensive check on `decision.model`
  and the EMF `known` set use the universe, not the active policy. Only client-supplied concrete ids (body model,
  pin hint) are checked against the active policy.
- **I5 State compatibility.** No state migration and no flush on swap. New state fields are optional. A store
  tolerates unknown fields.
- **I6 Doc-intrinsic validation.** Activation runs exactly the createEngine checks:
  - `validatePolicy` and `checkPolicyAgainstCatalog`;
  - the store capability check for `sessionTier: 'root'`;
  - the assessor options;
  - universe membership.

  On any failure the current config stays and `config-rejected` is logged. The result never depends on the
  previous version.
- **I7 Ordering and idempotence.** Accept only `seq` > active `seq`; equal → no-op; lower → ignore (a stale read).
  Rollback is a new higher `seq` with old content. The console sets `policy.version = "c<seq>"`, so
  `decision.policyVersion` resolves to exactly one stored document (needed by §1.3).
- **I8 Observability.** Each activation and rejection writes one log line (`kind: 'config'`, `{from, to, result,
  issues[]}`; not matched by the usage subscription filter) and an EMF datum with dimension `ConfigSeq`, so the
  console can show "active on k of n tasks".

### 2.4 Semantics per change type

"Next decision point" = for an existing lineage, the first call that is not a hard lock: break points
(session/subagent/task start, compaction, idle-expired, prefix-reset) always; user-text turns as the policy allows.

| Change | Existing lineages | New lineages | Console severity |
|---|---|---|---|
| observe → auto | Hard locks hold the observe default. Break points choose fresh. User turns: `retain` holds, `cost-gated` may upgrade at once or downgrade through hysteresis. | auto | info |
| auto → observe | **(fix 2)** hold the auto-chosen model until the next break point, then serve the observe default | observe default | info |
| observeDefaults change | **(fix 2)** hold until the next break point | new default | info |
| model removed from a pool (still in the universe) | Hard locks hold it. Next user-text turn: forced `ineligible` move (cold cache accepted; explicit admin act). Break point: fresh choice. Failover: no profile rotation (non-pool). | not chosen | **disruptive** if it was some lineage's current in the last 1 h (from records) |
| model removed from all pools and observeDefaults | as above for routed lineages. **Client pins of it get 400 `pin-not-allowed` immediately**, an access decision. | — | **disruptive** with count of recent pin requests |
| tier remap (pool `tier` override, or entry order changing `modelForTier`) | `cost-gated`: next user turn upgrades at once if current is now below desired; downgrades are cost-gated. `retain`: next break point. | new mapping | warn: estimated switch wave = active lineages on remapped models |
| defaultTier / rules / aliases→tier | next decision point that consults desired tier | new | info |
| alias removed | requests using it get 400 immediately | — | **disruptive** with count of recent requests |
| dialect pool removed | alias requests for it throw `NoEligibleModelError` → 503 → gateway fallback, including hard-locked lineages | — | **disruptive** |
| failover lists / `profileRotateOn` / `failover.windowMs` | next failure | — | info |
| hysteresis, horizon, gate, compaction, `cache.ttlSafetyMarginMs`, `cache.writeTtl` | next evaluation. Existing cache records keep their recorded `ttlMs`. | — | info |
| `userTurn` | next user turn | — | info |
| `portability` loosened (same-model → same-family) | may let non-portable state cross models at the next move | — | warn |
| `sessionTier` on/off | next decision. Turning it on mid-session inherits the root lineage's current tier (the store check is doc-intrinsic). | — | info |
| assessor mode / pack / model / threshold / timeout / downgradeFrom | new engine's `AssessorConfig`. A pack or model change gives a new `assessorId`, so no reuse of old opinions. A threshold change re-reads stored opinions. | — | info (73 owns details) |

### 2.5 Core changes required (child task "runtime-config", core part)

1. **Observe stickiness (fix 2).** In the observe branch, for alias requests:
   - Serve `state.current` when it is set, differs from the observe default, and `auto.point` is not a break
     point. Reason prefix `observe-hold:`.
   - Otherwise serve the observe default as today.
   - Today `current` always equals the default in observe, so behaviour without a swap is unchanged; tests must
     show this.
2. **`RecordResult.switchedFrom`** (§1.2) and **`Decision.projected` / `SessionState.projected`** (§1.6). Both
   optional; fixtures stay valid.
3. **Pure exports:**
   - `modelForTier(policy, catalog, dialect, tier)` (§1.4);
   - `policySwapEffects(prev, next, catalog) → {effect, severity, detail}[]` for the console's confirmation and
     what-if (§2.4 table, without record counts, which the console adds);
   - `allowedModels` moves from router to core, or stays in the router, as 0c prefers.
4. **No `setPolicy`, no store API change.** `createEngine` already validates everything I6 needs.

Router (0c, for my later review):
- the `ActiveConfig` snapshot (I1);
- universe-based defensive and EMF checks (fix 1, I4);
- the poll/activate loop with I6–I8;
- `catalogVersion` and `switchedFrom` on the log line.

### 2.6 Reject or accept? Accept and handle.

The router rejects a document only for doc-intrinsic invalidity (I6), never because of what it changes for running
sessions:
1. **Determinism.** A task that just booted has no previous version. Diff-based rejection would let tasks diverge
   on the same document.
2. **Rollback** must always activate.
3. **Safety is already guaranteed.** With fixes 1–2, every valid swap is safe for in-flight lineages under I3. The
   remaining "disruptive" effects (alias, pool or pin removal) are deliberate admin choices, not router hazards.
4. **The right place to stop a mistake is the console.** It shows `policySwapEffects` plus counts from recent
   records (active lineages per model, pin and alias usage) and requires a typed confirmation for **disruptive**
   items.

### 2.7 Tests to add (core)

- **Swap with a model removed:**
  - a tool-loop call retains it;
  - the next user-text turn moves with reason `ineligible`;
  - a break point chooses fresh;
  - `failover()` returns no rotation for it.
- **auto→observe and an observe-default change:**
  - hard lock serves `state.current` (`observe-hold`);
  - a compaction or idle-expired break point serves the new default;
  - a no-swap observe trace is byte-identical to today.
- **Tier remap under `retain`** gives no move at user turns, and a move at the next break point. Under `cost-gated`,
  an upgrade happens at the next user turn.
- **I1:** decide on engine v1, swap, then `record()` on v1. State written equals the no-swap case, and the next
  decide on v2 reads it.
- **`projected`:** the F4 sequence gives `{fast, false}`, `{fast, false}`, `{standard, true}`, and an auto decision
  clears it.
- **`switchedFrom`:** the F2 sequence gives `{fx.standard, 40000}` on the switch call and nothing on the warm call.
  It is absent on failures (status ≥ 400).

## 3. Open points for 0c / the user

1. Confirm `static` as the default baseline. The user's wording was "vs standard", and `tier:standard` is identical
   for `auto` today.
2. Pins of a model removed by the admin: immediate 400 (recommended, access semantics) or hold within the lineage's
   hard lock?
3. Core-side `projected` (recommended) vs an ingest-side carry-forward over (lineage, ts).
4. Whether the savings page shows the projection at all before a replay-based what-if exists. Recommended: yes,
   labelled "indicative", with the §1.6 exactness note one click away.
