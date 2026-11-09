# Runner delta for Claude Code × Harbor (a3): draft for 0c's ack, 2026-11-07

**Scope.** `infra/src/runner.ts`, `infra/runner-ssm/`, the infra tests and the deploy context, on branch `cc-harbor` (worktree `llmar-cc`). No code yet.

**Baseline.** `cc-harbor` already has:
- egress modes `none|internet` (3ba33be);
- the console-level fix for the connection log (940c9b8);
- the v2.2 default pack (db02ed5).

**Summary.**
- **No functional change to runner.ts or the SSM scripts is needed.**
- I recommend a deploy-context change: 300 GB instead of 250 GB.
- I recommend a small README note.
- Everything Claude-Code-specific lives in the harness (4f), the same way the Codex binary does today.

## 1. Staging the Claude Code binary: in the harness, like Codex, not in user data

**How Codex is staged today.**
- `fleet.py setup` runs `cli.py stage-codex` on each runner over SSM.
- That fetches the pinned release asset on the host, checks its sha256, and writes `bin/codex-<v>-<arch>`.
- `harbor_job.environment_config` bind-mounts the binary read-only at `/usr/local/bin/codex`.
- Harbor's `install()` returns early when `codex --version` matches.
- The sha256 is re-checked at job start.

**Claude Code fits the same path.** In Harbor 0.25.0's `agents/installed/claude_code.py`, `install()` first runs `is_requested_version_installed`, i.e. `claude --version` with `$HOME/.local/bin` prepended to `PATH`. If that version matches, the npm and `downloads.claude.ai` bootstrap paths never run.

**Proposal (agreed with 4f, who owns the version pin and the code):**

- **`cli.py stage-claude-code`**:
  - one pinned version, chosen by 4f and fixed for both benchmarks;
  - the native release binaries, `linux-x64` and `linux-x64-musl`;
  - the sha256 from the release manifest, pinned in code; the official installer verifies it the same way, and 4f confirms the source for the chosen version;
  - written to `bin/claude-<v>-linux-x64{,-musl}`;
  - re-checked at each job start.
  - Not the npm tarball: task images have no Node.
- **Mount.** Read-only bind at `/usr/local/bin/claude`, which is on `PATH`, so Harbor's version check passes and nothing installs. Agent environment only, as for Codex.
- **libc gate, a new item in prepull (17/4f).**
  - Codex was a static musl binary; Claude Code's native build links against glibc, with a separate musl build.
  - For each task image, prepull runs `docker run --rm --network none -v <bin>:/usr/local/bin/claude:ro <image> claude --version` with the glibc build, and falls back to musl.
  - It records which build works, and refuses the task if neither runs. It does this offline, before any spend.
  - This catches old-glibc or Alpine images. It runs no task code and needs no network.
- **Download source and timing.** The host fetches over its own egress, which the SG allows on 443. This happens during `setup`, before any trial. Containers never fetch.

**Why not user data.**
- The pin belongs with 4f's agent code, as Codex's does.
- A version bump in user data stops and starts every instance.
- User data runs once, and a re-stage after a fix would need SSM anyway.
- I'd stage it in infra only if 0c wants the binary present before `fleet.py setup`. Then `RUNNER_TOOLS.claudeCode` would gain `{version, url, sha256}` ×2 and an install to `/opt/llmar/claude/<v>/` — not recommended.

## 2. Egress: nothing Claude-Code-specific in the firewall

**DeepSWE (`none`). Claude Code reaches only the proxy, fail-closed, with no change.**
- The agent phase uses Harbor's allowlist sidecar (172.17.0.1). The host bounds it: DOCKER-USER drops everything forwarded from a bridge, and RUNNER-BRIDGE-IN admits only TCP 172.17.0.1:8088.
- DNS for every external name goes to 192.0.2.53, which never answers.
- So telemetry, Statsig, error reporting, the auto-updater and any `claude.ai` or `api.anthropic.com` call can't leave, whatever the environment variables say.
- The only cost of a stray attempt is a DNS timeout inside the trial: latency, not a leak.
- Harbor also sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. 4f adds `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`.
- `ANTHROPIC_BASE_URL` points at `http://172.17.0.1:8088/r/<trial>`, with a dummy key.
- 4f must never set `CLAUDE_CODE_USE_BEDROCK` or `_VERTEX`. There are no credentials in the container anyway: IMDS is dropped and the hop limit is 1.

**TB (`internet`). I don't recommend a firewall-level block for Anthropic or Statsig hosts.**
- **IP denies are unreliable and collateral.** These names sit on shared CDN and cloud front ends: the release bucket and error reporting share addresses with general Google and CDN traffic that TB tasks download from. IPs also change during a multi-day run.
- **DNS-level denies need a new component.** That is either Route 53 Resolver DNS Firewall (new AWS resources and writes; it also filters the host) or a host DNS forwarder (a new dependency).
- **Bypass is trivial.** The agent itself has 443 (residual risk (a), accepted), so a block would only cover Claude Code's own background traffic, not the agent.
- **Little is at stake.** There is no valid key in the container, so Anthropic endpoints reject. No secrets are there.
- **Cheap defense in depth instead (4f's choice, container level, no infra change).**
  - The TB online overlay adds `extra_hosts` mapping Claude Code's documented non-API hosts to `0.0.0.0`, so stray calls fail at once: `statsig.anthropic.com`, `api.anthropic.com`, `claude.ai`, `downloads.claude.ai`, the error-reporting host. 4f confirms the list against the pinned version's network requirements.
  - The agent, as root, could edit `/etc/hosts`. The aim is Claude Code's background traffic, not the agent.
- **Tools.** Per the PRD:
  - WebSearch off in both benchmarks.
  - On TB, the same as the Codex profile.
  - 4f, please note that Claude Code's WebFetch does a domain-safety preflight to an Anthropic endpoint, I believe. On TB that is a non-proxy call. Disable WebFetch, or accept it and list it.

**Verification (gates, not infra).**
- 4f's dev-box dry run asserts that the Claude Code process makes no connection or DNS attempt other than to the proxy, with the environment as configured.
- In the TB pilot, the connection log, with the `PHYSIN` join, should show no connections that aren't explained by the task and agent.
- On DeepSWE, counters show whether anything reached the host drops: `iptables -L DOCKER-USER -v -x` and `RUNNER-BRIDGE-IN` drops. Those counters stay at 0 if the sidecar refuses first, so 4f's sidecar denial log is the other half.

## 3. Everything else

**Session logs.**
- Harbor sets `CLAUDE_CONFIG_DIR` to `<agent logs>/sessions`, so transcripts land in the trial directory on the host bind mount, not in the container layer.
- Harbor then also writes the ATIF trajectory.
- Rough size: 5–40 MB per trial, since transcripts include tool outputs.
- Per runner: about 336 DeepSWE trials plus about 252 TB trials, so 3–24 GB. That fits; the next point covers the images.

**Disk: deploy with `runnerVolumeGb=300` (the default), not 250.**
- DeepSWE runs first, then TB, on the same disks. At TB time the disk would hold:
  - DeepSWE images, ≤ 75 GB;
  - TB images, ≤ 42 GB;
  - writable layers, 96 GB;
  - swap, 32 GB;
  - OS and tools, 20 GB;
  - transcripts, ≤ 24 GB.
- That is about 290 GB worst case.
- At 300 GB no mid-experiment prune (a delete with your go) is needed.
- Cost: 4 × 50 GB × $0.096/GB-month ≈ $0.64/day, about $4 for the run.
- The alternative is to keep 250 and prune DeepSWE images by name before the TB prepull, per 17's rule.

**Memory and CPU.**
- Claude Code (Bun) has more resident memory than Codex (Rust): roughly 0.3–0.6 GB more per agent.
- Most TB tasks set `memory_mb = 2048`, and the agent runs inside that limit, since resources are never overridden.
- Expect some container OOMs that Codex didn't hit. 17 already records `OOMKilled` and runner-metrics.
- For 0d: classify these as agent effects within the experiment. In the cross-agent comparison, mention them descriptively.
- Host RAM is fine: 6 × 0.6 GB extra against 64 GB plus swap.

**Console level and connection log, carried over unchanged.**
- DeepSWE uses `none`: no LOG rule, and the console level doesn't matter.
- For TB, `runner-egress-internet.sh` sets `kernel.printk` to `4 4 1 7` before the LOG rule goes live, and checks it. A fresh AL2023 instance will again boot at 8; the script handles that.
- The connection-log prefix, `PHYSIN`, and the journald defaults are as before.
- 0c: repeat the two read-only checks (printk, journald cap) on the new instances before the TB switch.

**Deploy.**
- **Pin the AMI** (`runnerAmiId`) to the one that resolves at deploy time. The experiment spans days, and an unpinned redeploy after an AL2023 release replaces the instances.
- **The secret.** A restored `llmar-runner/client` secret keeps its ARN, so `runnerSecretArn` is unchanged. A recreated one gets a new 6-character suffix, so pass the new ARN.
- **Context:** `-c runnerCount=4 -c runnerInstanceType=r7i.2xlarge -c runnerVolumeGb=300 -c runnerSwapGb=32 -c runnerDirectModel=none -c runnerAmiId=<pinned>`, egress default `none`.
- **TB:** switch via `runner-egress-internet.sh` after DeepSWE's final fetch, as last time. Don't redeploy with `runnerContainerEgress=internet`; that would stop and start the instances.

## 4. Tests and the expected cdk diff

**Tests.**
- With the recommended path (no functional change), none need updating.
- I'd add one README paragraph under "Experiment runner": Claude Code is staged by the harness, and the container's DNS and firewall make its non-proxy traffic fail closed in `none`.
- I'd also check `runner.test.ts`'s "nothing fetched from inside a container" assertion, which already covers it.
- If you choose infra staging instead:
  - `runner.test.ts` (user data pins: 3 → 5 curls, each followed by `sha256sum -c` before install, an install path and `test -x`, the 16 KB limit);
  - a new `RUNNER_TOOLS.claudeCode` pin test;
  - `runner-egress.test.ts` is unchanged either way;
  - the drift test is unchanged, since the switch scripts don't change.

**Expected cdk diff.**
- The stack no longer exists, so `cdk diff` shows every resource as new: VPC, subnet, IGW, route, flow logs and their log group, SG, role and instance profile, 4 instances, the results bucket and its policy, `PutRunResults`, the default-SG custom resource.
- Compared with the template last deployed for DeepSWE/TB, the only differences come from context:
  - the root volume, `VolumeSize` 250 → 300, if you take §3;
  - the `ImageId` parameter, now a fixed AMI if pinned;
  - the secret ARN in `ReadClientSecret`, if recreated.
- UserData is byte-identical, for `none`, to the deployed one: the egress code doesn't change user data in `none` mode, and the v2.2 pack commit didn't touch runner.ts's user data.
- I'll confirm that with a local synth diff against 940c9b8, once you ack the volume choice.

## 5. Asks

- **0c.** Ack:
  - (1) harness-owned staging;
  - (2) no firewall-level host block on TB;
  - (3) `runnerVolumeGb=300` and a pinned AMI.
  Then I write the README note and run the synth diff.
- **4f.**
  - The version pin and stage command;
  - the mount at `/usr/local/bin/claude`;
  - the libc gate in prepull;
  - the env set;
  - optionally, `extra_hosts` on TB;
  - the WebFetch decision;
  - the dry-run assertion of proxy-only traffic.

## 6. Run checklist (0c runs these, read-only; added 2026-11-07 for the A/C validation run)

The scope is now arms A and C, stage 1 only. There is no stop/start, and the runners are torn down after TB. Runner count (17, 2026-11-07): stays at 4, because the plans are pinned to the 4-way Codex shards. So 300 GB, as already synth-diffed. Expected wall time is about 7–9 h for DeepSWE plus TB.

**Deploy day, on the fresh instances**
- Check cloud-init, docker and `runner-firewall`, as in the TB runbook.
- Record the pinned AMI id in the task run log only.

**After DeepSWE's final fetch, before the TB switch, on every runner**
1. Read the DeepSWE drop counters. Save them with the DeepSWE results, because the switch re-runs the firewall script and resets RUNNER-BRIDGE-IN.
   - `iptables -L DOCKER-USER -v -x -n`
   - `iptables -L RUNNER-BRIDGE-IN -v -x -n`
2. Check `kernel.printk`: the console level must be ≤ 6 after `runner-egress-internet.sh` (the script checks this too). Also check journald disk usage against MaxUse: `journalctl --disk-usage` and `systemd-analyze cat-config systemd/journald.conf`.

**Before teardown, on every runner, fetched with the results**
1. The TB connection log, `journalctl -k --grep llmar-online -o short-iso-precise`. 4f joins it on `PHYSIN` with 17's veth and trial-window map.
2. If wanted, the VPC flow-log group, which has RemovalPolicy DESTROY.
3. Emptying the results bucket is a delete. It happens only with the user's explicit go, after the final fetch is verified. The bucket has no autoDeleteObjects, so the destroy fails until it is empty.
