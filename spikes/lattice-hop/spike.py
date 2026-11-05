# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.40", "requests>=2.32"]
# ///
"""V9 spike: AgentCore Gateway -> VPC Lattice service (AWS_IAM) -> Fargate echo stub (ap-northeast-1).

Usage:  source scripts/local.env && uv run spikes/lattice-hop/spike.py <command>
Order:  deploy -> gate -> hop -> forge -> size -> cadence -> lat -> teardown   (`all` runs gate..lat)

- Refuses to run unless sts:GetCallerIdentity matches LLMAR_SPIKE_ACCOUNT.
- Every resource is named llmar-v9-* and tagged Project=llm-auto-router, Purpose=spike (plus Owner from LLMAR_OWNER if set).
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
import socket
import statistics
import sys
import threading
import time
from typing import Any

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = 'ap-northeast-1'
ACCOUNT = os.environ.get('LLMAR_SPIKE_ACCOUNT', '')  # scripts/local.env (gitignored)
STACK = 'llmar-v9'
GATEWAY_NAME = 'llmar-v9-gw'
TARGET = 'router'
# Owner tag is optional (LLMAR_OWNER); nothing personal is baked into the repo.
TAGS = {'Project': 'llm-auto-router', 'Purpose': 'spike', **({'Owner': os.environ['LLMAR_OWNER']} if os.environ.get('LLMAR_OWNER') else {})}
CIDR = '10.89.0.0/24'
ZONE = 'llmar-v9.internal'
PORT = 8080
IMAGE = 'public.ecr.aws/docker/library/node:24-slim'
HERE = pathlib.Path(__file__).resolve().parent
STATE = HERE / 'state.json'      # gitignored (spikes/*/state.json)
RESULTS = HERE / 'results'       # gitignored (spikes/*/results/)
# Forged headers are allowlisted only on this spike target (check 3); the MVP never allowlists x-amz*/x-amzn*.
REQ_HEADERS = ['anthropic-version', 'anthropic-beta', 'x-router-session', 'x-router-hint',
               'x-amzn-lattice-identity', 'x-amz-source-arn', 'x-amzn-source-vpc']
REQ_HEADERS_SAFE = REQ_HEADERS[:4]
RESP_HEADERS = ['x-router-decision', 'x-router-model', 'x-stub-sha256']
PATHS = ('/v1/messages', '/v1/chat/completions', '/v1/responses')

session = boto3.Session(region_name=REGION)


# ---------------------------------------------------------------- helpers

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


def lattice_prefix_list() -> str:
    pls = session.client('ec2').describe_managed_prefix_lists(
        Filters=[{'Name': 'prefix-list-name', 'Values': [f'com.amazonaws.{REGION}.vpc-lattice']}])['PrefixLists']
    if not pls:
        sys.exit('VPC Lattice managed prefix list not found')
    return pls[0]['PrefixListId']


def signed(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None,
           stream: bool = False, timeout: Any = 180) -> requests.Response:
    creds = session.get_credentials().get_frozen_credentials()
    hdrs = {'content-type': 'application/json', **(headers or {})}
    req = AWSRequest(method=method, url=url, data=body, headers=hdrs)
    SigV4Auth(creds, 'bedrock-agentcore', REGION).add_auth(req)
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

def template() -> dict[str, Any]:
    stub = (HERE / 'stub' / 'server.cjs').read_text()
    probe = (HERE / 'probe' / 'probe.py').read_text()
    tl = [{'Key': k, 'Value': v} for k, v in TAGS.items()]
    named = lambda n: tl + [{'Key': 'Name', 'Value': n}]  # noqa: E731
    sub = lambda s: {'Fn::Sub': s}  # noqa: E731
    ref = lambda n: {'Ref': n}  # noqa: E731
    att = lambda n, a: {'Fn::GetAtt': [n, a]}  # noqa: E731
    az = lambda i: {'Fn::Select': [i, {'Fn::GetAZs': ''}]}  # noqa: E731
    pl = ref('LatticePrefixList')
    egress_lattice = {'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'DestinationPrefixListId': pl}
    r: dict[str, Any] = {
        # ---- network: two private subnets (tasks, probe, resource gateway); one public subnet for the NAT only.
        'Vpc': {'Type': 'AWS::EC2::VPC', 'Properties': {'CidrBlock': CIDR, 'EnableDnsSupport': True,
                                                        'EnableDnsHostnames': True, 'Tags': named('llmar-v9-vpc')}},
        'PrivA': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.89.0.0/26',
                                                             'AvailabilityZone': az(0), 'Tags': named('llmar-v9-priv-a')}},
        'PrivB': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.89.0.64/26',
                                                             'AvailabilityZone': az(1), 'Tags': named('llmar-v9-priv-b')}},
        'PubA': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.89.0.128/27',
                                                            'AvailabilityZone': az(0), 'MapPublicIpOnLaunch': False,
                                                            'Tags': named('llmar-v9-pub-nat')}},
        'Igw': {'Type': 'AWS::EC2::InternetGateway', 'Properties': {'Tags': named('llmar-v9-igw')}},
        'IgwAttach': {'Type': 'AWS::EC2::VPCGatewayAttachment', 'Properties': {'VpcId': ref('Vpc'), 'InternetGatewayId': ref('Igw')}},
        'PubRt': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc'), 'Tags': named('llmar-v9-pub-rt')}},
        'PubDefault': {'Type': 'AWS::EC2::Route', 'DependsOn': 'IgwAttach', 'Properties': {
            'RouteTableId': ref('PubRt'), 'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': ref('Igw')}},
        'PubRtA': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PubA'), 'RouteTableId': ref('PubRt')}},
        'NatEip': {'Type': 'AWS::EC2::EIP', 'DependsOn': 'IgwAttach', 'Properties': {'Domain': 'vpc', 'Tags': named('llmar-v9-nat-eip')}},
        'Nat': {'Type': 'AWS::EC2::NatGateway', 'Properties': {'SubnetId': ref('PubA'), 'AllocationId': att('NatEip', 'AllocationId'),
                                                               'Tags': named('llmar-v9-nat')}},
        'PrivRt': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc'), 'Tags': named('llmar-v9-priv-rt')}},
        'PrivDefault': {'Type': 'AWS::EC2::Route', 'Properties': {
            'RouteTableId': ref('PrivRt'), 'DestinationCidrBlock': '0.0.0.0/0', 'NatGatewayId': ref('Nat')}},
        'PrivRtA': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PrivA'), 'RouteTableId': ref('PrivRt')}},
        'PrivRtB': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PrivB'), 'RouteTableId': ref('PrivRt')}},
        # ---- security groups
        'TaskSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9 stub: ingress 8080 only from the VPC Lattice prefix list; egress 443 for image pull and logs',
            'VpcId': ref('Vpc'),
            'SecurityGroupIngress': [{'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT, 'SourcePrefixListId': pl,
                                      'Description': 'VPC Lattice data plane and health checks'}],
            'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'CidrIp': '0.0.0.0/0',
                                     'Description': 'image pull (ECR Public) and CloudWatch Logs via NAT'}],
            'Tags': named('llmar-v9-task-sg')}},
        'ClientSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9 clients in the VPC (gate probe, managed resource gateway): no ingress',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [egress_lattice,
                                    {'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT, 'CidrIp': CIDR,
                                     'Description': 'gate probe: direct connect to the task must time out'}],
            'Tags': named('llmar-v9-client-sg')}},
        'AssocSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-v9 service network VPC association: 443 only from ClientSg',
            'VpcId': ref('Vpc'),
            'SecurityGroupIngress': [{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'SourceSecurityGroupId': ref('ClientSg')}],
            'Tags': named('llmar-v9-assoc-sg')}},
        # ---- VPC Lattice
        'ServiceNetwork': {'Type': 'AWS::VpcLattice::ServiceNetwork', 'Properties': {
            'Name': 'llmar-v9-sn', 'AuthType': 'NONE', 'Tags': tl}},
        'SnVpc': {'Type': 'AWS::VpcLattice::ServiceNetworkVpcAssociation', 'Properties': {
            'ServiceNetworkIdentifier': ref('ServiceNetwork'), 'VpcIdentifier': ref('Vpc'),
            'SecurityGroupIds': [ref('AssocSg')], 'Tags': tl}},
        'Service': {'Type': 'AWS::VpcLattice::Service', 'Properties': {
            'Name': 'llmar-v9-router', 'AuthType': 'AWS_IAM', 'IdleTimeoutSeconds': 600, 'Tags': tl}},
        'SnService': {'Type': 'AWS::VpcLattice::ServiceNetworkServiceAssociation', 'Properties': {
            'ServiceNetworkIdentifier': ref('ServiceNetwork'), 'ServiceIdentifier': ref('Service'), 'Tags': tl}},
        'AuthPolicy': {'Type': 'AWS::VpcLattice::AuthPolicy', 'Properties': {
            'ResourceIdentifier': ref('Service'),
            'Policy': {'Version': '2012-10-17', 'Statement': [{
                'Sid': 'GatewayRoleOnly', 'Effect': 'Allow',
                'Principal': {'AWS': att('GatewayRole', 'Arn')},
                'Action': 'vpc-lattice-svcs:Invoke',
                'Resource': sub('${Service.Arn}/*')}]}}},
        'TargetGroup': {'Type': 'AWS::VpcLattice::TargetGroup', 'Properties': {
            'Name': 'llmar-v9-stub', 'Type': 'IP',
            'Config': {'Port': PORT, 'Protocol': 'HTTP', 'ProtocolVersion': 'HTTP1', 'IpAddressType': 'IPV4',
                       'VpcIdentifier': ref('Vpc'),
                       'HealthCheck': {'Enabled': True, 'Protocol': 'HTTP', 'ProtocolVersion': 'HTTP1', 'Port': PORT,
                                       'Path': '/healthz', 'HealthCheckIntervalSeconds': 10, 'HealthCheckTimeoutSeconds': 5,
                                       'HealthyThresholdCount': 2, 'UnhealthyThresholdCount': 2,
                                       'Matcher': {'HttpCode': '200'}}},
            'Tags': tl}},
        'Listener': {'Type': 'AWS::VpcLattice::Listener', 'Properties': {
            'ServiceIdentifier': ref('Service'), 'Name': 'https', 'Protocol': 'HTTPS', 'Port': 443,
            'DefaultAction': {'Forward': {'TargetGroups': [{'TargetGroupIdentifier': ref('TargetGroup'), 'Weight': 100}]}},
            'Tags': tl}},
        # ---- ECS stub (no task role: it holds no AWS permissions)
        'Cluster': {'Type': 'AWS::ECS::Cluster', 'Properties': {'ClusterName': 'llmar-v9', 'Tags': tl}},
        'StubLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {'LogGroupName': '/llmar/v9/stub', 'RetentionInDays': 3, 'Tags': tl}},
        'ExecRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9-exec-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'ecs-tasks.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'Policies': [{'PolicyName': 'logs-only', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'],
                'Resource': sub('${StubLogs.Arn}')}]}}],
            'Tags': tl}},
        'InfraRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9-ecs-lattice-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'ecs.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'ManagedPolicyArns': ['arn:aws:iam::aws:policy/AmazonECSInfrastructureRolePolicyForVpcLattice'],
            'Tags': tl}},
        'TaskDef': {'Type': 'AWS::ECS::TaskDefinition', 'Properties': {
            'Family': 'llmar-v9-stub', 'Cpu': '256', 'Memory': '512', 'NetworkMode': 'awsvpc',
            'RequiresCompatibilities': ['FARGATE'],
            'RuntimePlatform': {'CpuArchitecture': 'ARM64', 'OperatingSystemFamily': 'LINUX'},
            'ExecutionRoleArn': att('ExecRole', 'Arn'),
            'ContainerDefinitions': [{
                'Name': 'stub', 'Image': IMAGE, 'Essential': True, 'User': 'node', 'ReadonlyRootFilesystem': True,
                'Command': ['node', '-e', stub], 'Environment': [{'Name': 'PORT', 'Value': str(PORT)}, {'Name': 'HOST', 'Value': '0.0.0.0'}],  # nosec B104 - awsvpc task in a private subnet, no public IP, no published port; SG admits only the hop
                # awsvpc: no host port is published; the task SG (Lattice prefix list only) is the boundary.
                'PortMappings': [{'Name': 'http', 'ContainerPort': PORT, 'Protocol': 'tcp', 'AppProtocol': 'http'}],
                'LogConfiguration': {'LogDriver': 'awslogs', 'Options': {
                    'awslogs-group': ref('StubLogs'), 'awslogs-region': REGION, 'awslogs-stream-prefix': 'stub'}}}],
            'Tags': tl}},
        'StubService': {'Type': 'AWS::ECS::Service', 'DependsOn': ['PrivDefault', 'PrivRtA', 'PrivRtB', 'Listener'], 'Properties': {
            'ServiceName': 'llmar-v9-stub', 'Cluster': ref('Cluster'), 'TaskDefinition': ref('TaskDef'),
            'DesiredCount': 1, 'LaunchType': 'FARGATE', 'PropagateTags': 'SERVICE', 'EnableExecuteCommand': False,
            'DeploymentConfiguration': {'DeploymentCircuitBreaker': {'Enable': True, 'Rollback': False}},
            'NetworkConfiguration': {'AwsvpcConfiguration': {'AssignPublicIp': 'DISABLED',
                                                             'Subnets': [ref('PrivA'), ref('PrivB')],
                                                             'SecurityGroups': [ref('TaskSg')]}},
            'VpcLatticeConfigurations': [{'RoleArn': att('InfraRole', 'Arn'), 'TargetGroupArn': att('TargetGroup', 'Arn'),
                                          'PortName': 'http'}],
            'Tags': tl}},
        # ---- gate probe (check 1): its role is NOT in the auth policy. Lattice requires an allow from BOTH the
        # identity policy and the auth policy, so the probe role gets an identity allow for Invoke: its 403 then
        # proves the auth policy (principal = gateway role) denies it, not merely the missing identity grant.
        'ProbeLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {
            'LogGroupName': '/aws/lambda/llmar-v9-probe', 'RetentionInDays': 3, 'Tags': tl}},
        'ProbeRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9-probe-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'ManagedPolicyArns': ['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
            'Policies': [{'PolicyName': 'identity-allow-invoke', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Action': 'vpc-lattice-svcs:Invoke', 'Resource': sub('${Service.Arn}/*')}]}}],
            'Tags': tl}},
        'ProbeFn': {'Type': 'AWS::Lambda::Function', 'DependsOn': ['SnVpc'], 'Properties': {
            'FunctionName': 'llmar-v9-probe', 'Runtime': 'python3.13', 'Handler': 'index.handler',
            'Architectures': ['arm64'], 'MemorySize': 256, 'Timeout': 60,
            'Role': att('ProbeRole', 'Arn'), 'Code': {'ZipFile': probe},
            'VpcConfig': {'SubnetIds': [ref('PrivA'), ref('PrivB')], 'SecurityGroupIds': [ref('ClientSg')]},
            'LoggingConfig': {'LogGroup': ref('ProbeLogs')}, 'Tags': tl}},
        # ---- AgentCore Gateway (AWS_IAM inbound for the spike driver; the MVP uses CUSTOM_JWT)
        'GatewayRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-v9-gateway-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'bedrock-agentcore.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')},
                              'ArnLike': {'aws:SourceArn': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:*')}}}]},
            'Policies': [{'PolicyName': 'lattice-invoke-only', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'InvokeRouterService', 'Effect': 'Allow', 'Action': 'vpc-lattice-svcs:Invoke',
                 'Resource': sub('${Service.Arn}/*')},
                {'Sid': 'InvokeOwnGateway', 'Effect': 'Allow', 'Action': 'bedrock-agentcore:InvokeGateway',
                 'Resource': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:gateway/' + GATEWAY_NAME + '-*')}]}}],
            'Tags': tl}},
        'Gateway': {'Type': 'AWS::BedrockAgentCore::Gateway', 'Properties': {
            'Name': GATEWAY_NAME, 'AuthorizerType': 'AWS_IAM', 'ExceptionLevel': 'DEBUG',
            'RoleArn': att('GatewayRole', 'Arn'), 'Description': 'llm-auto-router V9 spike (Lattice hop)', 'Tags': TAGS}},
        # ---- R-a3 variant: Lattice refuses *.vpc-lattice-svcs.*.on.aws as a resource configuration domain, so
        # `hop --routing-domain` gives AgentCore a private name (CNAME to the service) as routingDomain while
        # the target endpoint (SNI, Host, SigV4) stays the Lattice service DNS.
        'PrivateZone': {'Type': 'AWS::Route53::HostedZone', 'Properties': {
            'Name': ZONE, 'VPCs': [{'VPCId': ref('Vpc'), 'VPCRegion': REGION}],
            'HostedZoneConfig': {'Comment': 'llmar-v9 spike routingDomain'}, 'HostedZoneTags': tl}},
        'RouterCname': {'Type': 'AWS::Route53::RecordSet', 'Properties': {
            'HostedZoneId': ref('PrivateZone'), 'Name': f'router.{ZONE}.', 'Type': 'CNAME', 'TTL': '60',
            'ResourceRecords': [att('Service', 'DnsEntry.DomainName')]}},
    }
    return {
        'AWSTemplateFormatVersion': '2010-09-09',
        'Description': 'llm-auto-router V9 spike: AgentCore Gateway -> VPC Lattice (AWS_IAM) -> Fargate echo stub. Delete after use.',
        'Parameters': {'LatticePrefixList': {'Type': 'String', 'Description': f'com.amazonaws.{REGION}.vpc-lattice'}},
        'Resources': r,
        'Outputs': {
            'GatewayId': {'Value': ref('Gateway')},
            'GatewayUrl': {'Value': att('Gateway', 'GatewayUrl')},
            'ServiceArn': {'Value': att('Service', 'Arn')},
            'ServiceDns': {'Value': att('Service', 'DnsEntry.DomainName')},
            'TargetGroupId': {'Value': att('TargetGroup', 'Id')},
            'VpcId': {'Value': ref('Vpc')},
            'PrivSubnetIds': {'Value': {'Fn::Join': [',', [ref('PrivA'), ref('PrivB')]]}},
            'ClientSgId': {'Value': ref('ClientSg')},
            'ProbeFn': {'Value': ref('ProbeFn')},
            'RoutingDomain': {'Value': f'router.{ZONE}'},
        },
    }


# ---------------------------------------------------------------- control plane

def cmd_deploy(_: argparse.Namespace) -> None:
    if stack():
        sys.exit(f'stack {STACK} already exists; use status or teardown')
    cfn = session.client('cloudformation')
    cfn.create_stack(StackName=STACK, TemplateBody=json.dumps(template()), Capabilities=['CAPABILITY_NAMED_IAM'],
                     Parameters=[{'ParameterKey': 'LatticePrefixList', 'ParameterValue': lattice_prefix_list()}],
                     Tags=[{'Key': k, 'Value': v} for k, v in TAGS.items()], OnFailure='ROLLBACK')
    print('creating stack', STACK)
    try:
        cfn.get_waiter('stack_create_complete').wait(StackName=STACK, WaiterConfig={'Delay': 15, 'MaxAttempts': 120})
    except Exception as err:  # noqa: BLE001
        try:
            for e in cfn.describe_stack_events(StackName=STACK)['StackEvents']:
                if 'FAILED' in e['ResourceStatus']:
                    print(e['LogicalResourceId'], e['ResourceStatus'], mask(e.get('ResourceStatusReason')))
        except Exception as e:  # noqa: BLE001 - best effort: the stack failure below is the error that matters
            print(f'could not list stack events: {type(e).__name__}')
        sys.exit(f'stack failed: {err}; run teardown before retrying')
    print(json.dumps(mask(outputs()), indent=2))


def cmd_update(_: argparse.Namespace) -> None:
    cfn = session.client('cloudformation')
    cfn.update_stack(StackName=STACK, TemplateBody=json.dumps(template()), Capabilities=['CAPABILITY_NAMED_IAM'],
                     Parameters=[{'ParameterKey': 'LatticePrefixList', 'UsePreviousValue': True}],
                     Tags=[{'Key': k, 'Value': v} for k, v in TAGS.items()])
    cfn.get_waiter('stack_update_complete').wait(StackName=STACK, WaiterConfig={'Delay': 15, 'MaxAttempts': 120})
    print(json.dumps(mask(outputs()), indent=2))


def cmd_untarget(_: argparse.Namespace) -> None:
    """Delete the gateway target only (e.g. after a FAILED hop), keeping the stack and the gate result."""
    delete_targets()


def ctl():
    return session.client('bedrock-agentcore-control')


def lattice():
    return session.client('vpc-lattice')


def target_health() -> list[dict[str, Any]]:
    return lattice().list_targets(targetGroupIdentifier=outputs()['TargetGroupId'])['items']


def task_ip() -> str:
    ecs = session.client('ecs')
    arns = ecs.list_tasks(cluster='llmar-v9', serviceName='llmar-v9-stub', desiredStatus='RUNNING')['taskArns']
    if not arns:
        sys.exit('no running stub task')
    task = ecs.describe_tasks(cluster='llmar-v9', tasks=arns[:1])['tasks'][0]
    for att in task['attachments']:
        for d in att['details']:
            if d['name'] == 'privateIPv4Address':
                return d['value']
    sys.exit('stub task has no private IP yet')


def cmd_status(_: argparse.Namespace) -> None:
    out = outputs()
    print(json.dumps(mask({'outputs': out, 'state': load_state(), 'targets': target_health()}), indent=2, default=str))


def cmd_gate(_: argparse.Namespace) -> None:
    """Check 1: anonymous, wrong-principal and direct-to-task requests are all denied. Run before any target exists."""
    s, out = stack(), outputs()
    if load_state()['targets']:
        sys.exit('STOP: a gateway target already exists; gate must run with no target (teardown and redeploy)')
    for _ in range(36):  # a healthy target makes a non-403 meaningful: denial must come from auth, not from no backend
        health = target_health()
        if any(t.get('status') == 'HEALTHY' for t in health):
            break
        time.sleep(10)
    else:
        sys.exit(f'stub target never became HEALTHY: {mask(health)}')
    service_url = 'https://' + out['ServiceDns']
    probe = json.loads(session.client('lambda').invoke(
        FunctionName=out['ProbeFn'],
        Payload=json.dumps({'serviceUrl': service_url, 'region': REGION, 'taskIp': task_ip(), 'taskPort': PORT}).encode(),
    )['Payload'].read())
    # From outside the VPC: the Lattice service name must not resolve to anything reachable, and the gateway
    # must deny anonymous callers.
    try:
        outside = {'resolved': sorted({a[4][0] for a in socket.getaddrinfo(out['ServiceDns'], 443)})}
    except socket.gaierror as err:
        outside = {'resolved': [], 'error': repr(err)}
    anon = requests.post(gateway_base() + '/inference/v1/messages', json=body_for('/v1/messages', 'v9-echo'), timeout=30)
    checks = {
        'probe_unsigned_403': (probe.get('unsigned') or {}).get('status') == 403,
        'probe_other_role_403': (probe.get('other_role') or {}).get('status') == 403,
        'probe_direct_tcp_timeout': (probe.get('direct_tcp') or {}).get('result') == 'timeout',
        'gateway_anonymous_denied': anon.status_code in (401, 403),
        'service_dns_private_only': all(ip.startswith(('169.254.', '10.', 'fd')) for ip in outside['resolved']),
    }
    res = save_result('gate', {
        'passed': all(checks.values()), 'checks': checks, 'stackCreated': str(s['CreationTime']),
        'probe': probe, 'outside_dns': outside,
        'gateway_anonymous': {'status': anon.status_code, 'body': anon.text[:300],
                              'headers': {k: v for k, v in anon.headers.items() if k.lower().startswith(('x-amzn', 'www-auth'))}},
        'target_health': health})
    print(json.dumps(res['checks'], indent=2))
    if not res['passed']:
        sys.exit('STOP: gate failed; do not create the gateway target. Tear down and investigate.')
    print('GATE PASSED')


def create_target(routing_domain: str | None = None) -> dict[str, Any]:
    state, out = load_state(), outputs()
    if TARGET in state['targets']:
        return {'targetId': state['targets'][TARGET], 'reused': True}
    ops = [{'path': p, 'models': [{'model': 'v9-*'}]} for p in PATHS]
    managed: dict[str, Any] = {
        'vpcIdentifier': out['VpcId'], 'subnetIds': out['PrivSubnetIds'].split(','), 'endpointIpAddressType': 'IPV4',
        'securityGroupIds': [out['ClientSgId']], 'tags': TAGS}
    if routing_domain:
        managed['routingDomain'] = routing_domain
    params: dict[str, Any] = {
        'gatewayIdentifier': out['GatewayId'], 'name': TARGET,
        'targetConfiguration': {'inference': {'provider': {'endpoint': 'https://' + out['ServiceDns'], 'operations': ops}}},
        'credentialProviderConfigurations': [{'credentialProviderType': 'GATEWAY_IAM_ROLE', 'credentialProvider': {
            'iamCredentialProvider': {'service': 'vpc-lattice-svcs', 'region': REGION}}}],
        'privateEndpoint': {'managedVpcResource': managed},
        'metadataConfiguration': {'allowedRequestHeaders': REQ_HEADERS, 'allowedResponseHeaders': RESP_HEADERS},
    }
    result: dict[str, Any] = {'routingDomain': routing_domain}
    try:
        created = ctl().create_gateway_target(**params)
        result['allowlist'] = 'with-forgeable-headers'
    except ctl().exceptions.ValidationException as err:  # refusing x-amz*/x-amzn* in the allowlist is itself a finding (R-a4)
        if 'header' not in str(err).lower():
            raise  # some other shape problem: do not mislabel it as an allowlist refusal
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


def cmd_hop(args: argparse.Namespace) -> None:
    """Check 2: gateway -> Lattice -> stub with SigV4 (vpc-lattice-svcs). Records identity and content-hash headers."""
    require_gate()
    created = create_target(outputs()['RoutingDomain'] if getattr(args, 'routing_domain', False) else None)
    print('target', created.get('status'), created.get('statusReasons') or '')
    res: dict[str, Any] = {'target': created, 'calls': {}}
    if created.get('status') == 'READY':
        time.sleep(20)
        for p in PATHS:
            res['calls'][p] = call(p, body_for(p, 'v9-echo'))
    gw_role = 'assumed-role/llmar-v9-gateway-role/'
    echo = (res['calls'].get('/v1/messages') or {}).get('echo') or {}
    amz = echo.get('amz') or {}
    res['findings'] = {
        'all_200': bool(res['calls']) and all(c.get('status') == 200 for c in res['calls'].values()),
        'lattice_identity_is_gateway_role': gw_role in amz.get('x-amzn-lattice-identity', ''),
        'source_arn_is_gateway': ('gateway/' + outputs()['GatewayId']) in amz.get('x-amz-source-arn', ''),
        'content_sha256': amz.get('x-amz-content-sha256'),  # R-a1: expect UNSIGNED-PAYLOAD
        'authorization_reaches_target': echo.get('authorizationPresent'),
        'header_names_at_target': echo.get('headerNames'),
    }
    print(json.dumps(mask(res['findings']), indent=2))
    if not res['findings']['all_200']:
        for p, c in res['calls'].items():
            print(p, c.get('status'), mask(str(c.get('body'))[:400]))
    save_result('hop-routing-domain' if created.get('routingDomain') else 'hop', res)
    if not res['findings']['all_200']:
        sys.exit('hop did not return 200 on every path; later checks would only measure the failure')


def cmd_forge(_: argparse.Namespace) -> None:
    """Check 3: client-supplied x-amzn-lattice-identity / x-amz-source-arn must not reach the router as sent (R-a4)."""
    require_gate()
    forged = {'x-amzn-lattice-identity': 'Principal=arn:aws:iam::000000000000:role/forged;Type=AWS_IAM',
              'x-amz-source-arn': 'arn:aws:bedrock-agentcore:ap-northeast-1:000000000000:gateway/forged',
              'x-amzn-source-vpc': 'vpc-forged'}
    r = call('/v1/messages', body_for('/v1/messages', 'v9-echo'), headers=forged)
    amz = (r.get('echo') or {}).get('amz') or {}
    res = {'allowlist': load_state().get('allowlist'), 'status': r.get('status'), 'seen': amz,
           'forged_value_reached_router': any('forged' in v for v in amz.values()),
           'body': None if r.get('echo') else r.get('body')}
    save_result('forge', res)
    print(json.dumps(mask({k: res[k] for k in ('allowlist', 'status', 'forged_value_reached_router')}), indent=2))


def cmd_size(_: argparse.Namespace) -> None:
    """Check 4a: 1 / 7 / 12 MB bodies arrive intact (R-a5)."""
    require_gate()
    res = {}
    for mb in (1, 7, 12):
        raw = json.dumps(body_for('/v1/messages', 'v9-echo', filler='x' * (mb * 1024 * 1024))).encode()
        r = call('/v1/messages', raw, timeout=300)
        e = r.get('echo') or {}
        res[f'{mb}MB'] = {'status': r.get('status'), 'sent_len': r['sent_len'], 'recv_len': e.get('len'),
                          'identical': e.get('sha256') == r['sent_sha256'], 'ttfb_ms': r.get('ttfb_ms'),
                          'body': None if e else str(r.get('body') or r.get('error'))[:300]}
        print(mb, 'MB', res[f'{mb}MB']['status'], res[f'{mb}MB']['identical'])
    save_result('size', res)


def cmd_cadence(_: argparse.Namespace) -> None:
    """Check 4b: SSE cadence (100 ms ticks), a 5-min silent gap (idle 600), and a 10.5-min stream (cut at 10 min?).
    The two long probes run in parallel; total wall time is about 11 minutes."""
    require_gate()
    res: dict[str, Any] = {}
    for p in PATHS:
        r = call(p, body_for(p, 'v9-sse', stream=True), stream=True)
        gaps = [b['t_ms'] - a['t_ms'] for a, b in zip(r.get('arrivals', []), r.get('arrivals', [])[1:])]
        res[f'sse{p}'] = {'status': r.get('status'), 'chunks': len(r.get('arrivals', [])), 'completed': r.get('completed'),
                          'median_gap_ms': statistics.median(gaps) if gaps else None, 'duration_ms': r.get('duration_ms')}
    def long(name: str, model: str) -> None:
        r = call('/v1/messages', body_for('/v1/messages', model, stream=True), stream=True, timeout=(10, 900))
        res[name] = {k: r.get(k) for k in ('status', 'completed', 'stream_error', 'duration_ms', 'events')}
        res[name]['last_arrival_ms'] = (r.get('arrivals') or [{}])[-1].get('t_ms')
    threads = [threading.Thread(target=long, args=('gap300', 'v9-gap300')),
               threading.Thread(target=long, args=('long630', 'v9-long630'))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    save_result('cadence', res)
    print(json.dumps(mask(res), indent=2))


def cmd_lat(_: argparse.Namespace) -> None:
    """Check 5: TTFB through gateway -> Lattice -> Fargate (10 warm calls) vs the spike's Lambda URL path."""
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
    res: dict[str, Any] = {'gateway_lattice_fargate': {'p50': statistics.median(samples), 'min': min(samples),
                                                       'max': max(samples), 'all': samples}}
    prior = HERE.parent / 'agentcore-gateway' / 'results' / 'lat.json'
    if prior.exists():
        p = json.loads(prior.read_text())
        res['spike_lambda_url'] = {k: p[k]['p50'] for k in ('direct', 'gateway_inference') if k in p}
        if 'gateway_inference' in p:
            res['delta_p50_ms_vs_gateway_lambda_url'] = res['gateway_lattice_fargate']['p50'] - p['gateway_inference']['p50']
    save_result('lat', res)
    print(json.dumps({k: v for k, v in res.items() if k != 'gateway_lattice_fargate'} | {'p50': res['gateway_lattice_fargate']['p50']}))


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
    vpcs = session.client('ec2').describe_vpcs(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9-vpc']}])['Vpcs']
    return vpcs[0]['VpcId'] if vpcs else None


def resource_gateways(vpc: str | None) -> list[dict[str, Any]]:
    if not vpc:
        return []
    return [g for g in pages(lattice(), 'list_resource_gateways', 'items') if g.get('vpcIdentifier') == vpc]


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
    """Verification listing: anything named llmar-v9* or tagged Purpose=spike under this project."""
    ec2, lat = session.client('ec2'), lattice()
    tagged = {'ResourceTagMappingList': pages(session.client('resourcegroupstaggingapi'), 'get_resources', 'ResourceTagMappingList',
                                              TagFilters=[{'Key': 'Project', 'Values': ['llm-auto-router']},
                                                          {'Key': 'Purpose', 'Values': ['spike']}])}
    left = {
        'stack': bool(stack()),
        'tagged_spike_resources': [r['ResourceARN'] for r in tagged['ResourceTagMappingList']],
        'gateways': [g['name'] for g in pages(ctl(), 'list_gateways', 'items') if g['name'].startswith('llmar-v9')],
        'service_networks': [n['name'] for n in pages(lat, 'list_service_networks', 'items') if n['name'].startswith('llmar-v9')],
        'services': [n['name'] for n in pages(lat, 'list_services', 'items') if n['name'].startswith('llmar-v9')],
        'target_groups': [n['name'] for n in pages(lat, 'list_target_groups', 'items') if n['name'].startswith('llmar-v9')],
        'resource_gateways_in_vpc': [g['name'] for g in resource_gateways(vpc_id())],
        'ecs_clusters': [c['clusterName'] for c in session.client('ecs').describe_clusters(clusters=['llmar-v9'])['clusters']
                         if c['status'] == 'ACTIVE'],
        'vpcs': [v['VpcId'] for v in ec2.describe_vpcs(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9-vpc']}])['Vpcs']],
        'nat_gateways': [n['NatGatewayId'] for n in ec2.describe_nat_gateways(
            Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9-nat']}])['NatGateways'] if n['State'] not in ('deleted', 'deleting')],
        'eips': [a['AllocationId'] for a in ec2.describe_addresses(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-v9-nat-eip']}])['Addresses']],
        'log_groups': [g['logGroupName'] for p in ('/llmar/v9', '/aws/lambda/llmar-v9')
                       for g in session.client('logs').describe_log_groups(logGroupNamePrefix=p)['logGroups']],
        'iam_roles': [r['RoleName'] for r in pages(session.client('iam'), 'list_roles', 'Roles') if r['RoleName'].startswith('llmar-v9')],
        'hosted_zones': [z['Id'] for z in pages(session.client('route53'), 'list_hosted_zones', 'HostedZones')
                         if z['Name'] == ZONE + '.'],
    }
    # Tagged spike resources may include the earlier agentcore spike; only llmar-v9 ones count against this teardown.
    v9_tagged = [a for a in left['tagged_spike_resources'] if 'llmar-v9' in a or (left['vpcs'] and left['vpcs'][0] in a)]
    remaining = {k: v for k, v in left.items() if v and k != 'tagged_spike_resources'}
    # The tagging API keeps listing deleted (INACTIVE) ECS clusters for a while; the cluster check above is authoritative.
    # ECS keeps INACTIVE services/task definitions and STOPPED tasks visible for a while; with no ACTIVE cluster
    # they are tombstones, not resources.
    v9_tagged = [a for a in v9_tagged if not (':ecs:' in a and not left['ecs_clusters'])]
    if v9_tagged:
        remaining['tagged_v9'] = v9_tagged
    save_result('teardown', {'remaining': remaining, 'all_tagged_spike_resources': left['tagged_spike_resources']})
    if remaining:
        print(json.dumps(mask(remaining), indent=2))
        sys.exit('teardown NOT verified: resources remain')
    print('teardown verified: nothing left')


def main() -> None:
    commands = {n[4:]: f for n, f in globals().items() if n.startswith('cmd_')}
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=sorted(commands))
    parser.add_argument('--print-template', action='store_true', help='print the template and exit (no AWS calls)')
    parser.add_argument('--routing-domain', action='store_true',
                        help='hop: set managedVpcResource.routingDomain to the private CNAME (R-a3 variant)')
    args = parser.parse_args()
    check_account()
    commands[args.command](args)


if __name__ == '__main__':
    if '--print-template' in sys.argv:
        print(json.dumps(template(), indent=1))
        sys.exit(0)
    main()
