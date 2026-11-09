# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3==1.40.70", "requests==2.34.2", "playwright==1.64.1"]
# ///
"""Admin console E2E on a deployed stack (design §3 C9, implement.md Phase 3). 17 wrote it; 0c runs it.

Usage:  source scripts/local.env && uv run --python 3.12 experiments/console-e2e/e2e.py phase <name> --region <r> [--prefix llmar]
        names: r | c1 | c2 | c3 | id | cleanup | all            (`status` prints the state table)
Order:  r (RouterStack) → c1 (console, bundle off, ingest off) → c2 (bundle on) → c3 (ingest on) → id → cleanup.
        `all` runs r..id and then cleanup, stopping (without cleanup) at the first failing phase.

Rules it enforces:
- No token, password or client secret is ever printed or written to results/. Test-user passwords are random, kept
  in memory, and persisted only in a 0600 file outside the repository (needed between phases; cleanup deletes it).
  Results and the state file hold statuses, codes, counts, durations and sha256[:12] digests; every value written
  or printed goes through mask() (12-digit runs, JWT shapes, long base64url runs).
- If LLMAR_E2E_ACCOUNT (or LLMAR_SPIKE_ACCOUNT) is set, the caller account must match it. It is never printed.
- Bedrock spend: every model call is small (max_tokens ≤ 64; pinned to the fast models, `--haiku` / `--luna`,
  except the `auto` checks that need the default tier). A conservative local estimate is kept per call, reconciled
  with the router's own costUsd from the log group after each phase; the run aborts before a call that could take
  either above $4.50 (--cap).
- Test users are e-mail usernames at example.com (RFC 2606): the console API's invite sends a Cognito e-mail.
- Every check is recorded in a state file in the work directory (~/.cache/llmar-e2e-<prefix>-<region>/, 0600,
  outside the repository); a passed check is skipped on a rerun (--force reruns). Created users and versions are
  reused. Masked per-phase results go to results/<phase>.json (gitignored).

Clients for c3: CLAUDE_BIN (default `claude`) and CODEX_BIN (default `codex`); missing binaries fail those checks.
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import string
import subprocess  # nosec B404 - fixed argv: llmar, claude, codex
import sys
import time
import urllib.parse
from typing import Any, Callable

import boto3
import botocore.exceptions
import requests

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / 'results'                       # gitignored
LLMAR = REPO / 'tools' / 'llmar' / 'llmar'
ROUTES_TS = REPO / 'packages' / 'console-contract' / 'src' / 'routes.ts'
SPEND_CAP = 4.50
MAX_TOKENS = 16
PROMPT = 'Reply with exactly: ok'


# ------------------------------------------------------------------------------------------------ safety

def mask(value: Any) -> Any:
    """12-digit runs (account ids), JWT shapes and long base64url runs never reach output or results/."""
    text = json.dumps(value, default=str, ensure_ascii=False)
    text = re.sub(r'(?<!\d)\d{12}(?!\d)', '<acct>', text)
    text = re.sub(r'eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}', '<jwt>', text)
    text = re.sub(r'[A-Za-z0-9_-]{40,}', '<b64>', text)
    return json.loads(text)


BEARERISH = re.compile(r'(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}')
SECRETISH = re.compile(r'(?i)\b(x-api-key|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|'
                       r'client[_-]?secret|secret)\b(["\']?\s*[:=]\s*["\']?)[^\s"\',;}]+')


def output_tail(text: str | bytes | None, *, secrets_: tuple[str, ...] = (), lines: int = 15, width: int = 300) -> list[str]:
    """The last non-blank lines of a CLI's output for results/: known secrets, values after token-ish keys, AWS key
    ids, JWT shapes, long base64url runs and 12-digit runs masked."""
    if isinstance(text, bytes):
        text = text.decode('utf-8', 'replace')
    text = text or ''
    for v in secrets_:
        if v:
            text = text.replace(v, '<secret>')
    text = BEARERISH.sub(lambda m: f'{m.group(1)} <masked>', text)
    text = SECRETISH.sub(lambda m: f'{m.group(1)}{m.group(2)}<masked>', text)
    text = re.sub(r'\b(AKIA|ASIA)[A-Z0-9]{16}\b', '<akid>', text)
    return mask([ln.rstrip()[:width] for ln in text.splitlines() if ln.strip()][-lines:])


def dig(value: str | None) -> str | None:
    return None if value is None else hashlib.sha256(value.encode()).hexdigest()[:12]


class Abort(Exception):  # noqa: N818 - reads better than AbortError at the call sites
    """Stops the run (spend cap, missing deployment): the table is printed and the process exits 2."""


class Secrets:
    """Test-user passwords, between phases only: a 0600 JSON file outside the repository."""

    def __init__(self, prefix: str, region: str):
        base = pathlib.Path(os.environ.get('XDG_RUNTIME_DIR') or (pathlib.Path.home() / '.cache'))
        self.path = base / f'llmar-e2e-{prefix}-{region}.secrets.json'
        if REPO in self.path.resolve().parents:
            raise Abort('refusing to keep secrets inside the repository')

    def _load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        if self.path.stat().st_mode & 0o077:
            raise Abort(f'{self.path} is readable by others: chmod 600 it or delete it')
        return json.loads(self.path.read_text())

    def get(self, name: str) -> str | None:
        return self._load().get(name)

    def put(self, name: str, value: str) -> None:
        data = self._load()
        data[name] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(f'.tmp{secrets.token_hex(4)}')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as fh:
            json.dump(data, fh)
        os.replace(tmp, self.path)

    def delete(self) -> None:
        self.path.unlink(missing_ok=True)


def new_password() -> str:
    """Satisfies the pool policy (14+, upper, lower, digit, symbol)."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(24)) + 'aA1!'


# ------------------------------------------------------------------------------------------------ state

class State:
    """Resumable state (check outcomes, test-user names and subs, config versions, spend): a 0600 file in the work
    directory outside the repository, deleted by cleanup. results/*.json carry the masked check outcomes."""

    def __init__(self, path: pathlib.Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.data: dict[str, Any] = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.data.setdefault('checks', {})
        self.data.setdefault('users', {})
        self.data.setdefault('spend', {'estUsd': 0.0, 'routerUsd': {}, 'calls': 0, 'cliRuns': 0})
        self.data.setdefault('ids', {})

    def save(self) -> None:
        tmp = self.path.with_suffix(f'.tmp{secrets.token_hex(4)}')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as fh:
            json.dump(self.data, fh, indent=2, sort_keys=True, ensure_ascii=False)
        os.replace(tmp, self.path)

    @property
    def users(self) -> dict[str, Any]:
        return self.data['users']

    @property
    def ids(self) -> dict[str, Any]:
        return self.data['ids']


# ------------------------------------------------------------------------------------------------ deployment

# SSM /<prefix>/router/<name> values this driver reads (RouterStack writes 15; GetParametersByPath pages hold 10).
SSM_REQUIRED = ('user-pool-id', 'cognito-domain', 'gateway-url', 'agent-client-id', 'config-bucket', 'log-group-name',
                'cluster-name', 'service-name', 'model-universe')


class Deploy:
    """Values of the deployed stacks (SSM /<prefix>/router/*, CloudFormation outputs)."""

    def __init__(self, session: Any, prefix: str, region: str):
        self.s, self.prefix, self.region = session, prefix, region
        self._ssm: dict[str, str] = {}
        self._outs: dict[str, dict[str, str]] = {}

    def ssm(self, name: str) -> str:
        if not self._ssm:
            pages = self.s.client('ssm').get_paginator('get_parameters_by_path').paginate(Path=f'/{self.prefix}/router/', Recursive=False)
            for page in pages:
                for p in page.get('Parameters', []):
                    self._ssm[p['Name'].rsplit('/', 1)[-1]] = p['Value']
            if not self._ssm:
                raise Abort(f'no SSM parameters under /{self.prefix}/router/: is the router stack deployed?')
            missing = [n for n in SSM_REQUIRED if n not in self._ssm]
            if missing:
                raise Abort(f'SSM /{self.prefix}/router/ is missing {", ".join(missing)} (found {len(self._ssm)} parameters)')
        if name not in self._ssm:
            raise Abort(f'SSM /{self.prefix}/router/{name} is missing')
        return self._ssm[name]

    def outputs(self, stack: str) -> dict[str, str]:
        if stack not in self._outs:
            try:
                st = self.s.client('cloudformation').describe_stacks(StackName=stack)['Stacks'][0]
            except Exception as e:  # noqa: BLE001
                raise Abort(f'stack {stack} not found ({type(e).__name__})') from None
            self._outs[stack] = {o['OutputKey']: o['OutputValue'] for o in st.get('Outputs', [])}
        return self._outs[stack]

    def router(self, key: str) -> str:
        return self.outputs(f'{self.prefix}-router')[key]

    def console(self, key: str) -> str:
        return self.outputs(f'{self.prefix}-console')[key]

    @property
    def gw(self) -> str:
        return self.ssm('gateway-url').rstrip('/')

    @property
    def domain(self) -> str:
        return self.ssm('cognito-domain').rstrip('/')

    @property
    def pool(self) -> str:
        return self.ssm('user-pool-id')

    @property
    def invoke_scope(self) -> str:
        return f'{self.prefix}/invoke'

    @property
    def console_scope(self) -> str:
        return f'{self.prefix}/console'


# ------------------------------------------------------------------------------------------------ the run context

class Run:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.session = boto3.Session(region_name=args.region)
        account = os.environ.get('LLMAR_E2E_ACCOUNT') or os.environ.get('LLMAR_SPIKE_ACCOUNT')
        if account and self.session.client('sts').get_caller_identity()['Account'] != account:
            raise Abort('refusing to run: the caller account is not LLMAR_E2E_ACCOUNT / LLMAR_SPIKE_ACCOUNT')
        self.d = Deploy(self.session, args.prefix, args.region)
        self.work = pathlib.Path(os.environ.get('XDG_CACHE_HOME') or (pathlib.Path.home() / '.cache')) / f'llmar-e2e-{args.prefix}-{args.region}'
        if REPO in self.work.resolve().parents:
            raise Abort('refusing to use a work directory inside the repository')
        if self.work.exists():
            os.chmod(self.work, 0o700)   # also when it existed before (created under another umask)
        self.state = State(self.work / 'state.json')
        self.secrets = Secrets(args.prefix, args.region)
        self._m2m: tuple[str, float] | None = None
        self._console: dict[str, dict[str, Any]] = {}
        self.cap = args.cap

    def c(self, name: str) -> Any:
        return self.session.client(name)

    # ------------------------------------------------------------------------------------------ spend
    def spend_guard(self, upper_usd: float) -> None:
        sp = self.state.data['spend']
        known = max(sp['estUsd'], sum(sp['routerUsd'].values()))
        if known + upper_usd > self.cap:
            raise Abort(f'spend cap: known ${known:.4f} + this call ≤ ${upper_usd:.4f} would exceed ${self.cap:.2f}')

    def spend_add(self, usd: float, cli: bool = False) -> None:
        sp = self.state.data['spend']
        sp['estUsd'] = round(sp['estUsd'] + usd, 6)
        sp['cliRuns' if cli else 'calls'] += 1
        self.state.save()

    def reconcile(self, phase: str, start_ms: int) -> float:
        """Router costUsd (+ assessor cost + unmetered bounds) of every model line since the phase started."""
        total = 0.0
        for line in self.logs('{ $.kind = "model" }', start_ms):
            total += float((line.get('costUsd') or {}).get('total') or 0) + float((line.get('assessor') or {}).get('costUsd') or 0)
            total += float(line.get('costBoundUsd') or 0)
        self.state.data['spend']['routerUsd'][f'{phase}@{start_ms}'] = round(total, 6)   # one entry per phase run: reruns add up
        self.state.save()
        return total

    # ------------------------------------------------------------------------------------------ logs
    def logs(self, pattern: str, start_ms: int, end_ms: int | None = None, limit: int = 2000) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        kw: dict[str, Any] = {'logGroupName': self.d.ssm('log-group-name'), 'filterPattern': pattern, 'startTime': start_ms}
        if end_ms:
            kw['endTime'] = end_ms
        for page in self.c('logs').get_paginator('filter_log_events').paginate(**kw):
            for ev in page.get('events', []):
                try:
                    o = json.loads(ev['message'])
                except ValueError:
                    continue
                o['_stream'] = ev.get('logStreamName', '')
                out.append(o)
                if len(out) >= limit:
                    return out
        return out

    def wait_logs(self, pattern: str, start_ms: int, ok: Callable[[list[dict[str, Any]]], bool], timeout_s: float, every_s: float = 5) -> tuple[list[dict[str, Any]], float]:
        t0 = time.time()
        while True:
            lines = self.logs(pattern, start_ms)
            if ok(lines):
                return lines, round(time.time() - t0, 1)
            if time.time() - t0 > timeout_s:
                return lines, round(time.time() - t0, 1)
            time.sleep(every_s)

    # ------------------------------------------------------------------------------------------ tokens
    def m2m(self) -> str:
        if self._m2m and self._m2m[1] > time.time() + 300:
            return self._m2m[0]
        cid = self.d.ssm('agent-client-id')
        sec = self.c('cognito-idp').describe_user_pool_client(UserPoolId=self.d.pool, ClientId=cid)['UserPoolClient']['ClientSecret']
        basic = base64.b64encode(f'{cid}:{sec}'.encode()).decode()
        del sec
        r = requests.post(self.d.domain + '/oauth2/token', data={'grant_type': 'client_credentials', 'scope': self.d.invoke_scope},
                          headers={'Authorization': f'Basic {basic}', 'Content-Type': 'application/x-www-form-urlencoded'}, timeout=30)
        if r.status_code != 200:
            raise Abort(f'client-credentials token: HTTP {r.status_code}')
        j = r.json()
        self._m2m = (j['access_token'], time.time() + int(j.get('expires_in', 3600)))
        return self._m2m[0]

    # ------------------------------------------------------------------------------------------ gateway calls
    def gw_call(self, dialect: str, model: str, token: str | None, api_key: str | None = None, extra: dict[str, str] | None = None,
                max_tokens: int = MAX_TOKENS, billable: bool = True) -> dict[str, Any]:
        assert max_tokens <= 64
        path, body = request_body(dialect, model, max_tokens)
        headers = {'content-type': 'application/json'}
        if dialect == 'messages':
            headers['anthropic-version'] = '2023-06-01'
        if token:
            headers['authorization'] = f'Bearer {token}'
        if api_key:
            headers['x-api-key'] = api_key
        headers.update(extra or {})
        if billable:
            self.spend_guard(0.01)
        r = requests.post(self.d.gw + '/inference' + path, json=body, headers=headers, timeout=90)
        out: dict[str, Any] = {'status': r.status_code, 'router': {k: r.headers[k] for k in ('x-router-decision', 'x-router-model', 'x-router-reason') if k in r.headers}}
        try:
            j = r.json()
        except ValueError:
            j = {}
        if r.status_code >= 400:
            out.update(error_fields(j, r.headers))
        else:
            p, o = usage_tokens(dialect, j.get('usage') or {})
            out['usage'] = {'prompt': p, 'output': o}
            est = (p * 6.25 + o * 25) / 1e6   # above every routed model's list price
            self.spend_add(est)
            out['estUsd'] = round(est, 6)
        return out

    # ------------------------------------------------------------------------------------------ console
    def api(self, method: str, path: str, token: str | None, body: Any = None, params: dict[str, Any] | None = None,
            base: str | None = None) -> tuple[int, Any]:
        url = (base or self.d.console('ConsoleUrl')).rstrip('/') + path
        h = {'authorization': f'Bearer {token}'} if token else {}
        r = requests.request(method, url, headers=h, json=body, params=params, timeout=60)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, None

    def api_items(self, path: str, token: str | None, params: dict[str, Any], max_pages: int = 20) -> tuple[int, list[dict[str, Any]]]:
        """GET a Page<T> list and follow nextCursor (a filtered page can be short while more exists)."""
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(max_pages):
            st, b = self.api('GET', path, token, params={**params, **({'cursor': cursor} if cursor else {})})
            if st != 200:
                return st, items
            items += (b or {}).get('items') or []
            cursor = (b or {}).get('nextCursor')
            if not cursor:
                break
        return 200, items

    def console_token(self, label: str) -> str:
        """Console access token for a test user (managed login, auth code + PKCE), refreshed in memory."""
        s = self._console.get(label)
        if s and s['exp'] > time.time() + 120:
            return s['access']
        cid = self.d.console('ConsoleClientId')
        if s and s.get('refresh'):
            r = requests.post(self.d.domain + '/oauth2/token', data={'grant_type': 'refresh_token', 'client_id': cid, 'refresh_token': s['refresh']}, timeout=30)
            if r.status_code == 200:
                j = r.json()
                s.update(access=j['access_token'], exp=time.time() + int(j['expires_in']), refresh=j.get('refresh_token', s['refresh']))
                return s['access']
        u = self.state.users[label]
        pw = self.secrets.get(label)
        if not pw:
            raise Abort(f'no password for {label}: rerun the phase that creates it')
        redirect = self.console_callback()
        j = pkce_login(self.d.domain, cid, redirect, f'openid email {self.d.console_scope}', u['username'], pw, capture=True)
        self._console[label] = {'access': j['access_token'], 'refresh': j.get('refresh_token'), 'exp': time.time() + int(j['expires_in'])}
        return j['access_token']

    def console_callback(self) -> str:
        c = self.c('cognito-idp').describe_user_pool_client(UserPoolId=self.d.pool, ClientId=self.d.console('ConsoleClientId'))['UserPoolClient']
        urls = c.get('CallbackURLs') or []
        if not urls:
            raise Abort('the console client has no callback URL')
        spa = self.d.console('ConsoleUrl').rstrip('/') + '/auth/callback'
        return spa if spa in urls else urls[0]

    # ------------------------------------------------------------------------------------------ users
    def ensure_user(self, label: str, role: str, via_api: bool = False) -> dict[str, Any]:
        """Creates (or resets) a test user with a fresh permanent password; group `role`; MEMBER#user:<sub> PROFILE."""
        idp = self.c('cognito-idp')
        u = self.state.users.get(label) or {'username': f'e2e-{label}-{secrets.token_hex(3)}@example.com', 'role': role}
        if not via_api:
            try:
                idp.admin_create_user(UserPoolId=self.d.pool, Username=u['username'], MessageAction='SUPPRESS', TemporaryPassword=new_password(),
                                      UserAttributes=[{'Name': 'email', 'Value': u['username']}, {'Name': 'email_verified', 'Value': 'true'}])
            except idp.exceptions.UsernameExistsException:
                pass
            idp.admin_add_user_to_group(UserPoolId=self.d.pool, Username=u['username'], GroupName=role)
        pw = new_password()
        idp.admin_set_user_password(UserPoolId=self.d.pool, Username=u['username'], Password=pw, Permanent=True)
        self.secrets.put(label, pw)
        del pw
        attrs = {a['Name']: a['Value'] for a in idp.admin_get_user(UserPoolId=self.d.pool, Username=u['username'])['UserAttributes']}
        u['sub'] = attrs['sub'].lower()
        if not via_api:
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            try:
                self.c('dynamodb').put_item(TableName=self.d.console('ConsoleTableName'), ConditionExpression='attribute_not_exists(pk)', Item={
                    'pk': {'S': f'MEMBER#user:{u["sub"]}'}, 'sk': {'S': 'PROFILE'}, 'status': {'S': 'active'}, 'role': {'S': role},
                    'budgetMonthlyUsd': {'NULL': True}, 'createdAt': {'S': now}, 'updatedAt': {'S': now}})
            except self.c('dynamodb').exceptions.ConditionalCheckFailedException:
                pass
        self.state.users[label] = u
        self.state.save()
        return u


# ------------------------------------------------------------------------------------------------ requests and parsing

def request_body(dialect: str, model: str, max_tokens: int) -> tuple[str, dict[str, Any]]:
    if dialect == 'messages':
        return '/v1/messages', {'model': model, 'max_tokens': max_tokens, 'messages': [{'role': 'user', 'content': PROMPT}]}
    if dialect == 'chat':
        # max_completion_tokens: the GPT models on Bedrock reject max_tokens (400 unsupported_parameter, param max_tokens).
        return '/v1/chat/completions', {'model': model, 'max_completion_tokens': max_tokens, 'messages': [{'role': 'user', 'content': PROMPT}]}
    return '/v1/responses', {'model': model, 'max_output_tokens': max(16, max_tokens), 'input': PROMPT, 'store': False}


def error_fields(j: Any, headers: Any) -> dict[str, Any]:
    """Codes of a failed call, never its message text. `code`: the router's own code (identity-*, budget-exceeded,
    pin-not-allowed, …), else the upstream error's code or type, else the gateway's x-amzn-errortype. The upstream
    OpenAI / Anthropic error object's code, param and type are kept as well."""
    j = j if isinstance(j, dict) else {}
    err = j.get('error')
    up = err if isinstance(err, dict) else {}
    out: dict[str, Any] = {}
    for k in ('code', 'param', 'type'):
        if isinstance(up.get(k), str):
            out[f'upstream{k.capitalize()}'] = up[k][:80]
    et = headers.get('x-amzn-errortype') if headers is not None else None
    if et:
        out['errorType'] = str(et)[:80]
    out['code'] = (j.get('code') if isinstance(j.get('code'), str) else None) or out.get('upstreamCode') or out.get('upstreamType') \
        or (err[:80] if isinstance(err, str) else None) or out.get('errorType')
    return out


def usage_tokens(dialect: str, u: dict[str, Any]) -> tuple[int, int]:
    if dialect == 'messages':
        p = sum(int(u.get(k) or 0) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
        return p, int(u.get('output_tokens') or 0)
    if dialect == 'chat':
        return int(u.get('prompt_tokens') or 0), int(u.get('completion_tokens') or 0)
    return int(u.get('input_tokens') or 0), int(u.get('output_tokens') or 0)


def claims(token: str) -> dict[str, Any]:
    part = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


def body_shape(r: requests.Response) -> dict[str, Any]:
    """What came back, without values: JSON keys (and a short `message`), or the content type and length."""
    try:
        j = r.json()
    except ValueError:
        return {'type': 'non-json', 'contentType': r.headers.get('content-type', '')[:60], 'length': len(r.content)}
    if isinstance(j, dict):
        return {'keys': sorted(j)[:10], **({'message': str(j['message'])[:60]} if 'message' in j else {})}
    return {'type': type(j).__name__}


def auth_header_shape(value: str | None) -> str | None:
    """`www-authenticate` with every quoted value removed (scheme and parameter names only)."""
    return None if value is None else re.sub(r'="[^"]*"', '=…', value)[:120]


SPA_SCOPE = re.compile(r'^[\w./:-]+$')


def _https(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    u = urllib.parse.urlsplit(v)
    return u.scheme == 'https' and bool(u.hostname) and not (u.username or u.password or u.query or u.fragment)


def spa_config_issues(raw: Any, *, client_id: str | None = None, console_scope: str | None = None, issuer: str | None = None,
                      cognito_domain: str | None = None) -> list[str]:
    """The SPA's own /config.json schema (console-web parseRuntimeConfig), https only for a deployed stack, plus
    consistency with this deployment when the expected values are given. [] means valid."""
    if not isinstance(raw, dict):
        return ['not a JSON object']
    issues = []
    if raw.get('schemaVersion') != 1:
        issues.append('schemaVersion must be 1')
    for k in ('region', 'clientId'):
        if not isinstance(raw.get(k), str) or not raw[k]:
            issues.append(f'{k} must be a non-empty string')
    for k in ('issuer', 'cognitoDomain'):
        if not _https(raw.get(k)):
            issues.append(f'{k} must be an https URL')
    scopes = raw.get('scopes')
    if not isinstance(scopes, list) or not scopes or not all(isinstance(x, str) and SPA_SCOPE.match(x) for x in scopes):
        issues.append('scopes must be a non-empty list of scope names')
    elif console_scope and console_scope not in scopes:
        issues.append(f'scopes must include {console_scope}')
    api_base = raw.get('apiBase', '/api')
    if not isinstance(api_base, str) or not api_base.startswith('/') or api_base.startswith('//'):
        issues.append('apiBase must be a same-origin path')
    if raw.get('tokenStorage', 'session') not in ('session', 'memory'):
        issues.append("tokenStorage must be 'session' or 'memory'")
    if client_id and raw.get('clientId') != client_id:
        issues.append('clientId is not the console client')
    if issuer and str(raw.get('issuer', '')).rstrip('/') != issuer.rstrip('/'):
        issues.append("issuer is not this user pool's issuer")
    if cognito_domain and _https(raw.get('cognitoDomain')) and urllib.parse.urlsplit(raw['cognitoDomain']).netloc != urllib.parse.urlsplit(cognito_domain).netloc:
        issues.append("cognitoDomain is not this pool's domain")
    if [k for k in raw if 'secret' in k.lower()] or re.search(r'eyJ[\w-]{8,}\.', json.dumps(raw)):
        issues.append('holds a secret-like key or a JWT')
    return issues


def console_routes() -> list[tuple[str, str, str]]:
    """(id, method, path) from the contract's route table, with sample parameters (no drift from the TS source)."""
    out = []
    for m in re.finditer(r"r\('([\w.]+)',\s*'(GET|POST|PUT|PATCH|DELETE)',\s*'(/api/[^']+)'", ROUTES_TS.read_text()):
        path = re.sub(r':(\w+)', lambda x: {'reqId': '00000000-0000-4000-8000-00000000e2e0', 'label': '0123456789abcdef',
                                             'version': '1-20261108T000000Z', 'packVersion': 'sha-0', 'id': 'e2e-none'}.get(x.group(1), 'x'), m.group(3))
        out.append((m.group(1), m.group(2), path))
    if len(out) < 30:
        raise Abort(f'parsed only {len(out)} routes from {ROUTES_TS}')
    return out


# ------------------------------------------------------------------------------------------------ headless managed login

VISIBLE_TEXT_JS = """() => Array.from(document.querySelectorAll('h1, h2, h3, [role="alert"], [role="status"]'))
  .filter((e) => e.offsetParent !== null).map((e) => e.innerText).join(' | ')"""


def visible_text(page: Any, limit: int = 120) -> str:
    """The page's visible headings and alerts (e.g. the SPA's 'not configured' message), whitespace-collapsed."""
    try:
        text = page.evaluate(VISIBLE_TEXT_JS)
    except Exception as e:  # noqa: BLE001
        return f'<unreadable: {type(e).__name__}>'
    return re.sub(r'\s+', ' ', str(text or '')).strip()[:limit]


def page_problem(page: Any, what: str) -> RuntimeError:
    origin = urllib.parse.urlsplit(page.url)._replace(query='', fragment='').geturl()
    return RuntimeError(f'{what}; page {origin} says: {visible_text(page) or "(no heading or alert)"}')


def _fill_login(page: Any, username: str, password: str) -> None:
    """Cognito managed login (v2): username and password on one page, or username → Next → password."""
    user = page.locator('input[name="username"]:visible, input[type="email"]:visible, input[autocomplete="username"]:visible').first
    try:
        user.wait_for(state='visible', timeout=30_000)
    except Exception:  # noqa: BLE001 - say what the page shows instead (an error page, a redirect_mismatch, …)
        raise page_problem(page, 'no username field') from None
    user.fill(username)
    pw = page.locator('input[type="password"]:visible').first
    if pw.count() == 0:
        page.locator('button[type="submit"]:visible').first.click()
        pw = page.locator('input[type="password"]:visible').first
        pw.wait_for(state='visible', timeout=30_000)
    pw.fill(password)
    pw.press('Enter')


def browser_sign_in(url: str, username: str, password: str, *, until: Callable[[Any], bool], capture_prefix: str | None = None,
                    timeout_s: float = 90, before: Callable[[Any], None] | None = None) -> dict[str, Any]:
    """Opens `url` headless, signs in, waits for `until(page)`; with capture_prefix, the redirect to it is captured
    (query returned) and answered locally instead of reaching the real target."""
    from playwright.sync_api import sync_playwright
    got: dict[str, Any] = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_context().new_page()
            if capture_prefix:
                # Cognito answers the sign-in with a 302 to the callback, and page.route() never sees redirected
                # requests, so the callback is read from the request event (it fires before DNS or any response).
                want = re.compile('^' + re.escape(capture_prefix) + r'(\?|$)')

                def on_request(req: Any) -> None:
                    if 'query' not in got and want.match(req.url):
                        got['query'] = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(req.url).query))
                page.on('request', on_request)
            page.goto(url, wait_until='domcontentloaded', timeout=60_000)
            if before:
                before(page)
            _fill_login(page, username, password)
            t0 = time.time()
            while time.time() - t0 < timeout_s:
                if (capture_prefix and 'query' in got) or (not capture_prefix and until(page)):
                    break
                page.wait_for_timeout(500)
            got['final'] = {'origin': urllib.parse.urlsplit(page.url)._replace(query='', fragment='').geturl(), 'title': page.title()[:80]}
            if not capture_prefix:
                got['until'] = until(page)
                got['localStorageTokens'] = page.evaluate("() => Object.values(localStorage).filter(v => /eyJ[\\w-]+\\.[\\w-]+\\./.test(v)).length")
                got['sessionStorageKeys'] = page.evaluate('() => Object.keys(sessionStorage).length')
        finally:
            browser.close()
    return got


def pkce_login(domain: str, client_id: str, redirect: str, scope: str, username: str, password: str, capture: bool = True) -> dict[str, Any]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    state = secrets.token_urlsafe(24)
    url = domain + '/oauth2/authorize?' + urllib.parse.urlencode({'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect,
        'scope': scope, 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
    got = browser_sign_in(url, username, password, until=lambda _p: False, capture_prefix=redirect)
    q = got.get('query') or {}
    if q.get('state') != state or 'code' not in q:
        raise RuntimeError(f"sign-in did not return a code (state ok: {q.get('state') == state}, error: {q.get('error')}, page: {got.get('final')})")
    r = requests.post(domain + '/oauth2/token', data={'grant_type': 'authorization_code', 'client_id': client_id, 'code': q['code'],
                      'redirect_uri': redirect, 'code_verifier': verifier}, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f'code exchange: HTTP {r.status_code}')
    return r.json()


# ------------------------------------------------------------------------------------------------ checks and phases

class Phase:
    def __init__(self, run: Run, name: str):
        self.run, self.name, self.rows = run, name, []
        self.start_ms = int(time.time() * 1000)

    def check(self, cid: str, fn: Callable[[], tuple[bool, dict[str, Any]]], always: bool = False) -> bool:
        st = self.run.state.data['checks']
        key = f'{self.name}.{cid}'
        if not always and not self.run.args.force and st.get(key, {}).get('ok'):
            self.rows.append((key, 'SKIP', 'passed before'))
            return True
        t0 = time.time()
        try:
            ok, detail = fn()
        except Abort:
            raise
        except Exception as e:  # noqa: BLE001 - a failed check, recorded
            ok, detail = False, {'error': type(e).__name__, 'message': str(e)[:300]}
        detail = mask(detail)
        st[key] = {'ok': ok, 'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 's': round(time.time() - t0, 1), 'detail': detail}
        self.run.state.save()
        self.rows.append((key, 'PASS' if ok else 'FAIL', json.dumps(detail, ensure_ascii=False)[:150]))
        return ok

    def skip(self, cid: str, why: str) -> None:
        self.rows.append((f'{self.name}.{cid}', 'SKIP', why))

    def finish(self) -> bool:
        try:
            usd = self.run.reconcile(self.name, self.start_ms)
        except Exception as e:  # noqa: BLE001
            usd = float('nan')
            self.rows.append((f'{self.name}.spend', 'FAIL', f'reconcile: {type(e).__name__}'))
        sp = self.run.state.data['spend']
        self.rows.append((f'{self.name}.spend', 'INFO', f"router ${usd:.4f} this phase; est ${sp['estUsd']:.4f}, router ${sum(sp['routerUsd'].values()):.4f} total"))
        RESULTS.mkdir(exist_ok=True)
        out = {'phase': self.name, 'checks': {k: v for k, v in self.run.state.data['checks'].items() if k.startswith(self.name + '.')},
               'spend': sp, 'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}
        (RESULTS / f'{self.name}.json').write_text(json.dumps(mask(out), indent=2, ensure_ascii=False))
        print_table(self.name, self.rows)
        return all(s in ('PASS', 'SKIP', 'INFO') for _, s, _ in self.rows)


def print_table(name: str, rows: list[tuple[str, str, str]]) -> None:
    w = max([len(r[0]) for r in rows] + [10])
    print(f'\n== phase {name}')
    for k, s, d in rows:
        print(f'{k:<{w}}  {s:<4}  {mask(d)}')


def models(run: Run) -> tuple[str, str]:
    uni = run.d.ssm('model-universe').split(',')
    haiku = run.args.haiku or next((m for m in uni if 'haiku' in m), None)
    luna = run.args.luna or next((m for m in uni if 'luna' in m), None)
    if not haiku or not luna:
        raise Abort('could not pick the fast models from model-universe: pass --haiku and --luna')
    return haiku, luna


def principal_key(kind: str, pid: str) -> str:
    return f'{kind}:{pid}'


# ------------------------------------------------------------------------------------------------ phase r

def phase_r(run: Run) -> bool:
    ph = Phase(run, 'r')
    haiku, _ = models(run)
    agent = run.d.ssm('agent-client-id')

    ph.check('anonymous-401', lambda: (lambda r: (r['status'] == 401, r))(run.gw_call('messages', 'auto', None, billable=False)))
    ph.check('bad-token-401', lambda: (lambda r: (r['status'] == 401, r))(run.gw_call('messages', 'auto', 'not-a-token', billable=False)))
    ph.skip('wrong-scope-403', 'needs the console client: checked in c1.wrong-scope-gateway')

    def m2m_claims() -> tuple[bool, dict[str, Any]]:
        c = claims(run.m2m())
        return run.d.invoke_scope in (c.get('scope') or '').split(), {'claims': sorted(c), 'lifetimeS': c['exp'] - c['iat']}
    ph.check('m2m-token', m2m_claims)

    for dialect in ('messages', 'chat', 'responses'):
        def auto_call(dialect: str = dialect) -> tuple[bool, dict[str, Any]]:
            t = run.m2m()
            r = run.gw_call(dialect, 'auto', t, t)
            return r['status'] == 200 and 'x-router-decision' in r['router'], r
        ph.check(f'auto-{dialect}-200', auto_call)

    def principal_logged() -> tuple[bool, dict[str, Any]]:
        lines, waited = run.wait_logs('{ $.kind = "model" && $.principal.kind = "client" }', ph.start_ms,
                                      lambda ls: len({ln.get('dialect') for ln in ls if (ln.get('principal') or {}).get('id') == agent}) >= 3, 180)
        mine = [ln for ln in lines if (ln.get('principal') or {}).get('id') == agent]
        return (len({ln.get('dialect') for ln in mine}) >= 3 and all(ln.get('identity') == 'verified' for ln in mine),
                {'lines': len(mine), 'dialects': sorted({str(ln.get('dialect')) for ln in mine}), 'identity': sorted({str(ln.get('identity')) for ln in mine}),
                 'principalDigest': dig(principal_key('client', agent)), 'waitedS': waited})
    ph.check('principal-logged', principal_logged)

    def catchall() -> tuple[bool, dict[str, Any]]:
        t = run.m2m()
        r = run.gw_call('messages', haiku, t, t, max_tokens=8)
        return r['status'] == 200 and r['router'].get('x-router-decision', '').startswith('pin;'), r
    ph.check('concrete-id-through-router', catchall)

    def bucket() -> tuple[bool, dict[str, Any]]:
        s3, b = run.c('s3'), run.d.ssm('config-bucket')
        res = {}
        for key in ('identity/jwks.json', 'packs/current.json'):
            try:
                s3.head_object(Bucket=b, Key=key)
                res[key] = 200
            except Exception as e:  # noqa: BLE001
                res[key] = getattr(e, 'response', {}).get('Error', {}).get('Code', type(e).__name__)
        return all(v == 200 for v in res.values()), res
    ph.check('config-bucket-objects', bucket)

    def jwks_line() -> tuple[bool, dict[str, Any]]:
        lines = run.logs('{ $.kind = "config" && $.source = "jwks" && $.outcome = "applied" }', int((time.time() - 86_400) * 1000))
        return len(lines) >= 1, {'lines': len(lines), 'tasks': len({ln['_stream'] for ln in lines})}
    ph.check('jwks-applied-line', jwks_line)
    return ph.finish()


# ------------------------------------------------------------------------------------------------ phase c1

def phase_c1(run: Run) -> bool:
    ph = Phase(run, 'c1')

    def outputs() -> tuple[bool, dict[str, Any]]:
        need = ['ConsoleUrl', 'ApiUrl', 'ConsoleClientId', 'SiteBucketName', 'ConsoleTableName', 'UsageTableName', 'IngestDlqUrl']
        o = run.d.outputs(f'{run.args.prefix}-console')
        return all(k in o for k in need), {'missing': [k for k in need if k not in o]}
    if not ph.check('console-outputs', outputs):
        return ph.finish()

    def authorizer_401(base: str, bearer: str | None) -> Callable[[], tuple[bool, dict[str, Any]]]:
        """Every route answers the HTTP API JWT authorizer's own 401: body {"message":"Unauthorized"} and an
        apigw-requestid header (via CloudFront that header also proves /api/* reached the API, not the S3 origin).
        Anything else fails with the observed status, body shape and header names."""
        def f() -> tuple[bool, dict[str, Any]]:
            bad, statuses, wa = [], {}, set()
            hdr = {'authorization': f'Bearer {bearer}'} if bearer else {}
            for rid, method, path in console_routes():
                r = requests.request(method, base.rstrip('/') + path, headers=hdr, json={} if method in ('POST', 'PUT', 'PATCH') else None, timeout=30)
                statuses[r.status_code] = statuses.get(r.status_code, 0) + 1
                shape = body_shape(r)
                if r.status_code != 401 or shape != {'keys': ['message'], 'message': 'Unauthorized'} or 'apigw-requestid' not in r.headers:
                    bad.append({'route': rid, 'status': r.status_code, 'body': shape, 'headers': sorted(k.lower() for k in r.headers)[:25]})
                if 'www-authenticate' in r.headers:
                    wa.add(auth_header_shape(r.headers['www-authenticate']))
            return not bad, {'routes': sum(statuses.values()), 'statuses': statuses, 'wwwAuthenticate': sorted(x for x in wa if x),
                             'mismatches': len(bad), 'firstMismatches': bad[:5]}
        return f
    cf, raw = run.d.console('ConsoleUrl'), run.d.console('ApiUrl')
    ph.check('anonymous-api-cloudfront-401', authorizer_401(cf, None))
    ph.check('anonymous-api-execute-api-401', authorizer_401(raw, None))
    ph.check('junk-bearer-api-cloudfront-401', authorizer_401(cf, 'e2e-junk-token'))
    ph.check('junk-bearer-api-execute-api-401', authorizer_401(raw, 'e2e-junk-token'))

    def not_a_route() -> tuple[bool, dict[str, Any]]:   # control: the API's own 404 shape, so the 401s above are not a catch-all
        r = requests.get(raw.rstrip('/') + '/e2e-not-a-route', timeout=30)
        shape = body_shape(r)
        return r.status_code == 404 and shape == {'keys': ['message'], 'message': 'Not Found'}, \
            {'status': r.status_code, 'body': shape, 'apigwRequestId': 'apigw-requestid' in r.headers}
    ph.check('execute-api-unknown-route-404', not_a_route)

    def s3_direct() -> tuple[bool, dict[str, Any]]:
        # Pre-check only: before the bundle upload no object exists, and S3 answers anonymous requests for missing
        # keys with 403 too. The conclusive check is c2.site-bucket-direct-denied-cloudfront-200.
        b = run.d.console('SiteBucketName')
        res = {k: requests.get(f'https://{b}.s3.{run.args.region}.amazonaws.com/{k}', timeout=30).status_code for k in ('index.html', 'config.json')}
        return all(v == 403 for v in res.values()), {**res, 'note': 'pre-check (objects may not exist yet): not conclusive'}
    ph.check('site-bucket-direct-403-precheck', s3_direct)

    def callbacks() -> tuple[bool, dict[str, Any]]:
        c = run.c('cognito-idp').describe_user_pool_client(UserPoolId=run.d.pool, ClientId=run.d.console('ConsoleClientId'))['UserPoolClient']
        origin = run.d.console('ConsoleUrl').rstrip('/')
        want = {'callback': origin + '/auth/callback', 'logout': origin + '/signed-out'}
        have = {'callback': want['callback'] in (c.get('CallbackURLs') or []), 'logout': want['logout'] in (c.get('LogoutURLs') or [])}
        return all(have.values()), {'spaPathsRegistered': have, 'registered': {'callbacks': len(c.get('CallbackURLs') or []), 'logouts': len(c.get('LogoutURLs') or [])},
                                    'scopes': sorted(c.get('AllowedOAuthScopes') or []), 'secret': 'ClientSecret' in c}
    ph.check('console-client-spa-callbacks', callbacks)

    ph.check('admin-user', lambda: (True, {'subDigest': dig(run.ensure_user('admin', 'admin')['sub'])}))

    def admin_login() -> tuple[bool, dict[str, Any]]:
        c = claims(run.console_token('admin'))
        return (c.get('client_id') == run.d.console('ConsoleClientId') and run.d.console_scope in (c.get('scope') or '').split()
                and 'admin' in (c.get('cognito:groups') or []), {'scope': sorted((c.get('scope') or '').split()), 'groups': c.get('cognito:groups'), 'lifetimeS': c['exp'] - c['iat']})
    ph.check('admin-console-login', admin_login)

    def me_profile() -> tuple[bool, dict[str, Any]]:
        st, b = run.api('GET', '/api/me/profile', run.console_token('admin'))
        return st == 200 and (b or {}).get('role') == 'admin' and (b or {}).get('principal') == f"user:{run.state.users['admin']['sub']}", \
            {'status': st, 'role': (b or {}).get('role'), 'identityMode': ((b or {}).get('deployment') or {}).get('identityMode')}
    ph.check('admin-me-profile-200', me_profile)

    def profile_effective() -> tuple[bool, dict[str, Any]]:
        t = run.console_token('admin')
        st1, prof = run.api('GET', '/api/me/profile', t)
        st2, setup = run.api('GET', '/api/me/setup', t)
        active = config_state(run)['active']['version']
        try:
            baked_version: str | None = baked_document(run)['version']
        except Exception:  # noqa: BLE001 - recorded as unknown; the version form is still checked
            baked_version = None
        ok, det = effective_identity(prof, setup, active, baked_version)
        return st1 == 200 and st2 == 200 and ok, {'profile': st1, 'setup': st2, 'activeVersion': active, **det}
    ph.check('profile-effective-identity', profile_effective)

    def members() -> tuple[bool, dict[str, Any]]:
        st, b = run.api('GET', '/api/admin/members', run.console_token('admin'))
        items = (b or {}).get('items') or []
        return st == 200 and any(m.get('id') == run.state.users['admin']['sub'] for m in items), {'status': st, 'members': len(items)}
    ph.check('admin-members-200', members)

    def wrong_scope() -> tuple[bool, dict[str, Any]]:
        r = run.gw_call('messages', 'auto', run.console_token('admin'), billable=False)
        return r['status'] == 403, r
    ph.check('wrong-scope-gateway-403', wrong_scope)

    ph.check('viewer-user', lambda: (True, {'subDigest': dig(run.ensure_user('viewer', 'member')['sub'])}))

    def viewer_admin() -> tuple[bool, dict[str, Any]]:
        t = run.console_token('viewer')
        st1, b1 = run.api('GET', '/api/admin/members', t)
        st2, b2 = run.api('GET', '/api/me/profile', t)
        return st1 == 403 and st2 == 200 and (b2 or {}).get('role') == 'member', \
            {'adminRoute': st1, 'code': ((b1 or {}).get('error') or {}).get('code'), 'meProfile': st2, 'role': (b2 or {}).get('role')}
    ph.check('member-on-admin-route-403', viewer_admin)
    return ph.finish()


# ------------------------------------------------------------------------------------------------ phase c2

def phase_c2(run: Run) -> bool:
    ph = Phase(run, 'c2')
    origin = run.d.console('ConsoleUrl').rstrip('/')

    def index() -> tuple[bool, dict[str, Any]]:
        r = requests.get(origin + '/', timeout=30)
        sec = {h: h in r.headers for h in ('content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy')}
        return r.status_code == 200 and 'text/html' in r.headers.get('content-type', ''), {'status': r.status_code, 'securityHeaders': sec}
    ph.check('spa-index-200', index)

    def config_json() -> tuple[bool, dict[str, Any]]:
        r = requests.get(origin + '/config.json', timeout=30)
        try:
            j = r.json() if r.status_code == 200 else None
        except ValueError:
            j = None
        issues = spa_config_issues(j, client_id=run.d.console('ConsoleClientId'), console_scope=run.d.console_scope,
                                   issuer=f'https://cognito-idp.{run.args.region}.amazonaws.com/{run.d.pool}', cognito_domain=run.d.domain)
        return r.status_code == 200 and not issues, {'status': r.status_code, 'keys': sorted(j) if isinstance(j, dict) else None, 'issues': issues}
    ph.check('spa-config-json', config_json)

    def direct_vs_cloudfront() -> tuple[bool, dict[str, Any]]:
        """With the bundle uploaded: the objects exist, yet anonymous S3 requests get AccessDenied, while CloudFront
        (OAC) serves them."""
        b, res, ok = run.d.console('SiteBucketName'), {}, True
        for key in ('index.html', 'config.json'):
            d = requests.get(f'https://{b}.s3.{run.args.region}.amazonaws.com/{key}', timeout=30)
            code = (re.search(r'<Code>([^<]{1,60})</Code>', d.text) or [None, None])[1]
            c = requests.get(f'{origin}/{key}', timeout=30)
            res[key] = {'direct': d.status_code, 'directCode': code, 'cloudfront': c.status_code}
            ok = ok and d.status_code == 403 and code == 'AccessDenied' and c.status_code == 200
        return ok, res
    ph.check('site-bucket-direct-denied-cloudfront-200', direct_vs_cloudfront)

    def spa_login() -> tuple[bool, dict[str, Any]]:
        pw = run.secrets.get('admin')
        if not pw:
            raise Abort('no admin password: run phase c1 first')
        def on_overview(page: Any) -> bool:
            return page.url.startswith(origin) and (page.get_by_role('heading', name=re.compile('^(Overview|概览)$')).count() > 0)
        def click_sign_in(page: Any) -> None:   # the SPA never redirects by itself: its Sign in button starts the flow
            try:
                page.get_by_role('button', name=re.compile('^(Sign in|登录)$')).first.click(timeout=30_000)
            except Exception:  # noqa: BLE001 - e.g. the SPA's "not configured" page: record what it says
                raise page_problem(page, 'no Sign in button') from None
        got = browser_sign_in(origin + '/', run.state.users['admin']['username'], pw, until=on_overview, timeout_s=90, before=click_sign_in)
        return bool(got.get('until')) and got.get('localStorageTokens') == 0, {k: got.get(k) for k in ('final', 'until', 'localStorageTokens', 'sessionStorageKeys')}
    ph.check('spa-sign-in-overview', spa_login)
    return ph.finish()


# ------------------------------------------------------------------------------------------------ phase c3 (+ helpers for llmar, Claude Code, Codex)

def llmar_env(run: Run) -> dict[str, str]:
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(run.work / 'home'), 'LLMAR_CONFIG_DIR': str(run.work / 'llmar')}
    for k in ('HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'):
        if k in os.environ:
            env[k] = os.environ[k]
    return env


def llmar(run: Run, *args: str, input: str | None = None, timeout: float = 60) -> subprocess.CompletedProcess:
    (run.work / 'home').mkdir(parents=True, exist_ok=True)
    return subprocess.run([sys.executable, '-I', str(LLMAR), *args], env=llmar_env(run), input=input, text=True, capture_output=True, timeout=timeout)  # nosec B603: argument list, no shell; arguments are the operator's own


def llmar_login(run: Run, label: str) -> dict[str, Any]:
    """`llmar login --no-browser`, its printed authorize URL driven headless; the browser reaches llmar's 127.0.0.1 callback."""
    pw = run.secrets.get(label)
    if not pw:
        raise Abort(f'no password for {label}')
    p = subprocess.Popen([sys.executable, '-I', str(LLMAR), 'login', '--no-browser', '--timeout', '180'], env=llmar_env(run),  # nosec B603: argument list, no shell; arguments are the operator's own
                         stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    url = None
    assert p.stderr
    for line in p.stderr:
        if re.match(r'https?://', line.strip()) and '/oauth2/authorize?' in line:
            url = line.strip()
        if line.startswith('Waiting for the sign-in'):
            break
    if not url:
        p.kill()
        raise RuntimeError('llmar printed no authorize URL')
    got = browser_sign_in(url, run.state.users[label]['username'], pw, until=lambda _p: p.poll() is not None, timeout_s=120)
    try:
        rc = p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        p.kill()
        rc = -1
    return {'exit': rc, 'final': got.get('final')}


def member_token(run: Run) -> str:
    r = llmar(run, 'token')
    if r.returncode != 0:
        raise RuntimeError(f'llmar token exit {r.returncode}')
    return r.stdout.strip()


def run_cli(argv: list[str], *, cwd: pathlib.Path, env: dict[str, str], secrets_: tuple[str, ...] = (),
            timeout: float = 240) -> tuple[subprocess.CompletedProcess | None, dict[str, Any]]:
    """Runs a CLI in its scratch environment. A `--version` preflight in the same environment comes first, so a binary
    that cannot start there (for example a launcher shim that looks its tools up under the real HOME) fails in its own
    words before any spend. The detail always carries the exit, the duration and masked stderr/stdout tails."""
    t0 = time.time()

    def detail(rc: Any, out: Any, err: Any, **extra: Any) -> dict[str, Any]:
        return {'exit': rc, 's': round(time.time() - t0, 1), **extra,
                'stderrTail': output_tail(err, secrets_=secrets_), 'stdoutTail': output_tail(out, secrets_=secrets_)}
    try:
        pre = subprocess.run([argv[0], '--version'], cwd=cwd, env=env, stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=30)  # nosec B603: argument list, no shell; arguments are the operator's own
    except subprocess.TimeoutExpired as e:
        return None, detail('timeout', e.stdout, e.stderr, stage='preflight')
    if pre.returncode != 0:
        return None, detail(pre.returncode, pre.stdout, pre.stderr, stage='preflight')
    version = (output_tail(pre.stdout, lines=1, width=80) or ['?'])[0]
    try:
        r = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=timeout)  # nosec B603: argument list, no shell; arguments are the operator's own
    except subprocess.TimeoutExpired as e:
        return None, detail('timeout', e.stdout, e.stderr, stage='run', version=version, ran=True)
    return r, detail(r.returncode, r.stdout, r.stderr, stage='run', version=version, ran=True)


def run_claude(run: Run, haiku: str) -> dict[str, Any]:
    exe = shutil.which(os.environ.get('CLAUDE_BIN', 'claude'))
    if not exe:
        raise RuntimeError('Claude Code not found (set CLAUDE_BIN)')
    run.spend_guard(0.25)
    home = run.work / 'cc-home'
    (home / '.claude').mkdir(parents=True, exist_ok=True)
    helper = run.work / 'bin' / 'llmar-token'
    helper.parent.mkdir(parents=True, exist_ok=True)
    if not helper.exists():
        helper.symlink_to(LLMAR)
    (home / '.claude' / 'settings.json').write_text(json.dumps({'apiKeyHelper': str(helper), 'env': {
        'ANTHROPIC_BASE_URL': run.d.gw + '/inference', 'ANTHROPIC_MODEL': haiku, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': haiku,
        'ANTHROPIC_DEFAULT_SONNET_MODEL': haiku, 'ANTHROPIC_DEFAULT_OPUS_MODEL': haiku,
        'CLAUDE_CODE_API_KEY_HELPER_TTL_MS': '240000', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}}))
    env = {**llmar_env(run), 'HOME': str(home), 'TERM': 'dumb'}
    workdir = run.work / 'cc-work'
    workdir.mkdir(exist_ok=True)
    r, det = run_cli([exe, '-p', PROMPT, '--output-format', 'json', '--max-turns', '1'], cwd=workdir, env=env)
    if det.get('ran'):
        run.spend_add(0.25, cli=True)
    try:
        j = json.loads(r.stdout) if r else {}
    except ValueError:
        j = {}
    j = j if isinstance(j, dict) else {}
    return {**det, 'isError': j.get('is_error'), 'resultOk': str(j.get('result', '')).strip().lower().startswith('ok')}


def run_codex(run: Run, luna: str, token: str) -> dict[str, Any]:
    exe = shutil.which(os.environ.get('CODEX_BIN', 'codex'))
    if not exe:
        raise RuntimeError('Codex not found (set CODEX_BIN)')
    run.spend_guard(0.25)
    home = run.work / 'codex-home'
    home.mkdir(parents=True, exist_ok=True)
    helper = run.work / 'bin' / 'llmar-token'
    helper.parent.mkdir(parents=True, exist_ok=True)
    if not helper.exists():
        helper.symlink_to(LLMAR)
    (home / 'config.toml').write_text(f'''model = "{luna}"
model_provider = "llmar"
model_context_window = 1000000
model_auto_compact_token_limit = 700000
web_search = "disabled"

[model_providers.llmar]
name = "llmar router"
base_url = "{run.d.gw}/inference/v1"
wire_api = "responses"
env_http_headers = {{ "x-router-session" = "LLMAR_SESSION", "x-api-key" = "LLMAR_TOKEN" }}
requires_openai_auth = false
supports_websockets = false

[model_providers.llmar.auth]
command = "{helper}"
timeout_ms = 15000
refresh_interval_ms = 240000

[features]
enable_request_compression = false
''')
    workdir = run.work / 'codex-work'
    workdir.mkdir(exist_ok=True)
    env = {**llmar_env(run), 'HOME': str(run.work / 'home'), 'CODEX_HOME': str(home), 'TERM': 'dumb',
           'LLMAR_TOKEN': token, 'LLMAR_SESSION': f'e2e-codex-{secrets.token_hex(4)}'}
    r, det = run_cli([exe, 'exec', '--skip-git-repo-check', PROMPT], cwd=workdir, env=env, secrets_=(token,))
    if det.get('ran'):
        run.spend_add(0.25, cli=True)
    last = ((r.stdout.strip().splitlines() if r else []) or [''])[-1].strip().lower()
    return {**det, 'resultOk': last.startswith('ok')}


def phase_c3(run: Run) -> bool:
    ph = Phase(run, 'c3')
    haiku, luna = models(run)
    since = dt.datetime.fromtimestamp(ph.start_ms / 1000 - 60, dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    run.state.ids.setdefault('c3Since', since)
    since = run.state.ids['c3Since']

    def invite() -> tuple[bool, dict[str, Any]]:
        t = run.console_token('admin')
        u = run.state.users.get('member') or {'username': f'e2e-member-{secrets.token_hex(3)}@example.com', 'role': 'member'}
        st, b = run.api('POST', '/api/admin/members', t, body={'email': u['username'], 'name': 'E2E member', 'role': 'member'})
        if st not in (201, 409):
            return False, {'status': st, 'code': ((b or {}).get('error') or {}).get('code')}
        run.state.users['member'] = u
        run.state.save()
        m = run.ensure_user('member', 'member', via_api=True)
        st2, b2 = run.api('GET', f"/api/admin/members/{m['sub']}", t)
        return st2 == 200 and (b2 or {}).get('role') == 'member', {'invite': st, 'get': st2, 'status': (b2 or {}).get('status')}
    if not ph.check('member-invite-api', invite):
        return ph.finish()

    def configure() -> tuple[bool, dict[str, Any]]:
        st, b = run.api('GET', '/api/me/setup', run.console_token('admin'))
        cj = (b or {}).get('configureJson')
        if st != 200 or not cj:
            return False, {'status': st, 'configureJson': bool(cj), 'missing': (b or {}).get('missing')}
        r = llmar(run, 'configure', '--from', json.dumps(cj))
        return r.returncode == 0, {'setup': st, 'configure': r.returncode, 'keys': sorted(cj)}
    ph.check('llmar-configure-from-setup', configure)

    def login() -> tuple[bool, dict[str, Any]]:
        res = llmar_login(run, 'member')
        s = llmar(run, 'status')
        return res['exit'] == 0 and s.returncode == 0, {**res, 'status': s.returncode, 'groups': 'groups:    member' in s.stdout}
    ph.check('llmar-login-headless', login)

    session = {'x-router-session': f'e2e-{secrets.token_hex(6)}'}

    def member_calls() -> tuple[bool, dict[str, Any]]:
        out = {}
        for dialect, model in (('messages', haiku), ('chat', luna), ('responses', luna)):
            t = member_token(run)
            out[dialect] = run.gw_call(dialect, model, t, t, extra=session)['status']
        return all(v == 200 for v in out.values()), out
    ph.check('member-calls-both-headers', member_calls)

    def m2m_call() -> tuple[bool, dict[str, Any]]:
        t = run.m2m()
        r = run.gw_call('messages', haiku, t, t, max_tokens=8)
        return r['status'] == 200, r
    ph.check('service-client-call', m2m_call)

    ph.check('claude-code-run', lambda: (lambda r: (r['exit'] == 0 and r['resultOk'], r))(run_claude(run, haiku)))
    ph.check('codex-run', lambda: (lambda r: (r['exit'] == 0 and r['resultOk'], r))(run_codex(run, luna, member_token(run))))

    member = lambda: f"user:{run.state.users['member']['sub']}"  # noqa: E731

    def expected() -> int:   # 3 API calls, plus one per CLI run that succeeded
        checks = run.state.data['checks']
        return 3 + sum(1 for k in ('c3.claude-code-run', 'c3.codex-run') if checks.get(k, {}).get('ok'))

    def me_records() -> tuple[bool, dict[str, Any]]:
        t0, items, want = time.time(), [], expected()
        while time.time() - t0 < 420:
            st, items = run.api_items('/api/me/records', run.console_token('member'), {'from': since, 'limit': 200})
            if st == 200 and len([i for i in items if i.get('kind') == 'model' and i.get('status') == 200]) >= want:
                break
            time.sleep(20)
        ok_items = [i for i in items if i.get('kind') == 'model' and i.get('status') == 200]
        return len(ok_items) >= want, {'records': len(items), 'model200': len(ok_items), 'expected': want,
                                       'dialects': sorted({str(i.get('dialect')) for i in ok_items}), 'waitedS': round(time.time() - t0, 1)}
    if not ph.check('member-records-attributed', me_records):
        return ph.finish()

    def me_usage() -> tuple[bool, dict[str, Any]]:
        day = since[:10]
        st, b = run.api('GET', '/api/me/usage', run.console_token('member'), params={'from': day, 'to': dt.datetime.now(dt.timezone.utc).date().isoformat()})
        req = ((b or {}).get('totals') or {}).get('requests') or 0
        return st == 200 and req >= expected(), {'status': st, 'requests': req, 'expected': expected()}
    ph.check('member-usage', me_usage)

    def admin_records() -> tuple[bool, dict[str, Any]]:
        st, items = run.api_items('/api/admin/records', run.console_token('admin'), {'from': since, 'limit': 200, 'caller': member()})
        return st == 200 and len(items) >= expected(), {'status': st, 'records': len(items), 'expected': expected()}
    ph.check('admin-records-for-member', admin_records)

    def cross() -> tuple[bool, dict[str, Any]]:
        client = f"client:{run.d.ssm('agent-client-id')}"
        st, items = run.api_items('/api/admin/records', run.console_token('admin'), {'from': since, 'limit': 50, 'caller': client}, max_pages=5)
        if st != 200 or not items:
            return False, {'adminList': st, 'clientRecords': len(items)}
        rid, ts = items[0]['reqId'], items[0]['ts']
        s_member, _ = run.api('GET', f'/api/me/records/{rid}', run.console_token('member'), params={'ts': ts})
        s_admin, _ = run.api('GET', f'/api/admin/records/{rid}', run.console_token('admin'), params={'ts': ts, 'caller': client})
        return s_member == 404 and s_admin == 200, {'memberGetsOthersRecord': s_member, 'adminGetsIt': s_admin, 'reqIdDigest': dig(rid)}
    ph.check('member-cannot-read-others-404', cross)

    def dlq() -> tuple[bool, dict[str, Any]]:
        a = run.c('sqs').get_queue_attributes(QueueUrl=run.d.console('IngestDlqUrl'), AttributeNames=['ApproximateNumberOfMessages'])['Attributes']
        n = int(a.get('ApproximateNumberOfMessages', '0'))
        return n == 0, {'dlqMessages': n}
    ph.check('ingest-dlq-empty', dlq)
    return ph.finish()


# ------------------------------------------------------------------------------------------------ phase id

def config_state(run: Run) -> dict[str, Any]:
    st, b = run.api('GET', '/api/admin/config', run.console_token('admin'))
    if st != 200:   # e.g. 503 config-unavailable: no active version and config/baked.json unreadable
        raise RuntimeError(f"GET /api/admin/config: {st} {((b or {}).get('error') or {}).get('code') if isinstance(b, dict) else ''}".rstrip())
    return b


def api_error_detail(status: int, body: Any) -> dict[str, Any]:
    """A console API refusal for results/: status, error code and reason, and each issue's path, code and rule
    (never messages: they can quote document values)."""
    b = body if isinstance(body, dict) else {}
    err = b.get('error') if isinstance(b.get('error'), dict) else {}
    issues = err.get('issues') if isinstance(err.get('issues'), list) else b.get('issues')   # 422 body, or validate's 200 {ok, issues}
    keep = ('path', 'code', 'rule')
    out: dict[str, Any] = {'status': status, 'code': err.get('code')}
    if isinstance(err.get('reason'), str):
        out['reason'] = err['reason']
    if isinstance(issues, list):
        out['issues'] = [{k: str(i[k])[:120] for k in keep if isinstance(i, dict) and isinstance(i.get(k), (str, int))} for i in issues[:20]]
    return out


IDENTITY_KEYS_REASONS = ('no-fresh-task', 'partial', 'not-configured', 'task-without-keys')   # 73, ConfigState.router.identityKeys


def keys_view(router: Any) -> dict[str, Any]:
    """ConfigState.router's identity-key evidence (0d effective-config §7, 73): loaded, the reason when not, the
    counts, and a digest of the first offending task."""
    r = router if isinstance(router, dict) else {}
    k = r.get('identityKeys') if isinstance(r.get('identityKeys'), dict) else {}
    out: dict[str, Any] = {'identityKeysLoaded': r.get('identityKeysLoaded'), 'status': r.get('status')}
    for f in ('loaded', 'reason', 'fresh', 'running', 'withKeys'):
        if f in k:
            out[f] = k[f]
    if isinstance(k.get('task'), str):
        out['taskDigest'] = dig(k['task'])
    if 'reason' in out and out['reason'] not in IDENTITY_KEYS_REASONS:
        out['reasonUnknown'] = True   # a code this driver doesn't know: the contract moved
    return out


def wait_keys_loaded(fetch: Callable[[], Any], timeout_s: float = 360, every_s: float = 20,
                     sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time) -> tuple[bool, dict[str, Any]]:
    """Polls ConfigState.router until identityKeysLoaded is true (the router's state lines come every 5 min, so up to
    6 min). A failed read is recorded and polled again. The detail is the last view, with the wait and poll count."""
    t0, polls, view, last_error = clock(), 0, {}, None
    while True:
        polls += 1
        try:
            view, last_error = keys_view(fetch()), None
        except Exception as e:  # noqa: BLE001 - e.g. a 503 between deploys: keep polling, record the last one
            last_error = str(e)[:120]
        if view.get('identityKeysLoaded') is True or clock() - t0 >= timeout_s:
            break
        sleep(every_s)
    det = {**view, 'waitedS': round(clock() - t0, 1), 'polls': polls, **({'lastError': last_error} if last_error else {})}
    return view.get('identityKeysLoaded') is True, det


def activate(run: Run, document: dict[str, Any], comment: str, rollback_of: str | None = None) -> tuple[int, dict[str, Any] | None, str | None]:
    base = config_state(run)['active']['version']
    # confirmDisruptive always: restores weaken identity (identity-weakened) or drop the edit, which the API counts as disruptive
    body = {'document': document, 'comment': comment, 'baseVersion': base, 'confirmDisruptive': True, **({'rollbackOf': rollback_of} if rollback_of else {})}
    st, b = run.api('POST', '/api/admin/config/activate', run.console_token('admin'), body=body)
    version = ((b or {}).get('version') or {}).get('version') if st in (200, 201) else None
    return st, b, version


def wait_applied(run: Run, version: str, start_ms: int, timeout_s: float = 60) -> tuple[bool, dict[str, Any]]:
    svc = run.c('ecs').describe_services(cluster=run.d.ssm('cluster-name'), services=[run.d.ssm('service-name')]).get('services') or []
    if not svc:
        raise RuntimeError('router ECS service not found (describe_services returned failures)')
    want_tasks = max(1, int(svc[0]['runningCount']))
    lines, waited = run.wait_logs(f'{{ $.kind = "config" && $.source = "config" && $.configVersion = "{version}" }}', start_ms,
                                  lambda ls: len({ln['_stream'] for ln in ls if ln.get('outcome') == 'applied'}) >= want_tasks, timeout_s, every_s=3)
    tasks = len({ln['_stream'] for ln in lines if ln.get('outcome') == 'applied'})
    return tasks >= want_tasks, {'tasksApplied': tasks, 'tasksRunning': want_tasks, 'waitedS': waited,
                                 'rejected': len([ln for ln in lines if ln.get('outcome') == 'rejected'])}


def phase_id(run: Run) -> bool:
    """Config, identity and budget checks. Whatever happens after the first activation (a failed check, a timeout,
    an Abort or any exception), restore() runs: baked default, identity observe, no member budget."""
    ph = Phase(run, 'id')
    haiku, _ = models(run)
    member_sub = (run.state.users.get('member') or {}).get('sub')
    if not member_sub:
        raise Abort('no member: run phase c3 first')
    aborted: Abort | None = None
    try:
        id_checks(run, ph, haiku, member_sub)
    except Abort as e:
        aborted = e
    finally:
        ph.check('restore-baked-default', lambda: restore(run), always=True)
    ok = ph.finish()
    if aborted:
        raise aborted
    return ok


def id_checks(run: Run, ph: Phase, haiku: str, member_sub: str) -> None:
    def edit() -> tuple[bool, dict[str, Any]]:
        cs = config_state(run)
        run.state.ids['idStartVersion'] = cs['active']['version']
        run.state.save()
        doc = copy.deepcopy(cs['active']['document'])
        pol = doc.setdefault('policy', {})
        comp = pol.setdefault('compaction', {})
        comp['shrinkRatio'] = 0.61 if comp.get('shrinkRatio') != 0.61 else 0.62   # tuning only: no session moves
        stv, bv = run.api('POST', '/api/admin/config/validate', run.console_token('admin'), body={'document': doc})
        if stv != 200 or not (bv or {}).get('ok'):
            return False, {'validate': api_error_detail(stv, bv)}
        t0 = int(time.time() * 1000)
        st, b, v = activate(run, doc, 'e2e: tuning edit')
        if not v:
            return False, {'activate': api_error_detail(st, b)}
        run.state.ids['editVersion'] = v
        ok, det = wait_applied(run, v, t0, 60)
        return ok, {'activate': st, **det}
    ph.check('config-activate-applied-60s', edit)

    def rollback() -> tuple[bool, dict[str, Any]]:
        start = run.state.ids.get('idStartVersion')
        st0, old = run.api('GET', f'/api/admin/config/versions/{start}', run.console_token('admin'))
        if st0 != 200:
            return False, {'getVersion': st0}
        t0 = int(time.time() * 1000)
        st, b, v = activate(run, old['document'], 'e2e: roll back the tuning edit', rollback_of=start)
        if not v:
            return False, {'activate': api_error_detail(st, b)}
        ok, det = wait_applied(run, v, t0, 60)
        return ok, {'activate': st, **det}
    ph.check('config-rollback-applied', rollback)

    # Every running task's state line reports its signing keys loaded (C#state, fresh = 15 min); state lines come
    # every 5 min, so wait up to 6. If it never does, the detail carries 73's reason code and counts.
    ph.check('require-precondition-jwks', lambda: wait_keys_loaded(lambda: config_state(run)['router']))
    ph.skip('require-refused-without-jwks', 'not reproducible on a healthy stack (jwks applied); covered by console-api tests')

    def require_on() -> tuple[bool, dict[str, Any]]:
        doc = copy.deepcopy(config_state(run)['active']['document'])
        doc['identity'] = {'mode': 'require'}
        t0 = int(time.time() * 1000)
        st, b, v = activate(run, doc, 'e2e: identity require')
        if not v:   # 422 identity-keys-not-loaded (reason in error.reason), or a validation failure
            return False, {'activate': api_error_detail(st, b), 'keys': keys_view(config_state(run).get('router'))}
        run.state.ids['requireVersion'] = v
        ok, det = wait_applied(run, v, t0, 60)
        return ok, {'activate': st, **det}
    if not ph.check('identity-require-applied', require_on):
        return

    def no_key() -> tuple[bool, dict[str, Any]]:
        r = run.gw_call('messages', haiku, run.m2m(), None, max_tokens=8, billable=False)
        return r['status'] == 401 and r.get('code') == 'identity-missing', r
    ph.check('require-no-api-key-401', no_key)

    def with_key() -> tuple[bool, dict[str, Any]]:
        t = run.m2m()
        r = run.gw_call('messages', haiku, t, t, max_tokens=8)
        return r['status'] == 200, r
    ph.check('require-with-api-key-200', with_key)

    member_tok: dict[str, str] = {}

    def disable() -> tuple[bool, dict[str, Any]]:
        member_tok['t'] = member_token(run)        # issued before the disable: still passes the gateway
        st, _ = run.api('POST', f'/api/admin/members/{member_sub}/actions', run.console_token('admin'), body={'action': 'disable'})
        t0, last = time.time(), {}
        while time.time() - t0 < 60:
            last = run.gw_call('messages', haiku, member_tok['t'], member_tok['t'], max_tokens=8)
            if last['status'] == 403:
                break
            time.sleep(5)
        waited = round(time.time() - t0, 1)
        return st == 200 and last.get('status') == 403 and last.get('code') == 'identity-blocked' and waited <= 40, \
            {'action': st, 'status': last.get('status'), 'code': last.get('code'), 'blockedAfterS': waited}
    ph.check('disable-403-within-40s', disable)

    def enable() -> tuple[bool, dict[str, Any]]:
        st, _ = run.api('POST', f'/api/admin/members/{member_sub}/actions', run.console_token('admin'), body={'action': 'enable'})
        tok = member_tok.get('t') or ''
        t0, last = time.time(), {}
        while time.time() - t0 < 90 and tok:
            last = run.gw_call('messages', haiku, tok, tok, max_tokens=8)
            if last['status'] == 200:
                break
            time.sleep(5)
        relog = llmar_login(run, 'member')          # disable revoked the refresh token (global sign-out)
        return st == 200 and last.get('status') == 200 and relog['exit'] == 0, \
            {'action': st, 'status': last.get('status'), 'servedAfterS': round(time.time() - t0, 1), 'relogin': relog['exit']}
    ph.check('enable-served-again', enable)

    def budget() -> tuple[bool, dict[str, Any]]:
        st, _ = run.api('PATCH', f'/api/admin/members/{member_sub}', run.console_token('admin'),
                        body={'budget': {'monthlyUsd': 0.000001, 'alertAt': 0.5, 'hardStop': True}})
        t0, last, calls = time.time(), {}, 0
        while time.time() - t0 < 600:
            t = member_token(run)
            last = run.gw_call('messages', haiku, t, t, max_tokens=8)
            calls += 1
            if last['status'] == 429:
                break
            time.sleep(20)
        return st == 200 and last.get('status') == 429 and last.get('code') == 'budget-exceeded', \
            {'patch': st, 'status': last.get('status'), 'code': last.get('code'), 'blockedAfterS': round(time.time() - t0, 1), 'calls': calls}
    ph.check('budget-hard-stop-429', budget)

    def budget_off() -> tuple[bool, dict[str, Any]]:
        st, _ = run.api('PATCH', f'/api/admin/members/{member_sub}', run.console_token('admin'), body={'budget': None})
        t0, last = time.time(), {}
        while time.time() - t0 < 600:
            t = member_token(run)
            last = run.gw_call('messages', haiku, t, t, max_tokens=8)
            if last['status'] == 200:
                break
            time.sleep(20)
        return st == 200 and last.get('status') == 200, {'patch': st, 'status': last.get('status'), 'liftedAfterS': round(time.time() - t0, 1)}
    ph.check('budget-removed-served', budget_off)


BAKED_VERSION = re.compile(r'^0-baked(\.[0-9a-f]{8})?$')   # 0-baked.<sha8> (0d effective-config §2), legacy 0-baked


def baked_document(run: Run) -> dict[str, Any]:
    """The deploy-time baked document, read from the config bucket (config/baked.json: RouterStack writes it with
    the router's own bakedConfigDocument, so it equals the router's generation 0)."""
    body = run.c('s3').get_object(Bucket=run.d.ssm('config-bucket'), Key='config/baked.json')['Body'].read()
    doc = json.loads(body)
    if not isinstance(doc, dict) or not BAKED_VERSION.match(str(doc.get('version', ''))) or not isinstance(doc.get('policy'), dict):
        raise RuntimeError('config/baked.json is not a baked config document')
    return doc


def effective_identity(profile: Any, setup: Any, active_version: str, baked_version: str | None) -> tuple[bool, dict[str, Any]]:
    """Profile/setup identity mode and its source (0d effective-config §4; 73's contract: deployment.identityMode,
    deployment.effective.identityMode = {value, source, version}; setup: identityMode, effective.identityMode).
    No console version active (the active version is the baked one): 'observe' from source 'baked' at the baked
    version. A version active: source 'document' at that version. Never a guessed 'off', never 'unknown'."""
    dep = (profile or {}).get('deployment') or {}
    eff = ((dep.get('effective') or {}).get('identityMode')) or {}
    seff = (((setup or {}).get('effective') or {}).get('identityMode')) or {}
    no_doc = bool(BAKED_VERSION.match(str(active_version)))
    if no_doc:
        ok = (dep.get('identityMode') == 'observe' and eff.get('value') == 'observe' and eff.get('source') == 'baked'
              and bool(BAKED_VERSION.match(str(eff.get('version', '')))) and (baked_version is None or eff.get('version') == baked_version))
    else:
        ok = eff.get('source') == 'document' and eff.get('version') == active_version and eff.get('value') == dep.get('identityMode') \
            and dep.get('identityMode') in ('off', 'observe', 'require')
    same = (setup or {}).get('identityMode') == dep.get('identityMode') and seff == eff
    return ok and same, {'activeIsBaked': no_doc, 'identityMode': dep.get('identityMode'), 'effective': eff,
                         'setupMatches': same, 'bakedVersionMatches': None if baked_version is None else eff.get('version') == baked_version}


def without_version(d: dict[str, Any] | None) -> dict[str, Any]:
    return {k: v for k, v in (d or {}).items() if k != 'version'}


def restore(run: Run) -> tuple[bool, dict[str, Any]]:
    """Baked default (config/baked.json), identity observe, no budget on the test member. Idempotent: it changes
    nothing (no activation, no PATCH) when that is already the state. Either baked version form is accepted."""
    if 'admin' not in run.state.users or not run.secrets.get('admin'):
        raise RuntimeError('no test admin session: cannot restore or verify')
    baked = baked_document(run)
    det: dict[str, Any] = {'bakedVersion': baked['version'], 'activated': False, 'budgetPatched': False}
    cs = config_state(run)
    if without_version(cs['active']['document']) != without_version(baked):
        # rollbackOf names the stored baked version when the console knows it (0-baked.<sha8>, else legacy 0-baked)
        rollback_of = None
        for v in dict.fromkeys((baked['version'], '0-baked')):
            if run.api('GET', f'/api/admin/config/versions/{v}', run.console_token('admin'))[0] == 200:
                rollback_of = v
                break
        t0 = int(time.time() * 1000)
        st, _, v = activate(run, copy.deepcopy(baked), 'e2e: restore the baked default', rollback_of=rollback_of)  # the API sets the new version
        ok, wait = wait_applied(run, v, t0, 90) if v else (False, {'activate': st})
        det.update(activated=bool(v), rollbackOf=rollback_of, **wait)
        if not ok:
            return False, det
    active = config_state(run)['active']
    mode = (active['document'].get('identity') or {}).get('mode') or baked.get('identity', {}).get('mode')
    det['matchesBaked'] = without_version(active['document']) == without_version(baked)
    det['activeIsBakedVersion'] = bool(BAKED_VERSION.match(str(active.get('version', ''))))
    sub = (run.state.users.get('member') or {}).get('sub')
    budget = None
    if sub:
        stm, m = run.api('GET', f'/api/admin/members/{sub}', run.console_token('admin'))
        if stm == 200 and (m or {}).get('budget') is not None:
            run.api('PATCH', f'/api/admin/members/{sub}', run.console_token('admin'), body={'budget': None})
            det['budgetPatched'] = True
            stm, m = run.api('GET', f'/api/admin/members/{sub}', run.console_token('admin'))
        budget = (m or {}).get('budget') if stm == 200 else None
        det['member'] = stm
    return det['matchesBaked'] and mode != 'require' and budget is None, {'identityMode': mode, 'memberBudget': budget, **det}


# ------------------------------------------------------------------------------------------------ cleanup

def remaining_e2e_users(idp: Any, pool: str) -> list[dict[str, Any]]:
    """Every user whose e-mail starts with e2e- (ListUsers pages hold at most 60)."""
    return [u for page in idp.get_paginator('list_users').paginate(UserPoolId=pool, Filter='email ^= "e2e-"') for u in page.get('Users', [])]


def phase_cleanup(run: Run) -> bool:
    ph = Phase(run, 'cleanup')
    run.args.force = True   # cleanup always runs its steps
    idp, db = run.c('cognito-idp'), run.c('dynamodb')

    def restore_first() -> tuple[bool, dict[str, Any]]:
        # While the test admin still exists; a no-op when phase id already restored everything.
        if 'admin' not in run.state.users:
            prior = run.state.data['checks'].get('id.restore-baked-default', {}).get('ok')
            return bool(prior) or not run.state.data['checks'].get('id.config-activate-applied-60s'), \
                {'note': 'no test admin left', 'idRestoredBefore': prior}
        return restore(run)
    if run.args.skip_restore:
        ph.skip('restore-baked-default', '--skip-restore: not restored or verified (stack gone, or restored by hand)')
    elif not ph.check('restore-baked-default', restore_first):
        # Keep the test users: the admin session is the only driver path back to observe / no budget / baked policy.
        ph.finish()
        raise Abort('restore failed: fix and rerun cleanup (test users kept so the admin session can retry the restore)')

    def llmar_out() -> tuple[bool, dict[str, Any]]:
        if not (run.work / 'llmar').exists():
            return True, {'llmar': 'absent'}
        r = llmar(run, 'logout')
        return r.returncode in (0, 3), {'logout': r.returncode}
    ph.check('llmar-logout', llmar_out)

    def users() -> tuple[bool, dict[str, Any]]:
        out = {}
        order = [k for k in run.state.users if k != 'admin'] + (['admin'] if 'admin' in run.state.users else [])
        for label in order:
            u = run.state.users[label]
            if label == 'admin' and len(order) > 1:
                try:   # regenerate principals/blocks without the deleted members while an admin session exists
                    st, _ = run.api('POST', '/api/admin/identity/republish', run.console_token('admin'))
                    out['republish'] = st
                except Exception as e:  # noqa: BLE001
                    out['republish'] = type(e).__name__
            for op in (idp.admin_user_global_sign_out, idp.admin_delete_user):
                try:
                    op(UserPoolId=run.d.pool, Username=u['username'])
                except idp.exceptions.UserNotFoundException:
                    out[f'{label}.{op.__name__}'] = 'absent'
            if u.get('sub'):
                db.delete_item(TableName=run.d.console('ConsoleTableName'), Key={'pk': {'S': f"MEMBER#user:{u['sub']}"}, 'sk': {'S': 'PROFILE'}})
            out[label] = 'deleted'
        left = remaining_e2e_users(idp, run.d.pool)
        run.state.data['users'] = {}
        run.state.save()
        return not left, {'users': out, 'remainingE2eUsers': len(left)}
    ph.check('test-users', users)

    def local() -> tuple[bool, dict[str, Any]]:
        run.secrets.delete()
        for child in run.work.iterdir() if run.work.exists() else []:
            if child != run.state.path:   # the state file goes last, after the table (below)
                shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
        return not run.secrets.path.exists(), {'secretsFile': 'deleted', 'workDir': 'emptied'}
    ph.check('local-files', local)
    ok = ph.finish()
    shutil.rmtree(run.work, ignore_errors=True)
    return ok


# ------------------------------------------------------------------------------------------------ CLI

PHASES: dict[str, Callable[[Run], bool]] = {'r': phase_r, 'c1': phase_c1, 'c2': phase_c2, 'c3': phase_c3, 'id': phase_id, 'cleanup': phase_cleanup}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('phase', 'status'):
        p = sub.add_parser(name)
        if name == 'phase':
            p.add_argument('name', choices=[*PHASES, 'all'])
        p.add_argument('--region', required=True)
        p.add_argument('--prefix', default='llmar')
        p.add_argument('--force', action='store_true', help='rerun checks that passed before')
        p.add_argument('--cap', type=float, default=SPEND_CAP, help='abort before a call that could take the spend above this (USD)')
        p.add_argument('--haiku', help='Messages fast model id (default: the haiku id in model-universe)')
        p.add_argument('--luna', help='OpenAI fast model id (default: the luna id in model-universe)')
        p.add_argument('--skip-restore', action='store_true',
                       help='cleanup only: delete the test users without restoring first (the stack is gone, or it was restored by hand)')
    args = ap.parse_args(argv)
    if args.cap > SPEND_CAP:
        print(f'--cap above {SPEND_CAP} is not allowed', file=sys.stderr)
        return 2
    try:
        run = Run(args)
        if args.cmd == 'status':
            rows = [(k, 'PASS' if v['ok'] else 'FAIL', json.dumps(v.get('detail'), ensure_ascii=False)[:150]) for k, v in sorted(run.state.data['checks'].items())]
            print_table('status', rows or [('none', 'INFO', 'no checks yet')])
            print(json.dumps(mask(run.state.data['spend'])))
            run.d.outputs(f'{args.prefix}-router')   # Abort when the router stack is not there (or not reachable)
            print(f'deployment: {args.prefix}-router found')
            return 0
        names = ['r', 'c1', 'c2', 'c3', 'id'] if args.name == 'all' else [args.name]
        for n in names:
            if not PHASES[n](run):
                if args.name == 'all':
                    print(f'\nphase {n} failed: stopping; inspect, then run `phase cleanup`.')
                return 1
        if args.name == 'all':
            return 0 if PHASES['cleanup'](run) else 1
        return 0
    except Abort as e:
        print(f'ABORT: {mask(str(e))}', file=sys.stderr)
        return 2
    except (botocore.exceptions.BotoCoreError, botocore.exceptions.ClientError) as e:
        print(f'ABORT: AWS {type(e).__name__}: {mask(str(e))[:300]}', file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - no raw traceback (it could carry request data); E2E_TRACEBACK=1 shows a masked one
        if os.environ.get('E2E_TRACEBACK') == '1':
            import traceback
            print(mask(traceback.format_exc()), file=sys.stderr)
        print(f'ERROR: {type(e).__name__}: {mask(str(e))[:300]}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
