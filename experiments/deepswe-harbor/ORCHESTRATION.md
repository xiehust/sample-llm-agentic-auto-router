# Multi-runner orchestration (design §9)

There are four identical runners, and each one runs every arm on its own shard of the 113 DeepSWE v1.1 tasks. The driver
starts one `harbor run` per trial attempt. Harbor does the task loading, the environments, the Codex install and run,
the separate verifier and result.json. The driver decides the order, the concurrency, the caps and the pre-registered
rerun rule (§7.4). The parent (0c) drives everything from the dev box over SSM with `fleet.py`.

| File | What it is |
|---|---|
| `shardplan.py`, `plan.json` (committed) | Shards, passes and blocks (task ids, language, difficulty band, shard). No task text, no public rates. |
| `classify.py` | The §7.4 classifier: a deterministic function of logged fields; it never reads whether a reward is good. |
| `driver.py`, `driver.py.lock`, `driver-requirements.txt` | The runner side: checks, the live scheduler, status, export. boto3 is used only for the runner secret. |
| `fleet.py` | The dev box side: pack, ship, setup, units, status, fetch, merge, project. Stdlib only, and the aws CLI with the operator's credentials. |
| `tests/test_shardplan.py`, `test_classify.py`, `test_driver.py`, `test_fleet.py` | Offline tests. They use a scripted fake `harbor` and 4f's real RunnerProxy against the mock router. |

## Plan (frozen once committed)

- **Shards.** 28/28/29/28 tasks. They are stratified by language (within ±1 per shard) and by the public pass rate at
  effort high: the mean over gpt-5-6-sol, gpt-5-6-luna and gpt-6-astra (mini-swe-agent, 4 attempts each). The seed is
  20261105.
- **Passes**, in run order on every runner:

  | Pass | Phase | Arms | Rep | Block order |
  |---|---|---|---|---|
  | `pilot` | pilot (outside the analysis) | A, F, C, B | 1 | one task per runner, four languages |
  | `main` | main | A, F, C, B | 1 | `random.Random(seed + shard)` over the shard's sorted tasks |
  | `rep2` | repeat | A, F, C, B | 2 | seeded, stratified: every prefix is a stratified subset |
  | `rep3` | repeat | A, B | 3 | seeded, stratified |

- **Blocks.** A block is one task with its arms in a seeded order. Each block's arms launch together.
- **Planning cost of one full pass of 113** (public, κ = 1, B at its tier-pass model): A $392, F $88, C $443, B $428.
- **Checkpoint (§7.5).** Run with `--max-blocks 7`. Then use `fleet.py project`, which gives κ per arm from the measured
  main-pass spend and prices the two cut options. Then cut one of them:
  - `shardplan.py cut --name rep2 --arm C --per-shard N`: C's 2nd run on the first N blocks;
  - `shardplan.py cut --name rep3 --per-shard N`: the 3rd A+B run on the first N blocks.

  Both block orders were fixed before any outcome was seen. After the cut, re-pack, re-ship and start again. The driver
  records the plan's sha256 in run-config.json and in every start event.

## Runbook (0c)

```
F="python3 experiments/deepswe-harbor/fleet.py --region <region> --stack <prefix>-runner"
$F pack && $F ship            # code + driver venv; the sha256 and the tarball members are checked on the runner
$F setup                      # stage the pinned Codex (4f's cli.py), clone deep-swe at the plan's commit, check the task.toml hashes
$F prepull                    # unit llmar-prepull: the shard's images + PREPULL_IMAGES + the isolation probe image
$F isolation --wait           # unit llmar-isolation: 18's isolation suite (PASS iff every gate passes), then a light fetch
                              #   (reports in results/fleet/runner-<i>/results/isolation/<ts>/llmar/report.json, through leakscan)
$F check                      # unit llmar-check: oracle (solution/ passes) + null (the base fails), no model calls
$F units; $F status           # progress; drops and unresolved checks are shown in status
$F start --pass pilot --gateway-url <GatewayUrl> --concurrency 6 --token-max-age-s 600   # pilot: forced mid-session re-mints
$F fetch && python3 experiments/deepswe-harbor/fleet.py merge --tasks-dir <deep-swe>/tasks --tiers <strata.json> --harvest
$F start --pass main --pass rep2 --pass rep3 --gateway-url <GatewayUrl> --concurrency 6 --max-blocks 7
…  $F fetch; …merge; …project  → cut (optional) → pack, ship, start again without --max-blocks
$F fetch --mode full          # full trial dirs through the results bucket (runs/<i>/<export-id>/)
```

- **Start.** `start` launches the systemd unit `llmar-driver` (KillMode=mixed, LimitCORE=0). It refuses if the unit is
  already active, or if results/STOP exists (`unstop` clears it). Starting the same command again resumes the run.
- **Concurrency.** It is fixed for the whole run. A resume at a different value needs `--change-concurrency`.
- **Stop.** `stop` drains: no new blocks; admitted blocks and their reruns finish. `stop --now` cancels the running
  trials (class `cancelled`), which rerun on resume without using up a rerun.
- **Caps.** At the soft cap (`--soft-cap`, default $1,000 of Bedrock spend per runner, read from the proxy ledger) no
  new block is admitted. Admitted blocks and their reruns still finish, so the run ends with complete blocks. The
  hard cap is the proxy's (`--hard-cap`, default $1,130; fails closed). After a hard-cap stop no new trial starts; the
  cap-stopped trials are `cap_stop` and excluded. `--unstop-cap` clears a sticky cap stop after the cap was raised.
- **Other stops.** The runner halts after 5 harness errors in a row, when the disk is low (< 30 GB on the results
  disk or /var/lib/docker), or when the proxy thread dies.

## Rerun rule (classify.py, design §7.4)

| Class | Action |
|---|---|
| agent | Scored. Covers: verifier ran; 3 h timeout; context or output limit; refusal; Codex exits non-zero after its last model call was answered; container OOM within the task's limit; and a last call that failed upstream or at the gateway with a request-caused 4xx (400/413/422) or a request-problem stream code (0d F1/F4). |
| sut | Scored 0: the session ended on an error the router generated. |
| upstream | Rerun: 5xx, 429, 408, 404 or model-not-found, transport or stream drops, a stream error without a request-problem code. |
| harness | Rerun: proxy refusals, gateway or upstream 401/403, environment, image or sidecar errors, a host (global) OOM kill of one of the trial's processes, a crashed or killed Harbor, Codex failing before any model call, unknown exceptions. |
| verifier_infra | `harbor jobs regrade` on the attempt's job dir (the verifier only), or a rerun if the patch is lost. |
| cap_stop | Excluded, never rerun. |
| cancelled | Rerun, not counted as a rerun. |

A (pass, task, arm, rep) gets at most 2 reruns and 2 re-verifies. Still errored after that, it is final `excluded`.
Every attempt gets a new uuid4 trial_id. That id is the proxy route and the router session.

## On a runner

- `$WORK_DIR/repo`: the shipped code; bin/ and results/ are kept across ships. The Codex binary is staged there.
- `$WORK_DIR/venv`: the driver's Python env.
- `$WORK_DIR/deep-swe`: the tasks.
- `$WORK_DIR/results`:
  - `attempts.jsonl`: fsynced events: start, pid, end, reverify-start/end, final, run-start/end;
  - `jobs/<trial_id>/…`: the Harbor job dirs;
  - `attempts/<trial_id>/{job.json,harbor.log}`;
  - `checks.jsonl`, `checks/summary.json`;
  - `proxy/`: calls, cap events, state, alerts;
  - `host-metrics.jsonl`, `docker-events.jsonl`, `kernel-oom.jsonl`, `status.json`, `run-config.json`, `driver.log`.
- **Host health per attempt.** runner-metrics deltas: CPU steal and iowait, load, memory and swap, PSI, oom_kill. Plus
  the docker oom and die-137 events and the kernel OOM kills (global vs container limit) of the trial's compose
  projects. After each trial, its leftover compose containers and networks are removed. Unused compose networks are
  pruned at each block admission.
- **Export.** An allowlist of results files only: Harbor job dirs, per-attempt job.json and logs, checks, proxy logs,
  metrics, status. 18's leakscan blocks any file with a finding, and so do the driver's own token patterns. Blocked
  files are listed in the manifest (kinds and fingerprints only) and never leave the runner. The light set goes over
  send-command (base64 parts); `--mode full` goes to the bucket. Both are sha256- and member-checked on the dev box,
  then unpacked into results/fleet/runner-<i>/.

## Merged dataset (results/merged/)

| File | Contents |
|---|---|
| `attempts.jsonl` | One row per attempt (plan metadata, class, proxy summary, host). |
| `final.jsonl` | One row per (pass, task, arm, rep). |
| `harvest-meta.jsonl` + `calls.jsonl` | The input to 4f's harvest. `job_name` holds the final verifier result; `agent_job_name` holds the agent logs. |
| `checks.json` | The oracle and null verdicts, and the drops. |
| `summary.json` | |

## Datasets

`driver.py`, `fleet.py` and `shardplan.py` take `--dataset` (`profiles.py`). The default, `deepswe`, is exactly the
DeepSWE run above; `tests/test_golden_orchestration.py` holds it byte-identical to the pre-TB snapshot. `--dataset
tb21` is Terminal-Bench 2.1: plan, checkout, runner and dev-box dirs, admission budget, checks and classification
rules of its own. Its runbook is `experiments/tbench-harbor/ORCHESTRATION.md`.

## Tests

```
cd experiments/deepswe-harbor && uv run --python 3.12 --with pytest==8.4.2 pytest -q
```
