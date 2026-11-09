# Claude Code × Harbor — assessor side: card, offline tier pass, transfer caveat (73)

> **Outcome (2026-11-07): the tier pass was not run.**
> - **User decision:** the live run was cut to a small validation with only arms A (Sonnet 5.5) and C (Opus 5.5), and
>   stage 1 only. Arm B is dropped, so the Claude-card tier pass (§3.3) and its gate (§3.4) do not run. No assessor
>   call was made and nothing was spent on the ledger.
> - **What stays:** the two Anthropic card fixes (§1.3: `<system-reminder>` blocks are client context; `system`-role
>   messages are system text). They are product fixes for any Anthropic client, committed on cc-harbor as f9052df,
>   1dda7d1 and e60f57e, together with the core `lastTurn` fix (4836d5b, 4f).
> - The tier-pass tooling stays in `experiments/claude-code-harbor/` for a later B arm. The plan below is kept as the
>   record.

Status: acked by 0c on 2026-11-07. The code (§3.2) is built and tested on branch cc-harbor, uncommitted, and
waiting for the capture. 73 makes no AWS calls; the one live step (§3.3, v2.2 only, about $0.20) is run by 0c.
Router semantics (§2) are 4f's design (design-harness.md §1.1, §1.4, §3, §5); this section only states what the
assessor side needs from them, and how to check it.

**0c's decisions (2026-11-07):**
1. The `<system-reminder>` filter is unconditional. It is the one non-opt-in change in this experiment, and the card
   version stays card/v1.
2. The tier pass runs **v2.2 only**: 3 passes × 196 cards, cap $0.30 on its own ledger. 0c first planned v2.1 as
   well; the user turned it down. The experiment keeps four arms, with B on v2.2.
3. The fidelity check must pass before any live call.
4. R6 is fixed in 4f's agent profile.

## 0. Summary and decisions requested

1. **The card builder cannot be used on Claude Code as it is.** For Anthropic Messages it joins every text block of
   the first user message. Claude Code puts its `<system-reminder>` context (date, CLAUDE.md / memory, reminders) in
   that same message as separate text blocks. So `latestUser` would start with scaffolding, not with the task, and on
   long DeepSWE issues the scaffolding would also eat into the 4,000-character budget. Proposal (§1.3): a block-level
   client-context filter for Anthropic `<system-reminder>` elements, mirroring the message-level filter that already
   exists for Codex's `<environment_context>`. Codex cards stay byte-identical; a regression check rebuilds every
   recorded Codex card and compares hashes.
   - **Decision for 0c:** make the filter unconditional (recommended), or opt-in behind a CardBuildContext flag that
     only the experiment router sets. Unconditional changes the assessor's input, not the routing, for Anthropic
     clients of the deployed observe router. Today those clients are mostly Claude Code, whose cards are therefore
     scaffolding-led.
2. **Exactly one assessment per trial**, from the first main-loop request. Today's core would consult again on a
   Task/Agent subagent, and possibly on a helper call that arrives first or a main-loop template change (§2). There
   is also a Harbor 0.25.0 default that matters: with a custom base URL, Harbor sets every Claude Code model alias,
   **including `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, to the main model**. Left as is,
   that contradicts the user's "helpers keep Claude Code defaults" decision. Requirements R1–R6 go to 4f.
3. **Offline tier pass** (§3): capture the pinned Claude Code's first request through Harbor's claude-code agent,
   against a local mock upstream (no AWS); turn it into a template; substitute each task's instruction; build and
   check the 196 cards offline. 0c then runs 3 live passes with v2.2: 588 Luna calls, about $0.20, cap $0.30 on a
   ledger of its own.
4. **Expected result, to show the user before the pilot.** On Codex cards, v2.2 called standard on 335/336 DeepSWE
   calls and 241/252 TB calls (10 no-opinion → pool default standard, 1 frontier). If Claude Code cards behave the
   same, **arm B will route almost every session to Sonnet, so B ≈ A by construction**: B−A ≈ 0, and C (Opus) is
   reached almost never. That is v2.2 working as released (frontier narrowed because Astra bought nothing over Sol),
   but it means B cannot show whether an assessor can exploit a real Opus/Sonnet gap. The user should see this
   before about a quarter of the run budget goes to B (§3.4).
5. **Transfer caveat** (§4): v2.2 is evaluated as released, not as calibrated for Claude. The report should say what
   B measured; it should not read B as evidence about assessor selection skill on the Claude family.

## 1. The card from Claude Code's first main-loop request

### 1.1 What the request contains (Harbor 0.25.0 claude-code agent; to be confirmed by capture, §3.1)

- **Launch:** Harbor pipes the instruction into `claude --verbose --output-format=stream-json [flags] --print` on
  stdin, with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `IS_SANDBOX=1`, `CLAUDE_CONFIG_DIR` under the trial log
  dir, `--effort` from the agent config, and `--disallowedTools WebSearch,WebFetch` when web tools are disabled.
- **The main-loop request** (Anthropic Messages):
  - `system`: an array of text blocks (the Claude Code preamble, then the main prompt with environment info such as
    cwd, platform, date and git state);
  - `tools`: Claude Code's built-in tools (DeepSWE without web tools);
  - `messages[0]`: role user, with a content array of text blocks. That is the instruction, plus `<system-reminder>`
    blocks before it and possibly after it.
- **Other requests in the same trial, probably:** helper calls on the small/fast model (e.g. title or topic
  detection, summaries), Explore subagents on Haiku, general-purpose Task subagents on the main model, and
  `count_tokens` calls if this version sends them. Their order relative to the first main-loop request is not known;
  it matters for §2 (R2).

**A second finding from the profile captures (4f, 2026-11-07; Sonnet client):**
- Claude Code 2.1.318 sends `messages[1]` with **role `system`**, after the prompt: its 9k-character environment
  block, which includes the cwd. Before the fix, the card builder counted it as a non-user step. The last message was
  then not user text, so `latestUser` was empty and the instruction landed in `firstUser`, cut at 1,200 characters.
  The tier-pass check caught this.
- **Fix:** in `fromAnthropic`, a `system`-role message is system text, as Chat's system and developer roles already
  are, and never a conversation step. It is the same kind of Anthropic client-context fix as the reminder filter.
- The system text is appended after `body.system`. Claude Code's own system blocks are 5.6k characters, so
  `systemHead` (the first 600) is unchanged; only `role.chars` grows.
- Codex cards stay byte-identical (the regression was rerun).
- Core's own `lastTurn` for such a request was `other`. 4f fixed that in core: `lastTurn` now comes from the last
  non-system message (0c acked; reviewed by 73). The first request is now user-text, notification turns are
  tool-result, and the first request after a compaction is tool-result too, since Claude Code keeps the last tool step.
- System block 0 is `x-anthropic-billing-header: cc_version=2.1.318.<3 hex>; …`, inside `systemHead`.
  - The 3-hex suffix differs per session and follows the first message. It is not task text, but it is not constant
    either.
  - The fidelity check masks the suffix and compares everything else in `systemHead`.
  - In the offline tier pass every card carries the template's suffix; the live trials carry their own. The facts do
    not depend on it.

**Router-side request fixes for 2.1.318** (0c's Bedrock probe, 2026-11-07):
- The router sanitizes `metadata.user_id`, and strips the advanced-tool-use value from the `anthropic-beta` header.
- Neither changes the card. buildCard reads only `messages`, `system` and `tools`, and the template family is tools
  plus system.
- The beta fix is header-only by requirement and never rewrites `tools`. So the captured client bodies are what the
  router builds its card from. At most, `estPromptTokens` moves by a few tokens, and the fidelity check ignores it.

Nothing above is assumed by the code. The capture records the real request sequence; the card checks (§1.4) and the
template fidelity check (§3.1) fail loudly if the shape differs.

### 1.2 What the current card builder does with it

`fromAnthropic` (packages/assessor/src/card.ts) turns a user message with no `tool_result` into one `user-text`
message whose text is every `text` block joined with `\n`. The client-context filter (`isClientContext`) works at the
message level: it drops a whole message only when its text is exactly one `<environment_context>` or
`<user_instructions>` element, which is the Codex case. Claude Code's reminders are blocks inside the instruction's
own message, so on Claude Code:

- `latestUser.text` starts with the reminder text, not with the instruction;
- the instruction may be cut by the 4,000-character limit;
- facts such as `specification` and `reasoning_depth` would partly be judged on scaffolding.

`turnIndex` = 0 and the absence of `firstUser` stay correct, since it is still one user message.

`role`: the router passes no `roleLabels`, so the card carries `systemHead`, the first 600 characters of the joined
system text. For Claude Code that is the static preamble, the same for every task. For Codex it was Codex's own
instructions head. Both are context the pack does not key on; the facts come from the task text.

The dev-box capture (4f, 2.1.318, 2026-11-07) settles this:
- `systemHead` is identical for Sonnet-, Haiku- and Opus-named requests.
- In the 5,637-character joined system text, the memory-dir line starts at character 2,436 and the cwd at 2,469.
  The first character that differs between models is 2,481.
- So the card cannot tell the models apart from the system text, and the per-task workdir swap does not touch
  `systemHead`. Only `estPromptTokens` can vary with them.
- `messages[0]` has three separate text blocks: two `<system-reminder>` blocks (context, and a git-attribution note
  that names the model), then the instruction alone in its own block.

### 1.3 Proposed change: Anthropic `<system-reminder>` blocks are client context

In `fromAnthropic`, for a user message without `tool_result`:

- Drop every `text` block whose trimmed text is exactly one `<system-reminder>…</system-reminder>` element. This is
  the same "exactly one element, no nested open or close tag" test as `isClientContext`.
- Also strip such elements at the **edges** of a text block, at the start and the end only, never in the middle, in
  case this version joins a reminder and the prompt into one block. The capture decides whether this is needed; if
  every reminder is its own block, edge stripping is left out.
- A message left with no text and no images is client context: it is not a user turn, so it is neither `firstUser`
  nor counted in `turnIndex`. This is the existing message-level rule, applied after the block filter.
- Other dialects are unchanged. Codex never sends `<system-reminder>`, so Codex cards are byte-identical anyway.

**Why this is safe:** the card is untrusted data either way. A user who wraps their own text in reminder tags only
hides that text from the assessor, which leads to less information, typically standard or no opinion. Nothing new
is logged; the change only removes text from the card.

**Tests** (packages/assessor, card.test.ts):

- a Claude-Code-shaped first request (synthetic, no captured text) gives `latestUser` = the instruction, with the
  reminders gone;
- a reminder-only message is not a user turn;
- a reminder in the middle of a block is kept;
- nested or partial tags are not stripped;
- tool-result steps and `prevTurnToolErrors` are unchanged.

**Regression:** rebuild every recorded Codex card (DeepSWE Harbor 112 and TB 84 bodies, plus the R2E bodies where they are still on disk) before and after the
change, and require identical card JSON (sha256 over the sorted list). The map golden tests and pack versions are not
affected (the card is not part of the pack).

**Opt-in alternative** (if 0c wants the deployed router's Anthropic cards to stay unchanged): a
`CardBuildContext.clientContextTags` option, empty by default, which the experiment router sets to `system-reminder`
through a router env var. I recommend the unconditional fix: the current behaviour is a bug for the router's main
Anthropic client, and the observe deployment only logs `proposedTier`.

### 1.4 Card checks in the Claude Code tier pass (fail before anything is billed)

Per task:

- `turnIndex` = 0 and no `firstUser`.
- `latestUser.text` starts with the first 60 characters of the instruction (NFC, trimmed), the same test as the Codex
  Harbor tier pass.
- `latestUser.text` contains no `<system-reminder`.
- `lineage.kind` = root.

Across tasks, recorded for the report (counts and hashes only, never text):

- the `systemHead` hash is one value per dataset profile;
- the tool names and count;
- the distribution of `estPromptTokens`;
- how often `latestUser` was cut, compared with the Codex cards of the same tasks.

## 2. Session semantics: one assessment per trial (requirements for 4f)

Today core keys a lineage as `<session>/t:<template family>`, where the family is the tools hash plus the system
hash. It consults at `session-start`, at `subagent-start`, including a new lineage under a root it has already seen,
and at user-text turns when the policy allows it. With one session header per trial, that gives:

| Request in a trial | What core would do today | Needed for this experiment |
|---|---|---|
| First main-loop request | session-start, consult | **R1:** the only consult in the trial; lineage root |
| Helper call on an explicit model (Haiku), before the main loop | initializes its own lineage; the root is now "seen", so the main loop becomes `subagent-start` (kind subagent on the card) | **R2:** helper calls never consult, never initialize or advance the root's state, and never make the main loop look like a subagent |
| Task/Agent subagent on the main-loop model | new lineage under the root → subagent-start → **consults** and can pick its own tier | **R3:** no consult; served at the session's tier (inherit the root lineage's model) |
| Main-loop request whose tools or system change mid-trial (e.g. tools loaded later) | new template family → new lineage → subagent-start → consult and possibly switch | **R4:** the main-loop lineage stays stable for the whole trial, or a family change is treated as the same lineage |
| Main loop after a Claude Code auto-compaction | free break point (4f, escalation §4); new turn key, so no cached opinion → the desired tier falls back to the pool default (standard) | **R5:** the session's assessed tier persists through compaction, idle-expiry and prefix-reset points (B must not drop Opus → Sonnet at a compaction) |
| count_tokens | not a decision | unchanged |

Explicit models need two harness settings, plus a check on arm B:

- **R6, model aliases.** Harbor 0.25.0 sets `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` and
  `CLAUDE_CODE_SUBAGENT_MODEL` to the main model unless they are already set. To keep Claude Code's defaults, the
  harness must set `ANTHROPIC_DEFAULT_HAIKU_MODEL` (and the small/fast model) to the Haiku id explicitly, and must not
  let `CLAUDE_CODE_SUBAGENT_MODEL` force every subagent onto the main model.
- **Main-loop model in arm B.** Arm B's main-loop requests must carry a model value the router reads as "decide",
  distinct from the helper model id.

How the router implements R1–R5 is 4f's design. One possible shape is a policy key that limits consults to
`session-start`, with subagent and explicit-model lineages served by inheritance or as requested. Whatever the
shape, existing configs must stay byte-identical when it is off.

**Checks on the assessor side:**

- **Mock capture (§3.1):** the full request sequence of one trial per dataset profile, with model, template family
  hash, and whether each request is the first main-loop request. Arm B's router in the mock e2e must show exactly one
  consult, on that request.
- **Pilot, per B trial:**
  - assessor consults = 1;
  - the consulted request is the first main-loop request;
  - the main-loop model is constant after it (no assessor-driven change);
  - helper calls are served as requested and counted separately.

  Any violation fails the pilot gate.

## 3. Offline tier pass with v2.2 on Claude Code cards

### 3.1 Getting realistic first requests without a live run

Rendering the request offline from the pinned version is not practical. Claude Code ships as a bundled binary, and
its request depends on runtime state: cwd, git state, date, settings and CLAUDE.md files. So the bodies come from a
**capture**, the same method as the Codex Harbor tier pass (template from a live first request against a mock, with
the instruction substituted per task):

1. **Capture (with 4f, local mock e2e, no AWS).**
   - Run Harbor's claude-code agent, with the pinned Claude Code version and the per-dataset agent config (DeepSWE
     profile: no web tools; TB profile: as the Codex TB profile), against a local mock Anthropic upstream.
   - The mock records each request body and returns a minimal `end_turn` response, so the session ends after the
     first turn.
   - One capture per profile, with any real task's instruction. The capture stays under `results/` (gitignored); it
     holds Claude Code's prompt and the instruction, so nothing from it is committed.
2. **Template.**
   - The first main-loop request, with the instruction's text block made the placeholder; it must match exactly
     once.
   - The cwd in the system environment block set per task (DeepSWE WORKDIR, TB `/app`), as `task_body` does for
     Codex.
   - Reminder blocks stay in the template (the card filter must remove them; that is what §1.4 tests).
3. **Bodies.** The template plus each task's `instruction.md`, canary stripped, for 112 DeepSWE and 84 TB tasks.
4. **Fidelity check.**
   - The template comes from 4f's dev-box capture (arm64 build of the same version):
     `experiments/claude-code-harbor/results/capture/<profile>/first-main.json`.
   - The dev box cannot run the x86 task images, so the real captures come from runner 0 right after setup and
     before the pilot, at $0 (4f: `cli.py capture --task <id>`, tasks' own images, x86 build, local mock upstream).
   - Six tasks, chosen to cover instruction length, the 4,000-character cut and non-`/app` workdirs:
     - DeepSWE: `mashumaro-flattened-dataclass-fields` (shortest, 571 chars), `actionlint-action-pinning-lint`
       (median), `arcane-drift-detection-baselines` (longest, 5,484, cut);
     - TB: `crack-7z-hash` (shortest, 123), `llm-inference-batching-scheduler` (longest, 4,346, cut),
       `prove-plus-comm` (WORKDIR `/workspace`).
   - Each must give the same card as its template body, except `estPromptTokens`, which varies with git state and
     repo CLAUDE.md (the ratio is reported). A difference in any other field stops the pass, before any live call.
   - If the only difference is arm64 vs x86 (e.g. a platform line inside `systemHead`), rebuild the template from a
     runner capture and rerun the check.

   Order: runner setup → captures → fidelity → 0c's live tier pass → gate table to the user → pilot.

### 3.2 Code (branch cc-harbor, worktree llmar-cc; built and tested, uncommitted)

- `packages/assessor/src/card.ts` + `card.test.ts`: the §1.3 filter and its tests.
- `experiments/claude-code-harbor/tierpass.py`:
  - **bodies:** from the capture template; reuses `deepswe-harbor/tierpass.py` helpers (`strip_canary`, instruction
    and workdir reading) by import, without editing them;
  - **summary:** the gate tables below.
- `experiments/claude-code-harbor/tierpass.ts`: Anthropic Messages, pack v2.2, the §1.4 checks.
  - It is a new file: the Codex Harbor `tierpass.ts` pins v2.1 and Responses, and stays frozen.
  - It uses the same STS account guard, per-call cost rows and spend cap as the Codex Harbor tier pass.
  - Offline by default; `--live` only for 0c.
- `experiments/claude-code-harbor/cardcheck.ts`: the Codex-card regression (§1.3), offline.
- **Ledger:** `experiments/claude-code-harbor/results/ledger.json`, cap $0.30, separate from every other ledger.
- Also: `tierpass.py` gains the subcommands `capture-bodies` and `fidelity`, and `tierpass.ts` takes `--pack v2.2|v2.1` (only v2.2 is run).

**On the real profile captures (offline, $0):** all 196 cards pass the §1.4 checks.
- `latestUser` is cut on 8 DeepSWE and 1 TB task.
- `systemHead` is one text per profile; it differs between the DeepSWE and TB profiles.
- `role.chars` varies only with the cwd length.
- The tools are the same 12 names for every task.
- `estPromptTokens` runs from 11.5k to 12.9k.

**Results so far (offline, $0):**
- The Codex-card regression is byte-identical on 702 recorded bodies: DeepSWE Harbor 113, TB 89, R2E 500. The same
  script reports a difference on an Anthropic body with reminders, so it does detect changes.
- Assessor tests: 209. All six package suites and the typecheck pass. The tier-pass tests (8, synthetic, including an
  offline end-to-end run of bodies → cards → fidelity) pass.
- A synthetic Claude-Code-shaped capture with all 196 real instructions builds 196 cards, and every card passes the
  §1.4 checks. `latestUser` is cut on 8 DeepSWE and 1 TB task, the same as on the Codex cards: the instruction's own
  length decides the cut, not the reminders.

### 3.3 The live step (0c)

The settings are the arm-B experiment config: Luna, threshold 0.8, `ROUTER_ASSESSOR_AUTO_RULES=all` (v2.2's rules
are all `auto:false`, so `pack` could never act in auto mode), and the router deadline of 5,000 ms. The run is 3 passes
× 196 cards = 588 calls. At the $0.00034 per call measured on Codex Harbor cards, that is about $0.20. Claude Code
cards are about the same size, since the card is capped and its prompt is mostly the pack. Spend stops at the $0.30
cap. Label: `cc-v22`.

`tierpass.py summary` refuses to run if the label's pack version does not end in `e2183dce2cb9`, the hash of the
Codex-card v2.2 calls it is compared with (labels `d1a` and `v22d-eval`).

### 3.4 Gate summary for the user (before the pilot)

Per dataset, all counts and percentages:

| Item | Content |
|---|---|
| Cards | built / passed checks; the cut rate of `latestUser` vs the Codex cards of the same tasks |
| Tier mix | per call (fast / standard / frontier / no opinion), and the per-task majority of 3 |
| Stability | flip rate across the 3 passes; no-opinion reasons (low confidence, timeout, invalid output) |
| Latency | p50 / p95 / max against the 5,000 ms deadline; cost |
| Agreement with the Codex-card v2.2 calls on the same tasks | per-task majority-tier agreement and the cross table. Codex side: `d1a` + `v22d-eval`, the same prompt and mapping, hash `e2183dce2cb9`. No new Codex calls. κ is given but marked degenerate when one tier is above 90% |
| Fact agreement | the same comparison per fact (scope, specification, reasoning_depth, prior_failures). With nearly constant tiers, this is the informative part: it shows whether Claude Code's request changes what the assessor reads from the same task |
| Implication for arm B | the share of sessions B would serve on Haiku, Sonnet and Opus, compared with arms F, A and C |

There is no pass/fail threshold on the tier mix: the pack is not re-tuned. The gate fails only on card or harness
problems: any card check failing, or more than 5% of calls invalid or past the deadline.

**What to tell the user with the table:**

- If more than 90% of sessions map to standard, as on Codex cards, B is close to a second Sonnet arm. B−A then
  measures almost nothing, and B costs about as much as A.
- The user has decided on four arms with B on v2.2 ("v2.2 as released"), and turned down a v2.1 arm. The table
  states what B can and cannot show (§4); it does not reopen the arm design.

## 4. Transfer caveat: what the report may and may not claim

v2.2 was built from GPT-family outcomes: Codex with Luna, Sol and Astra. Its one validated change is narrowing
frontier, because Astra bought nothing measurable over Sol on these benchmarks. That fact is about the GPT tier pair.

**The report may claim:**

- **Outcomes of arm B as deployed:** the resolve rate, cost and per-solve cost against A, C and F, with 0d's
  estimands. B is "the released v2.2 on Claude Code".
- **Card transfer:** whether the assessor reads the same task the same way from Claude Code's request as from
  Codex's. This is the tier and fact agreement in §3.4, on the same tasks and with the same pack.
- **The tier mix B actually produced,** and its consequence. For example, if B ≈ A by construction, say so in the
  summary, not only in a footnote.
- **Descriptive, hypothesis-generating results from A, C and F:**
  - the per-task best tier on Claude outcomes;
  - the split-half upper bound for a card-only router, as in v2.2 §7.5;
  - outcome rates by v2.2 fact cell.

  These are inputs to any future Claude-calibrated pack, which would need its own held-out split. Out of scope here.

**The report should not claim:**

- that v2.2 is calibrated for, or optimal on, the Claude family;
- that B's result validates or refutes the v2.2 tuning, or the assessor's selection skill on Claude. With nearly
  every call standard, there is no selection to measure. A good or bad B−C says nothing about the frontier rule,
  which the GPT data shaped;
- that "the assessor doesn't help on Claude" in general. Only this pack, card and agent were tested, at one decision
  point (session start);
- B vs F as "assessor vs fast". Helper calls go to Haiku in every arm, so each arm's cost includes Haiku helper
  spend. The report gives the main-loop and helper split per arm (PRD R1);
- cross-agent comparisons (Codex vs Claude Code) beyond description. The agents, harness defaults and model families
  all differ at once.

The assessor model is Luna (GPT) in both experiments. It judges task facts, not which model family does the work, so
that is not itself a transfer issue, but the report should state it.

## 5. Open items

- **4f:**
  - the capture in the local mock e2e (the request sequence and the first main-loop body per profile);
  - whether this Claude Code version sends reminders as separate blocks;
  - helper and subagent request patterns;
  - R1–R6 in the router and harness design.
- **0c:**
  - ack of this design;
  - the filter decision (§0.1);
  - the live tier pass (v2.2), about $0.20;
  - showing §3.4 to the user, with the B ≈ A question.
- **0d:** whether the §3.4 agreement statistics, and the §4 descriptive analyses, belong in the pre-registration.
