# Claude Code × Harbor: DeepSWE v1.1 + Terminal-Bench 2.1, auto (assessor v2.2) vs pinned Claude 5.5 tiers

## Goal
The user asked for this on 2026-11-07, after the two Codex × Harbor runs and the release of assessor v2.2. Those runs found that frontier (gpt-6 Astra) bought nothing measurable over standard (gpt-6.1 Sol). One reason was that the tier pair had no real capability gap. This experiment repeats both benchmarks with **Claude Code** and the Claude 5.5 family, where Opus/Sonnet/Haiku are one generation and the gap between tiers is expected to be real.

## User decisions (2026-11-07, verbatim where quoted)
- "用habor + claude code 来跑同样的DeepSwe v1.1 和TB 2.1实验。用新的v2.2版本assessor，只需跑auto，standard（对应sonnet 5.5），frontier（对应opus 5.5）， 每组跑3次即可。"
  ("Run the same DeepSWE v1.1 and TB 2.1 experiments with Harbor + Claude Code. Use the new v2.2 assessor. Only auto, standard (Sonnet 5.5) and frontier (Opus 5.5) are needed, 3 runs each.")
- "fast（对应 haiku 5.5） 也一起跑吧" ("run fast (Haiku 5.5) too"). That makes four arms:
  - **A** pinned Sonnet 5.5 (`global.anthropic.claude-sonnet-5-5`, standard);
  - **B** auto + assessor v2.2: frontier → Opus, standard → Sonnet, fast → Haiku;
  - **C** pinned Opus 5.5 (`global.anthropic.claude-opus-5-5`, frontier);
  - **F** pinned Haiku 5.5 (`global.anthropic.claude-haiku-5-5`, fast).
- **3 runs per task per arm, fixed.** Same task sets as the Codex runs: DeepSWE 112 tasks (the 113th's reference solution fails) and TB 2.1 84 tasks (5 dropped by the pre-registered oracle/nop rule). The pins must be re-checked before the run (task drift, §4.3 of the Harbor summary).
  - DeepSWE: 112 × 4 × 3 = 1,344 runs.
  - TB: 84 × 4 × 3 = 1,008 runs.
  - Total 2,352 runs.
- **Staged runs (user, 2026-11-07):** "每组先跑一次看看，这样能剩下不少吧？" (run each arm once first and look; that should save a lot, right?).
  - **Stage 1** is rep 1 of every arm on both datasets: 784 runs, about 1/3 of the cost.
  - **Stage 2** (reps 2–3) runs only if the user decides to continue after seeing stage 1.
  - The look between stages is pre-registered by 0d before any stage-1 outcome is seen:
    - the stage-1 reading rules (the wider CIs; alpha spending if a stage-1 claim is allowed);
    - the stage-1 + 2 combined analysis.

    This avoids the DeepSWE interim-look problem (Harbor summary §4.3).
  - Measured on the Codex data, one run per task gives paired CI half-widths of about ±5–7 pp for B−A and C−A, against ±3–4 pp at 3 runs. So stage 1 alone can only detect large gaps.
- **Budget $8,000** total for Bedrock across both benchmarks, including the pilot. The rough estimate is about $2,400, but Claude Code may use 2–3× Codex's tokens. Standing preference: "不要为了严格控制预算，导致最后白跑了" (don't let budget control make the run worthless). If the pilot projection exceeds the cap, stop and ask the user; don't cut runs.
- **Effort high** for every arm, the same as the Codex runs.
- **Helper calls keep Claude Code's defaults.** Claude Code sends some calls (the Explore subagent, background tasks such as titles and summaries) to its small/fast model, Haiku. These stay as Claude Code chooses, in every arm.
  - The arm decides only the **main-loop model**. Pinned arms pin the main loop; auto lets the assessor pick the main loop's tier.
  - Claude Code's explicitly requested helper model is served as requested.
  - The router and host proxy must support this. Today the proxy requires body `model: "auto"`, and pin hints override every call.
  - The analysis reports the helper share of calls and cost per arm.
  - **Observed 2026-11-07** (4f's frozen native role table, sha256 cdd8ddab…, stats Amendment 4, case 4b): Claude Code 2.1.318 natively requests the main model for every role: main, Task, Plan, Explore and compaction. It sends no background calls in --print mode.
    - So "keep the defaults" turns out to mean "every call on the arm's model", and the helper class is empty by observation.
    - The premise in the question asked of the user ("helpers go to Haiku") doesn't hold for this version. The user is told.
- Same networking as before:
  - DeepSWE offline (proxy only);
  - TB with outbound 80/443 and the guardrails the user accepted for TB (residual risks b and c accepted 2026-11-06).
- Same runner shape: 4 × x86 8 vCPU / 64 GB, sharded by task. DeepSWE first, then TB on the same runners. Torn down and verified after.

## Scope change (user, 2026-11-07, after the public-data analysis)
**What the public data showed.** The public DeepSWE v1.1 trials (mini-swe-agent, effort high, 4 attempts per task) were analysed offline against the recorded v2.1 and v2.2 tier calls:
- Opus 5 beats Sonnet 5 by +25.1 pp [+16.7, +33.3], at ×0.82 of the cost per run, because Opus needs about half the steps.
- auto with v2.1 is −10.5 pp against pinned Opus, and auto with v2.2 equals Sonnet.
- Even the held-out ideal Sonnet/Opus router (71.0%) doesn't beat pinned Opus (73.3%).

**The user's decision:** "还想确认 Claude Code + 5.5 是否也是这个模式，只跑一个小规模验证：只跑 Sonnet 和 Opus 两组的第一阶段。" (still check whether Claude Code + 5.5 follows the same pattern, with a small validation: only the Sonnet and Opus arms, stage 1).

So the live run becomes:
- **Arms A (pinned Sonnet 5.5) and C (pinned Opus 5.5) only.** B and F are dropped, and so is the tier pass, since nothing routes.
- **Stage 1 only:** rep 1 on DeepSWE (112 × 2 = 224 runs) and TB (84 × 2 = 168 runs), plus the pilot slice for those two arms. Stage 2 is not planned. If the user ever wants more, it's a new decision under 0d's staged rules.
- **The question:** does Claude Code + 5.5 show the same pattern as mini-swe-agent + Claude 5, i.e. C − A clearly > 0 at cost per run C ≲ A? The comparison with the public Claude 5 numbers is descriptive.
- **Budget:** the $8,000 cap stays. The expected spend is about $0.7–1.0k (≈ $300 × m, where m is Claude Code's token multiple over Codex, 2–3).
- **Everything else is unchanged:** harness, router fixes, runners, OOM and lookup rules, N5.

**Teardown authorisation (user, 2026-11-07: "同意清空", i.e. "I agree to empty it"):**
- **What:** empty this experiment's runner results bucket at teardown, and nothing else.
- **When:** only after the final fetch is verified (file counts, sizes, export manifest).
- **Then:** destroy the runner stack, and verify the teardown.

**Deploy-day notes for 0c:**
- **Budget file.** `experiments/claude-code-harbor/results/budget.json` (gitignored) is read by the start pre-flight:
  `{"schema":"cc-budget/v1","total_usd":8000,"outside_usd":{"probes":…,"tier_passes":…,"runner_hours":…}}`
- **Plan details.** Copy `experiments/claude-code-harbor/results/{deepswe,tb21}/plan-detail.json` from llmar-cc into the run checkout, then run `project --caps-for pilot --prior-m 3 --prior-tau 1.5`.
- **Runners and router.** 4 runners, 300 GB, pinned AMI, restored secret. The router redeploy needs the Bedrock-compat and lastTurn fixes; its config comes from 4f.
- **Before the TB switch:** read the DeepSWE drop counters.
- **Before teardown:** export the TB connection log, verify the fetch, empty the bucket (authorised above), destroy the stack and verify.

## What is reused
- The Harbor harness in `experiments/deepswe-harbor/`: driver, fleet, shardplan, classify, profiles, hproxy, harvest, report_zh, taskpin, lookupscan, leakscan, isolation.
  - Add an agent dimension (codex | claude-code) as a profile, not a copy.
  - The Codex DeepSWE and TB goldens must stay byte-identical.
- The runner stack (`infra`, runner.ts, egress modes none|internet) and the router (llmar-router) with policy.experiment, which already has the anthropic-messages pool (Opus/Sonnet/Haiku 5.5).
- Assessor pack v2.2 (the default since 2026-11-07), unchanged. This experiment also tests whether a pack calibrated on GPT-family outcomes transfers to the Claude family. It is not re-tuned.
- The statistics method (0d): paired task-level estimands, CIs, NI bounds, no interim looks, the lookup-flag rule on TB.

## Requirements
1. **Claude Code in Harbor.**
   - Harbor's claude-code agent, or a thin custom agent if needed, with a pinned Claude Code version staged on the runner. DeepSWE is offline, so no install-time network.
   - Point it at the host proxy (an Anthropic base URL) with a dummy key; the token never enters a container.
   - Turn off non-essential traffic: telemetry, auto-update, error reporting.
   - Effort high; the main-loop model is set per arm; helper models are left at Claude Code defaults.
   - No web search or fetch tools on DeepSWE. On TB, the same as the Codex profile.
2. **Proxy and router.**
   - The host proxy serves the per-trial Anthropic Messages route (POST messages, plus count_tokens if Claude Code needs it). It does the SSE usage tap and per-call pricing with Claude cache writes (5m/1h), and keeps the hard cap with fail-closed behaviour, the session header and the arm hint.
   - The router honours an explicit model on a call when the arm or policy allows it (helper calls), and decides the main loop by pin or assessor.
   - Router behaviour for existing configs stays byte-identical unless this is explicitly enabled.
     - **The one exception (0c, 2026-11-07):** the assessor card builder drops Claude Code's `<system-reminder>` blocks from the user text, for every Anthropic client. It's a bug fix, and on the deployed observe router only the logged proposedTier changes.
     - **A second exception (0c, 2026-11-07):** Anthropic `system`-role messages in `messages[]` become system text, not a conversation step. Claude Code 2.1.318 sends its environment block that way; 73's fix is commit 1dda7d1.
     - Codex/OpenAI cards stay byte-identical, verified by hash over every recorded Codex card.
     - Lineage, consult-once and compaction (73's R1–R5) are opt-in.
   - The assessor judges once per session from the main-loop request. The card builder must handle Claude Code's first request.
3. **Offline tier pass** with v2.2 on Claude Code cards (about $0.10), shown to the user before the pilot, as for the Codex runs.
   - It is informational only. The user decided against a v2.1 arm ("为啥还把v2.1加进去？", 2026-11-07), so the arms are final at A/B(v2.2)/C/F.
   - "Is Opus worth routing to" is answered by C−A and by the descriptive ideal-router analysis over A/C/F.
4. **Pilot**, then the full run. The pilot calibrates cost per arm, checks that every call is attributed (router log ↔ trial 100%), and checks the helper/main split.
5. **Pre-registered analysis (0d), written before the pilot outcomes are seen.**
   - The same comparisons as before: B−A, B−C, C−A, F−A, with cost ratios and per-solve cost.
   - Selection ability, and the helper share.
   - A cross-agent section comparing against the Codex results, descriptive only.
6. **Report** (zh) under `docs/experiments/`, and an update to `harbor-summary.zh-CN.md`, or a new summary if that reads better.

## Constraints
- **AWS writes only from 0c** (the parent session):
  - redeploy the runner stack from a clean worktree of HEAD;
  - restore or recreate the `llmar-runner/client` secret;
  - switch the router to the experiment config for the run, then restore the default observe config.
- Create only `llmar-*` resources, tagged; verify every teardown; touch nothing else.
- N5: no third-party task text, account ids or names in committed files. Run leakscan --strict before commits.
- Builder security: the proxy binds the docker bridge only; SigV4/IAM between services; no credentials in logs or containers.
- Never commit `.trellis/`; mirror it with scripts/sync-docs.sh.

## Acceptance criteria
- [ ] Design (§ owners: 4f harness/proxy/agent, 17 orchestration, a3 runner, 73 assessor/tier pass, 0d statistics) reviewed by 0c before any spend.
- [ ] Offline tier pass result shown to the user.
- [ ] Pilot passes: attribution 100%, cost projection ≤ $8,000 (otherwise stop and ask), no harness errors.
- [ ] Full run complete: 2,352 runs, or every missing run classified per the pre-registered rules.
- [ ] Report committed; spend ledger ≤ $8,000.
- [ ] Runners torn down and verified; router restored to the default observe config.

## Out of scope
- **Follow-up product gap (4f, Q7):** the AgentCore gateway doesn't forward `x-claude-code-parent-agent-id`, so router subagent lineage can't see Claude Code's parent id on the gateway path. It gets filed separately. The experiment doesn't depend on it, because `policy.sessionTier: "root"` covers it.
- **Follow-up product gap (4f, 2026-11-07):** Claude Code 2.1.318 puts `x-anthropic-billing-header: cc_version=…<3 hex>` in system block 0, and the suffix changes after every compaction.
  - So core's system hash and template family change too. Post-compaction main loops become new lineages under the root (`subagent-start`), and their warmth and cost state restarts.
  - Experiment arm B is unaffected, because sessionTier root keeps the tier.
  - The candidate fix is to treat that block as metadata in the system hash and family. It changes the chain for every Claude Code request, so it needs its own decision and a replay check.
- Re-tuning the assessor on Claude outcomes. That could follow, on a held-out split.
- Codex re-runs.

## Run log (0c, outcome-blind)

**DeepSWE, closed 2026-11-07 (harness at main a33121a; the run itself started from 45953c5).**
- **Main pass:** 224 finals. Arm A has 112 scored; arm C has 111 scored and 1 excluded.
  - The exclusion is pwntools-tube-multiplexing / C. The verifier timed out (1,800 s) on all 3 attempts ("patch lost"), so it is class verifier_infra and excluded pairwise-complete per stats §7: 111 pairs.
  - Reruns: 2 verifier_infra (that task), plus 1 harness (expr-try-catch-errors / C attempt 1: a RuntimeError at startup, 3.8 s, 0 calls, $0).
  - 0 upstream errors, 0 429s, 0 host OOM.
- **Spend:** $400.77 settled for DeepSWE, pilot included (pilot $25.29, main $375.48). Budget closed with $25.05 outside, so the total is $425.82 of $8,000.
- **Call-level checks (§4.2 and §16, over the main pass with the frozen role table): all pass.**
  - 8,201 calls: A 3,532, C 4,669. 0 unattributed, struct/role agreement 1.0.
  - Router join over 17,476 log events: no_router_decision 0, router_incomplete 0, gateway_fallback 0, pin_served_other 0, requested/main/helper served wrong 0.
  - count_tokens: 67 calls (A 16, C 51), all 404 answered locally, predicate broken 0, so no stop.
- **Fetch.** The light fetch skips files over 1 MiB, which includes each runner's main-pass `proxy/calls.jsonl`. The call checks therefore need the full fetch (S3); the first merge on light data showed only pilot calls.
- **Leakscan-blocked files (stay on the runner, lost at teardown).**
  - Almost all are the voided pilot-1 C trials: the gateway-role ARN in the 403.
  - The one exception is one scored main C trial (goreleaser-retry-publish-auditing). Its transcript files hold 32 `Basic <base64>` strings. A runner-side check printed counts only: none decodes to or contains the runner client id or secret. So it is repository fixture text.
  - That trial's result and cost records are exported.
- **Memory telemetry.** Host PSI memory-some reached 0.40, only on runner 1 between about 12:37 and 13:00 UTC, across 10 main trials (5 tasks × both arms).
  - Cause: one C trial at its 8 GB container limit swapped heavily (host swap up to 6.6 GB). Its neighbours stalled on IO and reclaim.
  - The host always had ≥ 50 GB available, with 0 OOM kills.
  - The pre-registered PSI rule (cpu-full > 0.05) decides concurrency before main only. cpu-full was 0.0, so this is reported as telemetry.
- **Drop counters before the switch** (saved under results/deepswe/drop-counters/), identical on all 4 runners despite different shards: DOCKER-USER IMDS 16, br+ 48, docker0 45–46; RUNNER-BRIDGE-IN 584. So they are deterministic (the isolation suite's probes), not trial traffic.
- **Archive:** every runner was frozen read-only. Each manifest matches the last full export, and the files not in the export are exactly the blocked ones (30/33/30/30).

**TB changeover, 2026-11-07.**
- Harness shipped (pack sha256 prefix b279d071) and the egress switched to internet on all 4 runners (exit 0, backups under the runner's egress-backup dir).
- printk is `4 4 1 7` and journals use 16–32 MB; the isolation suite passes on all 4.
- Setup: 19 + 21 + 22 + 22 = 84 tasks.
- Prepull: 23–26 images per runner, 0 failed, ≥ 240 GB free afterwards.
- Oracle/nop checks: dropped [], unresolved []. tune-mjcf is `flaky_env` (oracle 1 of 2, kept), the same as in the Codex TB run. Leakscan blocks 6 oracle/nop logs of sanitize-git-repo; that task is about scrubbing fake keys, so this is fixture text.

**TB pilot, 2026-11-07.**
- **First start (caps 16/16/17/16, soft 5): cap-stopped on runners 0, 1 and 3 within minutes.** hproxy admits a call only if settled + every in-flight worst-case reservation + this one ≤ hard − reserve, which was $6. Claude Code's max_tokens 128000 makes each reservation about $2–5, and the cc cap formula had no in-flight term. DeepSWE's larger caps had hidden this.
  - Runner 2 (limit $7) finished its 4 trials normally.
  - 17's fix is cc-harbor c5d63e4, merged into main as ea7f535:
    - hard gets an additive allowance of concurrency × the per-call ceiling, where the ceiling is a context-window prompt at the 1h write rate plus 128k output (Opus 5.5 $10.56; $84.48 at concurrency 8);
    - soft is unchanged;
    - the start pre-flight refuses caps without the allowance;
    - projection counts voided spend.
- **Recovery on runners 0, 1 and 3:** stop → fetch → void-pass ($0.50 voided, on the ledger) → unstop → merge → caps 101/101/103/102 (soft 5/5/6/6) → `start --unstop-cap`. Pre-flight exposure was $746.82.
- **Pilot result:** 18 finals (9 tasks × A/C), all class agent, 0 reruns, 0 429s.
- **Gate: ok.**
  - 155 calls (A 84, C 71), 0 unattributed; router join over 326 events.
  - Every §4.2/§16 check is 0. There were no count_tokens calls.
  - PSI memory ≤ 0.0012, no OOM.
- **Costs:** measured κ A 1.343, C 0.353. Projection: TB $65.09, experiment total $490.91.
- **caps-main:** hard 113/117/118/123, soft 15/19/19/24.
- **Scanner:** the run-config records lookupscan_version f462bb9a58e0e9c2 (the hash of the shipped file). Criterion (b) on the pilot transcripts is with 4f.
- **Scanner criterion (b) passed (4f, reward-blind).** A 0/9, C 0/9, base layer 0/18, no task flagged in both arms. Both scanner-cal tasks are covered in both arms. Transcripts are complete (session and stream tool_use counts agree in 18/18).
  - Criterion (a) is the existing 0/1,008, so VERSION f462bb9a58e0e9c2 is frozen.
  - The run-config already records it. 0d's sign-off was requested before TB main.

**TB main, 2026-11-07 (0d signed off the scanner freeze; caps-main at concurrency 8).**
- **Run:** 168 main finals, 0 429s, no OOM, PSI ≤ 0.008. There were 2 agent timeouts (task limits), scored per §7. Spend: TB $50.55 settled, $0.50 of it voided.
- **Refusal fallback.** In 9 (task, arm) pairs the pinned model refused twice. Claude Code 2.1.318 then switched the session to a built-in fallback model:
  - Opus 5.5 → claude-opus-4-8 (cyber) or claude-opus-5 (bio);
  - Sonnet 5.5 → claude-sonnet-5 (cyber).
  - hproxy's pool check answered that request 403 model-not-allowed, and Claude Code exited.
  - The run-time classifier called this `upstream`, so each pair was rerun ×2 and then excluded.
  - **The pairs.** A has 3: crack-7z-hash, vulnerable-secret, break-filter-js-from-html. C has 6: those 3 plus password-recovery, dna-insert, dna-assembly.
- **Ruling and reclass.** 0d's §18 (Amendment 9, 0b34a49) rules these pairs sut `refusal_fallback_blocked`: attempt 1 is scored 0, attempts 2–3 are superseded, and the 27 fallback requests are §13 deviations.
  - 17's reclass is cc-harbor f196e10, merged into main as a84af4e. Classifier VERSION 3a18f4db… (run-time aad5dbb0…).
  - Re-merge: TB 84 + 84 scored and 0 excluded; the gate is ok. Verifier ran on 9/9 attempt-1 trials. DeepSWE is unchanged: 0 matches.
- **Scanner:** f462bb9a58e0e9c2 on 186/186 TB main attempts.

**Teardown, 2026-11-07, as the user authorised ("同意清空").**
- TB connection logs: exported from each runner via its own results prefix (2,811 / 4,893 / 3,284 / 3,850 lines); the gz sha256 matched on-runner and local.
- TB archive: every runner's manifest matches the last full export. Not exported are runner 3's 12 leakscan-blocked files (sanitize-git-repo logs). **Correction (0c, after teardown):** the trial dirs of count-dataset-tokens (main A1/C1) and vulnerable-secret (main A1–3/C1–3), plus their check dirs, were never exported. driver.py's EXPORT_NEVER name filter (token/secret/credential, which also matches directory names) dropped them, and the archive's allowlist count excludes them too, so the check could not show it. Their ledger rows (attempts, calls, router join, lookup record) are intact; the transcripts and verifier files are lost. An earlier note called the vulnerable-secret loss leakscan-blocked; that was wrong. The fix goes to 17 as a follow-up (basename-only match, plus a by-name count in archive).
- The results bucket held 28 objects (export payloads and manifests, plus connection logs); it was emptied and verified at 0.
- `cdk destroy llmar-runner`, run from the deploy worktree with the deploy context. Verified:
  - the stack no longer exists;
  - 4 instances terminated, 0 volumes;
  - bucket, VPC, security group, 3 roles, 4 instance profiles, log group and Lambda all gone.
- Left in place:
  - the router, in default observe mode; it was never switched;
  - the `llmar-runner/client` secret, which was restored for this run. Scheduling its deletion needs the user's go.
- **Spend:** DeepSWE $400.77 + TB $50.55 + outside $25.05 = $476.37 of $8,000.
- **Results:** backed up to the main checkout's gitignored experiments/claude-code-harbor/results/ (the /tmp worktrees are tmpfs).
- **TB S6 connections (4f, outcome-blind):** results/tb21/connlog/s6-connections.json. All 14,838 lines are explained. No non-allowlisted egress was accepted. The only rejects are TCP 5228 (Google push) from filter-js-from-html; they also appear in its oracle runs, so they come from the task environment.
- **Export-filter follow-up (4f, 17).** The same EXPORT_NEVER filter explains 24 of the 30 Codex TB runs that had no local transcript: all 12 runs each of vulnerable-secret and count-dataset-tokens. The other 6 were leakscan-blocked (5 sanitize-git-repo, 1 make-doom-for-mips).
  - So Codex TB scanner (a) was 0/978 scannable runs (0d §15.7).
  - Fix: cc-harbor bc4ca21, merged into main as 9039250. The rule now matches the file name only, and archive lists the files excluded by name per directory.
