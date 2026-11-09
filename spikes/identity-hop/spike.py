# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3==1.43.126", "requests==2.34.2"]
# ///
"""Identity spike (admin console C1): does a client's Cognito access token, re-sent in `x-api-key`, reach the router
unchanged through AgentCore Gateway (CUSTOM_JWT, scope-only) -> private REST API (AWS_IAM) -> VPC link -> NLB ->
Fargate echo stub? Built from the V9d harness (spikes/apigw-hop). Plan: admin-console research a3 §1.4.

Usage:  source scripts/local.env && uv run spikes/identity-hop/spike.py [--region <r>] <command>
Order:  deploy -> gate -> s1 -> s2 -> s4 -> s7 -> teardown   (`verify` reruns the teardown listing)

- Refuses to run unless sts:GetCallerIdentity matches LLMAR_SPIKE_ACCOUNT. The account id is never printed or saved.
- Region: --region, else LLMAR_SPIKE_REGION, else AWS_REGION. It must have AgentCore managed private endpoints in
  two AZ IDs (AZ_IDS below, or --az-ids).
- Everything is named llmar-idspike* and tagged Project=llm-auto-router, Purpose=spike (+ Owner from LLMAR_OWNER).
- Gateway targets and the rule are created outside the stack (recorded in state.json) and deleted by `teardown`
  before the stack. `teardown` is idempotent and ends with a verification listing; it exits 1 if anything is left.
- `gate` (S0) must pass for the current stack, with no target, before any command that sends traffic.
- Tokens, client secrets and the spike user's password live in memory only. Results hold sha256[:12] digests and
  lengths of what was sent and what the stub saw, never a token. The stub logs no identity header.
- Only `s7` calls Bedrock: two requests with max_tokens 1 on the cheapest global profile (well under $0.01).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import pathlib
import re
import secrets
import string
import sys
import threading
import time
import urllib.parse
from typing import Any

import boto3
import requests

ACCOUNT = os.environ.get('LLMAR_SPIKE_ACCOUNT', '')  # scripts/local.env (gitignored)
STACK = 'llmar-idspike'
GATEWAY_NAME = 'llmar-idspike-gw'
TARGET, BEDROCK_TARGET = 'router', 'bedrock'
TAGS = {'Project': 'llm-auto-router', 'Purpose': 'spike', **({'Owner': os.environ['LLMAR_OWNER']} if os.environ.get('LLMAR_OWNER') else {})}
CIDR = '10.92.0.0/24'
# AgentCore managed private endpoints: apne1-az1/az2/az4 (Tokyo), apse1-az1/az2/az3 (Singapore).
AZ_IDS = {'ap-northeast-1': ('apne1-az1', 'apne1-az2'), 'ap-southeast-1': ('apse1-az1', 'apse1-az2')}
PORT = 8080
STAGE = 'v1'
IMAGE = 'public.ecr.aws/docker/library/node:24-slim'
HERE = pathlib.Path(__file__).resolve().parent
STATE = HERE / 'state.json'      # gitignored (spikes/*/state.json)
RESULTS = HERE / 'results'       # gitignored (spikes/*/results/)
RS_ID = 'llmar-idspike'          # resource server identifier
SCOPE, OTHER_SCOPE = f'{RS_ID}/invoke', f'{RS_ID}/other'
CALLBACK_PORT = 8976
CALLBACK = f'http://127.0.0.1:{CALLBACK_PORT}/callback'
SPIKE_USER = 'idspike-user'
# The spike user's password goes to a 0600 file outside the repo (never stdout, never results/); teardown deletes it.
PASSWORD_FILE = pathlib.Path(os.environ.get('XDG_RUNTIME_DIR') or pathlib.Path.home()) / 'llmar-idspike-user-password.txt'
# The identity header under test, and the fallback name if the gateway refuses to allowlist it (a3 §1.3 item 2).
ID_HEADER, ID_HEADER_FALLBACK = 'x-api-key', 'x-router-identity'
BASE_HEADERS = ['anthropic-version', 'anthropic-beta', 'x-router-session', 'x-router-hint']
RESP_HEADERS = ['x-router-decision', 'x-router-model', 'x-stub-sha256']
PATHS = ('/v1/messages', '/v1/chat/completions', '/v1/responses')
# S7: a concrete Bedrock id (global profile) for the bypass check; the gateway role may invoke only this one.
BEDROCK_MODEL = os.environ.get('LLMAR_IDSPIKE_BEDROCK_MODEL', 'global.anthropic.claude-haiku-5-5')
CONNECTOR_DISCOVERY = ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:GetInferenceProfile',
                       'bedrock:GetFoundationModel', 'bedrock:ListProvisionedModelThroughputs', 'bedrock:ListCustomModelDeployments',
                       'bedrock:ListImportedModels', 'bedrock:ListMarketplaceModelEndpoints', 'bedrock:ListPromptRouters']

REGION = ''
session: Any = None


# ---------------------------------------------------------------- helpers

def check_account() -> None:
    if not ACCOUNT:
        sys.exit('set LLMAR_SPIKE_ACCOUNT (source scripts/local.env) to the account this spike may touch')
    if session.client('sts').get_caller_identity()['Account'] != ACCOUNT:
        sys.exit('refusing to run: caller account is not LLMAR_SPIKE_ACCOUNT')


def mask(value: Any) -> Any:
    """Mask 12-digit numbers (account ids), anything JWT-shaped and long base64url runs in output and results/."""
    text = json.dumps(value, default=str)
    text = re.sub(r'(?<!\d)\d{12}(?!\d)', '<acct>', text)
    text = re.sub(r'eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}', '<jwt>', text)
    text = re.sub(r'[A-Za-z0-9_-]{40,}', '<b64>', text)  # any long base64url run (token pieces in error bodies)
    return json.loads(text)


def fp(value: str | None) -> str | None:
    """The stub's digest of a header value: sha256 hex, first 12 characters."""
    return None if value is None else hashlib.sha256(value.encode()).hexdigest()[:12]


def load_state() -> dict[str, Any]:
    return json.loads(STATE.read_text()) if STATE.exists() else {'targets': {}, 'rules': {}}


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


_OUTPUTS: dict[str, str] = {}


def outputs() -> dict[str, str]:
    """Stack outputs (cached once complete: they do not change after deploy)."""
    if _OUTPUTS.get('CliClientId'):
        return _OUTPUTS
    s = stack()
    if not s:
        sys.exit(f'stack {STACK} not found; run deploy')
    out = {o['OutputKey']: o['OutputValue'] for o in s.get('Outputs', [])}
    if s['StackStatus'] in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
        _OUTPUTS.update(out)
    return out


def gateway_base() -> str:
    url = outputs()['GatewayUrl']
    return url.split('/', 3)[0] + '//' + url.split('/', 3)[2]


def ctl() -> Any:
    return session.client('bedrock-agentcore-control')


def pages(client: Any, op: str, key: str, **kw: Any) -> list[dict[str, Any]]:
    if client.can_paginate(op):
        return [item for page in client.get_paginator(op).paginate(**kw) for item in page.get(key, [])]
    return getattr(client, op)(**kw).get(key, [])


def body_for(path: str, model: str, stream: bool = False, max_tokens: int = 16) -> dict[str, Any]:
    if path == '/v1/messages':
        b: dict[str, Any] = {'model': model, 'max_tokens': max_tokens, 'messages': [{'role': 'user', 'content': 'ping'}]}
    elif path == '/v1/chat/completions':
        b = {'model': model, 'max_completion_tokens': max_tokens, 'messages': [{'role': 'user', 'content': 'ping'}]}
    else:
        b = {'model': model, 'input': 'ping', 'max_output_tokens': max_tokens}
    if stream:
        b['stream'] = True
    return b


def stub_echo(body: Any) -> dict[str, Any] | None:
    for path in (('content', 0, 'text'), ('choices', 0, 'message', 'content'), ('output', 0, 'content', 0, 'text')):
        node = body
        try:
            for key in path:
                node = node[key]
            echo = json.loads(node)
            return echo if isinstance(echo, dict) and 'headerNames' in echo else None
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


def call(path: str, body: dict[str, Any], headers: dict[str, str], stream: bool = False, timeout: Any = 60) -> dict[str, Any]:
    """One gateway call with caller-chosen auth headers. The result never contains a header value."""
    raw = json.dumps(body).encode()
    hdrs = {'content-type': 'application/json', **headers}
    if path == '/v1/messages':
        hdrs.setdefault('anthropic-version', '2023-06-01')
    out: dict[str, Any] = {'path': path, 'stream': stream}
    try:
        resp = requests.post(gateway_base() + '/inference' + path, data=raw, headers=hdrs, stream=stream, timeout=timeout)
    except Exception as err:  # noqa: BLE001
        return {**out, 'status': None, 'error': type(err).__name__}
    out['status'] = resp.status_code
    out['headers'] = {k: v for k, v in resp.headers.items() if k.lower().startswith(('x-router', 'x-stub', 'x-amzn-errortype', 'www-authenticate'))}
    if not stream:
        try:
            out['body'] = resp.json()
        except ValueError:
            out['body'] = resp.text[:600]
        out['echo'] = stub_echo(out['body'])
        if out['echo']:
            out['body'] = '<stub echo>'
        elif isinstance(out['body'], dict):  # a real model or error answer: keep its shape, not its text
            b = out['body']
            out['body'] = {k: b.get(k) for k in ('type', 'model', 'error', 'message', 'stop_reason', 'usage') if k in b}
        return out
    buf = b''
    try:
        for chunk in resp.iter_content(chunk_size=None):
            buf += chunk
    except Exception as e:  # noqa: BLE001
        out['stream_error'] = type(e).__name__
    events = [e for e in buf.decode('utf-8', 'replace').split('\n\n') if e.strip()]
    out.update({'events': len(events), 'echo': first_echo(events)})
    return out


def seen(r: dict[str, Any], field: str = 'xApiKey') -> dict[str, Any] | None:
    return (r.get('echo') or {}).get(field)


def matches(r: dict[str, Any], sent: dict[str, str | None], field: str = 'xApiKey') -> str:
    """Which of the sent values the stub saw in `field`: a label from `sent`, 'absent', 'other', or 'no-echo'."""
    if not r.get('echo'):
        return 'no-echo'
    d = seen(r, field) or {}
    if not d.get('present'):
        return 'absent'
    for label, value in sent.items():
        if value is not None and d.get('sha256_12') == fp(value) and d.get('length') == len(value.encode()):
            return label
    return 'other'


def require_gate() -> None:
    gate = RESULTS / 'gate.json'
    s = stack()
    if not s or not gate.exists():
        sys.exit('STOP: run `gate` first (S0 must pass before any traffic through the gateway)')
    g = json.loads(gate.read_text())
    if not g.get('passed') or g.get('stackCreated') != str(s['CreationTime']):
        sys.exit('STOP: gate has not passed for the current stack; run `gate`')


def require_target() -> None:
    require_gate()
    if TARGET not in load_state()['targets']:
        sys.exit('no router target yet: run s1 first')


# ---------------------------------------------------------------- Cognito tokens (memory only)

def domain_base() -> str:
    return f"https://{outputs()['DomainPrefix']}.auth.{REGION}.amazoncognito.com"


def client_secret(client_id: str) -> str:
    c = session.client('cognito-idp').describe_user_pool_client(UserPoolId=outputs()['UserPoolId'], ClientId=client_id)
    return c['UserPoolClient']['ClientSecret']


def m2m_token(client_key: str, scope: str = SCOPE) -> str:
    """Client-credentials access token for the stack output `client_key` (e.g. M2mAClientId)."""
    cid = outputs()[client_key]
    basic = base64.b64encode(f'{cid}:{client_secret(cid)}'.encode()).decode()
    r = requests.post(domain_base() + '/oauth2/token', data={'grant_type': 'client_credentials', 'scope': scope},
                      headers={'Authorization': f'Basic {basic}', 'Content-Type': 'application/x-www-form-urlencoded'}, timeout=30)
    if r.status_code != 200:
        sys.exit(f'token request for {client_key} failed: {r.status_code} {mask(r.text[:200])}')
    return r.json()['access_token']


def claims(token: str) -> dict[str, Any]:
    """Unverified payload (for reporting only; the gateway and the router verify signatures)."""
    part = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


def claim_report(token: str, cli_client_id: str | None = None) -> dict[str, Any]:
    c = claims(token)
    return {'claimNames': sorted(c), 'token_use': c.get('token_use'), 'scope': sorted((c.get('scope') or '').split()),
            'hasAud': 'aud' in c, 'hasUsername': 'username' in c, 'hasGroups': 'cognito:groups' in c,
            'subEqualsClientId': c.get('sub') is not None and c.get('sub') == c.get('client_id'),
            'clientIdIsCli': None if cli_client_id is None else c.get('client_id') == cli_client_id,
            'lifetimeS': (c.get('exp') or 0) - (c.get('iat') or 0), 'length': len(token)}


def ensure_spike_user() -> str:
    """Creates (or resets) the spike user with a fresh random password; returns it (printed once, never saved)."""
    idp, pool = session.client('cognito-idp'), outputs()['UserPoolId']
    alphabet = string.ascii_letters + string.digits
    password = ''.join(secrets.choice(alphabet) for _ in range(20)) + 'aA1!'
    try:
        idp.admin_create_user(UserPoolId=pool, Username=SPIKE_USER, MessageAction='SUPPRESS',
                              TemporaryPassword=''.join(secrets.choice(alphabet) for _ in range(20)) + 'bB2#')
    except idp.exceptions.UsernameExistsException:
        pass
    idp.admin_set_user_password(UserPoolId=pool, Username=SPIKE_USER, Password=password, Permanent=True)
    return password


def browser_login(scope: str) -> dict[str, Any]:
    """Auth code + PKCE through managed login, loopback callback on 127.0.0.1. Returns the token response."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    state = secrets.token_urlsafe(24)
    cid = outputs()['CliClientId']
    url = domain_base() + '/oauth2/authorize?' + urllib.parse.urlencode({
        'response_type': 'code', 'client_id': cid, 'redirect_uri': CALLBACK, 'scope': scope, 'state': state,
        'code_challenge': challenge, 'code_challenge_method': 'S256'})
    got: dict[str, str] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header('content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'identity spike: sign-in received, you can close this tab')

        def log_message(self, *_: Any) -> None:  # the query holds the code: never log it
            return

    srv = http.server.HTTPServer(('127.0.0.1', CALLBACK_PORT), Handler)
    srv.timeout = 300
    print(f'\nOpen this URL in a browser and sign in as {SPIKE_USER} (scope: {scope}).')
    print(f'Remote dev box? First: ssh -L {CALLBACK_PORT}:127.0.0.1:{CALLBACK_PORT} <host>\n\n{url}\n')
    srv.handle_request()
    srv.server_close()
    if got.get('state') != state or 'code' not in got:
        sys.exit(f"sign-in failed: {'state mismatch' if got.get('state') != state else got.get('error', 'no code')}")
    r = requests.post(domain_base() + '/oauth2/token', data={'grant_type': 'authorization_code', 'client_id': cid, 'code': got['code'],
                      'redirect_uri': CALLBACK, 'code_verifier': verifier}, timeout=30)
    if r.status_code != 200:
        sys.exit(f'code exchange failed: {r.status_code} {mask(r.text[:200])}')
    return r.json()


def refresh(refresh_token: str) -> dict[str, Any]:
    r = requests.post(domain_base() + '/oauth2/token', data={'grant_type': 'refresh_token', 'client_id': outputs()['CliClientId'],
                      'refresh_token': refresh_token}, timeout=30)
    return {'status': r.status_code, **({'tokens': r.json()} if r.status_code == 200 else {'error': mask(r.text[:200])})}


def revoke(refresh_token: str) -> int:
    return requests.post(domain_base() + '/oauth2/revoke', data={'token': refresh_token, 'client_id': outputs()['CliClientId']},
                         timeout=30).status_code


# ---------------------------------------------------------------- template

def template() -> dict[str, Any]:
    stub = (HERE / 'stub' / 'server.cjs').read_text()
    probe = (HERE / 'probe' / 'probe.py').read_text()
    az = AZ_IDS[REGION]
    tl = [{'Key': k, 'Value': v} for k, v in TAGS.items()]
    named = lambda n: tl + [{'Key': 'Name', 'Value': n}]  # noqa: E731
    sub = lambda s: {'Fn::Sub': s}  # noqa: E731
    ref = lambda n: {'Ref': n}  # noqa: E731
    att = lambda n, a: {'Fn::GetAtt': [n, a]}  # noqa: E731
    api_invoke = sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/' + STAGE + '/*/*')
    base_model = BEDROCK_MODEL.split('.', 1)[1]
    profile_arn = sub('arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/' + BEDROCK_MODEL)
    # Globally unique, non-identifying domain prefix: the first block of the stack GUID (never the account id).
    domain_prefix = {'Fn::Join': ['-', ['llmar-idspike', {'Fn::Select': [0, {'Fn::Split': ['-', {'Fn::Select': [2, {'Fn::Split': ['/', ref('AWS::StackId')]}]}]}]}]]}
    m2m = lambda name, scopes, minutes=60: {'Type': 'AWS::Cognito::UserPoolClient', 'DependsOn': 'ResourceServer', 'Properties': {  # noqa: E731
        'UserPoolId': ref('UserPool'), 'ClientName': name, 'GenerateSecret': True, 'AllowedOAuthFlowsUserPoolClient': True,
        'AllowedOAuthFlows': ['client_credentials'], 'AllowedOAuthScopes': scopes, 'SupportedIdentityProviders': ['COGNITO'],
        'PreventUserExistenceErrors': 'ENABLED', 'AccessTokenValidity': minutes, 'TokenValidityUnits': {'AccessToken': 'minutes'}}}
    r: dict[str, Any] = {
        # ---- network (as V9d): two private subnets; one public subnet for the NAT only (ECR Public image pull).
        'Vpc': {'Type': 'AWS::EC2::VPC', 'Properties': {'CidrBlock': CIDR, 'EnableDnsSupport': True,
                                                        'EnableDnsHostnames': True, 'Tags': named('llmar-idspike-vpc')}},
        'PrivA': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.92.0.0/26',
                                                             'AvailabilityZoneId': az[0], 'Tags': named('llmar-idspike-priv-a')}},
        'PrivB': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.92.0.64/26',
                                                             'AvailabilityZoneId': az[1], 'Tags': named('llmar-idspike-priv-b')}},
        'PubA': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'CidrBlock': '10.92.0.128/27',
                                                            'AvailabilityZoneId': az[0], 'MapPublicIpOnLaunch': False,
                                                            'Tags': named('llmar-idspike-pub-nat')}},
        'Igw': {'Type': 'AWS::EC2::InternetGateway', 'Properties': {'Tags': named('llmar-idspike-igw')}},
        'IgwAttach': {'Type': 'AWS::EC2::VPCGatewayAttachment', 'Properties': {'VpcId': ref('Vpc'), 'InternetGatewayId': ref('Igw')}},
        'PubRt': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc'), 'Tags': named('llmar-idspike-pub-rt')}},
        'PubDefault': {'Type': 'AWS::EC2::Route', 'DependsOn': 'IgwAttach', 'Properties': {
            'RouteTableId': ref('PubRt'), 'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': ref('Igw')}},
        'PubRtA': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PubA'), 'RouteTableId': ref('PubRt')}},
        'NatEip': {'Type': 'AWS::EC2::EIP', 'DependsOn': 'IgwAttach', 'Properties': {'Domain': 'vpc', 'Tags': named('llmar-idspike-nat-eip')}},
        'Nat': {'Type': 'AWS::EC2::NatGateway', 'Properties': {'SubnetId': ref('PubA'), 'AllocationId': att('NatEip', 'AllocationId'),
                                                               'Tags': named('llmar-idspike-nat')}},
        'PrivRt': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc'), 'Tags': named('llmar-idspike-priv-rt')}},
        'PrivDefault': {'Type': 'AWS::EC2::Route', 'Properties': {
            'RouteTableId': ref('PrivRt'), 'DestinationCidrBlock': '0.0.0.0/0', 'NatGatewayId': ref('Nat')}},
        'PrivRtA': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PrivA'), 'RouteTableId': ref('PrivRt')}},
        'PrivRtB': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('PrivB'), 'RouteTableId': ref('PrivRt')}},
        'TaskSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-idspike stub: ingress 8080 only from the NLB SG; egress 443 for image pull and logs',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'CidrIp': '0.0.0.0/0',
                                     'Description': 'image pull (ECR Public) and CloudWatch Logs via NAT'}],
            'Tags': named('llmar-idspike-task-sg')}},
        'NlbSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-idspike NLB: no ingress rules (PrivateLink/VPC link traffic is not evaluated); egress 8080 to the task',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'icmp', 'FromPort': -1, 'ToPort': -1, 'CidrIp': '127.0.0.1/32',
                                     'Description': 'placeholder: replaced by NlbToTask (removes the default allow-all)'}],
            'Tags': named('llmar-idspike-nlb-sg')}},
        'NlbToTask': {'Type': 'AWS::EC2::SecurityGroupEgress', 'Properties': {
            'GroupId': ref('NlbSg'), 'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT,
            'DestinationSecurityGroupId': ref('TaskSg'), 'Description': 'traffic and health checks to the stub'}},
        'TaskFromNlb': {'Type': 'AWS::EC2::SecurityGroupIngress', 'Properties': {
            'GroupId': ref('TaskSg'), 'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT,
            'SourceSecurityGroupId': ref('NlbSg'), 'Description': 'NLB only'}},
        'ClientSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-idspike clients in the VPC (gate probe, managed resource gateway): no ingress',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': PORT, 'ToPort': PORT, 'CidrIp': CIDR,
                                     'Description': 'gate probe: direct connects to the task and the NLB must time out'}],
            'Tags': named('llmar-idspike-client-sg')}},
        'VpceSg': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
            'GroupDescription': 'llmar-idspike execute-api endpoint: 443 only from ClientSg',
            'VpcId': ref('Vpc'),
            'SecurityGroupEgress': [{'IpProtocol': 'icmp', 'FromPort': -1, 'ToPort': -1, 'CidrIp': '127.0.0.1/32',
                                     'Description': 'placeholder: no egress needed'}],
            'Tags': named('llmar-idspike-vpce-sg')}},
        'VpceFromClient': {'Type': 'AWS::EC2::SecurityGroupIngress', 'Properties': {
            'GroupId': ref('VpceSg'), 'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443,
            'SourceSecurityGroupId': ref('ClientSg'), 'Description': 'probe and AgentCore resource gateway'}},
        'ClientToVpce': {'Type': 'AWS::EC2::SecurityGroupEgress', 'Properties': {
            'GroupId': ref('ClientSg'), 'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443,
            'DestinationSecurityGroupId': ref('VpceSg'), 'Description': 'execute-api endpoint'}},
        'Vpce': {'Type': 'AWS::EC2::VPCEndpoint', 'Properties': {
            'VpcId': ref('Vpc'), 'VpcEndpointType': 'Interface', 'ServiceName': sub('com.amazonaws.${AWS::Region}.execute-api'),
            'SubnetIds': [ref('PrivA'), ref('PrivB')], 'SecurityGroupIds': [ref('VpceSg')], 'PrivateDnsEnabled': False,
            'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': '*', 'Action': 'execute-api:Invoke',
                'Resource': {'Fn::If': ['HasApiId',
                                        sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiIdForEndpointPolicy}/*'),
                                        sub('arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:llmar-idspike-pending/*')]}}]},
            'Tags': named('llmar-idspike-vpce')}},
        'Nlb': {'Type': 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'Properties': {
            'Name': 'llmar-idspike-nlb', 'Type': 'network', 'Scheme': 'internal', 'IpAddressType': 'ipv4',
            'Subnets': [ref('PrivA'), ref('PrivB')], 'SecurityGroups': [ref('NlbSg')],
            'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic': 'off', 'Tags': tl}},
        'NlbTg': {'Type': 'AWS::ElasticLoadBalancingV2::TargetGroup', 'Properties': {
            'Name': 'llmar-idspike-stub', 'TargetType': 'ip', 'Protocol': 'TCP', 'Port': PORT, 'VpcId': ref('Vpc'),
            'HealthCheckProtocol': 'HTTP', 'HealthCheckPath': '/healthz', 'HealthCheckIntervalSeconds': 10,
            'HealthyThresholdCount': 2, 'UnhealthyThresholdCount': 2,
            'TargetGroupAttributes': [{'Key': 'deregistration_delay.timeout_seconds', 'Value': '30'}], 'Tags': tl}},
        'NlbListener': {'Type': 'AWS::ElasticLoadBalancingV2::Listener', 'Properties': {
            'LoadBalancerArn': ref('Nlb'), 'Protocol': 'TCP', 'Port': PORT,
            'DefaultActions': [{'Type': 'forward', 'TargetGroupArn': ref('NlbTg')}]}},
        'Cluster': {'Type': 'AWS::ECS::Cluster', 'Properties': {'ClusterName': 'llmar-idspike', 'Tags': tl}},
        'StubLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {'LogGroupName': '/llmar/idspike/stub', 'RetentionInDays': 3, 'Tags': tl}},
        'ExecRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-idspike-exec-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'ecs-tasks.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'Policies': [{'PolicyName': 'logs-only', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'],
                'Resource': sub('${StubLogs.Arn}')}]}}],
            'Tags': tl}},
        'TaskDef': {'Type': 'AWS::ECS::TaskDefinition', 'Properties': {
            'Family': 'llmar-idspike-stub', 'Cpu': '256', 'Memory': '512', 'NetworkMode': 'awsvpc',
            'RequiresCompatibilities': ['FARGATE'],
            'RuntimePlatform': {'CpuArchitecture': 'ARM64', 'OperatingSystemFamily': 'LINUX'},
            'ExecutionRoleArn': att('ExecRole', 'Arn'),
            'ContainerDefinitions': [{
                'Name': 'stub', 'Image': IMAGE, 'Essential': True, 'User': 'node', 'ReadonlyRootFilesystem': True,
                'Command': ['node', '-e', stub],
                'Environment': [{'Name': 'PORT', 'Value': str(PORT)}, {'Name': 'HOST', 'Value': '0.0.0.0'}],  # nosec B104 - awsvpc task in a private subnet, no public IP, no published port; SG admits only the hop
                'PortMappings': [{'Name': 'http', 'ContainerPort': PORT, 'Protocol': 'tcp', 'AppProtocol': 'http'}],
                'LogConfiguration': {'LogDriver': 'awslogs', 'Options': {
                    'awslogs-group': ref('StubLogs'), 'awslogs-region': REGION, 'awslogs-stream-prefix': 'stub'}}}],
            'Tags': tl}},
        'StubService': {'Type': 'AWS::ECS::Service', 'DependsOn': ['PrivDefault', 'PrivRtA', 'PrivRtB', 'NlbListener'], 'Properties': {
            'ServiceName': 'llmar-idspike-stub', 'Cluster': ref('Cluster'), 'TaskDefinition': ref('TaskDef'),
            'DesiredCount': 1, 'LaunchType': 'FARGATE', 'PropagateTags': 'SERVICE', 'EnableExecuteCommand': False,
            'HealthCheckGracePeriodSeconds': 30,
            'DeploymentConfiguration': {'DeploymentCircuitBreaker': {'Enable': True, 'Rollback': False}},
            'NetworkConfiguration': {'AwsvpcConfiguration': {'AssignPublicIp': 'DISABLED',
                                                             'Subnets': [ref('PrivA'), ref('PrivB')],
                                                             'SecurityGroups': [ref('TaskSg')]}},
            'LoadBalancers': [{'ContainerName': 'stub', 'ContainerPort': PORT, 'TargetGroupArn': ref('NlbTg')}],
            'Tags': tl}},
        # ---- gateway role: hop signer; S7 also needs one Bedrock profile and the connector's discovery calls.
        'GatewayRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-idspike-gateway-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'bedrock-agentcore.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')},
                              'ArnLike': {'aws:SourceArn': sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:gateway/' + GATEWAY_NAME + '-*')}}}]},
            'Policies': [{'PolicyName': 's7-bedrock', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'InferenceProfile', 'Effect': 'Allow', 'Action': ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                 'Resource': [profile_arn], 'Condition': {'StringEquals': {'aws:RequestedRegion': ref('AWS::Region')}}},
                {'Sid': 'ProfileModelInRegion', 'Effect': 'Allow', 'Action': ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                 'Resource': [sub('arn:aws:bedrock:${AWS::Region}::foundation-model/' + base_model)],
                 'Condition': {'StringEquals': {'aws:RequestedRegion': ref('AWS::Region'), 'bedrock:InferenceProfileArn': profile_arn}}},
                {'Sid': 'GlobalProfileModel', 'Effect': 'Allow', 'Action': ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                 'Resource': [f'arn:aws:bedrock:::foundation-model/{base_model}'],
                 'Condition': {'StringEquals': {'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': profile_arn}}},
                {'Sid': 'ConnectorDiscovery', 'Effect': 'Allow', 'Action': CONNECTOR_DISCOVERY, 'Resource': '*'}]}}],
            'Tags': tl}},
        'GatewayRoleApiPolicy': {'Type': 'AWS::IAM::RolePolicy', 'Properties': {
            'RoleName': ref('GatewayRole'), 'PolicyName': 'execute-api-invoke-only',
            'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'InvokeRouterApi', 'Effect': 'Allow', 'Action': 'execute-api:Invoke', 'Resource': api_invoke}]}}},
        'VpcLink': {'Type': 'AWS::ApiGateway::VpcLink', 'Properties': {
            'Name': 'llmar-idspike-link', 'TargetArns': [ref('Nlb')], 'Tags': tl}},
        'RestApi': {'Type': 'AWS::ApiGateway::RestApi', 'Properties': {
            'Name': 'llmar-idspike-api', 'Description': 'llm-auto-router identity spike (private, AWS_IAM)',
            'EndpointConfiguration': {'Types': ['PRIVATE'], 'VpcEndpointIds': [ref('Vpce')]},
            'Policy': {'Version': '2012-10-17', 'Statement': [
                {'Sid': 'GatewayRoleViaEndpoint', 'Effect': 'Allow', 'Principal': {'AWS': att('GatewayRole', 'Arn')},
                 'Action': 'execute-api:Invoke', 'Resource': f'execute-api:/{STAGE}/*/*',
                 'Condition': {'StringEquals': {'aws:SourceVpce': ref('Vpce')}}},
                {'Sid': 'DenyOtherEndpoints', 'Effect': 'Deny', 'Principal': '*', 'Action': 'execute-api:Invoke',
                 'Resource': 'execute-api:/*', 'Condition': {'StringNotEquals': {'aws:SourceVpce': ref('Vpce')}}},
                {'Sid': 'DenyOtherPrincipals', 'Effect': 'Deny', 'Principal': '*', 'Action': 'execute-api:Invoke',
                 'Resource': 'execute-api:/*', 'Condition': {'ArnNotEquals': {'aws:PrincipalArn': att('GatewayRole', 'Arn')}}}]},
            'Tags': tl}},
        'ProxyResource': {'Type': 'AWS::ApiGateway::Resource', 'Properties': {
            'RestApiId': ref('RestApi'), 'ParentId': att('RestApi', 'RootResourceId'), 'PathPart': '{proxy+}'}},
        'ProxyAny': {'Type': 'AWS::ApiGateway::Method', 'Properties': {
            'RestApiId': ref('RestApi'), 'ResourceId': ref('ProxyResource'), 'HttpMethod': 'ANY',
            'AuthorizationType': 'AWS_IAM', 'ApiKeyRequired': False,
            'RequestParameters': {'method.request.path.proxy': True, 'method.request.header.x-api-key': False},
            'Integration': {
                'Type': 'HTTP_PROXY', 'IntegrationHttpMethod': 'ANY', 'ConnectionType': 'VPC_LINK', 'ConnectionId': ref('VpcLink'),
                'Uri': sub('http://${Nlb.DNSName}:' + str(PORT) + '/' + STAGE + '/{proxy}'),
                'RequestParameters': {
                    'integration.request.path.proxy': 'method.request.path.proxy',
                    'integration.request.header.x-router-caller-arn': 'context.identity.userArn',
                    'integration.request.header.x-router-source-vpce': 'context.identity.vpceId',
                    # a3 §1.3 fallback 1, measured in the same run: an explicit copy of x-api-key under another name.
                    'integration.request.header.x-router-identity': 'method.request.header.x-api-key'},
                'ResponseTransferMode': 'STREAM', 'TimeoutInMillis': 900000, 'PassthroughBehavior': 'WHEN_NO_MATCH'}}},
        'Deployment': {'Type': 'AWS::ApiGateway::Deployment', 'DependsOn': ['ProxyAny'], 'Properties': {
            'RestApiId': ref('RestApi'), 'Description': 'llmar-idspike'}},
        'Stage': {'Type': 'AWS::ApiGateway::Stage', 'Properties': {
            'RestApiId': ref('RestApi'), 'DeploymentId': ref('Deployment'), 'StageName': STAGE, 'Tags': tl}},
        'ProbeLogs': {'Type': 'AWS::Logs::LogGroup', 'Properties': {
            'LogGroupName': '/aws/lambda/llmar-idspike-probe', 'RetentionInDays': 3, 'Tags': tl}},
        'ProbeRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'RoleName': 'llmar-idspike-probe-role',
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
                'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole',
                'Condition': {'StringEquals': {'aws:SourceAccount': ref('AWS::AccountId')}}}]},
            'ManagedPolicyArns': ['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
            'Policies': [{'PolicyName': 'invoke-api-identity-allow', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Effect': 'Allow', 'Action': 'execute-api:Invoke', 'Resource': api_invoke}]}}],
            'Tags': tl}},
        'ProbeFn': {'Type': 'AWS::Lambda::Function', 'Properties': {
            'FunctionName': 'llmar-idspike-probe', 'Runtime': 'python3.13', 'Handler': 'index.handler',
            'Architectures': ['arm64'], 'MemorySize': 256, 'Timeout': 90,
            'Role': att('ProbeRole', 'Arn'), 'Code': {'ZipFile': probe},
            'VpcConfig': {'SubnetIds': [ref('PrivA'), ref('PrivB')], 'SecurityGroupIds': [ref('ClientSg')]},
            'LoggingConfig': {'LogGroup': ref('ProbeLogs')}, 'Tags': tl}},
        # ---- Cognito: admin-created users only; MFA off for the spike user (the console pool turns it on).
        'UserPool': {'Type': 'AWS::Cognito::UserPool', 'Properties': {
            'UserPoolName': 'llmar-idspike-users', 'UserPoolTier': 'ESSENTIALS', 'DeletionProtection': 'INACTIVE',
            'AdminCreateUserConfig': {'AllowAdminCreateUserOnly': True}, 'MfaConfiguration': 'OFF',
            'UsernameConfiguration': {'CaseSensitive': False},
            'Policies': {'PasswordPolicy': {'MinimumLength': 14, 'RequireLowercase': True, 'RequireUppercase': True,
                                            'RequireNumbers': True, 'RequireSymbols': True}},
            'UserPoolTags': TAGS}},
        'Domain': {'Type': 'AWS::Cognito::UserPoolDomain', 'Properties': {
            'UserPoolId': ref('UserPool'), 'Domain': domain_prefix, 'ManagedLoginVersion': 2}},
        'ResourceServer': {'Type': 'AWS::Cognito::UserPoolResourceServer', 'Properties': {
            'UserPoolId': ref('UserPool'), 'Identifier': RS_ID, 'Name': 'llmar-idspike',
            'Scopes': [{'ScopeName': 'invoke', 'ScopeDescription': 'call the gateway'},
                       {'ScopeName': 'other', 'ScopeDescription': 'a scope the gateway does not accept (S0)'}]}},
        'M2mA': m2m('llmar-idspike-m2m-a', [SCOPE]),
        'M2mB': m2m('llmar-idspike-m2m-b', [SCOPE]),
        'M2mShort': m2m('llmar-idspike-m2m-short', [SCOPE], minutes=5),  # S2: a signed token that is expired 5 min later
        'M2mOther': m2m('llmar-idspike-m2m-other', [OTHER_SCOPE]),
        'Cli': {'Type': 'AWS::Cognito::UserPoolClient', 'DependsOn': 'ResourceServer', 'Properties': {
            'UserPoolId': ref('UserPool'), 'ClientName': 'llmar-idspike-cli', 'GenerateSecret': False,
            'AllowedOAuthFlowsUserPoolClient': True, 'AllowedOAuthFlows': ['code'],
            'AllowedOAuthScopes': ['openid', SCOPE], 'CallbackURLs': [CALLBACK], 'SupportedIdentityProviders': ['COGNITO'],
            'ExplicitAuthFlows': ['ALLOW_REFRESH_TOKEN_AUTH'], 'PreventUserExistenceErrors': 'ENABLED', 'EnableTokenRevocation': True,
            'AccessTokenValidity': 30, 'IdTokenValidity': 30, 'RefreshTokenValidity': 1,
            'TokenValidityUnits': {'AccessToken': 'minutes', 'IdToken': 'minutes', 'RefreshToken': 'days'}}},
        # Managed login v2: every interactive client needs a branding style, or it has no sign-in pages.
        'CliBranding': {'Type': 'AWS::Cognito::ManagedLoginBranding', 'DependsOn': 'Domain', 'Properties': {
            'UserPoolId': ref('UserPool'), 'ClientId': ref('Cli'), 'UseCognitoProvidedValues': True}},
        # ---- AgentCore Gateway: CUSTOM_JWT, scope-only (design v1 0.4: no allowedClients)
        'Gateway': {'Type': 'AWS::BedrockAgentCore::Gateway', 'DependsOn': ['GatewayRoleApiPolicy', 'Stage', 'ResourceServer'], 'Properties': {
            'Name': GATEWAY_NAME, 'AuthorizerType': 'CUSTOM_JWT', 'ExceptionLevel': 'DEBUG', 'RoleArn': att('GatewayRole', 'Arn'),
            'AuthorizerConfiguration': {'CustomJWTAuthorizer': {
                'DiscoveryUrl': sub('https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}/.well-known/openid-configuration'),
                'AllowedScopes': [SCOPE]}},
            'Description': 'llm-auto-router identity spike (CUSTOM_JWT scope-only, private REST API hop)', 'Tags': TAGS}},
    }
    vpce_dns = {'Fn::Select': [1, {'Fn::Split': [':', {'Fn::Select': [0, att('Vpce', 'DnsEntries')]}]}]}
    return {
        'AWSTemplateFormatVersion': '2010-09-09',
        'Description': 'llm-auto-router identity spike: AgentCore Gateway (CUSTOM_JWT) -> private REST API (AWS_IAM) -> VPC link -> NLB -> Fargate echo stub. Delete after use.',
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
            'UserPoolId': {'Value': ref('UserPool')},
            'DomainPrefix': {'Value': domain_prefix},
            'CliClientId': {'Value': ref('Cli')},
            'M2mAClientId': {'Value': ref('M2mA')},
            'M2mBClientId': {'Value': ref('M2mB')},
            'M2mShortClientId': {'Value': ref('M2mShort')},
            'M2mOtherClientId': {'Value': ref('M2mOther')},
        },
    }


# ---------------------------------------------------------------- deploy and S0 gate

def cfn_wait(cfn: Any, waiter: str) -> None:
    try:
        cfn.get_waiter(waiter).wait(StackName=STACK, WaiterConfig={'Delay': 15, 'MaxAttempts': 120})
    except Exception as err:  # noqa: BLE001
        try:
            for e in cfn.describe_stack_events(StackName=STACK)['StackEvents'][:40]:
                if 'FAILED' in e['ResourceStatus']:
                    print(e['LogicalResourceId'], e['ResourceStatus'], mask(e.get('ResourceStatusReason')))
        except Exception as e:  # noqa: BLE001
            print(f'could not list stack events: {type(e).__name__}')
        sys.exit(f'stack operation failed: {type(err).__name__}; run teardown before retrying')


def cmd_deploy(_: argparse.Namespace) -> None:
    if stack():
        sys.exit(f'stack {STACK} already exists; use status or teardown')
    cfn = session.client('cloudformation')
    body = json.dumps(template())
    tags = [{'Key': k, 'Value': v} for k, v in TAGS.items()]
    cfn.create_stack(StackName=STACK, TemplateBody=body, Capabilities=['CAPABILITY_NAMED_IAM'],
                     Parameters=[{'ParameterKey': 'ApiIdForEndpointPolicy', 'ParameterValue': ''}], Tags=tags, OnFailure='ROLLBACK')
    print('creating stack', STACK, 'in', REGION)
    cfn_wait(cfn, 'stack_create_complete')
    print('scoping the VPC endpoint policy to the API (update pass)')
    cfn.update_stack(StackName=STACK, TemplateBody=body, Capabilities=['CAPABILITY_NAMED_IAM'],
                     Parameters=[{'ParameterKey': 'ApiIdForEndpointPolicy', 'ParameterValue': outputs()['RestApiId']}], Tags=tags)
    cfn_wait(cfn, 'stack_update_complete')
    print(json.dumps(mask(outputs()), indent=2))


def target_health() -> list[dict[str, Any]]:
    return session.client('elbv2').describe_target_health(TargetGroupArn=outputs()['TargetGroupArn'])['TargetHealthDescriptions']


def task_ip() -> str:
    ecs = session.client('ecs')
    arns = ecs.list_tasks(cluster='llmar-idspike', serviceName='llmar-idspike-stub', desiredStatus='RUNNING')['taskArns']
    if not arns:
        sys.exit('no running stub task')
    task = ecs.describe_tasks(cluster='llmar-idspike', tasks=arns[:1])['tasks'][0]
    for a in task['attachments']:
        for d in a['details']:
            if d['name'] == 'privateIPv4Address':
                return d['value']
    sys.exit('stub task has no private IP yet')


def cmd_status(_: argparse.Namespace) -> None:
    print(json.dumps(mask({'outputs': outputs(), 'state': load_state(), 'targets': target_health()}), indent=2, default=str))


def cmd_gate(_: argparse.Namespace) -> None:
    """S0 (before any target): the V9d network gate, plus the scope-only authorizer refuses anonymous, junk and
    wrong-scope tokens, while a valid token gets past it (so the denials come from the authorizer, not from routing)."""
    s, out = stack(), outputs()
    if load_state()['targets']:
        sys.exit('STOP: a gateway target already exists; gate must run with no target (teardown and redeploy)')
    for _ in range(36):
        health = target_health()
        if any(t['TargetHealth']['State'] == 'healthy' for t in health):
            break
        time.sleep(10)
    else:
        sys.exit(f'stub target never became healthy: {mask(health)}')
    vpce_policy = json.loads(session.client('ec2').describe_vpc_endpoints(VpcEndpointIds=[out['VpceId']])['VpcEndpoints'][0]['PolicyDocument'])
    probe = json.loads(session.client('lambda').invoke(
        FunctionName=out['ProbeFn'],
        Payload=json.dumps({'vpceDns': out['VpceDns'], 'apiHost': out['ApiHost'], 'region': REGION, 'taskIp': task_ip(),
                            'nlbDns': out['NlbDns'], 'port': PORT}).encode())['Payload'].read())

    def outside(url: str) -> Any:
        try:
            r = requests.get(url, timeout=30)
            return {'status': r.status_code}
        except requests.exceptions.ConnectionError as err:
            return {'unreachable': 'name resolution failed' if 'NameResolution' in repr(err) else 'connection failed'}
    outside_api = outside(f"https://{out['ApiHost']}/{STAGE}/models")
    msg = body_for('/v1/messages', 'id-echo')
    a, other = m2m_token('M2mAClientId'), m2m_token('M2mOtherClientId', OTHER_SCOPE)
    auth = {
        'anonymous': call('/v1/messages', msg, {}),
        'junk_bearer': call('/v1/messages', msg, {'Authorization': 'Bearer not-a-token'}),
        'wrong_scope_token': call('/v1/messages', msg, {'Authorization': f'Bearer {other}'}),
        'valid_token_no_target': call('/v1/messages', msg, {'Authorization': f'Bearer {a}'}),
    }
    nlb = probe.get('direct_tcp_nlb') or []
    denied = lambda r: r.get('status') in (401, 403)  # noqa: E731
    checks = {
        'probe_unsigned_403': all((probe.get(k) or {}).get('status') == 403 for k in ('unsigned_models', 'unsigned_messages')),
        'probe_other_role_403': all((probe.get(k) or {}).get('status') == 403 for k in ('other_role_models', 'other_role_messages')),
        'probe_direct_tcp_task_timeout': (probe.get('direct_tcp_task') or {}).get('result') == 'timeout',
        'probe_direct_tcp_nlb_timeout': bool(nlb) and all(n.get('result') == 'timeout' for n in nlb),
        'outside_vpc_api_denied': 'unreachable' in outside_api or outside_api.get('status') == 403,
        'vpce_policy_scoped_to_api': out['RestApiId'] in json.dumps(vpce_policy),
        'gateway_anonymous_denied': denied(auth['anonymous']),
        'gateway_junk_bearer_denied': denied(auth['junk_bearer']),
        'gateway_wrong_scope_denied': denied(auth['wrong_scope_token']),
        'gateway_valid_token_passes_authorizer': auth['valid_token_no_target'].get('status') not in (None, 401, 403),
        'no_2xx_anywhere': not any(200 <= (r.get('status') or 0) < 300 for r in auth.values()),
    }
    res = save_result('gate', {'passed': all(checks.values()), 'checks': checks, 'stackCreated': str(s['CreationTime']),
                               'probe': probe, 'outside_vpc_api': outside_api, 'gateway_auth': auth, 'vpce_policy': vpce_policy,
                               'claims_m2m': claim_report(a), 'target_health': health})
    print(json.dumps(res['checks'], indent=2))
    if not res['passed']:
        sys.exit('STOP: gate failed; do not create the gateway target. Tear down and investigate.')
    print('GATE PASSED')


# ---------------------------------------------------------------- S1 forwarding

def wait_target(gw: str, target_id: str) -> dict[str, Any]:
    for _ in range(120):
        t = ctl().get_gateway_target(gatewayIdentifier=gw, targetId=target_id)
        if t['status'] not in ('CREATING', 'UPDATING'):
            return t
        time.sleep(10)
    return t


def create_router_target() -> dict[str, Any]:
    state, out = load_state(), outputs()
    if TARGET in state['targets']:
        return {'targetId': state['targets'][TARGET], 'reused': True, 'idHeader': state['idHeader']}
    ops = [{'path': p, 'models': [{'model': 'id-*'}]} for p in PATHS]
    params: dict[str, Any] = {
        'gatewayIdentifier': out['GatewayId'], 'name': TARGET,
        'targetConfiguration': {'inference': {'provider': {'endpoint': 'https://' + out['ApiHost'], 'operations': ops}}},
        'credentialProviderConfigurations': [{'credentialProviderType': 'GATEWAY_IAM_ROLE', 'credentialProvider': {
            'iamCredentialProvider': {'service': 'execute-api', 'region': REGION}}}],
        'privateEndpoint': {'managedVpcResource': {
            'vpcIdentifier': out['VpcId'], 'subnetIds': out['PrivSubnetIds'].split(','), 'endpointIpAddressType': 'IPV4',
            'securityGroupIds': [out['ClientSgId']], 'routingDomain': out['VpceDns'], 'tags': TAGS}},
        'metadataConfiguration': {'allowedRequestHeaders': BASE_HEADERS + [ID_HEADER], 'allowedResponseHeaders': RESP_HEADERS},
    }
    result: dict[str, Any] = {'idHeader': ID_HEADER}
    try:
        created = ctl().create_gateway_target(**params)
    except ctl().exceptions.ValidationException as err:  # refusing x-api-key in the allowlist is itself the finding
        result['x_api_key_allowlist_refused'] = str(err)[:400]
        params['metadataConfiguration']['allowedRequestHeaders'] = BASE_HEADERS + [ID_HEADER_FALLBACK]
        created = ctl().create_gateway_target(**params)
        result['idHeader'] = ID_HEADER_FALLBACK
    state['targets'][TARGET] = created['targetId']
    state['idHeader'] = result['idHeader']
    save_state(state)
    t = wait_target(out['GatewayId'], created['targetId'])
    result.update({'targetId': created['targetId'], 'status': t['status'], 'statusReasons': t.get('statusReasons')})
    state['resourceGateways'] = sorted({*state.get('resourceGateways', []), *(g['id'] for g in resource_gateways(out['VpcId']))})
    save_state(state)
    return result


def cmd_s1(_: argparse.Namespace) -> None:
    """S1: the allowlist accepts x-api-key, and the value reaches the stub byte for byte on every path, streaming and
    not; header-value size limit; header census at the stub; and the REST mapping copy (x-router-identity)."""
    require_gate()
    created = create_router_target()
    print('target', created.get('status'), 'idHeader', created['idHeader'])
    if created.get('status') not in ('READY', None):
        save_result('s1', {'target': created})
        sys.exit('router target is not READY')
    time.sleep(20)
    idh = created['idHeader']
    a = m2m_token('M2mAClientId')
    calls: dict[str, Any] = {}
    for p in PATHS:
        for stream in (False, True):
            r = call(p, body_for(p, 'id-echo', stream=stream), {'Authorization': f'Bearer {a}', idh: a}, stream=stream)
            calls[f'{p}{" stream" if stream else ""}'] = {**r, 'idHeaderSaw': matches(r, {'A': a}, 'xApiKey' if idh == ID_HEADER else 'xRouterIdentity'),
                                                          'mappingCopySaw': matches(r, {'A': a}, 'xRouterIdentity')}
    sizes: dict[str, Any] = {}
    for n in (3900, 4200):
        v = 'a' * n
        r = call('/v1/messages', body_for('/v1/messages', 'id-echo'), {'Authorization': f'Bearer {a}', idh: v})
        sizes[str(n)] = {'status': r.get('status'), 'saw': matches(r, {'sent': v}, 'xApiKey' if idh == ID_HEADER else 'xRouterIdentity'),
                         'body': r.get('body') if not r.get('echo') else None}
    first = next((c['echo'] for c in calls.values() if c.get('echo')), {}) or {}
    findings = {
        'idHeader': idh,
        'x_api_key_allowlisted': idh == ID_HEADER,
        'all_calls_200': all(c.get('status') == 200 for c in calls.values()),
        'forwarded_unchanged_every_call': all(c['idHeaderSaw'] == 'A' for c in calls.values()),
        'rest_mapping_copy_unchanged': all(c['mappingCopySaw'] == 'A' for c in calls.values()) if idh == ID_HEADER else None,
        'authorization_scheme_at_stub': first.get('authorizationScheme'),  # expected AWS4-HMAC-SHA256 (the hop's SigV4), never Bearer
        'size_3900': sizes['3900'], 'size_4200': sizes['4200'],
        'header_names_at_stub': first.get('headerNames'),
        'amz_and_router_values_at_stub': first.get('amz'),
    }
    print(json.dumps(mask({k: v for k, v in findings.items() if k not in ('header_names_at_stub', 'amz_and_router_values_at_stub')}), indent=2))
    save_result('s1', {'target': created, 'findings': findings, 'calls': calls, 'claims_m2m': claim_report(a)})


# ---------------------------------------------------------------- S2 precedence

def st0(res: dict[str, Any], name: str) -> int | None:
    return (res.get(name) or {}).get('status')


def cmd_s2(args: argparse.Namespace) -> None:
    """S2: which credential the gateway authenticates when both headers are present, whether it strips or forwards
    x-api-key, and Bearer-prefixed values. Cases d/g need a signed token that has expired: S2 mints a 5-minute token
    first and runs those cases last, after it expires (about 5.5 min of waiting; --no-expired skips them)."""
    require_target()
    idh = load_state()['idHeader']
    field = 'xApiKey' if idh == ID_HEADER else 'xRouterIdentity'
    e = None if args.no_expired else m2m_token('M2mShortClientId')
    a, b = m2m_token('M2mAClientId'), m2m_token('M2mBClientId')
    other = m2m_token('M2mOtherClientId', OTHER_SCOPE)
    junk = 'junk-not-a-jwt'
    sent = {'A': a, 'B': b, 'E': e, 'junk': junk, 'Bearer A': f'Bearer {a}', 'other': other}
    msg = body_for('/v1/messages', 'id-echo')
    cases: list[tuple[str, dict[str, str]]] = [
        ('a_auth_valid__key_junk', {'Authorization': f'Bearer {a}', idh: junk}),
        ('b_no_auth__key_valid', {idh: a}),
        ('b2_no_auth__key_bearer_valid', {idh: f'Bearer {a}'}),
        ('c_auth_A__key_B', {'Authorization': f'Bearer {a}', idh: b}),
        ('e_auth_valid__key_bearer_valid', {'Authorization': f'Bearer {a}', idh: f'Bearer {a}'}),
        ('f_auth_junk__key_valid', {'Authorization': f'Bearer {junk}', idh: a}),
        ('h_no_auth__key_other_scope', {idh: other}),
        ('i_auth_valid_no_key', {'Authorization': f'Bearer {a}'}),
    ]
    res: dict[str, Any] = {}

    def run(name: str, headers: dict[str, str]) -> None:
        r = call('/v1/messages', msg, headers)
        res[name] = {'status': r.get('status'), 'saw': matches(r, sent, field), 'errorType': (r.get('headers') or {}).get('x-amzn-errortype'),
                     'body': r.get('body') if not r.get('echo') else None}
        if e is not None and any(e in v for v in headers.values()):
            res[name]['secondsPastExp'] = round(time.time() - claims(e)['exp'])
        print(name, res[name]['status'], res[name]['saw'])
    for name, headers in cases:
        run(name, headers)
    if e is not None:
        wait = max(0, claims(e)['exp'] - time.time()) + 20
        print(f'waiting {round(wait)} s for the short token to expire (cases d, g)')
        time.sleep(wait)
        a = m2m_token('M2mAClientId')  # fresh valid token for the remaining cases
        sent['A'], sent['Bearer A'] = a, f'Bearer {a}'
        expired = {
            'd_auth_valid__key_expired': lambda: {'Authorization': f'Bearer {a}', idh: e},
            'g_auth_expired__key_valid': lambda: {'Authorization': f'Bearer {e}', idh: a},
            'j_no_auth__key_expired': lambda: {idh: e},
        }
        for name, hdrs in expired.items():
            run(name, hdrs())
        # An expired token accepted by the gateway may be clock-skew leeway: retry at exp + 6 min before concluding.
        accepted = [n for n in ('g_auth_expired__key_valid', 'j_no_auth__key_expired') if st0(res, n) == 200]
        if accepted:
            wait = max(0, claims(e)['exp'] + 360 - time.time())
            print(f'expired token accepted in {accepted}; retrying at exp+6 min (waiting {round(wait)} s)')
            time.sleep(wait)
            a = m2m_token('M2mAClientId')
            sent['A'], sent['Bearer A'] = a, f'Bearer {a}'
            for n in accepted:
                run(f'{n}__retry_exp_plus_6min', expired[n]())
    st = lambda k: st0(res, k)  # noqa: E731
    saw = lambda k: (res.get(k) or {}).get('saw')  # noqa: E731
    findings = {
        'idHeader': idh,
        'key_forwarded_when_authorization_present': saw('a_auth_valid__key_junk') == 'junk' and saw('c_auth_A__key_B') == 'B',
        'gateway_validates_key_when_authorization_present': st('a_auth_valid__key_junk') in (401, 403),
        'gateway_accepts_jwt_in_key_alone': st('b_no_auth__key_valid') == 200,
        'key_forwarded_when_used_as_credential': saw('b_no_auth__key_valid') == 'A',
        'gateway_accepts_bearer_prefixed_key_alone': st('b2_no_auth__key_bearer_valid') == 200,
        'bearer_prefix_forwarded_as_sent': saw('e_auth_valid__key_bearer_valid') == 'Bearer A',
        'authorization_wins_over_key': st('f_auth_junk__key_valid') in (401, 403),
        'key_scope_checked_when_credential': st('h_no_auth__key_other_scope') in (401, 403),
        'expired_key_with_valid_authorization': {'status': st('d_auth_valid__key_expired'), 'saw': saw('d_auth_valid__key_expired')},
        'expired_authorization_with_valid_key': st('g_auth_expired__key_valid'),
        'expired_key_alone': st('j_no_auth__key_expired'),
        # Leeway: the status at exp + 6 min, where an accepted expired token was retried (absent if none was accepted).
        'expired_retry_exp_plus_6min': {n: st(n) for n in res if n.endswith('__retry_exp_plus_6min')},
        # C1 gate for design 0.1: the stub must see x-api-key when Authorization is present (else a3 §1.3 item 2).
        'header_path_ok': saw('c_auth_A__key_B') == 'B',
    }
    print(json.dumps(mask(findings), indent=2))
    save_result('s2', {'findings': findings, 'cases': res})


# ---------------------------------------------------------------- S4 user tokens

def cmd_s4(_: argparse.Namespace) -> None:
    """S4: user-pool access tokens from auth code + PKCE (managed login v2, 127.0.0.1 callback) pass the scope-only
    authorizer; refresh keeps the scope; an ID token and a token without the invoke scope are refused."""
    require_target()
    idh = load_state()['idHeader']
    field = 'xApiKey' if idh == ID_HEADER else 'xRouterIdentity'
    out = outputs()
    password = ensure_spike_user()
    if HERE.parents[1] in PASSWORD_FILE.resolve().parents:
        sys.exit('refusing to write the password inside the repository')
    fd = os.open(PASSWORD_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        fh.write(password + '\n')
    os.chmod(PASSWORD_FILE, 0o600)
    del password
    print(f'spike user {SPIKE_USER}: password written to {PASSWORD_FILE} (0600; deleted by teardown)')
    msg = body_for('/v1/messages', 'id-echo')
    t1 = browser_login(f'openid {SCOPE}')
    at, idt, rt = t1['access_token'], t1['id_token'], t1.get('refresh_token')
    res: dict[str, Any] = {'claims_access': claim_report(at, out['CliClientId']), 'claims_id': claim_report(idt, out['CliClientId']),
                           'refreshTokenIssued': rt is not None}
    r = call('/v1/messages', msg, {'Authorization': f'Bearer {at}', idh: at})
    res['access_token_call'] = {'status': r.get('status'), 'saw': matches(r, {'access': at}, field)}
    r = call('/v1/messages', msg, {idh: at})
    res['access_token_in_key_alone'] = {'status': r.get('status'), 'saw': matches(r, {'access': at}, field)}
    r = call('/v1/messages', msg, {'Authorization': f'Bearer {idt}'})
    res['id_token_call'] = {'status': r.get('status'), 'errorType': (r.get('headers') or {}).get('x-amzn-errortype')}
    if rt:
        rf = refresh(rt)
        res['refresh'] = {'status': rf['status'], 'newRefreshToken': 'refresh_token' in rf.get('tokens', {})}
        if rf['status'] == 200:
            at2 = rf['tokens']['access_token']
            res['claims_refreshed'] = claim_report(at2, out['CliClientId'])
            r = call('/v1/messages', msg, {'Authorization': f'Bearer {at2}', idh: at2})
            res['refreshed_token_call'] = {'status': r.get('status'), 'saw': matches(r, {'refreshed': at2}, field)}
    t2 = browser_login('openid')
    res['claims_no_invoke'] = claim_report(t2['access_token'], out['CliClientId'])
    r = call('/v1/messages', msg, {'Authorization': f"Bearer {t2['access_token']}"})
    res['no_invoke_scope_call'] = {'status': r.get('status'), 'errorType': (r.get('headers') or {}).get('x-amzn-errortype')}
    res['revoked'] = [revoke(t) for t in (rt, t2.get('refresh_token')) if t]
    ca = res['claims_access']
    res['findings'] = {
        'access_token_claims_ok': ca['token_use'] == 'access' and ca['clientIdIsCli'] and SCOPE in ca['scope'] and ca['hasUsername'] and not ca['subEqualsClientId'],
        'access_token_has_aud': ca['hasAud'],
        'access_token_passes_gateway': res['access_token_call']['status'] == 200,
        'access_token_forwarded_unchanged': res['access_token_call']['saw'] == 'access',
        'access_token_in_key_alone_status': res['access_token_in_key_alone']['status'],
        'id_token_refused': res['id_token_call']['status'] in (401, 403),
        'refresh_keeps_scope': SCOPE in (res.get('claims_refreshed') or {}).get('scope', []),
        'refreshed_token_passes_gateway': (res.get('refreshed_token_call') or {}).get('status') == 200,
        'no_invoke_scope_refused': res['no_invoke_scope_call']['status'] in (401, 403),
        'access_token_length': ca['length'],
    }
    print(json.dumps(mask(res['findings']), indent=2))
    save_result('s4', res)


# ---------------------------------------------------------------- S7 bypass

def wait_rule(gw: str, rule_id: str) -> dict[str, Any]:
    for _ in range(60):
        g = ctl().get_gateway_rule(gatewayIdentifier=gw, ruleId=rule_id)
        if g.get('status') not in ('CREATING', 'UPDATING'):
            return g
        time.sleep(5)
    return g


def make_rule(name: str, res: dict[str, Any], **params: Any) -> bool:
    """Creates a rule once (recorded in state). Errors (untested call shapes) are recorded, never fatal."""
    state, gw = load_state(), outputs()['GatewayId']
    try:
        if name not in state['rules']:
            state['rules'][name] = ctl().create_gateway_rule(gatewayIdentifier=gw, **params)['ruleId']
            save_state(state)
        g = wait_rule(gw, state['rules'][name])
        res.setdefault('rules', {})[name] = {'status': g.get('status'), 'priority': g.get('priority')}
        return True
    except Exception as err:  # noqa: BLE001 - the error is the finding
        res.setdefault('rules', {})[name] = {'error': f'{type(err).__name__}: {mask(str(err))[:400]}'}
        print('rule', name, 'failed:', res['rules'][name]['error'])
        return False


def cmd_s7(_: argparse.Namespace) -> None:
    """S7: a concrete Bedrock id goes to the bedrock connector target (the bypass). Then production-like rules:
    - P100 (ordering probe): matchModels id-pri -> router, pinning model id-pri-by-p100;
    - P200: matchModels id-* -> router, fallback on 5XX to bedrock with the S7 model (the MVP's auto* rule);
    - P1,000,000: no conditions -> router (the catch-all, design 0.3).
    Checks: the concrete id now reaches the router; a router 5xx (id-503) still falls back to bedrock; which way
    priority runs (lower number first is documented). About three Bedrock calls with max_tokens 1."""
    require_target()
    state, out = load_state(), outputs()
    gw, idh = out['GatewayId'], state['idHeader']
    res: dict[str, Any] = {'bedrockModel': BEDROCK_MODEL}
    try:
        if BEDROCK_TARGET not in state['targets']:
            created = ctl().create_gateway_target(
                gatewayIdentifier=gw, name=BEDROCK_TARGET, description='S7 bypass check',
                targetConfiguration={'inference': {'connector': {'source': {'connectorId': 'bedrock-runtime'}}}},
                credentialProviderConfigurations=[{'credentialProviderType': 'GATEWAY_IAM_ROLE'}])
            state['targets'][BEDROCK_TARGET] = created['targetId']
            save_state(state)
        t = wait_target(gw, state['targets'][BEDROCK_TARGET])
        res['bedrockTarget'] = {'status': t['status'], 'statusReasons': t.get('statusReasons')}
    except Exception as err:  # noqa: BLE001
        res['bedrockTarget'] = {'error': f'{type(err).__name__}: {mask(str(err))[:400]}'}
    print('bedrock target', res['bedrockTarget'])
    a = m2m_token('M2mAClientId')
    hdr = {'Authorization': f'Bearer {a}', idh: a}
    concrete = body_for('/v1/messages', BEDROCK_MODEL, max_tokens=1)
    view = lambda r: {'status': r.get('status'), 'reachedStub': bool(r.get('echo')), 'modelAtStub': (r.get('echo') or {}).get('model'),  # noqa: E731
                      'body': r.get('body') if not r.get('echo') else None}
    res['before_rules'] = view(call('/v1/messages', concrete, hdr))
    make_rule('p100_ordering', res, priority=100, description='S7 ordering probe',
              conditions=[{'matchModels': {'anyOf': [{'value': 'id-pri', 'operator': 'StringEquals'}]}}],
              actions=[{'routeToTarget': {'staticRoute': {'targetName': TARGET, 'model': 'id-pri-by-p100'}}}])
    make_rule('p200_fallback', res, priority=200, description='S7 production-like: id-* -> router, 5XX -> bedrock',
              conditions=[{'matchModels': {'anyOf': [{'value': 'id-*', 'operator': 'StringLike'}]}}],
              actions=[{'routeToTarget': {'staticRoute': {'targetName': TARGET, 'fallback': {
                  'triggerOn': {'statusCodes': ['5XX'], 'errors': ['CONNECTION_ERROR', 'UNROUTABLE']},
                  'targetFallback': [{'targetName': BEDROCK_TARGET, 'model': BEDROCK_MODEL}]}}}}])
    make_rule('catchall', res, priority=1_000_000, description='S7 catch-all -> router',
              actions=[{'routeToTarget': {'staticRoute': {'targetName': TARGET}}}])
    time.sleep(15)
    res['concrete_after_rules'] = view(call('/v1/messages', concrete, hdr))
    res['stub_model_after_rules'] = view(call('/v1/messages', body_for('/v1/messages', 'id-echo'), hdr))
    res['router_5xx_after_rules'] = view(call('/v1/messages', body_for('/v1/messages', 'id-503', max_tokens=1), hdr))
    res['ordering_probe'] = view(call('/v1/messages', body_for('/v1/messages', 'id-pri'), hdr))
    res['unknown_model_after_rules'] = view(call('/v1/chat/completions', body_for('/v1/chat/completions', 'unknown-model-xyz'), hdr))
    f503 = res['router_5xx_after_rules']
    order = res['ordering_probe'].get('modelAtStub')
    res['findings'] = {
        'concrete_id_served_by_bedrock_before_rules': res['before_rules']['status'] == 200 and not res['before_rules']['reachedStub'],
        'catchall_routes_concrete_id_to_router': res['concrete_after_rules']['reachedStub'] and res['concrete_after_rules']['modelAtStub'] == BEDROCK_MODEL,
        'concrete_after_rules_status': res['concrete_after_rules']['status'],
        'router_5xx_still_falls_back_to_bedrock': f503['status'] == 200 and not f503['reachedStub'],
        'router_5xx_status_seen': f503['status'],
        'stub_models_still_routed': res['stub_model_after_rules']['status'] == 200,
        'unknown_model_reaches_router': res['unknown_model_after_rules']['reachedStub'],
        # id-pri matches P100 (model pinned to id-pri-by-p100), P200 and the catch-all.
        'priority_ordering': ('lower-number-first' if order == 'id-pri-by-p100' else
                              'pin-not-applied-or-higher-first' if order == 'id-pri' else f'inconclusive ({order})'),
    }
    print(json.dumps(mask(res['findings']), indent=2))
    save_result('s7', res)


# ---------------------------------------------------------------- teardown

def _gone(fn: Any, **kw: Any) -> bool:
    try:
        fn(**kw)
        return False
    except ctl().exceptions.ResourceNotFoundException:
        return True


def _delete(fn: Any, what: str, **kw: Any) -> None:
    """Delete with retries on ConflictException (the resource is still changing state)."""
    for _ in range(30):
        try:
            fn(**kw)
            return
        except ctl().exceptions.ResourceNotFoundException:
            return
        except ctl().exceptions.ConflictException:
            print(f'{what}: conflict (still changing state), retrying in 10 s')
            time.sleep(10)
    sys.exit(f'{what}: still conflicting after 5 min; rerun teardown')


def delete_rules_and_targets() -> None:
    state, s = load_state(), stack()
    gw = next((o['OutputValue'] for o in (s or {}).get('Outputs', []) if o['OutputKey'] == 'GatewayId'), None)
    for name, rule_id in list(state.get('rules', {}).items()):
        if gw:
            _delete(ctl().delete_gateway_rule, f'rule {name}', gatewayIdentifier=gw, ruleId=rule_id)
            for _ in range(60):  # targets named by a rule cannot be deleted until the rule is gone
                if _gone(ctl().get_gateway_rule, gatewayIdentifier=gw, ruleId=rule_id):
                    break
                time.sleep(5)
            else:
                sys.exit(f'rule {name} still present after 5 min; rerun teardown')
        state['rules'].pop(name)
        save_state(state)
        print('rule deleted:', name)
    for name, target_id in list(state['targets'].items()):
        if gw:
            _delete(ctl().delete_gateway_target, f'target {name}', gatewayIdentifier=gw, targetId=target_id)
            for _ in range(90):
                if _gone(ctl().get_gateway_target, gatewayIdentifier=gw, targetId=target_id):
                    break
                time.sleep(10)
            else:
                sys.exit(f'target {name} still deleting after 15 min; rerun teardown')
        state['targets'].pop(name)
        save_state(state)
        print('target deleted:', name)


def vpc_id() -> str | None:
    vpcs = session.client('ec2').describe_vpcs(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-idspike-vpc']}])['Vpcs']
    return vpcs[0]['VpcId'] if vpcs else None


def resource_gateways(vpc: str | None) -> list[dict[str, Any]]:
    if not vpc:
        return []
    return [g for g in pages(session.client('vpc-lattice'), 'list_resource_gateways', 'items') if g.get('vpcIdentifier') == vpc]


def resource_configurations(gateway_ids: set[str]) -> list[dict[str, Any]]:
    """Lattice resource configurations on our resource gateways (by id, including ones recorded in state)."""
    if not gateway_ids:
        return []
    return [c for c in pages(session.client('vpc-lattice'), 'list_resource_configurations', 'items')
            if c.get('resourceGatewayId') in gateway_ids or any(g in (c.get('arn') or '') for g in gateway_ids)]


def lattice_ids(vpc: str | None) -> set[str]:
    return {*(g['id'] for g in resource_gateways(vpc)), *load_state().get('resourceGateways', [])}


def cmd_teardown(args: argparse.Namespace) -> None:
    delete_rules_and_targets()
    vpc = vpc_id()
    ids = lattice_ids(vpc)
    for _ in range(60):  # the managed resource gateway (and its configurations) hold ENIs in our subnets
        left = [g['name'] for g in resource_gateways(vpc)] + [c.get('name') for c in resource_configurations(ids)]
        if not left:
            break
        print('waiting for managed resource gateways / configurations:', left)
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
            sys.exit(f'stack delete failed: {type(err).__name__}; fix and rerun teardown')
    PASSWORD_FILE.unlink(missing_ok=True)
    cmd_verify(args)


def _lambda_gone(name: str) -> bool:
    lam = session.client('lambda')
    try:
        lam.get_function(FunctionName=name)
        return False
    except lam.exceptions.ResourceNotFoundException:
        return True


def cmd_verify(_: argparse.Namespace) -> None:
    """Verification listing: anything named llmar-idspike* (or in its VPC) that still exists."""
    ec2, apigw, vpc = session.client('ec2'), session.client('apigateway'), vpc_id()
    tagged = pages(session.client('resourcegroupstaggingapi'), 'get_resources', 'ResourceTagMappingList',
                   TagFilters=[{'Key': 'Project', 'Values': ['llm-auto-router']}, {'Key': 'Purpose', 'Values': ['spike']}])
    left = {
        'stack': bool(stack()),
        'gateways': [g['name'] for g in pages(ctl(), 'list_gateways', 'items') if g['name'].startswith('llmar-idspike')],
        'rest_apis': [a['name'] for a in pages(apigw, 'get_rest_apis', 'items') if a['name'].startswith('llmar-idspike')],
        'vpc_links': [v['name'] for v in pages(apigw, 'get_vpc_links', 'items') if v['name'].startswith('llmar-idspike')],
        'load_balancers': [lb['LoadBalancerName'] for lb in pages(session.client('elbv2'), 'describe_load_balancers', 'LoadBalancers')
                           if lb['LoadBalancerName'].startswith('llmar-idspike')],
        'target_groups': [tg['TargetGroupName'] for tg in pages(session.client('elbv2'), 'describe_target_groups', 'TargetGroups')
                          if tg['TargetGroupName'].startswith('llmar-idspike')],
        'vpc_endpoints': [e['VpcEndpointId'] for e in (ec2.describe_vpc_endpoints(Filters=[{'Name': 'vpc-id', 'Values': [vpc]}])['VpcEndpoints'] if vpc else [])
                          if e['State'].lower() not in ('deleted', 'deleting')],
        'resource_gateways_in_vpc': [g['name'] for g in resource_gateways(vpc)],
        'resource_configurations': [c.get('name') or c.get('id') for c in resource_configurations(lattice_ids(vpc))],
        'probe_function': [] if _lambda_gone('llmar-idspike-probe') else ['llmar-idspike-probe'],
        'password_file': [str(PASSWORD_FILE)] if PASSWORD_FILE.exists() else [],
        'ecs_clusters': [c['clusterName'] for c in session.client('ecs').describe_clusters(clusters=['llmar-idspike'])['clusters']
                         if c['status'] == 'ACTIVE'],
        'vpcs': [vpc] if vpc else [],
        'nat_gateways': [n['NatGatewayId'] for n in ec2.describe_nat_gateways(
            Filters=[{'Name': 'tag:Name', 'Values': ['llmar-idspike-nat']}])['NatGateways'] if n['State'] not in ('deleted', 'deleting')],
        'eips': [a['AllocationId'] for a in ec2.describe_addresses(Filters=[{'Name': 'tag:Name', 'Values': ['llmar-idspike-nat-eip']}])['Addresses']],
        'log_groups': [g['logGroupName'] for p in ('/llmar/idspike', '/aws/lambda/llmar-idspike')
                       for g in session.client('logs').describe_log_groups(logGroupNamePrefix=p)['logGroups']],
        'iam_roles': [r['RoleName'] for r in pages(session.client('iam'), 'list_roles', 'Roles') if r['RoleName'].startswith('llmar-idspike')],
        'user_pools': [p['Name'] for p in pages(session.client('cognito-idp'), 'list_user_pools', 'UserPools', MaxResults=60)
                       if p['Name'].startswith('llmar-idspike')],
    }
    spike_tagged = [r['ResourceARN'] for r in tagged if 'llmar-idspike' in r['ResourceARN'] or (vpc and vpc in r['ResourceARN'])]
    remaining = {k: v for k, v in left.items() if v}
    # ECS keeps INACTIVE clusters/services and STOPPED tasks visible for a while: tombstones once no cluster is ACTIVE.
    spike_tagged = [a for a in spike_tagged if not (':ecs:' in a and not left['ecs_clusters'])]
    if spike_tagged:
        remaining['tagged_idspike'] = spike_tagged
    save_result('teardown', {'remaining': remaining})
    if remaining:
        print(json.dumps(mask(remaining), indent=2))
        sys.exit('teardown NOT verified: resources remain')
    print('teardown verified: nothing left')


def main() -> None:
    global REGION, session, AZ_IDS
    commands = {n[4:]: f for n, f in globals().items() if n.startswith('cmd_')}
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=sorted(commands))
    parser.add_argument('--region', default=os.environ.get('LLMAR_SPIKE_REGION') or os.environ.get('AWS_REGION'))
    parser.add_argument('--az-ids', help='two AZ IDs with AgentCore managed private endpoints, comma-separated (default: AZ_IDS)')
    parser.add_argument('--no-expired', action='store_true', help='s2: skip the expired-token cases (saves ~5.5 min)')
    parser.add_argument('--print-template', action='store_true', help='print the template and exit (no AWS calls)')
    args = parser.parse_args()
    if not args.region:
        sys.exit('set --region, LLMAR_SPIKE_REGION or AWS_REGION')
    REGION = args.region
    if args.az_ids:
        AZ_IDS = {**AZ_IDS, REGION: tuple(args.az_ids.split(','))[:2]}
    if REGION not in AZ_IDS:
        sys.exit(f'no AZ IDs known for {REGION}: pass --az-ids <id1>,<id2>')
    if not BEDROCK_MODEL.startswith('global.'):
        sys.exit('LLMAR_IDSPIKE_BEDROCK_MODEL must be a global inference profile id (the IAM statements assume it)')
    if args.print_template:
        print(json.dumps(template(), indent=1))
        return
    session = boto3.Session(region_name=REGION)
    check_account()
    commands[args.command](args)


if __name__ == '__main__':
    main()
