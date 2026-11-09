// Experiment runner stack (`<prefix>-runner`): one x86 EC2 instance that runs third-party amd64 task images for the
// Codex experiments (R2E-Gym; DeepSWE via Harbor). It is deployed and destroyed independently of the router stack and shares nothing with it.
//
//   new VPC: one public subnet + IGW, no NAT; flow logs (all traffic)
//   SG: no inbound rules; egress 443 and 80 only (image and package pulls, Cognito, the gateway, SSM)
//   EC2 (x86_64, AL2023): IMDSv2 required, hop limit 1 (containers on a Docker bridge cannot reach the instance
//     credentials); host firewall (re-applied on every Docker start, fail-closed): from the bridges to the host only
//     the proxy (docker0 address, proxy port), and forwarded from the bridges either nothing (runnerContainerEgress=none,
//     the default) or public IPv4 on TCP 80/443 plus the VPC resolver (internet); SSM only, no key pair
//   host tools (pinned, checksummed): Docker + buildx (AL2023), the compose plugin, uv, Harbor; nothing is fetched
//     from inside a container
//   role: the Session Manager + Run Command minimum (inline) + secretsmanager:GetSecretValue on exactly one secret ARN
//     + optionally bedrock:InvokeModel* on one direct model (default GPT-6.1 Sol, arm D of the R2E-Gym run;
//     runnerDirectModel=none for DeepSWE) + s3:PutObject on its own results prefix (per instance)
//   results bucket: private, SSE-S3, TLS only, 30-day expiry
import {
  Aws, CfnOutput, type CfnResource, Duration, Fn, RemovalPolicy, Stack, type StackProps, Tags, Validations,
  aws_ec2 as ec2, aws_iam as iam, aws_logs as logs, aws_s3 as s3,
} from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { loadCatalog, type PriceCatalog } from '@auto-router/pricing'
import { invokeStatements, responsesProjectStatement } from './models.ts'
import { AZ_ID_RE, type Ctx, contextReader, DEFAULT_AZ_IDS, resolveCommon, SettingsError } from './settings.ts'

export const DEFAULT_RUNNER_INSTANCE_TYPE = 'm7i.2xlarge'
/** Default root volume (GB); `runnerVolumeGb` overrides it (sizing for DeepSWE via Harbor: infra/README.md). */
export const DEFAULT_RUNNER_VOLUME_GB = 300
export const RUNNER_CIDR = '10.91.0.0/24'
export const RUNNER_TAG_DEFAULTS = { Project: 'llm-auto-router', Purpose: 'experiment-runner' } as const
/**
 * The default model the instance role may invoke directly (arm D of the R2E-Gym run, Responses API); must be in the
 * region catalog. `-c runnerDirectModel=none` grants no Bedrock action at all (DeepSWE via Harbor has no direct arm).
 */
export const RUNNER_DIRECT_MODEL = 'global.openai.gpt-6.1-sol'
/** Host port of the proxy that containers on the bridges may reach (the only host port open to them). */
export const DEFAULT_RUNNER_PROXY_PORT = 8088
/**
 * docker0's address, pinned with `bip` in /etc/docker/daemon.json (Docker's own default). The host-side proxy binds
 * here; it is the only host address the bridges may reach. Containers on any user-defined bridge (Harbor's compose
 * networks) reach it through their own gateway, since it is a host-local address.
 */
export const RUNNER_BRIDGE_IP = '172.17.0.1'
/**
 * Address pool for user-defined networks (Harbor creates a compose network per trial for the agent and another for
 * the verifier, and crashed trials can leak them): 256 /24s instead of Docker's default ~30. Disjoint from the VPC
 * (RUNNER_CIDR) and from docker0 (172.17.0.0/16).
 */
export const RUNNER_DOCKER_POOL = { base: '10.200.0.0/16', size: 24 } as const
/**
 * Upstream DNS server for containers: TEST-NET-1 (RFC 5737), which never answers. Docker's embedded resolver still
 * serves compose service names; external names fail. An explicit non-loopback upstream also means dockerd never
 * forwards container queries from the host namespace (it does that for loopback upstreams such as a stub resolver):
 * the queries leave from the container's namespace and DOCKER-USER drops them. Image pulls use the host's resolver.
 */
export const RUNNER_CONTAINER_DNS = '192.0.2.53'
/**
 * What containers may reach beyond the proxy (`runnerContainerEgress`). `none` (the default; DeepSWE, whose tasks run
 * offline): nothing, on every bridge. `internet` (Terminal-Bench, whose tasks are network_mode public): containers on
 * one fixed network, RUNNER_ONLINE_NETWORK, also reach public IPv4 on TCP 80/443 and the VPC resolver (DNS); every
 * other bridge (docker0, Harbor's compose networks) stays as with `none`. See runnerFirewallScript.
 */
export const RUNNER_CONTAINER_EGRESS = ['none', 'internet'] as const
export type RunnerContainerEgress = typeof RUNNER_CONTAINER_EGRESS[number]
/**
 * The one network with internet egress (`internet` mode), created by the bootstrap (or runnerEgressSwitchScript) on
 * the host: a named Linux bridge (so the firewall can match it before the network exists), no inter-container traffic,
 * Docker's MASQUERADE, IPv4 only, and a subnet outside the VPC, docker0 and RUNNER_DOCKER_POOL. The driver attaches
 * the trial's container to it (compose overlay, `external: true`) and sets its DNS to RUNNER_VPC_RESOLVER.
 */
export const RUNNER_ONLINE_NETWORK = { name: 'llmar-online', bridge: 'br-llmon', subnet: '10.201.0.0/24' } as const
/**
 * DNS for containers on the online network: the Amazon-provided VPC resolver at its fixed link-local address (Nitro).
 * Security groups cannot filter traffic to it (the SG allows only TCP 80/443, so public resolvers are unreachable),
 * and it is not loopback, so dockerd's embedded resolver forwards from the container's namespace (FORWARD), where
 * the firewall admits port 53 to this one address and nothing else in 169.254.0.0/16.
 */
export const RUNNER_VPC_RESOLVER = '169.254.169.253'
/** TCP ports the online network may reach on public IPv4: the security group's egress ports. */
export const RUNNER_EGRESS_TCP_PORTS = [443, 80] as const
/**
 * Destinations a container never reaches: every non-global IPv4 block of the IANA special-purpose registry (this
 * network, private, shared address space, loopback, link-local incl. IMDS, IETF protocol assignments, documentation,
 * 6to4 relay, benchmarking, multicast, reserved and broadcast). Covers the VPC, docker0 and every Docker network.
 */
export const RUNNER_NON_PUBLIC_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
] as const
/** /etc/docker/daemon.json: docker0 pinned, the address pool for every other bridge network, and container DNS. */
export const runnerDaemonJson = () => JSON.stringify({ 'bip': `${RUNNER_BRIDGE_IP}/16`, 'default-address-pools': [RUNNER_DOCKER_POOL], 'dns': [RUNNER_CONTAINER_DNS] })
/**
 * Host tools, pinned with their release checksums (sha256 from the GitHub release assets). The AL2023 docker
 * package ships no compose plugin and a buildx too old for compose v5; both go to /usr/local/lib/docker/cli-plugins,
 * which the docker CLI searches before the package's /usr/libexec/docker/cli-plugins (the rpm's files stay as they are). Harbor is resolved by uv with --exclude-newer, so its
 * dependency set does not drift between deploys.
 */
export const RUNNER_TOOLS = {
  compose: {
    version: 'v5.7.0',
    url: 'https://github.com/docker/compose/releases/download/v5.7.0/docker-compose-linux-x86_64',
    sha256: '7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2',
  },
  // compose v5 `build` needs buildx >= 0.17; AL2023's docker package ships 0.12. Same versions as the Harbor dry run.
  buildx: {
    version: 'v0.38.2',
    url: 'https://github.com/docker/buildx/releases/download/v0.38.2/buildx-v0.38.2.linux-amd64',
    sha256: '7992ec09413b80ff57ba4e081f56fc833d7bac1d5e71143c6c809e7e6065f6d6',
  },
  uv: {
    version: '0.13.6',
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz',
    sha256: 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645',
  },
  harbor: { version: '0.25.0', python: '3.13', excludeNewer: '2026-11-05T00:00:00Z' },
} as const
/**
 * Images needed besides the task images, by digest: Harbor 0.25.0's nftables kernel probe and egress sidecar base
 * (from its docker environment), and the isolation suite's probe image (multi-arch index). Pulled by host dockerd
 * before a run, with each shard's task images (PREPULL_IMAGES).
 */
export const HARBOR_PREPULL_IMAGES = [
  'alpine:3.23.4@sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11',
  'gogost/gost:3.2.7-nightly.20260602@sha256:afc0137758ab4ce399d47a299f9abbacbf522b52a17e59cbb4b4e7a1a66e9196',
  'python:3.13-alpine@sha256:7984cf56ceaddebe4fefeb75d64000b9f45d8b77b11a09b24524da6cdc3af0c8',
] as const
/**
 * The SSM Agent's minimum for Session Manager and Run Command (what AmazonSSMManagedInstanceCore grants for those,
 * without its ssm:GetParameter(s), document, association and other ssm reads on `*`).
 */
export const RUNNER_SSM_ACTIONS = [
  'ssm:UpdateInstanceInformation',
  'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
  'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage', 'ec2messages:GetEndpoint',
  'ec2messages:GetMessages', 'ec2messages:SendReply',
] as const

export interface RunnerSettings {
  region: string
  account: string
  prefix: string
  tags: Record<string, string>
  /** AZ ID of the single public subnet. */
  azId: string
  /** x86_64 instance type (AL2023 x86_64 image). */
  instanceType: string
  /** The one secret the instance may read (full ARN with its 6-character suffix; created outside this stack). */
  secretArn: string
  /** Pinned AMI id; default: the latest AL2023 x86_64 image from its public SSM parameter at deploy time. */
  amiId?: string
  /** Host port of the container-facing proxy (the only host port the container bridges may reach). */
  proxyPort: number
  /** Root volume size (GB, gp3), per runner. */
  volumeGb: number
  /** Swap file size (GB, on the root volume); 0 = no swap. */
  swapGb: number
  /** Number of identical runners (one per task shard), each stoppable on its own. */
  count: number
  /** What containers may reach beyond the proxy: nothing (`none`, default) or public IPv4 on TCP 80/443 (`internet`). */
  containerEgress: RunnerContainerEgress
  /** Model the role may invoke directly (Responses), or absent (`runnerDirectModel=none`): no Bedrock action. */
  directModel?: string
  /** The region's bundled price catalog (only with a direct model): which kind of profile it is, for the IAM pattern. */
  catalog?: PriceCatalog
}

const INSTANCE_TYPE_RE = /^([a-z]+)(\d+)([a-z-]*)\.([a-z0-9]+)$/
/** Graviton families carry a `g` in the attribute letters after the generation (m7g, c7gn, r8gd, t4g), plus a1. */
export const isArmInstanceType = (t: string): boolean => {
  const m = INSTANCE_TYPE_RE.exec(t)
  return !!m && ((m[3] ?? '').includes('g') || (m[1] === 'a' && m[2] === '1'))
}

/**
 * Runner context keys: region and account (required), prefix, tags (see resolveCommon), runnerSecretArn (required),
 * runnerAzId (default: the first AZ ID of the Region's table entry), runnerInstanceType (default m7i.2xlarge, x86_64
 * only), runnerAmiId (optional pin), runnerProxyPort (default 8088), runnerVolumeGb (default 300, 50-4000, per
 * runner), runnerSwapGb (default 0, at most half the volume), runnerCount (default 1, 1-8; above 1 runnerInstanceType is
 * required), runnerDirectModel (default GPT-6.1 Sol; `none` = no Bedrock grant), runnerContainerEgress (none | internet,
 * default none).
 */
export function resolveRunnerSettings(node: Ctx, env: NodeJS.ProcessEnv): RunnerSettings {
  const issues: string[] = []
  const str = contextReader(node)
  const { region, account, prefix, tags } = resolveCommon(str, env, { ...RUNNER_TAG_DEFAULTS }, issues)

  const azId = str('runnerAzId') ?? DEFAULT_AZ_IDS[region]?.[0] ?? ''
  if (!AZ_ID_RE.test(azId)) issues.push(azId ? `runnerAzId: '${azId}' is not an AZ ID (e.g. apse1-az1)` : `runnerAzId: required for ${region || 'the region'} (-c runnerAzId=<az-id>)`)

  const instanceType = str('runnerInstanceType') ?? DEFAULT_RUNNER_INSTANCE_TYPE
  // Several runners are a sized fleet (DeepSWE: 8 vCPU / 64 GB each): never fall back to the default type for one.
  if (str('runnerInstanceType') === undefined && str('runnerCount') !== undefined && str('runnerCount') !== '1') {
    issues.push(`runnerInstanceType: required with runnerCount > 1 (no default for a fleet; e.g. -c runnerInstanceType=r7i.2xlarge)`)
  }
  if (!INSTANCE_TYPE_RE.test(instanceType)) issues.push(`runnerInstanceType: '${instanceType}' is not an instance type (e.g. ${DEFAULT_RUNNER_INSTANCE_TYPE})`)
  else if (isArmInstanceType(instanceType)) issues.push(`runnerInstanceType: '${instanceType}' is Arm (Graviton); the task images are amd64, use an x86_64 type`)

  const secretArn = str('runnerSecretArn') ?? ''
  const arnRe = new RegExp(`^arn:aws[a-z-]*:secretsmanager:${region.replace(/[^a-z0-9-]/g, '')}:${account.replace(/\D/g, '')}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`)
  if (!secretArn) issues.push('runnerSecretArn: required (-c runnerSecretArn=<full ARN of the client secret, created before deploy>)')
  else if (!arnRe.test(secretArn)) issues.push('runnerSecretArn: must be the full Secrets Manager ARN (with its 6-character suffix) in the deploy region and account')

  const amiId = str('runnerAmiId')
  if (amiId && !/^ami-[0-9a-f]{8,17}$/.test(amiId)) issues.push(`runnerAmiId: '${amiId}' is not an AMI id`)

  const proxyRaw = str('runnerProxyPort') ?? String(DEFAULT_RUNNER_PROXY_PORT)
  const proxyPort = Number(proxyRaw)
  if (!/^\d{4,5}$/.test(proxyRaw) || proxyPort < 1024 || proxyPort > 65535) issues.push(`runnerProxyPort: '${proxyRaw}' must be an unprivileged TCP port (1024-65535)`)

  const volRaw = str('runnerVolumeGb') ?? String(DEFAULT_RUNNER_VOLUME_GB)
  const volumeGb = Number(volRaw)
  if (!/^\d{2,4}$/.test(volRaw) || volumeGb < 50 || volumeGb > 4000) issues.push(`runnerVolumeGb: '${volRaw}' must be an integer number of GB (50-4000)`)

  const swapRaw = str('runnerSwapGb') ?? '0'
  const swapGb = Number(swapRaw)
  if (!/^\d{1,3}$/.test(swapRaw) || swapGb > 256) issues.push(`runnerSwapGb: '${swapRaw}' must be an integer number of GB (0-256)`)
  else if (Number.isInteger(volumeGb) && swapGb > volumeGb / 2) issues.push(`runnerSwapGb: ${swapGb} GB is more than half of runnerVolumeGb (${volumeGb})`)

  const countRaw = str('runnerCount') ?? '1'
  const count = Number(countRaw)
  if (!/^[1-8]$/.test(countRaw)) issues.push(`runnerCount: '${countRaw}' must be an integer 1-8`)

  const egressRaw = str('runnerContainerEgress') ?? 'none'
  const containerEgress = RUNNER_CONTAINER_EGRESS.find((m) => m === egressRaw)
  if (!containerEgress) issues.push(`runnerContainerEgress: '${egressRaw}' must be one of ${RUNNER_CONTAINER_EGRESS.join(' | ')}`)

  const directRaw = str('runnerDirectModel') ?? RUNNER_DIRECT_MODEL
  const directModel = directRaw === 'none' ? undefined : directRaw
  let catalog: PriceCatalog | undefined
  if (directModel !== undefined && !/^[a-z0-9][a-z0-9.:-]{2,127}$/.test(directModel)) issues.push(`runnerDirectModel: '${directModel}' is not a model id (or 'none')`)
  else if (directModel !== undefined && !issues.some((x) => x.startsWith('region:'))) {
    try {
      catalog = loadCatalog(region)
      const m = catalog.models.find((x) => x.modelId === directModel)
      if (!m) issues.push(`runnerDirectModel: '${directModel}' is not in the ${region} catalog (or use -c runnerDirectModel=none)`)
      else if (!m.dialects.includes('openai-responses')) issues.push(`runnerDirectModel: '${directModel}' does not support the Responses API in the ${region} catalog`)
    } catch (e) { issues.push(`catalog: ${(e as Error).message} (needed for runnerDirectModel; or use -c runnerDirectModel=none)`) }
  }

  if (issues.length) throw new SettingsError(issues)
  return { region, account, prefix, tags, azId, instanceType, secretArn, ...(amiId ? { amiId } : {}), proxyPort, volumeGb, swapGb, count, containerEgress: containerEgress as RunnerContainerEgress, ...(directModel && catalog ? { directModel, catalog } : {}) }
}

/**
 * Host firewall for the container bridges (docker0 and every user-defined bridge, `br-*`: Harbor's compose networks
 * too), applied by /usr/local/sbin/runner-firewall as an ExecStartPost of docker.service, so it is re-applied on
 * every Docker start. If any rule fails, docker.service fails and no container runs (fail-closed).
 * - Forwarded (DOCKER-USER, before Docker's own rules): everything from a bridge is dropped: no internet, no IMDS, no
 *   VPC hosts, no container-to-container traffic (the script loads br_netfilter and turns on bridge-nf-call-ip(6)tables
 *   itself, so bridged traffic is filtered too, whatever Docker did).
 * - With egress `internet`, ahead of those drops, for the online network's bridge only (RUNNER_ONLINE_NETWORK): from
 *   it (RUNNER-ONLINE-OUT) replies, DNS to the VPC resolver, and new TCP connections to public IPv4 on 80/443
 *   (RUNNER_EGRESS_TCP_PORTS, as the security group; new ones logged to the kernel log, addresses and ports only).
 *   Never another container (same bridge or any other) or a non-public address (RUNNER_NON_PUBLIC_V4: IMDS, the VPC,
 *   other private and link-local ranges): dropped. Other public ports and protocols are rejected (a fast failure, not
 *   a timeout). To it (RUNNER-ONLINE-IN) only replies: no inbound connection, published port or not. Docker's own
 *   MASQUERADE rule for the network does the address translation.
 * - To the host (INPUT): from a bridge, only replies and TCP to the proxy at RUNNER_BRIDGE_IP:proxyPort; everything
 *   else is dropped, including the proxy port on any other host address.
 * - IPv6: everything from a bridge is dropped (INPUT and FORWARD), so link-local IPv6 cannot reach host services and
 *   nothing leaves over IPv6.
 * Harbor's egress sidecar (gost + nftables, NET_ADMIN in the trial's own network namespace) is a second layer
 * inside the trial; these rules bound it from outside, whatever it allows.
 * Image pulls are made by dockerd on the host (OUTPUT), which these rules do not touch. BuildKit RUN steps are not:
 * they run in their own network namespace on docker0, so DOCKER-USER drops their traffic (a RUN that needs the
 * network fails by design). Switching a running runner between the modes: runnerEgressSwitchScript.
 */
export function runnerFirewallScript(proxyPort: number, egress: RunnerContainerEgress = 'none'): string[] {
  const q = (rules: readonly string[]) => rules.map((r) => `"${r}"`).join(' ')
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'ipt=/usr/sbin/iptables',
    'ip6t=/usr/sbin/ip6tables',
    '/usr/sbin/modprobe br_netfilter',
    '/usr/sbin/sysctl -q -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1',
    `for rule in ${q(RUNNER_DOCKER_USER_DROPS)}; do`,
    '  $ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER $rule',
    'done',
    '$ipt -N RUNNER-BRIDGE-IN 2>/dev/null || $ipt -F RUNNER-BRIDGE-IN',
    ...runnerBridgeInRules(proxyPort).map((r) => `$ipt -A RUNNER-BRIDGE-IN ${r}`),
    'for ifc in docker0 br+; do',
    '  $ipt -C INPUT -i $ifc -j RUNNER-BRIDGE-IN 2>/dev/null || $ipt -I INPUT 1 -i $ifc -j RUNNER-BRIDGE-IN',
    '  for chain in INPUT FORWARD; do',
    '    $ip6t -C $chain -i $ifc -j DROP 2>/dev/null || $ip6t -I $chain 1 -i $ifc -j DROP',
    '  done',
    'done',
    ...(egress === 'internet' ? [
      `# Internet egress for ${RUNNER_ONLINE_NETWORK.bridge} only (the ${RUNNER_ONLINE_NETWORK.name} network), ahead of the drops above.`,
      '$ipt -N RUNNER-ONLINE-OUT 2>/dev/null || $ipt -F RUNNER-ONLINE-OUT',
      ...runnerOnlineOutRules().map((r) => `$ipt -A RUNNER-ONLINE-OUT ${r}`),
      '$ipt -N RUNNER-ONLINE-IN 2>/dev/null || $ipt -F RUNNER-ONLINE-IN',
      ...RUNNER_ONLINE_IN_RULES.map((r) => `$ipt -A RUNNER-ONLINE-IN ${r}`),
      `for rule in ${q([...RUNNER_DOCKER_USER_ONLINE].reverse())}; do`,
      '  $ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER 1 $rule',
      'done',
    ] : []),
  ]
}

/** DOCKER-USER drops, in insertion order (each goes to the top): the result is IMDS, br+, docker0. */
export const RUNNER_DOCKER_USER_DROPS = ['-i docker0 -j DROP', '-i br+ -j DROP', '-d 169.254.169.254/32 -j DROP'] as const
/** DOCKER-USER jumps for the online bridge (`internet`), in order, above the drops. */
export const RUNNER_DOCKER_USER_ONLINE = [
  `-i ${RUNNER_ONLINE_NETWORK.bridge} -j RUNNER-ONLINE-OUT`, `-o ${RUNNER_ONLINE_NETWORK.bridge} -j RUNNER-ONLINE-IN`,
] as const
/** RUNNER-ONLINE-IN (to the online bridge): replies only. */
export const RUNNER_ONLINE_IN_RULES = ['-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT', '-j DROP'] as const
/** RUNNER-BRIDGE-IN (from any bridge to the host). */
export const runnerBridgeInRules = (proxyPort: number) => [
  '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  `-p tcp -d ${RUNNER_BRIDGE_IP}/32 --dport ${proxyPort} -j ACCEPT`,
  '-j DROP',
]
/** Kernel-log prefix of new outbound TCP connections from the online network (journalctl -k --grep). */
export const RUNNER_ONLINE_LOG_PREFIX = 'llmar-online: '
/** RUNNER-ONLINE-OUT (from the online bridge), in order. */
export const runnerOnlineOutRules = () => [
  '-m conntrack --ctstate INVALID -j DROP',
  '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  '-o docker0 -j DROP',
  '-o br+ -j DROP',
  `-d ${RUNNER_VPC_RESOLVER}/32 -p udp --dport 53 -j ACCEPT`,
  `-d ${RUNNER_VPC_RESOLVER}/32 -p tcp --dport 53 -j ACCEPT`,
  ...RUNNER_NON_PUBLIC_V4.map((c) => `-d ${c} -j DROP`),
  `-p tcp -j LOG --log-prefix "${RUNNER_ONLINE_LOG_PREFIX}" --log-level 6`,
  `-p tcp -m multiport --dports ${RUNNER_EGRESS_TCP_PORTS.join(',')} -j ACCEPT`,
  '-p tcp -j REJECT --reject-with tcp-reset',
  '-j REJECT --reject-with icmp-admin-prohibited',
]
/** Creates the online network if it is missing (host-side; idempotent). */
export const runnerOnlineNetworkCreate = () => {
  const n = RUNNER_ONLINE_NETWORK
  return `docker network inspect ${n.name} >/dev/null 2>&1 || docker network create --driver bridge --subnet ${n.subnet} `
    + `-o com.docker.network.bridge.name=${n.bridge} -o com.docker.network.bridge.enable_icc=false `
    + `-o com.docker.network.bridge.enable_ip_masquerade=true ${n.name}`
}
/** Checks that the online network has exactly the expected shape (fails otherwise). */
export const runnerOnlineNetworkCheck = () => {
  const n = RUNNER_ONLINE_NETWORK
  const fmt = `{{.Driver}} {{index .Options "com.docker.network.bridge.name"}} {{index .Options "com.docker.network.bridge.enable_icc"}} `
    + '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}} {{.Internal}} {{.EnableIPv6}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'
  return `test "$(docker network inspect ${n.name} --format '${fmt}')" = 'bridge ${n.bridge} false true false false ${n.subnet} '`
}

/**
 * Kernel console log level with internet egress: 4 (warnings and worse), so the connection log (LOG, level 6) goes to
 * the journal only and never to the serial console (AL2023 on EC2 boots with console level 8). Persisted as a sysctl.d
 * drop-in; the value before the switch is kept and restored by `none`. Nothing else here depends on it.
 */
export const RUNNER_CONSOLE_PRINTK = '4 4 1 7'
export const RUNNER_PRINTK_DROPIN = '/etc/sysctl.d/90-runner-console.conf'
export const RUNNER_PRINTK_BEFORE = '/var/lib/llmar-runner/printk.before'
const printkVars = ['printk=/proc/sys/kernel/printk', `printk_dropin=${RUNNER_PRINTK_DROPIN}`, `printk_before=${RUNNER_PRINTK_BEFORE}`]
/** Sets the quiet console level (internet), keeping the previous value once; idempotent. Needs printkVars. */
export const runnerConsoleQuiet = () => [
  '# Console log level 4: the connection log (level 6) goes to the journal only, not to the serial console.',
  'install -d -m 0700 "$(dirname "$printk_before")"',
  'test -e "$printk_before" || cat "$printk" > "$printk_before"',
  `echo 'kernel.printk = ${RUNNER_CONSOLE_PRINTK}' > "$printk_dropin"`,
  `echo '${RUNNER_CONSOLE_PRINTK}' > "$printk"`,
]
/** Restores the console level from before the switch (none); idempotent. Needs printkVars. */
const runnerConsoleRestore = () => [
  '# The console log level from before internet egress, and no drop-in.',
  'rm -f "$printk_dropin"',
  'if [ -e "$printk_before" ]; then cat "$printk_before" > "$printk"; rm -f "$printk_before"; fi',
]

/**
 * Run Command script that switches a running runner's container egress to `egress` (idempotent, as root, only while
 * no container runs; dockerd keeps running). It installs what a fresh deploy with that mode has: the firewall script
 * (backed up first under /var/lib/llmar-runner/egress-backup/, with the env file) and the env file's egress keys,
 * applies the firewall, creates the online network for `internet`, removes the online chains for `none`, and checks
 * every rule. daemon.json is not touched (container DNS for the online network is per container). For `none` the
 * online network stays (empty, and with no egress: it is a `br+` bridge again). The proxy port must match the env file.
 */
export function runnerEgressSwitchScript(egress: RunnerContainerEgress, proxyPort: number): string[] {
  const n = RUNNER_ONLINE_NETWORK
  const q = (rules: readonly string[]) => rules.map((r) => `"${r}"`).join(' ')
  const count = (chain: string, k: number) => `test "$($ipt -S ${chain} | grep -c '^-A')" = ${k} || fail "${chain} has other rules"`
  return [
    '#!/bin/bash',
    `# Sets this llmar runner's container egress to '${egress}'. Generated from infra/src/runner.ts (runnerEgressSwitchScript);`,
    '# regenerate, do not edit. Idempotent. Run as root (SSM Run Command) only while no container runs.',
    'set -euo pipefail',
    'umask 022',
    `env_file=${RUNNER_ENV_FILE}`,
    'fw=/usr/local/sbin/runner-firewall',
    'dropin=/etc/systemd/system/docker.service.d/10-runner-firewall.conf',
    'backup_root=/var/lib/llmar-runner/egress-backup',
    'ipt=/usr/sbin/iptables',
    ...printkVars,
    'fail() { echo "runner-egress: $*" >&2; exit 1; }',
    'absent() { if "$@" >/dev/null 2>&1; then fail "unexpected: $*"; fi; }',
    'test "$(id -u)" = 0 || fail "run as root"',
    'test -f "$env_file" && test -x "$fw" || fail "not a runner (env file or firewall missing)"',
    'grep -qx "ExecStartPost=$fw" "$dropin" || fail "the docker.service firewall drop-in is missing"',
    `grep -qx 'PROXY_PORT=${proxyPort}' "$env_file" || fail "PROXY_PORT in $env_file is not ${proxyPort}; regenerate for this runner"`,
    'systemctl is-active --quiet docker || fail "docker is not active"',
    'test -z "$(docker ps -q)" || fail "containers are running: finish or stop the run first"',
    'install -d -m 0700 "$backup_root"',
    'backup="$(mktemp -d "$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-XXXX")"',
    'cp -p "$fw" "$env_file" "$backup/"',
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `cat > "$tmp/runner-firewall" <<'EOF'`,
    ...runnerFirewallScript(proxyPort, egress),
    'EOF',
    'bash -n "$tmp/runner-firewall"',
    'install -m 0755 "$tmp/runner-firewall" "$fw"',
    ...(egress === 'internet' ? runnerConsoleQuiet() : []),
    '"$fw"',
    ...(egress === 'internet' ? [runnerOnlineNetworkCreate(), runnerOnlineNetworkCheck()] : [
      '# Online leftovers: the jumps, then the chains (the drops above them are in place).',
      `for rule in ${q(RUNNER_DOCKER_USER_ONLINE)}; do`,
      '  while $ipt -C DOCKER-USER $rule 2>/dev/null; do $ipt -D DOCKER-USER $rule; done',
      'done',
      'for chain in RUNNER-ONLINE-OUT RUNNER-ONLINE-IN; do',
      '  if $ipt -n -L $chain >/dev/null 2>&1; then $ipt -F $chain; $ipt -X $chain; fi',
      'done',
      ...runnerConsoleRestore(),
    ]),
    `sed -i '/^CONTAINER_EGRESS=/d; /^ONLINE_NETWORK=/d; /^ONLINE_DNS=/d' "$env_file"`,
    ...runnerEgressEnv(egress).map((l) => `echo '${l}' >> "$env_file"`),
    '# Check: every rule of this mode is in place, nothing else.',
    ...RUNNER_DOCKER_USER_DROPS.map((r) => `$ipt -C DOCKER-USER ${r}`),
    ...(egress === 'internet' ? [
      ...RUNNER_DOCKER_USER_ONLINE.map((r) => `$ipt -C DOCKER-USER ${r}`),
      `test "$($ipt -S DOCKER-USER | sed -n 2,3p)" = "$(printf -- '-A DOCKER-USER %s\\n' ${q(RUNNER_DOCKER_USER_ONLINE)})" || fail "the online jumps are not first in DOCKER-USER"`,
      ...runnerOnlineOutRules().map((r) => `$ipt -C RUNNER-ONLINE-OUT ${r}`),
      count('RUNNER-ONLINE-OUT', runnerOnlineOutRules().length),
      ...RUNNER_ONLINE_IN_RULES.map((r) => `$ipt -C RUNNER-ONLINE-IN ${r}`),
      count('RUNNER-ONLINE-IN', RUNNER_ONLINE_IN_RULES.length),
      `$ipt -t nat -C POSTROUTING -s ${n.subnet} ! -o ${n.bridge} -j MASQUERADE  # Docker's NAT for the online network`,
    ] : [
      ...RUNNER_DOCKER_USER_ONLINE.map((r) => `absent $ipt -C DOCKER-USER ${r}`),
      'absent $ipt -n -L RUNNER-ONLINE-OUT',
      'absent $ipt -n -L RUNNER-ONLINE-IN',
    ]),
    ...runnerBridgeInRules(proxyPort).map((r) => `$ipt -C RUNNER-BRIDGE-IN ${r}`),
    count('RUNNER-BRIDGE-IN', runnerBridgeInRules(proxyPort).length),
    ...(egress === 'internet' ? [
      'read -r console_level _ < "$printk"',
      'test "$console_level" -le 6 || fail "kernel console log level is $console_level (the connection log would reach the serial console)"',
      `grep -qx 'kernel.printk = ${RUNNER_CONSOLE_PRINTK}' "$printk_dropin" || fail "console level drop-in missing"`,
      'test -s "$printk_before" || fail "previous console level not kept"',
    ] : ['absent test -e "$printk_dropin"', 'absent test -e "$printk_before"']),
    'cmp -s "$tmp/runner-firewall" "$fw" || fail "the firewall script changed underneath"',
    ...(egress === 'internet' ? runnerEgressEnv(egress).map((l) => `grep -qx '${l}' "$env_file" || fail "env file not updated"`)
      : [`absent grep -qE '^(CONTAINER_EGRESS|ONLINE_NETWORK|ONLINE_DNS)=' "$env_file"`]),
    `echo "runner-egress: ${egress}; previous files in $backup"`,
  ]
}

/**
 * Env-file keys for the driver with internet egress: the mode, the online network and its DNS server. With `none`
 * there are none (absent CONTAINER_EGRESS means none), so a `none` deploy has the same user data as before the mode.
 */
export const runnerEgressEnv = (egress: RunnerContainerEgress) => egress === 'internet'
  ? [`CONTAINER_EGRESS=${egress}`, `ONLINE_NETWORK=${RUNNER_ONLINE_NETWORK.name}`, `ONLINE_DNS=${RUNNER_VPC_RESOLVER}`]
  : []

/** Download a pinned release asset and check its sha256 before anything uses it. */
const fetchChecked = (url: string, sha256: string, to: string) => [
  `curl -fsSL --retry 3 -o ${to} '${url}'`,
  `echo '${sha256}  ${to}' | sha256sum -c -`,
]

/** The bootstrap contract for the orchestration driver on every runner (see infra/README.md). */
export const RUNNER_ENV_FILE = '/etc/llmar-runner.env'
/** Results bucket: objects expire after this many days; runner `i` may only PutObject under `runs/<i>/`. */
export const RUNNER_RESULTS_EXPIRY_DAYS = 30
export const runnerResultsPrefix = (index: number) => `runs/${index}/`
export const RUNNER_WORK_DIR = '/srv/runner'

/**
 * /usr/local/bin/runner-metrics: one JSON line of cumulative host counters (load, /proc/stat CPU jiffies incl. steal,
 * memory and swap, swap-in/out pages, PSI some/full totals for cpu, memory and io, the kernel's oom_kill counter, and
 * Docker's free disk). The driver reads it before and after each trial (and periodically) and diffs. Per-container
 * OOM comes from the container state (docker inspect) before teardown, not from here. System python3 (AL2023), standard library only, no network.
 */
export function runnerMetricsScript(): string[] {
  return [
    '#!/usr/bin/python3 -I',
    '# Cumulative host counters for the experiment driver, as one JSON line. Diff two readings per trial.',
    'import json, os, time',
    '',
    '',
    'def counters(path):',
    '    out = {}',
    '    try:',
    '        with open(path) as f:',
    '            for line in f:',
    "                parts = line.replace(':', ' ').split()",
    '                if len(parts) >= 2 and parts[1].isdigit():',
    '                    out[parts[0]] = int(parts[1])',
    '    except OSError:',
    '        pass',
    '    return out',
    '',
    '',
    "with open('/proc/stat') as f:",
    '    cpu = f.readline().split()',
    "names = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal']",
    "with open('/proc/loadavg') as f:",
    '    load = [float(x) for x in f.read().split()[:3]]',
    "mem = counters('/proc/meminfo')",
    'try:',
    "    st = os.statvfs('/var/lib/docker')",
    '    docker_free = st.f_bavail * st.f_frsize',
    'except OSError:',
    '    docker_free = None',
    "vm = counters('/proc/vmstat')",
    'psi = {}',
    "for res in ('cpu', 'memory', 'io'):",
    '    try:',
    "        with open('/proc/pressure/' + res) as f:",
    "            psi[res] = {line.split()[0] + '_total_us': int(line.rsplit('total=', 1)[1]) for line in f if 'total=' in line}",
    '    except (OSError, ValueError, IndexError):',
    '        psi[res] = None',
    'print(json.dumps({',
    "    'ts': round(time.time(), 3), 'load': load, 'ncpu': os.cpu_count(),",
    "    'cpu_jiffies': dict(zip(names, (int(x) for x in cpu[1:9]))),",
    "    'mem_available_kb': mem.get('MemAvailable'), 'swap_total_kb': mem.get('SwapTotal'), 'swap_free_kb': mem.get('SwapFree'),",
    "    'oom_kill': vm.get('oom_kill'), 'pswpin': vm.get('pswpin'), 'pswpout': vm.get('pswpout'),",
    "    'psi': psi, 'docker_free_bytes': docker_free,",
    '}, sort_keys=True))',
  ]
}

export interface RunnerHost { proxyPort: number; swapGb: number; index: number; count: number; containerEgress?: RunnerContainerEgress }

/**
 * User data for runner `index` of `count`: Docker (with buildx, from AL2023) plus the compose plugin, uv and Harbor at
 * pinned versions, git, an optional swap file, the docker0 address, the bridge firewall as a docker.service
 * ExecStartPost (and with internet egress the online network), runner-metrics, and the driver contract
 * (RUNNER_ENV_FILE, RUNNER_WORK_DIR). Only the env file
 * differs between runners. The SSM Agent ships with AL2023. Everything here runs on the host; nothing is fetched
 * from inside a container.
 */
export function runnerUserData(h: RunnerHost): string[] {
  const { compose, buildx, uv, harbor } = RUNNER_TOOLS
  const egress = h.containerEgress ?? 'none'
  return [
    'set -euo pipefail',
    'dnf install -y docker git tar gzip',
    'test -x /usr/sbin/iptables  # Docker depends on it; fail before writing the firewall if it is missing',
    'test -x /usr/sbin/ip6tables',
    `# docker compose ${compose.version} and buildx ${buildx.version} (CLI plugins, searched before the package's)`,
    'install -d -m 0755 /usr/local/lib/docker/cli-plugins',
    ...fetchChecked(compose.url, compose.sha256, '/tmp/docker-compose'),
    'install -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose',
    ...fetchChecked(buildx.url, buildx.sha256, '/tmp/docker-buildx'),
    'install -m 0755 /tmp/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx',
    `# uv ${uv.version}`,
    ...fetchChecked(uv.url, uv.sha256, '/tmp/uv.tar.gz'),
    'tar -xzf /tmp/uv.tar.gz -C /tmp',
    'install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/',
    `# Harbor ${harbor.version} as a uv tool (Python ${harbor.python} managed by uv), on PATH as /usr/local/bin/harbor`,
    'export HOME="${HOME:-/root}" UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_CACHE_DIR=/var/cache/uv',
    `/usr/local/bin/uv tool install --managed-python --python ${harbor.python} --exclude-newer ${harbor.excludeNewer} harbor==${harbor.version}`,
    'test -x /usr/local/bin/harbor',
    `DRIVER_PYTHON="$(/usr/local/bin/uv python find --managed-python --no-project ${harbor.python})"  # the same uv-managed Python, for the driver`,
    'test -x "$DRIVER_PYTHON"',
    'rm -rf /tmp/docker-compose /tmp/docker-buildx /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu',
    '# No sshd: the only way in is SSM (no key pair, no inbound rules); nothing listens on 22, not even for the bridges.',
    'systemctl disable --now sshd.service sshd.socket 2>/dev/null || true',
    "test -z \"$(ss -Htln 'sport = :22')\"",
    ...(h.swapGb > 0 ? [
      `# ${h.swapGb} GB swap: trials (2 CPU / 8 GB each) plus their verifiers can exceed RAM briefly`,
      `fallocate -l ${h.swapGb}G /swapfile`,
      'chmod 0600 /swapfile',
      'mkswap /swapfile',
      'swapon /swapfile',
      "echo '/swapfile none swap defaults 0 0' >> /etc/fstab",
      "echo 'vm.swappiness = 10' > /etc/sysctl.d/90-runner-swap.conf",
      'sysctl -q -p /etc/sysctl.d/90-runner-swap.conf',
    ] : []),
    "cat > /usr/local/bin/runner-metrics <<'EOF'",
    ...runnerMetricsScript(),
    'EOF',
    'chmod 0700 /usr/local/bin/runner-metrics',
    `install -d -m 0700 ${RUNNER_WORK_DIR}`,
    `cat > ${RUNNER_ENV_FILE} <<'EOF'`,
    `RUNNER_INDEX=${h.index}`,
    `RUNNER_COUNT=${h.count}`,
    `PROXY_ADDR=${RUNNER_BRIDGE_IP}`,
    `PROXY_PORT=${h.proxyPort}`,
    `HARBOR_VERSION=${harbor.version}`,
    `WORK_DIR=${RUNNER_WORK_DIR}`,
    `RESULTS_PREFIX=${runnerResultsPrefix(h.index)}`,
    'UV_PYTHON_INSTALL_DIR=/opt/uv/python',
    'UV_TOOL_DIR=/opt/uv/tools',
    `PREPULL_IMAGES="${HARBOR_PREPULL_IMAGES.join(' ')}"`,
    ...runnerEgressEnv(egress),
    'EOF',
    `echo "DRIVER_PYTHON=$DRIVER_PYTHON" >> ${RUNNER_ENV_FILE}`,
    'mkdir -p /etc/docker',
    'test ! -e /etc/docker/daemon.json  # a fresh AL2023 instance has none; never overwrite one',
    "cat > /etc/docker/daemon.json <<'EOF'",
    runnerDaemonJson(),
    'EOF',
    "cat > /usr/local/sbin/runner-firewall <<'EOF'",
    ...runnerFirewallScript(h.proxyPort, egress),
    'EOF',
    'chmod 0755 /usr/local/sbin/runner-firewall',
    ...(egress === 'internet' ? [...printkVars, ...runnerConsoleQuiet()] : []),
    'mkdir -p /etc/systemd/system/docker.service.d',
    "cat > /etc/systemd/system/docker.service.d/10-runner-firewall.conf <<'EOF'",
    '[Service]',
    'ExecStartPost=/usr/local/sbin/runner-firewall',
    'EOF',
    'systemctl daemon-reload',
    'systemctl enable --now docker',
    ...(egress === 'internet' ? [runnerOnlineNetworkCreate(), runnerOnlineNetworkCheck()] : []),
    `docker compose version | grep -qF '${compose.version}'`,
    `docker buildx version | grep -qF '${buildx.version}'`,
  ]
}

export interface RunnerStackProps extends StackProps { settings: RunnerSettings }

export class RunnerStack extends Stack {
  /** One subnet placed by AZ ID; the AZ-name placeholder keeps synth offline (no context lookup). */
  override get availabilityZones(): string[] {
    return [Fn.select(0, Fn.getAzs())]
  }

  constructor(scope: Construct, id: string, props: RunnerStackProps) {
    super(scope, id, props)
    const cfg = props.settings
    const n = (x: string) => `${cfg.prefix}-runner${x ? `-${x}` : ''}`

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: n('vpc'), ipAddresses: ec2.IpAddresses.cidr(RUNNER_CIDR), maxAzs: 1, natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26, mapPublicIpOnLaunch: false }],
      restrictDefaultSecurityGroup: true,
    })
    for (const subnet of vpc.publicSubnets) {
      const cfn = subnet.node.defaultChild as ec2.CfnSubnet
      cfn.addPropertyDeletionOverride('AvailabilityZone')
      cfn.addPropertyOverride('AvailabilityZoneId', cfg.azId)
    }
    // The default-SG restriction is a CDK custom-resource provider (raw CfnResources the Tags aspect skips): tag it.
    const crp = this.node.tryFindChild('Custom::VpcRestrictDefaultSGCustomResourceProvider')
    for (const cid of ['Role', 'Handler']) {
      (crp?.node.tryFindChild(cid) as CfnResource | undefined)?.addPropertyOverride('Tags', Object.entries(cfg.tags).map(([Key, Value]) => ({ Key, Value })))
    }
    const flowLogs = new logs.LogGroup(this, 'FlowLogs', { logGroupName: `/${cfg.prefix}/runner-vpc-flow`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })
    vpc.addFlowLog('Flow', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs), trafficType: ec2.FlowLogTrafficType.ALL })

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc, securityGroupName: n(''), allowAllOutbound: false,
      description: 'experiment runner: no inbound rules (SSM only); egress 443 and 80',
    })
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS: image registries, git, Cognito, the gateway, SSM')
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP: package mirrors that redirect or serve over http')

    // Direct model (arm D of the R2E-Gym run; none for DeepSWE): the documented global cross-Region inference pattern
    // (as for the router task role), that model only, plus the Responses API's default-project authorization limited
    // by bedrock:ModelArn to it. With runnerDirectModel=none the role has no Bedrock action at all.
    const direct = cfg.directModel && cfg.catalog ? { model: cfg.directModel, catalog: cfg.catalog } : undefined
    const invoke = direct ? invokeStatements([direct.model], direct.catalog, cfg.region, Aws.ACCOUNT_ID).map((st) => new iam.PolicyStatement({
      sid: `Direct${st.sid}`, actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: st.resources, ...(st.conditions ? { conditions: st.conditions } : {}),
    })) : []
    const project = direct ? responsesProjectStatement([direct.model], cfg.region, Aws.ACCOUNT_ID) : undefined
    if (project) invoke.push(new iam.PolicyStatement({ sid: `Direct${project.sid}`, actions: ['bedrock:InvokeModel'], resources: project.resources, conditions: project.conditions }))
    const role = new iam.Role(this, 'Role', {
      roleName: n('role'), assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `experiment runner: SSM sessions and Run Command, read of one secret${direct ? `, direct Responses calls on ${direct.model}` : ''}, results upload`,
      inlinePolicies: {
        SsmAgent: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ sid: 'SsmAgent', actions: [...RUNNER_SSM_ACTIONS], resources: ['*'] }),
        ] }),
        ReadClientSecret: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ sid: 'ReadClientSecret', actions: ['secretsmanager:GetSecretValue'], resources: [cfg.secretArn] }),
        ] }),
        ...(invoke.length ? { InvokeDirectModel: new iam.PolicyDocument({ statements: invoke }) } : {}),
      },
    })

    // N identical runners (one per task shard): same type, AMI parameter, role and bootstrap; only the env file's
    // RUNNER_INDEX differs. Each one is stopped on its own (ec2 stop-instances) when its shard is done.
    const machineImage = cfg.amiId
      ? ec2.MachineImage.genericLinux({ [cfg.region]: cfg.amiId })
      : ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 })
    const instances = Array.from({ length: cfg.count }, (_, index) => {
      const userData = ec2.UserData.forLinux()
      userData.addCommands(...runnerUserData({ proxyPort: cfg.proxyPort, swapGb: cfg.swapGb, index, count: cfg.count, containerEgress: cfg.containerEgress }))
      const instance = new ec2.Instance(this, `Instance${index}`, {
        instanceName: n(String(index)), vpc, vpcSubnets: { subnets: vpc.publicSubnets }, securityGroup: sg, role,
        instanceType: new ec2.InstanceType(cfg.instanceType), machineImage,
        userData, associatePublicIpAddress: true, ssmSessionPermissions: false,
        httpEndpoint: true, httpTokens: ec2.HttpTokens.REQUIRED, httpPutResponseHopLimit: 1, httpProtocolIpv6: false, instanceMetadataTags: false,
        blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(cfg.volumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }) }],
        propagateTagsToVolumeOnCreation: true, detailedMonitoring: false, disableApiTermination: false,
      })
      Tags.of(instance).add('RunnerIndex', String(index))
      return instance
    })

    // Private results bucket for the full trial dirs (17's fetch). Runner i may only PutObject under runs/<i>/: one
    // statement per runner, tied to that instance with the global key ec2:SourceInstanceARN (present on every
    // request signed with instance-profile credentials). No reads, lists or deletes for any runner. It is a separate
    // policy on the shared role, because it names the instances (inline on the role would be a cycle). Not
    // versioned, and no autoDeleteObjects Lambda: empty it before destroy (README).
    const results = new s3.Bucket(this, 'Results', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, versioned: false, removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ id: 'expire', expiration: Duration.days(RUNNER_RESULTS_EXPIRY_DAYS), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    })
    const put = new iam.Policy(this, 'ResultsPut', {
      policyName: 'PutRunResults', roles: [role],
      statements: instances.map((instance, index) => new iam.PolicyStatement({
        sid: `PutRunResults${index}`, actions: ['s3:PutObject'], resources: [results.arnForObjects(`${runnerResultsPrefix(index)}*`)],
        conditions: { ArnEquals: { 'ec2:SourceInstanceARN': this.formatArn({ service: 'ec2', account: Aws.ACCOUNT_ID, resource: 'instance', resourceName: instance.instanceId }) } },
      })),
    })
    new CfnOutput(this, 'ResultsBucketName', { value: results.bucketName, description: 'private results bucket; runner i writes runs/<i>/ only' })

    new CfnOutput(this, 'InstanceIds', { value: Fn.join(',', instances.map((i) => i.instanceId)), description: 'runner instance ids, ordered by RunnerIndex' })

    const ack = (c: Construct, aid: string, reason: string) => Validations.of(c).acknowledge({ id: aid, reason })
    ack(results, 'AwsSolutions-S1', 'Short-lived results bucket for one experiment: writes come only from the runners (per-instance PutObject) '
      + 'and are in the runners\' trial logs; server access logs would need a second bucket to empty and destroy.')
    const bucketId = this.getLogicalId(results.node.defaultChild as s3.CfnBucket)
    for (const index of instances.keys()) {
      ack(put, `AwsSolutions-IAM5[Resource::<${bucketId}.Arn>/${runnerResultsPrefix(index)}*]`, 'Object keys under the runner\'s own prefix only (runs/<i>/), for that instance only (ec2:SourceInstanceARN); PutObject only.')
    }
    ack(role, 'AwsSolutions-IAM5[Resource::*]',
      'SSM Agent channel actions (ssmmessages, ec2messages) have no resource-level permissions; ssm:UpdateInstanceInformation on its own instance '
      + 'would need the instance ARN, a cycle. The only way in (no inbound rules, no key pair); no ssm parameter or document reads.')
    if (project) {
      ack(role, `AwsSolutions-IAM5[Resource::arn:aws:bedrock:${cfg.region}:<AWS::AccountId>:project/*]`,
        'Responses on bedrock-runtime authorizes InvokeModel on the default project (Bedrock User Guide, Responses API > Permissions); '
        + 'the project id is not known at synth, and bedrock:ModelArn limits the grant to the one direct model.')
    }
    for (const instance of instances) {
      ack(instance, 'AwsSolutions-EC28', 'Short-lived experiment runner: basic monitoring is enough; the driver records per-trial host metrics.')
      ack(instance, 'AwsSolutions-EC29', 'Short-lived experiment runner destroyed with its stack after the run; termination protection would block cdk destroy.')
    }
  }
}
