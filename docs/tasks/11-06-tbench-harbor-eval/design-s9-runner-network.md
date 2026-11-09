# §9 Runner network for Terminal-Bench (a3): draft for 0c's review, 2026-11-06

Code: worktree `llmar-tb21`, branch `tb21-harbor`, not committed:
- `infra/src/runner.ts`
- `infra/src/runner-ssm.ts`
- `infra/runner-ssm/*.sh`
- `infra/src/runner-egress.test.ts`
- `infra/test/runner-netns/`
- `infra/README.md`

Nothing has been applied. The contract was agreed with 4f; it matches design §4.2 and §4.6.

## 9.1 Decision

**Internet egress for one fixed Docker network, not for the bridges in general.** This is 4f's proposal, and I adopted it in place of my first draft, which opened every bridge.

- **Context flag** `runnerContainerEgress=none|internet`, default `none`.
  - `none` is byte-identical to d3e56dc: the firewall script, daemon.json and user data. A test freezes the deployed firewall.
  - So merging this branch changes nothing on a `none` deploy.
- **What `internet` adds:**
  - **Network** `llmar-online`: bridge `br-llmon`, `10.201.0.0/24`, `enable_icc=false`, Docker MASQUERADE, IPv4 only.
    - Created by infra: the user data, or the switch script.
    - 17's driver only checks it (`taskpin.check_online_network`).
    - 4f's `llmar_env` online mode attaches `main` to it (`external: true`), with `dns: [ONLINE_DNS]` and `cap_drop: NET_RAW`.
  - **Firewall:** two chains, jumped to from the top of DOCKER-USER, matching `br-llmon` only. The existing drops stay below them, last.
  - **Env file:** `CONTAINER_EGRESS=internet`, `ONLINE_NETWORK=llmar-online`, `ONLINE_DNS=169.254.169.253`. If the keys are absent, the mode is `none`, and 4f's online mode refuses to start.
- **Unchanged:**
  - docker0 and every compose-pool bridge stay offline. That covers BuildKit, stock Harbor networks and DeepSWE.
  - INPUT (host only at `172.17.0.1:8088`), the IPv6 drops and the SG.
  - **daemon.json is unchanged, so dockerd does not restart.**

## 9.2 Rules (internet mode)

DOCKER-USER, in order:
1. `-i br-llmon -j RUNNER-ONLINE-OUT`
2. `-o br-llmon -j RUNNER-ONLINE-IN`
3. Then, as deployed: `-d 169.254.169.254/32 DROP`, `-i br+ DROP`, `-i docker0 DROP`, then Docker's own rules.

RUNNER-ONLINE-OUT:

| # | Match | Action |
|---|---|---|
| 1 | conntrack INVALID | DROP |
| 2 | ESTABLISHED,RELATED | ACCEPT |
| 3 | `-o docker0`, `-o br+` (any container, same or other bridge) | DROP |
| 4 | `169.254.169.253` udp/tcp 53 (VPC resolver) | ACCEPT |
| 5 | every non-global IANA special-purpose IPv4 block (15 CIDRs: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4) | DROP |
| 6 | tcp (new, public) | LOG `llmar-online: ` |
| 7 | tcp 443, 80 | ACCEPT |
| 8 | other tcp | REJECT tcp-reset |
| 9 | anything else (UDP incl. QUIC, ICMP) | REJECT icmp-admin-prohibited |

RUNNER-ONLINE-IN: ESTABLISHED,RELATED → ACCEPT; everything else → DROP.

- **NAT** is Docker's own per-network MASQUERADE. The switch script checks that the rule is present.
- **Why 80/443 only:** the SG's egress is TCP 80/443, so anything else would time out at the SG anyway. Rejecting it on the host makes it fail at once. 4f checked all 89 tasks: none uses another public port or scheme.
- **Why the VPC resolver:**
  - The SG blocks port 53 to public resolvers.
  - Security groups and NACLs can't filter traffic to the Amazon DNS server (VPC user guide, "Understanding Amazon DNS").
  - dockerd's embedded resolver forwards to a non-loopback upstream from the container's namespace (moby v25 `resolver.go`, `HostLoopback`), so the query goes through FORWARD, where rule 4 admits it.
  - Using the resolver needs no deploy.

**Tested without a runner:**
- **Packet level** (`infra/test/runner-netns/packets.sh`): real iptables-nft 1.8.8 (the same as AL2023), veth, bridges, `br_netfilter`, conntrack and NAT, run in an unprivileged user+net namespace with Docker 25's bridge baseline.
  - Internet mode: 29/29, covering:
    - public 443/80 ok;
    - :22, :8443 and :53/tcp to a public address get an immediate RST;
    - UDP 53/443 to a public address rejected;
    - the resolver on 53 ok, on 443 not;
    - IMDS, 169.254.170.2, the VPC, 100.64/10 and the documentation ranges dropped;
    - same-bridge traffic both ways and cross-bridge traffic dropped;
    - proxy ok; host ports, gateway IPs and the ENI IP dropped;
    - the pool bridge fully offline;
    - an outside sender routed straight to a container dropped;
    - the internet side sees only the MASQUERADEd host address.
  - None mode: 11/11.
- **Switch dry run** (`switch.sh`): deployed → internet → internet → none → none → internet.
  - Internet mode is idempotent.
  - `none` restores the deployed filter table and the env file exactly.
- vitest runs both of these, plus the static tests: 45/45 in infra.

## 9.3 Applying to the running runners (0c, after DeepSWE's final fetch)

- **Scripts:**
  - `infra/runner-ssm/runner-egress-internet.sh` applies.
  - `infra/runner-ssm/runner-egress-none.sh` rolls back.
  - Both are generated (`node src/runner-ssm.ts`), and a test fails if the committed files drift.
  - Each is one script, idempotent, and each undoes the other.
- **Run:** as root via `AWS-RunShellScript` on all 4 runners. The script:
  1. refuses unless it is root, on a runner (env file, firewall, drop-in), `PROXY_PORT=8088` and **no container running**;
  2. backs up the firewall script and env file to `/var/lib/llmar-runner/egress-backup/<ts>-XXXX/`;
  3. installs the firewall script a fresh deploy in that mode would have, and runs it;
  4. `internet`: creates or checks the network; `none`: removes the online jumps and chains;
  5. rewrites the env keys;
  6. checks every rule (`iptables -C`), the rule counts, the jump order, the NAT rule and the env file.
- **Success:** the last line is `runner-egress: internet; previous files in …`. Any failure exits non-zero, and the old drops are still in place.
- **Why "no container running":** re-running the firewall script flushes and refills RUNNER-BRIDGE-IN, which leaves a window of milliseconds in which host ports aren't filtered. Never run it during a live run.
- **After the switch:** 4f's gates O1b/O1/O8/O9 from inside a real trial on every runner, plus the kernel-log check.
- **Rollback:** `runner-egress-none.sh`. It leaves the empty `llmar-online` network, which is a `br+` bridge again and so fully offline. Removing it is optional (`docker network rm llmar-online`, your call).
- **Fresh deploy:** `-c runnerContainerEgress=internet` reproduces the same state. **Don't** change the context on the live stack: the user data change would stop/start the instances. Use the scripts.
- **Reboots:** the installed firewall is the internet version, re-applied by ExecStartPost, and the network persists. The state survives a reboot.

## 9.4 Docker Hub and disk

- **Rate limit:**
  - The runners **don't share an IP**. Each has its own auto-assigned public IPv4 (public subnet + IGW, no NAT gateway), so each gets its own anonymous quota of 100 pulls / 6 h.
  - The IP changes on stop/start, which doesn't matter here.
  - A pull counts manifest GETs only; HEAD and layer downloads are free.
  - Per runner: about 22–23 task images plus the probe image, so about 24 pulls; a full retry of the shard fits too.
  - Harbor never pulls an image that is already present: prebuilt (`force_build` false), and `compose up` defaults to `pull_policy: missing`. So nothing is pulled during the run. Don't add `--pull always` or `compose pull`.
  - To see the remaining quota without spending it: an anonymous token plus a `HEAD` on a manifest returns `ratelimit-remaining`.
- **Prepull plan:** 17's `prepull`, as designed. On each runner, pull its shard as `alexgshaw/<task>@sha256:<pinned>`, then `docker tag` it to `:20251031`, plus the probe image. Pull concurrency 4.
  - Pin the digests now (taskpin): 10 of the 89 tags were re-pushed in 2026-04 under the old `20251031` name. Examples: hf-model-inference, mteb-*, pytorch-model-recovery, caffe-cifar-10.
  - 4 images are multi-arch indexes; on x86 they resolve to amd64, still one pull each.
- **Sizes** (Docker Hub repository API, which doesn't count toward the limit; amd64, compressed):
  - 89 images, 21.0 GB in total, median 0.15 GB, largest 1.43 GB (reshard-c4-data).
  - Size-balanced shards: 5.2–5.3 GB each. Bound: the 23 largest images, 13.9 GB.
  - Unpacked about 3×, so **16–42 GB per runner**.
- **Pruning DeepSWE first: not required.** The 250 GB per runner is already holding:
  - up to about 75 GB of DeepSWE images;
  - 32 GB swap;
  - about 20 GB of OS and tools.
  - That leaves about 80–120 GB for TB images and writable layers. TB tasks install pip/apt and torch at run time, a few GB per container, and Harbor deletes them.
  - I agree with 17's rule: prune only if `docker_free_gb` < 100 after the prepull, and only with your go.
  - If you prune, remove DeepSWE's task and verifier image refs by name (`public.ecr.aws/…swe-bench-202605:*`, `hb__*`). **Not** `docker image prune -a`, which would also remove the prepulled probe and sidecar images.

## 9.5 What gets weaker than DeepSWE (for the user and builder-security)

**Nothing new is reachable from outside.**
- No listener is added and no inbound path is opened: the SG has no inbound rules, ports are never published, RUNNER-ONLINE-IN drops everything except replies, and hairpin traffic through a runner's public IP is dropped by the SG.

**Outbound changes, for a task container (agent and verifier share it) on `llmar-online`:**

| Destination | DeepSWE | TB (`internet`) |
|---|---|---|
| Public IPv4, TCP 443/80 (any host, any content) | no | **yes** |
| Public IPv4, other TCP ports / UDP / ICMP | no | no (rejected; the SG would drop it anyway) |
| VPC resolver 169.254.169.253:53 (public names; the VPC's own EC2 internal names; no private zones) | no | **yes** |
| Host 172.17.0.1:8088 (proxy, which holds the token) | yes | yes (unchanged) |
| IMDS v4/v6, ECS creds, other link-local addresses | no | no (dropped; plus hop limit 1, IMDS IPv6 off) |
| VPC hosts, other runners (private IPs or public IPs), the host's other ports and addresses | no | no |
| Other containers (same network or any other) | no | no |
| Anything over IPv6 | no | no |
| docker0 and compose-pool bridges (BuildKit, stock Harbor) | offline | offline (unchanged) |

**Residual risks, stated plainly:**
1. **Exfiltration and download, unrestricted on 80/443.** Anything in the container can be sent to any internet host, and anything can be fetched, including the benchmark's public solutions. The latter is the PRD's lookup rule (4f's `lookupscan`, driven by the command log).
   - Nothing secret is in the container: no gateway token, no AWS credentials. IMDS is blocked and the hop limit is 1. The proxy holds the token on the host.
2. **Reverse tunnels.** Outbound 443 allows a tunnel (ngrok/cloudflared style) through which an outside party could drive the container and, through it, the proxy at 172.17.0.1:8088, spending Bedrock budget with our token.
   - Bounds: the proxy's per-runner caps fail closed, the arm's model is pinned, and the trial has a timeout, after which the container is deleted.
   - It can't be prevented at L3/L4 while 443 is open. Detection: tunnel tools in the command-log scan (suggested to 4f), plus the connection log.
3. **Our IP on the internet.** Container traffic leaves from the runners' public IPs, i.e. the account's. Abuse by an agent (scraping, form spam, scanning on 80/443) would be attributed to the account, and abuse reports go there.
   - No bandwidth or connection-rate limit is set.
   - VPC flow logs record this traffic under the instance's private IP, indistinguishable from the host's own. The kernel connection log (below) is the per-container record.
4. **Public AWS endpoints** (S3, STS, Bedrock, the router API, Cognito) are reachable, but only anonymously: the container has no credentials or client secret.

**Connection log:**
- What is logged: every new TCP connection from `br-llmon`, accepted or rejected. Each line has the interfaces (with `br_netfilter` probably also `PHYSIN=<veth>`, which identifies the container more precisely than its reused IP; to confirm in the pilot), the source and destination address and port, and no payload.
- How to read it: `journalctl -k --grep llmar-online -o short-iso-precise`. journald stamps each entry with µs realtime, which is enough for 4f's join by IP and trial window.
- Volume: a few hundred lines per trial, so about 100k–1M lines per runner over the run; well within the journal's default cap.
- It has no hostnames, so it can't prove a solution lookup (4f agrees: counts only).

**Approval asked:** the user chose outbound internet with these guardrails. Residual risks 2 and 3 are the parts to accept knowingly. The private alternative would be an allowlisting HTTP(S) proxy on the host for pip/apt/HF/GitHub, at the cost of task failures and a new component; I don't recommend it for this run.

## 9.6 Open items

- **0c:**
  - review the scripts;
  - after the final fetch, run `runner-egress-internet.sh` on the 4 runners;
  - decide on pruning, only if the prepull leaves less than 100 GB free.
- **4f:** gates O1b/O1/O8/O9. In the pilot, confirm that `PHYSIN` appears in the log lines.
- **17:** export `ONLINE_*` to Harbor (done per 4f); the prepull by digest; `check_online_network` after `prune_networks`.
