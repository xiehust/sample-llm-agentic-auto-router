# Claude Code × Harbor orchestration (17; CC orchestration design, acked by 0c)

Claude Code runs on the DeepSWE harness (`experiments/deepswe-harbor/`) with `--agent claude-code` and
`--dataset deepswe | tb21` (`profiles.py`: `cc-deepswe`, `cc-tb21`). Without `--agent`, every command is the Codex
run, byte for byte.

**Current scope (0c, 2026-11-07): a small validation.**
- **Arms:** A (Sonnet 5.5 pinned) and C (Opus 5.5 pinned) only.
- **Stage 1 only:**
  - DeepSWE: pilot 16 runs + main 224;
  - TB: pilot 18 runs + main 168.
  - 392 main runs in all. No rep2/rep3 and no stage 2.
- **Gates dropped:** the tier-pass and assessor gates. TB blocks are stratified by category group × difficulty, so no tier pass is needed.
- **Gates kept:** attribution, the §13 role table, OOM, 429, PSI and the budget.
- **Expected cost:** about $0.7–1.0k, i.e. 0d's m ≈ 3. The pilot caps use `--prior-m 3 --prior-tau 1.5`, and main's caps come from the pilot's measured κ.

| File | What it is |
|---|---|
| `arms.json` (committed) | The arm table (`cc-arms/v1`): A Sonnet 5.5, B auto + assessor v2.2 (client Sonnet, CapLedger worst case Opus), C Opus 5.5, F Haiku 5.5. No router hint in any arm (the body model is the pin). `codex_ref` is the Codex arm paired for κ. `planning_usd` holds 0d's planning cost per run, which is the prior κ. A fifth arm would be an edit here; the user kept A/B/C/F. |
| `native-roles.json` (committed, 4f) | Claude Code 2.1.318's native role table. It is loaded only by its sha256 `89f7e8c0…ba93` (design-stats §13). |
| `deepswe/plan.json`, `tb21/plan.json` (committed) | Derived from the Codex plans: same tasks minus the pre-registered drops, same shards and pins. Passes `pilot`, `main` (stage 1), `rep2`, `rep3` (stage 2). Seed 20261107. |
| `results/` (gitignored) | `budget.json`; per benchmark `plan-detail.json` (Codex costs and walls per task), `caps-*.json`, `caps-committed.json`, `fleet/`, `merged/`. |

## Plans (once, before stage 1)

The committed plans are the A/C validation's:
```
S="python3 experiments/deepswe-harbor/shardplan.py --agent claude-code"
$S --dataset deepswe derive --only-arms A,C --passes main \
   --codex-attempts <Codex DS merged>/attempts.jsonl --drops <Codex DS merged>/checks.json
$S --dataset tb21 derive --only-arms A,C --passes main \
   --codex-attempts <Codex TB merged>/attempts.jsonl --drops <Codex TB merged>/checks.json \
   --scanner-cal mailman,make-doom-for-mips,fix-code-vulnerability,pytorch-model-recovery,hf-model-inference
```
The full design adds no `--only-arms` and passes main,rep2,rep3. For TB it also adds `--tiers <73's Claude Code tier pass strata.json>`, which an auto arm requires.

- **Sizes:** DeepSWE 112 tasks, TB 84 tasks (5 drops, recorded in `dataset.dropped`). Each pass runs every plan arm once per task: 224 and 168 runs with A/C.
- **Pilot:** per shard, the two tasks nearest the 25th and 75th percentile of Codex-measured cost. TB adds the 2 `scanner-cal` tasks. Costs are the only input (outcome-blind).
- **Block order:** stratified and seeded; TB's ≥ 7200 s tasks come first.
- **Stages:** stage 2 continues stage 1 in the same file and the same blocks.

## Commands

```
F="python3 experiments/deepswe-harbor/fleet.py --region <region> --stack <prefix>-runner"
D="$F --agent claude-code --dataset deepswe";  B="$F --agent claude-code --dataset tb21"
RT="--role-table experiments/claude-code-harbor/native-roles.json --role-table-sha256 89f7e8c0908dd81855ec90f2fb62240cc160499df595d9fa2ae94be84807ba93"
GW="--gateway-url <GatewayUrl> --router-policy-version <router policyVersion>"
```

`results/budget.json` (0c writes it):
`{"schema": "cc-budget/v1", "total_usd": 8000, "outside_usd": {"tier_pass": …, "runner_hours": …, "assessor": …}}`.

### Stage 1

1. **Changeover from TB (Codex).**
   - Fetch and stop TB Codex: `$F --dataset tb21 fetch --mode full`, then `stop`.
   - Pack and ship: `$D pack; $D ship`.
   - Archive TB Codex: `$F --dataset tb21 archive`.
2. **Switch DeepSWE to egress none.** a3's switch to `CONTAINER_EGRESS=none`, then `$D isolation --wait`. Every gate must PASS.
3. **Prepare the runners.**
   - `$D setup`: stages Claude Code 2.1.318, both glibc and musl builds, and clones deep-swe.
   - `$D prepull`: pulls the images, records RepoDigests, and runs a3's libc gate. `prepull.json` gets `claude_build` per task. A task where no build runs fails prepull, and `run` refuses it.
   - `$D check --concurrency 6`, then `fetch` and `merge`.
4. **DeepSWE pilot.**
   ```
   $D project --caps-for pilot $RT --prior-m 3 --prior-tau 1.5   # prior κ → results/deepswe/caps-pilot.json
   $D start --pass pilot $GW --concurrency 6 --caps-file experiments/claude-code-harbor/results/deepswe/caps-pilot.json
   $D fetch; $D merge --router-logs <router log events of the run>
   $D project --caps-for main $RT                          # the pilot gate; writes caps-main.json
   ```
   - **Caps** (`project --caps-for`): hard = settled + max(1.4 × remaining, remaining + the largest block, the largest
     block + $5) + the $10 reserve + the in-flight allowance; soft = hard − reserve − allowance − the largest block.
     - The allowance (17, after the TB pilot's cap stops) is concurrency × the largest per-call reservation hproxy can
       make for the passes' arms: a context-window prompt at the 1h cache-write rate + 128k output (Opus 5.5 $10.56,
       Sonnet 5.5 $5.28; A/C: $63.36 at concurrency 6, $84.48 at 8).
     - hproxy admits a call only if settled + every in-flight reservation + this one ≤ hard − reserve. The allowance
       raises hard only, and soft is unchanged.
     - Settled includes the spend of voided attempts, which stays on the ledger.
   - **What `start` refuses:**
     - a runner whose hard cap − settled − the $10 reserve is not above its largest κ-priced run plus the in-flight
       allowance at this start's `--concurrency`, or whose soft cap is above hard − reserve − allowance (caps written
       without the allowance, or for a lower concurrency);
     - a total over budget: every Claude Code ledger's exposure plus `outside_usd` must not exceed `total_usd`. Exposure is the hard cap, or the settled spend once closed.
   - **On success:** `start` records the started runners' caps in `caps-committed.json`.
   - **The gate** (`project` → `gate`): every item must hold before main.
     - §4.2 per call:
       - attribution;
       - `call_role` and `call_role_struct` present;
       - requested model = the role table's model for the arm's M;
       - main and subagent calls served by M (B: the model of the assessed tier, from the router log);
       - one assessor consult per B session;
       - helper calls served as requested.
     - 429 rate ≤ 1% (above it: concurrency 4).
     - PSI memory ≤ 0.05 and no host OOM.
     - The projection within budget. If it is over, stop and ask 0c; never cut runs.
   - **What is printed:** cost, κ, calls and attribution, timing, 429s, memory/OOM and helper share. Never a reward or a resolve count; `status` drops solved counts too.
   - **Calls that never reached the router** (0c, 2026-11-07) are a harness rerun, never scored:
     - at run time: classify, when the proxy's `gateway_fallback_calls` > 0 (4f; any role);
     - post hoc: `merge --router-logs`, when the router log saw fewer calls than the proxy forwarded (`router_short`). Such rows are reclassified, and the scored ones are listed in `merged/requeue.json`. Then run `$D requeue` (drivers stopped) and `$D start --pass pilot …` again: the driver reruns those keys.
     - The gate also requires 0 attempts with fallback calls and 0 `pin_served_other`.
   - **Pilot reset** (a pilot that must be run again from scratch, e.g. the 2026-11-07 fallback pilot):
     - Drivers stopped, then `$D fetch`.
     - `$D void-pass --pass pilot --reason "<plain text>"` appends a `void` event on every runner. Replay then forgets every earlier pilot attempt and final, while the old events and rewards stay in attempts.jsonl.
       - The proxy ledger and calls.jsonl are untouched: the spend stays on the caps.
       - run-config.json moves aside, so the continuity baseline restarts.
       - It is refused if any other pass has attempts on that runner (main is never touched), or if an attempt has no end event.
     - `$D fetch; $D merge`, then run step 4 again as written. merge puts the void attempts' calls in `calls-void.jsonl`, out of the gate.
     - After a cap stop, two more steps:
       - `$D unstop` removes only results/STOP, which `stop` wrote (`run` refuses while it exists).
       - The ledger's cap stop is sticky in cap-events.jsonl. Only `start … --unstop-cap` clears it: the restarted
         proxy unstops it under its new hard cap, and the event is logged. Without it, every call is refused again.
5. **DeepSWE main.**
   - Run `$D start --pass main $GW --concurrency 6 --caps-file …/caps-main.json`, then `fetch` and `merge --router-logs …`.
   - Close the benchmark: `$D budget --close`. Its exposure becomes its settled spend; every driver must be stopped.
6. **TB.**
   - Ship: `$B pack; $B ship`.
   - Network: a3's switch to `CONTAINER_EGRESS=internet`, then `$B isolation --wait`.
   - Prepare: `$B setup; $B prepull; $B check --concurrency 8`, then `fetch` and `merge`.
   - Pilot and main as in steps 4–5, with `--concurrency 8`.
7. **Stage-1 stop.**
   - `$B fetch --mode full`, then `merge --router-logs …`.
   - Close: `$B budget --close`.
   - Stop the instances (EBS kept) for the user's decision.

### Stage 2 (not planned for the A/C validation)

1. **Start the instances.** On start:
   - a3's checks: docker active, runner-firewall exited 0, `runner-egress-<mode>.sh`;
   - `$B isolation --wait`;
   - `$B status`.
2. **TB rep2 + rep3.**
   - `$B project --caps-for rep2,rep3 $RT`. The caps come from stage 1's κ, measured on every task.
   - `$B start --pass rep2 --pass rep3 $GW --concurrency 8 --caps-file …/caps-rep2+rep3.json`.
   - The continuity pre-flight refuses a changed plan sha, agent pin (version and binary sha256), router policy version, concurrency or arm table. Pass `--allow-change <field>` only on purpose.
3. **DeepSWE rep2 + rep3.**
   - `$B budget --close`, then `$D pack; $D ship`.
   - Network: a3's switch to `none`, then `$D isolation --wait`.
   - Run rep2 + rep3 as in step 2, with `--concurrency 6`. Reuse the DeepSWE checks if the images are unchanged (`prepull` reports `digest_changes`).
4. **End.**
   - `$D fetch --mode full`, then `merge --router-logs …`.
   - `$D budget --close; $D budget`.

## On a runner

- **Directories:** `$WORK_DIR/cc-deepswe/results` and `$WORK_DIR/cc-tb21/results`, each with its own CapLedger. Codex's `results/` and `tb21/results` are archived and never touched.
- **Memory:** a cgroup sampler records per trial (`host.mem`):
  - the agent's peak RSS (`claude`, `bun` or `node`);
  - peaks of the container's memory, anon and swap;
  - `memory.events` oom and oom_kill.
- **OOM:**
  - The kernel log names the OOM victim.
  - classify tags a container-limit OOM `oom-container` + `victim:agent|workload|unknown`. The tags never change the class (0d §9).
  - A host OOM is a harness rerun.
- **classify:** reads `calls_by_role.main`, so a failed subagent or helper call never causes a rerun. A run without a stream-json `result` event counts as a non-zero agent exit. Any call answered by the gateway's fallback (`gateway_fallback_calls` > 0) makes the trial a harness rerun.
- **Refusals whose fallback the pin blocks** (0d design-stats §18, Amendment 9) are `sut` / score_zero, reason `refusal_fallback_blocked`, and never rerun. The rule is `classify.refusal_fallback_blocked`; all of these must hold:
  - ≥ 1 model call with stop_reason `refusal` served by M_arm;
  - the trial's last model call is hproxy's 403 `model-not-allowed`. That answer comes only from hproxy's pool check, so the request named a model other than M_arm: Claude Code's built-in fallback.
  - At run time the check uses the proxy summary's `refusals`.
  - `fleet.py merge` applies it to the recorded attempts. The first match is the key's final, scored; later attempts are `superseded_by` it, and their cost goes to total spend only.
  - `summary.json` `refusal_fallback` lists the keys, the fallback models (from the transcript, if exported), whether each final's verifier ran, and the classify VERSION.
  - The refused request is a §13 deviation (gate `deviations`): reported in main, and it fails `deviation_in_pilot` in a pilot.
- **Export:** only `agent/claude-code.txt` and `agent/sessions/projects/**.jsonl` of Claude Code's config dir. `.claude.json`, statsig, todos and the rest are left out.
- **Known gap in the 2026-11-07 run (fixed afterwards):**
  - The export's credential-name rule (driver.py `EXPORT_NEVER`) was searched against the whole path relative to results/, so it matched directory names too.
  - Every trial dir and check dir of a task whose name contains token, secret or credential was dropped from every export, without a trace. On TB that was count-dataset-tokens and vulnerable-secret: 8 main attempts plus their check dirs. Their transcripts and verifier files were never fetched; the runners are destroyed.
  - The ledger and attempt rows are complete. Only those trials' files are missing.
  - The archive check missed it, because it compared only allowlisted files.
  - Since the fix:
    - the rule reads the file's own name only (`export_never`; content is still scanned);
    - `archive` lists every file left out by name (`excluded_by_name`, with per-directory counts), so a directory dropped whole is visible.

## Tests

```
cd experiments/deepswe-harbor && uv run --python 3.12 --with pytest==8.4.2 pytest -q tests/test_cc.py
uv run --python 3.12 --with pytest==8.4.2 python tests/cc_dryrun.py --codex-dev <checkout with the Codex results>/experiments --tmp-dir <disk with ≥ 30 GB>
```
