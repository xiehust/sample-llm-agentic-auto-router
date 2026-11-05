# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.40", "requests>=2.32"]
# ///
"""V9d spike: AgentCore Gateway -> private REST API (AWS_IAM, execute-api VPC endpoint) -> VPC link -> internal NLB
-> Fargate echo stub (ap-northeast-1). Fallback (d) after V9 option (a) failed (research/v9-findings.md).

Usage:  source scripts/local.env && uv run spikes/apigw-hop/spike.py <command>
Order:  deploy -> gate -> hop -> forge -> size -> cadence -> lat -> teardown   (`all` runs gate..lat)

- Refuses to run unless sts:GetCallerIdentity matches LLMAR_SPIKE_ACCOUNT.
- Every resource is named llmar-v9d-* and tagged Project=llm-auto-router, Purpose=spike (plus Owner from LLMAR_OWNER if set).
- `deploy` creates the stack, then updates it once to scope the VPC endpoint policy to the new API id (the API's
  resource policy names the endpoint, so the endpoint policy cannot name the API in the same template pass).
- The gateway target (and the Lattice resource gateway AgentCore manages for it) is created by `hop`, outside
  the stack, recorded in state.json, and deleted by `teardown` before the stack. `teardown` is idempotent and
  ends with a verification listing; it exits 1 if anything is left.
- `gate` (check 1) must pass for the current stack before any command that sends traffic through the gateway.
- The stub never calls a model; nothing here invokes Bedrock.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import statistics
import sys
import threading
import time
from typing import Any

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# Region: LLMAR_SPIKE_REGION (default ap-northeast-1; the recorded V9d run used ap-southeast-1).
REGION = os.environ.get('LLMAR_SPIKE_REGION', 'ap-northeast-1')
ACCOUNT = os.environ.get('LLMAR_SPIKE_ACCOUNT', '')  # scripts/local.env (gitignored)
STACK = 'llmar-v9d'
GATEWAY_NAME = 'llmar-v9d-gw'
TARGET = 'router'
# Owner tag is optional (LLMAR_OWNER); nothing personal is baked into the repo.
TAGS = {'Project': 'llm-auto-router', 'Purpose': 'spike', **({'Owner': os.environ['LLMAR_OWNER']} if os.environ.get('LLMAR_OWNER') else {})}
CIDR = '10.91.0.0/24'
# AgentCore managed private endpoints: apne1-az1/az2/az4 (Tokyo), apse1-az1/az2/az3 (Singapore).
AZ_IDS = {'ap-northeast-1': ('apne1-az1', 'apne1-az2'), 'ap-southeast-1': ('apse1-az1', 'apse1-az2')}[REGION]
PORT = 8080
STAGE = 'v1'
IMAGE = 'public.ecr.aws/docker/library/node:24-slim'
HERE = pathlib.Path(__file__).resolve().parent
STATE = HERE / 'state.json'      # gitignored (spikes/*/state.json)
RESULTS = HERE / 'results'       # gitignored (spikes/*/results/)
# Forgeable identity headers are allowlisted only on this spike target (check 3); the MVP never allowlists them.
REQ_HEADERS = ['anthropic-version', 'anthropic-beta', 'x-router-session', 'x-router-hint',
               'x-router-caller-arn', 'x-router-source-vpce', 'x-amz-source-arn']
REQ_HEADERS_SAFE = REQ_HEADERS[:4]
RESP_HEADERS = ['x-router-decision', 'x-router-model', 'x-stub-sha256']
PATHS = ('/v1/messages', '/v1/chat/completions', '/v1/responses')

session = boto3.Session(region_name=REGION)


# ---------------------------------------------------------------- helpers (shared shape with spikes/lattice-hop)

def check_account() -> None:
    if not ACCOUNT:
        sys.exit('set LLMAR_SPIKE_ACCOUNT (source scripts/local.env) to the account this spike may touch')
    if session.client('sts').get_caller_identity()['Account'] != ACCOUNT:
        sys.exit('refusing to run: caller account is not LLMAR_SPIKE_ACCOUNT')


def mask(value: Any) -> Any:
    """Mask 12-digit numbers (account ids) in anything written to results/."""
    return json.loads(re.sub(r'(?<!\d)\d{12}(?!\d)', '<acct>', json.dumps(value, default=str)))


def load_state() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {'targets': {}}


def save_state(state: dict[str, Any]) -> None:
    STATE.write_text(json.dumps(state, indent=2, sort_keys=True))


def save_result(name: str, data: Any) -> Any:
    RESULTS.mkdir(exist_ok=True)
    data = mask(data)
    (RESULTS / f'{name}.json').write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f'-> results/{name}.json')
    return data


def stack() -> dict[str, Any] | None:
    try:
        return session.client('cloudformation').describe_stacks(StackName=STACK)['Stacks'][0]
    except Exception:  # noqa: BLE001 - absent stack
        return None


def outputs() -> dict[str, str]:
    s = stack()
    if not s:
        sys.exit(f'stack {STACK} not found; run deploy')
    return {o['OutputKey']: o['OutputValue'] for o in s.get('Outputs', [])}


def gateway_base() -> str:
    url = outputs()['GatewayUrl']
    return url.split('/', 3)[0] + '//' + url.split('/', 3)[2]


def signed(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None,
           stream: bool = False, timeout: Any = 180, service: str = 'bedrock-agentcore') -> requests.Response:
    creds = session.get_credentials().get_frozen_credentials()
    hdrs = {'content-type': 'application/json', **(headers or {})}
    req = AWSRequest(method=method, url=url, data=body, headers=hdrs)
    SigV4Auth(creds, service, REGION).add_auth(req)
    return requests.request(method, url, data=body, headers=dict(req.headers), stream=stream, timeout=timeout)


def body_for(path: str, model: str, stream: bool = False, filler: str = 'ping') -> dict[str, Any]:
    if path == '/v1/messages':
        b: dict[str, Any] = {'model': model, 'max_tokens': 16, 'messages': [{'role': 'user', 'content': filler}]}
    elif path == '/v1/chat/completions':
        b = {'model': model, 'max_completion_tokens': 16, 'messages': [{'role': 'user', 'content': filler}]}
    else:
        b = {'model': model, 'input': filler, 'max_output_tokens': 16}
    if stream:
        b['stream'] = True
    return b


def stub_echo(body: Any) -> dict[str, Any] | None:
    for path in (('content', 0, 'text'), ('choices', 0, 'message', 'content'), ('output', 0, 'content', 0, 'text')):
        node = body
        try:
            for key in path:
                node = node[key]
            return json.loads(node)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
    return None


def first_echo(events: list[str]) -> dict[str, Any] | None:
    """The stub's first SSE delta carries the echo JSON."""
    for ev in events:
        for line in ev.splitlines():
            if not line.startswith('data: '):
                continue
            try:
                d = json.loads(line[6:])
            except ValueError:
                continue
            text = (d.get('delta') or {}).get('text') if isinstance(d.get('delta'), dict) else d.get('delta')
            if text is None and d.get('choices'):
                text = d['choices'][0].get('delta', {}).get('content')
            if isinstance(text, str) and text.startswith('{"method"'):
                return json.loads(text)
    return None


def call(path: str, body: dict[str, Any] | bytes, headers: dict[str, str] | None = None, stream: bool = False,
         timeout: Any = 180) -> dict[str, Any]:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    if path == '/v1/messages':
        headers = {'anthropic-version': '2023-06-01', **(headers or {})}
    t0 = time.time()
    out: dict[str, Any] = {'sent_len': len(raw), 'sent_sha256': hashlib.sha256(raw).hexdigest()}
    try:
        resp = signed('POST', gateway_base() + '/inference' + path, raw, headers, stream=stream, timeout=timeout)
    except Exception as err:  # noqa: BLE001
        return {**out, 'status': None, 'error': repr(err)}
    out['ttfb_ms'] = round((time.time() - t0) * 1000)
    out['status'] = resp.status_code
    out['headers'] = {k: v for k, v in resp.headers.items() if k.lower().startswith(('x-router', 'x-stub', 'x-amzn-errortype'))}
    if not stream:
        try:
            out['body'] = resp.json()
        except ValueError:
            out['body'] = resp.text[:2000]
        out['echo'] = stub_echo(out['body'])
        return out
    arrivals, buf, err = [], b'', None
    try:
        for chunk in resp.iter_content(chunk_size=None):
            arrivals.append({'t_ms': round((time.time() - t0) * 1000), 'bytes': len(chunk)})
            buf += chunk
    except Exception as e:  # noqa: BLE001 - how a long stream fails is the finding
        err = repr(e)
    events = [e for e in buf.decode('utf-8', 'replace').split('\n\n') if e.strip()]
    out.update({'arrivals': arrivals, 'events': len(events), 'stream_error': err,
                'completed': any(('message_stop' in e) or ('[DONE]' in e) or ('response.completed' in e) for e in events),
                'duration_ms': round((time.time() - t0) * 1000), 'echo': first_echo(events)})
    return out


def require_gate() -> None:
    gate = RESULTS / 'gate.json'
    s = stack()
    if not s or not gate.exists():
        sys.exit('STOP: run `gate` first (check 1 must pass before any traffic through the gateway)')
    g = json.loads(gate.read_text())
    if not g.get('passed') or g.get('stackCreated') != str(s['CreationTime']):
        sys.exit('STOP: gate has not passed for the current stack; run `gate`')


# ---------------------------------------------------------------- template


# ---------------------------------------------------------------- template

def template() -> dict[str, Any]:
    stub = (HERE / 'stub' / 'server.cjs').read_text()
    probe = (HERE / 'probe' / 'probe.py').read_text()
    tl = [{'Key': k, 'Value': v} for k, v in TAGS.items()]
    named = lambda n: tl + [{'Key': 'Name', 'Value': n}]  # noqa: E731
    sub = lambda s: {'Fn::Sub': s}  # noqa: E731
    ref = lambda n: {'Ref': n}  # noqa: E731
    att = lambda n, a: {'Fn::GetAtt': [n, a]}  # noqa: E731
    api_invoke = sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/' + STAGE + '/*/*')
    r: dict[str, Any] = {
        # ---- network: two private subnets (task, NLB, VPCE, probe, resource gateway); one public subnet for the NAT only.
        'Vpc': {'Type': 'AWS::EC2::VPC', 'Properties': {'CidrBlock': CIDR, 'EnableDnsSupport': True,
                                                        'EnableDnsHostnames': True, 'Tags': named('llmar-v9d-vpc')}},
        'PrivA': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.91.0.0/26',
                                                             'AvailabilityZoneId': AZ_IDS[0], 'Tags': named('llmar-v9d-priv-a')}},
        'PrivB': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.91.0.64/26',
                                                             'AvailabilityZoneId': AZ_IDS[1], 'Tags': named('llmar-v9d-priv-b')}},
        'PubA': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.91.0.128/27',
                                                            'AvailabilityZoneId': AZ_IDS[0], 'MapPublicIpOnLaunch': False,
                                                            'Tags': named('llmar-v9d-pub-nat')}},
        'Igw': {'Type': 'AWS::EC2::InternetGateway', 'Properties': {'Tags': named('llmar-v9d-igw')}},
        'IgwAttach': {'Type': 'AWS::EC2::VPCGatewayAttachment', 'Properties': {'VpcId': ref('Vpc'), 'InternetGatewayId': ref('Igw')}},
        'PubRt': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc'), 'Tags': named('llmar-v9d-pub-rt')}},
        'PubDefault': {'Type': 'AWS::EC2::Route', 'DependsOn': 'IgwAttach', 'Properties': {
            'RouteTableId': ref('PubRt'), 'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': ref('Igw')}},
        'PubRtA': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PubA'), 'RouteTableId': ref('PubRt')}},
        'NatEip': {'Type': 'AWS::EC2::EIP', 'DependsOn': 'IgwAttach', 'Properties': {'Domain': 'vpc', 'Tags': named('llmar-v9d-nat-eip')}},
        'Nat': {'Type': 'AWS::EC2::NatGateway', 'Properties': {'SubnetId': ref('PubA'), 'AllocationId': att('NatEip', 'AllocationId'),
                                                               'Tags': named('llmar-v9d-nat')}},
        'PrivRt': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc'), 'Tags': named('llmar-v9d-priv-rt')}},
        'PrivDefault': {'Type': 'AWS::EC2::Route', 'Properties': {
            'RouteTableId': ref('PrivRt'), 'DestinationCidrBlock': '0.0.0.0/0', 'NatGatewayId': ref('Nat')}},
        'PrivRtA': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PrivA'), 'RouteTableId': ref('PrivRt')}},
        'PrivRtB': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PrivB'), 'RouteTableId': ref('PrivRt')}},
        # ---- security groups (cross-references as separate rule resources to avoid template cycles)
        'TaskSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9d stub: ingress 8080 only from the NLB SG; egress 443 for image pull and logs',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'CidrIp': '0.0.0.0/0',
                                     'Description': 'image pull (ECR Public) and CloudWatch Logs via NAT'}],
            'Tags': named('llmar-v9d-task-sg')}},
        'NlbSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9d NLB: no ingress rules (PrivateLink/VPC link traffic is not evaluated); egress 8080 to the task',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'icmp', 'FromPort': -1, 'ToPort': -1, 'CidrIp': '127.0.0.1/32',
                                     'Description': 'placeholder: replaced by NlbToTask (removes the default allow-all)'}],
            'Tags': named('llmar-v9d-nlb-sg')}},
        'NlbToTask': {'Type': 'AWS::EC2::SecurityGroupEgress', 'Properties': {
            'GroupId': ref('NlbSg'), 'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT,
            'DestinationSecurityGroupId': ref('TaskSg'), 'Description': 'traffic and health checks to the stub'}},
        'TaskFromNlb': {'Type': 'AWS::EC2::SecurityGroupIngress', 'Properties': {
            'GroupId': ref('TaskSg'), 'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT,
            'SourceSecurityGroupId': ref('NlbSg'), 'Description': 'NLB only'}},
        'ClientSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9d clients in the VPC (gate probe, managed resource gateway): no ingress',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT, 'CidrIp': CIDR,
                                     'Description': 'gate probe: direct connects to the task and the NLB must time out'}],
            'Tags': named('llmar-v9d-client-sg')}},
        'VpceSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9d execute-api endpoint: 443 only from ClientSg',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'icmp', 'FromPort': -1, 'ToPort': -1, 'CidrIp': '127.0.0.1/32',
                                     'Description': 'placeholder: no egress needed'}],
            'Tags': named('llmar-v9d-vpce-sg')}},
        'VpceFromClient': {'Type': 'AWS::EC2::SecurityGroupIngress', 'Properties': {
            'GroupId': ref('VpceSg'), 'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443,
            'SourceSecurityGroupId': ref('ClientSg'), 'Description': 'probe and AgentCore resource gateway'}},
        'ClientToVpce': {'Type': 'AWS::EC2::SecurityGroupEgress', 'Properties': {
            'GroupId': ref('ClientSg'), 'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443,
            'DestinationSecurityGroupId': ref('VpceSg'), 'Description': 'execute-api endpoint'}},
        # ---- execute-api endpoint (private DNS off). Policy: this API only once `deploy` has run its update pass.
        'Vpce': {'Type': 'AWS::EC2::VPCEndpoint', 'Properties': {
            'VpcId': ref('Vpc'), 'VpcEndpointType': 'Interface', 'ServiceName': sub('com.amazonaws.${AWS::Region}.execute-api'),
            'SubnetIds': [ref('PrivA'), ref('PrivB')], 'SecurityGroupIds': [ref('VpceSg')], 'PrivateDnsEnabled': False,
            'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': '*', 'Action': 'execute-api:Invoke',
                'Resource': {'Fn::If': ['HasApiId',
                                        sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiIdForEndpointPolicy}/*'),
                                        sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:llmar-v9d-pending/*')]}}]},
            'Tags': named('llmar-v9d-vpce')}},
        # ---- internal NLB -> stub (ECS registers task IPs)
        'Nlb': {'Type': 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'Properties': {
            'Name': 'llmar-v9d-nlb', 'Type': 'network', 'Scheme': 'internal', 'IpAddressType': 'ipv4',
            'Subnets': [ref('PrivA'), ref('PrivB')], 'SecurityGroups': [ref('NlbSg')],
            'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic': 'off', 'Tags': tl}},
        'NlbTg': {'Type': 'AWS::ElasticLoadBalancingV2::TargetGroup', 'Properties': {
            'Name': 'llmar-v9d-stub', 'TargetType': 'ip', 'Protocol': 'TCP', 'Port': PORT, 'VpcId': ref('Vpc'),
            'HealthCheckProtocol': 'HTTP', 'HealthCheckPath': '/healthz', 'HealthCheckIntervalSeconds': 10,
            'HealthyThresholdCount': 2, 'UnhealthyThresholdCount': 2,
            'TargetGroupAttributes': [{'Key': 'deregistration_delay.timeout_seconds', 'Value': '30'}], 'Tags': tl}},
        'NlbListener': {'Type': 'AWS::ElasticLoadBalancingV2::Listener', 'Properties': {
            'LoadBalancerArn': ref('Nlb'), 'Protocol': 'TCP', 'Port': PORT,
            'DefaultActions': [{'Type': 'forward', 'TargetGroupArn': ref('NlbTg')}]}},
        # ---- ECS stub (no task role: it holds no AWS permissions)
        'Cluster': {'Type': 'AWS::ECS::Cluster', 'Properties': {'ClusterName': 'llmar-v9d', 'Tags': tl}},
        'StubLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {'LogGroupName': '/llmar/v9d/stub', 'RetentionInDays': 3, 'Tags': tl}},
        'ExecRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9d-exec-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'ecs-tasks.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'Policies': [{'PolicyName': 'logs-only', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'],
                'Resource': sub('${StubLogs.Arn}')}]}}],
            'Tags': tl}},
        'TaskDef': {'Type': 'AWS::ECS::TaskDefinition', 'Properties': {
            'Family': 'llmar-v9d-stub', 'Cpu': '256', 'Memory': '512', 'NetworkMode': 'awsvpc',
            'RequiresCompatibilities': ['FARGATE'],
            'RuntimePlatform': {'CpuArchitecture': 'ARM64', 'OperatingSystemFamily': 'LINUX'},
            'ExecutionRoleArn': att('ExecRole', 'Arn'),
            'ContainerDefinitions': [{
                'Name': 'stub', 'Image': IMAGE, 'Essential': True, 'User': 'node', 'ReadonlyRootFilesystem': True,
                'Command': ['node', '-e', stub],
                'Environment': [{'Name': 'PORT', 'Value': str(PORT)}, {'Name': 'HOST', 'Value': '0.0.0.0'}],  # nosec B104 - awsvpc task in a private subnet, no public IP, no published port; SG admits only the hop
                # awsvpc: no host port is published; the task SG (NLB SG only) is the boundary.
                'PortMappings': [{'Name': 'http', 'ContainerPort': PORT, 'Protocol': 'tcp', 'AppProtocol': 'http'}],
                'LogConfiguration': {'LogDriver': 'awslogs', 'Options': {
                    'awslogs-group': ref('StubLogs'), 'awslogs-region': REGION, 'awslogs-stream-prefix': 'stub'}}}],
            'Tags': tl}},
        'StubService': {'Type': 'AWS::ECS::Service', 'DependsOn': ['PrivDefault', 'PrivRtA', 'PrivRtB', 'NlbListener'], 'Properties': {
            'ServiceName': 'llmar-v9d-stub', 'Cluster': ref('Cluster'), 'TaskDefinition': ref('TaskDef'),
            'DesiredCount': 1, 'LaunchType': 'FARGATE', 'PropagateTags': 'SERVICE', 'EnableExecuteCommand': False,
            'HealthCheckGracePeriodSeconds': 30,
            'DeploymentConfiguration': {'DeploymentCircuitBreaker': {'Enable': True, 'Rollback': False}},
            'NetworkConfiguration': {'AwsvpcConfiguration': {'AssignPublicIp': 'DISABLED',
                                                             'Subnets': [ref('PrivA'), ref('PrivB')],
                                                             'SecurityGroups': [ref('TaskSg')]}},
            'LoadBalancers': [{'ContainerName': 'stub', 'ContainerPort': PORT, 'TargetGroupArn': ref('NlbTg')}],
            'Tags': tl}},
        # ---- gateway role (the only principal the API resource policy allows)
        'GatewayRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9d-gateway-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'bedrock-agentcore.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')},
                              'ArnLike': {'aws:SourceArn': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:*')}}}]},
            'Policies': [{'PolicyName': 'invoke-own-gateway', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'InvokeOwnGateway', 'Effect': 'Allow', 'Action': 'bedrock-agentcore:InvokeGateway',
                 'Resource': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:gateway/' + GATEWAY_NAME + '-*')}]}}],
            'Tags': tl}},
        # Separate resource: the API's resource policy names the role, so the role cannot name the API inline.
        'GatewayRoleApiPolicy': {'Type': 'AWS::IAM::RolePolicy', 'Properties': {
            'RoleName': ref('GatewayRole'), 'PolicyName': 'execute-api-invoke-only',
            'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'InvokeRouterApi', 'Effect': 'Allow', 'Action': 'execute-api:Invoke', 'Resource': api_invoke}]}}},
        # ---- private REST API: AWS_IAM, resource policy = gateway role via this VPCE only
        'VpcLink': {'Type': 'AWS::ApiGateway::VpcLink', 'Properties': {
            'Name': 'llmar-v9d-link', 'TargetArns': [ref('Nlb')], 'Tags': tl}},
        'RestApi': {'Type': 'AWS::ApiGateway::RestApi', 'Properties': {
            'Name': 'llmar-v9d-api', 'Description': 'llm-auto-router V9d spike (private, AWS_IAM)',
            'EndpointConfiguration': {'Types': ['PRIVATE'], 'VpcEndpointIds': [ref('Vpce')]},
            'DisableExecuteApiEndpoint': False,
            'Policy': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'GatewayRoleViaEndpoint', 'Effect': 'Allow', 'Principal': {'AWS': att('GatewayRole', 'Arn')},
                 'Action': 'execute-api:Invoke', 'Resource': f'execute-api:/{STAGE}/*/*',
                 'Condition': {'StringEquals': {'aws:SourceVpce': ref('Vpce')}}},
                {'Sid': 'DenyOtherEndpoints', 'Effect': 'Deny', 'Principal': '*', 'Action': 'execute-api:Invoke',
                 'Resource': 'execute-api:/*', 'Condition': {'StringNotEquals': {'aws:SourceVpce': ref('Vpce')}}},
                # Same account: an identity-policy allow alone would be enough, so every other principal is denied explicitly.
                {'Sid': 'DenyOtherPrincipals', 'Effect': 'Deny', 'Principal': '*', 'Action': 'execute-api:Invoke',
                 'Resource': 'execute-api:/*', 'Condition': {'ArnNotEquals': {'aws:PrincipalArn': att('GatewayRole', 'Arn')}}}]},
            'Tags': tl}},
        'ProxyResource': {'Type': 'AWS::ApiGateway::Resource', 'Properties': {
            'RestApiId': ref('RestApi'), 'ParentId': att('RestApi', 'RootResourceId'), 'PathPart': '{proxy+}'}},
        'ProxyAny': {'Type': 'AWS::ApiGateway::Method', 'Properties': {
            'RestApiId': ref('RestApi'), 'ResourceId': ref('ProxyResource'), 'HttpMethod': 'ANY',
            'AuthorizationType': 'AWS_IAM', 'RequestParameters': {'method.request.path.proxy': True},
            'Integration': {
                'Type': 'HTTP_PROXY', 'IntegrationHttpMethod': 'ANY', 'ConnectionType': 'VPC_LINK', 'ConnectionId': ref('VpcLink'),
                'Uri': sub('http://${Nlb.DNSName}:' + str(PORT) + '/' + STAGE + '/{proxy}'),
                'RequestParameters': {
                    'integration.request.path.proxy': 'method.request.path.proxy',
                    # Verified identity, set by API Gateway (client values for these names must be overwritten: check 3).
                    'integration.request.header.x-router-caller-arn': 'context.identity.userArn',
                    'integration.request.header.x-router-source-vpce': 'context.identity.vpceId'},
                'ResponseTransferMode': 'STREAM', 'TimeoutInMillis': 900000, 'PassthroughBehavior': 'WHEN_NO_MATCH'}}},
        'Deployment': {'Type': 'AWS::ApiGateway::Deployment', 'DependsOn': ['ProxyAny'], 'Properties': {
            'RestApiId': ref('RestApi'), 'Description': 'llmar-v9d'}},
        'Stage': {'Type': 'AWS::ApiGateway::Stage', 'Properties': {
            'RestApiId': ref('RestApi'), 'DeploymentId': ref('Deployment'), 'StageName': STAGE, 'Tags': tl}},
        # ---- gate probe (check 1): identity policy allows Invoke on this API; the resource policy must deny it
        'ProbeLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {
            'LogGroupName': '/aws/lambda/llmar-v9d-probe', 'RetentionInDays': 3, 'Tags': tl}},
        'ProbeRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9d-probe-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'ManagedPolicyArns': ['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
            'Policies': [{'PolicyName': 'invoke-api-identity-allow', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Effect': 'Allow', 'Action': 'execute-api:Invoke', 'Resource': api_invoke}]}}],
            'Tags': tl}},
        'ProbeFn': {'Type': 'AWS::Lambda::Function', 'Properties': {
            'FunctionName': 'llmar-v9d-probe', 'Runtime': 'python3.13', 'Handler': 'index.handler',
            'Architectures': ['arm64'], 'MemorySize': 256, 'Timeout': 90,
            'Role': att('ProbeRole', 'Arn'), 'Code': {'ZipFile': probe},
            'VpcConfig': {'SubnetIds': [ref('PrivA'), ref('PrivB')], 'SecurityGroupIds': [ref('ClientSg')]},
            'LoggingConfig': {'LogGroup': ref('ProbeLogs')}, 'Tags': tl}},
        # ---- AgentCore Gateway (AWS_IAM inbound for the spike driver; the MVP uses CUSTOM_JWT)
        'Gateway': {'Type': 'AWS::BedrockAgentCore::Gateway', 'DependsOn': ['GatewayRoleApiPolicy', 'Stage'], 'Properties': {
            'Name': GATEWAY_NAME, 'AuthorizerType': 'AWS_IAM', 'ExceptionLevel': 'DEBUG',
            'RoleArn': att('GatewayRole', 'Arn'), 'Description': 'llm-auto-router V9d spike (private REST API hop)', 'Tags': TAGS}},
    }
    vpce_dns = {'Fn::Select': [1, {'Fn::Split': [':', {'Fn::Select': [0, att('Vpce', 'DnsEntries')]}]}]}
    return {
        'AWSTemplateFormatVersion': '2010-09-09',
        'Description': 'llm-auto-router V9d spike: AgentCore Gateway -> private REST API (AWS_IAM) -> VPC link -> NLB -> Fargate echo stub. Delete after use.',
        'Parameters': {'ApiIdForEndpointPolicy': {'Type': 'String', 'Default': '', 'AllowedPattern': '^[a-z0-9]*$',
                                                  'Description': 'set by `deploy` in its second pass (scopes the VPCE policy)'}},
        'Conditions': {'HasApiId': {'Fn::Not': [{'Fn::Equals': [ref('ApiIdForEndpointPolicy'), '']}]}},
        'Resources': r,
        'Outputs': {
            'GatewayId': {'Value': ref('Gateway')},
            'GatewayUrl': {'Value': att('Gateway', 'GatewayUrl')},
            'RestApiId': {'Value': ref('RestApi')},
            'ApiHost': {'Value': sub('${RestApi}.execute-api.${AWS::Region}.amazonaws.com')},
            'VpceId': {'Value': ref('Vpce')},
            'VpceDns': {'Value': vpce_dns},
            'NlbDns': {'Value': att('Nlb', 'DNSName')},
            'TargetGroupArn': {'Value': ref('NlbTg')},
            'VpcId': {'Value': ref('Vpc')},
            'PrivSubnetIds': {'Value': {'Fn::Join': [',', [ref('PrivA'), ref('PrivB')]]}},
            'ClientSgId': {'Value': ref('ClientSg')},
            'ProbeFn': {'Value': ref('ProbeFn')},
        },
    }


# ---------------------------------------------------------------- control plane

def cfn_wait(cfn: Any, waiter: str) -> None:
    try:
        cfn.get_waiter(waiter).wait(StackName=STACK, WaiterConfig={'Delay': 15, 'MaxAttempts': 120})
    except Exception as err:  # noqa: BLE001
        try:
            for e in cfn.describe_stack_events(StackName=STACK)['StackEvents'][:40]:
                if 'FAILED' in e['ResourceStatus']:
                    print(e['LogicalResourceId'], e['ResourceStatus'], mask(e.get('ResourceStatusReason')))
        except Exception as e:  # noqa: BLE001 - best effort: the stack failure below is the error that matters
            print(f'could not list stack events: {type(e).__name__}')
        sys.exit(f'stack operation failed: {err}; run teardown before retrying')


def cmd_deploy(_: argparse.Namespace) -> None:
    if stack():
        sys.exit(f'stack {STACK} already exists; use status or teardown')
    cfn = session.client('cloudformation')
    body = json.dumps(template())
    cfn.create_stack(StackName=STACK, TemplateBody=body, Capabilities=['CAPABILITY_NAMED_IAM'],
                     Parameters=[{'ParameterKey': 'ApiIdForEndpointPolicy', 'ParameterValue': ''}],
                     Tags=[{'Key': k, 'Value': v} for k, v in TAGS.items()], OnFailure='ROLLBACK')
    print('creating stack', STACK)
    cfn_wait(cfn, 'stack_create_complete')
    api = outputs()['RestApiId']
    print('scoping the VPC endpoint policy to the API (update pass)')
    cfn.update_stack(StackName=STACK, TemplateBody=body, Capabilities=['CAPABILITY_NAMED_IAM'],
                     Parameters=[{'ParameterKey': 'ApiIdForEndpointPolicy', 'ParameterValue': api}],
                     Tags=[{'Key': k, 'Value': v} for k, v in TAGS.items()])
    cfn_wait(cfn, 'stack_update_complete')
    print(json.dumps(mask(outputs()), indent=2))


def cmd_untarget(_: argparse.Namespace) -> None:
    """Delete the gateway target only (e.g. after a FAILED hop), keeping the stack and the gate result."""
    delete_targets()


def ctl():
    return session.client('bedrock-agentcore-control')


def target_health() -> list[dict[str, Any]]:
    return session.client('elbv2').describe_target_health(TargetGroupArn=outputs()['TargetGroupArn'])['TargetHealthDescriptions']


def task_ip() -> str:
    ecs = session.client('ecs')
    arns = ecs.list_tasks(cluster='llmar-v9d', serviceName='llmar-v9d-stub', desiredStatus='RUNNING')['taskArns']
    if not arns:
        sys.exit('no running stub task')
    task = ecs.describe_tasks(cluster='llmar-v9d', tasks=arns[:1])['tasks'][0]
    for a in task['attachments']:
        for d in a['details']:
            if d['name'] == 'privateIPv4Address':
                return d['value']
    sys.exit('stub task has no private IP yet')


def stub_log_lines(kind: str, since_ms: int) -> list[dict[str, Any]]:
    """Stub log lines of one kind (the stub logs names and masked x-amz*/x-router-* values only)."""
    events = pages(session.client('logs'), 'filter_log_events', 'events', logGroupName='/llmar/v9d/stub',
                   startTime=since_ms, filterPattern=f'{{ $.kind = "{kind}" }}')
    out = []
    for e in events:
        try:
            out.append(json.loads(e['message']))
        except ValueError:
            continue
    return out


def cmd_status(_: argparse.Namespace) -> None:
    print(json.dumps(mask({'outputs': outputs(), 'state': load_state(), 'targets': target_health()}), indent=2, default=str))


def cmd_gate(_: argparse.Namespace) -> None:
    """Check 1 (before any target): unsigned, wrong-principal, outside-VPC and direct-to-task/NLB requests are denied."""
    s, out = stack(), outputs()
    if load_state()['targets']:
        sys.exit('STOP: a gateway target already exists; gate must run with no target (teardown and redeploy)')
    for _ in range(36):  # a healthy target makes a 403 meaningful: denial must come from auth, not from no backend
        health = target_health()
        if any(t['TargetHealth']['State'] == 'healthy' for t in health):
            break
        time.sleep(10)
    else:
        sys.exit(f'stub target never became healthy: {mask(health)}')
    vpce = session.client('ec2').describe_vpc_endpoints(VpcEndpointIds=[out['VpceId']])['VpcEndpoints'][0]
    vpce_policy = json.loads(vpce['PolicyDocument'])
    probe = json.loads(session.client('lambda').invoke(
        FunctionName=out['ProbeFn'],
        Payload=json.dumps({'vpceDns': out['VpceDns'], 'apiHost': out['ApiHost'], 'region': REGION, 'taskIp': task_ip(),
                            'nlbDns': out['NlbDns'], 'port': PORT}).encode(),
    )['Payload'].read())
    # From outside the VPC: the private API's public hostname, unsigned and signed by the operator's own (admin) role.
    # A private API's hostname may not resolve outside the VPC at all: that is unreachable, which satisfies the gate.
    def outside(fn: Any) -> Any:
        try:
            return fn()
        except requests.exceptions.ConnectionError as err:
            return {'unreachable': 'name resolution failed' if 'NameResolution' in repr(err) else 'connection failed'}
    outside_unsigned = outside(lambda: requests.get(f"https://{out['ApiHost']}/{STAGE}/models", timeout=30))
    outside_signed = outside(lambda: signed('GET', f"https://{out['ApiHost']}/{STAGE}/models", service='execute-api', timeout=30))
    anon = requests.post(gateway_base() + '/inference/v1/messages', json=body_for('/v1/messages', 'v9-echo'), timeout=30)
    nlb = probe.get('direct_tcp_nlb') or []
    checks = {
        'probe_unsigned_403': all((probe.get(k) or {}).get('status') == 403 for k in ('unsigned_models', 'unsigned_messages')),
        'probe_other_role_403': all((probe.get(k) or {}).get('status') == 403 for k in ('other_role_models', 'other_role_messages')),
        'probe_direct_tcp_task_timeout': (probe.get('direct_tcp_task') or {}).get('result') == 'timeout',
        'probe_direct_tcp_nlb_timeout': bool(nlb) and all(n.get('result') == 'timeout' for n in nlb),
        'outside_vpc_unsigned_denied': isinstance(outside_unsigned, dict) or outside_unsigned.status_code == 403,
        'outside_vpc_signed_denied': isinstance(outside_signed, dict) or outside_signed.status_code == 403,
        'gateway_anonymous_denied': anon.status_code in (401, 403),
        'vpce_policy_scoped_to_api': out['RestApiId'] in json.dumps(vpce_policy),
    }
    short = lambda r: {'status': r.status_code, 'body': r.text[:300],  # noqa: E731
                       'headers': {k: v for k, v in r.headers.items() if k.lower().startswith(('x-amzn', 'www-auth'))}}
    res = save_result('gate', {
        'passed': all(checks.values()), 'checks': checks, 'stackCreated': str(s['CreationTime']), 'probe': probe,
        'outside_vpc_unsigned': outside_unsigned if isinstance(outside_unsigned, dict) else short(outside_unsigned),
        'outside_vpc_signed': outside_signed if isinstance(outside_signed, dict) else short(outside_signed),
        'gateway_anonymous': short(anon), 'vpce_policy': vpce_policy, 'target_health': health})
    print(json.dumps(res['checks'], indent=2))
    if not res['passed']:
        sys.exit('STOP: gate failed; do not create the gateway target. Tear down and investigate.')
    print('GATE PASSED')


def create_target() -> dict[str, Any]:
    state, out = load_state(), outputs()
    if TARGET in state['targets']:
        return {'targetId': state['targets'][TARGET], 'reused': True}
    ops = [{'path': p, 'models': [{'model': 'v9-*'}]} for p in PATHS]
    params: dict[str, Any] = {
        'gatewayIdentifier': out['GatewayId'], 'name': TARGET,
        'targetConfiguration': {'inference': {'provider': {'endpoint': 'https://' + out['ApiHost'], 'operations': ops}}},
        'credentialProviderConfigurations': [{'credentialProviderType': 'GATEWAY_IAM_ROLE', 'credentialProvider': {
            'iamCredentialProvider': {'service': 'execute-api', 'region': REGION}}}],
        'privateEndpoint': {'managedVpcResource': {
            'vpcIdentifier': out['VpcId'], 'subnetIds': out['PrivSubnetIds'].split(','), 'endpointIpAddressType': 'IPV4',
            'securityGroupIds': [out['ClientSgId']], 'routingDomain': out['VpceDns'], 'tags': TAGS}},
        'metadataConfiguration': {'allowedRequestHeaders': REQ_HEADERS, 'allowedResponseHeaders': RESP_HEADERS},
    }
    result: dict[str, Any] = {'routingDomain': 'vpce-regional-dns'}
    try:
        created = ctl().create_gateway_target(**params)
        result['allowlist'] = 'with-forgeable-headers'
    except ctl().exceptions.ValidationException as err:  # refusing these names in the allowlist is itself a finding
        if 'header' not in str(err).lower():
            raise
        result['forgeable_allowlist_refused'] = str(err)
        params['metadataConfiguration']['allowedRequestHeaders'] = REQ_HEADERS_SAFE
        created = ctl().create_gateway_target(**params)
        result['allowlist'] = 'safe-only'
    state['targets'][TARGET] = created['targetId']
    state['allowlist'] = result['allowlist']
    save_state(state)
    for _ in range(120):
        t = ctl().get_gateway_target(gatewayIdentifier=out['GatewayId'], targetId=created['targetId'])
        if t['status'] not in ('CREATING', 'UPDATING'):
            break
        time.sleep(10)
    result.update({'targetId': created['targetId'], 'status': t['status'], 'statusReasons': t.get('statusReasons')})
    return result


def cmd_hop(_: argparse.Namespace) -> None:
    """Check 2: gateway -> VPCE -> private REST API (SigV4 execute-api, signed payload) -> NLB -> stub."""
    require_gate()
    t0 = int(time.time() * 1000) - 60_000
    created = create_target()
    print('target', created.get('status'), mask(created.get('statusReasons') or ''))
    res: dict[str, Any] = {'target': created, 'calls': {}}
    if created.get('status') == 'READY':
        time.sleep(20)
        for p in PATHS:
            res['calls'][p] = call(p, body_for(p, 'v9-echo'))
    out = outputs()
    echo = (res['calls'].get('/v1/messages') or {}).get('echo') or {}
    amz = echo.get('amz') or {}
    discovery = stub_log_lines('models', t0)
    res['discovery_at_stub'] = discovery[-3:]
    res['findings'] = {
        'target_ready': created.get('status') == 'READY',
        'discovery_reached_stub': bool(discovery),
        'all_200': bool(res['calls']) and all(c.get('status') == 200 for c in res['calls'].values()),
        'caller_arn_is_gateway_role': 'assumed-role/llmar-v9d-gateway-role/' in amz.get('x-router-caller-arn', ''),
        'source_vpce_is_ours': amz.get('x-router-source-vpce') == out['VpceId'],
        'source_arn_is_gateway': ('gateway/' + out['GatewayId']) in amz.get('x-amz-source-arn', ''),
        'content_sha256_at_stub': amz.get('x-amz-content-sha256'),  # R-a1 for (d): execute-api accepted a signed payload
        'authorization_reaches_stub': echo.get('authorizationPresent'),
        'header_names_at_stub': echo.get('headerNames'),
    }
    print(json.dumps(mask(res['findings']), indent=2))
    if not res['findings']['all_200']:
        for p, c in res['calls'].items():
            print(p, c.get('status'), mask(str(c.get('body'))[:400]))
    save_result('hop', res)
    if not res['findings']['all_200']:
        sys.exit('hop did not return 200 on every path; later checks would only measure the failure')


def cmd_forge(_: argparse.Namespace) -> None:
    """Check 3: client-sent identity headers must be overwritten by the API mapping (or never reach the stub)."""
    require_gate()
    forged = {'x-router-caller-arn': 'arn:aws:sts::000000000000:assumed-role/forged/s',
              'x-router-source-vpce': 'vpce-forged',
              'x-amz-source-arn': f'arn:aws:bedrock-agentcore:{REGION}:000000000000:gateway/forged'}
    r = call('/v1/messages', body_for('/v1/messages', 'v9-echo'), headers=forged)
    amz = (r.get('echo') or {}).get('amz') or {}
    res = {'allowlist': load_state().get('allowlist'), 'status': r.get('status'), 'seen': amz,
           'forged_value_reached_stub': {k: 'forged' in amz.get(k, '') for k in forged},
           'body': None if r.get('echo') else r.get('body')}
    save_result('forge', res)
    print(json.dumps(mask({k: res[k] for k in ('allowlist', 'status', 'forged_value_reached_stub')}), indent=2))


def cmd_size(_: argparse.Namespace) -> None:
    """Check 4a: 1 / 7 / 9.5 / 12 MB. The REST API caps payloads at 10 MB; record where and how 12 MB fails."""
    require_gate()
    t0 = int(time.time() * 1000) - 5_000
    res: dict[str, Any] = {}
    for mb in (1, 7, 9.5, 12):
        raw = json.dumps(body_for('/v1/messages', 'v9-echo', filler='x' * int(mb * 1024 * 1024))).encode()
        r = call('/v1/messages', raw, timeout=300)
        e = r.get('echo') or {}
        res[f'{mb}MB'] = {'status': r.get('status'), 'sent_len': r['sent_len'], 'recv_len': e.get('len'),
                          'identical': e.get('sha256') == r['sent_sha256'], 'ttfb_ms': r.get('ttfb_ms'),
                          'error_headers': r.get('headers'), 'body': None if e else str(r.get('body') or r.get('error'))[:400]}
        print(mb, 'MB', res[f'{mb}MB']['status'], res[f'{mb}MB']['identical'])
    res['stub_saw_lengths'] = [x.get('len') for x in stub_log_lines('request', t0)]
    save_result('size', res)


def cmd_cadence(_: argparse.Namespace) -> None:
    """Check 4b: SSE ticks on all paths; 240 s / 330 s silent gaps around the 5-min private idle timeout; 630 s and
    960 s streams (ticking every 15 s) against the 15-min streaming cap. The long probes run in parallel (~17 min)."""
    require_gate()
    res: dict[str, Any] = {}
    for p in PATHS:
        r = call(p, body_for(p, 'v9-sse', stream=True), stream=True)
        gaps = [b['t_ms'] - a['t_ms'] for a, b in zip(r.get('arrivals', []), r.get('arrivals', [])[1:])]
        res[f'sse{p}'] = {'status': r.get('status'), 'chunks': len(r.get('arrivals', [])), 'completed': r.get('completed'),
                          'median_gap_ms': statistics.median(gaps) if gaps else None, 'duration_ms': r.get('duration_ms')}

    def long(name: str, model: str) -> None:
        r = call('/v1/messages', body_for('/v1/messages', model, stream=True), stream=True, timeout=(10, 1100))
        res[name] = {k: r.get(k) for k in ('status', 'completed', 'stream_error', 'duration_ms', 'events')}
        res[name]['last_arrival_ms'] = (r.get('arrivals') or [{}])[-1].get('t_ms')
    threads = [threading.Thread(target=long, args=(n, f'v9-{n}')) for n in ('gap240', 'gap330', 'long630', 'long960')]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    save_result('cadence', res)
    print(json.dumps(mask(res), indent=2))


def cmd_lat(_: argparse.Namespace) -> None:
    """Check 5: TTFB through gateway -> VPCE -> REST API -> NLB -> Fargate (10 warm calls) vs the agentcore spike."""
    require_gate()
    body = json.dumps(body_for('/v1/messages', 'v9-echo', stream=True)).encode()
    url = gateway_base() + '/inference/v1/messages'
    hdr = {'anthropic-version': '2023-06-01'}
    signed('POST', url, body, hdr, stream=True).close()
    samples = []
    for _ in range(10):
        t0 = time.time()
        r = signed('POST', url, body, hdr, stream=True)
        r.raw.read(1)
        samples.append(round((time.time() - t0) * 1000))
        r.close()
    res: dict[str, Any] = {'gateway_apigw_fargate': {'p50': statistics.median(samples), 'min': min(samples),
                                                     'max': max(samples), 'all': samples}}
    prior = HERE.parent / 'agentcore-gateway' / 'results' / 'lat.json'
    if prior.exists():
        p = json.loads(prior.read_text())
        res['spike_lambda_url'] = {k: p[k]['p50'] for k in ('direct', 'gateway_inference') if k in p}
        if 'gateway_inference' in p:
            res['delta_p50_ms_vs_gateway_lambda_url'] = res['gateway_apigw_fargate']['p50'] - p['gateway_inference']['p50']
    save_result('lat', res)
    print(json.dumps({k: v for k, v in res.items() if k != 'gateway_apigw_fargate'} | {'p50': res['gateway_apigw_fargate']['p50']}))


def cmd_all(args: argparse.Namespace) -> None:
    cmd_gate(args)
    for fn in (cmd_hop, cmd_forge, cmd_size, cmd_cadence, cmd_lat):
        fn(args)


# ---------------------------------------------------------------- teardown (check 6)

def delete_targets() -> None:
    state = load_state()
    s = stack()
    gw = next((o['OutputValue'] for o in (s or {}).get('Outputs', []) if o['OutputKey'] == 'GatewayId'), None)
    for name, target_id in list(state['targets'].items()):
        if gw:
            try:
                ctl().delete_gateway_target(gatewayIdentifier=gw, targetId=target_id)
                for _ in range(90):
                    ctl().get_gateway_target(gatewayIdentifier=gw, targetId=target_id)
                    time.sleep(10)
                sys.exit(f'target {name} still deleting after 15 min; rerun teardown')
            except ctl().exceptions.ResourceNotFoundException:
                pass
        state['targets'].pop(name)
        save_state(state)
        print('target deleted:', name)


def pages(client: Any, op: str, key: str, **kw: Any) -> list[dict[str, Any]]:
    if client.can_paginate(op):
        return [item for page in client.get_paginator(op).paginate(**kw) for item in page.get(key, [])]
    return getattr(client, op)(**kw).get(key, [])


def vpc_id() -> str | None:
    vpcs = session.client('ec2').describe_vpcs(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9d-vpc']}])['Vpcs']
    return vpcs[0]['VpcId'] if vpcs else None


def resource_gateways(vpc: str | None) -> list[dict[str, Any]]:
    if not vpc:
        return []
    return [g for g in pages(session.client('vpc-lattice'), 'list_resource_gateways', 'items') if g.get('vpcIdentifier') == vpc]


def cmd_teardown(_: argparse.Namespace) -> None:
    delete_targets()
    vpc = vpc_id()
    for _ in range(60):  # the managed resource gateway holds ENIs in our subnets; the VPC cannot go before it
        left = resource_gateways(vpc)
        if not left:
            break
        print('waiting for managed resource gateways:', [g['name'] for g in left])
        time.sleep(15)
    cfn = session.client('cloudformation')
    if stack():
        cfn.delete_stack(StackName=STACK)
        try:
            cfn.get_waiter('stack_delete_complete').wait(StackName=STACK, WaiterConfig={'Delay': 15, 'MaxAttempts': 120})
            print('stack deleted')
        except Exception as err:  # noqa: BLE001
            for e in cfn.describe_stack_events(StackName=STACK)['StackEvents'][:30]:
                if 'FAILED' in e['ResourceStatus']:
                    print(e['LogicalResourceId'], e['ResourceStatus'], mask(e.get('ResourceStatusReason')))
            sys.exit(f'stack delete failed: {err}; fix and rerun teardown')
    cmd_verify(_)


def cmd_verify(_: argparse.Namespace) -> None:
    """Verification listing: anything named llmar-v9d* or tagged Purpose=spike under this project."""
    ec2, apigw, vpc = session.client('ec2'), session.client('apigateway'), vpc_id()
    tagged = pages(session.client('resourcegroupstaggingapi'), 'get_resources', 'ResourceTagMappingList',
                   TagFilters=[{'Key': 'Project', 'Values': ['llm-auto-router']}, {'Key': 'Purpose', 'Values': ['spike']}])
    left = {
        'stack': bool(stack()),
        'gateways': [g['name'] for g in pages(ctl(), 'list_gateways', 'items') if g['name'].startswith('llmar-v9d')],
        'rest_apis': [a['name'] for a in pages(apigw, 'get_rest_apis', 'items') if a['name'].startswith('llmar-v9d')],
        'vpc_links': [v['name'] for v in pages(apigw, 'get_vpc_links', 'items') if v['name'].startswith('llmar-v9d')],
        'load_balancers': [lb['LoadBalancerName'] for lb in pages(session.client('elbv2'), 'describe_load_balancers', 'LoadBalancers')
                           if lb['LoadBalancerName'].startswith('llmar-v9d')],
        'target_groups': [tg['TargetGroupName'] for tg in pages(session.client('elbv2'), 'describe_target_groups', 'TargetGroups')
                          if tg['TargetGroupName'].startswith('llmar-v9d')],
        'vpc_endpoints': [e['VpcEndpointId'] for e in (ec2.describe_vpc_endpoints(Filters=[{'Name': 'vpc-id', 'Values': [vpc]}])['VpcEndpoints'] if vpc else [])
                          if e['State'].lower() not in ('deleted', 'deleting')],
        'resource_gateways_in_vpc': [g['name'] for g in resource_gateways(vpc)],
        'ecs_clusters': [c['clusterName'] for c in session.client('ecs').describe_clusters(clusters=['llmar-v9d'])['clusters']
                         if c['status'] == 'ACTIVE'],
        'vpcs': [vpc] if vpc else [],
        'nat_gateways': [n['NatGatewayId'] for n in ec2.describe_nat_gateways(
            Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9d-nat']}])['NatGateways'] if n['State'] not in ('deleted', 'deleting')],
        'eips': [a['AllocationId'] for a in ec2.describe_addresses(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9d-nat-eip']}])['Addresses']],
        'log_groups': [g['logGroupName'] for p in ('/llmar/v9d', '/aws/lambda/llmar-v9d')
                       for g in session.client('logs').describe_log_groups(logGroupNamePrefix=p)['logGroups']],
        'iam_roles': [r['RoleName'] for r in pages(session.client('iam'), 'list_roles', 'Roles') if r['RoleName'].startswith('llmar-v9d')],
    }
    # Tagged spike resources may include other spikes; only llmar-v9d ones count against this teardown.
    v9d_tagged = [r['ResourceARN'] for r in tagged if 'llmar-v9d' in r['ResourceARN'] or (vpc and vpc in r['ResourceARN'])]
    remaining = {k: v for k, v in left.items() if v}
    # The tagging API keeps listing deleted (INACTIVE) ECS clusters for a while; the cluster check above is authoritative.
    # ECS keeps INACTIVE services/task definitions and STOPPED tasks visible for a while; with no ACTIVE cluster
    # they are tombstones, not resources.
    v9d_tagged = [a for a in v9d_tagged if not (':ecs:' in a and not left['ecs_clusters'])]
    if v9d_tagged:
        remaining['tagged_v9d'] = v9d_tagged
    save_result('teardown', {'remaining': remaining, 'all_tagged_spike_resources': [r['ResourceARN'] for r in tagged]})
    if remaining:
        print(json.dumps(mask(remaining), indent=2))
        sys.exit('teardown NOT verified: resources remain')
    print('teardown verified: nothing left')


def main() -> None:
    commands = {n[4:]: f for n, f in globals().items() if n.startswith('cmd_')}
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=sorted(commands))
    parser.add_argument('--print-template', action='store_true', help='print the template and exit (no AWS calls)')
    args = parser.parse_args()
    check_account()
    commands[args.command](args)


if __name__ == '__main__':
    if '--print-template' in sys.argv:
        print(json.dumps(template(), indent=1))
        sys.exit(0)
    main()
