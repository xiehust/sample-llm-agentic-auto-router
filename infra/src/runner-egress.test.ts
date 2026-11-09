// Container egress modes of the runner (runnerContainerEgress): `none` (DeepSWE) must stay exactly as deployed;
// `internet` (Terminal-Bench) opens public TCP 80/443 and the VPC resolver for the online bridge only.
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  resolveRunnerSettings, RUNNER_BRIDGE_IP, RUNNER_CIDR, RUNNER_DOCKER_POOL, RUNNER_DOCKER_USER_ONLINE, RUNNER_EGRESS_TCP_PORTS,
  RUNNER_NON_PUBLIC_V4, RUNNER_ONLINE_NETWORK, RUNNER_VPC_RESOLVER, runnerDaemonJson, runnerEgressSwitchScript, runnerFirewallScript,
  RUNNER_CONSOLE_PRINTK, runnerConsoleQuiet, runnerEgressEnv, RUNNER_PRINTK_BEFORE, RUNNER_PRINTK_DROPIN, runnerOnlineNetworkCheck, runnerOnlineNetworkCreate, runnerOnlineOutRules, runnerUserData, RunnerStack, type RunnerSettings,
} from './runner.ts'
import { runnerSsmFiles } from './runner-ssm.ts'

const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const SECRET = 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:llmar-runner/client-AbC123'
const BASE = { region: 'ap-southeast-1', account: '000000000000', runnerSecretArn: SECRET }
const FLEET = { ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge', runnerVolumeGb: '250', runnerSwapGb: '32', runnerDirectModel: 'none' }
type Res = { Type: string; Properties?: Record<string, any> }
const synth = (s: RunnerSettings) => {
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'llmar-runner-egress-')) })
  const stack = new RunnerStack(app, 'llmar-runner', { env: { account: s.account, region: s.region }, settings: s })
  return Template.fromStack(stack).toJSON() as { Resources: Record<string, Res> }
}
const userData = (t: { Resources: Record<string, Res> }) => Object.values(t.Resources).filter((r) => r.Type === 'AWS::EC2::Instance')
  .map((r) => r.Properties?.UserData['Fn::Base64'] as string)
const v4 = (cidr: string) => { const [ip, len] = cidr.split('/'); const n = (ip as string).split('.').reduce((a, o) => a * 256 + Number(o), 0); const l = Number(len ?? 32); return [n - (n % 2 ** (32 - l)), 2 ** (32 - l)] as const }
const inside = (a: string, b: string) => { const [x, xs] = v4(a); const [y, ys] = v4(b); return x >= y && x + xs <= y + ys }
const overlap = (a: string, b: string) => { const [x, xs] = v4(a); const [y, ys] = v4(b); return x < y + ys && y < x + xs }
const HARNESS = new URL('../test/runner-netns/', import.meta.url).pathname
// Unprivileged user+network namespaces with br_netfilter loaded (the packet and switch dry runs need both).
const NETNS = spawnSync('unshare', ['-rn', 'sh', '-c', 'test "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)" = 1 && /usr/sbin/iptables -S >/dev/null']).status === 0
/**
 * Runs a harness script as pid 1 of a fresh pid namespace (plus user, net and mount namespaces, /proc remounted so its
 * nsenter -t <pid> sees its own pids). When the script exits or is killed, the kernel kills every process left in the
 * namespace (listeners, sleepers); --kill-child kills the script if unshare itself dies (spawnSync's timeout below).
 */
const inNamespaces = (script: string, arg: string, timeoutMs: number) => spawnSync('unshare',
  ['-rn', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL', 'bash', join(HARNESS, script), arg],
  { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' })
/** Harness processes of this worktree still alive (the absolute harness path is in their command lines). */
const harnessLeft = (): string[] => {
  const r = spawnSync('pgrep', ['-af', HARNESS], { encoding: 'utf8' })
  return r.stdout.split('\n').filter((l) => l.trim() !== '')
}

// The deployed DeepSWE firewall (commit d3e56dc), frozen: `none` must keep producing exactly this.
const DEPLOYED_FIREWALL = [
  '#!/bin/bash',
  'set -euo pipefail',
  'ipt=/usr/sbin/iptables',
  'ip6t=/usr/sbin/ip6tables',
  '/usr/sbin/modprobe br_netfilter',
  '/usr/sbin/sysctl -q -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1',
  'for rule in "-i docker0 -j DROP" "-i br+ -j DROP" "-d 169.254.169.254/32 -j DROP"; do',
  '  $ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER $rule',
  'done',
  '$ipt -N RUNNER-BRIDGE-IN 2>/dev/null || $ipt -F RUNNER-BRIDGE-IN',
  '$ipt -A RUNNER-BRIDGE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  '$ipt -A RUNNER-BRIDGE-IN -p tcp -d 172.17.0.1/32 --dport 8088 -j ACCEPT',
  '$ipt -A RUNNER-BRIDGE-IN -j DROP',
  'for ifc in docker0 br+; do',
  '  $ipt -C INPUT -i $ifc -j RUNNER-BRIDGE-IN 2>/dev/null || $ipt -I INPUT 1 -i $ifc -j RUNNER-BRIDGE-IN',
  '  for chain in INPUT FORWARD; do',
  '    $ip6t -C $chain -i $ifc -j DROP 2>/dev/null || $ip6t -I $chain 1 -i $ifc -j DROP',
  '  done',
  'done',
]

describe('runner container egress', () => {
  it('none is the default and unchanged: the deployed firewall, daemon.json and user data, no online network', () => {
    const s = resolveRunnerSettings(ctx(FLEET), {})
    expect(s.containerEgress).toBe('none')
    expect(runnerFirewallScript(8088)).toEqual(DEPLOYED_FIREWALL)
    expect(runnerFirewallScript(8088, 'none')).toEqual(DEPLOYED_FIREWALL)
    expect(JSON.parse(runnerDaemonJson())).toEqual({ 'bip': '172.17.0.1/16', 'default-address-pools': [{ base: '10.200.0.0/16', size: 24 }], 'dns': ['192.0.2.53'] })
    for (const ud of userData(synth(s))) {
      expect(ud).toContain(DEPLOYED_FIREWALL.join('\n'))
      expect(ud).not.toMatch(/CONTAINER_EGRESS|ONLINE_|llmar-online|br-llmon|RUNNER-ONLINE|169\.254\.169\.253|docker network/)
    }
    expect(runnerUserData({ proxyPort: 8088, swapGb: 32, index: 1, count: 4 })).toEqual(runnerUserData({ proxyPort: 8088, swapGb: 32, index: 1, count: 4, containerEgress: 'none' }))
  })

  it('settings: runnerContainerEgress is none | internet', () => {
    expect(resolveRunnerSettings(ctx({ ...FLEET, runnerContainerEgress: 'internet' }), {}).containerEgress).toBe('internet')
    expect(resolveRunnerSettings(ctx({ ...FLEET, runnerContainerEgress: 'none' }), {}).containerEgress).toBe('none')
    for (const bad of ['public', 'Internet', 'all', 'true']) {
      expect(() => resolveRunnerSettings(ctx({ ...FLEET, runnerContainerEgress: bad }), {}), bad).toThrow(/runnerContainerEgress: '.*' must be one of none \| internet/)
    }
  })

  it('internet: the online network is disjoint from the VPC, docker0 and the pool; every non-public range is covered; the ports are the SG\'s', () => {
    const n = RUNNER_ONLINE_NETWORK
    for (const other of [RUNNER_CIDR, `${RUNNER_BRIDGE_IP}/16`, RUNNER_DOCKER_POOL.base]) expect(overlap(n.subnet, other), other).toBe(false)
    expect(n.bridge).toMatch(/^br-[a-z]{1,12}$/) // matches the firewall's br+ (so RUNNER-BRIDGE-IN and the IPv6 drop apply); IFNAMSIZ
    // Nothing a container must not reach is public: VPC, docker0, every Docker network, IMDS, the ECS credentials address, the resolver.
    for (const c of [RUNNER_CIDR, `${RUNNER_BRIDGE_IP}/16`, RUNNER_DOCKER_POOL.base, n.subnet, '169.254.169.254/32', '169.254.170.2/32', `${RUNNER_VPC_RESOLVER}/32`, '100.64.0.0/10']) {
      expect(RUNNER_NON_PUBLIC_V4.some((r) => inside(c, r)), c).toBe(true)
    }
    for (const pub of ['1.1.1.1/32', '8.8.8.8/32', '52.0.0.0/8', '100.128.0.1/32', '172.32.0.1/32', '192.169.0.1/32']) {
      expect(RUNNER_NON_PUBLIC_V4.some((r) => overlap(pub, r)), pub).toBe(false)
    }
    const t = synth(resolveRunnerSettings(ctx({ ...FLEET, runnerContainerEgress: 'internet' }), {}))
    const sg = Object.values(t.Resources).find((r) => r.Type === 'AWS::EC2::SecurityGroup')?.Properties
    expect(sg?.SecurityGroupIngress ?? []).toEqual([])
    expect((sg?.SecurityGroupEgress as any[]).map((e) => e.FromPort).sort()).toEqual([...RUNNER_EGRESS_TCP_PORTS].sort())
  })

  it('internet: RUNNER-ONLINE-OUT admits replies, DNS to the resolver only, public TCP 80/443; drops other bridges and non-public; rejects the rest', () => {
    const out = runnerOnlineOutRules()
    const i = (r: string) => { const k = out.indexOf(r); expect(k, r).toBeGreaterThanOrEqual(0); return k }
    const accepts = out.filter((r) => r.endsWith('-j ACCEPT'))
    expect(accepts).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      '-d 169.254.169.253/32 -p udp --dport 53 -j ACCEPT',
      '-d 169.254.169.253/32 -p tcp --dport 53 -j ACCEPT',
      '-p tcp -m multiport --dports 443,80 -j ACCEPT',
    ])
    // Order: other bridges and the non-public ranges are dropped before the public accept; the resolver exception
    // comes before the 169.254.0.0/16 drop; the log is just before the public accept; the rejects are last.
    const pub = i('-p tcp -m multiport --dports 443,80 -j ACCEPT')
    for (const r of ['-o docker0 -j DROP', '-o br+ -j DROP', ...RUNNER_NON_PUBLIC_V4.map((c) => `-d ${c} -j DROP`)]) expect(i(r)).toBeLessThan(pub)
    expect(i('-d 169.254.169.253/32 -p udp --dport 53 -j ACCEPT')).toBeLessThan(i('-d 169.254.0.0/16 -j DROP'))
    expect(i('-p tcp -j LOG --log-prefix "llmar-online: " --log-level 6')).toBe(pub - 1)
    expect(out.slice(-2)).toEqual(['-p tcp -j REJECT --reject-with tcp-reset', '-j REJECT --reject-with icmp-admin-prohibited'])
    const fw = runnerFirewallScript(8088, 'internet')
    // The deployed rules come first, unchanged; the online chains and jumps are added after them, the jumps at the top.
    expect(fw.slice(0, DEPLOYED_FIREWALL.length)).toEqual(DEPLOYED_FIREWALL)
    expect(fw.slice(-3)).toEqual([
      `for rule in "${RUNNER_DOCKER_USER_ONLINE[1]}" "${RUNNER_DOCKER_USER_ONLINE[0]}"; do`,
      '  $ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER 1 $rule',
      'done',
    ])
    expect(RUNNER_DOCKER_USER_ONLINE).toEqual(['-i br-llmon -j RUNNER-ONLINE-OUT', '-o br-llmon -j RUNNER-ONLINE-IN'])
    expect(fw).toContain('$ipt -A RUNNER-ONLINE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')
    expect(fw.filter((l) => l.startsWith('$ipt -A RUNNER-ONLINE-IN'))).toHaveLength(2)
    expect(fw.join('\n')).not.toMatch(/\|\| true|; true|set \+e|ip6t.*ACCEPT|-t nat/) // fail-closed; no IPv6 admitted; NAT is Docker's
    execFileSync('bash', ['-n'], { input: fw.join('\n') })
  })

  it('internet user data: env keys, the online network created after Docker starts and checked; same bootstrap otherwise', () => {
    const uds = userData(synth(resolveRunnerSettings(ctx({ ...FLEET, runnerContainerEgress: 'internet' }), {})))
    expect(uds).toHaveLength(4)
    for (const ud of uds) {
      const lines = ud.split('\n')
      const at = (l: string) => { const k = lines.indexOf(l); expect(k, l).toBeGreaterThan(0); return k }
      for (const l of ['CONTAINER_EGRESS=internet', 'ONLINE_NETWORK=llmar-online', 'ONLINE_DNS=169.254.169.253']) expect(at(l)).toBeLessThan(at('echo "DRIVER_PYTHON=$DRIVER_PYTHON" >> /etc/llmar-runner.env'))
      const create = lines.findIndex((l) => l.startsWith('docker network inspect llmar-online >/dev/null 2>&1 || docker network create --driver bridge --subnet 10.201.0.0/24 '))
      expect(create).toBeGreaterThan(at('systemctl enable --now docker'))
      expect(lines[create]).toContain('-o com.docker.network.bridge.name=br-llmon -o com.docker.network.bridge.enable_icc=false -o com.docker.network.bridge.enable_ip_masquerade=true llmar-online')
      expect(lines[create]).not.toMatch(/--ipv6|--internal|--gateway/)
      expect(lines[create + 1]).toMatch(/^test "\$\(docker network inspect llmar-online --format '.*'\)" = 'bridge br-llmon false true false false 10\.201\.0\.0\/24 '$/)
      expect(ud).toContain(runnerFirewallScript(8088, 'internet').join('\n'))
      expect(ud).toContain(runnerDaemonJson()) // container DNS stays 192.0.2.53 for every other network
      expect(ud).not.toMatch(/docker (run|build|pull)\b|buildx build|--network[ =]host|--privileged|-p \d|--publish/)
      expect(Buffer.byteLength(ud)).toBeLessThan(16 * 1024)
      execFileSync('bash', ['-n'], { input: ud })
    }
    // Same bootstrap otherwise: removing exactly the internet blocks gives the none user data.
    const none = userData(synth(resolveRunnerSettings(ctx(FLEET), {})))[0] as string
    const fwTail = runnerFirewallScript(8088, 'internet').slice(DEPLOYED_FIREWALL.length).join('\n')
    const cut = (ud: string, block: string) => { expect(ud).toContain(`\n${block}\n`); return ud.replace(`\n${block}\n`, '\n') }
    let ud = uds[0] as string
    const quiet = ['printk=/proc/sys/kernel/printk', `printk_dropin=${RUNNER_PRINTK_DROPIN}`, `printk_before=${RUNNER_PRINTK_BEFORE}`, ...runnerConsoleQuiet()].join('\n')
    for (const block of [runnerEgressEnv('internet').join('\n'), fwTail, quiet, `${runnerOnlineNetworkCreate()}\n${runnerOnlineNetworkCheck()}`]) ud = cut(ud, block)
    // The console goes quiet before Docker (and so the connection log) starts.
    expect((uds[0] as string).indexOf(`echo '${RUNNER_CONSOLE_PRINTK}' > "$printk"`)).toBeLessThan((uds[0] as string).indexOf('systemctl enable --now docker'))
    expect(ud).toBe(none)
  })

  it('switch scripts: committed files match the generator; root, a runner, the proxy port and no running container are required; every rule is checked', () => {
    const files = runnerSsmFiles()
    expect(Object.keys(files)).toEqual(['runner-egress-none.sh', 'runner-egress-internet.sh'])
    for (const [name, body] of Object.entries(files)) {
      expect(readFileSync(new URL(`../runner-ssm/${name}`, import.meta.url), 'utf8'), `${name}: run node src/runner-ssm.ts`).toBe(body)
      execFileSync('bash', ['-n'], { input: body })
      const lines = body.split('\n')
      const at = (l: string) => { const k = lines.indexOf(l); expect(k, l).toBeGreaterThan(0); return k }
      const apply = at('"$fw"')
      for (const pre of ['test "$(id -u)" = 0 || fail "run as root"', "grep -qx 'PROXY_PORT=8088' \"$env_file\" || fail \"PROXY_PORT in $env_file is not 8088; regenerate for this runner\"",
        'test -z "$(docker ps -q)" || fail "containers are running: finish or stop the run first"', 'cp -p "$fw" "$env_file" "$backup/"']) expect(at(pre)).toBeLessThan(apply)
      expect(body).not.toMatch(/systemctl restart|daemon\.json|docker network rm|rm -rf \/|\|\| true/) // dockerd keeps running; nothing deleted
    }
    const internet = files['runner-egress-internet.sh'] as string
    expect(internet).toContain(runnerFirewallScript(8088, 'internet').join('\n'))
    for (const r of runnerOnlineOutRules()) expect(internet).toContain(`$ipt -C RUNNER-ONLINE-OUT ${r}\n`)
    expect(internet).toContain(`test "$($ipt -S RUNNER-ONLINE-OUT | grep -c '^-A')" = ${runnerOnlineOutRules().length}`)
    expect(internet).toContain('$ipt -t nat -C POSTROUTING -s 10.201.0.0/24 ! -o br-llmon -j MASQUERADE')
    // Console level 4 before the LOG rule is applied; checked; none restores the previous value and removes the drop-in.
    expect(internet.indexOf(`echo '${RUNNER_CONSOLE_PRINTK}' > "$printk"`)).toBeLessThan(internet.indexOf('\n"$fw"\n'))
    expect(internet).toContain('test "$console_level" -le 6 || fail')
    const none = files['runner-egress-none.sh'] as string
    expect(none).toContain('if [ -e "$printk_before" ]; then cat "$printk_before" > "$printk"; rm -f "$printk_before"; fi')
    expect(none).not.toContain(`echo '${RUNNER_CONSOLE_PRINTK}'`)
    expect(none).toContain(DEPLOYED_FIREWALL.join('\n'))
    expect(none).toContain('absent $ipt -n -L RUNNER-ONLINE-OUT')
    expect(runnerEgressSwitchScript('internet', 9443).join('\n')).toContain("grep -qx 'PROXY_PORT=9443'")
  })

  it.skipIf(!NETNS)('switch dry run (iptables-nft in a user+net namespace): internet is idempotent; none restores the deployed rules and env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmar-egress-switch-'))
    writeFileSync(join(dir, 'fw-none.sh'), `${DEPLOYED_FIREWALL.join('\n')}\n`)
    for (const [name, body] of Object.entries(runnerSsmFiles())) writeFileSync(join(dir, name), body)
    const r = inNamespaces('switch.sh', dir, 50_000)
    expect(r.stdout + r.stderr).toMatch(/\nok\n$/)
    expect(r.status).toBe(0)
  }, 60_000)

  it.skipIf(!NETNS)('packets (veth, bridges, br_netfilter, conntrack, NAT in a user+net namespace): what a container on each bridge reaches, per mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmar-egress-packets-'))
    for (const m of ['none', 'internet'] as const) {
      const fw = join(dir, `fw-${m}.sh`)
      writeFileSync(fw, `${runnerFirewallScript(8088, m).join('\n')}\n`)
      const r = inNamespaces('packets.sh', fw, 70_000)
      expect(r.stdout + r.stderr, m).toMatch(/pass=\d+ fail=0\n$/)
      expect(r.status, m).toBe(0)
    }
  }, 150_000)

  afterAll(async () => {
    // No listen.py, sleep or harness shell may outlive the tests (they leaked by the thousand before the pid namespace).
    let left = harnessLeft()
    for (let i = 0; i < 20 && left.length; i++) { await new Promise((ok) => setTimeout(ok, 100)); left = harnessLeft() }
    expect(left, 'runner-netns processes left behind').toEqual([])
  })
})
