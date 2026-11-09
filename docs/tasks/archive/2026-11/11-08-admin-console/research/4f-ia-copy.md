# Admin console: information architecture, page specs and copy deck (4f, 2026-11-08)

Status: **aligned with design v1** (0c, 2026-11-08). Planning doc only: no code, no AWS. 0c integrates; 18
owns the frontend stack, a3 the API, ingest and identity, 0d the savings method and config semantics, 17 the
client recipes and the `llmar` CLI. Where v1 overrides draft 0, this note follows v1 (design §0 numbers in
brackets, e.g. [0.4]). Everything still marked **[open: x]** needs that owner's answer.

v1 changes applied here: catch-all gateway rule [0.3]; scope-only authorizer, so no allowed-clients list
anywhere [0.4]; pool MFA off (user decision, replaces 0.5; production hardening note: require TOTP on the pool); disable / block / budget bounds ≈ 35 s and only fully in
`require` [0.2]; daily rollups (`U#`/`A#`) kept 400 days, records 90 days; savings symbols and the `static`
baseline [0.11]; one `llmar` CLI [0.14]; Codex `auth.command` + `gateway_oauth` and the SDK `RouterAuth` recipe
[0.13]; tier limits for members and service clients, groups from `identity/principals.json` [0.16]; error codes
403 `identity-blocked`, 429 `budget-exceeded`, 400 `access-cap`, 400 `access-cap-context` [0.15–0.16]; another
caller's ids → 404 [§2.4]; router-reported `configVersion` [§2.1–2.2].

Sources: `prd.md`, `design.md` (draft 0), README / README.zh-CN "Connecting clients" (verified 2026-11-08),
`docs/experiments/harbor-summary.zh-CN.md`, `docs/architecture/architecture.zh-CN.md` (zh terms),
`packages/router/src/account.ts` (`RequestLog`, `AssessorLog`), `packages/core/src/types.ts` (`Decision`,
`DecisionPoint`, `MissReason`, `AssessmentStatus`), `packages/core/src/policy.ts` (`Policy`).

Copy deck: [`i18n/en.json`](i18n/en.json) and [`i18n/zh-CN.json`](i18n/zh-CN.json) (same keys, checked for
parity). Conventions in §7.

---

## 1. Principles for every page

1. **Show only what the router logged.** Every number traces back to log fields (`RequestLog`) or the price
   catalog. No prompt, card or output text exists anywhere in the console; the decision detail says so.
2. **Label money honestly.** Every cost is a list price from the versioned catalog (version shown in the page
   footer). Savings figures always carry three captions: list price, same-usage assumption, quality not measured
   (§5.3). Negative savings are shown as negative, never floored.
3. **Say what is not counted.** Every model name reaches the router through the catch-all rule [0.3], so only
   calls the gateway fallback served while the router was failing are missing. Calls whose stream ended before usage
   arrived are *unmetered* [0.3c]: the router logs `usageMissing` and `costBoundUsd`, an *approximate* upper bound (the prompt is
   estimated at chars/4, so it can be low for CJK text). With `boundPartial` (no output cap) the bound covers input
   only and is labelled "partial (input only)". The console shows count and bound apart from metered cost, and
   leaves them out of savings.
4. **Members see only themselves.** A member never sees another principal's id, name or totals, nor
   unattributed traffic. The server enforces this (design §6); the UI simply has no control for it.
5. **Days are UTC.** Rollups (`U#`/`A#`) are daily, keyed by UTC day, and kept 400 days; per-request records are
   kept 90 days. So charts and totals reach back 400 days, while Decisions and timelines reach back 90. Charts
   and day groupings say "UTC"; single-request timestamps show local time with UTC on hover.
6. **Plain, short sentences** in both languages, matching the zh docs (one fact per sentence, code identifiers
   in English, no marketing words).

## 2. Terminology (en / zh-CN)

Rule: a term has one translation everywhere. Code identifiers, model ids, header names and tier names stay in
English in both languages (as in the zh docs: "fast 档", `auto:fast`).

| Concept | en (UI) | zh-CN (UI) | Note / source |
|---|---|---|---|
| tier | tier | 档位 | values `fast` / `standard` / `frontier` never translated (zh docs: "frontier 档") |
| observe mode | Observe | 观察 | zh docs: 观察模式 |
| auto mode | Auto | 自动 | literal `model: auto` stays code |
| observe default (model) | observe default | 观察默认模型 | README.zh-CN |
| session (root) | session | 会话 | one agent session; `session` label in the log |
| lineage | lineage | 会话链 | zh docs keep "lineage"; UI uses 会话链, glossary tooltip shows "会话链（lineage）" |
| session label | session label | 会话标签 | sha256 prefix, never the raw id |
| sub-agent | sub-agent | 子 agent | zh docs |
| cache break point | cache break point | 缓存断点 | |
| free break point | free break point | 免费断点 | architecture §3 |
| hard lock | hard lock | 硬锁 | architecture §3 |
| cost gate | cost gate | 成本门 | architecture §3 |
| hysteresis | hysteresis | 迟滞 | architecture §3 |
| cold write | cold write | 冷写 | architecture §1 |
| hit rate (cache) | cache hit rate | 缓存命中率 | = cache read ÷ prompt tokens |
| uncached input | uncached input | 未缓存输入 | token class |
| cache read | cache read | 缓存读取 | token class |
| cache write ({ttl}) | cache write ({ttl}) | 缓存写入（{ttl}） | by TTL: 5m, 30m, 1h, 12h |
| output | output | 输出 | reasoning included |
| long-context rate | long-context rate | 长上下文价格 | pricing `tier: long` |
| list price | list price | 目录价 | from the price catalog (价格目录); not the invoice (账单) |
| price catalog | price catalog | 价格目录 | zh docs |
| baseline | baseline | 基线 | zh docs |
| counterfactual | counterfactual | 反事实 | zh docs |
| routing effect | routing effect | 路由效果 | savings decomposition |
| switch penalty | switch penalty | 切换代价 | cold-cache writes after a switch |
| assessor overhead | assessor overhead | 评估器开销 | |
| net saving | net saving | 净节省 | may be negative |
| projected if auto | projected if auto | 自动模式预估 | from `wouldChoose` |
| prompt-cache saving | prompt-cache saving | 提示缓存节省 | separate KPI, not routing |
| assessor | assessor | 评估器 | zh docs |
| pack (prompt pack) | pack | 提示词包 | zh docs |
| basis | basis | 依据 | rule ids the assessor cited |
| confidence / threshold | confidence / threshold | 置信度 / 阈值 | |
| pin | pin | 指定模型（pin） | header `x-router-hint: pin=` |
| hint | hint | 提示（hint） | README.zh-CN "`tier=` 提示" |
| alias | alias | 别名 | |
| pool (model pool) | model pool | 模型池 | per API |
| rule (policy) | rule | 规则 | |
| failover | failover | 故障切换 | router-side, profile or sibling |
| gateway fallback | gateway fallback | 网关回退 | gateway-side fixed models |
| profile | inference profile | inference profile | not translated (zh docs) |
| sibling model | sibling model | 兄弟模型 | zh docs |
| non-portable state | non-portable state | 不可移植状态 | zh docs |
| dialect / API | API | 接口 | README.zh-CN 接口 |
| principal | caller | 调用方 | a member or a service client; AWS zh docs use 主体, plainer here |
| member / admin | member / admin | 成员 / 管理员 | |
| service client | service client | 服务客户端 | client-credentials principal |
| unattributed | unattributed | 未归属 | identity header missing (identity mode observe) |
| config version | config version | 配置版本 | |
| activate / roll back | activate / roll back | 启用 / 回滚 | |
| draft | draft | 草稿 | |
| audit log | audit log | 审计日志 | |
| budget | budget | 预算 | members and service clients |
| tier limit (access cap) | tier limit | 档位上限 | config `access` + `principals.json` [0.16]; code `access-cap` |
| blocked | blocked | 被拦截 | 403 `identity-blocked` |
| identity mode off / observe / require | Off / Observe / Require | 关闭 / 观察 / 必需 | [0.2] |
| warm-equivalent cost | warm-equivalent cost (A*) | 热缓存等价成本（A*） | 0d §1.1 |
| net saving rate | net saving rate | 净节省率 | N ÷ B |
| indicative | indicative | 仅供参考 | projection label [0.11] |
| retention | retention | 保留期 | |

Enum labels (action, point, miss reason, assessor status, guard, dialect) are in the copy deck under `enum.*`.
The router's `reason` text (`'<code>: <text>'`) is shown in two parts: the code via `enum.reasonCode.*` when
known (else the raw code), and the text verbatim in monospace under "Router detail", untranslated.

## 3. Navigation

### 3.1 Global frame (both roles)

- Top bar: product name, deployment (`{prefix} · {region}`), mode badge (Observe / Auto, tooltip explains),
  language switch (English / 简体中文; persisted in `localStorage` [0.3b]; the only thing the SPA keeps there, no
  tokens), user menu (name, role, Settings, Sign out).
- Footer on data pages: "Prices: {region} price catalog {catalogVersion} (list price)" and "Records up to {time}".
- Date range picker on data pages: Last 24 hours, 7 days (default), 30 days, This month, Last month, Custom.
  Range is in the URL so links can be shared.
- Cloudscape built-in component strings (pagination, table preferences, date picker) come from its zh-CN
  locale; our strings from the copy deck.

### 3.2 Member navigation (flat)

Overview · Usage & cost · Savings · Decisions · Get started · Settings

First sign-in with no requests yet lands on **Get started**, afterwards on Overview.

### 3.3 Admin navigation (grouped)

| Group | Pages |
|---|---|
| Usage | Overview · Usage & cost · Savings · Decisions |
| Routing | Routing policy · Assessor · Gateway |
| Access | Members · Service clients |
| Operations | Health · Audit log |
| (ungrouped) | Get started · Settings |

### 3.4 Routes and access

| Route | Page | Member | Admin |
|---|---|---|---|
| `/` | Overview | own | all |
| `/usage` | Usage & cost | own | all, any caller |
| `/savings` | Savings | own | all, any caller |
| `/decisions`, `/decisions/:reqId` | Decisions, detail | own | all |
| `/sessions/:session` | Session timeline | own sessions | all |
| `/get-started` | Get started | yes | yes |
| `/settings` | Settings: My account | yes | yes |
| `/settings/deployment` | Settings: Deployment | — | yes |
| `/admin/members`, `/admin/members/:id` | Members | — | yes |
| `/admin/clients` | Service clients | — | yes |
| `/admin/policy`, `/admin/config/versions[/:v]` | Routing policy, versions | — | yes |
| `/admin/assessor` | Assessor | — | yes |
| `/admin/gateway` | Gateway | — | yes |
| `/admin/health` | Health | — | yes |
| `/admin/audit` | Audit log | — | yes |

A member who opens an admin route sees the Forbidden state (no redirect loop, no data fetched). A member who
opens another member's `/decisions/:reqId` or `/sessions/:session` gets Not found (the API returns 404, not 403,
so ids cannot be probed) [§2.4].

## 4. Page specs

Common states for every data page (copy in `state.*`): Loading; Empty (no requests in range); Empty after
filters (with "Clear filters"); Error (retry + request id); Forbidden; Sign-in expired; Data delayed (ingest
lag above 5 min: "Records are about {minutes} min behind the router."); Feature off (e.g. identity mode off →
per-caller views unavailable).

Caller display: admins see the member's name and e-mail (resolved by the console API from Cognito; never in
router logs) or the service client's name; `principal: none` shows as "Unattributed". Members see "You".

### 4.1 Overview

- **Purpose.** One look: how much, on what, is anything wrong.
- **Member data.** This month: list-price cost, requests, tokens (by class), cache hit rate; budget bar if a
  budget is set (spent / budget, alert threshold); top 3 models by cost; last request time; last 5 sessions
  (link to timeline).
- **Admin data.** This month across all callers: list-price cost, requests, active callers (7 days), net saving
  vs the default baseline (with the three captions, link to Savings); cost per day by model (UTC days); top
  callers by cost; health strip (5xx rate, failovers, signs of gateway fallback, router tasks, from Health); alerts list
  (config rejected by router, budget exceeded, ingest delayed, identity unattributed share above 5%); last 3
  config changes (link to Audit log).
- **Filters.** None besides month (current / previous).
- **Actions.** Links only.
- **Empty.** Member with no requests: "No requests from you yet." + button "Get started". Admin with no data:
  "No requests reached the router yet." + link to Get started.
- **Errors.** Each card fails on its own (card-level error with retry), the page still renders.

### 4.2 Usage & cost

- **Purpose.** Real token usage per model and its list price.
- **Data.** Chart: cost per UTC day, stacked by served model (switch: by tier, by API, by caller for admins).
  Chart: tokens per day by class. Table, grouped by a chosen dimension (caller* / served model / tier / API /
  day): requests, uncached input, cache read, cache write per TTL, output (reasoning shown as "of which
  reasoning"), cost per class, total cost, cache hit rate, errors, unmetered calls and their approximate upper bound (separate columns, never added to cost; "partial (input only)" marker when any call has `boundPartial`) [0.3c]. Totals row.
  Long-context requests are flagged (cost `tier: long`).
- **Filters.** Date range, caller* (multi), served model, tier, API, status class (2xx / 4xx / 5xx / client
  aborted).
- **Actions.** Group by, Export CSV (the current table, with catalog version and filter summary in the first
  lines), drill-down from any row to Decisions with the same filters.
- **Captions.** List price + catalog version; "Only requests that reached the router are counted…"; requests
  unmetered calls (count and upper bound, `caption.unmetered`); days are UTC.
- **Member vs admin.** Member: no caller dimension or filter. Admin: all, plus "Unattributed" as a caller.
- **Empty.** "No requests in this period."

\* admin only.

### 4.3 Savings

- **Purpose.** What routing changed in list-price cost against a baseline, decomposed, with honest limits.
- **Data (0d §1, frozen [0.11]).** KPI row: actual A; baseline B; net saving N = B − A − X = R − S − X
  (signed; negative is labelled "costs more than the baseline"); net saving rate N ÷ B; then R (routing effect,
  B − A*), S (switch penalty, A − A*) and X (assessor overhead) as their own KPIs. Separate KPI box
  "Prompt-cache saving" (Cnet, net of the write premium; not a routing effect). Tier matrix "Where requests
  went" (baseline tier → served tier: n, R). Informational "Other cold-cache cost" (A − A* on failover,
  policy-forced and client switches; not in N). A "Tier limit" row for capped requests (a forced downgrade is not
  a routing saving) [0.16]. Chart: net saving per UTC day. Table by caller* / API / served model: requests, A, B,
  R, S, X, N, N %. In observe mode a tab **Projected if auto (indicative)** from `decision.projected` (carried
  forward along the lineage), with the projection caption.
- **Baseline selector.** Requested tier `static` (default) · Always `standard` · Always `frontier` · Observe
  default (in observe mode equals actual, so N = −X). Admin sets the deployment default in Settings; any viewer
  may switch for their own view (URL parameter).
- **Captions (mandatory, always visible, not in a tooltip).** `savings.caption.listPrice`,
  `savings.caption.sameUsage`, `savings.caption.quality` (with link to the Harbor summary), plus
  `savings.caption.observe` in observe mode. Texts in §5.3.
- **Filters.** Date range, caller*, API, baseline.
- **Actions.** Export CSV (inputs and every term, so a hand calculation can reproduce it), link "How this is
  calculated" (method panel with the formulas from design §5 as frozen by 0d).
- **Empty / special.** Observe mode with baseline = observe default: actual = baseline, so N = −X; the page
  says so and points to the Projected tab. No requests: standard empty state.
- **Member vs admin.** Member: own figures only. Admin: all and per caller.

### 4.4 Decisions

- **Purpose.** Each routing decision and its basis.
- **List columns.** Time · Caller* · Session label · API · Requested (`auto`, `auto:fast`, …, or "other") ·
  Action · Point · Served model · Tier · Tokens (prompt / output) · Cost · Hit rate · Status. Icons: failover,
  cache miss, assessor consulted, hint applied, client aborted.
- **Filters.** Date range, caller*, session label (exact), API, action, point, served model, tier, status
  class, "assessor consulted", "failover", "cache miss" (with reason), mode (observe / auto), "wouldChoose
  differs".
- **Detail (drawer or `/decisions/:reqId`).** Sections and fields:
  - Request: time, reqId (copy), caller*, identity (verified / missing / invalid:<code>), session label (link
    to timeline), lineage label, API, requested, stream, body size, hints applied, sanitized edits, status,
    error code (`error.*`: identity-*, `identity-blocked`, `budget-exceeded`, `access-cap`,
    `access-cap-context`, `pin-not-allowed`), client aborted.
  - Decision: action, point, mode, model, policy version, config version, reason (code label via
    `decision-codes.json` / `enum.reasonCode.*`, incl. `access-cap`, + router detail text), tier limit applied,
    wouldChoose and projected (observe), estimate (stay / switch / horizon calls, in list-price USD).
  - Served: served model, tier, switched from (model, warm tokens), failover (from → to, status),
    gateway-differs flag, price catalog version.
  - Usage and cost: tokens by class, cost by class, total, cost tier (base / long-context), cache hit rate,
    cache miss (reason, expected vs read tokens).
  - Assessor (only when consulted): assessor id, pack and pack version, mode, auto rules, status, outcome,
    tier, proposed tier, confidence vs threshold, guard, applied, cached (reused for the same user turn),
    called, latency, cost. Basis: each rule id with its tier and instruction text from the pack manifest
    (pack text in the pack's language, not translated).
  - Timing: body read, decide, router overhead, upstream first byte, total.
  - Footer note: "Prompt and output text are never stored."
- **Actions.** Open session timeline, copy reqId, Export CSV (list), "Show raw record" (the stored JSON, ids
  only).
- **Captions.** Retention: "Records are kept {days} days. Daily totals are kept longer."
- **Member vs admin.** Member: own records; no caller column. Admin: all.
- **Empty.** "No decisions in this period." Not found (detail): "This record does not exist or has expired."

### 4.5 Session timeline (from Decisions)

- **Purpose.** One session's requests in order: where the model stayed, where it switched, what it cost.
- **Header.** Session label, caller*, first / last request, requests, lineages, models served, switches, cache
  misses, failovers, total cost, overall hit rate.
- **Body.** One lane per lineage (root first, sub-agents under it). Each request is a point on its lane, coloured
  by served model; markers for break points (with point label), switches, cache misses (reason), failovers,
  assessor consultations (tier). Below: the request list in time order with the Decisions columns, and per row a
  small bar of cache read vs cache write vs uncached input.
- **Filters.** Lineage, "break points only".
- **Actions.** Click a point → decision detail. Export CSV.
- **Empty.** Unknown or expired session: Not found. A session that is still running shows "Live: new requests
  appear within about {minutes} min."

### 4.6 Get started

- **Purpose.** Connect a client in a few minutes with this deployment's values. Content in §6.
- **Data.** Filled from the deployment (`/api/me/setup` [§2.4]): gateway URL, Cognito domain, token endpoint,
  `cli` client id, scope, registered callback ports, the `llmar configure` block, mode, observe defaults, tier
  aliases with the pool models per API (read-only), the caller's tier limit and budget, sign-in lifetime,
  identity mode.
- **Layout.** 1 Install `llmar`; 2 Configure (`llmar configure --from …`); 3 Sign in (`llmar login`, password); 4 tabs per tool (Claude Code, Codex, Anthropic SDK, OpenAI SDK, curl); 5 Check my setup; reference
  panels "Models and tiers in this deployment", "Endpoints and headers", "Troubleshooting".
- **Actions.** Copy buttons on every snippet; Check my setup (calls `/api/me/latest`: the caller's latest request
  in the last 10 minutes: time, API, requested, served model). The console serves no files: the CLI comes from the
  repository (17 §3.8).
- **Empty / error.** Check found nothing: "No request from you in the last 10 minutes. If you sent one, check
  that the x-api-key header is set (step 4)." Deployment values missing: "This deployment is not fully
  configured. Ask an admin." (admin sees which value is missing).
- **Member vs admin.** Same content. Admins also see a box "Service clients for CI and agents" linking to
  Service clients.

### 4.7 Members (admin)

- **Purpose.** Create and manage the people who use the router.
- **List.** Name, e-mail, role, status (Active / Invited, password not set / Disabled), created, last request, cost this month, budget, tier
  limit. Search by name or e-mail; filter role, status.
- **Actions.** Invite member (e-mail, name, role, optional monthly budget and tier limit; Cognito sends the invite
  with a temporary password; at first sign-in the member sets a password); Resend invite; Change
  role (applies at the router ≈ 35 s, via `identity/principals.json` [0.16]); Set budget / tier limit; Disable;
  Enable (the member must `llmar login` again: disable revoked the refresh tokens); Sign out everywhere
  (revokes refresh tokens; issued access tokens still pass the gateway up to 30 min); Delete (only disabled
  members; records remain, shown as "Deleted member"). Every action writes the Audit log.
- **Disable semantics [0.2].** `require`: the router stops serving within ≈ 35 s. `observe`: requests that carry
  the member's identity get 403 `identity-blocked` within ≈ 35 s; requests without `x-api-key` are served until
  the access token expires (≤ 30 min). `off`: until the token expires. The dialog text follows the active mode.
- **Detail.** Profile, status history, this month's usage (link to Usage filtered), sessions, budget, tier limit.
- **Promotion to admin.** The new rights apply only after the person signs in again (`members.adminSignIn`).
- **Delivery.** Block-list and caller-list publishes show Delivered / Waiting / **Not delivered** with a
  Republish action (`enum.deliveryState.*`, `delivery.*`; API 502 `identity-delivery-failed`), like config.
- **Propagation.** After Disable / Enable / role / limit changes the row shows "Applying… (the router checks
  every 30 s)" until a router `kind: "config"` line reports the new `principalsVersion` / blocks etag [0.3b].
- **Errors.** E-mail already exists; invite failed (Cognito error code shown); cannot disable yourself; cannot
  remove the last admin.
- **Member view.** Not visible.

### 4.8 Service clients (admin)

- **Purpose.** Machine callers (CI, agents) on client credentials, as in the README today.
- **List.** Name, client id, status, created, last used, cost this month, scope, budget, tier limit.
- **Actions.** Create (name, description, optional budget and tier limit) → dialog shows the client secret
  once, with copy, the README machine token script and Secrets Manager advice, and the note to send the token in
  both `Authorization` and `x-api-key`; Rotate secret; Set budget / tier limit; Disable; Enable; Delete. The
  gateway authorizer is scope-only [0.4], so a new client needs no gateway or config change and has no pending
  state. Budgets and tier limits work as for members (0c correction, 2026-11-08).
- **Errors / empty.** "No service clients. Members use their own account; service clients are for automation."

### 4.9 Routing policy (admin)

- **Purpose.** Edit the model mapping with validation, versions and rollback.
- **Header.** Active config version (number, author, time, comment), state on the router from its `kind:
  "config"` lines [§2.1] (Active since …, Waiting for the router, Rejected by the router: issue codes), mode.
- **Tabs.**
  - *Form:* Mode (observe / auto, with the auto warning in §5.4); per API: default tier, models (model id from
    the allowed model universe, tier, failover profiles); observe defaults per API; aliases (name → tier or
    default); rules; Advanced (collapsed): user turn (cost-gated / retain), session tier, gate context headroom,
    cache TTL safety margin and write TTL, hysteresis (cost ratio, min USD, min turns before switch, max switches
    per lineage), horizon (calls, appended tokens, output tokens), compaction shrink ratio, failover (window,
    profile rotate on statuses), portability; **Tier limits** (group defaults for admin and member: highest
    tier, allowed pins; per-caller overrides live on Members / Service clients) [0.16].
  - *JSON:* the same document, editable, with schema errors inline.
  - *Versions:* list (version, author, time, comment, changed sections), diff between any two, Roll back to this
    version (creates a new version with the old content).
  - *What-if* (later phase, R7): replay recent decisions under the draft.
- **Actions.** Validate (runs `validatePolicy` + `checkPolicyAgainstCatalog` + allowed-universe check on the
  server); Save as draft; Activate (requires a comment; shows the diff and "Effect on running sessions" from
  `policySwapEffects(prev, next)` [0.9], with an explicit confirm when a change can move sessions; optimistic
  lock: "Someone activated version {version} while you were editing. Review their change first."); Discard
  draft. Removing a model makes its pins fail at once with 400 [0.10]; the effects list says so.
- **Errors.** Validation list with JSON path and message (validator text in English, shown as router detail);
  model outside the allowed universe ("Widening the model list needs a CDK deploy: parameter
  `allowedModelUniverse`"); model not in the region's catalog.
- **Member view.** Not visible (members see a read-only "Models and tiers" panel on Get started).

### 4.10 Assessor (admin)

- **Purpose.** Choose the assessor mode, pack and settings; read each pack's rules.
- **Settings.** Mode (off / observe / auto); pack (from the image manifest: id, pack version hash, rule count);
  model; threshold (0–1); timeout (ms); auto rules (pack / all). Saved into the same config document as the
  policy, so it creates a new config version (shared Versions tab).
- **Pack viewer.** Rules table: id, tier, instruction text, enabled, acts in auto. Pack text is shown as is.
- **Stats (range).** Consultations, share of requests, opinions by tier, no-opinion and unavailable rates,
  applied rate, cached share, latency p50 / p95, cost.
- **Warnings.** Switching to auto shows `assessor.autoWarning` (Harbor evidence: no detected selection skill;
  the router ships in observe) and needs an explicit confirm.
- **Member view.** Not visible; the assessor block in a member's own decision detail is visible.

### 4.11 Gateway (admin)

- **Purpose.** See how the gateway in front of the router is set up.
- **Data (read-only).** Gateway URL, id, status, last updated; authorizer (discovery URL, allowed scopes;
  scope-only, no client list [0.4]); targets (router target: private REST API, IAM; fallback target and its
  models); routing rules (catch-all → router [0.3]; router 5xx / unreachable → fallback); fallback chain;
  forwarded request headers (the allowlist, including `x-api-key`).
- **Edits.** None from the console (design §4: no `UpdateGateway`). Every field shows "Changed by a CDK deploy"
  with the parameter name.
- **Errors.** "Could not read the gateway." (AgentCore control API error code).

### 4.12 Audit log (admin)

- **Purpose.** Who changed what, and when.
- **List.** Time, actor, action, target, summary. Detail: before / after diff, request id, result (succeeded /
  failed with error code).
- **Actions recorded.** Member invite / role / disable / enable / sign-out / delete; service client
  create / rotate / disable / delete; config draft / activate / roll back; settings change; gateway edit;
  router config rejected (actor "router").
- **Filters.** Date range, actor, action type, target.
- **Actions.** Export CSV. No edit or delete in the UI.
- **Empty.** "No admin actions in this period."

### 4.13 Health (admin)

- **Purpose.** Is the router serving well right now.
- **Data (EMF, namespace `LlmAutoRouter`, plus ECS).** Router tasks running / desired; requests per minute;
  4xx and 5xx rate; failovers; "Signs of gateway fallback" (the gateway publishes no fallback count [0.3b]:
  router 5xx, unhealthy router targets, running < desired tasks, with a caption saying these are proxies);
  router overhead p50 / p99;
  upstream first byte p50 / p99; cache hit rate; switches; cache misses by reason; assessor latency and
  unavailable rate; active config version and config rejections; ingest lag; alarms in ALARM.
- **Filters.** Range (1 h, 6 h, 24 h, 7 days), API.
- **Errors.** "Metrics are not available." Router scaled to 0: "The router has 0 tasks. Requests go to the
  gateway fallback."

### 4.14 Settings

- **My account (everyone).** Language; time display (local / UTC); change password; MFA status (off; production hardening note `settings.mfa.off`); Sign out everywhere (revokes the `llmar` sign-in too); my budget and tier
  limit (read-only).
- **Deployment (admin).** Identity mode (off / observe / require, with consequences text and the observe note:
  disables, blocks and budgets bind only requests that carry `x-api-key`; warning before `require` while
  unattributed traffic exists [0.2]; until `require`, tier limits, blocks and budgets are *advisory*, because a
  caller who sends no token is served unattributed; switching to `require` is refused until the router reports
  its signing keys loaded, with the reason "otherwise every call would get 401"); budget spend = actual + assessor
  cost for the UTC month; record retention (days); default monthly budget, alert threshold, hard stop;
  default savings baseline (`static` by default); `llmar` sign-in lifetime (refresh token, 30 days, read-only,
  CDK); price catalog version and region (read-only); allowed model universe (read-only, CDK).
- Every Deployment change writes a config version or the Audit log, and shows where it applies.

## 5. Must-have copy (excerpt; full text in the JSON)

### 5.1 Scope captions (Usage, Savings, Decisions)

| key | en | zh-CN |
|---|---|---|
| `caption.scope` | Only requests that reached the router are counted. Calls that the gateway fallback served while the router was failing are not. | 只统计进入 router 的请求。router 出错期间由网关回退服务的调用不在其中。 |
| `caption.retention` | Request records are kept {days} days. Daily totals are kept {rollupDays} days. | 请求记录保留 {days} 天，每日汇总保留 {rollupDays} 天。 |
| `caption.unmetered` | {count} unmetered calls: their streams ended before usage arrived. They are not in the cost above. Approximate upper bound: {upperBound}. | 有 {count} 个未计量调用：流在拿到用量之前就结束了。它们不在上面的成本里。近似上限：{upperBound}。 |
| `caption.unmetered.partial` | partial (input only) | 不完整（仅输入） |
| `savings.caption.unmetered` | {count} unmetered calls are left out of these figures. | 有 {count} 个未计量调用不在这些数字里。 |
| `caption.utcDays` | Days are in UTC. | 按 UTC 日期分组。 |

### 5.2 Price captions

| key | en | zh-CN |
|---|---|---|
| `caption.listPrice` | List price from the {region} price catalog {catalogVersion}. This is not your AWS invoice: discounts, credits and taxes are not included. | 按 {region} 价格目录 {catalogVersion} 的目录价计算。这不是 AWS 账单：折扣、抵扣额度和税费都不在内。 |

### 5.3 Savings captions (mandatory)

| key | en | zh-CN |
|---|---|---|
| `savings.caption.listPrice` | All figures are list prices ({catalogVersion}), not your invoice. | 所有数字都是目录价（{catalogVersion}），不是账单金额。 |
| `savings.caption.sameUsage` | Same usage is assumed: the baseline prices the same token counts at the baseline model's price. A different model may use more or fewer tokens and turns. | 假设用量相同：基线用同样的 token 数，按基线模型的价格计算。换一个模型，token 数和轮数都可能不同。 |
| `savings.caption.quality` | Quality is not measured. A cheaper model may solve fewer tasks. In our coding-agent benchmarks the fast tier solved 14–17 points fewer tasks than standard. | 这里不衡量质量。更便宜的模型可能做对的任务更少。在我们的编程 agent 基准上，fast 档的解决率比 standard 档低 14–17 个百分点。 |
| `savings.caption.observe` | Observe mode: the router serves the observe default, so the figures show only how that model differs from the baseline. "Projected if auto" estimates what auto would have cost. | 观察模式：router 用观察默认模型服务，所以这里只反映这个模型和基线的差别。“自动模式预估”估算自动模式下的成本。 |
| `savings.caption.projection` | Indicative, not measured: the same tokens repriced on the models auto would have chosen, carried forward along each lineage. Exact for the shipped policy; approximate when user turns are cost-gated. | 仅供参考，不是实测：把同样的 token 按自动模式本会选的模型重新计价，并沿每条会话链延续。对默认策略是精确的；用户新 turn 过成本门时是近似值。 |
| `savings.caption.evidence` | Benchmark evidence: on two coding benchmarks, auto with the assessor cost 2.6–4.1 times fixed standard, with no quality gain detected. | 基准证据：在两个编程基准上，auto 加评估器的成本是固定 standard 的 2.6–4.1 倍，没有检出质量提升。 |

Numbers in `quality` and `evidence` come from `harbor-summary.zh-CN.md` §2–3 (Luna −14 to −17 pp; B/A cost
×2.64–4.06). They are pinned to that report; if the report changes, these strings change with it. The link
target is the summary (`docs/experiments/harbor-summary.zh-CN.md`). There is no English summary, so the en UI
links the zh report labelled "(Chinese)" (`savings.caption.evidenceLink`).

### 5.4 Auto-mode warnings

- `policy.autoWarning` — en: "In auto mode the router serves the model it chooses. Check the Savings
  projection and the benchmark evidence first." zh: "自动模式下，router 用它选择的模型服务请求。请先看“节省”页的自动模式预估和基准证据。"
- `assessor.autoWarning` — en: "In auto mode the assessor's tier changes the served model. In our benchmarks no
  ability to pick the tasks that need frontier was detected, and it never chose fast. Keep observe until the
  offline evaluation passes." zh: "自动模式下，评估器给出的档位会改变服务模型。在我们的基准上，没有检出它挑出需要 frontier 的任务的能力，它也从未选过 fast 档。离线评估通过之前，请保持观察模式。"
  (Harbor summary §3.4–3.5: selection skill +0.4 / −2.4 pp, CI includes 0; fast chosen 0 times.)

## 6. Get started page content (v1: 17 §2–3, design 0.13–0.14)

Placeholders the page fills: `{gatewayUrl}`, `{inferenceUrl}` (= `{gatewayUrl}/inference`), `{cognitoDomain}`
(`https://<domain>.auth.<region>.amazoncognito.com`), `{tokenEndpoint}` (`{cognitoDomain}/oauth2/token`),
`{authorizeEndpoint}` (`{cognitoDomain}/oauth2/authorize`), `{clientId}` (the public `cli` app client, no
secret), `{scope}` (`<prefix>/invoke`), `{codexOauthPort}` (the registered Codex callback port),
`{configureJson}` (the non-secret config block for `llmar configure`), `{cliRawUrl}` (raw URL of `llmar` in the
public repository; a build constant, not deployment data), `{refreshDays}` (30), `{observeDefaults}`. Snippets
are frontend templates (not in the JSON); their comments stay in English in both languages, as in the README.
Captions are `getStarted.*` in the deck.

### 6.1 What changes against the README (verified 2026-11-08)

| | README today (shared client credentials) | Console, member login |
|---|---|---|
| Credential | shared client id + secret in Secrets Manager | your own account: password in the browser (MFA off by default) |
| Needs AWS credentials / boto3 | yes (to read the secret) | no |
| Token | `client_credentials`, 60 min, minted on every call | auth code + PKCE once (`llmar login`); refresh token 30 days in a 0600 file; access token 30 min [0.3], cached with a 5-min margin |
| Identity at the router | none | the same token also in `x-api-key`; the router verifies it and records you |
| Usage attribution | none | per member (Usage, Savings, Decisions) |
| Disable | rotate the shared secret for everyone | admin disables one member: ≈ 35 s in `require` [0.2] |
| Claude Code | helper TTL 3000000 | helper TTL **240000** (17 §3.5) |
| Codex over 60 min | restart or local proxy | `auth.command` refreshes; `gateway_oauth` adds `x-api-key` (two sign-ins) [0.13] |
| SDKs | static token, recreate client | `RouterAuth` sets both headers per request |

The client-credentials flow from the README stays for **service clients** (CI, agents), shown in the Service
clients create dialog, now with the token also sent as `x-api-key`.

### 6.2 Step 1 — install `llmar`

```bash
mkdir -p ~/bin
curl -fsSLo ~/bin/llmar {cliRawUrl} && chmod +x ~/bin/llmar
ln -sf llmar ~/bin/llmar-token && ln -sf llmar ~/bin/llmar-login
```

One Python 3 file, standard library only; `llmar-token` and `llmar-login` are argv[0] aliases so tools can call
them with no arguments. python.org builds on macOS may need "Install Certificates" once (17 §3.8).

### 6.3 Step 2 — configure

```bash
llmar configure --from '{configureJson}'
```

Writes `~/.config/llmar/config.json` (no secrets). `{configureJson}` comes from `/api/me/setup` (C6): `{cognitoDomain,
clientId, scope, redirectPorts[], gatewayUrl?, identityHeader? (default x-api-key), refreshDays?}`. Subcommands:
`configure`, `login`, `token`, `headers`, `status`, `logout`; `llmar-login` / `llmar-token` are aliases (C8).

### 6.4 Step 3 — sign in

```bash
llmar login
llmar status
```

Copy (`getStarted.step2.*`): the browser opens the managed login page; first sign-in replaces the temporary password; afterwards the password. The refresh token is stored in `~/.config/llmar/credentials-<profile>.json`
(0600). Sign in again after {refreshDays} days, after "Sign out everywhere", or after re-enable. Over SSH:
`llmar login --no-browser` prints the URL and the `ssh -L <p>:127.0.0.1:<p>` hint (Cognito has no device-code
flow).

### 6.5 Step 4 — per tool

**Claude Code** (`~/.claude/settings.json`): the README config with the member helper and a 4-minute TTL.

```json
{
  "apiKeyHelper": "~/bin/llmar-token",
  "env": {
    "ANTHROPIC_BASE_URL": "{inferenceUrl}",
    "ANTHROPIC_MODEL": "auto",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "auto:frontier",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "auto:standard",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "auto:fast",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": "240000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Claude Code sends the helper output as both `Authorization: Bearer` and `X-Api-Key` (17 §2.1, design 0.13). The
README notes stay (tier aliases, `unrecognized_model`, count_tokens 404, refusal fallback model).

**Codex** (`~/.codex/config.toml`), long sessions, attributed [0.13]. `command` needs an absolute path:

```toml
model = "auto"
model_provider = "llmar"
model_context_window = 1000000
model_auto_compact_token_limit = 700000
web_search = "disabled"                # required: Bedrock rejects Codex's built-in web search tool mid-stream

[model_providers.llmar]
name = "llmar router"
base_url = "{inferenceUrl}/v1"
wire_api = "responses"
env_http_headers = { "x-router-session" = "LLMAR_SESSION" }
requires_openai_auth = false
supports_websockets = false

[model_providers.llmar.auth]           # Authorization: Bearer, refreshed by llmar
command = "/home/<you>/bin/llmar-token"
timeout_ms = 15000
refresh_interval_ms = 240000

[model_providers.llmar.gateway_oauth]  # Codex's own sign-in; its token goes in x-api-key
authorization_url = "{authorizeEndpoint}"
token_url = "{tokenEndpoint}"
client_id = "{clientId}"
scopes = ["openid", "{scope}"]
redirect_port = {codexOauthPort}
delivery = { kind = "header", name = "x-api-key" }

[features]
enable_request_compression = false
```

Run: `LLMAR_SESSION=$(uuidgen) codex`. Codex opens its own browser sign-in once (`getStarted.codex.oauth`).
Short sessions (< 30 min) may instead use the README form with `env_key = "LLMAR_TOKEN"` and
`env_http_headers = { "x-router-session" = "LLMAR_SESSION", "x-api-key" = "LLMAR_TOKEN" }`, started with
`LLMAR_TOKEN=$(llmar-token) LLMAR_SESSION=$(uuidgen) codex` (17 §2.1 matrix). **[open: C1 spike S2 — if the
gateway accepts the JWT in `x-api-key` alone, one sign-in suffices and this tab simplifies]**

**Anthropic and OpenAI SDKs (Python)**, verified recipe (17 §1.6):

```python
import subprocess, uuid
import anthropic, openai
import httpx2 as httpx   # anthropic>=2 / openai>=3 ship httpx2; older releases use httpx

def router_token() -> str:   # llmar answers from its cache; it refreshes 5 min before expiry
    return subprocess.run(['llmar-token'], capture_output=True, text=True, check=True).stdout.strip()

class RouterAuth(httpx.Auth):   # both headers on every request
    def auth_flow(self, request):
        t = router_token()
        request.headers['authorization'] = f'Bearer {t}'
        request.headers['x-api-key'] = t
        yield request

session = {'x-router-session': str(uuid.uuid4())}   # one id per agent session
claude = anthropic.Anthropic(base_url='{inferenceUrl}', auth_token='unused', default_headers=session,
                             http_client=httpx.Client(auth=RouterAuth()))
oai = openai.OpenAI(base_url='{inferenceUrl}/v1', api_key='unused', default_headers=session,
                    http_client=httpx.Client(auth=RouterAuth()))
msg = claude.messages.create(model='auto', max_tokens=512, messages=[{'role': 'user', 'content': 'Hello'}])
resp = oai.responses.create(model='auto', input='Hello', store=False)
```

Not documented: the Anthropic `credentials=` provider (adds an oauth beta Bedrock may reject, 17 §2.2).

**curl:**

```bash
TOKEN=$(llmar-token)
curl -sS "{inferenceUrl}/v1/messages" -H "Authorization: Bearer $TOKEN" -H "x-api-key: $TOKEN" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H "x-router-session: $(uuidgen)" \
  -d '{"model": "auto", "max_tokens": 256, "messages": [{"role": "user", "content": "Say ok."}]}' -D -
```

### 6.6 Step 5 — check my setup

Button "Check my setup" → latest request attributed to you in the last 10 minutes. With identity `require`, a
missing `x-api-key` returns 401 `identity-missing`; with `observe`, the call works but is not yours (the check
finds nothing).

### 6.7 Reference panels

- *Models and tiers in this deployment:* mode; per API the tiers and models, filtered to the caller's tier limit
  (with "Your tier limit: {maxTier}"); observe defaults; aliases.
- *Endpoints and headers:* the README tables plus `x-api-key`. A concrete model id also passes through the router
  [0.3] and is a pin in both modes [0.3a]: in the policy and within the caller's limit → served; in the policy
  but above the limit and not in `allowPins` → 400 `access-cap`; not in the policy → 400 `pin-not-allowed`.
- *Troubleshooting* (`getStarted.trouble.*`): 401 (no / expired token; `identity-missing` / `identity-*` in
  require); 403 `identity-blocked` (disabled or blocked) vs a bare 403 (wrong scope); 400 `pin-not-allowed`;
  400 `access-cap` (a pin or model id above the limit; a tier above it is clamped, logged as reason `access-cap`); 400 `access-cap-context` (no model within the limit fits the
  context); 429 `budget-exceeded`; 404 on count_tokens (harmless); Codex "stream disconnected" (web search on);
  `llmar-token` exit 2 "run llmar login" (sign-in expired, revoked or account disabled; Claude Code shows the
  message, Codex only "auth command exited with status 2", so the copy says to run `llmar-token` in a terminal);
  exit 3 (sign-in service unreachable, cached token used while valid); exit 4 (setup or file-permission problem).

## 7. Copy-deck conventions

- Flat dotted keys, grouped by page prefix: `app`, `nav`, `common`, `state`, `caption`, `term` (glossary
  tooltips), `enum`, then one prefix per page. Same key set in both files (checked).
- Interpolation `{name}`; plurals in ICU MessageFormat (`{count, plural, one {…} other {…}}`). zh-CN uses
  `other` only. If 18 picks a library without ICU, convert the few plural strings.
- Numbers and dates via `Intl` with the active locale (zh-CN compact numbers give 万 / 亿); currency always USD
  with 2 decimals for totals and up to 6 for single requests; percentages 1 decimal.
- zh-CN punctuation: full-width （），。：；“” in prose; half-width inside code and around English identifiers;
  one space between Chinese and English words or numbers, as in the zh docs.
- Not in the JSON: code snippets (frontend templates), router reason text and validator messages (shown verbatim
  as "Router detail"), pack rule text, model ids.

## 8. Open items (owner)

Resolved by design v1: 404 for other callers' ids [§2.4]; router-reported `configVersion` [§2.1–2.2]; savings
formulas [0.11]; MFA off by user decision (was 0.5); scope-only authorizer, no client list [0.4]; no gateway edits from the
console (§4); helper packaging (`llmar`, served from the repository, 17 §3.8); daily rollups 400 days; zh report
linked "(Chinese)"; budgets and tier limits for service clients too.

Still open:
Also resolved (design 0.3a / 0.3b): concrete model ids are pins in both modes (`access-cap` above the limit,
`pin-not-allowed` outside the policy); no gateway-fallback metric, Health shows proxies; "Applying…" ends on the
router's `principalsVersion` / blocks etag; language in `localStorage`; unmetered calls instead of $0 streams [0.3c].

1. C1 spike S2: one Codex sign-in or two (simplifies the Codex tab).
2. C9 (4f): README / README.zh-CN "Connecting clients" follow §6 once C2 and C8 land; the README stays the
   verified source and the Get started page mirrors it.
