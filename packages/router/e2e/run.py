# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3==1.43.126", "requests==2.34.2"]
# ///
"""E2E runner for the deployed router (design §6, E0-E12). Read-only towards the router stack, except E0's own
temporary probe stack (<prefix>-e2e-probe, tagged Purpose=mvp-e2e) which `e0-teardown` deletes.

  source scripts/local.env      # LLMAR_SPIKE_ACCOUNT: the only account this may touch
  uv run packages/router/e2e/run.py --region <r> [--prefix llmar] <check>

Checks: e0 | e0-teardown | e1 | e2 | e3 | e4 | e5 | e6 | e7 | e8 | e9 | e10 | e11 | e12 | pre-destroy | verify-teardown | all
(`all` = e0 e1 e2 e3 e4 e5 e8 e9 e11 e12; e6, e7 and e10 need a specific deployment state, see each docstring.)

Rules:
- Refuses unless sts:GetCallerIdentity is LLMAR_SPIKE_ACCOUNT. Signing only through botocore (no hand-rolled SigV4).
- The Cognito client secret and access tokens are read at runtime and kept in memory: never printed or written.
- Spend ledger (results/ledger.json): real Bedrock usage from responses, priced with the region's catalog. Each check
  has a budget; the run refuses any check that would pass the total cap (default USD 4.50).
- results/<check>.json: PASS/FAIL per assertion with evidence; 12-digit numbers masked; only our own test prompts.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import re
import socket
import statistics
import subprocess  # nosec B404 - used only for the fixed-argv SDK runner in sdk()
import sys
import time
import uuid
from typing import Any

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
RESULTS = HERE / 'results'
LEDGER = RESULTS / 'ledger.json'
ACCOUNT = os.environ.get('LLMAR_SPIKE_ACCOUNT', '')
PROMPT = 'E2E-PROMPT-MARKER: reply with the single word ok.'
HAIKU = 'global.anthropic.claude-haiku-5-5'
SONNET = 'global.anthropic.claude-sonnet-5-5'
LUNA = 'global.openai.gpt-6-luna'
SOL = 'global.openai.gpt-6.1-sol'
BUDGET = {'e1': 0.05, 'e2': 0.05, 'e3': 0.3, 'e4': 0.6, 'e5': 0.02, 'e5b': 0.02, 'e6': 0.05, 'e7': 0.1, 'e7b': 0.1, 'e8': 0.05, 'e10': 0.05, 'e11': 0.2}

ARGS: argparse.Namespace
session: boto3.Session


# ---------------------------------------------------------------- helpers

def mask(value: Any) -> Any:
    return json.loads(re.sub(r'(?<!\d)\d{12}(?!\d)', '<acct>', json.dumps(value, default=str)))


def save(name: str, data: dict[str, Any]) -> dict[str, Any]:
    RESULTS.mkdir(exist_ok=True)
    checks = data.get('checks', {})
    data['passed'] = bool(checks) and all(checks.values())
    (RESULTS / f'{name}.json').write_text(json.dumps(mask(data), indent=2, ensure_ascii=False))
    for k, v in checks.items():
        print(f"  {'PASS' if v else 'FAIL'}  {name}: {k}")
    print(f"{name}: {'PASS' if data['passed'] else 'FAIL'} -> results/{name}.json")
    return data


def check_account() -> None:
    if not ACCOUNT:
        sys.exit('set LLMAR_SPIKE_ACCOUNT (source scripts/local.env)')
    if session.client('sts').get_caller_identity()['Account'] != ACCOUNT:
        sys.exit('refusing to run: caller account is not LLMAR_SPIKE_ACCOUNT')


def stack_name() -> str:
    return f'{ARGS.prefix}-router'


def outputs() -> dict[str, str]:
    s = session.client('cloudformation').describe_stacks(StackName=stack_name())['Stacks'][0]
    return {o['OutputKey']: o['OutputValue'] for o in s.get('Outputs', [])}


def gateway() -> str:
    url = outputs()['GatewayUrl']
    return url.split('/', 3)[0] + '//' + url.split('/', 3)[2]


_token: dict[str, Any] = {}


def token() -> str:
    """Client-credentials access token (cached in memory until 5 minutes before expiry; never printed)."""
    if _token.get('exp', 0) > time.time() + 300:
        return _token['value']
    out = outputs()
    client = session.client('cognito-idp').describe_user_pool_client(UserPoolId=out['UserPoolId'], ClientId=out['AgentClientId'])['UserPoolClient']
    basic = base64.b64encode(f"{client['ClientId']}:{client['ClientSecret']}".encode()).decode()
    r = requests.post(out['TokenEndpoint'], data={'grant_type': 'client_credentials', 'scope': f'{ARGS.prefix}/invoke'},
                      headers={'authorization': f'Basic {basic}', 'content-type': 'application/x-www-form-urlencoded'}, timeout=30)
    if r.status_code != 200:
        sys.exit(f'token endpoint HTTP {r.status_code}')
    j = r.json()
    _token.update(value=j['access_token'], exp=time.time() + int(j.get('expires_in', 3600)))
    return _token['value']


def body_for(path: str, model: str, stream: bool = False, text: str = PROMPT, max_out: int = 16) -> dict[str, Any]:
    if path == '/v1/messages':
        b: dict[str, Any] = {'model': model, 'max_tokens': max_out, 'messages': [{'role': 'user', 'content': text}]}
    elif path == '/v1/chat/completions':
        b = {'model': model, 'max_completion_tokens': max_out, 'messages': [{'role': 'user', 'content': text}]}
    else:
        b = {'model': model, 'input': text, 'max_output_tokens': max_out, 'store': False}
    if stream:
        b['stream'] = True
    return b


def call(path: str, body: dict[str, Any] | bytes, headers: dict[str, str] | None = None, stream: bool = False,
         auth: str | None = 'token', timeout: Any = (10, 300)) -> dict[str, Any]:
    """One request through the gateway. Returns status, x-router-* headers, the body or SSE stats, and usage."""
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    h = {'content-type': 'application/json', **(headers or {})}
    if path == '/v1/messages':
        h.setdefault('anthropic-version', '2023-06-01')
    if auth == 'token':
        h['authorization'] = f'Bearer {token()}'
    elif auth:
        h['authorization'] = auth
    t0 = time.time()
    try:
        r = requests.post(gateway() + '/inference' + path, data=raw, headers=h, stream=stream, timeout=timeout)
    except requests.RequestException as e:
        return {'status': None, 'error': repr(e)[:300]}
    out: dict[str, Any] = {'status': r.status_code, 'ttfb_ms': round((time.time() - t0) * 1000),
                           'headers': {k: v for k, v in r.headers.items() if k.lower().startswith(('x-router-', 'x-amzn-errortype'))}}
    if not stream:
        try:
            out['body'] = r.json()
        except ValueError:
            out['body'] = r.text[:500]
        out['usage'] = (out['body'] or {}).get('usage') if isinstance(out['body'], dict) else None
        out['model'] = out['body'].get('model') if isinstance(out['body'], dict) else None
        return out
    buf, err, beats, arrivals = b'', None, 0, 0
    try:
        for chunk in r.iter_content(chunk_size=None):
            arrivals += 1
            buf += chunk
    except Exception as e:  # noqa: BLE001 - how a stream ends is evidence
        err = repr(e)[:200]
    text = buf.decode('utf-8', 'replace')
    beats = text.count(': keepalive\n\n')
    usage, model = None, None
    for line in text.splitlines():
        if not line.startswith('data: ') or not line[6:].startswith('{'):
            continue
        try:
            d = json.loads(line[6:])
        except ValueError:
            continue
        model = model or d.get('model') or (d.get('message') or {}).get('model') or (d.get('response') or {}).get('model')
        u = d.get('usage') or (d.get('message') or {}).get('usage') or (d.get('response') or {}).get('usage')
        if isinstance(u, dict):
            usage = {**(usage or {}), **{k: v for k, v in u.items() if v is not None}}
    out.update({'duration_ms': round((time.time() - t0) * 1000), 'chunks': arrivals, 'heartbeats': beats, 'stream_error': err,
                'completed': any(m in text for m in ('message_stop', '[DONE]', 'response.completed')),
                'usage': usage, 'model': model, 'bytes': len(buf)})
    return out


# ---------------------------------------------------------------- spend ledger

def catalog() -> dict[str, Any]:
    c = json.loads((REPO / f'packages/pricing/data/catalog.{ARGS.region}.json').read_text())
    return {m['modelId']: m for m in c['models']}


def resolve_model(served: str | None, body_model: str | None) -> str | None:
    """Catalog id for pricing: the router's x-router-model, else the response body's model (Bedrock returns bare
    names such as 'claude-sonnet-5-5'), matched to the catalog id that ends with it."""
    cat = catalog()
    for m in (served, body_model):
        if m and m in cat:
            return m
        if m:
            hit = next((k for k in cat if k.endswith('.' + m) or k.endswith(m)), None)
            if hit:
                return hit
    return None


def cost(model: str | None, usage: dict[str, Any] | None) -> float:
    """USD for one response from its usage (Anthropic or OpenAI shape). Unknown models are priced at Opus 5.5 rates."""
    if not usage:
        return 0.0
    cat = catalog()
    m = cat.get(model or '') or cat.get('global.anthropic.claude-opus-5-5')
    p = m['price']
    if 'input_tokens' in usage and 'output_tokens' in usage and 'prompt_tokens' not in usage:
        if 'cache_read_input_tokens' in usage or 'cache_creation_input_tokens' in usage:      # Anthropic
            read = usage.get('cache_read_input_tokens') or 0
            write = usage.get('cache_creation_input_tokens') or 0
            uncached = usage.get('input_tokens') or 0
        else:                                                                                  # OpenAI Responses
            read = (usage.get('input_tokens_details') or {}).get('cached_tokens') or 0
            write = 0
            uncached = (usage.get('input_tokens') or 0) - read
        out = usage.get('output_tokens') or 0
    else:                                                                                      # OpenAI Chat
        det = usage.get('prompt_tokens_details') or {}
        read, write = det.get('cached_tokens') or 0, det.get('cache_write_tokens') or 0
        uncached = max(0, (usage.get('prompt_tokens') or 0) - read - write)
        out = usage.get('completion_tokens') or 0
    prompt = uncached + read + write
    lc = m.get('longContext')
    if lc and prompt > lc['aboveTokens']:
        p = lc['price']
    wprice = max(p['cacheWrite'].values()) if p['cacheWrite'] else p['input']
    return (uncached * p['input'] + read * p['cacheRead'] + write * wprice + out * p['output']) / 1e6


class Ledger:
    def __init__(self, name: str):
        self.name = name
        self.data = json.loads(LEDGER.read_text()) if LEDGER.exists() else {'spentUsd': 0.0, 'byCheck': {}}
        need = BUDGET.get(name, 0.0)
        if self.data['spentUsd'] + need > ARGS.cap:
            sys.exit(f'STOP: {name} needs up to ${need:.2f}; spent ${self.data["spentUsd"]:.4f} of the ${ARGS.cap:.2f} cap')

    def add(self, r: dict[str, Any]) -> dict[str, Any]:
        usd = r['_usd'] if '_usd' in r else cost(resolve_model((r.get('headers') or {}).get('x-router-model'), r.get('model')), r.get('usage'))
        self.data['spentUsd'] += usd
        self.data['byCheck'][self.name] = self.data['byCheck'].get(self.name, 0.0) + usd
        RESULTS.mkdir(exist_ok=True)
        LEDGER.write_text(json.dumps(self.data, indent=2))
        if self.data['byCheck'][self.name] > BUDGET.get(self.name, 0.0) * 1.5:
            sys.exit(f'STOP: {self.name} spent ${self.data["byCheck"][self.name]:.4f}, over its budget')
        if self.data['spentUsd'] >= ARGS.cap:
            sys.exit(f'STOP: total spend ${self.data["spentUsd"]:.4f} reached the ${ARGS.cap:.2f} cap')
        r['costUsd'] = round(usd, 6)
        return r

    def add_usd(self, usd: float) -> float:
        return self.add({'usage': None, '_usd': usd}).get('_usd', 0.0)


def router_logs(since_ms: int, pattern: str = '{ $.kind = "model" }') -> list[dict[str, Any]]:
    group = outputs()['RouterLogGroup']
    logs = session.client('logs')
    events: list[dict[str, Any]] = []
    for page in logs.get_paginator('filter_log_events').paginate(logGroupName=group, startTime=since_ms, filterPattern=pattern):
        for e in page['events']:
            try:
                events.append(json.loads(e['message']))
            except ValueError:
                continue
    return events


def desired_running() -> tuple[int, int]:
    out = outputs()
    svc = session.client('ecs').describe_services(cluster=out['ClusterName'], services=[out['ServiceName']])['services'][0]
    return svc['desiredCount'], svc['runningCount']


def healthy_targets() -> int:
    """Healthy router targets behind the NLB (read-only describe calls)."""
    elb = session.client('elbv2')
    lbs = elb.describe_load_balancers(Names=[f'{ARGS.prefix}-nlb'])['LoadBalancers']
    tgs = elb.describe_target_groups(LoadBalancerArn=lbs[0]['LoadBalancerArn'])['TargetGroups'] if lbs else []
    return sum(1 for tg in tgs for d in elb.describe_target_health(TargetGroupArn=tg['TargetGroupArn'])['TargetHealthDescriptions']
               if d['TargetHealth']['State'] == 'healthy')


def gateway_id() -> str:
    """The gateway id is the first label of the gateway URL's host (<id>.gateway.bedrock-agentcore.<region>.amazonaws.com)."""
    return gateway().split('//', 1)[1].split('.', 1)[0]


# ---------------------------------------------------------------- E0: gate (+ temporary in-VPC probe)

PROBE_STACK = '{prefix}-e2e-probe'


def probe_template(out: dict[str, str]) -> dict[str, Any]:
    code = (HERE / 'probe.py').read_text()
    tags = [{'Key': 'Project', 'Value': 'llm-auto-router'}, {'Key': 'Purpose', 'Value': 'mvp-e2e'}]
    api_invoke = {'Fn::Sub': f"arn:aws:execute-api:${{AWS::Region}}:${{AWS::AccountId}}:{out['RestApiId']}/v1/*/*"}
    return {
        'AWSTemplateFormatVersion': '2010-09-09',
        'Description': 'llm-auto-router E2E E0 probe (temporary; delete with `run.py e0-teardown`).',
        'Resources': {
            'ProbeSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
                'GroupDescription': 'E2E probe: egress 443 to the execute-api endpoint, 8080 to the VPC (must time out)',
                'VpcId': out['VpcId'],
                'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'DestinationSecurityGroupId': out['ApiVpceSgId']},
                                        {'IpProtocol': 'tcp', 'FromPort': 8080, 'ToPort': 8080, 'CidrIp': out['VpcCidr']}],
                'Tags': tags}},
            # Temporary: lets the probe reach the endpoint so the API's own policy (not the network) answers.
            'VpceFromProbe': {'Type': 'AWS::EC2::SecurityGroupIngress', 'Properties': {
                'GroupId': out['ApiVpceSgId'], 'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443,
                'SourceSecurityGroupId': {'Ref': 'ProbeSg'}, 'Description': 'E2E probe (temporary)'}},
            'ProbeLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {
                'LogGroupName': f'/aws/lambda/{ARGS.prefix}-e2e-probe', 'RetentionInDays': 1, 'Tags': tags}},
            'ProbeRole': {'Type': 'AWS::IAM::Role', 'Properties': {
                'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'},
                                                                                   'Action': 'sts:AssumeRole', 'Condition': {'StringEquals': {'aws:SourceAccount': {'Ref': 'AWS::AccountId'}}}}]},
                'ManagedPolicyArns': ['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
                # Identity Allow on purpose: a 403 then proves the API's explicit Deny / endpoint policy, not missing IAM.
                'Policies': [{'PolicyName': 'invoke-api-identity-allow', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                    {'Effect': 'Allow', 'Action': 'execute-api:Invoke', 'Resource': api_invoke}]}}],
                'Tags': tags}},
            'ProbeFn': {'Type': 'AWS::Lambda::Function', 'Properties': {
                'FunctionName': f'{ARGS.prefix}-e2e-probe', 'Runtime': 'python3.13', 'Handler': 'index.handler', 'Architectures': ['arm64'],
                'MemorySize': 256, 'Timeout': 90, 'Role': {'Fn::GetAtt': ['ProbeRole', 'Arn']}, 'Code': {'ZipFile': code},
                'VpcConfig': {'SubnetIds': out['PrivateSubnetIds'].split(','), 'SecurityGroupIds': [{'Ref': 'ProbeSg'}]},
                'LoggingConfig': {'LogGroup': {'Ref': 'ProbeLogs'}}, 'Tags': tags}},
        },
        'Outputs': {'ProbeFn': {'Value': {'Ref': 'ProbeFn'}}},
    }


def probe_fn() -> str:
    cfn = session.client('cloudformation')
    name = PROBE_STACK.format(prefix=ARGS.prefix)
    try:
        s = cfn.describe_stacks(StackName=name)['Stacks'][0]
    except cfn.exceptions.ClientError:
        cfn.create_stack(StackName=name, TemplateBody=json.dumps(probe_template(outputs())), Capabilities=['CAPABILITY_IAM'],
                         Tags=[{'Key': 'Project', 'Value': 'llm-auto-router'}, {'Key': 'Purpose', 'Value': 'mvp-e2e'}])
        print('creating', name)
        cfn.get_waiter('stack_create_complete').wait(StackName=name, WaiterConfig={'Delay': 10, 'MaxAttempts': 60})
        s = cfn.describe_stacks(StackName=name)['Stacks'][0]
    return {o['OutputKey']: o['OutputValue'] for o in s['Outputs']}['ProbeFn']


def task_ip() -> str | None:
    out = outputs()
    ecs = session.client('ecs')
    arns = ecs.list_tasks(cluster=out['ClusterName'], serviceName=out['ServiceName'], desiredStatus='RUNNING')['taskArns']
    if not arns:
        return None
    for att in ecs.describe_tasks(cluster=out['ClusterName'], tasks=arns[:1])['tasks'][0]['attachments']:
        for d in att['details']:
            if d['name'] == 'privateIPv4Address':
                return d['value']
    return None


def cmd_e0(_: argparse.Namespace) -> dict[str, Any]:
    """Gate. Run at desiredCount=0 before any traffic, then again at 1. Stops on any 2xx."""
    out = outputs()
    desired, running = desired_running()
    anon = call('/v1/messages', body_for('/v1/messages', 'auto'), auth=None)
    bogus = call('/v1/messages', body_for('/v1/messages', 'auto'), auth='Bearer eyJhbGciOiJSUzI1NiJ9.e30.invalid')
    try:
        socket.getaddrinfo(out['ApiHost'], 443)
        api_outside = 'resolves'
    except socket.gaierror:
        api_outside = 'nxdomain'
    ip = task_ip()
    payload = {'vpceDns': out['ApiVpceDns'], 'apiHost': out['ApiHost'], 'region': ARGS.region, 'nlbDns': out['NlbDns'], 'port': 8080,
               'taskIp': ip or '10.90.0.1'}
    probe = json.loads(session.client('lambda').invoke(FunctionName=probe_fn(), Payload=json.dumps(payload).encode())['Payload'].read())
    nlb = probe.get('direct_tcp_nlb') or []
    checks = {
        'gateway_anonymous_denied': anon.get('status') in (401, 403),
        'gateway_bad_token_denied': bogus.get('status') in (401, 403),
        'api_hostname_private': api_outside == 'nxdomain',
        'probe_unsigned_403': all((probe.get(k) or {}).get('status') == 403 for k in ('unsigned_models', 'unsigned_messages')),
        'probe_other_role_403': all((probe.get(k) or {}).get('status') == 403 for k in ('other_role_models', 'other_role_messages')),
        'probe_direct_nlb_timeout': bool(nlb) and all(n.get('result') == 'timeout' for n in nlb),
        'probe_direct_task_timeout': (probe.get('direct_tcp_task') or {}).get('result') == 'timeout' if ip else True,
    }
    res = save(f'e0-desired{desired}', {'checks': checks, 'desired': desired, 'running': running, 'anonymous': anon, 'bad_token': bogus,
                                        'api_outside': api_outside, 'probe': probe, 'task_ip_checked': bool(ip)})
    if not res['passed']:
        sys.exit('STOP: E0 failed; do not scale up or send traffic')
    return res


def probe_stack_exists() -> bool:
    cfn = session.client('cloudformation')
    try:
        s = cfn.describe_stacks(StackName=PROBE_STACK.format(prefix=ARGS.prefix))['Stacks'][0]
        return s['StackStatus'] != 'DELETE_COMPLETE'
    except cfn.exceptions.ClientError:
        return False


def cmd_e0_teardown(_: argparse.Namespace) -> None:
    cfn = session.client('cloudformation')
    name = PROBE_STACK.format(prefix=ARGS.prefix)
    if not probe_stack_exists():
        print('probe stack absent')
        return
    try:
        cfn.delete_stack(StackName=name)
        cfn.get_waiter('stack_delete_complete').wait(StackName=name, WaiterConfig={'Delay': 15, 'MaxAttempts': 120})
    except Exception as e:  # noqa: BLE001
        sys.exit(f'probe stack delete FAILED: {mask(str(e))[:300]}')
    if probe_stack_exists():
        sys.exit('probe stack still present')
    print('probe stack deleted (its ingress rule on the execute-api endpoint SG went with it)')


def cmd_pre_destroy(_: argparse.Namespace) -> None:
    """Run before `cdk destroy`: refuses while the probe stack exists (its SG rule references the router stack's SG)."""
    if probe_stack_exists():
        sys.exit(f'STOP: {PROBE_STACK.format(prefix=ARGS.prefix)} still exists; run e0-teardown first')
    print('ok to destroy: no E2E probe stack')


# ---------------------------------------------------------------- E1-E5: clients, chains, Claude Code, cache, pins

def sdk(which: str) -> list[dict[str, Any]]:
    """Runs e2e/sdk.ts with a minimal environment (PATH only: no AWS_*, no HOME config); the token goes on stdin."""
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'NODE_NO_WARNINGS': '1'}
    opts: dict[str, Any] = {'env': env, 'input': json.dumps({'gateway': gateway(), 'token': token()}),
                            'capture_output': True, 'text': True, 'timeout': 900, 'cwd': HERE.parent}
    # A literal argv per check, no shell: node from the PATH above runs this harness's own sdk.ts. The token goes over
    # stdin, not argv or env.
    if which == 'e1':
        p = subprocess.run(['node', 'e2e/sdk.ts', 'e1'], **opts)  # nosec B603 B607
    elif which == 'e2':
        p = subprocess.run(['node', 'e2e/sdk.ts', 'e2'], **opts)  # nosec B603 B607
    elif which == 'e3':
        p = subprocess.run(['node', 'e2e/sdk.ts', 'e3'], **opts)  # nosec B603 B607
    else:
        raise ValueError(f'unknown SDK check: {which!r}')
    rows = [json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')]
    if p.returncode != 0:  # keep the calls already made (and ledgered) before the crash
        rows.append({'name': f'{which}-exit', 'status': None, 'error': mask(p.stderr[-300:])})
    return rows


def cmd_e1(_: argparse.Namespace) -> dict[str, Any]:
    """OpenAI SDK Chat Completions, JSON and stream, through the gateway (model auto)."""
    led = Ledger('e1')
    rs = {r['name']: led.add(r) for r in sdk('e1')}
    j, s = rs.get('chat-json', {}), rs.get('chat-stream', {})
    checks = {
        'json_200_with_router_headers': j.get('status') == 200 and all(k in (j.get('headers') or {}) for k in ('x-router-decision', 'x-router-model', 'x-router-reason')),
        'json_usage_present': bool(j.get('usage')),
        'stream_200_incremental': s.get('status') == 200 and (s.get('chunks') or 0) > 1,
        'stream_has_no_usage_key_inject_strip': s.get('streamHasUsageKey') is False,
    }
    return save('e1', {'checks': checks, 'calls': rs})


def cmd_e2(_: argparse.Namespace) -> dict[str, Any]:
    """OpenAI SDK Responses: store=false JSON and stream; store=true + previous_response_id hard-locks the model."""
    led = Ledger('e2')
    rs = {r['name']: led.add(r) for r in sdk('e2')}   # includes responses-chain-first
    chain = rs.get('responses-chain', {})
    stored = [x for x in (rs.get('responses-chain-first', {}).get('storedId'), chain.get('storedId')) if x]
    deleted = {rid: delete_stored_response(rid) for rid in stored}
    checks = {
        'json_200': rs.get('responses-json', {}).get('status') == 200,
        'stream_200': rs.get('responses-stream', {}).get('status') == 200 and (rs.get('responses-stream', {}).get('events') or 0) > 1,
        'chain_200': chain.get('status') == 200,
        'chain_hard_locked': 'hard-lock-response-chain' in (chain.get('headers') or {}).get('x-router-decision', ''),
        'chain_same_model': chain.get('model') == chain.get('firstModel'),
        'stored_responses_deleted': bool(stored) and all(v in (200, 204, 404) for v in deleted.values()),
    }
    return save('e2', {'checks': checks, 'calls': rs, 'storedResponses': deleted,
                       'note': 'store=true responses are deleted right away (DELETE /openai/v1/responses/{id}); any not deleted expire after 30 days.'})


def cmd_e3(_: argparse.Namespace) -> dict[str, Any]:
    """Claude-Code-shaped agent loop via the Anthropic SDK (sdk.ts e3): Claude Code's default betas and session header,
    a tools array, and a synthetic transcript (our own assistant tool_use + scripted tool_result per turn, one user turn).
    Decisions depend only on the request. No local tools run; nothing autonomous. Every call is recorded, failed ones too."""
    led = Ledger('e3')
    since = int(time.time() * 1000) - 5000
    rs = [led.add(r) for r in sdk('e3')]
    time.sleep(10)
    logs = [l for l in router_logs(since) if l.get('dialect') == 'anthropic-messages']
    point = lambda r: ((r.get('headers') or {}).get('x-router-decision') or ';').split(';')[1]  # noqa: E731
    tool_turns = [r for r in rs if r.get('turn') == 'tool-result']
    user_turns = [r for r in rs if r.get('turn') == 'user'][1:]  # the first call is session start
    checks = {
        'ten_plus_calls': len(rs) >= 10,
        'all_200_no_bedrock_400': bool(rs) and all(r.get('status') == 200 for r in rs),
        'twelve_calls_recorded': len([r for r in rs if r.get('name', '').startswith('e3-') and r.get('name') != 'e3-exit']) == 12,
        'betas_accepted_no_veto': bool(logs) and all(not l.get('betaVeto') for l in logs)
                                  and all('claude-code-20250219' in ((l.get('headers') or {}).get('anthropic-beta') or '') for l in logs),
        'tool_result_turns_hard_locked': bool(tool_turns) and all(point(r) == 'hard-lock-tool-loop' for r in tool_turns),
        'decision_at_user_turn': bool(user_turns) and all(point(r) not in ('hard-lock-tool-loop', '') for r in user_turns),
    }
    return save('e3', {'checks': checks, 'calls': [{k: r.get(k) for k in ('name', 'turn', 'status', 'headers', 'stop', 'costUsd', 'error')} for r in rs],
                       'routerLines': len(logs)})


def delete_stored_response(rid: str) -> int | None:
    """Documented bedrock-runtime DELETE /openai/v1/responses/{id} (bedrock:DeleteInvoke on the default project), with the
    operator's credentials through botocore SigV4. Returns the HTTP status (404 = already gone)."""
    url = f'https://bedrock-runtime.{ARGS.region}.amazonaws.com/openai/v1/responses/{rid}'
    req = AWSRequest(method='DELETE', url=url)
    SigV4Auth(session.get_credentials().get_frozen_credentials(), 'bedrock', ARGS.region).add_auth(req)
    try:
        return requests.delete(url, headers=dict(req.headers), timeout=30).status_code
    except requests.RequestException:
        return None


def sigv4_bedrock(path: str, body: dict[str, Any]) -> dict[str, Any]:
    url = f'https://bedrock-runtime.{ARGS.region}.amazonaws.com{path}'
    raw = json.dumps(body).encode()
    req = AWSRequest(method='POST', url=url, data=raw, headers={'content-type': 'application/json', 'anthropic-version': '2023-06-01'})
    SigV4Auth(session.get_credentials().get_frozen_credentials(), 'bedrock', ARGS.region).add_auth(req)
    r = requests.post(url, data=raw, headers=dict(req.headers), timeout=120)
    j = r.json() if r.headers.get('content-type', '').startswith('application/json') else {}
    return {'status': r.status_code, 'usage': j.get('usage'), 'model': body['model']}


def cmd_e4(_: argparse.Namespace) -> dict[str, Any]:
    """Cache parity: the same 20-turn Messages session through the gateway (pinned via hint) and directly to Bedrock."""
    led = Ledger('e4')
    run = str(int(time.time()))
    system = [{'type': 'text', 'text': f'[e2e {run}] You are terse. ' + ' '.join(f'Rule {i}: keep answers to one word.' for i in range(400)),
               'cache_control': {'type': 'ephemeral'}}]

    def session_turns(send) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = []
        res = []
        for i in range(20):
            msgs.append({'role': 'user', 'content': f'E2E-PROMPT-MARKER turn {i}: say ok.'})
            body = {'model': HAIKU, 'max_tokens': 8, 'system': system, 'messages': msgs}
            r = led.add(send(body))
            res.append(r)
            msgs.append({'role': 'assistant', 'content': 'ok'})
        return res

    via = session_turns(lambda b: call('/v1/messages', {**b, 'model': 'auto'}, headers={'x-router-hint': f'pin={HAIKU}', 'x-router-session': f'e4-{run}'}))
    system[0]['text'] = system[0]['text'].replace(f'[e2e {run}]', f'[e2e {run}-direct]')
    direct = session_turns(lambda b: sigv4_bedrock('/anthropic/v1/messages', b))

    def rate(rs: list[dict[str, Any]]) -> float:
        read = sum((r.get('usage') or {}).get('cache_read_input_tokens', 0) or 0 for r in rs)
        prompt = sum(sum(((r.get('usage') or {}).get(k) or 0) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')) for r in rs)
        return read / prompt if prompt else 0.0
    rv, rd = rate(via), rate(direct)
    checks = {'all_200': all(r.get('status') == 200 for r in via + direct), 'hit_rate_within_2pp': abs(rv - rd) <= 0.02}
    return save('e4', {'checks': checks, 'hitRateGateway': rv, 'hitRateDirect': rd})


def cmd_e5(_: argparse.Namespace) -> dict[str, Any]:
    """Pins: a policy model via hint; a hint outside the policy; a concrete body id (not routed)."""
    led = Ledger('e5')
    ok = led.add(call('/v1/messages', body_for('/v1/messages', 'auto'), headers={'x-router-hint': f'pin={HAIKU}'}))
    bad = call('/v1/messages', body_for('/v1/messages', 'auto'), headers={'x-router-hint': 'pin=global.anthropic.claude-opus-4-8'})
    concrete = led.add(call('/v1/messages', body_for('/v1/messages', HAIKU)))
    checks = {
        'hint_pin_routed': ok.get('status') == 200 and ok.get('headers', {}).get('x-router-model') == HAIKU and ok['headers'].get('x-router-decision', '').startswith('pin;'),
        'hint_outside_policy_400': bad.get('status') == 400 and (bad.get('body') or {}).get('code') == 'pin-not-allowed',
        'concrete_id_not_routed': not concrete.get('headers', {}).get('x-router-model') and concrete.get('status') in (403, 400),
    }
    return save('e5', {'checks': checks, 'hintPin': ok, 'hintOutside': bad, 'concrete': concrete})


# The router's built-in aliases (core DEFAULT_ALIASES): auto (pool default tier), auto:fast, auto:standard, auto:frontier.
# The gateway rule sends `auto` and `auto:*` (StringLike) to the router; anything else goes to the bedrock target.
ALIAS = 'auto:fast'
FAST_TIER = {'anthropic-messages': {HAIKU}, 'openai-chat': {LUNA}, 'openai-responses': {LUNA}}
DIALECT_OF = {'/v1/messages': 'anthropic-messages', '/v1/chat/completions': 'openai-chat', '/v1/responses': 'openai-responses'}


def cmd_e5b(_: argparse.Namespace) -> dict[str, Any]:
    """Model aliases through the gateway: `auto:fast` on all three paths reaches the router and resolves to the fast tier
    (observe mode serves the observe default and logs the fast-tier model as wouldChoose; auto mode serves it).
    `auto:bogus` matches `auto:*`, so it reaches the router, which rejects it (400 pin-not-allowed, no upstream call).
    `autox` matches neither `auto` nor `auto:*`: the router must never see it."""
    led = Ledger('e5b')
    since = int(time.time() * 1000) - 5000
    # A fresh session per call: without a session header the router keys the lineage on the prompt fingerprint, which
    # the earlier checks' identical bodies already created, so the alias would land on a user turn instead of a start.
    run = uuid.uuid4().hex[:8]
    rs = {path: led.add(call(path, body_for(path, ALIAS, max_out=16), headers={'x-router-session': f'e5b-{run}-{i}'}))
          for i, path in enumerate(DIALECT_OF)}
    bogus = call('/v1/messages', body_for('/v1/messages', 'auto:bogus'))
    autox = led.add(call('/v1/messages', body_for('/v1/messages', 'autox')))
    time.sleep(10)
    logs = router_logs(since)
    hdr = lambda r: r.get('headers') or {}  # noqa: E731
    alias_lines = {d: [l for l in logs if l.get('requested') == ALIAS and l.get('dialect') == d] for d in DIALECT_OF.values()}

    def resolved_fast(d: str) -> bool:
        ls = alias_lines[d]
        dec = lambda l: l.get('decision') or {}  # noqa: E731
        fast = FAST_TIER[d]
        return bool(ls) and all('tier=fast via alias' in (dec(l).get('reason') or '')
                                and (dec(l).get('wouldChoose') if dec(l).get('mode') == 'observe' else l.get('servedModel')) in fast
                                for l in ls)
    checks = {
        **{f'{path}_alias_routed_to_router': r.get('status') == 200 and bool(hdr(r).get('x-router-model')) for path, r in rs.items()},
        **{f'{d}_alias_resolved_fast_tier': resolved_fast(d) for d in DIALECT_OF.values()},
        'auto_bogus_reaches_router_400': bogus.get('status') == 400 and (bogus.get('body') or {}).get('code') == 'pin-not-allowed'
                                         and any(l.get('requested') == 'other' and l.get('requestedLength') == len('auto:bogus') for l in logs),
        'autox_not_routed': not hdr(autox).get('x-router-model') and not any(l.get('requestedLength') == len('autox') for l in logs),
    }
    return save('e5b', {'checks': checks, 'alias': rs, 'aliasLines': {d: [{k: l.get(k) for k in ('requested', 'servedModel', 'decision')} for l in ls]
                                                                      for d, ls in alias_lines.items()},
                        'autoBogus': bogus, 'autox': autox})


# ---------------------------------------------------------------- E6-E12

def cmd_e6(_: argparse.Namespace) -> dict[str, Any]:
    """Router 5xx path. Needs the e2e revision -c e2eFault=upstream-503-once:2 on a fresh task, with e6 as the first
    thing that reaches Bedrock through it: turn 1 is served by the router (core gets a current model), turn 2 is the
    task's 2nd upstream attempt and gets the injected 503 (the gateway fallback serves it), turn 3 must be the router's
    retain `failover: exhausted` (the default policy has no same-tier sibling)."""
    led = Ledger('e6')
    since = int(time.time() * 1000) - 5000
    sess = f'e6-{int(time.time())}'
    msgs: list[dict[str, Any]] = []
    turns = []
    for i, text in enumerate(('say ok.', 'again.', 'once more.')):
        msgs.append({'role': 'user', 'content': f'E2E-PROMPT-MARKER: {text}'})
        r = led.add(call('/v1/messages', {'model': 'auto', 'max_tokens': 8, 'messages': list(msgs)}, headers={'x-router-session': sess}))
        turns.append(r)
        msgs.append({'role': 'assistant', 'content': 'ok'})
    time.sleep(10)
    logs = [l for l in router_logs(since) if l.get('dialect') == 'anthropic-messages']
    first, faulted, third = turns
    hdr = lambda r: r.get('headers') or {}  # noqa: E731
    checks = {
        'turn1_served_by_router': first.get('status') == 200 and bool(hdr(first).get('x-router-model')),
        'turn2_client_200_via_gateway_fallback': faulted.get('status') == 200 and not hdr(faulted).get('x-router-model'),
        'turn2_fallback_model_sonnet': 'sonnet' in (faulted.get('model') or ''),
        'router_logged_fault_503': any(l.get('status') == 503 and str(l.get('fault', '')).startswith('upstream-503-once') for l in logs),
        'turn3_retain_failover_exhausted': hdr(third).get('x-router-decision', '').startswith('retain;failover;')
                                           and any('failover: exhausted' in ((l.get('decision') or {}).get('reason') or '') for l in logs),
        'turn3_same_model_as_turn1': hdr(third).get('x-router-model') == hdr(first).get('x-router-model'),
    }
    return save('e6', {'checks': checks, 'turns': turns, 'routerLines': len(logs),
                       'note': 'turn 2 was served by the gateway fallback: its usage and model never reach the router (no router cost or state for it).'})


def cmd_e7(_: argparse.Namespace) -> dict[str, Any]:
    """Gateway fallback chain. Needs routerDesiredCount=0 (no running task)."""
    desired, running = desired_running()
    if running:
        return save('e7', {'checks': {'router_scaled_to_zero': False}, 'running': running})
    led = Ledger('e7')
    rs = {}
    for path in ('/v1/messages', '/v1/chat/completions', '/v1/responses'):
        for stream in (False, True):
            rs[f'{path}{"-stream" if stream else ""}'] = led.add(call(path, body_for(path, 'auto', stream=stream), stream=stream))
    bad = call('/v1/chat/completions', {'model': 'auto', 'messages': [{'role': 'user', 'content': PROMPT}], 'max_completion_tokens': -5})
    model_of = lambda r: (r.get('model') or '')  # noqa: E731
    checks = {
        'messages_by_sonnet': all('sonnet' in model_of(rs[k]) and rs[k]['status'] == 200 for k in ('/v1/messages', '/v1/messages-stream')),
        'chat_by_sol': all('gpt-6.1-sol' in model_of(rs[k]) and rs[k]['status'] == 200 for k in ('/v1/chat/completions', '/v1/chat/completions-stream')),
        'responses_by_sol': all(rs[k]['status'] == 200 for k in ('/v1/responses', '/v1/responses-stream')),
        'both_fail_last_targets_error': (bad.get('status') or 0) >= 400,
    }
    return save('e7', {'checks': checks, 'calls': rs, 'bothFail': bad,
                       'note': 'Also read the gateway fallback/circuit-breaker metrics for this window in CloudWatch.'})


def gateway_metrics(t0: float, t1: float) -> dict[str, Any]:
    """The gateway's CloudWatch metrics for [t0, t1] (namespace AWS/Bedrock-AgentCore, any metric with a dimension value that
    names this gateway). The documented gateway metrics are Invocations, Throttles, SystemErrors, UserErrors, Latency,
    Duration, TargetExecutionTime and TargetType; no fallback or circuit-breaker metric is documented, so every metric
    name found is listed in case the service publishes more."""
    cw, gid = session.client('cloudwatch'), gateway_id()
    found = [m for page in cw.get_paginator('list_metrics').paginate(Namespace='AWS/Bedrock-AgentCore') for m in page['Metrics']
             if any(gid in d['Value'] for d in m.get('Dimensions', []))][:100]
    if not found:
        return {'metricNames': [], 'series': []}
    queries = [{'Id': f'm{i}', 'MetricStat': {'Metric': m, 'Period': 60, 'Stat': 'Average' if m['MetricName'] in ('Latency', 'Duration', 'TargetExecutionTime') else 'Sum'}}
               for i, m in enumerate(found)]
    series = []
    for i in range(0, len(queries), 100):
        r = cw.get_metric_data(MetricDataQueries=queries[i:i + 100], StartTime=t0 - 120, EndTime=t1 + 120)
        for q, res in zip(queries[i:i + 100], r['MetricDataResults']):
            m = q['MetricStat']['Metric']
            dims = {d['Name']: (d['Value'] if gid not in d['Value'] else '<gateway>') for d in m.get('Dimensions', [])}
            series.append({'metric': m['MetricName'], 'dims': dims, 'stat': q['MetricStat']['Stat'],
                           'points': sorted(zip([int(t.timestamp()) for t in res['Timestamps']], res['Values']))})
    return {'metricNames': sorted({m['MetricName'] for m in found}), 'series': series}


def cmd_e7b(args: argparse.Namespace) -> dict[str, Any]:
    """Circuit breaker, informational (no pass/fail threshold). Start at routerDesiredCount=0. Phase A: --n `auto` requests
    while the router is down (each served by the gateway fallback). Then scale to 1 from another terminal; phase B probes
    every --probe-s seconds and records when the router has a healthy target and when `auto` is served by the router
    again (x-router-model present), for up to --recover-min minutes. Then reads the gateway's CloudWatch metrics."""
    desired, running = desired_running()
    if desired or running:
        return save('e7b', {'checks': {'router_scaled_to_zero': False}, 'desired': desired, 'running': running})
    led = Ledger('e7b')
    body = body_for('/v1/messages', 'auto', max_out=1)
    timeline: list[dict[str, Any]] = []

    def probe(phase: str) -> dict[str, Any]:
        t = time.time()
        r = led.add(call('/v1/messages', body))
        row = {'phase': phase, 't': round(t, 1), 'status': r.get('status'), 'ttfb_ms': r.get('ttfb_ms'),
               'byRouter': bool((r.get('headers') or {}).get('x-router-model')), 'model': r.get('model'), 'costUsd': r.get('costUsd')}
        timeline.append(row)
        return row
    t_a0 = time.time()
    for _ in range(args.n):
        probe('down')
    t_a1 = time.time()
    print(f'e7b: phase A done ({args.n} requests). Scale the router to 1 now (cdk deploy ... -c routerDesiredCount=1); '
          f'probing every {args.probe_s}s for up to {args.recover_min} min.', flush=True)
    t_healthy = t_router = None
    streak = 0
    deadline = time.time() + args.recover_min * 60
    while time.time() < deadline and streak < 3:
        if t_healthy is None and healthy_targets() > 0:
            t_healthy = time.time()
        row = probe('recovering' if t_healthy is None else 'healthy')
        if row['byRouter']:
            t_router = t_router or row['t']
            streak += 1
        else:
            streak = 0
        time.sleep(args.probe_s)
    t_end = time.time()
    if t_end - t_a0 < 1200:  # gateway metrics are batched per minute; give the last minute time to land
        time.sleep(90)
    down = [r for r in timeline if r['phase'] == 'down']
    ttfb = lambda rows: statistics.median([r['ttfb_ms'] for r in rows if r['ttfb_ms'] is not None]) if rows else None  # noqa: E731
    result = {
        'checks': {'informational_only': True, 'phase_a_all_served_by_fallback': all(r['status'] == 200 and not r['byRouter'] for r in down),
                   'router_back_within_window': t_router is not None},
        'timing_s': {
            'phase_a': round(t_a1 - t_a0, 1),
            'healthy_target_after_phase_a': round(t_healthy - t_a1, 1) if t_healthy else None,
            'router_served_after_healthy_target': round(t_router - t_healthy, 1) if t_router and t_healthy else None,
            'router_served_after_last_down_request': round(t_router - down[-1]['t'], 1) if t_router and down else None,
        },
        'ttfb_ms_median': {'down_first5': ttfb(down[:5]), 'down_last5': ttfb(down[-5:]),
                           'healthy_not_router': ttfb([r for r in timeline if r['phase'] == 'healthy' and not r['byRouter']]),
                           'router': ttfb([r for r in timeline if r['byRouter']])},
        'timeline': timeline,
        'gatewayMetrics': gateway_metrics(t_a0, t_end),
        'note': 'Probes in phase "healthy" that were not served by the router are the circuit breaker (or the gateway) still '
                'skipping the router after it became reachable. Probe resolution is --probe-s.',
    }
    return save('e7b', result)


def cmd_e8(_: argparse.Namespace) -> dict[str, Any]:
    """Request size: 9.5 MiB passes the hop; 10.5 MiB is a 413 from API Gateway (no fallback, nothing at the router)."""
    led = Ledger('e8')
    since = int(time.time() * 1000) - 5000

    def padded(mib: float) -> bytes:
        filler = 'x' * int(mib * 1024 * 1024)
        return json.dumps({'model': 'auto', 'max_tokens': 1, 'messages': [{'role': 'user', 'content': filler}]}).encode()
    small = led.add(call('/v1/messages', padded(9.5), headers={'x-router-hint': f'pin={HAIKU}'}))
    big = call('/v1/messages', padded(10.5))
    time.sleep(10)
    logs = router_logs(since)
    checks = {
        'small_reached_router': any((l.get('bodyBytes') or 0) > 9 * 1024 * 1024 for l in logs),
        'small_not_413': small.get('status') != 413,
        'big_413': big.get('status') == 413,
        'big_not_at_router': not any((l.get('bodyBytes') or 0) > 10 * 1024 * 1024 for l in logs),
    }
    return save('e8', {'checks': checks, 'small': {k: small.get(k) for k in ('status', 'headers', 'body')},
                       'big': {k: big.get(k) for k in ('status', 'body')}})


def cmd_e9(_: argparse.Namespace) -> dict[str, Any]:
    """Every router log line of the run window says hopToken 'redacted' (never the gateway session token)."""
    since = int(time.time() * 1000) - ARGS.window_min * 60_000
    logs = router_logs(since, '{ $.kind = "model" || $.kind = "error" }')
    tokens = [l.get('hopToken') for l in logs]
    checks = {'has_lines': bool(logs), 'all_redacted': bool(tokens) and all(t == 'redacted' for t in tokens)}
    return save('e9', {'checks': checks, 'counts': {t: tokens.count(t) for t in set(tokens)}})


def cmd_e10(_: argparse.Namespace) -> dict[str, Any]:
    """Heartbeat end to end. Needs -c e2eFault=pause-after-first-frame:330000 -c e2eIdleTimeoutMs=420000."""
    led = Ledger('e10')
    r = led.add(call('/v1/messages', body_for('/v1/messages', 'auto', stream=True), headers={'x-router-hint': f'pin={HAIKU}'},
                     stream=True, timeout=(10, 900)))
    checks = {
        'survived_past_300s': (r.get('duration_ms') or 0) > 320_000,
        'completed': bool(r.get('completed')),
        'heartbeats_reached_client': (r.get('heartbeats') or 0) >= 4,
    }
    return save('e10', {'checks': checks, 'call': {k: r.get(k) for k in ('status', 'duration_ms', 'heartbeats', 'completed', 'stream_error')}})


def cmd_e11(_: argparse.Namespace) -> dict[str, Any]:
    """Router overhead over 200 short requests (from the router's own overheadMs)."""
    led = Ledger('e11')
    since = int(time.time() * 1000) - 5000
    for i in range(200):
        led.add(call('/v1/chat/completions', body_for('/v1/chat/completions', 'auto', max_out=1), headers={'x-router-hint': f'pin={LUNA}'}))
    time.sleep(15)
    xs = sorted(l['overheadMs'] for l in router_logs(since) if isinstance(l.get('overheadMs'), (int, float)))
    p = lambda q: xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None  # noqa: E731
    checks = {'samples_200': len(xs) >= 200, 'p50_under_20ms': (p50 := p(0.5)) is not None and p50 < 20,
              'p99_under_100ms': (p99 := p(0.99)) is not None and p99 < 100}
    return save('e11', {'checks': checks, 'n': len(xs), 'p50': p(0.5), 'p99': p(0.99), 'mean': statistics.mean(xs) if xs else None})


def cmd_e12(_: argparse.Namespace) -> dict[str, Any]:
    """Log hygiene: page the router log group (no filter pattern, so no secret ever goes into an AWS request) and scan
    every line locally for credentials, tokens, the client secret and prompt text."""
    since = int(time.time() * 1000) - ARGS.window_min * 60_000
    out = outputs()
    patterns = {
        'jwt': re.compile(r'eyJ[\w-]{10,}\.'), 'aws_key_id': re.compile(r'(ASIA|AKIA)[A-Z0-9]{16}'), 'bearer': re.compile(r'Bearer\s'),
        'sigv4': re.compile(r'AWS4-HMAC-SHA256'), 'credential_scope': re.compile(r'Credential='),
        'security_token_header': re.compile(r'x-amz-security-token', re.I), 'prompt_marker': re.compile(re.escape('E2E-PROMPT-MARKER')),
        'x_api_key': re.compile(r'x-api-key', re.I), 'cookie_header': re.compile(r'"cookie"', re.I),
    }
    secret = session.client('cognito-idp').describe_user_pool_client(UserPoolId=out['UserPoolId'], ClientId=out['AgentClientId'])['UserPoolClient']['ClientSecret']
    hits = {k: 0 for k in [*patterns, 'client_secret']}
    lines = 0
    for page in session.client('logs').get_paginator('filter_log_events').paginate(logGroupName=out['RouterLogGroup'], startTime=since):
        for e in page['events']:
            lines += 1
            msg = e['message']
            for k, rx in patterns.items():
                if rx.search(msg):
                    hits[k] += 1
            if secret and secret in msg:
                hits['client_secret'] += 1
    del secret
    return save('e12', {'checks': {'scanned_lines': lines > 0, **{f'no_{k}': v == 0 for k, v in hits.items()}}, 'lines': lines, 'hits': hits})


# ---------------------------------------------------------------- teardown verification

def cmd_verify_teardown(_: argparse.Namespace) -> dict[str, Any]:
    """After `cdk destroy` (and e0-teardown): nothing of this deployment is left."""
    if probe_stack_exists():
        sys.exit(f'STOP: {PROBE_STACK.format(prefix=ARGS.prefix)} still exists; run e0-teardown first')
    p = ARGS.prefix
    cfn, ec2, apigw, logs = session.client('cloudformation'), session.client('ec2'), session.client('apigateway'), session.client('logs')

    def pages(client: Any, op: str, key: str, **kw: Any) -> list[dict[str, Any]]:
        return [x for page in client.get_paginator(op).paginate(**kw) for x in page.get(key, [])] if client.can_paginate(op) else getattr(client, op)(**kw).get(key, [])
    stacks = [s['StackName'] for s in pages(cfn, 'list_stacks', 'StackSummaries') if s['StackStatus'] != 'DELETE_COMPLETE'
              and s['StackName'] in (f'{p}-router', PROBE_STACK.format(prefix=p))]
    vpcs = [v['VpcId'] for v in ec2.describe_vpcs(Filters=[{'Name': 'tag:Name', 'Values': [f'{p}-vpc']}])['Vpcs']]
    left = {
        'stacks': stacks,
        'gateways': [g['name'] for g in pages(session.client('bedrock-agentcore-control'), 'list_gateways', 'items') if g['name'].startswith(f'{p}-gw')],
        'rest_apis': [a['name'] for a in pages(apigw, 'get_rest_apis', 'items') if a['name'] == f'{p}-api'],
        'vpc_links': [v['name'] for v in pages(apigw, 'get_vpc_links', 'items') if v['name'] == f'{p}-link'],
        'load_balancers': [lb['LoadBalancerName'] for lb in pages(session.client('elbv2'), 'describe_load_balancers', 'LoadBalancers') if lb['LoadBalancerName'] == f'{p}-nlb'],
        'vpcs': vpcs,
        'vpc_endpoints': [e['VpcEndpointId'] for v in vpcs for e in ec2.describe_vpc_endpoints(Filters=[{'Name': 'vpc-id', 'Values': [v]}])['VpcEndpoints']
                          if e['State'].lower() not in ('deleted', 'deleting')],
        'resource_gateways': [g['name'] for g in pages(session.client('vpc-lattice'), 'list_resource_gateways', 'items') if g.get('vpcIdentifier') in vpcs],
        'ecs_clusters': [c['clusterName'] for c in session.client('ecs').describe_clusters(clusters=[f'{p}-cluster'])['clusters'] if c['status'] == 'ACTIVE'],
        'user_pools': [u['Name'] for u in pages(session.client('cognito-idp'), 'list_user_pools', 'UserPools', MaxResults=60) if u['Name'] == f'{p}-users'],
        'log_groups': [g['logGroupName'] for prefix in (f'/{p}/', f'/aws/ecs/containerinsights/{p}-cluster', f'/aws/lambda/{p}-router-CustomVpcRestrictDefaultSG',
                                                        f'/aws/lambda/{p}-e2e-probe')
                       for g in pages(logs, 'describe_log_groups', 'logGroups', logGroupNamePrefix=prefix)],
    }
    remaining = {k: v for k, v in left.items() if v}
    res = save('verify-teardown', {'checks': {f'no_{k}': not v for k, v in left.items()}, 'remaining': remaining})
    if remaining:
        print('note: the /aws/lambda/…CustomVpcRestrictDefaultSG… log group survives cdk destroy by design; delete it by hand')
    return res


def cmd_all(args: argparse.Namespace) -> None:
    for fn in (cmd_e0, cmd_e1, cmd_e2, cmd_e3, cmd_e4, cmd_e5, cmd_e5b, cmd_e8, cmd_e9, cmd_e11, cmd_e12):
        fn(args)


def main() -> None:
    global ARGS, session
    commands = {n[4:].replace('_', '-'): f for n, f in globals().items() if n.startswith('cmd_')}
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('check', choices=sorted(commands))
    ap.add_argument('--region', required=True)
    ap.add_argument('--prefix', default='llmar')
    ap.add_argument('--cap', type=float, default=4.50, help='total Bedrock spend cap in USD across all checks')
    ap.add_argument('--window-min', type=int, default=180, help='e9/e12: how far back to scan the router logs')
    ap.add_argument('--n', type=int, default=30, help='e7b: requests while the router is down')
    ap.add_argument('--probe-s', type=int, default=10, help='e7b: seconds between recovery probes')
    ap.add_argument('--recover-min', type=int, default=30, help='e7b: how long to wait for the router to serve again')
    ARGS = ap.parse_args()
    session = boto3.Session(region_name=ARGS.region)
    check_account()
    commands[ARGS.check](ARGS)


if __name__ == '__main__':
    main()
