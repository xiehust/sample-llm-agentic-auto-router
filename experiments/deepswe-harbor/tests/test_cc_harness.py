"""Claude Code × Harbor, 4f's side (design-harness §1–2): agent env and job config, the Anthropic proxy route (B's
rewrite, roles, pricing, reservations, summary), against the mock router on loopback. Synthetic requests only."""
import hashlib
import http.client
import json
import pathlib
import re
import uuid

import hcommon  # isort: skip  (puts codex-deepswe on sys.path)
import common  # isort: skip
import proxy as px  # isort: skip
import pytest
from test_harbor_integration import LOOP, rig  # noqa: F401  (the RunnerProxy + mock router fixture)

import cc_calls
import cc_config
import cc_pricing
import harbor_job_cc
import hproxy

common.set_region('ap-southeast-1')
ARMS_JSON = hcommon.HERE.parent / 'claude-code-harbor' / 'arms.json'
SONNET, OPUS, HAIKU = (hcommon.CC_MODELS[k] for k in ('sonnet', 'opus', 'haiku'))
CLF = cc_calls.load_classifier()
BETAS = 'claude-code-20250219,interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20,effort-2025-11-24'


def spec(arm):
    return json.loads(ARMS_JSON.read_text())['arms'][arm]


def _sys(opening):
    return [{'type': 'text', 'text': 'x-billing-header'}, {'type': 'text', 'text': 'preamble'}, {'type': 'text', 'text': opening + ' more text'}]


# Synthetic system blocks whose openings hash to the frozen signatures cannot be produced without the real prompt, so
# the request builder takes the signature from a patched classifier (the logic under test is the matching).
def _clf_with(sigs):
    c = json.loads(json.dumps(CLF))
    for k, v in sigs.items():
        c[k]['system_sig'] = v
    return c


OPEN = {'main': 'You are the main agent', 'task': 'You are a task agent', 'plan': 'You are a planning agent', 'explore': 'You are an explorer'}
TEST_CLF = _clf_with({k: cc_calls._sig(v + ' more text') for k, v in OPEN.items()})
TOOLS = [{'name': n, 'input_schema': {'type': 'object'}} for n in ('Agent', 'Bash', 'Edit', 'Read')]


def body(model, kind='main', compaction=False, uid='{"device_id":"x","session_id":"y"}'):
    msgs = [{'role': 'user', 'content': [{'type': 'text', 'text': 'do it'}]}]
    if compaction:
        msgs.append({'role': 'user', 'content': [{'type': 'text', 'text': 'CRITICAL: Respond with TEXT ONLY. Summarise.'}]})
    b = {'model': model, 'max_tokens': 128000, 'messages': msgs, 'metadata': {'user_id': uid}, 'stream': True}
    if kind != 'background':
        b = {'model': model, 'max_tokens': 128000, 'system': _sys(OPEN[kind]), 'tools': TOOLS, 'messages': msgs,
             'metadata': {'user_id': uid}, 'stream': True}
    return b


def post(srv, url, b, headers=None, path='/messages', method='POST', raw=None):
    u = url.split('/', 3)[3]
    data = raw if raw is not None else json.dumps(b).encode()
    c = http.client.HTTPConnection(LOOP, srv.server_address[1], timeout=10)
    h = {'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETAS, 'x-api-key': 'dummy', **(headers or {})}
    if method == 'POST':
        h['content-length'] = str(len(data))
    c.request(method, '/' + u + path + '?beta=true', body=data if method == 'POST' else None, headers=h)
    r = c.getresponse()
    out = r.status, r.read()
    c.close()
    return out


def lines_of(path, n, timeout=5.0):
    """calls.jsonl once it has n lines (the proxy writes a call's record after its response has ended)."""
    import time
    t = time.time()
    while True:
        xs = [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []
        if len(xs) >= n or time.time() - t > timeout:
            return xs
        time.sleep(0.02)


@pytest.fixture
def cc(rig, monkeypatch):  # noqa: F811
    srv, mock, _ = rig()
    monkeypatch.setattr(srv, '_cc_clf', TEST_CLF, raising=False)
    return srv, mock


# ---------------------------------------------------------------- agent env and job config

def test_agent_env_is_exact_and_identical_across_arms_but_the_client_model():
    e = cc_config.agent_env('http://172.17.0.1:8088/r/t1/v1')
    assert e['ANTHROPIC_BASE_URL'] == 'http://172.17.0.1:8088/r/t1' and e['ANTHROPIC_API_KEY'] == hcommon.DUMMY_KEY
    assert e['ANTHROPIC_DEFAULT_HAIKU_MODEL'] == HAIKU and e['ANTHROPIC_DEFAULT_SONNET_MODEL'] == SONNET and e['ANTHROPIC_DEFAULT_OPUS_MODEL'] == OPUS
    assert e['ANTHROPIC_SMALL_FAST_MODEL'] == HAIKU and e['ANTHROPIC_DEFAULT_FABLE_MODEL'] == hcommon.CC_MODELS['fable']
    assert 'CLAUDE_CODE_SUBAGENT_MODEL' not in e and 'DISABLE_NON_ESSENTIAL_MODEL_CALLS' not in e
    assert {k for k, v in e.items() if v == '1'} == set(cc_config.TRAFFIC_OFF)
    assert set(e) == {'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', *cc_config.ALIASES, *cc_config.TRAFFIC_OFF}
    assert [cc_config.client_model(a) for a in 'ABCF'] == [SONNET, SONNET, OPUS, HAIKU]
    for bad in ('https://172.17.0.1:8088/r/t1', 'http://172.17.0.1:8088/v1'):
        with pytest.raises(ValueError):
            cc_config.agent_env(bad)


def test_scrub_drops_credentials_selectors_and_proxies_in_any_case():
    base = {'PATH': '/bin', 'ANTHROPIC_API_KEY': 'real', 'CLAUDE_CODE_OAUTH_TOKEN': 't', 'CLAUDE_CODE_USE_BEDROCK': '1', 'AWS_BEARER_TOKEN_BEDROCK': 'b',
            'AWS_SECRET_ACCESS_KEY': 's', 'https_proxy': 'http://p', 'HTTP_PROXY': 'http://p', 'no_proxy': 'x', 'CLAUDE_CODE_SUBAGENT_MODEL': 'm'}
    out = harbor_job_cc.harbor_env(base)
    assert set(out) == {'PATH', 'HARBOR_TELEMETRY', 'PYTHONPATH'}


def test_job_config_per_arm(tmp_path):
    tid = uuid.uuid4().hex
    url = f'http://172.17.0.1:8088/r/{tid}/v1'
    for arm, model in (('A', SONNET), ('B', SONNET), ('C', OPUS), ('F', HAIKU)):
        j = harbor_job_cc.job_config(arm=arm, trial_id=tid, task_dir=tmp_path / 't', jobs_dir=tmp_path / 'j', job_name=tid, base_url=url,
                                     glibc=tmp_path / 'g', musl=tmp_path / 'm', wrapper=tmp_path / 'w')
        a = j['agents'][0]
        assert a['import_path'] == 'cc_agent:LlmarClaudeCode' and a['model_name'] == model and a['skip_model_parsing'] is True
        assert a['kwargs'] == {'version': '2.1.318', 'reasoning_effort': 'high', 'disable_web_search': True}
        assert a['env'] == {cc_config.BASE_URL_ENV: url} and a['extra_allowed_hosts'] == ['172.17.0.1']
        assert [m['target'] for m in j['environment']['mounts']] == ['/opt/llmar/claude/glibc', '/opt/llmar/claude/musl', '/usr/local/bin/claude']
        assert all(m['read_only'] for m in j['environment']['mounts']) and j['retry'] == {'max_retries': 0}
    assert 'exec "$d/$b" "$@"' in harbor_job_cc.WRAPPER_TEXT and harbor_job_cc.WRAPPER_TEXT.startswith('#!/bin/sh\n')


def test_pins_have_both_x64_builds_and_no_bare_12_digit_runs():
    assert set(hcommon.CLAUDE_CODE['sha256']) >= {'linux-x64', 'linux-x64-musl'}
    assert all(re.fullmatch(r'[0-9a-f]{64}', v) for v in hcommon.CLAUDE_CODE['sha256'].values())
    assert hcommon.claude_bin('linux-x64-musl').name == 'claude-2.1.318-linux-x64-musl'


# ---------------------------------------------------------------- calls: classifier, roles, rewrite, sanitize

def test_frozen_classifier_matches_native_roles_and_its_hash():
    raw = cc_calls.NATIVE_ROLES.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == '89f7e8c0908dd81855ec90f2fb62240cc160499df595d9fa2ae94be84807ba93'
    doc = json.loads(raw)
    assert {r for r, v in doc['roles'].items() if v['requested'] == 'M'} == {'main', 'task', 'plan', 'explore', 'compaction'}


@pytest.mark.parametrize('kind,agent,compaction,want_type,want_struct', [
    ('main', False, False, 'main', 'main'), ('main', False, True, 'compaction', 'main'), ('task', True, False, 'task', 'main_subagent'),
    ('plan', True, False, 'plan', 'main_subagent'), ('explore', True, False, 'explore', 'main_subagent'),
    ('background', False, False, 'background', 'helper'), ('task', False, False, 'unknown', None), ('main', True, False, 'unknown', None)])
def test_call_types(kind, agent, compaction, want_type, want_struct):
    h = {'x-claude-code-agent-id': 'a1'} if agent else {}
    r = cc_calls.roles(h, body(SONNET, kind, compaction), SONNET, TEST_CLF)
    assert (r['call_type'], r['call_role_struct']) == (want_type, want_struct)
    assert r['lineage'] == ('subagent' if agent else 'root')


def test_model_roles_and_the_F_rule():
    h_sub = {'x-claude-code-agent-id': 'a1'}
    assert cc_calls.roles({}, body(SONNET), SONNET, TEST_CLF)['call_role'] == 'main'
    assert cc_calls.roles(h_sub, body(SONNET, 'explore'), SONNET, TEST_CLF)['call_role'] == 'main_subagent'
    assert cc_calls.roles(h_sub, body(HAIKU, 'explore'), SONNET, TEST_CLF)['call_role'] == 'helper'
    assert cc_calls.roles({}, body(OPUS), SONNET, TEST_CLF)['call_role'] is None
    # F: the model cannot tell roles apart; the structural role is used (null when the structure is unknown)
    assert cc_calls.roles(h_sub, body(HAIKU, 'explore'), HAIKU, TEST_CLF)['call_role'] == 'main_subagent'
    assert cc_calls.roles({}, body(HAIKU, 'background'), HAIKU, TEST_CLF)['call_role'] == 'helper'
    assert cc_calls.roles({}, body(HAIKU, 'task'), HAIKU, TEST_CLF)['call_role'] is None


def test_sanitized_mirrors_the_router_constants():
    ts = (hcommon.HERE.parents[1] / 'packages' / 'router' / 'src' / 'bedrock-compat.ts').read_text()
    assert re.search(r"BEDROCK_BETA_STRIP[^=]*= \[([^\]]*)\]", ts).group(1).replace("'", '').split(', ') == list(cc_calls.BEDROCK_BETA_STRIP)
    assert "/^[A-Za-z0-9_-]{1,256}$/" in ts and cc_calls.USER_ID_SAFE.pattern == '^[A-Za-z0-9_-]{1,256}$'
    assert cc_calls.sanitized({'anthropic-beta': BETAS}, body(SONNET)) == ['user_id', 'beta:advanced-tool-use-2025-11-20']
    assert cc_calls.sanitized({'anthropic-beta': 'claude-code-20250219'}, body(SONNET, uid='ab' * 32)) == []


def test_splice_top_level_is_byte_exact():
    raw = b'{ "metadata":{"model":"inner"}, "model" :  "global.anthropic.claude-sonnet-5-5","x":"caf\\u00e9 \xe2\x98\x95"}'
    out = cc_calls.splice_top_level(raw, 'model', '"auto"')
    assert out == raw.replace(b'"global.anthropic.claude-sonnet-5-5"', b'"auto"')
    with pytest.raises(ValueError):
        cc_calls.splice_top_level(b'{"a":1}', 'model', '"auto"')
    with pytest.raises(ValueError):
        cc_calls.splice_top_level(b'{"model":"a","model":"b"}', 'model', '"auto"')


# ---------------------------------------------------------------- pricing

def test_anthropic_pricing_split_writes_long_context_and_unknown():
    u = {'input_tokens': 10, 'cache_read_input_tokens': 1000, 'cache_creation_input_tokens': 300,
         'cache_creation': {'ephemeral_5m_input_tokens': 100, 'ephemeral_1h_input_tokens': 150}, 'output_tokens': 20}
    n = cc_pricing.normalize(u)
    assert n == {'prompt': 1310, 'uncached': 10, 'read': 1000, 'write': 300, 'write_5m': 150, 'write_1h': 150, 'output': 20, 'reasoning': 0}
    c = cc_pricing.cost(SONNET, u)
    assert c['usd'] == pytest.approx((10 * 2 + 1000 * 0.1 + 150 * 2.5 + 150 * 4 + 20 * 10) / 1e6) and c['long'] is False
    big = {'input_tokens': 100_001, 'output_tokens': 1}
    assert cc_pricing.cost(HAIKU, big)['long'] is True
    assert cc_pricing.cost(HAIKU, big)['usd'] == pytest.approx((100_001 * 0.5 + 2.5) / 1e6)
    assert cc_pricing.cost('claude-unknown', {'input_tokens': 1_000_000})['priced_as'] == OPUS
    assert cc_pricing.cost(None, {'input_tokens': 1, 'cache_creation_input_tokens': 4})['usd'] == pytest.approx((1 * 4 + 4 * 5) / 1e6)


def test_worst_case_prices_the_prompt_at_the_largest_write_rate():
    assert cc_pricing.worst(OPUS, 1000, 16_000) == pytest.approx((1000 * 8 + 16_000 * 20) / 1e6)
    assert cc_pricing.worst(HAIKU, 200_000, 0) == pytest.approx(200_000 * 1.0 / 1e6)
    assert cc_pricing.body_max_tokens({'max_tokens': 128000}) == 128000 and cc_pricing.body_max_tokens({}) == 16_000
    assert cc_pricing.body_max_tokens({'max_tokens': 999_999}) == 128_000


# ---------------------------------------------------------------- proxy round trips (RunnerProxy + mock router)

def test_every_call_goes_up_as_auto_pinned_to_its_own_model_except_B_main(cc, tmp_path):
    """The gateway routes only auto / auto:* to the router (infra RouteAuto); a concrete model would go to its fallback.
    So the bytes sent are the client's with the model replaced by "auto", and only the hint differs by arm."""
    srv, mock = cc
    sent = json.dumps(body(SONNET)).encode()
    up = sent.replace(b'"global.anthropic.claude-sonnet-5-5"', b'"auto"')
    urls = {arm: srv.register_trial(uuid.uuid4().hex, arm, spec=spec(arm)) for arm in 'ABCF'}
    for arm, url in urls.items():
        st, _ = post(srv, url, None, raw=sent.replace(b'"global.anthropic.claude-sonnet-5-5"', json.dumps(cc_config.client_model(arm)).encode()))
        assert st == 200
    seen = {s['session']: s for s in mock.seen}
    tid = {arm: url.split('/r/')[1].split('/')[0] for arm, url in urls.items()}
    assert all(seen[tid[a]]['raw'] == up for a in 'ABCF')
    assert {a: seen[tid[a]]['hint'] for a in 'ABCF'} == {'A': f'pin={SONNET}', 'B': '', 'C': f'pin={OPUS}', 'F': f'pin={HAIKU}'}
    assert all(not s['leaked'] for s in mock.seen)
    assert all(s['path'] == '/inference/v1/messages' for s in mock.seen)
    assert all(s['beta'] == BETAS and s['version'] == '2023-06-01' for s in mock.seen)   # the router strips betas, not the proxy
    lines = lines_of(tmp_path / 'calls.jsonl', 4)
    by = {x['trial_id']: x for x in lines}
    assert by[tid['B']]['rewritten'] is True and by[tid['B']]['pin'] is None and by[tid['B']]['requested_model'] == SONNET
    assert by[tid['B']]['served_model'] == SONNET
    for a, m in (('A', SONNET), ('C', OPUS), ('F', HAIKU)):
        x = by[tid[a]]
        assert (x['rewritten'], x['pin'], x['requested_model'], x['served_model'], x['via_router'], x['origin']) == (False, m, m, m, True, None)
    for x in lines:
        assert x['call_role'] == 'main' and x['call_role_struct'] == 'main' and x['call_type'] == 'main' and x['lineage'] == 'root'
        assert x['sanitized'] == ['user_id', 'beta:advanced-tool-use-2025-11-20'] and x['stop_reason'] == 'end_turn'
        assert x['usage']['write_1h'] == 1000 and x['cost_usd'] > 0


def test_helper_calls_are_pinned_to_the_model_they_name(cc, tmp_path):
    srv, mock = cc
    for arm in 'AB':
        t = uuid.uuid4().hex
        url = srv.register_trial(t, arm, spec=spec(arm))
        assert post(srv, url, body(HAIKU, 'background'))[0] == 200
        assert mock.seen[-1]['model'] == 'auto' and mock.seen[-1]['hint'] == f'pin={HAIKU}'
        s = srv.unregister_trial(t)
        assert s['calls_by_role']['helper']['served_models'] == {HAIKU: 1} and s['pinned_calls'] == 1 and s['pin_served_other'] == 0


FALLBACK_400 = b'{"message":"Request metadata contains a value that violates the regular expression"}'
FALLBACK_403 = b'{"type":"error","error":{"type":"permission_error","message":"not authorized"}}'


@pytest.mark.parametrize('mode,status,body_,want', [('serve', 200, None, True), ('fail', 400, FALLBACK_400, True), ('fail', 403, FALLBACK_403, True),
                                                    ('fail', 502, b'{"message":"bad gateway"}', True), ('fail', 401, b'{"message":"Unauthorized"}', False),
                                                    ('fail', 429, b'{"message":"Too many requests"}', False)])
def test_a_response_without_router_headers_is_gateway_fallback(cc, tmp_path, mode, status, body_, want):
    """Answered without the router (the gateway's fallback after a router 5xx): gateway_fallback, origin
    'gateway-fallback', whatever the body's shape; the gateway's own 401/429 stay 'gateway'."""
    srv, mock = cc
    if mode == 'serve':
        mock.anthropic_fallback = 'serve'
    else:
        mock.fail_status, mock.fail_body = status, body_
    t = uuid.uuid4().hex
    url = srv.register_trial(t, 'C', spec=spec('C'))
    for _ in range(2 if status == 401 else 1):          # a 401 drops the token; Claude Code would retry
        assert post(srv, url, body(OPUS))[0] == status
    x = lines_of(tmp_path / 'calls.jsonl', 1)[-1]
    assert x['via_router'] is False and x['gateway_fallback'] is want and x['origin'] == ('gateway-fallback' if want else 'gateway')
    s = srv.unregister_trial(t)
    assert s['gateway_fallback_calls'] == (1 if want else 0) and s['last_call']['ok'] is False


def test_the_routers_own_error_stays_router(cc, tmp_path):
    srv, mock = cc
    mock.fail_status, mock.fail_body = 400, b'{"error": "model not allowed", "code": "pin-not-allowed"}'
    url = srv.register_trial(uuid.uuid4().hex, 'A', spec=spec('A'))
    assert post(srv, url, body(SONNET))[0] == 400
    x = lines_of(tmp_path / 'calls.jsonl', 1)[-1]
    assert x['origin'] == 'router' and x['gateway_fallback'] is False


def test_codex_routes_keep_their_static_hint_and_origins(cc, tmp_path):
    srv, _ = cc
    url = srv.register_trial(uuid.uuid4().hex, 'A')
    assert hproxy.origin({'status': 200, 'via_router': False}) is None
    assert hproxy.origin({'status': 400, 'via_router': False, 'error_shape': 'message'}) == 'gateway'
    assert hproxy.origin({'status': 400, 'via_router': False, 'error_shape': 'error-object'}) == 'upstream'
    assert url.endswith('/v1')


def test_summary_split_by_role_and_cost_sums_to_the_ledger(cc):
    srv, _ = cc
    t = uuid.uuid4().hex
    url = srv.register_trial(t, 'A', spec=spec('A'))
    sub = {'x-claude-code-agent-id': 'agent-1'}
    for b, h in ((body(SONNET), {}), (body(SONNET, 'explore'), sub), (body(HAIKU, 'background'), {}), (body(SONNET, compaction=True), {})):
        assert post(srv, url, b, headers=h)[0] == 200
    s = srv.unregister_trial(t)
    r = s['calls_by_role']
    assert (r['main']['calls'], r['main_subagent']['calls'], r['helper']['calls']) == (2, 1, 1)
    assert r['helper']['served_models'] == {HAIKU: 1} and r['main']['last_call']['ok'] is True
    assert sum(v['cost_usd'] for v in r.values()) == pytest.approx(s['spent_usd'], abs=1e-6)
    assert s['call_types'] == {'main': 1, 'explore': 1, 'background': 1, 'compaction': 1} and s['roles_null'] == 0
    assert s['sanitized_requests'] == 4 and s['rewritten_calls'] == 0 and s['role_agreement'] == {'n': 4, 'agree': 4}
    assert s['pinned_calls'] == 4 and s['pin_served_other'] == 0 and s['gateway_fallback_calls'] == 0
    assert s['tokens_by_model'][SONNET]['calls'] == 3


def test_refusals_local_answers_and_codex_routes_unchanged(cc, tmp_path):
    srv, mock = cc
    url = srv.register_trial(uuid.uuid4().hex, 'F', spec=spec('F'))
    n = len(mock.seen)
    assert post(srv, url, body(hcommon.CC_MODELS['fable']))[0] == 403          # not a pool model: refused loudly
    assert post(srv, url, body('auto'))[0] == 403                              # the client never names auto itself
    assert post(srv, url, body('auto:fast'))[0] == 403
    st, b = post(srv, url, body(HAIKU), path='/messages/count_tokens')
    assert st == 404 and json.loads(b)['error']['type'] == 'not_found_error'
    st, b = post(srv, url, None, path='/models', method='GET')
    assert st == 200 and {m['id'] for m in json.loads(b)['data']} == set(cc_calls.POOL)
    assert post(srv, url, body(HAIKU), path='/responses')[0] == 405           # an Anthropic route serves no Responses call
    assert len(mock.seen) == n
    codex = srv.register_trial(uuid.uuid4().hex, 'A')
    assert post(srv, codex, body(HAIKU))[0] == 404                             # a Codex route has no Messages path


def test_count_tokens_is_tagged_as_an_auxiliary_call_and_models_is_not(cc, tmp_path):
    """0d §16 (Amendment 7): count_tokens is answered 404 here, never forwarded, and tagged call_type count_tokens with
    the non-model marker in call_role / call_role_struct; no body field is stored (7.5). GET models stays untagged (7.3).
    The model-call summary is unchanged."""
    srv, mock = cc
    t = uuid.uuid4().hex
    url = srv.register_trial(t, 'A', spec=spec('A'))
    n = len(mock.seen)
    assert post(srv, url, body(SONNET), path='/messages/count_tokens?beta=true')[0] == 404
    assert post(srv, url, None, path='/models', method='GET')[0] == 200
    assert post(srv, url, body(SONNET))[0] == 200
    assert len(mock.seen) == n + 1                                              # only the Messages call went up
    recs = {x['leaf']: x for x in lines_of(tmp_path / 'calls.jsonl', 3) if x.get('trial_id') == t}
    ct = recs['messages/count_tokens']
    assert ct['local'] is True and ct['method'] == 'POST' and ct['status'] == 404 and ct['origin'] == 'gateway'
    assert ct['call_type'] == 'count_tokens' and ct['call_role'] == ct['call_role_struct'] == cc_calls.NON_MODEL
    body_keys = {'requested_model', 'served_model', 'req_bytes', 'input_items', 'system_sig', 'tools_sig', 'n_tools',
                 'sanitized', 'stream', 'usage', 'cost_usd', 'pin', 'est_prompt_tokens', 'reserved_usd'}
    assert not body_keys & set(ct)
    assert 'Count' not in json.dumps(ct) and 'device_id' not in json.dumps(ct)
    assert recs['models'].get('call_type') is None and recs['models'].get('call_role') is None
    assert recs['messages']['call_role'] == 'main' and recs['messages']['call_type'] == 'main'
    s = srv.unregister_trial(t)
    assert s['calls'] == 1 and s['roles_null'] == 0 and s['call_types'] == {'main': 1}


@pytest.mark.parametrize('change', [{'status': 200}, {'status': 400}, {'origin': None}, {'via_router': True},
                                    {'cost_usd': 0.01}, {'usage': {'prompt': 5}}, {'method': 'GET'}, {'leaf': 'messages'}])
def test_count_tokens_outside_the_predicate_stays_untagged(change):
    ok = {'method': 'POST', 'leaf': 'messages/count_tokens', 'status': 404, 'origin': 'gateway', 'local': True}
    assert hproxy.count_tokens_aux(ok)
    assert not hproxy.count_tokens_aux({**ok, **change})


def test_reservation_uses_the_worst_model_and_max_tokens(cc, tmp_path):
    srv, _ = cc
    url = srv.register_trial(uuid.uuid4().hex, 'B', spec=spec('B'))
    assert post(srv, url, body(SONNET))[0] == 200
    assert post(srv, url, body(HAIKU, 'background'))[0] == 200
    ev = [json.loads(x) for x in (tmp_path / 'cap-events.jsonl').read_text().splitlines() if '"admit"' in x]
    calls = lines_of(tmp_path / 'calls.jsonl', 2)
    b, h = calls[0], calls[1]
    assert b['reserved_usd'] == pytest.approx(cc_pricing.worst(OPUS, b['est_prompt_tokens'], 128000), abs=1e-6)
    assert h['reserved_usd'] == pytest.approx(cc_pricing.worst(HAIKU, h['est_prompt_tokens'], 128000), abs=1e-6)
    assert len(ev) == 2


def test_register_refuses_hints_and_bad_specs(cc):
    srv, _ = cc
    with pytest.raises(ValueError):
        srv.register_trial(uuid.uuid4().hex, 'A', spec={**spec('A'), 'hint': f'pin={SONNET}'})
    with pytest.raises(ValueError):
        srv.register_trial(uuid.uuid4().hex, 'A', spec={**spec('A'), 'client_model': 'auto'})
    with pytest.raises(ValueError):
        srv.register_trial(uuid.uuid4().hex, 'A', spec={'client_model': SONNET})


def test_anthropic_sse_tap_overlays_usage_and_survives_crlf_and_splits():
    tap = hproxy.AnthropicSseTap()
    evs = [{'type': 'message_start', 'message': {'id': 'm', 'model': SONNET, 'usage': {'input_tokens': 5, 'cache_read_input_tokens': 7, 'output_tokens': 1}}},
           {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 9, 'input_tokens': None}},
           {'type': 'message_stop'}]
    data = ''.join(f"event: {e['type']}\r\ndata: {json.dumps(e)}\r\n\r\n" for e in evs).encode()
    for i in range(0, len(data), 7):
        tap.feed(data[i:i + 7])
    tap.close()
    assert tap.out['usage'] == {'input_tokens': 5, 'cache_read_input_tokens': 7, 'output_tokens': 9}
    assert tap.out['stop_reason'] == 'tool_use' and tap.out['terminal'] == 'message_stop' and tap.out['model'] == SONNET
    t2 = hproxy.AnthropicSseTap()
    t2.feed(b'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n')
    assert t2.out['error_code'] == 'overloaded_error'


def test_codex_proxy_constants_are_unchanged():
    assert px.FORWARD_REQUEST_HEADERS == ('content-type', 'accept', 'user-agent', 'openai-beta')
    assert px.ROUTE_LEAVES['openai-responses'] == (('POST', 'responses'), ('GET', 'models'))
    assert pathlib.Path(px.__file__).name == 'proxy.py'
