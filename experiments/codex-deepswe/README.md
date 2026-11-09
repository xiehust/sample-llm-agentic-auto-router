# Codex × DeepSWE (R2E-Gym) routing experiment harness

This harness runs OpenAI Codex CLI on R2E-Gym-Subset repository-repair tasks (the DeepSWE training set), through AgentCore Gateway → router → Bedrock, and compares four arms. The design is in `docs/tasks/11-05-codex-deepswe-eval/design.md`; §10 overrides §2–§7.

| Arm | Routing | Tasks |
|---|---|---|
| A | `model: auto` + `x-router-hint: pin=global.openai.gpt-6.1-sol` (standard) | 200 |
| F | `model: auto` + `x-router-hint: pin=global.openai.gpt-6-luna` (fast) | the same 200 |
| C | `pin=global.openai.gpt-6-astra` (frontier) | 60 of the 200, size-stratified |
| B | `model: auto`, assessor in auto mode (the full router path) | 30 of the 200, size-stratified |
| D | direct to bedrock-runtime Responses on Sol, no gateway or router | 10 of the 200, size-stratified |
| repeat | A and F once more on 20 of the 200 (run-to-run noise; `rules.repeat_reps`) | 40 runs |

Design §11 (revision 2): the tier pass predicted no fast or frontier task (500 candidates), so B would be served by Sol exactly like A. The fast arm F was added (§11), and after the pilot the sample was scaled from 50 to 200 tasks (§12: `cli.py select --extend` keeps the 53 validated v2 tasks and continues along the same seeded order under a repo cap of 25% of N, recorded with its effect in `selections.json`). F vs A and C vs A are the primary comparisons, B vs A and D vs A are descriptive, and an ideal per-task router (cheapest tier that solved the task) is reported against always-Sol and the assessor's choice.

It is Python 3.12 (uv, inline dependencies in `cli.py`, locked in `cli.py.lock`; run it with `uv run --locked`) and stdlib-only apart from pyarrow (dataset), boto3 (secret) and botocore (arm D signing). `tierpass.ts` runs on Node 24 against the workspace packages.

The Region is a parameter, never a default: pass `--region <region>` before the command (or set `AWS_REGION`). `tierpass`, `net-check` and `run` refuse to start without it, or when the Region has no bundled price catalog. Examples below use `cli.py --region <region> …`.

## What is committed and what stays local

- **Committed:**
  - code;
  - `candidates.json` (500 task ids);
  - `selections.json` (ids, strata, arm membership, validation verdict codes).
- **Local only (gitignored):**
  - `data/` (parquet);
  - `bin/` (Codex);
  - `results/`: events, patches, test logs, per-call proxy log, ledger, report data.

Nothing from the dataset's text (problem statements, patches, test names) is committed.

## Pins

| What | Pin | Check |
|---|---|---|
| Dataset | `R2E-Gym/R2E-Gym-Subset` (Apache-2.0) at revision `2e8108ff…` | sha256 of every parquet file (`common.DATASET`) |
| Grading conventions | R2E-Gym at commit `0d94c4eb…` | copied into `r2e.py`, deviations listed in its docstring |
| Codex | upstream `rust-v0.166.0`, static musl build | sha256 of the release asset and of the extracted binary |
| uv on the runner | 0.12.6 | sha256 in `runner-bootstrap.sh` |

The Codex settings are pinned in `codex_setup.CODEX_SETTINGS` (D6) and recorded in every result row:
- reasoning effort `medium`, summary `none`;
- context window 272k, auto-compact at 200k;
- approval `never`, sandbox `danger-full-access` (the container is the sandbox);
- web search off, no sub-agents, no request compression.

`--strict-config` makes Codex refuse any key it does not know.

## Order of steps

| Step | Where | Command | Model calls |
|---|---|---|---|
| 1 | anywhere | `uv run experiments/codex-deepswe/cli.py fetch-dataset` and `fetch-codex [--arch x86_64\|aarch64]` | none |
| 2 | anywhere | `cli.py candidates` → `candidates.json` (seeded simple random sample of 500) | none |
| 3 | Linux with `unshare` | `cli.py capture --arm B` | none (loopback mock in a network-less namespace) |
| 4 | dev box | `cli.py tierpass-bodies`, then `cli.py --region <region> tierpass` (offline: builds and checks every card) | none |
| 5 | dev box, AWS credentials | `cli.py --region <region> tierpass --live --cap-usd 0.6` | Luna, about $0.30, charged to the ledger |
| 6 | anywhere | `cli.py select` → `selections.json` (seeded random 50 + 3 pilot, ≤ 8 per repo, arm subsets, tier-pass summary) | none |
| 7 | dev box → runner | `cli.py pack` (prints the sha256), ship the tarball, then `bash runner-bootstrap.sh --tarball <path> <sha256>` (or `<repo-url> <sha>` to clone) | none |
| 8 | runner | `cli.py --region <region> net-check`, then `cli.py validate` | none |
| 9 | runner | `cli.py --region <region> run --phase pilot …` (cap $10) | yes |
| 10 | runner | `cli.py --region <region> run --phase main …`, then optionally `--phase repeat` (cap $200 total) | yes |
| 11 | dev box | fetch the router log group's lines for the run window, then `cli.py join-logs <files…>` and `cli.py report --out results/report/report.zh.md` | none |

Notes on the steps:
- **Step 3 (capture).** It records Codex's real first Responses request and writes `results/capture/template-B.json` and the D6 record `d6-B.json`.
- **Step 4 (tier-pass bodies).** Each card must have `turnIndex 0`, no `firstUser`, and the issue prompt as `latestUser`. Every card is checked before the first model call, and the script fails loudly if one is wrong.
- **Step 5 (live tier pass).**
  - Spend is counted from every billed assessor call, including calls whose output was invalid. No new call starts once the cap is reached, so the total can exceed the cap by at most one call.
  - Each row records its `cost_usd`, and `cli.py` charges the ledger from that file however the process ends.
  - `pred_tier` is the opinion only when it arrived within the router's assessor timeout given by `--deadline-ms` (recorded per row; the D2 pass used 1500 ms, measured from the dev box, not from the router's task); `pred_tier_untimed` is the same opinion without that limit.
  - `cli.py tierpass-summary --deadlines 1500,5000` recomputes the timed opinion at other timeouts from the same rows (no model calls; design §13: the main run uses 5000 ms) and records `pred_tier_5000` per task in `selections.json` (descriptive; the recorded `pred_tier` is unchanged).
- **Step 7 (ship).** `pack` writes a byte-reproducible `results/llmar-experiment.tar.gz` of this directory (without results/, data/, bin/ and caches) plus `packages/pricing/data`. The bootstrap checks the sha256, accepts only regular files and directories under those two roots, and replaces the code while keeping the runner's results/, data/ and bin/.
- **Step 8 (validation).** `validate` runs base and gold 3× each in fresh containers. A failing task is replaced from the same predicted-tier reserve.
- **Step 9 (run).** `--runner-usd-per-hour` (> 0) and `--runner-started-at` are required; `--secret-id` defaults to `llmar-runner/client`. The scheduler starts no new run below 30 GB free on the results disk or Docker's data root. Example:

  ```
  uv run --locked experiments/codex-deepswe/cli.py --region <region> run --phase pilot --gateway-url <GatewayUrl> \
    --runner-usd-per-hour <rate> --runner-started-at <epoch-seconds> \
    --budget A=1.5 --budget F=0.3 --budget B=2 --budget C=3.5 --budget D=1.5
  ```

  `--gateway-url` is the router stack output; pass it at run time and never commit it. The pilot is A×3 and F×3 on the 3 pilot tasks plus C, B and D once each, in a fixed order, most expensive first (C, B, A, D, F). With the budgets above, every pilot run's worst case fits the $10 cap at the time it starts.

## Run protocol (per task × arm)

1. **Agent container.** A fresh task image (amd64) on the experiment network (`--internal` bridge by default). R2E-Gym's venv setup runs, and then the hidden tests and every answer-bearing file of R2E-Gym's `SKIP_FILES` (`run_tests.sh`, `r2e_tests`, `parsed_commit.json`, `expected_test_output.json`, `execution_result.json`, `modified_files.json`, `modified_entities.json`, `syn_issue.json`) are **deleted** from `/testbed`, `/root` and `/`, not moved to `/root`, because Codex can read `/root`.
   - History check: the dataset's `commit_hash` and the parsed commit's new hash must not exist as commit objects, and `git rev-list --all --not HEAD` must be empty. Otherwise every ref, the reflogs and FETCH_HEAD/ORIG_HEAD are deleted and unreachable objects pruned, and the check runs again. If the answer is still reachable, the run fails. The result is recorded per row (`history_check`). The working tree is unchanged.
   - The baseline tree (`git add -A && git write-tree`) is recorded at this point.
2. **Codex.** The pinned Codex is installed into `/opt/llmar-codex`, with a run-local `CODEX_HOME/config.toml` and a dummy API key.
   - The run is `timeout -s INT -k 60 40m codex exec --json --strict-config …`. The JSONL stream is kept.
3. **Patch.** The patch is `git add -A && git diff --cached <baseline-tree>` minus test files (R2E-Gym's rule), artefacts and binaries. It is taken at timeout too (D11).
4. **Grading.** A fresh container runs R2E-Gym's `setup_env` unchanged, then `git apply --whitespace=fix`, then (only if the patch touches extension sources) `python setup.py build_ext --inplace`, then `bash /root/run_tests.sh`. Validation also records whether the unpatched base rebuilds (`base_rebuild_ok`). At grading, a failed rebuild when the base rebuilds is the agent's: `rebuild-failed-agent`, counted as unresolved. No `setup.py`, or a base that does not rebuild either, is the harness's: `rebuild-unavailable`, and the task is excluded from every comparison and listed in the report.
   - The primary verdict is SWE-bench style (F2P/P2P from validation). The secondary verdict is R2E-Gym strict.

## Network and credentials (D5, review R3, F1–F4)

- **Containers.** They have no route out and no DNS. Codex's `base_url` is `http://<bridge-gateway-ip>:<port>/r/<run-id>/v1`, an IP and not a hostname.
  - The docker wrapper allowlists the flags of `docker run`, `docker exec` (`-w`, `-e`, `-i`) and `docker network create` (exactly those it uses), requires `run --network` to be the configured experiment network, refuses `docker network connect|disconnect|rm` outright, so `--restart`, `--privileged`, `--network host|bridge|none`, `-p`, `--cap-add`, `--ipv6`, host namespaces, devices, mounts and anything else are refused.
  - The token fetch never follows redirects.
- **The proxy** (`proxy.py`) runs on the host and is the only egress.
  - It binds only an explicit private address, the bridge gateway, never `0.0.0.0`.
  - It allows only `POST …/v1/responses` and `GET …/v1/models` for a registered run. There is no CONNECT, no absolute URI and no compressed body. On the gateway path the body's `model` must be exactly `auto` (no `auto:<tier>`, no concrete id); on arm D it must be Sol.
  - It admits a call only if the call's worst case (prompt estimated from the previous call plus the new bytes / 3, uncached, + 16k output, priced at the last served model for A and C and at Astra for B, since the router may switch B's model) fits in what is left of the run's budget + one-call margin, so the ledger's worst case holds. Calls billed without usage are estimated and added to the run's spend.
  - It forwards to exactly two hosts, the gateway and `bedrock-runtime.<region>.amazonaws.com`. It resolves IPv4 only, connects to an address it has vetted (TLS 1.2+, certificate and hostname checked), and refuses link-local (IMDS), loopback, private, CGNAT, NAT64, 6to4, IPv4-compatible, ULA and multicast destinations.
  - It always sets `x-router-session: <run-id>` (a random uuid4) and the arm's hint.
- **Tokens.**
  - Arms A–C: the proxy injects a fresh Cognito token per run, minted from the `llmar-runner/client` secret.
  - Arm D: the proxy signs with SigV4 using the instance role, and the request body must name Sol.
  - Tokens, `Authorization` and SigV4 headers are never logged, written or placed in a container.
- **Per-call records** (`results/calls.jsonl`) contain only:
  - status, timings;
  - served model, router headers;
  - usage, priced cost;
  - previous prompt size (D9/D10/D13).

## Budget (R6)

`ledger.py` holds the caps: pilot $10, total $200 (tier pass + Bedrock + runner hours).

- **Starting a run.** A run starts only if committed + every in-flight reservation + its worst case fits under the caps.
  - The worst case is the run's budget, which the proxy enforces by refusing calls once it is spent.
  - Plus one more call at the auto-compact prompt size, uncached, with a 16k-token output.
  - Plus a $0.01 assessor allowance for B.
- **Settling.** The actual spend is the proxy's per-call pricing with the bundled ap-southeast-1 catalog. Unknown models are priced as Astra. A call cut off mid-stream is estimated from the previous prompt.
- **After a crash,** a run still marked running is charged at its worst case.

## Results and report

- **Rows.** `results/results.jsonl` has one row per run (`results.SCHEMA`).
- **Router-log join.** `join-logs` matches the router's `session` field, which is `sha256(<run-id>)[:16]`. It adds the assessor's cost to the router's request cost (A3) and checks that every run has exactly one lineage (A2).
- **Validation pass rate per predicted tier** is recorded in `selections.json` (`validation_summary`) and printed with the selection (exchangeability) assumption in the report's limitations.
- **Report.** `report` calls `stats.py` for the pre-registered analyses. It writes `results/report-data.json` and a Chinese Markdown skeleton: the tier-pass summary (incl. the deadline finding), F vs A and C vs A (primary), B vs A and D vs A (descriptive), the ideal router (F/A on 50, F/A/C on C's 20, and the A/B pure-noise gain on B's Sol runs), transparency, the per-task table (ids only) and the limitations list.

## Tests

```
cd experiments/codex-deepswe && uv run --python 3.12 --with pytest==8.4.2 pytest -q
```

The bootstrap waits for cloud-init (exit 2 is accepted only when `cloud-init status` says `status: done`), then checks the runner firewall (RUNNER-BRIDGE-IN accepts only the proxy port and ends in DROP, DOCKER-USER drops `-i br+`, INPUT sends the bridges to RUNNER-BRIDGE-IN) and exits non-zero on any miss (`LLMAR_PROXY_PORT`, default 8088).

The tests are offline. They cover:
- R2E-Gym parsing, grading and gold patch;
- patch filtering;
- pricing and ledger caps;
- the Codex config (parsed with `tomllib`) and event parsing;
- every proxy refusal, plus a forwarding round trip against a local fake upstream;
- token minting, the docker flag guard, selection and replacement;
- per-call cache attribution, the router-log join and report building;
- the scheduler end to end against a scripted fake Docker.
