"""Offline checks of the E2E driver's pure parts: fake boto3 clients and a fake console API (no AWS, no network).

  uv run --python 3.12 --with pytest==8.4.2 --with boto3==1.40.70 --with requests==2.34.2 --with playwright==1.64.1 \
      pytest -q experiments/console-e2e/tests
"""
import importlib.util
import pathlib
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('e2e', HERE / 'e2e.py')
e2e = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(e2e)

PARAMS = {n: f'value-{n}' for n in (*e2e.SSM_REQUIRED, 'user-pool-arn', 'gateway-id', 'service-arn', 'cli-client-id',
                                       'cli-callback-ports', 'identity-header')}


class FakePaginator:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def paginate(self, **kw):
        self.calls.append(kw)
        yield from self.pages


class FakeClient:
    def __init__(self, paginators):
        self.paginators = paginators

    def get_paginator(self, op):
        return self.paginators[op]


def ssm_pages(names, size=10):
    items = [{'Name': f'/llmar/router/{n}', 'Value': PARAMS[n]} for n in names]
    return [{'Parameters': items[i:i + size]} for i in range(0, len(items), size)]


def deploy(pages):
    pg = FakePaginator(pages)
    session = types.SimpleNamespace(client=lambda name: FakeClient({'get_parameters_by_path': pg}))
    return e2e.Deploy(session, 'llmar', 'xx-test-1'), pg


def test_ssm_reads_every_page():
    names = list(PARAMS)   # 15 parameters; reversed, user-pool-id lands on the second page of 10
    d, pg = deploy(ssm_pages(list(reversed(names))))
    assert len(pg.pages) == 2
    assert d.ssm('user-pool-id') == 'value-user-pool-id' and d.pool == 'value-user-pool-id'
    assert len(d._ssm) == 15 and pg.calls == [{'Path': '/llmar/router/', 'Recursive': False}]


def test_ssm_lists_every_missing_name():
    present = [n for n in PARAMS if n not in ('user-pool-id', 'service-name')]
    d, _ = deploy(ssm_pages(present))
    with pytest.raises(e2e.Abort) as err:
        d.ssm('gateway-url')
    assert 'user-pool-id' in str(err.value) and 'service-name' in str(err.value) and '13 parameters' in str(err.value)


def test_ssm_none_at_all():
    d, _ = deploy([{'Parameters': []}])
    with pytest.raises(e2e.Abort, match='is the router stack deployed'):
        d.ssm('gateway-url')


def test_remaining_users_reads_every_page():
    pg = FakePaginator([{'Users': [{'Username': f'u{i}'} for i in range(60)]}, {'Users': [{'Username': 'u60'}]}])
    left = e2e.remaining_e2e_users(FakeClient({'list_users': pg}), 'pool-1')
    assert len(left) == 61 and pg.calls == [{'UserPoolId': 'pool-1', 'Filter': 'email ^= "e2e-"'}]


def test_api_items_follows_the_cursor():
    pages = {None: {'items': [{'reqId': 'a'}], 'nextCursor': 'c1'}, 'c1': {'items': [], 'nextCursor': 'c2'}, 'c2': {'items': [{'reqId': 'b'}]}}
    seen = []

    def api(method, path, token, params=None, **_):
        seen.append(params.get('cursor'))
        return 200, pages[params.get('cursor')]
    fake = types.SimpleNamespace(api=api)
    st, items = e2e.Run.api_items(fake, '/api/me/records', 't', {'from': 'x', 'limit': 200})
    assert st == 200 and [i['reqId'] for i in items] == ['a', 'b'] and seen == [None, 'c1', 'c2']


def test_api_items_stops_on_error_and_at_max_pages():
    fake = types.SimpleNamespace(api=lambda *a, **k: (403, {'error': {'code': 'forbidden'}}))
    assert e2e.Run.api_items(fake, '/api/admin/records', 't', {}) == (403, [])
    endless = types.SimpleNamespace(api=lambda *a, params=None, **k: (200, {'items': [{}], 'nextCursor': 'again'}))
    st, items = e2e.Run.api_items(endless, '/api/admin/records', 't', {}, max_pages=3)
    assert st == 200 and len(items) == 3


def test_routes_match_the_contract_and_masking():
    src = e2e.ROUTES_TS.read_text()
    assert len(e2e.console_routes()) == src.count("\n  r('")
    assert all(':' not in p for _, _, p in e2e.console_routes())
    acct = '1234567890' + '12'   # built at runtime: no 12-digit literal in the repo (N5)
    m = e2e.mask({'arn': f'arn:aws:iam::{acct}:role/x', 'tok': 'eyJabcdefghij.eyJabcdefghij.abcdefghijkl'})
    assert m == {'arn': 'arn:aws:iam::<acct>:role/x', 'tok': '<jwt>'}


def test_chat_body_uses_max_completion_tokens():
    path, body = e2e.request_body('chat', 'global.openai.gpt-6.1-sol', 16)
    assert path == '/v1/chat/completions' and body['max_completion_tokens'] == 16 and 'max_tokens' not in body
    assert e2e.request_body('messages', 'm', 16)[1]['max_tokens'] == 16                  # Anthropic keeps max_tokens
    assert 'max_tokens' not in e2e.request_body('responses', 'm', 16)[1]                 # Responses: max_output_tokens


class FakeResponse:
    def __init__(self, status, body, headers=None):
        self.status_code, self._body, self.headers = status, body, headers or {}

    def json(self):
        return self._body


def gw(monkeypatch, response):
    sent = {}

    def post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, body=json, headers=headers)
        return response
    monkeypatch.setattr(e2e.requests, 'post', post)
    fake = types.SimpleNamespace(d=types.SimpleNamespace(gw='https://gw.example'), spend_guard=lambda u: None, spend_add=lambda u, cli=False: None)
    return sent, fake


def test_failed_call_records_upstream_code_and_param(monkeypatch):
    sent, fake = gw(monkeypatch, FakeResponse(400, {'error': {'message': "Unsupported parameter: 'max_tokens' ...", 'type': 'invalid_request_error',
                                                              'param': 'max_tokens', 'code': 'unsupported_parameter'}}))
    r = e2e.Run.gw_call(fake, 'chat', 'auto', 'tok', 'tok')
    assert r['status'] == 400 and r['code'] == 'unsupported_parameter' and r['upstreamParam'] == 'max_tokens'
    assert r['upstreamType'] == 'invalid_request_error' and 'message' not in r and 'max_tokens' not in sent['body']
    assert sent['url'] == 'https://gw.example/inference/v1/chat/completions'


def test_router_code_wins_and_gateway_errortype_kept(monkeypatch):
    _, fake = gw(monkeypatch, FakeResponse(401, {'error': 'unauthorized', 'code': 'identity-missing'}))
    assert e2e.Run.gw_call(fake, 'messages', 'm', 'tok', None)['code'] == 'identity-missing'
    _, fake = gw(monkeypatch, FakeResponse(403, {'message': 'Forbidden'}, {'x-amzn-errortype': 'AccessDeniedException'}))
    r = e2e.Run.gw_call(fake, 'messages', 'm', 'tok', None)
    assert r['code'] == 'AccessDeniedException' and r['errorType'] == 'AccessDeniedException'
    _, fake = gw(monkeypatch, FakeResponse(400, {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'x'}}))
    assert e2e.Run.gw_call(fake, 'messages', 'm', 'tok', None)['code'] == 'invalid_request_error'


class FakeBody:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


def baked_run(doc):
    s3 = types.SimpleNamespace(get_object=lambda **kw: {'Body': FakeBody(e2e.json.dumps(doc).encode())} if kw['Key'] == 'config/baked.json' else None)
    return types.SimpleNamespace(c=lambda name: s3, d=types.SimpleNamespace(ssm=lambda name: 'config-bucket'))


def test_baked_document_accepts_both_version_forms():
    doc = {'schemaVersion': 1, 'version': '0-baked.ab12cd34', 'policy': {'version': 'p'}, 'identity': {'mode': 'observe'}, 'access': {'groups': {}}}
    assert e2e.baked_document(baked_run(doc))['version'] == '0-baked.ab12cd34'
    assert e2e.baked_document(baked_run({**doc, 'version': '0-baked'}))['version'] == '0-baked'
    for bad in ({**doc, 'version': '3-20261108T000000Z'}, {**doc, 'version': '0-baked.XYZ'}, {k: v for k, v in doc.items() if k != 'policy'}):
        with pytest.raises(RuntimeError):
            e2e.baked_document(baked_run(bad))


def test_restore_compares_documents_without_version():
    baked = {'schemaVersion': 1, 'version': '0-baked.ab12cd34', 'policy': {'version': 'p'}, 'identity': {'mode': 'observe'}}
    active = {**baked, 'version': '9-20261108T010000Z'}   # a restore activation: new version, the baked content
    assert e2e.without_version(active) == e2e.without_version(baked)
    assert e2e.without_version({**active, 'identity': {'mode': 'require'}}) != e2e.without_version(baked)


GOOD_SPA = {'schemaVersion': 1, 'region': 'xx-test-1', 'issuer': 'https://cognito-idp.xx-test-1.amazonaws.com/pool_1',
            'cognitoDomain': 'https://llmar-ab12.auth.xx-test-1.amazoncognito.com', 'clientId': 'consoleclient', 'scopes': ['openid', 'email', 'llmar/console']}


def test_spa_config_schema_valid_and_consistent():
    assert e2e.spa_config_issues(GOOD_SPA, client_id='consoleclient', console_scope='llmar/console',
                                 issuer='https://cognito-idp.xx-test-1.amazonaws.com/pool_1', cognito_domain='https://llmar-ab12.auth.xx-test-1.amazoncognito.com') == []


def test_spa_config_schema_catches_the_live_shape():
    live = {k: v for k, v in GOOD_SPA.items() if k not in ('schemaVersion', 'scopes')} | {'scope': 'openid email llmar/console'}
    issues = e2e.spa_config_issues(live, console_scope='llmar/console')
    assert 'schemaVersion must be 1' in issues and 'scopes must be a non-empty list of scope names' in issues


def test_spa_config_schema_rejects_http_and_mismatches():
    bad = {**GOOD_SPA, 'issuer': 'http://cognito-idp.xx-test-1.amazonaws.com/pool_1', 'clientId': 'other', 'tokenStorage': 'local',
           'apiBase': '//evil.example', 'scopes': ['openid']}
    issues = e2e.spa_config_issues(bad, client_id='consoleclient', console_scope='llmar/console',
                                   cognito_domain='https://other.auth.xx-test-1.amazoncognito.com')
    for want in ('issuer must be an https URL', 'clientId is not the console client', "tokenStorage must be 'session' or 'memory'",
                 'apiBase must be a same-origin path', 'scopes must include llmar/console', "cognitoDomain is not this pool's domain"):
        assert want in issues
    assert e2e.spa_config_issues([1]) == ['not a JSON object']
    assert 'holds a secret-like key or a JWT' in e2e.spa_config_issues({**GOOD_SPA, 'clientSecret': 'x'})


def test_visible_text_reads_headings_and_alerts():
    page = types.SimpleNamespace(evaluate=lambda js: '  This console is not configured \n | schemaVersion must be 1; scopes must be a non-empty list  ' + 'x' * 200,
                                 url='https://d1.example.net/?code=abc#frag')
    t = e2e.visible_text(page)
    assert t.startswith('This console is not configured | schemaVersion must be 1') and len(t) == 120
    err = e2e.page_problem(page, 'no Sign in button')
    assert 'https://d1.example.net/' in str(err) and 'code=abc' not in str(err) and 'not configured' in str(err)
    broken = types.SimpleNamespace(evaluate=lambda js: (_ for _ in ()).throw(RuntimeError('detached')), url='about:blank')
    assert e2e.visible_text(broken) == '<unreadable: RuntimeError>'


BAKED_V = '0-baked.ab12cd34'


def prof(mode, value, source, version):
    eff = {'identityMode': {k: v for k, v in (('value', value), ('source', source), ('version', version)) if v is not None}}
    return {'deployment': {'identityMode': mode, 'effective': eff}}, {'identityMode': mode, 'effective': eff}


def test_effective_identity_baked_observe():
    p, s = prof('observe', 'observe', 'baked', BAKED_V)
    ok, det = e2e.effective_identity(p, s, BAKED_V, BAKED_V)
    assert ok and det['activeIsBaked'] and det['bakedVersionMatches']
    assert e2e.effective_identity(p, s, '0-baked', None)[0]          # legacy active pointer, baked.json unreadable


def test_effective_identity_rejects_guessed_off_unknown_and_drift():
    for args in (('off', 'off', 'baked', BAKED_V), ('unknown', None, 'unknown', None), ('observe', 'observe', 'document', BAKED_V)):
        p, s = prof(*args)
        assert not e2e.effective_identity(p, s, BAKED_V, BAKED_V)[0], args
    p, s = prof('observe', 'observe', 'baked', '0-baked.ffffffff')    # another deploy's baked content
    assert not e2e.effective_identity(p, s, BAKED_V, BAKED_V)[0]
    p, _ = prof('observe', 'observe', 'baked', BAKED_V)
    _, other = prof('require', 'require', 'document', '3-20261108T000000Z')
    assert not e2e.effective_identity(p, other, BAKED_V, BAKED_V)[0]   # setup disagrees with the profile


def test_effective_identity_document_active():
    p, s = prof('require', 'require', 'document', '5-20261108T020000Z')
    assert e2e.effective_identity(p, s, '5-20261108T020000Z', BAKED_V)[0]
    assert not e2e.effective_identity(p, s, '6-20261108T030000Z', BAKED_V)[0]   # not the active version


def test_output_tail_masks_secrets_and_keeps_the_last_lines():
    jwt = 'eyJ' + 'a' * 20 + '.eyJ' + 'b' * 20 + '.' + 'c' * 30
    acct = '1234567890' + '12'
    akid = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'   # built at runtime, like acct: no key-shaped literal in the repo
    text = '\n'.join([f'line {i}' for i in range(30)] + [
        f'Authorization: Bearer {jwt}', 'x-api-key: plainvalue123', '{"refresh_token": "r-tok-value", "ok": 1}',
        f'arn:aws:iam::{acct}:role/x', akid, 'helper said the-known-secret', '', 'token helper exited 1'])
    tail = e2e.output_tail(text.encode(), secrets_=('the-known-secret',))
    assert len(tail) == 15 and tail[-1] == 'token helper exited 1'
    joined = '\n'.join(tail)
    for leaked in (jwt, 'plainvalue123', 'r-tok-value', acct, akid, 'the-known-secret'):
        assert leaked not in joined
    assert 'Authorization: <masked>' in joined and '<acct>' in joined and '<akid>' in joined and '<secret>' in joined
    assert e2e.output_tail(None) == [] and len(e2e.output_tail('x' * 1000)[0]) <= 300


def fake_cli(tmp_path, body):
    exe = tmp_path / 'fakecli'
    exe.write_text('#!/bin/sh\n' + body)
    exe.chmod(0o700)
    return exe


def test_run_cli_preflight_failure_does_not_run(tmp_path):
    exe = fake_cli(tmp_path, 'echo "launcher: Unable to run fakecli: not associated with any tool" >&2\nexit 1\n')
    r, det = e2e.run_cli([str(exe), '-p', 'x'], cwd=tmp_path, env={'PATH': '/usr/bin:/bin', 'HOME': str(tmp_path)})
    assert r is None and det['exit'] == 1 and det['stage'] == 'preflight' and 'ran' not in det
    assert det['stderrTail'] == ['launcher: Unable to run fakecli: not associated with any tool']


def test_run_cli_records_tails_of_a_failed_run(tmp_path):
    exe = fake_cli(tmp_path, 'if [ "$1" = --version ]; then echo "fakecli 1.2.3"; exit 0; fi\n'
                             'echo "API Error: 401 x-api-key=$LLMAR_TOKEN" >&2\necho partial\nexit 1\n')
    r, det = e2e.run_cli([str(exe), 'exec', 'x'], cwd=tmp_path, env={'PATH': '/usr/bin:/bin', 'LLMAR_TOKEN': 'tok-123456'}, secrets_=('tok-123456',))
    assert r is not None and det['exit'] == 1 and det['ran'] and det['version'] == 'fakecli 1.2.3'
    assert det['stderrTail'] == ['API Error: 401 x-api-key=<masked>'] and det['stdoutTail'] == ['partial']


def test_api_error_detail_keeps_codes_paths_and_reason_not_messages():
    body = {'error': {'code': 'identity-keys-not-loaded', 'reason': 'task-without-keys', 'message': 'keys not loaded on task abc',
                      'issues': [{'path': '/identity/mode', 'code': 'identity', 'rule': 'identity-keys-not-loaded', 'message': 'quote: secret'}]}}
    assert e2e.api_error_detail(422, body) == {'status': 422, 'code': 'identity-keys-not-loaded', 'reason': 'task-without-keys',
                                               'issues': [{'path': '/identity/mode', 'code': 'identity', 'rule': 'identity-keys-not-loaded'}]}
    v = e2e.api_error_detail(200, {'ok': False, 'issues': [{'path': '/policy/mode', 'code': 'enum', 'message': 'x'}, 'junk']})
    assert v == {'status': 200, 'code': None, 'issues': [{'path': '/policy/mode', 'code': 'enum'}, {}]}
    assert e2e.api_error_detail(502, None) == {'status': 502, 'code': None}
    assert 'message' not in str(e2e.api_error_detail(422, body))


def test_keys_view_records_reason_counts_and_a_task_digest():
    router = {'status': 'active', 'identityKeysLoaded': False,
              'identityKeys': {'loaded': False, 'reason': 'partial', 'fresh': 1, 'running': 2, 'withKeys': 1, 'task': 'abcdef0123'}}
    v = e2e.keys_view(router)
    assert v == {'identityKeysLoaded': False, 'status': 'active', 'loaded': False, 'reason': 'partial', 'fresh': 1, 'running': 2,
                 'withKeys': 1, 'taskDigest': e2e.dig('abcdef0123')}
    assert e2e.keys_view({'identityKeys': {'reason': 'something-new'}})['reasonUnknown'] is True
    assert e2e.keys_view(None) == {'identityKeysLoaded': None, 'status': None}


def test_wait_keys_loaded_polls_until_loaded_and_survives_a_failed_read():
    now = [0.0]
    seq = iter([RuntimeError('GET /api/admin/config: 503 config-unavailable'),
                {'identityKeysLoaded': False, 'identityKeys': {'loaded': False, 'reason': 'no-fresh-task', 'fresh': 0, 'withKeys': 0}},
                {'identityKeysLoaded': True, 'identityKeys': {'loaded': True, 'fresh': 2, 'running': 2, 'withKeys': 2}}])

    def fetch():
        x = next(seq)
        if isinstance(x, Exception):
            raise x
        return x
    ok, det = e2e.wait_keys_loaded(fetch, timeout_s=360, every_s=20, sleep=lambda s: now.__setitem__(0, now[0] + s), clock=lambda: now[0])
    assert ok and det['polls'] == 3 and det['waitedS'] == 40 and det['withKeys'] == 2 and 'lastError' not in det and 'reason' not in det


def test_wait_keys_loaded_times_out_with_the_reason():
    now = [0.0]
    stuck = {'identityKeysLoaded': False, 'identityKeys': {'loaded': False, 'reason': 'task-without-keys', 'fresh': 2, 'running': 2, 'withKeys': 1, 'task': 't9'}}
    ok, det = e2e.wait_keys_loaded(lambda: stuck, timeout_s=360, every_s=20, sleep=lambda s: now.__setitem__(0, now[0] + s), clock=lambda: now[0])
    assert not ok and det['reason'] == 'task-without-keys' and det['waitedS'] == 360 and det['polls'] == 19 and det['taskDigest'] == e2e.dig('t9')
