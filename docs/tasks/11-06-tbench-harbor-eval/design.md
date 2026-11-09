# Terminal-Bench 2.1 × Codex via Harbor: design

Sections 1–6 and 8 onward belong to their owners (0c, 4f, 17, a3). **§7 (statistics pre-registration) is 0d's.**

## 3. Step 1: offline tier pass (73)

### 3.1 Method (as on DeepSWE, that task's §3)
- **Request.** Harbor's Codex agent sends `strip_canary(instruction.md)` as the only user message. The body is the
  R2E Codex 0.166.0 capture (instructions, developer messages, 4 tools, environment context). The cwd is set to the
  task's last Dockerfile `WORKDIR`: `/app` 86, `/app/personal-site`, `/app/dclm`, `/workspace` 1 each.
  - On DeepSWE, the card from a live Harbor first request matched this card except the router's template family,
    which isn't part of the card.
- **Card.** The router's own `requestCard`, checked before any call: turn 0, no `firstUser`, and `latestUser` is
  the instruction.
  - 89/89 cards pass. Prompt estimate 6.1–7.2k tokens (median 6.3k).
  - Instructions are 123–4346 chars (median 716, DeepSWE 2075). 1 is truncated at the card's 4000-char cap.
- **Assessor.** The deployed config: pack v2.1, Luna, threshold 0.8, autoRules all, 5000 ms deadline, called
  directly on Bedrock. Each task is assessed 3 times.
  - `pred_tier` is the opinion the router would act on: confidence ≥ 0.8 and an answer within 5 s.
- **Strata.** Frozen in `results/tierpass/strata.json` (`tbench-harbor-strata/v1`), with the same rule as DeepSWE:
  - each task's stratum is its majority `pred_tier` over the 3 runs, with no opinion counted as standard;
  - `stable` means the same tier in all 3 runs.
- **No simulated B.** TB 2.1 has no public per-task outcomes by model.
- **Inputs and spend.**
  - Terminal-Bench 2.1 at `12b7565679ce`. All 89 task dirs match the dataset manifest.
  - Spend $0.088 over 267 calls, charged to this experiment's ledger (`experiments/tbench-harbor/results/ledger.json`,
    cap $1.00 approved by 0c), not the assessor eval ledger.
- **Code.** `experiments/tbench-harbor/tierpass.py` (branch `tb21-harbor`). It reuses
  `experiments/deepswe-harbor/tierpass.ts` and its body helpers unchanged.

### 3.2 Result (2026-11-06): gate passed, B is a Sol/Astra mix
- **Tier mix per run** (frontier / standard / no opinion):
  - 32 / 52 / 5;
  - 31 / 53 / 5;
  - 25 / 56 / 8.
  - **Fast: 0 of 267**, including before the threshold (raw tier and mapped tier).
- **Strata: frontier 30 (34%), standard 59 (66%), fast 0.** 73/89 tasks are stable: 21 frontier, 52 standard.
  - Pairwise agreement between runs is 88% (DeepSWE 79%).
  - So the §7.8 gate (< 10% frontier ⇒ B ≈ A) is not triggered.
  - Expect live B to serve Astra on about 28–36% of tasks and Sol on the rest.
- **Why there is no fast at all.**
  - Pack v2.1 has two fast rules: read-only lookup, and a fully specified mechanical edit.
  - No TB task is either: each asks the agent to build, fix, configure or compute something and leaves the
    method open.
  - So B can't route to Luna on this benchmark. F stays as a pinned reference arm only.
  - As on DeepSWE, this is the deployed pack tested as-is. No pack changes (PRD, out of scope).
- **Agreement with TB difficulty** (author-assigned; easy 4, medium 55, hard 30):

  | Difficulty | Tasks | Frontier stratum | Share |
  |---|---|---|---|
  | easy | 4 | 0 | 0% |
  | medium | 55 | 14 | 25% |
  | hard | 30 | 16 | 53% |

  - Using §7.8's merge (easy+medium 59 / hard 30): 14/59 (24%) vs 16/30 (53%). The difference is +30 pp, 95%
    task-bootstrap CI [+8, +50].
  - Goodman–Kruskal γ between tier order and difficulty order is 0.60 [0.23, 0.83]. It is 0.62 on stable tasks and
    0.44–0.64 per run.
  - The assessor broadly sends "hard" up, but 14 hard tasks still get standard and 14 medium tasks get frontier.
  - The naive map (easy→fast, medium→standard, hard→frontier) matches 64% of tasks. That isn't a target, because
    nothing can map to fast.
- **What drives frontier.**
  - Every frontier answer carries `fact:deep`, and all but one per run also match `deep-investigation`. Every
    standard answer matches `bounded-change`, sometimes with `fact:multi-file-edit`.
  - Unlike DeepSWE, instruction length doesn't drive it. Frontier shares by length tercile are 28%, 43% and 30%
    (γ = 0.03).
  - Expert time does track it: the median author estimate is 120 min for frontier vs 45 min for standard.
  - By category, frontier is all 4 mathematics tasks, 5/8 security and 3/5 debugging. It is 0 of the
    file-operations, data-processing and model-training tasks.
- **Latency and cost.** Median 1.45 s and p95 1.6–2.0 s per call. The slowest call took 3.2 s, so none passed 5 s.
  The median confidence is 0.89; 4–6 calls per run were below 0.8.
- **Caveats.**
  - The card shape comes from the R2E capture, not from a TB Harbor capture.
  - On DeepSWE that shape matched the live card, and Harbor's Codex agent and config are the same here. Internet
    access in the container shouldn't change Codex's first request.
  - To confirm, 73 reruns `carddiff.ts` on one TB first request that 4f captures before the pilot. If the card
    differs in a way the pack reads, the pass is rerun and the strata are re-frozen pre-treatment.
  - Repeat runs differ on 16/89 tasks. Unstable tasks are reported apart from stable ones (§7.8).
  - Difficulty is the authors' label, not a measured pass rate.

## 4. Harbor integration (4f): draft for review, 2026-11-06
This builds on DeepSWE design §4–5 and only describes what changes. It contains no task text: ids, counts, file
names and public host names only. It implements 0d's §7.4, §7.5 and §7.7 rather than restating them.

### 4.0 Reuse, not copy
- **No second directory.** The TB code is the DeepSWE harness (`experiments/deepswe-harbor/`), changed on branch
  `tb21-harbor` (worktree `llmar-tb21`). It merges after DeepSWE's final fetch.
- **Module split, as proposed by 17:**
  - 17 owns `profiles.py` (the dataset registry, `--dataset {deepswe,tb21}`, default deepswe), the driver, fleet,
    shardplan and classify.
  - 4f owns `harbor_job`, `codex_config`, `llmar_env`, `hcommon`, `harvest`, `report_zh`, `dryrun`, `cli`,
    `hproxy`, `mock_upstream`, `isolation`/`isoprobe` (with 18), the new `taskpin.py` and `lookupscan.py`, and their
    tests.
- **Dataset-free Harbor config (17's Q1):** `job_config`, `environment_config` and `llmar_env` choose TB behaviour
  from the task itself (its resolved network policy), so the driver's call sites don't change.
- **Parity:** the existing tests stay unchanged. Golden tests pin DeepSWE's job config, environment config, compose
  path list and a `report_zh` render of synthetic rows, byte for byte.
- **Runner state:** TB uses its own checkout (`$WORK_DIR/terminal-bench-2-1`) and results
  (`$WORK_DIR/tb21/results`), so it has its own proxy ledger, cap events and caps. DeepSWE's results are archived
  in place (17).

### 4.1 Pins
- **Unchanged:** Harbor 0.25.0, Codex 0.166.0 (same staged binary and sha256), and the proxy (§5).
- **Dataset:**
  - `https://github.com/harbor-framework/terminal-bench-2-1` (Apache-2.0),
    commit `12b7565679ce` (the full hash is in the PRD and plan.json; written short here because the full hash has a
    bare 12-digit run that N5 flags);
  - task dirs `tasks/<id>/`; manifest `tasks/dataset.toml` (89 `[[tasks]]` with `digest = "sha256:…"`);
  - on the dev box, the 89 dirs and the manifest's names (`terminal-bench/<id>`) are the same set.
- **Images:** 89 prebuilt `alexgshaw/<id>:<tag>`, linux/amd64; tags 20251031 (79), 20260403 (6), 20260430 (4).
  Tags are mutable, so each is pinned by digest (§4.3).
- **From task.toml:**
  - no compose files;
  - CPUs 1 (83), 2 (3), 4 (3); memory 2 GB (68), 4 GB (13), 8 GB (8); storage 10 GB;
  - agent timeouts 600–12,000 s; verifier timeouts 360–12,000 s;
  - `allow_internet = true` everywhere; no phase network override; no verifier environment.

### 4.2 Network: `llmar_env` online mode
**What Harbor 0.25.0 does with these tasks:**
- It migrates `allow_internet = true` to `[environment] network_mode = "public"`.
- With no `[verifier.environment]`, the verifier is **shared**: it runs in the agent's container after the agent.
  One container per trial; both phases are `public`.
- Public mode adds **no egress sidecar**, and `main` joins the compose project's default network.
- `agent.extra_allowed_hosts` is ignored, with a notice.
- Codex web search is *not* auto-disabled. Harbor does that only under a restricted policy, which is why DeepSWE had
  it off.

**Why stock Harbor fails on the runner, by design:**
- The per-trial `br-*` pool network is dropped by the runner firewall (`-i br+ -j DROP`).
- daemon.json gives containers the never-answering DNS 192.0.2.53.
- Opening `br+` would open every pool network.

**Online mode:**
- **Selected automatically** when every phase policy is `public`; there is no kwarg. Inside `llmar_env` there are
  then three modes:
  - all `no-network`: offline (`network_mode: none`), unchanged;
  - all `public`: online, new;
  - otherwise: Harbor's sidecar + NET_RAW drop, unchanged (DeepSWE's agent environment).
  - No DeepSWE environment is all-public: the agent phase is the proxy allowlist, and verifier and checks are
    no-network. So DeepSWE is untouched.
- **Guard:** a task with its own `environment/docker-compose.yaml` raises `ValueError` in online mode, because its
  services would need their own network decisions. There are 0 such tasks in TB.
- **Runner env (a3; from the runner env file, which 17's driver exports into the harbor subprocess):**
  - `CONTAINER_EGRESS=internet`, `ONLINE_NETWORK=llmar-online`, `ONLINE_DNS=169.254.169.253`.
  - Absent keys mean mode none, as on today's DeepSWE runners. Online mode then refuses to start: fail-closed.
  - llmar_env validates the values: the network name against `[a-z0-9-]{1,32}`, and DNS as an IPv4 literal.
- **Compose overlay, generated per environment from those values and appended last:**
  - `services.main.networks: {<ONLINE_NETWORK>: {}}`;
  - `services.main.dns: [<ONLINE_DNS>]`;
  - `services.main.cap_drop: [NET_RAW]`;
  - `networks: {<ONLINE_NETWORK>: {external: true, name: <ONLINE_NETWORK>}}`.
  - No literal resolver in code. No service uses the project default network, so none is created.
  - **Fail-closed:** if the network is missing, compose fails and the trial never starts (class harness).
- **Policy switch to `public`:** a no-op. Any other target raises.
- **The network** (a3's contract, accepted with a3's changes): one fixed network per runner, `llmar-online`.
  - Bridge `br-llmon`, `10.201.0.0/24`, `enable_icc=false`, masquerade on, IPv4 only. Disjoint from the pool
    `10.200.0.0/16`, the VPC `10.91.0.0/24` and docker0.
  - **Infra owns it:** the bootstrap in internet mode, and the SSM switch script, create it and check it with
    `docker network inspect`. The switch script refuses to run while any container is running.
  - 17's driver only **checks**: `taskpin.check_online_network(run)` raises if it is missing or differs.
  - Every other bridge keeps drop-everything.
- **Firewall (a3, implemented and packet-tested in `infra/test/runner-netns/packets.sh`: 29/29 in internet mode,
  11/11 in none mode).** The jumps sit at the top of DOCKER-USER, above the IMDS drop and the `-i br+` and
  `-i docker0` drops, which stay last.
  - Forwarded: ESTABLISHED,RELATED accepted.
  - `-o br-llmon` dropped: no container-to-container traffic, same bridge or cross-bridge.
  - DNS: UDP/TCP 53 to 169.254.169.253 only. The rest of 169.254/16 (IMDS, ECS) is dropped.
  - Non-public IPv4 (the full IANA special-purpose set, including 10/8, 172.16/12, 192.168/16, 100.64/10, the
    documentation and benchmark ranges, and 224/4 + 240/4) is dropped.
  - **Egress = new TCP to public IPv4 on 443 and 80 only**, the same as the security group (TCP 80/443 out, nothing
    in). Other public TCP ports get an immediate RST. Other protocols, including QUIC (UDP 443), get ICMP
    admin-prohibited: fast failures instead of SG timeouts.
  - Inbound to the bridge: established only. INPUT unchanged (host only at `172.17.0.1:8088`); the IPv6 `br+` drop
    unchanged; daemon.json unchanged, so dockerd doesn't restart.
  - **Connection log:** every new TCP connection from `br-llmon`, accepted or rejected, goes to the kernel log with
    prefix `llmar-online: `. It holds the source container IP and the destination IP and port, with no payload.
  - Applied strictly after DeepSWE's final fetch.
- **Port check against the tasks:** the 89 tasks' solutions, tests and instructions use no public URL with a port
  other than 80/443, and no public git/ssh/ftp/rsync scheme. The only `git@` is to localhost inside the container.
  So the 80/443 limit should cost no task. The oracle (§4.4) confirms it, and a drop it causes is reported as a
  guardrail effect.
- **DNS:** the VPC resolver (`169.254.169.253`). Security groups and NACLs don't filter traffic to the Amazon DNS
  server, and public port 53 is closed by the SG. dockerd's embedded resolver forwards to it from the container's
  namespace.
- **NET_RAW dropped:** no spoofing on the shared bridge and no raw-socket bypass. None of the 89 solutions or tests
  needs raw sockets (I grepped for tcpdump, scapy, nmap, ping, iptables and SOCK_RAW). ping still works through
  `ping_group_range`. The oracle (§4.4) confirms it per task.

**What carries over unchanged:**
- **Proxy route** `http://172.17.0.1:8088/r/<trial>/v1`: from `br-llmon`, 172.17.0.1 is a host address, so traffic
  goes through INPUT, which admits only TCP 8088. `codex_config`'s private-IP check passes.
- **Token:** never in a container; the dummy key is used.
- **Codex:**
  - bind-mounted read-only binary (install skipped);
  - `plugins` and `plugin_discovery_prefetch` off (with internet the plugin sync would succeed and change the
    requests compared with DeepSWE);
  - R2E settings, context window and compaction; effort high.
- **One addition, for public-mode tasks only:** `disable_web_search: true` in the agent kwargs, which Harbor turns
  into `-c web_search=disabled`. Why:
  - It keeps the tool list identical to DeepSWE's.
  - The hosted tool isn't served on the router path.
  - It would be a lookup channel outside the command log.
  - It survives Harbor's public-mode call. `trial._configure_web_tools` calls
    `set_web_tools_disabled(False)` for public, which keeps an explicitly configured `disable_web_search` (checked in
    0.25.0 `agents/base.py`; a3 flagged the call). The dry run asserts `web_search=disabled` in the request.
- `extra_allowed_hosts` is omitted for public tasks; Harbor ignores it there anyway.
- **Capture for 73:** 73's TB tier pass needs a session-start capture,
  `cli.py dryrun --arms B --instruction-from <tb task dir>` (§4.8).

**Verifier:** shared container, same network, so it has internet for its uv and apt installs (88 of 89 test.sh files
download them). DeepSWE's offline-verifier rule doesn't apply. Report caveat, the same for every arm and for the
leaderboard: the agent can change its verifier's environment.

**Resources:** never overridden. With 1–4 CPUs and 2–8 GB per task, admission should count task CPU and memory, not
trials (17).

### 4.3 Dataset pin (`taskpin.py`, pure functions; 17's driver calls them in `fetch-tasks`, `prepull` and at start)
- **Fetch:** the DeepSWE git sequence; URL, dir and commit from `profiles.TB21` and the plan. Clone
  `--no-checkout`, fetch the commit, `checkout --detach`, check HEAD.
- **Integrity (all three must pass, else exit 1):**
  1. HEAD equals the pinned commit.
  2. The plan's tasks, the manifest's names and the task dirs are the same set.
  3. Per shard task:
     - `harbor.publisher.packager.Packager.compute_content_hash(task_dir)`, Harbor's own file selection and
       `.gitignore` filtering over task.toml, instruction, environment/, tests/ and solution/;
     - equals the plan's recorded digest,
     - which equals the manifest's.
     - **On the dev box at the pinned commit: 89/89 match.**
  The plan carries its own copy of the digests, so a checkout with both its files and its manifest altered is still
  caught.
- **Images:**
  - The plan records per task `image` (the tag) and `image_digest` (the registry's linux/amd64 manifest digest,
    resolved once at plan build), plus the compressed size.
  - `prepull` pulls `repo@digest` and tags it as `repo:tag`. Harbor's prebuilt compose (pull policy `missing`) uses
    the local tag and never pulls.
  - At driver start, every shard image's tag must resolve to the pinned digest (`RepoDigests`).
- **Task facts** (`taskpin.task_facts`, for harvest and the report; labels and numbers only):
  - `category` (16 values), `difficulty` (easy 4 / medium 55 / hard 30), `expert_time_estimate_min`,
    `junior_time_estimate_min`;
  - agent and verifier `timeout_sec`, `cpus`, `memory_mb`.
  - Never description, keywords, tags, authors or instruction text.
- **Plan stratification** (§7.6, §7.8) is 17's `shardplan`. The pin doesn't depend on it.

### 4.4 Oracle and null checks (implements §7.5)
- **The run:** the same `driver.py check` (Harbor `oracle` = `solution/solve.sh`; `nop`), with the live run's
  environment config, i.e. online mode on `llmar-online` behind a3's rules. On every runner for its shard, after
  the firewall change and a passing isolation run.
- **Attempt verdicts:**
  - pass: reward 1; fail: reward 0.
  - A Harbor environment or verifier exception, or no valid reward, is `infra`: retried (at most 2) and not counted
    as one of §7.5's 2 attempts, as on DeepSWE.
  - §7.5 then applies:
    - drop if the oracle fails both attempts, or nop passes either;
    - oracle 1 of 2 → kept, `flaky_env`;
    - a post-run oracle re-check of every kept task.
  - `checks.json` gets `flaky_env` per task (17).
- **Does the null check make sense for TB? Yes.**
  - TB verifiers test the container's final state, and nop leaves the initial state. A nop pass means the initial
    environment already passes, so every arm scores 1 and the task measures nothing.
  - It costs no model calls.
  - It exercises each verifier's internet path before the run.
- **A test runner that never started** (reward 0, no `verifier/ctrf.json` or 0 tests, a network-error pattern in
  `verifier/test-stdout.txt`, and `net_config_touched == false`; nop and oracle run no agent commands, so that last
  condition always holds) is classify rule (b). **0d accepted it for the checks:** such an attempt is retried at most
  2 times and not counted, and after that it counts as a failed attempt. Every TB test.sh writes `--ctrf
  /logs/verifier/ctrf.json`, and Harbor 0.25.0 writes `verifier/test-stdout.txt`.
- **Runtime:** unknown; some solutions build or train. It is measured in the check pass, with no Bedrock cost.

### 4.5 Solution-lookup scanner (`lookupscan.py`; implements §7.7's L1/L2; deterministic, version-hashed, never sees rewards)
**Input.** Each trial's Codex rollout (`agent/sessions/**/rollout-*.jsonl`, collected by Harbor; fallback
`agent/codex.txt`, the `exec --json` events).
- **Actions:**
  - `function_call.arguments`, the whole JSON (`cmd`, `write_stdin` chars);
  - `custom_tool_call.input`: apply_patch bodies and heredocs, i.e. scripts the agent writes and then runs;
  - `local_shell_call.action.command`;
  - `web_search_call.action` (expected absent).
- **Outputs:** `function_call_output.output` and `custom_tool_call_output.output`.
- **Normalisation:** lowercase, one round of percent-decoding, shell line continuations joined.
- **Network log:** a3's kernel connection log (`llmar-online: ` prefix; source container IP and destination IP and
  port; harvested with `journalctl -k`; joined to the trial by container IP and trial window).
  - **Join key** (a3): the LOG line's `PHYSIN=<host veth>` names the container's host-side veth, which lives only as
    long as the container, so it beats the reused 10.201.0.x.
    - In online mode, `llmar_env.start()` reads the container's `eth0` iflink and IPv4 address once after start (one
      exec of `cat` before the agent runs).
    - It maps the iflink to the host veth name through the host's `/sys/class/net/*/ifindex` (llmar_env runs on the
      host) and writes `llmar-net.json` (veth, ifindex, ip, at) into the trial's logs.
    - The join is on (PHYSIN, trial window), never on PHYSIN alone: a later trial can get the same veth name once
      Harbor deletes the container. Without NET_ADMIN the agent can't rename or replace eth0, so one read at start
      is enough. The pilot confirms that PHYSIN appears. The fallback is IP plus trial window.
    - Timestamps come from journald (`-o json`, `__REALTIME_TIMESTAMP`, µs).
  - It has no hostnames. The benchmark's hosts sit on shared CDN or GitHub addresses, so an IP can't show benchmark
    access. It is therefore **not used for L1/L2**: every flag comes from the command log.
  - It is recorded descriptively: per run, the counts of accepted and rejected new connections by port class, and
    of rejected non-80/443 attempts.
  - The report says the network log carries no hostnames.

**L1: benchmark access** (actions, plus the network log):
- **Code hosts:** `(github\.com|gitlab\.com|raw\.githubusercontent\.com|codeload\.github\.com|api\.github\.com/repos)[/:]`
  followed by `harbor-framework/`, `laude-institute/`, or any `<owner>/<repo>` whose path contains
  `terminal[-_]?bench` (forks and mirrors). HTTPS, API, raw and `git@host:` forms all count.
- **Benchmark sites:** `tbench\.ai`; `hub\.harborframework\.com`.
- **Hugging Face:** `(huggingface\.co|hf\.co)/(datasets|spaces)/<id>` with `terminal[-_]?bench` in the id. Also an HF
  client call (`snapshot_download`, `hf_hub_download`, `load_dataset`, `huggingface-cli`/`hf download`) with such an
  id in the same action.
- **Benchmark tooling that fetches tasks:**
  - `(pip3?|uvx?|pipx|poetry)\b[^\n;&|]*\b(terminal-bench|harbor)\b`;
  - `\bharbor\s+(run|datasets?|tasks?|download|jobs?)\b`;
  - `\btb\s+(run|tasks|datasets?)\b`.
  Proposed for 0d to confirm under "hosts serving the benchmark".
- **Web search:**
  - a `web_search_call` query, or a search-engine URL (`google.`, `bing.com`, `duckduckgo.com`,
    `search.brave.com` with `q=`/`p=`), containing the benchmark name (`terminal[-_ +]?bench`, `tbench`) or the task
    id;
  - **0d:** single-word ids (for example `mailman`) will match ordinary searches. I propose matching an id only if it
    contains a hyphen, or appears next to `bench`/`solution`. With "no manual overrides", false positives stay
    flagged, so this matters.

**L2: solution artifact** (actions and outputs; references are precomputed per task from the local checkout and
never committed):
- **By content:**
  - the dataset canary (the `terminal-bench-canary` marker or its GUID, read at scan time from the task's Dockerfile;
    it is in solve.sh and the tests of 88 of 89 tasks and in no instruction) appears in an output;
  - or ≥ 3 distinct *distinctive lines* of the task's own `solution/` or `tests/` files appear verbatim in outputs
    or actions. A distinctive line is ≥ 30 characters stripped, occurs in only this task's files, and is not in its
    `environment/` or instruction.
  - This is the practical form of "a content hash of those files": fetched files reach the log as text, rarely
    whole.
- **By path:** a URL whose path ends in `solution/solve.sh` or `tests/test_outputs.py`, or contains
  `/tasks/<task id>/`. A bare local path doesn't count: an agent may name its own script `solve.sh`, and those paths
  don't exist in the container during the agent phase.
- **"What the task image provides":**
  - lines and canary occurrences that also appear in the task's `environment/` files don't count. The canary is in
    the build-context files (10 files) of 7 tasks.
  - Spans that appear in the task's instruction don't count. One instruction contains the string `terminal-bench`.

**Also recorded, never flags** (descriptive, for 0d to keep or drop):
- protected-archive decryption (`openssl enc … -d` on `/protected/*.enc`). One task ships its solution encrypted in
  the image, and the password is in the public solve.sh.
- another model's API (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `openrouter.ai`,
  `api.groq.com`, `api.deepseek.com`, `api.together.xyz`, `bedrock-runtime`): arm contamination, not lookup.

**Network config touched** (17; feeds classify rule (b), never a lookup flag). `net_config_touched` is true when
any action writes, or tries to change, the network setup the verifier inherits. "Writes" means a write-shaped action
on the path: `>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `ln`, `rm`, `truncate`, an apply_patch target, or
`open(…, 'w'|'a')`. Reading doesn't count. The sub-rules, each counted in `evidence`:
- **N1 resolver:** `/etc/resolv.conf`, `/etc/hosts`, `/etc/nsswitch.conf`, `/etc/gai.conf`.
- **N2 apt:** `/etc/apt/sources.list*`, `/etc/apt/apt.conf*`.
- **N3 package index:** `pip.conf` (any location), `pip config set`, `uv.toml`, `~/.config/uv/`, and any assignment of
  `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL` or `UV_INDEX_URL`.
- **N4 proxy:** any assignment or export of `http_proxy`, `https_proxy`, `all_proxy` or `no_proxy`, in either case.
  Inline and persisted (`/etc/environment`, shell init files) both count.
- **N5 network stack:** `ip (route|addr|link) (add|del|change|replace|set)`, `iptables`, `nft` (NET_ADMIN isn't
  granted, so this counts the attempt).
- **N6 TLS trust:** `/etc/ssl/certs`, `update-ca-certificates`, and removing or purging `ca-certificates` or `curl`.

The definition is deliberately broad: a false "touched" withholds a rerun (agent outcome), which is the conservative
direction. Rule (b) requires `net_config_touched == false`; 0d decides. S6 reports the (b) rate per arm either way.

**Per-run record** (`row.lookup`, text-free):
- `scanner` (version hash), `flag_l1`, `flag_l2`, `flag`;
- `evidence` (sub-rule → count), `hosts` (normalised public host/owner names), `first_action_index`, `actions`,
  `outputs`;
- `source` (rollout / codex.txt / missing), `net_log` (true/false).
A local-only `lookup-hits.jsonl` (gitignored, never committed) keeps the action index and a 200-character window
per hit, for the report's false-positive notes. Agent commands can carry task text.

**Calibration:** before the pilot, on synthetic rollouts (unit tests). On the pilot's rollouts, hits are read, never
rewards. The rules are then frozen and the version hash goes into run-config. **Limits** (stated in the report):
encoded or obfuscated fetches can't be seen, and without a network log, fetches by programs the agent didn't write
in a visible action can't be seen either.

### 4.6 Isolation suite: TB gates
**CLI (17's Q3):**
```
isolation.py run --where runner --profile tb21 --env llmar --harbor harbor --region R --out $WORK_DIR/tb21/results/isolation
```
- The probe image is unchanged (`python:3.13-slim`, pinned by digest; stdlib probes).
- The host ENI IP comes from `ip -4 route get` on the host. The VPC resolver is VPC base + 2 (RUNNER_CIDR is
  already in infra). No arguments, no ids.

**How it runs:** a real Harbor trial with the oracle agent on a TB-shaped probe task (`allow_internet = true`, shared
verifier). solve.sh runs `isoprobe.py --role agent-online` and test.sh runs `--role verifier-online`. Every gate
holds in both phases.

| gate | must hold |
|---|---|
| O1 internet | DNS through `169.254.169.253:53` resolves; TLS to pypi.org:443 and an HTTP request to a public host on :80 succeed |
| O1b egress limits | a public host on :22 and :8443: connection refused, fast (< 2 s); UDP 53 to a public resolver: no answer; QUIC (UDP 443) to a public host: blocked; `169.254.169.253:443`: no connect |
| O2 metadata | 169.254.169.254:80, `[fd00:ec2::254]`, 169.254.170.2, 169.254.169.253: no connect |
| O3 private | the VPC resolver, the host ENI IP (all probed ports), and one address each in 10/8, 172.16/12 (not .17.0.1), 192.168/16 and 100.64/10: no connect |
| O4 host | `172.17.0.1:8088` answers; `:22`, the `br-llmon` gateway and the docker API ports: no connect |
| O5 containers | a listening probe container on `llmar-online` is unreachable by IP; probes on docker0 and on a pool bridge are unreachable (and DeepSWE gates 3–4 still pass for those bridges) |
| O6 inbound | no container publishes a port; no DNAT for `br-llmon`; host listeners only on loopback and the proxy (gate 5); the security group has no inbound (from `--aws-sg`, judged offline) |
| O7 caps | AF_PACKET socket: EPERM |
| O8 network | `llmar-online` has the contract's bridge name, subnet, `icc=false`, IPv4 only; the trial container's only non-lo interface is on it; its resolv.conf upstream is `ONLINE_DNS` |
| O9 log | the probe's own accepted (:443) and rejected (:22) connections appear in the kernel log with the `llmar-online: ` prefix, its container IP and its host veth as `PHYSIN` (as recorded in `llmar-net.json`) |
| L, P | leakscan over the outputs; the probe image is present (unchanged) |

`--profile deepswe` keeps today's gates.

### 4.7 Harvest, classifier interface, leakscan, report
**`harvest.py`** (17's Q4: task_dir plus the plan's task meta is enough; the rest comes from `taskpin.task_facts`):
- Profile `tb21` writes `tbench-harbor-run/v1` with the same field names.
- `repo`, `language`, `size_bucket` and `patch` are `null` (the work is the container state).
- Adds the §4.3 facts, `verifier.ctrf` counts (existing parser), `tests_ran`, `lookup` (§4.5) and `flaky_env`.

**Classifier: 17's, under 0d's §7.4.**
- **(a)** TB has no patch, so `verifier_infra` → **rerun**, not regrade: the shared container is gone.
- **(b)** Reward 0, no ctrf or 0 tests, and a network-error pattern in `verifier/test-stdout.txt` → `verifier_infra`.
  - Patterns: curl exit 6/7/28 messages, apt `Temporary failure resolving`/`Could not connect`/`Unable to fetch`,
    the uv installer's download failure, pip/uv `ConnectionError`/`error sending request`/`dns error`.
  - Owner: 17 in classify. I'll supply the candidates from the 89 test.sh files' tools.
  - A reward 0 with tests not run and no network error stays an agent outcome. Without that condition, an agent
    that breaks the environment would earn a rerun.
- **(c)** "No patch = 0" has no TB meaning: an agent exception before the verifier ran is a rerun. Harbor verifies
  after agent timeouts, so this is rare.

**Leakscan (17's FYI; 18 and 4f):** TB's own fixture files (sanitize-git-repo, plus 3 tasks with basic credentials)
trip high findings.
- Proposal: `leakscan --fixture-dir <task checkout>`. A finding whose exact value occurs in that task's checkout
  files is reported as `fixture` (counted, not high). The real account id (IMDS exact match) stays high, whatever the
  fixtures contain.

**`report_zh.py`:**
- The profile sets the title, the path `docs/experiments/tbench-harbor.zh-CN.md`, the schema and planned reps
  (3/3/3/3).
- The DeepSWE §7.5.2 blind set and interim-look disclosure are off.
- S7a and S7b are on only if §7.10's `rep4`/`rep5` run ("reps 1–3 only" and drift of reps 4–5 vs 1–3).
- TB additions per §7: P1-tight (NI 5 pp); the §7.7 primary (flagged resolved → 0) and the as-graded sensitivity;
  flag rates; difficulty strata (easy+medium / hard) and the tier × difficulty table; `flaky_env`; the post-run
  oracle sensitivity; the C ≥ 80% premise check; §7.11's side-by-side (`--compare-with` DeepSWE's
  `report-data.json`); the public reference line.
- DeepSWE's render stays byte-identical (golden test).

### 4.8 Dev-box dry run (arm64, mock router)
- All TB images are amd64 and the dev box has no emulation. So it uses a TB-shaped stand-in: an arm64 image,
  `allow_internet = true`, shared verifier, and a test.sh that downloads uv like the real ones.
- Real Harbor, Codex, `harbor_job` and `RunnerProxy`, against `mock_upstream`, on a local `llmar-online` network.
- Checks:
  - install skipped; web search disabled in the request;
  - session and hint headers;
  - the container is on `llmar-online` only; DNS through the overlay;
  - the verifier downloaded its tools;
  - a lookup record exists;
  - the capture for 73.
- There is no runner firewall on the dev box, so O2–O5 are runner-only, as in DeepSWE's suite.

## 5. Host proxy (4f)
`hproxy.py` is unchanged: routes, `model = auto`, session stamping and hints, shared token with re-mint, the
fail-closed `CapLedger`, failure fields and per-trial summaries. TB differences are configuration only:
- **Caps per runner** (§7.9: soft $800, hard $900). The ledger is in TB's work dir, starting at $0.
- **Long trials:** up to 12,000 s plus the verifier. Token re-mint covers it, as for DeepSWE's 3-hour trials. The
  $25 per-trial alert stays.
- **Exposure (builder-security):**
  - **Unchanged:** the bind is `172.17.0.1:8088` only (`check_bind`); no new listener or published port.
  - **Who can reach it:** containers on `llmar-online` (INPUT rule) and the other local bridges, as before.
  - **What they can do:** call registered routes with model `auto`, bounded by the cap.
  - **New:** containers have the internet. But the token never enters one, IMDS (the instance role's credentials) is
    blocked, and no credential is in the container. The agent can upload whatever is in its container; that is TB's
    standard condition, and the container holds no secret.

## 4–5 implementation estimate (4f; starts after 0c approves)
Hours of focused work, ordered by what gates what. DeepSWE's final fetch is about 12:00 UTC.

| step | gates | est. |
|---|---|---|
| 1. `llmar_env` online mode + overlay + `harbor_job`/`codex_config` (web search, public tasks only) + golden parity tests | everything | 2.0 h |
| 2. `taskpin.py`: three integrity checks, image digest pin and start check, `task_facts` (17 wires the call sites) | prepull, checks | 1.5 h |
| 3. isolation TB gates + isoprobe online roles + second-container and negative-control probes | isolation pass | 2.5 h |
| 4. dev-box dry run (stand-in, mock router), capture for 73 | sign-off for 12:00 | 1.5 h |
| **phase 1: ready for isolation and checks at about 12:00** | | **7.5 h** |
| 5. `lookupscan.py` (L1/L2, exemptions, distinctive lines) + tests + harvest TB facts/schema/lookup | pilot | 3.5 h |
| 6. `report_zh` profile and TB sections + golden DeepSWE render; leakscan `--fixture-dir` (with 18) | report, export | 3.5 h |
| **total** | | **14.5 h** |

If phase 1 is late, O5's negative controls and the capture can follow the first isolation pass, and steps 5–6 run
during the checks and before the pilot.

**Dependencies:**
- a3: the firewall, the network and the connection log (done in the worktree, packet-tested; applied after DeepSWE's final fetch).
- 17: profiles, driver call sites, exporting ONLINE_* into the harbor env, `check_online_network` at run/check start, CPU-weighted admission, `flaky_env` in `checks.json`, and
  classify (a)–(c).
- 0d: the §4.4 infra detail, the §4.5 L1 tooling/id rules, and the descriptive extras.
- 0c: applying the firewall switch; the runs.

## 7. Statistics (0d): pre-registration (budget $4,000 total, PRD)

This section is written before any TB model run. Everything here follows the DeepSWE design (that task's §7)
unless it says otherwise. The planning numbers in §7.1 come from public data only. DeepSWE enters only through its
measured **per-run cost** (from 0c); no DeepSWE outcome was looked at.

### 7.1 Planning data (public)
- **Per-task public results.**
  - Per-trial Harbor Hub data (for example the public job "Terminal-Bench 2.1 · GPT-6 Astra / Codex · reasoning
    efforts low–max", 2,225 trials) needs a Hub login to download. Logging in is the user's decision, so it is not
    used here.
  - The planning profile is instead a published per-task table for TB 2.1: Codex CLI + GPT-5.5 (xhigh), 5 trials on
    each of the 89 tasks, with successes and cost per task (Sentra, "Sentra Code Memory on Terminal-Bench 2.1",
    baseline column). Its mean is 83.4% (371/445). 63 tasks are 5/5 and 5 are 0/5. By difficulty: easy 0.95,
    medium 0.86, hard 0.77.
- **Arm levels (TB 2.1 leaderboard and independent trackers).**
  - Astra (GPT-6 Astra + Codex): **87.4%** at effort high (k = 5). The effort curve is flat, 85.8–87.4% from low to
    max.
  - GPT-6.1 Sol has no public TB 2.1 number. GPT-6 Sol is listed at 83.2%, and 6.1 Sol is "near-Astra". The plan
    therefore covers Sol at 0.80 / 0.84 / 0.87.
  - GPT-6 Luna is listed at 73–80% depending on harness and effort; planned at about 0.73–0.78.
- **A real paired comparison on TB 2.1.** The same source gives two Codex + GPT-5.5 configurations on all 89 tasks
  × 5 trials each. `paired_mean_diff` gives +4.9 pp [+0.9, +9.0], with 28 discordant tasks.
  - So a paired difference at k = 5 has a CI of about ±4 pp here. The simulation below reproduces that (±3.3–4.7
    at k = 5), which calibrates it.
  - The variance of the per-task difference splits about 56% within-task (run noise) and 44% between-task. At
    infinite runs, the B−A half-width floor is about ±2.5–3 pp.
- **Reward hacking is common on TB 2.1.** The leaderboard maintainers disqualified 32 of 445 trials (7.2%) for
  GPT-5.6 Sol (max) + Codex and 33 of 445 (7.4%) for GPT-5.6 Luna (max), but 1 of 445 for GPT-5.5. Disqualified
  trials count as reward 0. This is why §7.7 exists.
- **Cost and time.**
  - The public Astra job averages $1.71 per trial (OpenAI pricing, mean over efforts), with about 0.8 M tokens per
    trial at a 94% cache hit. At the catalog's Bedrock Astra prices ($10 / $50 / $1 per Mtok), that is about
    $1.5–2.6 per trial. Against DeepSWE's measured Astra $4.42, **TB costs about 0.35–0.6× DeepSWE per run**.
  - Leaderboard Codex runs average 7–8 min per trial. Agent timeouts are 10 min to 3.3 h, with a median of 15 min.
    83 of the 89 tasks need 1 CPU, and most need 2 GB.
  - Per-task cost is heavy-tailed: the costliest 5 tasks carry 35% of the public run's cost, and the costliest is
    10× the mean.

### 7.2 Design and estimands
- **4 arms × 3 runs × 89 tasks = 1,068 runs** (user decision), after the §7.5 drop rule. All arms are in every pass
  (§7.6). Unit: a task; the 89 tasks are the whole TB 2.1 release, so nothing is sampled. The estimand is the
  equal-weight mean over the release's tasks.
- **P1.** Δ(B−A) = mean over tasks of [mean of B runs − mean of A runs] (`paired_mean_diff`), with a paired
  percentile bootstrap CI, a sign-flip p, and non-inferiority at **10 pp**, the same margin as DeepSWE and R2E, for
  cross-benchmark comparability.
- **P1-tight**, reported with P1 under the same claim rules: NI at **5 pp**.
  - TB runs near the ceiling (arms at about 75–87%), so 10 pp would allow two-thirds more failures than Astra's.
    It is almost always met (P ≈ 1 in every scenario below) and says little.
  - The report states both and leads with whichever is shown. "NI at 10 pp but not 5 pp" is stated as such.
- **P2.** Cost ratio ΣB/ΣA on per-task mean costs (`cost_ratio`). B's cost includes its assessor calls; a
  ledger-only variant is also shown. These are the report_zh rules from DeepSWE.
- **Claims:** exactly DeepSWE §7.2: NI and lower cost; better (CI lower bound > 0); costs more (cost-ratio lower
  bound > 1); otherwise the point with both CIs; never "equivalent"; a degenerate CI makes no resolve claim but
  keeps the cost claim.
- **Secondary (95% CIs, no multiplicity adjustment, labelled):**
  - S1: B−C (NI at 10 and 5 pp, and ΣB/ΣC); B−F.
  - S2: C−A, F−A.
  - S3: the ideal per-task router over {F, A, C}, held-out (k = 3 allows 3 folds) and in-sample on run 1.
  - S4: by stratum (§7.8).
  - S5: run-to-run noise per arm.
  - S6: descriptive (cost per solved task, timeouts, tokens and cache, B's served-model share, assessor latency and
    cost, failovers, per runner, flag rates from §7.7).
  - Sensitivities: run 1 only (`paired_diff`, comparable with R2E); the §7.4 excluded-as-failures sensitivity; the
    §7.7 lookup sensitivity; the §7.5 post-run oracle sensitivity.
- **Premise check, not a result:** C (Astra) should land near the public 87.4%, because we use the same agent, the
  same effort and timeout multiplier 1.0.
  - If C's run-1 rate is below 80%, the report flags an environment problem (most likely the network guardrails
    breaking tasks) before any comparison is read.
  - The check is computed and read by 0c at the end of the run with the other results, not as an interim look.
- **No interim looks:** no per-arm outcome is computed or shown to anyone until every pass is final on every runner.
  Only cost and run status are used while the run is in progress (DeepSWE §7.5.2). Any exception is disclosed in
  the report, and the comparisons it touches are made on the blind-design set, as on DeepSWE.

### 7.3 Precision at 89 tasks × 3 runs (simulated)
Method:
- Per-task rates are drawn from the public profile's Jeffreys posteriors and shifted on the logit scale to each
  arm's level.
- Each arm gets an independent task-specific effect with sd 0.6 on the logit scale. Results barely move between sd
  0.3 and 1.0: ±0.2 pp.
- Each B run goes frontier with probability f, the assessor's frontier share, which the tier pass measures.
- 600 simulations per cell. Normal CIs, which track the bootstrap at n = 89.

| Sol level | f (frontier share) | B−A ±hw (k = 3 / 5) | P(NI 10) k = 3 | P(NI 5) k = 3 / 5 | B−C ±hw (k = 3 / 5) | P(NI 10) k = 3 | P(NI 5) k = 3 / 5 |
|---|---|---|---|---|---|---|---|
| 0.80 | 0.2 | ±5.0 / 3.9 | 0.99 | 0.75 / 0.91 | ±5.4 / 4.6 | 0.30 | 0.00 / 0.00 |
| 0.80 | 0.5 | ±5.2 / 4.2 | 1.00 | 0.94 / 0.98 | ±4.8 / 3.9 | 0.76 | 0.08 / 0.09 |
| 0.80 | 0.8 | ±5.5 / 4.7 | 1.00 | 1.00 / 1.00 | ±4.3 / 3.4 | 0.97 | 0.42 / 0.52 |
| 0.84 | 0.5 | ±4.8 / 3.9 | 1.00 | 0.81 / 0.92 | ±4.6 / 3.7 | 0.94 | 0.30 / 0.41 |
| 0.87 | 0.5 | ±4.5 / 3.6 | 0.99 | 0.65 / 0.83 | ±4.5 / 3.6 | 0.98 | 0.60 / 0.78 |

- **At k = 3:** B−A is about ±4.2–5.5 pp and B−C about ±4.2–5.4 pp. The B−A minimum detectable difference at 80%
  power is about 6–8 pp (about 5–7 at k = 5).
- These are tighter than DeepSWE (±6.2 at k = 5) because pass rates are near the ceiling, so most tasks have
  near-zero run noise.
- C−A is ±5.1–5.8 pp. F−A is ±6.0–6.8 pp; Luna's expected gap of 7–9 pp is detectable at about 55–85%.
- P(NI 10) on B−C is low only where B really is worse: Sol at 0.80 and f = 0.2 give a true B−C of −5.8 pp. That is
  power working, not a lack of it.
- **What 3 runs can't do:** detect a true B−A of a few pp. The 5 pp margin is the informative NI test.

### 7.4 Scoring, reruns and exclusion
DeepSWE §7.4 is reused as is (classes agent, sut, upstream, harness, verifier_infra, cap_stop and cancelled; at
most 2 reruns and 2 re-verifies; then excluded, pairwise complete; the excluded-as-failures sensitivity above 3
tasks in any arm, counting rerun classes only). TB additions:
- **Agent timeout is scored** (the task's own `timeout_sec`, multiplier 1.0), as on the TB leaderboard.
- **The network is part of the agent's environment.** A pip, apt, download or DNS failure seen inside the agent's
  session is an agent outcome. The agent can retry or work around it, and the internet is a shared condition across
  arms, because a block's arms run back to back.
- It is infrastructure (harness, rerun) only when the harness's own logs show the cause: the host egress filter
  denying a public destination, environment build or start failure (including image or package fetch at build
  time), a proxy error, or host OOM.
- **Verify-time network failure, rule (b) (§6).** Reward 0, and no ctrf or 0 tests in it, and a fixed network-error
  pattern in the verifier's stdout, and **`net_config_touched` false**:
  - then the class is `verifier_infra`. TB has no patch to re-grade, so this means a rerun of the trial (≤ 2).
  - If the agent wrote to its own network configuration (resolv.conf, hosts, apt sources, pip/uv config, `*_proxy`,
    firewall), the run stays an agent outcome. Breaking your own environment must not earn a rerun.
  - The pattern list and the `net_config_touched` rules are fixed and tested before the pilot, and are reward-blind.
  - S6 reports per arm: the (b) rate, the `net_config_touched` rate, and the reruns from (b). If A and B differ in
    their (b) rate (two-sided Fisher p < 0.05 on runs, descriptive), the report says so next to P1.
  - (b) reruns that exhaust their limit fall under §7.4's excluded-as-failures sensitivity, like any other rerun
    class.
- The classifier is a deterministic function of logged fields, tested before the pilot and applied without looking
  at rewards. Its version hash goes into run-config.

### 7.5 Oracle-drop rule (before any model run)
- On the final network rules, on the runner that owns the task's shard: run Harbor's **oracle** (`solution/`) and
  **nop** (unmodified) for every task. Each gets up to 2 attempts, because internet-dependent setup can flake.
  - **Drop** a task if the oracle fails both attempts, or if nop passes either attempt. The same set is dropped for
    every arm, and the drops are listed with their reason.
  - A task whose oracle passes on one attempt and fails on the other is kept and marked `flaky_env`. S6 reports
    flaky-env tasks separately.
  - Rule (b) applies to check attempts too. A (b) attempt (the test runner never started because of the network)
    is retried up to 2 times and not counted. If it is still (b) after that, the slot is `infra-exhausted`:
    - for the **oracle**, it counts as a failed attempt;
    - for **nop**, it counts as *unverified*, not as a pass.
  - **Drop** also if both nop slots are unverified: we have no evidence the tests reject an unmodified task, and
    the verifier's network is unreliable for it.
  - One nop slot clean-failing and the other unverified → keep, marked `flaky_env`.
  - So a task that can't be verified on our network at all is dropped, and a nop pass in any slot drops the task as
    before.
- **Applied, 2026-11-06, before any model run.** 5 tasks were dropped and **84 kept**. Every kept task has 2 complete
  oracle slots and 2 complete nop slots, with no infra retries.
  - Oracle failed both attempts: build-cython-ext (1 of 18 repo tests fails, upstream drift), protein-assembly
    (library drift in the solution), mcmc-sampling-stan (rstan not installed at verify time).
  - Both nop slots unverified, 6 infra attempts each: qemu-alpine-ssh, qemu-startup (the Debian security mirror
    returned 404 for packages right after a fresh index).
  - The causes are descriptive notes from 0c's log reading. They don't enter the rule.
  - `flaky_env`: portfolio-optimization and tune-mjcf (oracle 1 of 2).
  - **No discretionary re-check** of dropped tasks, even an outcome-blind one: the rule was written for exactly
    these cases.
  - Live run: 84 × 4 × 3 = 1,008 runs. The §7.9 costs scale by 84/89, about $2,040 planned at s = 1, f ≈ 0.34.
    The caps are unchanged.
- **Post-run oracle re-check** (no model calls): after the last pass, run the oracle once more on every kept task.
  A task whose oracle now fails is reported in a sensitivity with those tasks removed. Upstream internet content
  may have changed during the run. The primary keeps them, because the change hit every arm of that pass.
- **Pilot:** 2 tasks per shard (8 tasks, 32 runs), so each runner fills its 8 slots once as a load test. The tasks are
  a seeded sample within each shard, excluding tasks with agent timeouts ≥ 7200 s, with at least one multi-CPU task
  fleet-wide to exercise admission. Pilot tasks are excluded from the analysis and run again fresh in `main`.

### 7.6 Run order
- **Passes:** `main`, `rep2`, `rep3`, each with all 4 arms on every task (rep 1, 2, 3). They run in order on each
  runner, sharded by task.
- Each pass's block order is stratified (by tier-pass stratum, then difficulty), seeded with the plan seed and the
  pass name, so any prefix is a stratified subset. Within a block, the 4 arms run back to back in a seeded order.
  So each paired difference sits within minutes of the same internet state, and drift between passes hits every arm
  equally.
- **Long tasks first:** in every pass, the blocks of tasks with an agent timeout ≥ 7200 s move to the front of
  their shard's order. The rest of the stratified order is kept as is (a stable partition). This is fixed before
  any outcome, so a cut prefix is still pre-specified. The prefix always contains those tasks, which is acceptable.
  At the checkpoint, κ is measured on blocks that include them, which errs conservative.
- **Resources are never overridden.** A runner admits trials while the declared CPUs total ≤ 8 and declared memory
  ≤ 48 GB.
  - A 4-CPU task's arms run two at a time, in the block's seeded arm order. Which arms go first is randomised per
    block and pass, so time within a block isn't confounded with arm.
  - 2-CPU blocks run all 4 arms together, and 1-CPU blocks run two blocks side by side.
  - S6 reports the within-block start spread per arm.
- **Sharding:** balance shards on expected cost, using the public profile's per-task cost as the relative weight
  (normalised; arm levels per §7.9), and on difficulty and category. The heavy tail (top 5 tasks = 35% of cost) must
  not land on one runner.

### 7.7 Solution-lookup rule
TB solutions and tests are public, and agents have the internet. 4f's scanner is deterministic, version-hashed, and
fixed and tested before the pilot. It is applied to each run's command log and network log (proxy and egress
records where present) **without seeing rewards**, and flags:
- **L1, benchmark access:**
  - any request or command that touches a host or path serving the benchmark: the TB 2.x and 2.1 repositories and
    their forks or mirrors (GitHub/GitLab paths containing `terminal-bench`, the Harbor framework organisation's
    task repositories);
  - `tbench.ai`, `hub.harborframework.com`, and Hugging Face datasets or spaces whose id contains `terminal-bench`;
  - web search queries containing the task id or the benchmark's name.
- **L2, solution artifact:** reading, fetching or writing content that matches the task's own `solution/` or
  `tests/` files. The match is by path (`solution/solve.sh`, `tests/test_outputs.py`) or by a content hash of
  those files, from anywhere other than what the task image provides.
- **Not flagged:** the upstream sources of the software a task builds or uses (package indexes, the project's own
  repository or docs). Those are the work.

Scoring:
- **Primary (all of P1/P2/S1–S5):** a flagged run that resolved is scored as **not resolved**. This is the TB
  leaderboard's own practice for disqualified trials. It is never excluded, so an arm that looks things up more
  can't lose runs from the comparison. Its cost counts as usual.
- **Sensitivity:** all runs as graded, flags ignored. The report shows both next to P1 and S1, and says when a claim
  differs.
- **S6:** flag rate per arm (L1 and L2 separately, Wilson CIs) and flagged resolved runs per arm.
  - If any arm's flag rate is > 5% of its runs, the report states it in its summary.
  - If flag rates differ between A and B (two-sided Fisher p < 0.05 on runs, descriptive), the report says the
    primary may favour the arm that looks less.
- **No manual overrides of flags.** A human may describe false positives in the report, but they stay flagged in
  the primary.

### 7.8 Stratification
- **Primary strata = the tier pass**, as on DeepSWE. It is 73's offline assessor pass, 3 runs, majority tier with
  "none" counted as standard, frozen in `strata.json` before the pilot. It is the router's own pre-treatment signal,
  so the stratum analysis reads as routing value.
  - In S4: B−A, B−C and C−A per stratum; the decomposition B−A = Σ w_s Δ_s; assessor skill = (C−A | frontier) −
    (C−A | standard), descriptive.
- **Frozen strata (73, 2026-11-06):** **frontier 30 / standard 59** (fast 0 on all 267 calls). 73 tasks are stable
  (21 frontier, 52 standard). Schema `tbench-harbor-strata/v1`, sha256 `9db628eb…` (the full hash is recorded in
  plan.json). The card check matched a live TB first request, so there was no re-freeze.
  - B never serves Luna, so it mixes Sol and Astra only. The S4 transparency checks apply as on DeepSWE: in the
    standard stratum B ≈ A, and in the frontier stratum B ≈ C.
  - Expected S4 half-widths per stratum are wider: about ±8–9 pp at 30 tasks and ±6 pp at 59, all secondary. The
    assessor-skill interaction is descriptive.
  - Pre-treatment context, not a result: the tier pass sends 24% of easy+medium tasks to frontier against 53% of
    hard ones (+30 pp [+8, +50]).
- **TB difficulty** (author-assigned, pre-treatment) is a secondary stratification.
  - Easy has 4 tasks, so it is merged with medium: **easy+medium 59 / hard 30**. B−A and C−A are shown per
    difficulty stratum, descriptive.
  - Also shown: the cross-table of tier-pass tier × difficulty (does the assessor send "hard" to frontier?), and
    the public profile's rate per difficulty for orientation.
- **Gate (PRD step 1):** if the tier pass sends < 10% of tasks to frontier, B ≈ A, and 0c reports that to the user
  before the live run, as on DeepSWE.

### 7.9 Budget ($4,000 total: Bedrock, assessor and runner hours; no separate buffer)
Planning per-run cost is DeepSWE's measured per-run cost × s, where s is TB's cost per run relative to DeepSWE.
s = 0.6 is central (§7.1). The plan is costed at **s = 1.0**, the conservative case.

B costs f × Astra + (1 − f) × Sol plus the assessor. 73's tier pass gives **frontier 30 / standard 59 / fast 0**
(73 tasks stable), so **f ≈ 0.34** and B ≈ $1.97 per run at s = 1. f = 1 is kept as a stress case. The §7.8 gate
(< 10% frontier) is not triggered.

| Item | Runs | s = 1.0, f = 0.34 | s = 1.0, f = 1.0 (stress) | s = 0.6, f = 0.34 |
|---|---|---|---|---|
| Tier pass × 3 | — | 0.3 | 0.3 | 0.3 |
| Pilot (8 tasks: 2 per shard × 4 arms, fills each runner's 8 slots once; not analysed) | 32 | ≤ 75 | ≤ 75 | ≤ 45 |
| A (Sol $0.72) × 3 | 267 | 192 | 192 | 115 |
| F (Luna $0.13) × 3 | 267 | 35 | 35 | 21 |
| C (Astra $4.42) × 3 | 267 | 1,180 | 1,180 | 708 |
| B ($1.97 at f = 0.34; $4.42 at f = 1) × 3 | 267 | 526 | 1,180 | 316 |
| Reruns (DeepSWE's observed rate, about 1%) | ~11 | 20 | 30 | 12 |
| Runners (4 × $2.69/h; about 270 trial-hours at 15 min mean → about 15–45 h wall) | — | ≤ 120 | ≤ 120 | ≤ 120 |
| Assessor (about 1 consult per B run) | — | < 2 | < 2 | < 2 |
| **Planned total** | 1,068 + 32 | **≈ 2,150** | **≈ 2,815** | **≈ 1,340** |
| Unspent within the $4,000 (no extension, §7.10) | | ~1,850 | ~1,185 | ~2,660 |

**Per-runner caps:**
- Each runner gets about a quarter of the planned Bedrock: about $490 (s = 1, f = 0.34) to $660 (f = 1).
- Soft cap **$800**, hard cap **$900**. 4 × 900 = $3,600, + $120 runners + $2 assessor ≈ $3,720 ≤ $4,000. That
  leaves about 1.6× room for κ > 1 on the planned runs and their reruns.
- Pilot caps: soft **$45**, hard **$65** per runner, the same on every runner (0c, 2026-11-06), so ≤ $260
  fail-closed fleet-wide against $49 planned.
  - They were raised from $35 / $50 because the final pilot picks (plan f3503f6) plan $26.0 on shard 1 at s = 1, so
    a $50 hard cap would leave only about 1.5× margin. At $65 every runner has ≥ 2× (a cap stop lost DeepSWE's
    first pilot).
  - `fleet start` refuses to start unless reserve < hard cap − the largest expected single run (about $8 on
    shard 1), on every runner.
- Caps may be raised only to finish the **planned** runs (κ overrun or reruns), and only so that Σ hard caps +
  projected runner hours + assessor ≤ $4,000. They are never raised to add runs.
- The proxy alerts on any trial over $25. There is no per-trial cap, because truncating a run changes the agent.
- **25% cost checkpoint** (cost only, no outcomes): when every runner has finished ≥ 6 `main` blocks, 0c projects
  the total from measured κ.
  - If the projection exceeds $4,000, 0c asks the user before continuing. The options are cutting `rep3` to a
    stratified prefix (all four arms together, so no arm asymmetry) or adding budget.

### 7.10 Extension: none, by user decision
The user fixed **3 runs per task in every arm, with no headroom extension** (2026-11-06; the options offered were
extend to 5 / fixed 3 / up to 4).
- The design is `main`, `rep2` and `rep3` with all four arms, and nothing is added whatever the checkpoint shows.
  The unspent budget stays unspent.
- Consequences, pre-registered:
  - The §7.3 precision at k = 3 is final. With the tier pass's f ≈ 0.34 (between the f = 0.2 and 0.5 rows), it is
    B−A about ±4.6–5.2 pp and B−C about ±4.6–5.4 pp. P(NI 10) on B−A is ≈ 1; P(NI 5) is about 0.7–0.95, depending
    on Sol's level.
  - There are no blind-design splits and no reps-1–3 or drift sensitivities (S7a/S7b do not apply). Every arm
    has the same 3 runs per task in the same passes.

### 7.11 Next to DeepSWE in the report
- **Two parallel tables**, one per benchmark, with the same rows: P1 (with NI 10 and NI 5 for TB), P2, S1 B−C, S2
  C−A and F−A, each with its CI and claim. A cost/quality plane per benchmark shows the 4 arms.
- **No pooled estimate and no pooled claim.** The task populations, ceilings (TB about 85% vs DeepSWE about 70%),
  run lengths and cost scales differ. The report says whether the two benchmarks agree in direction and claim on
  P1, P2 and S1, and treats agreement as consistency, not as extra power.
- If a reader wants one number, a descriptive "both benchmarks" line averages the two per-benchmark estimates with
  equal weight, with the CI from independent bootstraps. It is labelled descriptive and makes no claim.
- **Per-benchmark context:**
  - frontier share f from each tier pass;
  - assessor skill per benchmark;
  - flag rates (TB only);
  - the public reference (TB: Astra + Codex 87.4%; DeepSWE: the public mini-swe-agent rates), reference only.
- **Timing:** the DeepSWE half is written from DeepSWE's final data only, and the TB half from TB's. Neither run's
  outcomes inform any decision about the other. The TB pre-registration (this section) was written before any
  DeepSWE outcome was seen by 0d.
