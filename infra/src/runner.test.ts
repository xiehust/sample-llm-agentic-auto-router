import { App, Tags, Validations } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { execFileSync } from 'node:child_process'
import { DEFAULT_RUNNER_INSTANCE_TYPE, DEFAULT_RUNNER_VOLUME_GB, HARBOR_PREPULL_IMAGES, isArmInstanceType, resolveRunnerSettings, RUNNER_BRIDGE_IP, RUNNER_CIDR, RUNNER_DOCKER_POOL, RUNNER_ENV_FILE, runnerDaemonJson, RUNNER_SSM_ACTIONS, RUNNER_TOOLS, RUNNER_WORK_DIR, runnerFirewallScript, runnerMetricsScript, runnerUserData, RunnerStack, type RunnerSettings } from './runner.ts'
import { resolveSettings } from './settings.ts'

const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const SECRET = 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:llmar-runner/client-AbC123'
const BASE = { region: 'ap-southeast-1', account: '000000000000', runnerSecretArn: SECRET, tags: '{"Owner":"test-owner"}' }
const SETTINGS = resolveRunnerSettings(ctx(BASE), {})

function build(settings: RunnerSettings = SETTINGS, nag = false) {
  const app = new App({ outdir: `/tmp/llmar-runner-test-${process.pid}-${Math.random().toString(36).slice(2)}` })
  const stack = new RunnerStack(app, 'llmar-runner', { env: { account: settings.account, region: settings.region }, settings })
  for (const [k, v] of Object.entries(settings.tags)) Tags.of(app).add(k, v)
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  return { app, template: Template.fromStack(stack) }
}
type Res = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string }
const { template } = build()
const json = template.toJSON() as { Resources: Record<string, Res>; Outputs: Record<string, unknown>; Parameters?: Record<string, any> }
const resources = json.Resources
const ofType = (t: string) => Object.entries(resources).filter(([, r]) => r.Type === t)
const props = (t: string) => ofType(t)[0]?.[1].Properties as Record<string, any>

describe('llmar-runner stack', () => {
  it('passes cdk-nag AwsSolutions with only the justified acknowledgements', () => {
    expect(() => build(SETTINGS, true).app.synth()).not.toThrow()
  })

  it('network: a new VPC with one public subnet in the AZ ID, an IGW, no NAT, flow logs', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1)
    const subnets = ofType('AWS::EC2::Subnet')
    expect(subnets).toHaveLength(1)
    expect(subnets[0]?.[1].Properties?.AvailabilityZoneId).toBe('apse1-az1')
    expect(subnets[0]?.[1].Properties?.AvailabilityZone).toBeUndefined()
    expect(subnets[0]?.[1].Properties?.MapPublicIpOnLaunch).toBe(false)
    template.resourceCountIs('AWS::EC2::InternetGateway', 1)
    template.resourceCountIs('AWS::EC2::NatGateway', 0)
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0)
    const routes = ofType('AWS::EC2::Route').map(([, r]) => r.Properties)
    expect(routes).toHaveLength(1)
    expect(routes[0]?.DestinationCidrBlock).toBe('0.0.0.0/0')
    expect(routes[0]?.GatewayId.Ref).toBe(ofType('AWS::EC2::InternetGateway')[0]?.[0])
    template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'ALL', ResourceType: 'VPC' })
    expect(resources[Object.keys(resources).find((k) => resources[k]?.Type === 'AWS::Logs::LogGroup') as string]?.Properties?.LogGroupName).toBe('/llmar/runner-vpc-flow')
    expect(build(resolveRunnerSettings(ctx({ ...BASE, runnerAzId: 'apse1-az3' }), {})).template.toJSON().Resources)
      .toSatisfy((r: Record<string, Res>) => Object.values(r).some((x) => x.Type === 'AWS::EC2::Subnet' && x.Properties?.AvailabilityZoneId === 'apse1-az3'))
  })

  it('security group: no inbound rules at all; egress exactly 443 and 80', () => {
    const sgs = ofType('AWS::EC2::SecurityGroup')
    expect(sgs).toHaveLength(1)
    const sg = sgs[0]?.[1].Properties
    expect(sg?.GroupName).toBe('llmar-runner')
    expect(sg?.SecurityGroupIngress ?? []).toEqual([])
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0)
    const egress = [...(sg?.SecurityGroupEgress ?? []), ...ofType('AWS::EC2::SecurityGroupEgress').map(([, r]) => r.Properties)]
    expect(egress.map((e: any) => [e.IpProtocol, e.FromPort, e.ToPort, e.CidrIp]).sort()).toEqual([['tcp', 443, 443, '0.0.0.0/0'], ['tcp', 80, 80, '0.0.0.0/0']])
  })

  it('instance: x86 m7i.2xlarge by default, AL2023 x86_64, 300 GB gp3 encrypted, IMDSv2 required with hop limit 1, public IP, no key pair', () => {
    const i = props('AWS::EC2::Instance')
    expect(i.InstanceType).toBe(DEFAULT_RUNNER_INSTANCE_TYPE)
    expect(i.KeyName).toBeUndefined()
    expect(i.MetadataOptions).toEqual({ HttpEndpoint: 'enabled', HttpProtocolIpv6: 'disabled', HttpPutResponseHopLimit: 1, HttpTokens: 'required', InstanceMetadataTags: 'disabled' })
    expect(i.BlockDeviceMappings).toEqual([{ DeviceName: '/dev/xvda', Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 300, VolumeType: 'gp3' } }])
    expect(i.NetworkInterfaces).toEqual([expect.objectContaining({ AssociatePublicIpAddress: true, DeviceIndex: '0' })])
    expect(i.Monitoring).toBe(false)
    expect(i.DisableApiTermination).toBe(false)
    expect(i.PropagateTagsToVolumeOnCreation).toBe(true)
    const ami = Object.values(json.Parameters ?? {}).find((p: any) => String(p.Type).includes('AWS::EC2::Image::Id'))
    expect(ami?.Default).toMatch(/^\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-.*-x86_64$/)
    // DeepSWE via Harbor: 8 vCPU / 64 GB and a bigger disk are deploy inputs.
    const other = build(resolveRunnerSettings(ctx({ ...BASE, runnerInstanceType: 'r7i.2xlarge', runnerVolumeGb: '400', runnerAmiId: 'ami-0123456789abcdef0' }), {})).template.toJSON()
    const oi = Object.values(other.Resources as Record<string, Res>).find((r) => r.Type === 'AWS::EC2::Instance')?.Properties
    expect(oi?.InstanceType).toBe('r7i.2xlarge')
    expect(oi?.BlockDeviceMappings).toEqual([{ DeviceName: '/dev/xvda', Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 400, VolumeType: 'gp3' } }])
    expect(JSON.stringify(oi?.ImageId)).toContain('ami-0123456789abcdef0')
    expect(SETTINGS.volumeGb).toBe(DEFAULT_RUNNER_VOLUME_GB)
    for (const bad of ['20', '5000', '400.5', '4e2', 'big']) expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerVolumeGb: bad }), {}), bad).toThrow(/runnerVolumeGb/)
  })

  it('user data: docker, buildx, compose, uv and Harbor pinned and checksummed; docker0 pinned; the bridge firewall as a fail-closed docker.service ExecStartPost', () => {
    const ud = props('AWS::EC2::Instance').UserData['Fn::Base64'] as string
    const lines = ud.split('\n')
    expect(lines.slice(1)).toEqual(runnerUserData({ proxyPort: 8088, swapGb: 0, index: 0, count: 1 }))
    expect(ud).not.toContain('/swapfile') // runnerSwapGb defaults to 0
    expect(ud).toMatch(/^#!\/bin\/bash\nset -euo pipefail\n/)
    expect(ud).toContain('dnf install -y docker git tar gzip\ntest -x /usr/sbin/iptables')
    expect(lines).toContain('test -x /usr/sbin/ip6tables')
    // AL2023's buildx (0.12) is too old for compose v5 build: pinned plugins go first in the CLI's search path.
    expect(lines).toContain('install -d -m 0755 /usr/local/lib/docker/cli-plugins')
    expect(ud).not.toContain('/usr/libexec/docker/cli-plugins') // the rpm's own plugin dir is left alone
    expect(ud).toContain('[Service]\nExecStartPost=/usr/local/sbin/runner-firewall\n')
    const at = (l: string) => { const i = lines.indexOf(l); expect(i, l).toBeGreaterThan(0); return i }
    const start = at('systemctl enable --now docker')
    expect(ud.indexOf('runner-firewall.conf')).toBeLessThan(ud.indexOf('systemctl enable --now docker')) // rules before the first start
    expect(at(runnerDaemonJson())).toBeLessThan(start)
    // daemon.json: docker0 pinned, plus 256 /24s for compose networks (agent + verifier per trial, leaks from crashes),
    // disjoint from the VPC and from docker0.
    expect(JSON.parse(runnerDaemonJson())).toEqual({ 'bip': '172.17.0.1/16', 'default-address-pools': [{ base: '10.200.0.0/16', size: 24 }], 'dns': ['192.0.2.53'] })
    const v4 = (cidr: string) => { const [ip, len] = cidr.split('/'); const n = (ip as string).split('.').reduce((a, o) => a * 256 + Number(o), 0); const l = Number(len); return [n - (n % 2 ** (32 - l)), 2 ** (32 - l)] as const }
    const overlap = (a: string, b: string) => { const [x, xs] = v4(a); const [y, ys] = v4(b); return x < y + ys && y < x + xs }
    // Container DNS upstream: TEST-NET-1 (never answers), not loopback, so dockerd never forwards container queries
    // from the host namespace; not in the VPC either (the VPC resolver stays unreachable from containers).
    expect(overlap('192.0.2.53/32', '192.0.2.0/24')).toBe(true)
    for (const other of ['127.0.0.0/8', RUNNER_CIDR, `${RUNNER_BRIDGE_IP}/16`, RUNNER_DOCKER_POOL.base]) expect(overlap('192.0.2.53/32', other), other).toBe(false)
    expect(2 ** (RUNNER_DOCKER_POOL.size - 16)).toBe(256)
    for (const other of [RUNNER_CIDR, `${RUNNER_BRIDGE_IP}/16`, '169.254.0.0/16']) expect(overlap(RUNNER_DOCKER_POOL.base, other), other).toBe(false)
    expect(overlap('10.200.5.0/24', RUNNER_DOCKER_POOL.base)).toBe(true) // the helper itself
    expect(at('test ! -e /etc/docker/daemon.json  # a fresh AL2023 instance has none; never overwrite one')).toBeLessThan(at("cat > /etc/docker/daemon.json <<'EOF'"))
    // Every download is a pinned release URL, checked against its sha256 before it is installed or run.
    const { compose, buildx, uv, harbor } = RUNNER_TOOLS
    for (const [tool, to, use] of [[compose, '/tmp/docker-compose', 'install -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose'],
      [buildx, '/tmp/docker-buildx', 'install -m 0755 /tmp/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx'],
      [uv, '/tmp/uv.tar.gz', 'tar -xzf /tmp/uv.tar.gz -C /tmp']] as const) {
      expect(tool.url).toMatch(new RegExp(`^https://github\\.com/[a-z-]+/[a-z-]+/releases/download/${tool.version}/`))
      expect(tool.sha256).toMatch(/^[0-9a-f]{64}$/)
      const get = at(`curl -fsSL --retry 3 -o ${to} '${tool.url}'`)
      expect(lines[get + 1]).toBe(`echo '${tool.sha256}  ${to}' | sha256sum -c -`)
      expect(get + 1).toBeLessThan(at(use))
    }
    expect(lines.filter((l) => l.startsWith('curl '))).toHaveLength(3)
    expect(compose.version).toBe('v5.7.0')
    expect(Number(buildx.version.split('.')[1])).toBeGreaterThanOrEqual(17) // compose v5 build needs buildx >= 0.17
    // No sshd: disabled, and the user data fails unless nothing listens on 22.
    expect(at("test -z \"$(ss -Htln 'sport = :22')\"") - 1).toBe(at('systemctl disable --now sshd.service sshd.socket 2>/dev/null || true'))
    expect(at(`/usr/local/bin/uv tool install --managed-python --python 3.13 --exclude-newer ${harbor.excludeNewer} harbor==0.25.0`)).toBeLessThan(at('test -x /usr/local/bin/harbor'))
    expect(at('test -x "$DRIVER_PYTHON"') - 1).toBe(at('DRIVER_PYTHON="$(/usr/local/bin/uv python find --managed-python --no-project 3.13)"  # the same uv-managed Python, for the driver'))
    expect(harbor.excludeNewer).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/)
    expect(Buffer.byteLength(ud)).toBeLessThan(16 * 1024) // EC2 user data limit (before base64)
    expect(lines.slice(-2)).toEqual([`docker compose version | grep -qF 'v5.7.0'`, `docker buildx version | grep -qF '${buildx.version}'`])
    // Nothing runs a container or a build during bootstrap: all fetching is by host processes.
    expect(ud).not.toMatch(/docker (run|build|pull)\b|buildx build|--network[ =]host|--privileged/)
    // Both scripts parse (bash -n: syntax only, nothing runs).
    execFileSync('bash', ['-n'], { input: ud })
    execFileSync('bash', ['-n'], { input: runnerFirewallScript(8088).join('\n') })
  })

  it('bridge firewall: nothing forwarded from docker0 or br-*; to the host only replies and the proxy port; idempotent', () => {
    const fw = runnerFirewallScript(8088)
    expect(fw.slice(0, 6)).toEqual(['#!/bin/bash', 'set -euo pipefail', 'ipt=/usr/sbin/iptables', 'ip6t=/usr/sbin/ip6tables',
      // Bridged (container-to-container) traffic goes through iptables only with br_netfilter: load it, fail-closed.
      '/usr/sbin/modprobe br_netfilter', '/usr/sbin/sysctl -q -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1'])
    const body = fw.join('\n')
    // Forwarded: DOCKER-USER drops everything entering from a bridge (and the IMDS address from anywhere).
    expect(body).toContain('for rule in "-i docker0 -j DROP" "-i br+ -j DROP" "-d 169.254.169.254/32 -j DROP"; do')
    expect(body).toContain('$ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER $rule')
    // To the host: a chain hooked first in INPUT for both bridge kinds (docker0 and every compose network); replies,
    // the proxy on docker0's pinned address only, then DROP.
    expect(RUNNER_BRIDGE_IP).toBe('172.17.0.1')
    expect(fw.filter((l) => l.startsWith('$ipt -A RUNNER-BRIDGE-IN'))).toEqual([
      '$ipt -A RUNNER-BRIDGE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      '$ipt -A RUNNER-BRIDGE-IN -p tcp -d 172.17.0.1/32 --dport 8088 -j ACCEPT',
      '$ipt -A RUNNER-BRIDGE-IN -j DROP',
    ])
    expect(body).toContain('$ipt -N RUNNER-BRIDGE-IN 2>/dev/null || $ipt -F RUNNER-BRIDGE-IN') // re-run flushes, never duplicates
    // IPv6 from a bridge (e.g. link-local to host services): dropped to the host and forwarded.
    expect(body).toContain([
      'for ifc in docker0 br+; do',
      '  $ipt -C INPUT -i $ifc -j RUNNER-BRIDGE-IN 2>/dev/null || $ipt -I INPUT 1 -i $ifc -j RUNNER-BRIDGE-IN',
      '  for chain in INPUT FORWARD; do',
      '    $ip6t -C $chain -i $ifc -j DROP 2>/dev/null || $ip6t -I $chain 1 -i $ifc -j DROP',
      '  done',
      'done',
    ].join('\n'))
    expect(fw.filter((l) => /ACCEPT/.test(l))).toHaveLength(2) // nothing else is admitted, v4 or v6
    expect(body).not.toMatch(/\|\| true|; true|set \+e/) // fail-closed: any failed rule fails docker.service
    // The proxy port is a deploy input.
    const other = build(resolveRunnerSettings(ctx({ ...BASE, runnerProxyPort: '9443' }), {})).template.toJSON()
    const ud = JSON.stringify(Object.values(other.Resources as Record<string, Res>).find((r) => r.Type === 'AWS::EC2::Instance')?.Properties?.UserData)
    expect(ud).toContain('--dport 9443 -j ACCEPT')
    expect(ud).not.toContain('--dport 8088')
    for (const bad of ['80', '0', '70000', 'x', '8088.5']) expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerProxyPort: bad }), {}), bad).toThrow(/runnerProxyPort/)
    expect(SETTINGS.proxyPort).toBe(8088)
  })

  it('role: the SSM Agent minimum + GetSecretValue on exactly the one secret ARN + Sol invoke (arm D), no managed policies, nothing else', () => {
    const roles = ofType('AWS::IAM::Role').filter(([, r]) => r.Properties?.RoleName === 'llmar-runner-role')
    expect(roles).toHaveLength(1)
    const role = roles[0]?.[1].Properties
    expect(role?.AssumeRolePolicyDocument.Statement).toEqual([{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' } }])
    expect(role?.ManagedPolicyArns).toBeUndefined()
    expect(role?.Policies.map((p: any) => p.PolicyName)).toEqual(['SsmAgent', 'ReadClientSecret', 'InvokeDirectModel'])
    // Session Manager + Run Command only: no ssm:GetParameter(s), documents or associations.
    expect(role?.Policies[0].PolicyDocument.Statement).toEqual([{ Sid: 'SsmAgent', Effect: 'Allow', Resource: '*', Action: [
      'ssm:UpdateInstanceInformation',
      'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage', 'ec2messages:GetEndpoint', 'ec2messages:GetMessages', 'ec2messages:SendReply',
    ] }])
    expect(RUNNER_SSM_ACTIONS).toHaveLength(11)
    expect(role?.Policies[1].PolicyDocument.Statement).toEqual([
      { Sid: 'ReadClientSecret', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: SECRET },
    ])
    // Arm D: the router task role's global-profile pattern, Sol only, plus the Responses default project limited to Sol.
    const inv = role?.Policies[2].PolicyDocument.Statement as any[]
    const s = JSON.stringify
    const profile = { 'Fn::Join': ['', ['arn:aws:bedrock:ap-southeast-1:', { Ref: 'AWS::AccountId' }, ':inference-profile/global.openai.gpt-6.1-sol']] }
    const actions = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']
    expect(inv.map((x) => x.Sid)).toEqual(['DirectInferenceProfiles', 'DirectProfileModelsInRegion', 'DirectGlobalProfileModels', 'DirectResponsesDefaultProject'])
    expect(inv[0]).toEqual({ Sid: 'DirectInferenceProfiles', Effect: 'Allow', Action: actions, Resource: profile, Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-southeast-1' } } })
    expect(inv[1]).toEqual({ Sid: 'DirectProfileModelsInRegion', Effect: 'Allow', Action: actions, Resource: 'arn:aws:bedrock:ap-southeast-1::foundation-model/openai.gpt-6.1-sol',
      Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-southeast-1', 'bedrock:InferenceProfileArn': [profile] } } })
    expect(inv[2]).toEqual({ Sid: 'DirectGlobalProfileModels', Effect: 'Allow', Action: actions, Resource: 'arn:aws:bedrock:::foundation-model/openai.gpt-6.1-sol',
      Condition: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': [profile] } } })
    expect(inv[3]).toEqual({ Sid: 'DirectResponsesDefaultProject', Effect: 'Allow', Action: 'bedrock:InvokeModel',
      Resource: { 'Fn::Join': ['', ['arn:aws:bedrock:ap-southeast-1:', { Ref: 'AWS::AccountId' }, ':project/*']] }, Condition: { StringEquals: { 'bedrock:ModelArn': [profile] } } })
    expect(s(inv)).not.toMatch(/astra|luna|anthropic|InvokeModel\*/)
    for (const st of inv) for (const a of [st.Action].flat()) expect(String(a)).not.toContain('*')
    // The only separate policy on the runner role is PutRunResults (it names the instances; see the results test).
    const roleId = roles[0]?.[0] as string
    const attached = ofType('AWS::IAM::Policy').filter(([, p]) => JSON.stringify(p.Properties?.Roles).includes(roleId))
    expect(attached.map(([, p]) => p.Properties?.PolicyName)).toEqual(['PutRunResults'])
    template.hasResourceProperties('AWS::IAM::InstanceProfile', { Roles: [{ Ref: roleId }] })
  })

  it('settings: region, account and the secret ARN are required; the AZ ID and instance type are validated deploy inputs', () => {
    expect(() => resolveRunnerSettings(ctx({ account: '000000000000', runnerSecretArn: SECRET }), { AWS_REGION: 'ap-southeast-1', CDK_DEFAULT_REGION: 'ap-southeast-1' })).toThrow(/region: required/)
    expect(() => resolveRunnerSettings(ctx({ region: 'ap-southeast-1', runnerSecretArn: SECRET }), { CDK_DEFAULT_ACCOUNT: '000000000000' })).toThrow(/account: required/)
    expect(() => resolveRunnerSettings(ctx({ region: 'ap-southeast-1', account: '000000000000' }), {})).toThrow(/runnerSecretArn: required/)
    // The ARN must be complete and in the deploy region and account: a partial ARN would need a wildcard.
    for (const bad of [SECRET.slice(0, -7), SECRET.replace('ap-southeast-1', 'us-east-1'), SECRET.replace('000000000000', '111111111111'), `${SECRET.slice(0, -6)}*`]) {
      expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerSecretArn: bad }), {}), bad).toThrow(/runnerSecretArn: must be the full/)
    }
    expect(() => resolveRunnerSettings(ctx({ ...BASE, region: 'eu-west-3', runnerSecretArn: SECRET.replace('ap-southeast-1', 'eu-west-3') }), {})).toThrow(/runnerAzId: required for eu-west-3/)
    // Arm D's grant needs the region's bundled catalog (profile kind of GPT-6.1 Sol).
    expect(() => resolveRunnerSettings(ctx({ ...BASE, region: 'eu-west-3', runnerAzId: 'euw3-az1', runnerSecretArn: SECRET.replace('ap-southeast-1', 'eu-west-3') }), {})).toThrow(/catalog: no bundled price catalog for region 'eu-west-3'/)
    expect(resolveRunnerSettings(ctx({ ...BASE, runnerAzId: 'apse1-az2' }), {}).azId).toBe('apse1-az2')
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerAzId: 'ap-southeast-1a' }), {})).toThrow(/runnerAzId: 'ap-southeast-1a' is not an AZ ID/)
    for (const arm of ['m7g.2xlarge', 'c7gn.4xlarge', 'r8gd.xlarge', 't4g.large', 'a1.xlarge']) {
      expect(isArmInstanceType(arm), arm).toBe(true)
      expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerInstanceType: arm }), {}), arm).toThrow(/is Arm \(Graviton\)/)
    }
    for (const x86 of ['m7i.2xlarge', 'm7a.2xlarge', 'c6in.4xlarge', 'g5.xlarge', 'm7i-flex.2xlarge']) expect(isArmInstanceType(x86), x86).toBe(false)
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerInstanceType: 'big' }), {})).toThrow(/is not an instance type/)
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerAmiId: 'latest' }), {})).toThrow(/runnerAmiId/)
    expect(SETTINGS).toMatchObject({ prefix: 'llmar', azId: 'apse1-az1', instanceType: 'm7i.2xlarge', tags: { Project: 'llm-auto-router', Purpose: 'experiment-runner', Owner: 'test-owner' } })
    expect(resolveRunnerSettings(ctx({ ...BASE, tags: '' }), {}).tags.Owner).toBeUndefined()
  })

  it('every taggable resource carries Project/Owner/Purpose, names follow the prefix, and nothing is retained', () => {
    const want = { Project: 'llm-auto-router', Owner: 'test-owner', Purpose: 'experiment-runner' }
    for (const [id, r] of Object.entries(resources)) {
      expect(r.DeletionPolicy ?? 'Delete', id).not.toBe('Retain')
      expect(r.UpdateReplacePolicy ?? 'Delete', id).not.toBe('Retain')
      const tags = r.Properties?.Tags
      if (!tags) continue
      expect(Object.fromEntries(tags.map((t: any) => [t.Key, t.Value])), id).toMatchObject(want)
    }
    for (const t of ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::InternetGateway', 'AWS::EC2::SecurityGroup', 'AWS::EC2::Instance', 'AWS::IAM::Role', 'AWS::Logs::LogGroup']) {
      for (const [id, r] of ofType(t)) expect(r.Properties?.Tags, `${t} ${id}`).toBeTruthy()
    }
    const nameOf = (t: string) => (props(t).Tags as any[]).find((x) => x.Key === 'Name')?.Value
    expect(nameOf('AWS::EC2::Instance')).toBe('llmar-runner-0')
    expect(nameOf('AWS::EC2::VPC')).toBe('llmar-runner-vpc')
    const acme = build(resolveRunnerSettings(ctx({ ...BASE, prefix: 'acme' }), {})).template
    acme.hasResourceProperties('AWS::IAM::Role', { RoleName: 'acme-runner-role' })
    acme.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'acme-runner' })
  })

  it('outputs: the instance id only, nothing secret', () => {
    expect(Object.keys(json.Outputs).sort()).toEqual(['InstanceIds', 'ResultsBucketName'])
    expect(JSON.stringify(json.Outputs)).not.toMatch(/secret/i)
  })

  it('N runners: identical type, AMI, role, SG and bootstrap except RUNNER_INDEX; named and tagged by index; one ordered id list', () => {
    const four = build(resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge', runnerVolumeGb: '250', runnerSwapGb: '32' }), {})).template.toJSON() as typeof json
    const inst = Object.entries(four.Resources).filter(([, r]) => r.Type === 'AWS::EC2::Instance')
    expect(inst.map(([id]) => id.replace(/[0-9A-F]{8}$/, ''))).toEqual(['Instance0', 'Instance1', 'Instance2', 'Instance3'])
    const p = inst.map(([, r]) => r.Properties as Record<string, any>)
    const tag = (q: Record<string, any>, k: string) => (q.Tags as any[]).find((t) => t.Key === k)?.Value
    expect(p.map((q) => tag(q, 'Name'))).toEqual(['llmar-runner-0', 'llmar-runner-1', 'llmar-runner-2', 'llmar-runner-3'])
    expect(p.map((q) => tag(q, 'RunnerIndex'))).toEqual(['0', '1', '2', '3'])
    const strip = (q: Record<string, any>) => JSON.stringify({ ...q, Tags: undefined, UserData: undefined, IamInstanceProfile: undefined })
    for (const q of p) expect(strip(q)).toBe(strip(p[0] as Record<string, any>)) // same type, AMI parameter, SG, subnet, disk, IMDS
    expect(p[0]?.InstanceType).toBe('r7i.2xlarge')
    expect(p[0]?.BlockDeviceMappings[0].Ebs.VolumeSize).toBe(250)
    expect(Object.values(four.Parameters ?? {}).filter((x: any) => String(x.Type).includes('AWS::EC2::Image::Id'))).toHaveLength(1)
    const uds = p.map((q) => (q.UserData['Fn::Base64'] as string).split('\n'))
    for (const [i, ud] of uds.entries()) {
      expect(ud.slice(1)).toEqual(runnerUserData({ proxyPort: 8088, swapGb: 32, index: i, count: 4 }))
      const diff = ud.filter((l, k) => l !== uds[0]?.[k])
      expect(diff).toEqual(i === 0 ? [] : [`RUNNER_INDEX=${i}`, `RESULTS_PREFIX=runs/${i}/`])
      execFileSync('bash', ['-n'], { input: ud.join('\n') })
    }
    // One role for all (an instance profile each), one SG, one VPC.
    expect(Object.values(four.Resources).filter((r) => r.Type === 'AWS::IAM::Role' && r.Properties?.RoleName === 'llmar-runner-role')).toHaveLength(1)
    expect(Object.values(four.Resources).filter((r) => r.Type === 'AWS::IAM::InstanceProfile')).toHaveLength(4)
    expect(Object.values(four.Resources).filter((r) => r.Type === 'AWS::EC2::SecurityGroup')).toHaveLength(1)
    expect(Object.keys(four.Outputs).sort()).toEqual(['InstanceIds', 'ResultsBucketName'])
    expect((four.Outputs.InstanceIds as any).Value).toEqual({ 'Fn::Join': [',', inst.map(([id]) => ({ Ref: id }))] })
    // cdk-nag passes with N instances too.
    expect(() => build(resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge' }), {}), true).app.synth()).not.toThrow()
    for (const bad of ['0', '9', '2.5', 'four']) expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerCount: bad }), {}), bad).toThrow(/runnerCount/)
    expect(SETTINGS.count).toBe(1)
  })

  it('swap, driver contract and host metrics: swap file when runnerSwapGb > 0; env file and work dir; runner-metrics prints counters', () => {
    const ud = runnerUserData({ proxyPort: 8088, swapGb: 32, index: 2, count: 4 })
    const at = (l: string) => { const i = ud.indexOf(l); expect(i, l).toBeGreaterThan(0); return i }
    expect(ud.slice(at('fallocate -l 32G /swapfile'), at('swapon /swapfile') + 1)).toEqual(['fallocate -l 32G /swapfile', 'chmod 0600 /swapfile', 'mkswap /swapfile', 'swapon /swapfile'])
    expect(ud).toContain("echo '/swapfile none swap defaults 0 0' >> /etc/fstab") // survives stop/start
    expect(at('swapon /swapfile')).toBeLessThan(at('systemctl enable --now docker'))
    for (const bad of ['-1', '300', '1.5']) expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerSwapGb: bad }), {}), bad).toThrow(/runnerSwapGb/)
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerVolumeGb: '60', runnerSwapGb: '40' }), {})).toThrow(/more than half/)
    expect(resolveRunnerSettings(ctx({ ...BASE, runnerSwapGb: '32' }), {}).swapGb).toBe(32)
    // The driver contract.
    expect(RUNNER_ENV_FILE).toBe('/etc/llmar-runner.env')
    const env = ud.slice(at(`cat > ${RUNNER_ENV_FILE} <<'EOF'`) + 1, at(`echo "DRIVER_PYTHON=$DRIVER_PYTHON" >> ${RUNNER_ENV_FILE}`) + 1)
    expect(env).toEqual(['RUNNER_INDEX=2', 'RUNNER_COUNT=4', 'PROXY_ADDR=172.17.0.1', 'PROXY_PORT=8088', 'HARBOR_VERSION=0.25.0', `WORK_DIR=${RUNNER_WORK_DIR}`, 'RESULTS_PREFIX=runs/2/',
      'UV_PYTHON_INSTALL_DIR=/opt/uv/python', 'UV_TOOL_DIR=/opt/uv/tools', `PREPULL_IMAGES="${HARBOR_PREPULL_IMAGES.join(' ')}"`, 'EOF',
      `echo "DRIVER_PYTHON=$DRIVER_PYTHON" >> ${RUNNER_ENV_FILE}`])
    for (const img of HARBOR_PREPULL_IMAGES) expect(img).toMatch(/^[a-z0-9/]+:[\w.-]+@sha256:[0-9a-f]{64}$/)
    // The env file is sourceable as written (bash -n on its body).
    execFileSync('bash', ['-n'], { input: env.slice(0, -2).join('\n') })
    expect(ud).toContain(`install -d -m 0700 ${RUNNER_WORK_DIR}`)
    expect(ud).toContain('chmod 0700 /usr/local/bin/runner-metrics')
    // runner-metrics runs here (Linux /proc) and prints one JSON object of cumulative counters.
    const script = runnerMetricsScript()
    expect(ud.slice(at("cat > /usr/local/bin/runner-metrics <<'EOF'") + 1, at("cat > /usr/local/bin/runner-metrics <<'EOF'") + 1 + script.length)).toEqual(script)
    expect(script.join('\n')).not.toMatch(/socket|urllib|http|subprocess/)
    const out = execFileSync('python3', ['-I', '-'], { input: script.join('\n') }).toString().trim().split('\n')
    expect(out).toHaveLength(1)
    const m = JSON.parse(out[0] as string)
    expect(Object.keys(m).sort()).toEqual(['cpu_jiffies', 'docker_free_bytes', 'load', 'mem_available_kb', 'ncpu', 'oom_kill', 'psi', 'pswpin', 'pswpout', 'swap_free_kb', 'swap_total_kb', 'ts'])
    expect(typeof m.pswpin).toBe('number')
    expect(typeof m.pswpout).toBe('number')
    // PSI some/full totals (microseconds) per resource; this dev kernel has PSI, as does AL2023's.
    expect(Object.keys(m.psi).sort()).toEqual(['cpu', 'io', 'memory'])
    for (const r of ['memory', 'io']) expect(Object.keys(m.psi[r]).sort(), r).toEqual(['full_total_us', 'some_total_us'])
    expect(typeof m.psi.cpu.some_total_us).toBe('number')
    for (const v of Object.values(m.psi) as Record<string, number>[]) for (const x of Object.values(v)) expect(Number.isInteger(x)).toBe(true)
    expect(Object.keys(m.cpu_jiffies).sort()).toEqual(['idle', 'iowait', 'irq', 'nice', 'softirq', 'steal', 'system', 'user']) // sort_keys
    expect(m.load).toHaveLength(3)
    expect(typeof m.oom_kill).toBe('number')
    expect(typeof m.mem_available_kb).toBe('number')
  })

  it('results bucket: private (BPA all four, SSE-S3, TLS only, no ACLs), 30-day expiry, destroyed with the stack; runner i may only PutObject under runs/<i>/', () => {
    const four = build(resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge' }), {})).template
    const res = four.toJSON().Resources as Record<string, Res>
    const buckets = Object.entries(res).filter(([, r]) => r.Type === 'AWS::S3::Bucket')
    expect(buckets).toHaveLength(1)
    const [bucketId, bucket] = buckets[0] as [string, Res]
    expect(bucket.DeletionPolicy).toBe('Delete')
    expect(bucket.UpdateReplacePolicy).toBe('Delete')
    const b = bucket.Properties as Record<string, any>
    expect(b.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true })
    expect(b.BucketEncryption).toEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] })
    expect(b.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] })
    expect(b.AccessControl).toBeUndefined()
    expect(b.VersioningConfiguration).toBeUndefined()
    expect(b.LifecycleConfiguration).toEqual({ Rules: [{ Id: 'expire', Status: 'Enabled', ExpirationInDays: 30, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] })
    expect(b.BucketName).toBeUndefined() // generated: no collisions across accounts
    // No autoDeleteObjects custom resource (no extra Lambda); the only Lambda-backed resource is the default-SG one.
    expect(Object.values(res).filter((r) => r.Type === 'Custom::S3AutoDeleteObjects')).toHaveLength(0)
    // Bucket policy: only the enforceSSL deny, no Allow and no public principal.
    const bp = Object.values(res).filter((r) => r.Type === 'AWS::S3::BucketPolicy')
    expect(bp).toHaveLength(1)
    const bst = bp[0]?.Properties?.PolicyDocument.Statement as any[]
    expect(bst).toEqual([expect.objectContaining({ Effect: 'Deny', Action: 's3:*', Principal: { AWS: '*' }, Condition: { Bool: { 'aws:SecureTransport': 'false' } } })])
    // Runner role: one PutObject statement per runner, own prefix, own instance; nothing else touches the bucket.
    const pol = Object.values(res).filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties?.PolicyName === 'PutRunResults')
    expect(pol).toHaveLength(1)
    const inst = Object.keys(res).filter((k) => res[k]?.Type === 'AWS::EC2::Instance')
    expect(pol[0]?.Properties?.PolicyDocument.Statement).toEqual(inst.map((iid, i) => ({
      Sid: `PutRunResults${i}`, Effect: 'Allow', Action: 's3:PutObject',
      Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, `/runs/${i}/*`]] },
      Condition: { ArnEquals: { 'ec2:SourceInstanceARN': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ec2:ap-southeast-1:', { Ref: 'AWS::AccountId' }, ':instance/', { Ref: iid }]] } } },
    })))
    const roleId = Object.keys(res).find((k) => res[k]?.Properties?.RoleName === 'llmar-runner-role') as string
    expect(pol[0]?.Properties?.Roles).toEqual([{ Ref: roleId }])
    for (const [id, r] of Object.entries(res)) {
      if (r.Type !== 'AWS::IAM::Policy' && r.Type !== 'AWS::IAM::Role') continue
      const docs = JSON.stringify(r.Type === 'AWS::IAM::Role' ? r.Properties?.Policies ?? [] : r.Properties?.PolicyDocument)
      if (!docs.includes(bucketId)) continue
      expect(id, 'only PutRunResults names the bucket').toBe(Object.keys(res).find((k) => res[k]?.Properties?.PolicyName === 'PutRunResults'))
      expect(docs).not.toMatch(/s3:(Get|List|Delete|\*)|s3:PutObjectAcl/)
    }
    expect(resolveRunnerSettings(ctx(BASE), {}).count).toBe(1)
    expect(() => build(resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge' }), {}), true).app.synth()).not.toThrow() // cdk-nag
  })

  it('least privilege and fleet guards: runnerDirectModel=none drops every Bedrock action (and the catalog need); a fleet needs an explicit instance type', () => {
    const none = resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge', runnerDirectModel: 'none' }), {})
    expect(none.directModel).toBeUndefined()
    expect(none.catalog).toBeUndefined()
    expect(SETTINGS.directModel).toBe('global.openai.gpt-6.1-sol') // default unchanged for the R2E-Gym arm D
    const res = build(none).template.toJSON().Resources as Record<string, Res>
    const role = Object.values(res).find((r) => r.Properties?.RoleName === 'llmar-runner-role')?.Properties as Record<string, any>
    expect(role.Policies.map((x: any) => x.PolicyName)).toEqual(['SsmAgent', 'ReadClientSecret'])
    expect(role.Description).not.toMatch(/Responses|sol/i)
    // Nothing anywhere in the stack grants a Bedrock action.
    const docs = Object.values(res).filter((r) => r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::Policy').map((r) => JSON.stringify(r.Properties))
    for (const d of docs) expect(d).not.toMatch(/bedrock/i)
    expect(() => build(none, true).app.synth()).not.toThrow() // cdk-nag: no stale project/* acknowledgement needed
    // With none, a Region without a bundled catalog is fine; with a direct model it is not.
    const euw3 = { ...BASE, region: 'eu-west-3', runnerAzId: 'euw3-az1', runnerSecretArn: SECRET.replace('ap-southeast-1', 'eu-west-3') }
    expect(resolveRunnerSettings(ctx({ ...euw3, runnerDirectModel: 'none' }), {}).directModel).toBeUndefined()
    expect(() => resolveRunnerSettings(ctx(euw3), {})).toThrow(/catalog: .*runnerDirectModel=none/)
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerDirectModel: 'global.openai.gpt-nope' }), {})).toThrow(/runnerDirectModel: 'global.openai.gpt-nope' is not in the ap-southeast-1 catalog/)
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerDirectModel: 'Sol!' }), {})).toThrow(/runnerDirectModel: 'Sol!' is not a model id/)
    // Fleet: no silent fallback to the 32 GB default type.
    expect(() => resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4' }), {})).toThrow(/runnerInstanceType: required with runnerCount > 1/)
    expect(resolveRunnerSettings(ctx({ ...BASE, runnerCount: '1' }), {}).instanceType).toBe(DEFAULT_RUNNER_INSTANCE_TYPE)
    expect(resolveRunnerSettings(ctx({ ...BASE, runnerCount: '4', runnerInstanceType: 'r7i.2xlarge' }), {}).instanceType).toBe('r7i.2xlarge')
  })

  it('the runner shares no settings with the router: router settings and models resolve unchanged', () => {
    const router = resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000' }), {}, DEFAULT_POLICY_FILE)
    expect(router.tags).toEqual({ Project: 'llm-auto-router', Purpose: 'mvp' })
    const exp = new URL('../../packages/router/config/policy.experiment.ap-southeast-1.json', import.meta.url).pathname
    const m = deployModels({ ...router, policyFile: exp })
    expect(m.policy.mode).toBe('auto')
    expect(m.routerResponsesModels).toEqual(['global.openai.gpt-6-astra', 'global.openai.gpt-6-luna', 'global.openai.gpt-6.1-sol'])
  })
})
