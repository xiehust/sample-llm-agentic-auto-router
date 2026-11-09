# Terminal-Bench 2.1 orchestration (TB design §6)

TB 2.1 runs on the DeepSWE harness (`experiments/deepswe-harbor/`) with `--dataset tb21` (`profiles.py`). That flag
selects the plan, the runner and dev-box directories, the admission budget, the checks and the classification rules.
Without it, every command is the DeepSWE run, byte for byte.

| File | What it is |
|---|---|
| `plan.json` (committed) | 89 tasks in 4 shards, then the passes: `pilot`, `main`, `rep2`, `rep3`, all four arms. It holds ids, labels, timeouts, resources, digests and blocks. It holds no task text, no tier-pass tiers and no costs; their inputs are recorded by sha256 only. |
| `results/` (gitignored) | `tierpass/strata.json` (73), `inputs/tb-cost-weights.json` (0d), `plan-detail.json`, `pins.json`, `fleet/`, `merged/` |

## Plan (seed 20261106)

- **Shards.**
  - **Sizes:** 22/22/23/22 tasks. Each category group is within ±1 per shard; a category with fewer than 4 tasks
    joins `other`.
  - **Long tasks:** the two tasks with agent timeouts ≥ 7200 s are on different runners: build-pov-ray on shard 2,
    sam-cell-seg on shard 3.
  - **Limits per runner:**
    - ≤ 2 of the 5 costliest tasks (0d's public weights);
    - ≤ 1 four-CPU task;
    - ≤ 2 multi-CPU tasks;
    - ≤ 2 tasks that need 8 GB.
  - **Balance:** the counts of hard tasks, ≥ 3600 s tasks and frontier-tier tasks are each within ±1. The expected
    cost per shard is within 0.12% (cost weight 22.23–22.26 per shard).
- **Block order.** Each of `main`, `rep2` and `rep3` uses a seeded stratified order by (tier-pass tier × easy+medium
  | hard), so any prefix is a stratified subset. The ≥ 7200 s tasks' blocks come first in every pass (0d). Arms run
  in a seeded order per block.
- **Pilot** (0d): 2 tasks per shard, 32 runs, outside the analysis.
  - **Pick 1:** standard tier, 1 CPU, 2 GB, ≤ 900 s, medium.
  - **Pick 2:** frontier tier, ≤ 1800 s.
  - The multi-CPU task with the shortest timeout (overfull-hbox) replaces pick 2 on its shard.
  - **The picks:**

    | Shard | Pick 1 | Pick 2 |
    |---|---|---|
    | 0 | pypi-server | overfull-hbox |
    | 1 | query-optimize | make-mips-interpreter |
    | 2 | nginx-request-logging | adaptive-rejection-sampler |
    | 3 | chess-best-move | path-tracing-reverse |
  - **Planning cost:** ≈ $49 at s = 1.
- **Rebuild** (only before the pilot, e.g. if 73 re-freezes strata.json):
  ```
  python3 experiments/deepswe-harbor/shardplan.py --dataset tb21 build-tb --force \
      --tasks-dir <terminal-bench-2-1 at the pin>/tasks --tiers experiments/tbench-harbor/results/tierpass/strata.json \
      --weights experiments/tbench-harbor/results/inputs/tb-cost-weights.json
  ```
  - Run it with a Python that has Harbor 0.25.0, which taskpin's content digests need.
  - Image digests come from Docker Hub with read-only, anonymous requests. They are cached in `results/pins.json`.

## On a runner

- **Directories:** the checkout is `$WORK_DIR/terminal-bench-2-1`. Results go to `$WORK_DIR/tb21/results`: attempts,
  jobs, the proxy ledger and caps, checks, isolation reports. Exports go to `$WORK_DIR/tb21/exports`. DeepSWE's
  `$WORK_DIR/results` is archived and never touched.
- **Network:** `run` and `check` need a3's `CONTAINER_EGRESS=internet`. They pass `ONLINE_NETWORK` and `ONLINE_DNS`
  from the env file to Harbor. After the network prune they check `llmar-online` against 4f's contract (infra creates
  it; the driver never creates or removes it). They also check every image against its pinned digest.
- **Admission:** at most 8 trials, Σ declared cpus ≤ 8 and Σ declared memory ≤ 48 GB.
  - Head-of-line: nothing else starts while the next trial doesn't fit.
  - What that means per block:

    | Task | How its block runs |
    |---|---|
    | 1 CPU | two blocks side by side |
    | 2 CPU | the block alone |
    | 8 GB | one such block at a time |
    | 4 CPU | two arms at a time, in the seeded arm order (0d) |
- **Watchdog:** per task, agent + verifier + build timeouts + 30 min. build-pov-ray gets 7.3 h.
- **Lookupscan:** every trial is scanned by 4f's `lookupscan`.
  - The text-free record goes into the `end` event and `attempts/<id>/lookup.json`.
  - The hit windows go into `attempts/<id>/lookup-hits.jsonl`, which ships in full exports only, through leakscan.
- **Classification:** classify.py's TB rules (0d §7.4).
  - (a) `verifier_infra` is a rerun; there is nothing to re-verify.
  - (b) It is `verifier_infra` (rerun) when all four hold:
    - reward 0;
    - the test runner never started (no `verifier/ctrf.json`, or 0 tests in it);
    - a network-error pattern in `verifier/test-stdout.txt`;
    - lookupscan's `net_config_touched` is false.
  - (c) An agent exception before the verifier ran is a rerun.
- **Checks** (§7.5): oracle and nop, each with 2 counted slots, attempted one at a time per (task, kind).
  - An infra verdict, including (b), retries the slot. The 3rd infra in a row fills the slot as `exhausted`.
  - Oracle: an exhausted slot counts as a failure. Both slots failed → drop; 1 of 2 → `flaky_env`.
  - Nop: a pass in either slot → drop. An exhausted slot is unverified: both unverified → drop; one unverified →
    `flaky_env`.
  - `check --post` re-runs the oracle once per kept task, into `checks/post/`. It is a sensitivity only.

## Changeover runbook (0c)

```
F="python3 experiments/deepswe-harbor/fleet.py --region <region> --stack <prefix>-runner"   # DeepSWE (default)
T="$F --dataset tb21"
```

0. **DeepSWE final.**
   ```
   $F fetch --mode full
   …merge --harvest
   ```
   0d and 4f confirm the data. Then merge `tb21-harbor` into main and commit; pack only from a clean worktree of that
   HEAD.
1. **Stop and verify DeepSWE.**
   ```
   $F stop
   $F units
   $F status
   ```
   All four llmar-* units are inactive, every runner shows `run-end` with 0 running, and every attempt has an end.
2. **Ship.**
   ```
   $T pack
   $T ship
   ```
   - The pack roots add `experiments/tbench-harbor`.
   - The ship goes first because the runners' DeepSWE driver (7ced27d) has no `archive` command.
   - Shipping replaces only the code under `$WORK_DIR/repo` (each root's `results/`, `data/` and `bin/` are kept)
     and never touches `$WORK_DIR/results`. The new driver's default profile is DeepSWE, byte-identical.
3. **Archive DeepSWE.**
   ```
   $F archive
   ```
   - Per runner: `$WORK_DIR/archive/deepswe-<ts>.manifest.json` (size and sha256 of every results file), then
     `chmod -R a-w $WORK_DIR/results`. Nothing is deleted or moved.
   - The output shows `matched_last_full_export` / `allowlisted`, which must be equal, and `differs_from_export`,
     which must be `[]`.
   - Root can still write to the tree. `$F archive --verify <manifest path on the runner>` re-hashes it later.
4. **Network.** 0c applies a3's switch to `CONTAINER_EGRESS=internet`; no redeploy. Then:
   ```
   $T isolation --wait
   ```
   This is the gate: O1–O8, L and P must PASS on all 4 runners. It runs before any task container gets the internet.
5. **Setup and prepull**, in parallel with step 4's wait:
   ```
   $T setup
   $T prepull
   ```
   - `setup` stages the same Codex pin, then runs `fetch-tasks`: clone at the pin, then taskpin's three integrity checks.
   - `prepull` pulls `repo@digest` for each image, tags it `repo:tag`, then checks the digests. Shards hold 4.0–6.6 GB
     compressed.
6. **Oracle and null checks.**
   ```
   $T check --concurrency 8
   $T status
   $T fetch
   python3 experiments/deepswe-harbor/fleet.py --dataset tb21 merge
   ```
   `results/merged/checks.json` lists `dropped` and `flaky_env`; 0d signs off. No model calls.
7. **Pilot.**
   ```
   $T start --pass pilot --gateway-url <GatewayUrl> --concurrency 8 --soft-cap 45 --hard-cap 65 --token-max-age-s 600
   $T fetch
   python3 experiments/deepswe-harbor/fleet.py --dataset tb21 merge --tasks-dir <tb21 checkout>/tasks \
       --tiers experiments/tbench-harbor/results/tierpass/strata.json --harvest --region <region>
   ```
   - `start` refuses unless the $10 proxy reserve < hard cap − the largest expected single run of the passes.
   - The gate:
     - joins;
     - κ per arm;
     - host PSI, OOM and steal, and 429s;
     - the leakscan blocked list;
     - (b) hits;
     - lookupscan hits, read without rewards; then freeze the scanner.
8. **Main.**
   ```
   $T start --pass main --pass rep2 --pass rep3 --gateway-url <GatewayUrl> --concurrency 8 --soft-cap 800 --hard-cap 900 --max-blocks 6
   $T project
   ```
   - The checkpoint after 6 blocks per runner is a cost and status look only (3 runs are fixed; there is no extension).
   - Start the same command without `--max-blocks` to continue. Concurrency stays 8 for the whole run.
9. **End.**
   ```
   $T check --post
   $T fetch --mode full
   …merge --harvest
   ```
   Teardown is 0c and a3's.

## Tests

```
cd experiments/deepswe-harbor && uv run --python 3.12 --with pytest==8.4.2 pytest -q tests/test_tb.py tests/test_golden_orchestration.py
```
