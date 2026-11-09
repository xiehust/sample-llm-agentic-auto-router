# Claude Code × Harbor: harness, host proxy and router semantics (4f)

Status: design for 0c's ack. No code until the ack. No AWS calls. Code goes on branch `cc-harbor` in the
`llmar-cc` worktree. Codex behaviour, the Codex goldens and every existing router config stay byte-identical.
Facts marked **[capture]** are what Harbor 0.25.0's source and Claude Code's documented behaviour lead me to
expect. The capture (§5.2) confirms them against the pinned binary before anything is billed, and the checks fail
loudly if any differs.

## 0. Summary and decisions for 0c

1. **Agent.** A thin subclass of Harbor 0.25.0's `claude-code` agent, `cc_agent.LlmarClaudeCode` (about 40 lines).
   - It neutralises R6: no alias forcing; every alias is set explicitly.
   - It refuses to install anything: no network install, ever, on TB either.
   - Everything else is Harbor's own launch: `claude --verbose --output-format=stream-json --print`.
   - The pinned native binary is mounted read-only at `/usr/local/bin/claude`, staged as a3 proposes.
2. **Arms are expressed by the body model, not by pin hints.** The experiment router runs in auto mode, so a
   concrete model id is already a pin there (`decide` step 1, `pin: concrete model`). That means:
   - A, C and F run Claude Code with `ANTHROPIC_MODEL` set to the Sonnet, Opus or Haiku 5.5 id.
   - Helper calls name their own model and are served as requested.
   - No `x-router-hint` is sent for Claude Code.
   - **B runs the same client as A** (`ANTHROPIC_MODEL` = Sonnet), and the proxy rewrites the body model to `auto`
     on B's calls that name the nominal main model. A and B therefore send byte-identical requests apart from
     `model`: the only arm difference is the router's choice. This doesn't depend on how Claude Code treats an
     unknown model name like `auto`.
3. **One opt-in core change**, policy key `"sessionTier": "root"`, for 73's R1, R3, R4 and R5.
   - The assessor is consulted once per session, on its first auto request.
   - Every later auto decision under the same session root (subagents on the main model, a main loop whose
     tools/system changed, post-compaction, idle-expiry, prefix-reset) takes the tier of the root lineage's model,
     without consulting.
   - The key goes in a new policy file, `policy.experiment-cc.ap-southeast-1.json`.
   - Absent the key, `validatePolicy` returns the identical Policy object and every code path is unchanged.
   - R2 already holds today: pinned/explicit calls return before core touches the root index. A core test will lock
     that in.
4. **hproxy gets an Anthropic Messages route** for Claude Code profiles:
   - POST `/v1/messages`, plus whatever the capture shows Claude Code calls at startup;
   - the Anthropic SSE usage tap;
   - pricing mirrored from `@auto-router/pricing` (5m and 1h writes, and Haiku's long-context tier above 100k);
   - reservations at max(input, 1h write);
   - a per-call `role`, and the main/helper summary split that 17 asked for.

   Codex routes keep today's code path: new behaviour hangs off route fields whose defaults reproduce today's
   exactly.
5. **Decisions for 0c:**
   - (a) the version pin (§1.2);
   - (b) B's proxy rewrite (§2.3) versus a client-side `auto` model name;
   - (c) `sessionTier: "root"` as the R1–R5 mechanism (§3.3);
   - (d) running 73's fidelity capture (d) on runner 0 right after `setup`, with $0 spend (§5.3).

## 1. Claude Code in Harbor

### 1.1 Agent: Harbor's `claude-code`, subclassed thin

Harbor 0.25.0 `agents/installed/claude_code.py`, `run()`:
- It pipes the instruction on stdin into `claude --verbose --output-format=stream-json [--settings] [flags] --print`, then into `| tee <logs>/claude-code.txt`.
- It sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `IS_SANDBOX=1` and `CLAUDE_CONFIG_DIR=<logs>/sessions`.
- Flags come from options:
  - `--effort` (`reasoning_effort`);
  - `--disallowedTools WebSearch,WebFetch` (`disable_web_search`);
  - `--permission-mode=bypassPermissions` (the default).

What the subclass changes, and nothing else:

| Override | Why |
|---|---|
| `_model_alias_env(...)` → `{}` | Harbor would otherwise set `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` to the main model whenever a custom base URL is set (R6). Helpers would then run on the main model, contradicting the user's decision. The env of §1.4 sets every alias explicitly instead. |
| `install()` → verify only | It runs Harbor's own version check (`claude --version` == the pin). On a mismatch it raises `NonZeroAgentExitCodeError("claude-code pin not present")`, so 17's classify can map it to harness. It never falls through to npm or `downloads.claude.ai`, which on TB would fetch an unpinned build over the open egress. |

- It's loaded by `import_path`, as `llmar_env` already is.
- `harbor_job.agent_config` becomes agent-dispatched. `codex` returns today's dict byte for byte, and the golden
  covers it.
- `--max-turns`, `--fallback-model`, `--max-budget-usd` and the settings file are not used. Like the Codex runs,
  there's no turn cap; the per-runner CapLedger is the spend bound.

### 1.2 Version pin and staging

- **Version.** The current public stable at staging time; I propose **2.1.318**, the build this repo's work has
  been done with. 0c confirms it's on the public release channel for `linux-x64` and `linux-x64-musl`.
  - One version for both benchmarks and every arm, recorded in run-config (17's continuity field 4).
- **Checksum source.** The per-version release manifest (`…/claude-code-releases/<v>/manifest.json`), which lists a
  per-platform sha256. The official bootstrap verifies against the same manifest.
  - `cli.py stage-claude-code` fetches the manifest and the binaries on the host. It checks the manifest's sha256
    against the value pinned in `hcommon.CLAUDE_CODE` (version, per-platform sha256), and the binary against the
    manifest.
  - The pinned values are filled once by 0c's first fetch and reviewed, as Codex's asset hash was.
  - The binary sha is re-checked at every job start.
- **Mount and libc gate.** I accept a3's proposal:
  - mount read-only at `/usr/local/bin/claude` (agent environment only, as Codex);
  - a prepull gate tries glibc, then musl, records the build that works per task (in `pins.json` next to the image
    digest), and refuses the task if neither works.
  - The job config mounts the recorded build.

### 1.3 Effort, thinking, web tools

- **Effort high:** `--effort high` (Harbor's `reasoning_effort`), the same for every arm.
  - For the 5.5 models I expect the main loop to send adaptive thinking with `output_config.effort: "high"`
    **[capture]**.
  - The capture records per call whether `thinking` and `effort` are present and their values. A, B, C and F must
    send the same for the main loop.
  - Helper calls keep whatever Claude Code sends; no override.
- **Web tools off on both benchmarks** (`disable_web_search: true` → `--disallowedTools WebSearch,WebFetch`):
  - This is the same as the Codex TB profile, which disabled web search explicitly. On TB, shell access to the
    internet stays, as for Codex.
  - WebSearch is an Anthropic-hosted server tool that Bedrock doesn't offer anyway. Disabling WebFetch also removes
    its domain-safety preflight to Anthropic (a3's question), so nothing needs deciding there.
- **Not set:** `DISABLE_NON_ESSENTIAL_MODEL_CALLS`. Background model calls (titles, summaries) are part of Claude
  Code's defaults, which the user kept.

### 1.4 Agent environment (all arms; the values are the only per-arm difference)

| Variable | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | `http://172.17.0.1:8088/r/<trial-id>`, the proxy route. Claude Code appends `/v1/messages` (with `?beta=true`). |
| `ANTHROPIC_API_KEY` | a dummy value; the real token never enters a container. `ANTHROPIC_AUTH_TOKEN` is empty. |
| `ANTHROPIC_MODEL` | A and B: `global.anthropic.claude-sonnet-5-5`; C: `…claude-opus-5-5`; F: `…claude-haiku-5-5` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL` | the three 5.5 ids: Claude Code's native alias → the Bedrock id |
| `ANTHROPIC_SMALL_FAST_MODEL` | the Haiku 5.5 id (the deprecated name, set so an older code path can't fall back to a first-party id) |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `global.anthropic.claude-fable-5-1`. It's not in the pool, so a Fable request is refused loudly (proxy 403 `model-not-allowed`), never silently remapped. Expected 0 in the capture. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | **unset** (the subclass sets no alias env), so each subagent uses its own default |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND` | `1`; the first covers the rest, the others are belt and braces (a3) |
| `IS_SANDBOX`, `CLAUDE_CONFIG_DIR` | as Harbor sets them |

**Host-variable scrub.** The dev box and runners hold real credentials. `harbor_env` already drops the variables
Codex would forward. For Claude Code it also drops:
- `ANTHROPIC_*`;
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_FORCE_OAUTH`;
- `AWS_BEARER_TOKEN_BEDROCK`, `AWS_*`.

Only the table's values reach the agent. A unit test asserts the exact env key set.

### 1.5 Which model each role requests (expected **[capture]**, verified per arm in the mock e2e by the served model per call)

| Role | Claude Code default | A | B | C | F |
|---|---|---|---|---|---|
| Main loop | `ANTHROPIC_MODEL` | Sonnet | auto → the session tier | Opus | Haiku |
| Compaction summary | main model | Sonnet | auto (session tier) | Opus | Haiku |
| General-purpose Task subagent | `inherit` | Sonnet | auto (session tier, R3) | Opus | Haiku |
| Plan subagent | `inherit` | Sonnet | auto (session tier) | Opus | Haiku |
| Explore subagent | `haiku` | Haiku | Haiku | Haiku | Haiku |
| Background/small-fast (title or topic, summaries, command-prefix checks, if this version sends them in `--print` mode) | `haiku` | Haiku | Haiku | Haiku | Haiku |

- Any other model or alias seen in the capture is reported, and the table is corrected before the pilot.
- **B ≡ "every call A would send to Sonnet goes to auto".** This covers inherit subagents and compaction, and keeps A
  and B symmetric.

### 1.6 Network

- **DeepSWE:** unchanged. The `none` profile proxy is the only reachable address.
- **TB:** the Codex public profile, `llmar-online`, unchanged. I accept a3's optional `extra_hosts` for
  Anthropic-owned non-API hosts only, mapped to `0.0.0.0` in the agent container:
  - `statsig.anthropic.com`, `api.anthropic.com`, `console.anthropic.com`, `claude.ai`, `downloads.claude.ai`.
  - Not shared error-reporting hosts: a3's collateral argument applies to them.
  - The list is checked against what the no-egress capture (§5.2) shows the pinned binary would contact.
  - It's recorded in run-config.
  - It's an agent-environment overlay only; the verifier stays as it is.

## 2. hproxy: the Anthropic Messages route

### 2.1 Where the code goes

- `codex-deepswe/proxy.py` gets route-level hooks only:
  - `Route.dialect` (default `openai-responses`);
  - the allowed paths;
  - the forwarded headers;
  - the tap factory;
  - the pricer.

  Every default is today's constant, so the Codex dry run and goldens are byte-identical. A golden test asserts the
  Codex route's request headers, the records and the summary keys.
- The Anthropic pieces live in `deepswe-harbor/hproxy.py` and a new `cc_pricing.py`.

### 2.2 Paths and methods (per trial, `/r/<trial-id>/…`)

| Path | Handling |
|---|---|
| `POST /v1/messages` (query `beta=true` accepted and dropped) | Forwarded to the gateway's `/inference/v1/messages` |
| `POST /v1/messages/count_tokens` | **[capture]** I expect Claude Code not to call it in `--print` mode. If it does, the proxy answers it locally without forwarding (404, `not_found_error`): the gateway has no route for it and Bedrock prices nothing for it. The capture checks that Claude Code proceeds after the 404. If it doesn't, a local estimate (bytes/4) is the fallback, flagged in run-config. |
| `GET /v1/models` | **[capture]** If Claude Code calls it, the proxy answers locally with the arm's allowed model ids, as the Codex Bedrock route does today |
| Anything else (HEAD, other paths) | 404/405, `path-not-allowed`, recorded. The capture must show 0 of them, or each is added explicitly. |

Unchanged: no CONNECT and no absolute URIs; no compressed or chunked bodies; the 12 MB cap; `x-router-session:
<trial-id>` set by the proxy whatever the client sent.

### 2.3 Body model policy and B's rewrite

- **Allowed body models**, for every Claude Code arm: the three pool ids (Opus, Sonnet and Haiku 5.5). Anything else
  gets 403 `model-not-allowed`, fail closed, counted.
- **B:** a call whose body model equals the nominal main id (Sonnet) is re-serialised with `model: "auto"`.
  - The record keeps `requested_model` (Sonnet), `rewritten: true` and the served model.
  - Haiku calls pass through. Under the auto-mode experiment policy they are pinned (R2).
- **Why rewrite instead of `ANTHROPIC_MODEL=auto`.** Claude Code derives per-model request features from the model
  name (thinking/effort support, max_tokens, betas, the context-window and auto-compact threshold) **[capture]**.
  With the rewrite, B's requests are byte-identical to A's apart from `model`. The capture also runs a client with
  `ANTHROPIC_MODEL=auto` once, for information: if its bodies equal the Sonnet-named ones apart from `model`, the
  two are equivalent, and 0c may choose either.
- **Known consequence.** B served by Opus or Haiku gets a Sonnet-shaped request. In particular `max_tokens` and the
  betas are Sonnet's.
  - The capture records `max_tokens` per model for A, C and F.
  - If Haiku's main-loop `max_tokens` is below Sonnet's, a B session routed to fast could exceed Haiku's output
    limit (a Bedrock 400). That's open question Q3.
  - v2.2 almost never calls fast on Codex cards (73 §0.4), so the exposure is small. It's checked in the mock e2e
    with a Bedrock-like stub that enforces per-model limits.

### 2.4 Headers

- **Forwarded:** `content-type`, `accept`, `user-agent`, `anthropic-version`, `anthropic-beta`.
- **Not forwarded:** `x-api-key` (the dummy); `x-claude-code-session-id` (the proxy's cooperative `x-router-session`
  wins in core anyway); `x-claude-code-*` agent headers.
  - Note for the record: the gateway forwards only 9 named headers, and `x-claude-code-parent-agent-id` isn't one of
    them. Core's subagent hint from that header therefore never fires through the gateway today. It's harmless here,
    because subagent lineages are detected by template family under one session root, but it's a product gap worth
    an issue.
- **Hint:** none for Claude Code arms; the arm lives in the body model.
- **Recorded from responses** as today: `x-router-decision`, `x-router-model` (the served model), `x-router-reason`,
  `x-amzn-requestid`.

### 2.5 SSE usage tap and pricing

- **Tap.** `message_start` gives the model and the base usage. Every `message_delta` overlays the cumulative usage
  (nulls never erase a field) and carries `stop_reason`. `message_stop` is the terminal event. An `error` event gives
  `error.type` (`overloaded_error`, …).
  - Non-stream JSON: the top-level `usage` and `stop_reason`.
  - This mirrors `createStreamUsageAccumulator('anthropic-messages')`.
  - The record gains `stop_reason` (`end_turn | tool_use | max_tokens | pause_turn | refusal`), as a code only.
- **Pricing** (`cc_pricing.cost`) mirrors `fromAnthropic` and `costOf`:
  - uncached = `input_tokens`; read = `cache_read_input_tokens`;
  - writes split by `cache_creation.ephemeral_{5m,1h}_input_tokens`, with the unsplit rest at 5m;
  - prompt = the sum;
  - the long-context tier applies to the whole call when prompt > `aboveTokens` (Haiku 100k: input 0.5, write
    0.625/1.0, read 0.05, output 2.5).
  - Unknown model → priced as Opus, so the ledger stays an upper bound.
  - A cross-check test prices the same fixtures with the TypeScript package and requires equality to 1e-9.
  - The pilot compares the proxy cost with the router's `costUsd` per call.

### 2.6 Reservations (CapLedger worst case; 17 §3)

Worst = est_prompt × max(input, 1h write) at the price for that size, + max(16k, body `max_tokens`, capped at 128k)
× output.
- est_prompt is R2E's rule: the previous prompt + new bytes / 3.
- Worst model:
  - the pin for A, C and F main calls;
  - the requested model for explicit helper calls;
  - **Opus** for every rewritten (auto) call in B.
- Long-context pricing is applied when est_prompt > 100k on Haiku.
- In-flight subagent calls each hold their own reservation; the ledger already sums them.
- Refusals stay `budget` 429. Claude Code retries 429 with backoff (about 10 tries) before giving up, which is
  bounded and only happens at a cap stop.

### 2.7 Per-call `role` and the trial summary (17's interface; 0d §4.2 preconditions 2, 5 and 6)

The model id can't tell roles apart in F, where everything is Haiku. So the proxy computes text-free structure per
call:
- `fam`: sha256(canonical tools JSON + system JSON)[:12], the same idea as core's template family;
- `tools_sig`: sha256 of the sorted tool names [:12], plus `n_tools`;
- `first_user`: sha256(messages[0])[:12];
- whether the request has thinking.

Classification, first match:
1. **main:** the trial's first request with tools defines the main loop (`main_fam`, `main_first`). Later requests
   with `fam == main_fam` or `first_user == main_first` are main. The `first_user` match keeps the main loop through
   tool loading; after a compaction, the post-compaction main request matches by `tools_sig` + nominal model
   instead.
2. **subagent-main:** has tools, isn't main, and names the nominal main model (inherit subagents). It counts as
   0d's **main** (the arm decides it).
3. **helper:** names a model other than the nominal main one (Explore, background) in A, B and C. In F: a request
   with no tools (background), or one whose `tools_sig` is in the capture's table of helper toolsets for the pinned
   version (Explore's read-only set).
4. **unknown:** anything else. The pilot requires 0.

For 0d and 17, `role` ∈ {main, helper, unknown}, and `role_detail` keeps {main, subagent-main, explore, background}.
The trial summary keeps every current key and adds:
- `main: {calls, statuses, error_origins, last_call, spent_usd, served_models}`;
- `helper: {…}`;
- `roles_unknown`;
- `rewritten_calls`.

None of these keys exists for Codex.

## 3. Router and core semantics

### 3.1 What core does today with Claude Code calls (checked in `decide.ts` / `summarize`)

- **Explicit body model in auto mode:** `pin: concrete model`. It returns at step 1, before any state lookup, root
  note or assessor consult; `record()` still writes that lineage's cache state.
- **`auto`:** a full evaluation. The lineage is `<x-router-session>/t:<template family>`. Claude Code's main loop,
  Explore, general-purpose subagents and background calls each have their own tools/system, so each is its own
  lineage under the one trial root.
- **Subagent-start:** a new auto lineage under a root that already has one. Core consults the assessor there (card
  lineage `subagent`).
- **userTurn `retain`** (the experiment policy): no consult on plain user turns. At a break point with user text
  (e.g. after an auto-compaction, where the history becomes the summary) core does consult.
  - 73 asked whether that was also true for the Codex B arms. It would have been, but the Codex B arms never
    compacted (0 of 560 DeepSWE B runs, 0 of 252 TB), so it never arose.
- **Thinking signatures** are non-portable (`anthropic-thinking-signature`, same-model), so tool loops are
  hard-locked as with Codex.

### 3.2 73's requirements against today

| | Today | With `sessionTier: "root"` |
|---|---|---|
| R1: one consult per trial, on the first main-loop request | Consults again at every subagent-start and every post-compaction user-text break point | Only the root lineage's first decision consults |
| R2: helpers don't steal the root | **Already holds**: explicit-model calls return before `noteRoot`, so the main loop is still `session-start`. Locked by a core test. | Unchanged |
| R3: inherit subagents run at the session tier, with no consult | Consult; own tier | Desired tier = the tier of the root lineage's current model (`session-tier`) |
| R4: the main loop survives a tools/system change | New lineage → subagent-start → consult | New lineage → `session-tier`, no consult. Its first call writes a new cache prefix, as today. |
| R5: the tier persists through compaction, idle-expiry and prefix-reset | Re-consult at a user-text break point; no-opinion → the pool default | `session-tier` at every break point |
| R6: helper aliases | Harness | §1.1 / §1.4 |

### 3.3 The change: `policy.sessionTier` (opt-in)

**Policy.** An optional `sessionTier: "root"`.
- `validatePolicy` copies the key only when it's present, so absent means the identical Policy object.
- Any other value is a PolicyError.

**`decide()`, only when `policy.sessionTier === "root"` and the request is an auto request:**
1. `root = await store.rootLineage?.(s.session.root)`. A store without `rootLineage` and `noteRoot` makes
   `createEngine` throw at construction, fail closed. `InMemoryStateStore` has both; the deployed router uses it.
2. **Root lineage, first decision** (no state, and the root is unnoted or is this lineage): as today. Session-start,
   with the assessor consulted under the usual rules.
3. **Anything else** (the root lineage at later break points, or any other auto lineage under the root):
   - `meta.consult = false`;
   - the desired-tier source order is hint → alias → rule → **`session-tier`** → (no assessor) → default;
   - `session-tier` = the tier of the root lineage's `state.current` (`tierOfModel`, as `parentTierOf` already
     does);
   - if the root has no current model yet (its first call failed before serving), the pool default, with reason
     code `session-tier:pending`.
4. The reason string carries `via session-tier`. RequestLog needs no new key: `decision.reason` and the absence of
   `assessment` show it.

**What it deliberately doesn't change:**
- the pin path and hard locks;
- failover and the context gate (a gate-forced move still happens);
- beta veto;
- observe mode, which applies the same logic to `wouldChoose`.

**Precondition (0c): one router task during the run.** The state is in-memory per task (`InMemoryStateStore`), so
all of a trial's calls must reach the same task. Codex relied on this too; it's to be confirmed in the deployed
config (Q5).

### 3.4 Blast radius and the byte-identical guarantee

- **Files:**
  - `core/src/policy.ts`: validate and copy one key;
  - `core/src/decide.ts`: a guarded branch in `decide`/`evaluate`/`desiredTier` (about 40 lines);
  - `core/src/engine.ts`: the store-capability check, only when the key is set;
  - `router/config/policy.experiment-cc.ap-southeast-1.json`: new, a copy of the experiment policy plus the key
    and its own `version`.
- **No change** to the router server, gateway, infra, the card or the assessor. 73's card filter is theirs and
  separate.
- **Guarantee:**
  1. Every existing policy file validates to a deep-equal Policy before and after.
  2. All existing core, router and replay tests pass unchanged.
  3. A replay golden, the recorded DeepSWE/TB Codex request sequences through `createEngine` with the existing
     experiment policy, gives byte-identical decisions and log lines.
  4. The same replay with `sessionTier` present on a Codex trace (one lineage) gives identical decisions as well:
     the key is inert without a second lineage or a break point.
- **New core tests:**
  - R2: a helper first, then the main loop → session-start, kind root, one consult.
  - R3: an inherit subagent → served at the root's tier, no consult. Covered for root at frontier, standard and fast.
  - R4: the main loop's family changes mid-trial → same model, no consult.
  - R5: a post-compaction shrink with user text → same tier, no consult; and with the assessor unavailable at the
    root → default, never re-consulted.
  - Pending root → default + reason.
  - The store without the root index throws.
  - Observe mode → `wouldChoose` follows the same rules.

## 4. Transcripts: harvest, lookupscan, leakscan, export

**Layout** (Harbor `CLAUDE_CONFIG_DIR=<agent>/sessions`):
- `sessions/projects/<cwd-slug>/<session-id>.jsonl` (main);
- `…/<session-id>/subagents/agent-*.jsonl` (subagents);
- `agent/claude-code.txt` (stream-json stdout: the `system` init event, then assistant/user events, then the
  terminal `result` event).

Other files in `sessions/` (`.claude.json` with a random user id, `statsig/`, `todos/`, `shell-snapshots/`,
`debug/`) aren't needed and are **excluded from exports** (17's export globs). Only the `projects/**.jsonl` files
and `claude-code.txt` are kept.

**harvest** (`cc_fields`; text-free, a sibling of `tb_fields`):
- `claude: {version, binary_sha, effort, build: glibc|musl, models: the alias env as ids}`;
- from the `result` event: `{subtype, is_error, num_turns, duration_ms, duration_api_ms, permission_denials (count)}`;
- `modelUsage` tokens per model, as a cross-check against the proxy;
- from the transcripts: subagents (count, by type when the transcript names it), compactions (count of
  `compact_boundary` system events), tool calls by tool name (counts), disallowed-tool attempts (expect 0);
- the proxy's role split.

Never message text, tool inputs or outputs.

**Exit status (17's item 5).** Harbor's pipeline `claude … --print 2>&1 | tee …` has no `pipefail`, so a failed
Claude Code process can exit 0. Harbor's `_classify_exec_error` reads the stream-json `result`/`error` events,
though, and harvest records `result.subtype`/`is_error`. A missing `result` event (killed, OOM) → `cc_result:
missing`, which 17's classify treats as an agent crash. The mock e2e covers four cases: end_turn, a max-turns-style
error, an upstream 400 loop, and SIGKILL mid-stream.

**lookupscan** (TB; 0d §5.1 rule unchanged, scanner version bumped and frozen before the pilot):
- A new source, `cc-session`:
  - actions = assistant `tool_use.input` (Bash `command`, Edit/Write/MultiEdit/NotebookEdit fields, Grep/Glob
    patterns, Task prompts);
  - outputs = user `tool_result.content` (string or text blocks);
  - across the main and subagent files.
- Fallback: `claude-code.txt` events, same shape.
- Rules, exemptions, `net_config_touched` and the text-free record are unchanged. Tests are synthetic transcripts
  with our own text, as today.

**leakscan.** Claude Code transcripts carry opaque provider blobs: `thinking.signature` and `redacted_thinking.data`.
They're long base64 strings that trip the N5 12-digit-run *review* rule.
- Allowance: in files that parse as Claude Code session JSONL, the review-level digit-run rule skips exactly these
  two JSON paths.
- Every high-confidence detector (JWT, Bearer, AWS key, ARN account) still runs on them, and every other field is
  scanned as today.
- The task-fixture allowance (by fingerprint, `--fixture-dir`) is unchanged and applies to Claude Code runs too.
- Tests: a synthetic signature with a 12-digit run is not a review hit; a JWT inside a signature field is still a
  high-confidence hit.

## 5. Test plan

### 5.1 Unit (no network)

- `cc_agent`: the exact env key set and values per arm; no alias env from Harbor; `install()` refuses on a version
  mismatch and never runs a network command (a fake environment records exec calls); the scrubbed host variables.
- `harbor_job`: the Codex dict is unchanged (golden); the Claude Code job config per arm and dataset (mount, build,
  web tools, `extra_hosts` on TB only).
- **hproxy:**
  - paths and methods;
  - the allowed models and B's rewrite (requested/served/rewritten recorded; Haiku untouched);
  - forwarded headers;
  - the Anthropic SSE tap (CRLF, split chunks, a null overlay, error events, cut streams);
  - pricing against the TS fixtures (5m/1h, long-context Haiku, unknown → Opus);
  - reservations (worst model per arm and role, in-flight subagents);
  - role classification on synthetic sequences for all four arms, F included;
  - summary keys present only for Claude Code;
  - the Codex golden route unchanged.
- **core:** the §3.4 tests. **lookupscan / leakscan / harvest:** the §4 tests.

### 5.2 Capture and no-egress check (dev box, no AWS)

The dev box is arm64 without qemu, so the capture uses the same version's `linux-arm64` native build. Request
content doesn't depend on the CPU architecture; any difference shows up in the runner check in §5.3.
- It runs Harbor's real trial flow with `LlmarClaudeCode` in a generic container (task WORKDIR and a git repo),
  against the real hproxy on loopback. The proxy's upstream is a **stub router** (`mock_upstream.py` gains an
  Anthropic mode) that records every request and answers from a script:
  - **S1:** `end_turn` at once (the first-request capture);
  - **S2:** a `tool_use` of Task (general-purpose), then Explore, then `end_turn`;
  - **S3:** usage numbers near the auto-compact threshold, so that Claude Code compacts cheaply;
  - **S4:** 429/overloaded, then 400, then a cut stream.
- Once per profile (DeepSWE: no web tools; TB: as the Codex TB profile), for arms A and F, plus an
  `ANTHROPIC_MODEL=auto` client once.
- **No-egress check:**
  - Claude Code runs in a network namespace whose only reachable address is the proxy.
  - A DNS stub in the namespace logs every query.
  - A catch-all TCP listener records any connect, by `REDIRECT` inside the namespace, or with `strace -f -e connect`
    where available.
  - Pass = 0 DNS queries and 0 connects other than the proxy.

**Outputs, under `experiments/claude-code-harbor/results/capture/<profile>/`** (gitignored; it contains Claude Code's
prompt and an instruction):
- `requests.jsonl`, text-free, one line per call: seq, path, method, requested and served model, rewritten, `fam`,
  `tools_sig`, `n_tools`, `first_user`, role / role_detail, `is_first_main`, `max_tokens`, thinking type, effort,
  betas, cache_control TTLs, stream, `stop_reason`. That's 73's (a).
- `first-main.json`: the first main-loop body, 73's (b). The instruction is from one DeepSWE task in the DeepSWE
  profile and one TB task in the TB profile.
- `reminders.json`: messages[0]'s block structure (block count, the index and character length of each
  `<system-reminder>` block, and whether it is a separate block or joined to the instruction), 73's (c).
- `d6.json`: the D6 equivalent for Claude Code, text-free. Version and build; the endpoints called; request header
  names; the per-role model table (§1.5) as observed; the alias env; the no-egress result.

### 5.3 On a runner, $0 (73's (d) and the x86 check)

Right after `setup` on runner 0, before the pilot: `cli.py capture --task <id>` on 3 DeepSWE and 3 TB tasks, chosen
by 73. It runs in **the tasks' own images** with the x86 build and the same stub-router script (S1 only). The
upstream is a local mock, so there's no Bedrock spend.
- Output: `capture/runner/<task>.json` with the same fields.
- 73's fidelity check compares each with its template body.
- Any difference against the dev-box capture (other than cwd, git state, date or the arm64/x86 build) is reported
  before the pilot.

### 5.4 Mock end-to-end through the real proxy and the real router (dev box, no AWS)

Claude Code → hproxy → **the real router** (`node`, `startRouter` test helper, auto mode,
`policy.experiment-cc`, a scripted fake assessor) → a stub Bedrock that enforces a per-model max output, records,
and scripts S1–S4.

Per arm:
- every call is attributed (router log `session` hash == the trial);
- the served model per role equals §1.5 (pinned arms 100%; helpers as requested);
- `roles_unknown == 0`;
- the proxy cost equals the router `costUsd`.

B, with the fake assessor returning frontier, then standard, then fast:
- **exactly one consult per trial**;
- the main loop, inherit subagent and post-compaction main all on the assessed tier;
- helpers on Haiku;
- B's Sonnet-shaped requests served by Haiku don't exceed its output limit, or the gap is reported (Q3).

Exit status: the four cases of §4. leakscan `--strict` and lookupscan on the produced transcripts.

## 6. Interfaces (answers)

- **17:**
  1. Aliases: §1.4.
  2. `role` and the summary split: §2.7 (keyed on structure, not the model id, so F works).
  3. Reservations: §2.6.
  4. Continuity: `hcommon.CLAUDE_CODE` and the staged sha in run-config. The router policy version comes from the
     router logs (`decision.policyVersion`, read once by 0c at the pre-flight): the gateway returns only the three
     `x-router-*` headers, so there's no new response header.
  5. Exit status: §4, covered by the mock e2e.
  6. Container id: Harbor 0.25.0 doesn't expose it per trial; the compose project prefix stays the key.
- **a3:** accept staging, mount, libc gate and env (§1.2, §1.4). `extra_hosts` for Anthropic-owned hosts only
  (§1.6). WebFetch is disabled, so no preflight. The no-egress assertion is §5.2.
- **73:** R1–R6 → §3.2–3.3 and §1.1. Capture (a)–(d) → §5.2–5.3, with the paths there. The R5 question → §3.1.
- **0d:** preconditions 2, 5 and 6 come from `role`/`role_detail` and the served model per call. Precondition 4
  (one consult) comes from router logs: decisions with an uncached `assessment`, per session.

## 7. Open questions

- **Q1 (0c):** the version pin, 2.1.318 or the current public stable, plus the manifest URL for the checksum.
- **Q2 (0c):** B by proxy rewrite (recommended) or a client-side `auto` model. Decide after the §5.2 comparison.
- **Q3 (0c, 0d):** if Haiku's output limit is below the `max_tokens` Claude Code sets for Sonnet:
  - accept the rare B-to-fast 400s and classify them as agent;
  - or add an opt-in router clamp (`pool[].maxOutputTokens`);
  - or have the proxy clamp B's `max_tokens` when the router serves fast. That isn't possible before the decision,
    so it would need the router clamp.
- **Q4 (73, 0d):** an inherit subagent takes the root's tier under `sessionTier`. That matches R3, but B then never
  routes subagents differently from the main loop. Confirm that this is what the pre-registration means by "B".
- **Q5 (0c):** confirm that `routerDesiredCount` is 1 for the run. Session-tier state, like all lineage state, is
  per task.
- **Q6 (a3):** whether the TB `extra_hosts` list may include the error-reporting host if the capture shows the
  binary resolving it despite `DISABLE_ERROR_REPORTING`. I expect it won't.
- **Q7 (0c):** the gateway doesn't forward `x-claude-code-parent-agent-id`. Should that be filed as a product issue,
  separately from this run?

## 8. Estimate (4f; after the ack)

| Work | Hours |
|---|---|
| `cc_agent`, env, `harbor_job` dispatch, staging cmd + libc gate, unit tests | 3 |
| proxy hooks (Codex golden), Anthropic route, tap, `cc_pricing`, reservations, role classifier, summary, tests | 5 |
| core `sessionTier` + tests + replay golden; the new policy file | 3 |
| harvest `cc_fields`, lookupscan `cc-session`, leakscan allowance, tests | 2.5 |
| capture tool (S1–S4 stub, no-egress netns), runner capture cmd | 3 |
| mock e2e with the real router (node), assertions | 3 |
| **Total** | **≈ 19.5 h** |
