# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.40", "requests>=2.32"]
# ///
"""AgentCore Gateway front-door spike (ap-northeast-1).

Usage: uv run spikes/agentcore-gateway/spike.py <command> [...]
Commands: deploy | status | gate | v0 | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 | teardown

Every resource is named llmar-spike-* and tagged Project=llm-auto-router, Purpose=spike. Resources
created outside the CloudFormation stack are recorded in state.json and deleted by `teardown` before the
stack itself. The echo stub never holds model permissions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import time
import uuid
from typing import Any

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = 'ap-northeast-1'
ACCOUNT = os.environ.get('LLMAR_SPIKE_ACCOUNT', '')  # set in scripts/local.env (gitignored)
STACK = 'llmar-spike'
GATEWAY_NAME = 'llmar-spike-gw'
# Owner tag is optional (LLMAR_OWNER); nothing personal is baked into the repo.
TAGS = {'Project': 'llm-auto-router', 'Purpose': 'spike', **({'Owner': os.environ['LLMAR_OWNER']} if os.environ.get('LLMAR_OWNER') else {})}
HERE = pathlib.Path(__file__).resolve().parent
STATE = HERE / 'state.json'
RESULTS = HERE / 'results'
HAIKU = 'global.anthropic.claude-haiku-5-5'
LUNA = 'global.openai.gpt-6-luna'
REQ_HEADERS = ['x-claude-code-session-id', 'x-session-id', 'anthropic-beta', 'anthropic-version', 'x-router-session',
               'x-router-parent-session', 'x-router-agent-id', 'x-router-hint', 'openai-beta', 'x-stainless-lang']
RESP_HEADERS = ['x-router-decision', 'x-router-model', 'x-stub-sha256']

session = boto3.Session(region_name=REGION)


# ---------------------------------------------------------------- helpers

def check_account() -> None:
    if not ACCOUNT:
        sys.exit('set LLMAR_SPIKE_ACCOUNT (scripts/local.env) to the account this spike may touch')
    ident = session.client('sts').get_caller_identity()
    if ident['Account'] != ACCOUNT:
        sys.exit(f"refusing to run: account {ident['Account']} is not {ACCOUNT}")


def load_state() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {'targets': {}, 'rules': {}}


def save_state(state: dict[str, Any]) -> None:
    STATE.write_text(json.dumps(state, indent=2, sort_keys=True))


def save_result(name: str, data: Any) -> None:
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / f'{name}.json').write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str))
    print(f'-> results/{name}.json')


def signed(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None,
           service: str = 'bedrock-agentcore', stream: bool = False) -> requests.Response:
    creds = session.get_credentials().get_frozen_credentials()
    hdrs = {'content-type': 'application/json', **(headers or {})}
    req = AWSRequest(method=method, url=url, data=body, headers=hdrs)
    SigV4Auth(creds, service, REGION).add_auth(req)
    return requests.request(method, url, data=body, headers=dict(req.headers), stream=stream, timeout=180)


def read_stream(resp: requests.Response) -> dict[str, Any]:
    """Read an SSE response, recording when each network chunk arrived."""
    start = time.time()
    arrivals, buf = [], b''
    for chunk in resp.iter_content(chunk_size=None):
        arrivals.append({'t_ms': round((time.time() - start) * 1000), 'bytes': len(chunk)})
        buf += chunk
    events = [e for e in buf.decode('utf-8', 'replace').split('\n\n') if e.strip()]
    return {'status': resp.status_code, 'arrivals': arrivals, 'events': events,
            'headers': dict(resp.headers)}


def summarize(resp: requests.Response) -> dict[str, Any]:
    text = resp.text
    try:
        body: Any = json.loads(text)
    except ValueError:
        body = text[:2000]
    return {'status': resp.status_code, 'headers': dict(resp.headers), 'body': body}


def stub_echo(result: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the stub's echo metadata from a non-streaming response body."""
    body = result.get('body')
    if not isinstance(body, dict):
        return None
    for path in (('content', 0, 'text'), ('choices', 0, 'message', 'content'), ('output', 0, 'content', 0, 'text')):
        node: Any = body
        try:
            for key in path:
                node = node[key]
            return json.loads(node)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
    return None


def outputs() -> dict[str, str]:
    stack = session.client('cloudformation').describe_stacks(StackName=STACK)['Stacks'][0]
    return {o['OutputKey']: o['OutputValue'] for o in stack.get('Outputs', [])}


def gateway_base() -> str:
    url = outputs()['GatewayUrl']
    return url.split('/', 3)[0] + '//' + url.split('/', 3)[2]


# ---------------------------------------------------------------- template

def template() -> dict[str, Any]:
    code = (HERE / 'stub' / 'index.js').read_text()
    tag_list = [{'Key': k, 'Value': v} for k, v in TAGS.items()]
    sub = lambda s: {'Fn::Sub': s}  # noqa: E731
    return {
        'AWSTemplateFormatVersion': '2010-09-09',
        'Description': 'llm-auto-router spike: AgentCore Gateway front door + echo stub. Delete after use.',
        'Resources': {
            'StubLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {
                'LogGroupName': '/aws/lambda/llmar-spike-stub', 'RetentionInDays': 3, 'Tags': tag_list}},
            'StubRole': {'Type': 'AWS::IAM::Role', 'Properties': {
                'RoleName': 'llmar-spike-stub-role',
                'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                    'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]},
                'Policies': [{'PolicyName': 'logs-only', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                    'Effect': 'Allow', 'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    'Resource': {'Fn::GetAtt': ['StubLogs', 'Arn']}}]}}],
                'Tags': tag_list}},
            'StubFn': {'Type': 'AWS::Lambda::Function', 'Properties': {
                'FunctionName': 'llmar-spike-stub', 'Runtime': 'nodejs22.x', 'Handler': 'index.handler',
                'Architectures': ['arm64'], 'MemorySize': 256, 'Timeout': 60,
                'Role': {'Fn::GetAtt': ['StubRole', 'Arn']}, 'Code': {'ZipFile': code},
                'LoggingConfig': {'LogGroup': {'Ref': 'StubLogs'}}, 'Tags': tag_list}},
            'StubUrl': {'Type': 'AWS::Lambda::Url', 'Properties': {
                'TargetFunctionArn': {'Fn::GetAtt': ['StubFn', 'Arn']}, 'AuthType': 'AWS_IAM',
                'InvokeMode': 'RESPONSE_STREAM'}},
            'GatewayRole': {'Type': 'AWS::IAM::Role', 'Properties': {
                'RoleName': 'llmar-spike-gateway-role',
                'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                    'Effect': 'Allow', 'Principal': {'Service': 'bedrock-agentcore.amazonaws.com'},
                    'Action': 'sts:AssumeRole',
                    'Condition': {'StringEquals': {'aws:SourceAccount': {'Ref': 'AWS::AccountId'}},
                                  'ArnLike': {'aws:SourceArn': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:*')}}}]},
                'Policies': [{'PolicyName': 'spike', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                    {'Sid': 'InvokeAllowedModelsOnly', 'Effect': 'Allow',
                     'Action': ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                     'Resource': [
                         sub('arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/' + HAIKU),
                         sub('arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/jp.anthropic.claude-haiku-5-5'),
                         sub('arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/' + LUNA),
                         'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5*',
                         'arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-5-5*',
                         'arn:aws:bedrock:*::foundation-model/openai.gpt-6-luna*',
                         'arn:aws:bedrock:::foundation-model/openai.gpt-6-luna*',
                         sub('arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:project/*')]},
                    {'Sid': 'ConnectorDiscovery', 'Effect': 'Allow', 'Resource': '*', 'Action': [
                        'bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles',
                        'bedrock:ListProvisionedModelThroughputs', 'bedrock:ListCustomModelDeployments',
                        'bedrock:ListImportedModels', 'bedrock:ListMarketplaceModelEndpoints',
                        'bedrock:ListPromptRouters', 'bedrock:GetInferenceProfile', 'bedrock:GetFoundationModel']},
                    {'Sid': 'InvokeStubOnly', 'Effect': 'Allow',
                     'Action': ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'],
                     'Resource': {'Fn::GetAtt': ['StubFn', 'Arn']}},
                    {'Sid': 'InvokeOwnGateway', 'Effect': 'Allow', 'Action': 'bedrock-agentcore:InvokeGateway',
                     'Resource': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:gateway/' + GATEWAY_NAME + '-*')}]}}],
                'Tags': tag_list}},
            'Gateway': {'Type': 'AWS::BedrockAgentCore::Gateway', 'Properties': {
                'Name': GATEWAY_NAME, 'AuthorizerType': 'AWS_IAM', 'ExceptionLevel': 'DEBUG',
                'RoleArn': {'Fn::GetAtt': ['GatewayRole', 'Arn']},
                'Description': 'llm-auto-router spike front door', 'Tags': TAGS}},
            'BedrockTarget': {'Type': 'AWS::BedrockAgentCore::GatewayTarget', 'Properties': {
                'GatewayIdentifier': {'Ref': 'Gateway'}, 'Name': 'bedrock',
                'TargetConfiguration': {'Inference': {'Connector': {'Source': {'ConnectorId': 'bedrock-runtime'}}}},
                'CredentialProviderConfigurations': [{'CredentialProviderType': 'GATEWAY_IAM_ROLE'}]}},
            'Vpc': {'Type': 'AWS::EC2::VPC', 'Properties': {
                'CidrBlock': '10.88.0.0/24', 'EnableDnsSupport': True, 'EnableDnsHostnames': True,
                'Tags': tag_list + [{'Key': 'Name', 'Value': 'llmar-spike-vpc'}]}},
            'SubnetA': {'Type': 'AWS::EC2::Subnet', 'Properties': {
                'VpcId': {'Ref': 'Vpc'}, 'CidrBlock': '10.88.0.0/26',
                'AvailabilityZone': {'Fn::Select': [0, {'Fn::GetAZs': ''}]}, 'Tags': tag_list}},
            'SubnetB': {'Type': 'AWS::EC2::Subnet', 'Properties': {
                'VpcId': {'Ref': 'Vpc'}, 'CidrBlock': '10.88.0.64/26',
                'AvailabilityZone': {'Fn::Select': [1, {'Fn::GetAZs': ''}]}, 'Tags': tag_list}},
            'Sg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
                'GroupDescription': 'llmar spike: no ingress, egress 443 inside the VPC only',
                'VpcId': {'Ref': 'Vpc'},
                'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'CidrIp': '10.88.0.0/24'}],
                'Tags': tag_list}},
        },
        'Outputs': {
            'GatewayId': {'Value': {'Ref': 'Gateway'}},
            'GatewayUrl': {'Value': {'Fn::GetAtt': ['Gateway', 'GatewayUrl']}},
            'StubUrl': {'Value': {'Fn::GetAtt': ['StubUrl', 'FunctionUrl']}},
            'StubArn': {'Value': {'Fn::GetAtt': ['StubFn', 'Arn']}},
            'VpcId': {'Value': {'Ref': 'Vpc'}},
            'SubnetIds': {'Value': {'Fn::Join': [',', [{'Ref': 'SubnetA'}, {'Ref': 'SubnetB'}]]}},
            'SgId': {'Value': {'Ref': 'Sg'}},
        },
    }


# ---------------------------------------------------------------- control plane

def cmd_deploy(_: argparse.Namespace) -> None:
    cfn = session.client('cloudformation')
    cfn.create_stack(StackName=STACK, TemplateBody=json.dumps(template()), Capabilities=['CAPABILITY_NAMED_IAM'],
                     Tags=[{'Key': k, 'Value': v} for k, v in TAGS.items()])
    print('creating stack', STACK)
    try:
        cfn.get_waiter('stack_create_complete').wait(StackName=STACK, WaiterConfig={'Delay': 10, 'MaxAttempts': 90})
    except Exception as err:  # print the failure reasons, then stop
        events = cfn.describe_stack_events(StackName=STACK)['StackEvents']
        for e in events:
            if 'FAILED' in e['ResourceStatus']:
                print(e['LogicalResourceId'], e['ResourceStatus'], e.get('ResourceStatusReason'))
        sys.exit(f'stack failed: {err}')
    print(json.dumps(outputs(), indent=2))


def cmd_update(_: argparse.Namespace) -> None:
    cfn = session.client('cloudformation')
    cfn.update_stack(StackName=STACK, TemplateBody=json.dumps(template()), Capabilities=['CAPABILITY_NAMED_IAM'],
                     Tags=[{'Key': k, 'Value': v} for k, v in TAGS.items()])
    cfn.get_waiter('stack_update_complete').wait(StackName=STACK, WaiterConfig={'Delay': 10, 'MaxAttempts': 90})
    print('stack updated')


def ctl():
    return session.client('bedrock-agentcore-control')


def wait_target(gw: str, target_id: str) -> dict[str, Any]:
    for _ in range(60):
        t = ctl().get_gateway_target(gatewayIdentifier=gw, targetId=target_id)
        if t['status'] not in ('CREATING', 'UPDATING'):
            return t
        time.sleep(5)
    return t


def create_target(name: str, config: dict[str, Any], creds: list[dict[str, Any]],
                  private: dict[str, Any] | None = None, metadata: bool = True) -> dict[str, Any]:
    state = load_state()
    gw = outputs()['GatewayId']
    params: dict[str, Any] = {'gatewayIdentifier': gw, 'name': name, 'targetConfiguration': config,
                              'credentialProviderConfigurations': creds}
    if metadata:
        params['metadataConfiguration'] = {'allowedRequestHeaders': REQ_HEADERS, 'allowedResponseHeaders': RESP_HEADERS}
    if private:
        params['privateEndpoint'] = private
    try:
        created = ctl().create_gateway_target(**params)
    except Exception as err:  # the API refusing a shape is itself a finding
        return {'name': name, 'accepted': False, 'error': str(err)}
    state['targets'][name] = created['targetId']
    save_state(state)
    final = wait_target(gw, created['targetId'])
    return {'name': name, 'accepted': True, 'targetId': created['targetId'], 'status': final['status'],
            'statusReasons': final.get('statusReasons')}


def delete_target(name: str) -> None:
    state = load_state()
    target_id = state['targets'].get(name)
    if not target_id:
        return
    gw = outputs()['GatewayId']
    try:
        ctl().delete_gateway_target(gatewayIdentifier=gw, targetId=target_id)
        for _ in range(60):
            ctl().get_gateway_target(gatewayIdentifier=gw, targetId=target_id)
            time.sleep(5)
    except ctl().exceptions.ResourceNotFoundException:
        pass
    state['targets'].pop(name, None)
    save_state(state)


def stub_endpoint() -> str:
    return outputs()['StubUrl'].rstrip('/')


def inference_cfg(prefix: str) -> dict[str, Any]:
    ops = [{'path': p, 'models': [{'model': f'{prefix}-*'}]} for p in ('/v1/messages', '/v1/chat/completions', '/v1/responses')]
    return {'inference': {'provider': {'endpoint': stub_endpoint(), 'operations': ops}}}


IAM_LAMBDA = {'credentialProviderType': 'GATEWAY_IAM_ROLE',
              'credentialProvider': {'iamCredentialProvider': {'service': 'lambda', 'region': REGION}}}


# ---------------------------------------------------------------- probes

def body_for(path: str, model: str, stream: bool = False, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    if path.endswith('/v1/messages'):
        b: dict[str, Any] = {'model': model, 'max_tokens': 16, 'messages': [{'role': 'user', 'content': 'ping'}]}
    elif path.endswith('/v1/chat/completions'):
        b = {'model': model, 'max_completion_tokens': 16, 'messages': [{'role': 'user', 'content': 'ping'}]}
    else:
        b = {'model': model, 'input': 'ping', 'max_output_tokens': 16}
    if stream:
        b['stream'] = True
    b.update(extra or {})
    return b


def call(url: str, body: dict[str, Any] | bytes, headers: dict[str, str] | None = None, stream: bool = False) -> dict[str, Any]:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    if url.endswith('/v1/messages'):
        headers = {'anthropic-version': '2023-06-01', **(headers or {})}
    t0 = time.time()
    resp = signed('POST', url, raw, headers, stream=stream)
    ttfb = round((time.time() - t0) * 1000)
    result = read_stream(resp) if stream else summarize(resp)
    result['ttfb_ms'] = ttfb
    result['sent_sha256'] = hashlib.sha256(raw).hexdigest()
    result['sent_len'] = len(raw)
    return result


def cmd_gate(_: argparse.Namespace) -> None:
    """Anonymous requests must be denied by the IAM gates before any test traffic."""
    out = outputs()
    res = {}
    for name, url in (('stub_url', out['StubUrl']), ('gateway_inference', gateway_base() + '/inference/v1/messages')):
        r = requests.post(url, json=body_for('/v1/messages', 'stubi-echo'), timeout=30)
        res[name] = {'status': r.status_code, 'headers': {k: v for k, v in r.headers.items()
                                                           if k.lower().startswith(('x-amzn', 'www-auth'))},
                     'body': r.text[:300]}
    save_result('gate', res)
    print(json.dumps(res, indent=2))
    if any(v['status'] < 400 for v in res.values()):
        sys.exit('STOP: an anonymous request was not denied')


def cmd_v0(_: argparse.Namespace) -> None:
    """Outbound SigV4 from the gateway to the stub, for each target shape."""
    variants = {
        'stubi': (inference_cfg('stubi'), [{'credentialProviderType': 'GATEWAY_IAM_ROLE'}]),
        'stubx': (inference_cfg('stubx'), [IAM_LAMBDA]),
        'stubhttp': ({'http': {'passthrough': {'endpoint': stub_endpoint(), 'protocolType': 'INFERENCE'}}}, [IAM_LAMBDA]),
        'stubcaller': ({'http': {'passthrough': {'endpoint': stub_endpoint(), 'protocolType': 'INFERENCE'}}},
                       [{'credentialProviderType': 'CALLER_IAM_CREDENTIALS'}]),
    }
    base, res = gateway_base(), {}
    for name, (cfg, creds) in variants.items():
        created = create_target(name, cfg, creds)
        probe = None
        if created.get('accepted') and created.get('status') == 'READY':
            url = base + ('/inference/v1/messages' if name in ('stubi', 'stubx') else f'/{name}/v1/messages')
            probe = call(url, body_for('/v1/messages', f'{name}-echo'))
            probe['echo'] = stub_echo(probe)
        res[name] = {'create': created, 'probe': probe}
        print(name, created.get('status') or created.get('error'), probe and probe['status'])
    save_result('v0', res)


def cmd_v0b(_: argparse.Namespace) -> None:
    """CALLER_IAM_CREDENTIALS with an explicit signing service: does the target see the real caller?"""
    cfg = {'http': {'passthrough': {'endpoint': stub_endpoint(), 'protocolType': 'INFERENCE'}}}
    creds = [{'credentialProviderType': 'CALLER_IAM_CREDENTIALS',
              'credentialProvider': {'iamCredentialProvider': {'service': 'lambda', 'region': REGION}}}]
    created = create_target('stubcallerx', cfg, creds)
    probe = None
    if created.get('accepted') and created.get('status') == 'READY':
        probe = call(gateway_base() + '/stubcallerx/v1/messages', body_for('/v1/messages', 'stubcallerx-echo'))
        probe['echo'] = stub_echo(probe)
    res = {'create': created, 'probe': probe and {'status': probe['status'], 'body': probe['body'] if not probe['echo'] else None,
                                                  'caller': (probe['echo'] or {}).get('caller')}}
    save_result('v0b', res)
    print(json.dumps(res, indent=2, default=str)[:3000])


def cmd_v1(_: argparse.Namespace) -> None:
    """Does a provider/passthrough target accept privateEndpoint (managed VPC Lattice)?"""
    out = outputs()
    private = {'managedVpcResource': {'vpcIdentifier': out['VpcId'], 'subnetIds': out['SubnetIds'].split(','),
                                      'endpointIpAddressType': 'IPV4', 'securityGroupIds': [out['SgId']]}}
    fake = 'https://router.llmar-spike.internal'
    res = {
        'inference': create_target('privinf', {'inference': {'provider': {'endpoint': fake, 'operations': [
            {'path': '/v1/messages', 'models': [{'model': 'privinf-*'}]}]}}}, [IAM_LAMBDA], private=private, metadata=False),
        'http': create_target('privhttp', {'http': {'passthrough': {'endpoint': fake, 'protocolType': 'INFERENCE'}}},
                              [IAM_LAMBDA], private=private, metadata=False),
    }
    save_result('v1', res)
    print(json.dumps(res, indent=2))
    for name in ('privinf', 'privhttp'):
        delete_target(name)


def working_routes() -> dict[str, str]:
    """Base URL per working stub target, from the V0 results."""
    v0 = json.loads((RESULTS / 'v0.json').read_text())
    base, routes = gateway_base(), {}
    for name, r in v0.items():
        if r.get('probe') and r['probe']['status'] == 200:
            routes[name] = base + ('/inference' if name in ('stubi', 'stubx') else f'/{name}')
    return routes


def cmd_v2(_: argparse.Namespace) -> None:
    """Byte fidelity and SSE incrementality for the three APIs, plus the direct-to-stub baseline."""
    res: dict[str, Any] = {}
    for name, base in working_routes().items():
        for path in ('/v1/messages', '/v1/chat/completions', '/v1/responses'):
            b = body_for(path, f'{name}-echo')
            # Unsorted keys, odd spacing and non-ASCII text: any re-serialization changes the hash.
            raw = ('{"model": "%s",  "zeta":1, "alpha":{"b":2,"a":1}, "text":"café \\u00e9", %s}'
                   % (b['model'], json.dumps({k: v for k, v in b.items() if k != 'model'})[1:-1])).encode()
            plain = call(base + path, raw)
            echo = stub_echo(plain) or {}
            streamed = call(base + path, body_for(path, f'{name}-echo', stream=True), stream=True)
            res[f'{name}{path}'] = {'status': plain['status'], 'sent_sha256': plain['sent_sha256'],
                                    'recv_sha256': echo.get('sha256'), 'identical': echo.get('sha256') == plain['sent_sha256'],
                                    'recv_len': echo.get('len'), 'sent_len': plain['sent_len'], 'ttfb_ms': plain['ttfb_ms'],
                                    'stream_status': streamed['status'], 'stream_arrivals': streamed['arrivals'],
                                    'stream_ttfb_ms': streamed['ttfb_ms']}
    # Baseline: the stub URL called directly with SigV4 (service lambda).
    direct = signed('POST', stub_endpoint() + '/v1/messages', json.dumps(body_for('/v1/messages', 'direct', True)).encode(),
                    service='lambda', stream=True)
    res['direct_stub_stream'] = read_stream(direct)['arrivals']
    save_result('v2', res)


def cmd_lat(_: argparse.Namespace) -> None:
    """Extra-hop latency: time to first byte, direct to the stub vs through the gateway (10 warm calls each)."""
    import statistics
    body = json.dumps(body_for('/v1/messages', 'stubx-echo')).encode()
    def ttfb(fn) -> list[int]:
        fn()  # warm up
        out = []
        for _ in range(10):
            t0 = time.time()
            r = fn()
            r.raw.read(1)
            out.append(round((time.time() - t0) * 1000))
        return out
    direct = ttfb(lambda: signed('POST', stub_endpoint() + '/v1/messages', body, service='lambda', stream=True))
    inference = ttfb(lambda: signed('POST', gateway_base() + '/inference/v1/messages', body, stream=True))
    http = ttfb(lambda: signed('POST', gateway_base() + '/stubhttp/v1/messages', body.replace(b'stubx', b'stubhttp'), stream=True))
    res = {k: {'p50': statistics.median(v), 'min': min(v), 'max': max(v), 'all': v}
           for k, v in (('direct', direct), ('gateway_inference', inference), ('gateway_http', http))}
    save_result('lat', res)
    print(json.dumps({k: {'p50': v['p50'], 'min': v['min'], 'max': v['max']} for k, v in res.items()}))


def cmd_v3(_: argparse.Namespace) -> None:
    """Which headers reach the target, and which response headers come back."""
    sent = {h: f'v-{h}' for h in REQ_HEADERS}
    sent.update({'x-unlisted-header': 'v-unlisted', 'user-agent': 'llmar-spike/1.0', 'x-forwarded-for': '203.0.113.9'})
    sent['anthropic-version'] = '2023-06-01'
    res = {}
    for name, base in working_routes().items():
        r = call(base + '/v1/messages', body_for('/v1/messages', f'{name}-echo'), headers=sent)
        echo = stub_echo(r) or {}
        got = {k.lower(): v for k, v in (echo.get('headers') or {}).items()}
        res[name] = {'received_by_target': got, 'caller_identity_seen': echo.get('caller'),
                     'response_headers': {k: v for k, v in r['headers'].items() if k.lower().startswith(('x-router', 'x-stub'))}}
    save_result('v3', res)


def cmd_v4(_: argparse.Namespace) -> None:
    """Model id handling: glob, qualified id, Bedrock id, unknown id."""
    base = gateway_base() + '/inference/v1/messages'
    cases = {'glob': 'stubx-echo', 'qualified': 'stubx/stubx-echo', 'qualified_nomatch': 'stubx/other',
             'bedrock_exact': HAIKU, 'bedrock_qualified': 'bedrock/' + HAIKU, 'unknown': 'nobody-knows-this'}
    res = {}
    for case, model in cases.items():
        r = call(base, body_for('/v1/messages', model))
        echo = stub_echo(r)
        res[case] = {'sent_model': model, 'status': r['status'],
                     'target_saw_model': echo.get('model') if echo else None,
                     'served_by': 'stub' if echo else ('bedrock' if r['status'] == 200 else None),
                     'body': None if echo else r['body']}
    save_result('v4', res)


def cmd_v5(_: argparse.Namespace) -> None:
    """Request-size limit (stub path, then Bedrock path with oversized prompts only)."""
    base = gateway_base() + '/inference/v1/messages'
    res: dict[str, Any] = {'stub': {}, 'bedrock': {}}
    def padded(model: str, mb: float) -> bytes:
        filler = 'x' * int(mb * 1024 * 1024)
        return json.dumps({'model': model, 'max_tokens': 1, 'messages': [{'role': 'user', 'content': filler}]}).encode()
    for mb in (1, 5, 7, 10):
        r = call(base, padded('stubx-echo', mb))
        echo = stub_echo(r)
        res['stub'][f'{mb}MB'] = {'status': r['status'], 'recv_len': echo.get('len') if echo else None,
                                  'body': None if echo else str(r['body'])[:300]}
    for mb in (7, 12, 24):  # far beyond any context window: rejected by Bedrock or by the gateway, never billed
        r = call(base, padded(HAIKU, mb))
        res['bedrock'][f'{mb}MB'] = {'status': r['status'], 'body': str(r['body'])[:300]}
    save_result('v5', res)


def cmd_v6(_: argparse.Namespace) -> None:
    """Fallback from the stub target (forced 503) to Bedrock with a pinned model."""
    state, gw = load_state(), outputs()['GatewayId']
    rule = ctl().create_gateway_rule(
        gatewayIdentifier=gw, priority=100, description='llmar spike: stubx-503 falls back to Bedrock Haiku',
        conditions=[{'matchModels': {'anyOf': [{'value': 'stubx-503'}]}}],
        actions=[{'routeToTarget': {'staticRoute': {'targetName': 'stubx', 'fallback': {
            'triggerOn': {'statusCodes': ['5XX']}, 'targetFallback': [{'targetName': 'bedrock', 'model': HAIKU}]}}}}])
    state['rules']['fallback'] = rule['ruleId']
    save_state(state)
    time.sleep(35)  # rules propagate within 30 s
    res = {'rule': rule.get('ruleId'),
           'non_stream': call(gateway_base() + '/inference/v1/messages', body_for('/v1/messages', 'stubx-503')),
           'stream': call(gateway_base() + '/inference/v1/messages', body_for('/v1/messages', 'stubx-503', stream=True), stream=True)}
    save_result('v6', res)


def cmd_v7(_: argparse.Namespace) -> None:
    """GET/DELETE of stored Responses through the gateway (stub and real Bedrock)."""
    base, res = gateway_base(), {}
    for name, url in (('inference', base + '/inference/v1/responses/resp_stub123'),
                      ('passthrough', base + '/stubhttp/v1/responses/resp_stub123')):
        res[f'{name}_get'] = summarize(signed('GET', url))
        res[f'{name}_delete'] = summarize(signed('DELETE', url))
    created = call(base + '/inference/v1/responses', {'model': LUNA, 'input': 'Say ok.', 'max_output_tokens': 16, 'store': True})
    res['bedrock_create'] = created
    rid = created['body'].get('id') if isinstance(created['body'], dict) else None
    if rid:
        res['bedrock_get'] = summarize(signed('GET', f'{base}/inference/v1/responses/{rid}'))
        res['bedrock_delete'] = summarize(signed('DELETE', f'{base}/inference/v1/responses/{rid}'))
    save_result('v7', res)


def cmd_v8(_: argparse.Namespace) -> None:
    """cache_control through the gateway to Bedrock, 5m then 1h (with and without anthropic-beta)."""
    base = gateway_base() + '/inference/v1/messages'
    system_text = ' '.join(f'Rule {i}: answer briefly and cite rule numbers when relevant.' for i in range(400))
    def req(tag: str, ttl: str | None) -> dict[str, Any]:
        cc: dict[str, Any] = {'type': 'ephemeral'}
        if ttl:
            cc['ttl'] = ttl
        return {'model': HAIKU, 'max_tokens': 8,
                'system': [{'type': 'text', 'text': f'[{tag}] ' + system_text, 'cache_control': cc}],
                'messages': [{'role': 'user', 'content': 'Say ok.'}]}
    run = uuid.uuid4().hex[:8]
    res = {}
    for label, ttl, headers in (('ttl5m', None, {}), ('ttl1h', '1h', {}),
                                ('ttl1h_beta', '1h', {'anthropic-beta': 'extended-cache-ttl-2025-04-11'})):
        first = call(base, req(f'{run}-{label}', ttl), headers)
        second = call(base, req(f'{run}-{label}', ttl), headers)
        res[label] = {'first': first['status'], 'first_usage': (first['body'] or {}).get('usage') if isinstance(first['body'], dict) else first['body'],
                      'second': second['status'], 'second_usage': (second['body'] or {}).get('usage') if isinstance(second['body'], dict) else second['body']}
    save_result('v8', res)


def cmd_status(_: argparse.Namespace) -> None:
    print(json.dumps({'outputs': outputs(), 'state': load_state()}, indent=2))


def cmd_teardown(_: argparse.Namespace) -> None:
    state = load_state()
    cfn = session.client('cloudformation')
    try:
        gw = outputs()['GatewayId']
    except Exception:
        gw = None
    if gw:
        for name, rule_id in list(state['rules'].items()):
            try:
                ctl().delete_gateway_rule(gatewayIdentifier=gw, ruleId=rule_id)
            except Exception as err:
                print('rule', name, err)
            state['rules'].pop(name)
            save_state(state)
        for name in list(state['targets']):
            delete_target(name)
    try:
        cfn.delete_stack(StackName=STACK)
        cfn.get_waiter('stack_delete_complete').wait(StackName=STACK, WaiterConfig={'Delay': 10, 'MaxAttempts': 90})
        print('stack deleted')
    except Exception as err:
        print('stack delete:', err)
    left = session.client('resourcegroupstaggingapi').get_resources(
        TagFilters=[{'Key': 'Project', 'Values': ['llm-auto-router']}, {'Key': 'Purpose', 'Values': ['spike']}])
    print('remaining tagged resources:', [r['ResourceARN'] for r in left['ResourceTagMappingList']])


def main() -> None:
    commands = {n[4:]: f for n, f in globals().items() if n.startswith('cmd_')}
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=sorted(commands))
    args = parser.parse_args()
    check_account()
    commands[args.command](args)


if __name__ == '__main__':
    main()
