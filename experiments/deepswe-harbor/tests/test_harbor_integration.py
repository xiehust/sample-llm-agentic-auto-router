"""Harbor integration and host proxy (design §4–5): config, job, cap ledger, proxy round trips against the mock
router, token refresh, cap stop, error origins, harvest rows. No network beyond loopback, no Docker, no AWS."""
import http.client
import json
import pathlib
import time
import uuid

import pytest

import hcommon  # noqa: F401
import auth
import codex_config
import harbor_job
import harvest
import hproxy
import mock_upstream
import proxy as px

LOOP = '127.0.0.1'


# ---------------------------------------------------------------- Codex config and Harbor job

def test_codex_config_same_for_every_arm_and_pinned_settings():
    url = 'http://172.17.0.1:8088/r/abc/v1'
    c = codex_config.config(url)
    assert c['model'] == 'auto' and c['model_provider'] == 'llmar'
    p = c['model_providers']['llmar']
    assert p['base_url'] == url and p['wire_api'] == 'responses' and p['env_key'] == hcommon.DUMMY_KEY_ENV
    assert 'http_headers' not in p and 'env_http_headers' not in p   # the arm exists only on the proxy route
    assert c['model_context_window'] == 272_000 and c['model_auto_compact_token_limit'] == 200_000
    assert 'model_reasoning_effort' not in c and 'web_search' not in c   # Harbor sets these (-c effort=high)
    assert c['features']['multi_agent'] is False and c['project_doc_max_bytes'] == 0
    assert codex_config.EFFORT == 'high'


@pytest.mark.parametrize('bad', ['https://172.17.0.1:8088/r/x/v1', 'http://example.com:8088/r/x/v1', 'http://8.8.8.8:8088/r/x/v1',
                                 'http://172.17.0.1/r/x/v1', 'http://172.17.0.1:8088/v1'])
def test_codex_config_refuses_anything_but_a_private_proxy_route(bad):
    with pytest.raises(ValueError):
        codex_config.config(bad)


def test_job_config_for_one_trial(tmp_path):
    tid = uuid.uuid4().hex
    bin_ = tmp_path / 'codex'
    j = harbor_job.job_config(arm='B', trial_id=tid, task_dir=tmp_path / 't', jobs_dir=tmp_path / 'jobs', job_name=tid,
                              base_url=f'http://172.17.0.1:8088/r/{tid}/v1', codex_bin=bin_)
    assert j['n_concurrent_trials'] == 1 and j['retry'] == {'max_retries': 0} and j['n_attempts'] == 1
    a = j['agents'][0]
    assert a['name'] == 'codex' and a['model_name'] == 'auto' and a['skip_model_parsing'] is True
    assert a['kwargs']['version'] == '0.166.0' and a['kwargs']['reasoning_effort'] == 'high'
    assert a['extra_allowed_hosts'] == ['172.17.0.1']
    assert a['env'] == {hcommon.DUMMY_KEY_ENV: hcommon.DUMMY_KEY}
    env = j['environment']
    assert env['mounts'] == [{'type': 'bind', 'source': str(bin_), 'target': '/usr/local/bin/codex', 'read_only': True}]
    assert not any(k.startswith('override_') for k in env)   # never override the task's CPU/memory/storage
    assert j['tasks'] == [{'path': str(tmp_path / 't')}]
    with pytest.raises(ValueError):
        harbor_job.job_config(arm='B', trial_id=tid, task_dir=tmp_path, jobs_dir=tmp_path, job_name=tid,
                              base_url='http://172.17.0.1:8088/r/other/v1', codex_bin=bin_)
    with pytest.raises(ValueError):
        harbor_job.job_config(arm='D', trial_id=tid, task_dir=tmp_path, jobs_dir=tmp_path, job_name=tid,
                              base_url=f'http://172.17.0.1:8088/r/{tid}/v1', codex_bin=bin_)
    assert harbor_job.environment_config() == {'import_path': 'llmar_env:LlmarDockerEnvironment', 'delete': True}
    env = harbor_job.harbor_env({'PATH': '/bin', 'OPENAI_API_KEY': 'k', 'CODEX_FORCE_AUTH_JSON': '1', 'AWS_SECRET_ACCESS_KEY': 's',
                                 'AWS_PROFILE': 'p', 'LLMAR_X': 'y'})
    assert env['PATH'] == '/bin' and env['HARBOR_TELEMETRY'] == '0' and env['PYTHONPATH'].endswith('deepswe-harbor')
    assert not any(k.startswith(('OPENAI', 'CODEX', 'AWS', 'LLMAR')) for k in env)
    # Nothing secret in the job file: the token stays in the proxy.
    assert 'tok' not in json.dumps(j).lower().replace('token_limit', '')


# ---------------------------------------------------------------- cap ledger

def _ledger(tmp_path, cap=1.0, reserve=0.0, **kw):
    return hproxy.make_ledger(tmp_path, cap_usd=cap, reserve_usd=reserve, **kw)


def test_cap_counts_inflight_reservations_and_stops_for_good(tmp_path):
    led = _ledger(tmp_path, cap=1.0)
    a = led.admit('t1', 0.4)
    b = led.admit('t2', 0.4)
    assert a and b
    assert led.admit('t3', 0.3) is None            # 0.8 in flight + 0.3 > 1.0
    assert led.stopped and 'cap' in led.stopped
    led.settle(a.call_id, 0.01)
    assert led.admit('t3', 0.01) is None           # sticky: refused even though it would fit now
    state = json.loads((tmp_path / 'proxy-state.json').read_text())
    assert state['stopped'] and state['inflight'] == 1


def test_cap_reserve_and_runner_hours(tmp_path):
    clock = [1000.0]
    led = _ledger(tmp_path, cap=10.0, reserve=2.0, runner_usd_per_hour=3.6, runner_started_at=0.0, clock=lambda: clock[0])
    assert led.runner_usd() == pytest.approx(1.0)
    assert led.admit('t', 6.9)                      # 1.0 + 6.9 ≤ 8.0
    assert led.admit('t', 0.2) is None              # 8.1 > 10 − 2


def test_crash_replay_charges_the_worst_case_of_open_calls(tmp_path):
    led = _ledger(tmp_path, cap=100.0)
    a = led.admit('t', 2.5)
    b = led.admit('t', 1.0)
    led.settle(b.call_id, 0.25)
    assert a is not None
    led2 = _ledger(tmp_path, cap=100.0)            # restart without a settle for `a`
    assert led2.settled == pytest.approx(2.75) and led2.crash_charged == pytest.approx(2.5)
    led3 = _ledger(tmp_path, cap=100.0)            # the crash charge is logged once, not re-derived
    assert led3.settled == pytest.approx(2.75)


def test_stop_survives_restart_until_an_operator_unstops(tmp_path):
    led = _ledger(tmp_path, cap=1.0)
    assert led.admit('t', 2.0) is None
    led2 = _ledger(tmp_path, cap=5.0)
    assert led2.stopped and led2.admit('t', 0.1) is None
    led2.unstop('cap raised by 0c')
    assert led2.admit('t', 0.1) is not None
    assert _ledger(tmp_path, cap=5.0).stopped is None


# ---------------------------------------------------------------- proxy round trips against the mock router

def _minter(ttl, clock=time.time):
    n = {'i': 0}

    def post(_u, _d, _h):
        n['i'] += 1
        return 200, json.dumps({'access_token': f'tok-{n["i"]}', 'expires_in': ttl}).encode()
    return auth.TokenMinter({'client_id': 'a', 'client_secret': 'b', 'token_url': 'https://x.invalid/oauth2/token', 'scope': 's'},
                            post=post, clock=clock), n


@pytest.fixture
def rig(tmp_path):
    made = []

    def make(cap=50.0, ttl=3600, **mock_kw):
        mock, _ = mock_upstream.serve(0, **mock_kw)
        port = mock.server_address[1]
        ups = px.Upstreams('https://gateway.test.invalid', 'ap-southeast-1',
                           connect=lambda _h, _ip, t: http.client.HTTPConnection(LOOP, port, timeout=t),
                           resolver=lambda *a, **k: [(2, 1, 6, '', ('203.0.113.10', 443))])
        minter, count = _minter(ttl)
        srv = hproxy.RunnerProxy(LOOP, 0, ups, _ledger(tmp_path, cap=cap), hproxy.SharedToken(minter), tmp_path, allow_loopback_bind=True,
                                 require_host=None)
        hproxy.serve_in_thread(srv)
        made.append((srv, mock))
        return srv, mock, count
    yield make
    for srv, mock in made:
        srv.shutdown()
        srv.server_close()
        mock.shutdown()


def _post(srv, base_url, body=None, headers=None):
    u = base_url.split('/', 3)[3]
    c = http.client.HTTPConnection(LOOP, srv.server_address[1], timeout=10)
    data = json.dumps(body or {'model': 'auto', 'stream': True, 'input': [{'type': 'message', 'role': 'user', 'content': 'x'}],
                               'tools': [{'type': 'function', 'name': 'exec_command'}]}).encode()
    c.request('POST', '/' + u + '/responses', body=data, headers={'content-type': 'application/json', 'content-length': str(len(data)), **(headers or {})})
    r = c.getresponse()
    out = r.status, r.read()
    c.close()
    return out


def test_router_session_is_the_trial_id_and_the_hint_follows_the_arm(rig, tmp_path):
    srv, mock, _ = rig()
    ids = {arm: uuid.uuid4().hex for arm in hcommon.ARMS}
    for arm, tid in ids.items():
        url = srv.register_trial(tid, arm)
        # Whatever the client claims, the proxy sets the router headers.
        st, _ = _post(srv, url, headers={'x-router-session': 'spoofed', 'x-router-hint': 'pin=global.openai.gpt-6-astra'})
        assert st == 200
    seen = {s['session']: s['hint'] for s in mock.seen}
    assert set(seen) == set(ids.values())
    for arm, tid in ids.items():
        pin = hcommon.ARM_PIN[arm]
        assert seen[tid] == (f'pin={pin}' if pin else '')
    lines = [json.loads(x) for x in (tmp_path / 'calls.jsonl').read_text().splitlines()]
    assert all({'trial_id', 'status', 'origin', 'served_model'} <= set(x) for x in lines)
    assert {x['served_model'] for x in lines if x['arm'] == 'F'} == {hcommon.ARM_PIN['F']}
    s = srv.unregister_trial(ids['B'])
    for k in ('statuses', 'error_origins', 'last_call', 'cap_stopped', 'auth_errors', 'token_invalidations', 'refused', 'calls',
              'spent_usd', 'served_models', 'throttled', 'tokens_by_model'):
        assert k in s
    assert s['statuses'] == {'200': 1} and s['last_call']['ok'] is True and s['last_failure'] is None
    assert s['tokens_by_model'][mock_upstream.SOL]['calls'] == 1 and s['spent_usd'] > 0
    # Unregistered: the next call is refused (unknown run), and nothing reaches the router.
    n = len(mock.seen)
    st, _ = _post(srv, f'http://{LOOP}:0/r/{ids["B"]}/v1')
    assert st == 404 and len(mock.seen) == n


def test_body_model_must_be_auto_and_bad_paths_are_refused(rig):
    srv, mock, _ = rig()
    url = srv.register_trial(uuid.uuid4().hex, 'A')
    st, body = _post(srv, url, body={'model': 'global.openai.gpt-6-astra', 'input': []})
    assert st == 403 and b'model-not-allowed' in body
    c = http.client.HTTPConnection(LOOP, srv.server_address[1], timeout=5)
    c.request('GET', '/v1/models')
    assert c.getresponse().status == 404
    assert mock.seen == []


def test_token_is_shared_reminted_before_expiry_and_dropped_after_a_401(rig):
    srv, mock, count = rig(ttl=3600, reject_tokens={'tok-1'})
    url = srv.register_trial(uuid.uuid4().hex, 'A')
    st, _ = _post(srv, url)
    assert st == 401                                # tok-1 rejected upstream → invalidated
    st, _ = _post(srv, url)
    assert st == 200 and count['i'] == 2            # the retry minted tok-2
    url2 = srv.register_trial(uuid.uuid4().hex, 'C')
    assert _post(srv, url2)[0] == 200 and count['i'] == 2   # shared by trials
    s = srv.unregister_trial(url.split('/')[4])
    assert s['token_invalidations'] == 1 and s['statuses'] == {'401': 1, '200': 1}
    assert s['last_failure'] is None or s['last_failure']['status'] == 401


def test_token_reminted_when_close_to_expiry():
    clock = [0.0]
    minter, count = _minter(ttl=600, clock=lambda: clock[0])
    tok = hproxy.SharedToken(minter, clock=lambda: clock[0])
    assert tok() == 'tok-1'
    clock[0] = 600 - 121
    assert tok() == 'tok-1'
    clock[0] = 600 - 119
    assert tok() == 'tok-2' and count['i'] == 2
    assert 'tok-' not in repr(tok)


def test_cap_stop_refuses_every_trial_without_forwarding(rig):
    srv, mock, _ = rig(cap=0.3)                     # A's call reserves ~$0.24 (Sol, 16k output); C's (Astra) cannot fit
    a = srv.register_trial(uuid.uuid4().hex, 'A')
    b = srv.register_trial(uuid.uuid4().hex, 'C')   # Astra: the worst case does not fit
    assert _post(srv, a)[0] == 200
    st, body = _post(srv, b)
    assert st == 429 and b'budget' in body
    n = len(mock.seen)
    assert _post(srv, a)[0] == 429 and len(mock.seen) == n
    sa = srv.unregister_trial(a.split('/')[4])
    assert sa['cap_stopped'] and sa['refused'].get('budget') == 1 and sa['last_call']['origin'] == 'proxy'
    assert srv.summary()['stopped']


@pytest.mark.parametrize('kw,origin', [
    ({'fail_status': 503, 'fail_body': b'{"error": "no eligible model"}'}, 'router'),
    ({'fail_status': 429, 'fail_body': b'{"error": {"code": "throttled", "message": "x"}}', 'fail_router_headers': True}, 'upstream'),
    ({'fail_status': 500, 'fail_body': b'{"error": {"type": "server_error"}}'}, 'upstream'),
    ({'fail_status': 504, 'fail_body': b'{"message": "Endpoint request timed out"}'}, 'gateway'),
])
def test_error_origins(rig, kw, origin):
    srv, _, _ = rig(**kw)
    tid = uuid.uuid4().hex
    url = srv.register_trial(tid, 'A')
    st, _ = _post(srv, url)
    assert st == kw['fail_status']
    s = srv.unregister_trial(tid)
    assert s['error_origins'] == {origin: 1}
    assert {k: s['last_call'][k] for k in ('status', 'origin', 'ok')} == {'status': st, 'origin': origin, 'ok': False}
    assert s['last_failure']['status'] == st and s['last_failure']['origin'] == origin
    assert s['throttled'] == (1 if st == 429 else 0)


def test_origin_of_proxy_and_transport_failures():
    assert hproxy.origin({'refused': 'budget', 'status': 429}) == 'proxy'
    assert hproxy.origin({'error': 'AuthError', 'status': 502}) == 'proxy'
    assert hproxy.origin({'error': 'TimeoutError', 'status': 502}) == 'transport'
    assert hproxy.origin({'status': 200}) is None
    assert hproxy.origin({'status': 200, 'terminal': 'response.failed'}) == 'upstream'


def test_bind_is_never_unspecified_or_public(tmp_path):
    ups = px.Upstreams(None, 'ap-southeast-1')
    for host in ('0.0.0.0', '8.8.8.8', '127.0.0.1', '10.1.2.3'):   # 10.1.2.3: private, but not the proxy address  # nosec B104: test data, the wildcard host must be refused
        with pytest.raises(px.Refused):
            hproxy.RunnerProxy(host, 0, ups, _ledger(tmp_path), None, tmp_path)


# ---------------------------------------------------------------- harvest

def _trial(root, name, *, reward=1, exc=None, patch=b'diff --git a/x b/x\n'):
    td = root / 'jobs' / name / 'task-a__abc'   # <jobs_dir>/<job_name>/<trial_name>
    (td / 'verifier').mkdir(parents=True)
    (td / 'artifacts' / 'logs' / 'artifacts').mkdir(parents=True)
    if patch is not None:
        (td / 'artifacts' / 'logs' / 'artifacts' / 'model.patch').write_bytes(patch)
    res = {'trial_name': 'task-a__abc', 'agent_info': {'name': 'codex', 'version': '0.166.0'},
           'verifier_result': {'rewards': {'reward': reward}} if reward is not None else None,
           'exception_info': {'exception_type': exc, 'exception_message': 'SECRET TASK TEXT'} if exc else None,
           'started_at': '2026-11-05T00:00:00Z', 'finished_at': '2026-11-05T00:10:00Z',
           'agent_execution': {'started_at': '2026-11-05T00:01:00Z', 'finished_at': '2026-11-05T00:09:00Z'},
           'verifier': {'started_at': '2026-11-05T00:09:00Z', 'finished_at': '2026-11-05T00:09:30Z'}}
    (td / 'result.json').write_text(json.dumps(res))
    if reward is not None:
        (td / 'verifier' / 'reward.json').write_text(json.dumps({'reward': reward, 'f2p_total': 3, 'f2p_passed': 3 * reward, 'note': 'text'}))
    (td / 'verifier' / 'ctrf.json').write_text(json.dumps({'results': {'summary': {'tests': 4, 'passed': 4}, 'tests': [
        {'name': '[f2p] secret_test_name', 'status': 'passed'}, {'name': '[p2p] other', 'status': 'failed', 'message': 'SECRET'}]}}))
    return str(td.relative_to(root))


def _task(root):
    task = root / 'tasks' / 'task-a'
    (task / 'solution').mkdir(parents=True)
    (task / 'task.toml').write_text('[metadata]\nlanguage = "go"\nrepository_url = "https://github.com/o/r"\nbase_commit_hash = "abc"\n')
    (task / 'solution' / 'solution.patch').write_text('diff --git a/src/x.go b/src/x.go\n+a\n-b\ndiff --git a/x_test.go b/x_test.go\n+t\n')
    return task


def _meta(tmp_path, tid, *, cls, action, score, status, is_final=True, attempt=1, rerun_of=None, job_name=None):
    return {'trial_id': tid, 'arm': 'B', 'task': 'task-a', 'phase': 'main', 'pass': 'main', 'rep': 1, 'attempt': attempt,
            'rerun_of': rerun_of, 'class': cls, 'action': action, 'reason': 'r', 'score': score, 'runner': 1, 'shard': 0,
            'block': 3, 'host': {'load1': 1.0}, 'cap_stopped': cls == 'cap_stop', 'pred_tier': 'standard',
            'jobs_dir': str(tmp_path / 'jobs'), 'task_dir': str(tmp_path / 'tasks' / 'task-a'), 'job_name': job_name or tid,
            'agent_job_name': tid, 'is_final': is_final, 'final_status': status if is_final else None}


def _harvest(tmp_path, metas, calls=()):
    (tmp_path / 'meta.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in metas))
    (tmp_path / 'calls.jsonl').write_text(''.join(json.dumps(c) + '\n' for c in calls))
    out = tmp_path / 'rows.jsonl'
    harvest.harvest(tmp_path / 'meta.jsonl', tmp_path / 'calls.jsonl', out)
    return [json.loads(x) for x in out.read_text().splitlines()]


@pytest.mark.parametrize('cls,action,exc,reward,status,score,exit_reason,resolved', [
    ('agent', 'score', None, 1.0, 'scored', 1.0, 'done', True),
    ('agent', 'score', 'AgentTimeoutError', 1.0, 'scored', 1.0, 'timeout', True),     # scored on what was committed
    ('agent', 'score', 'NonZeroAgentExitCodeError', 0.0, 'scored', 0.0, 'error', False),
    ('agent', 'score', None, 0.5, 'scored', 1.0, 'done', True),                       # the classifier's score decides
    ('sut', 'score_zero', None, 1.0, 'scored', 0.0, 'error', False),                 # router failure scores 0
    ('upstream', 'rerun', 'ApiOverloadedError', None, 'excluded', None, 'harness-error', False),
    ('cap_stop', 'exclude', None, None, 'excluded', None, 'budget', False),
    ('cancelled', 'rerun', 'CancelledError', None, 'excluded', None, 'harness-error', False),
])
def test_harvest_takes_the_classifiers_decision(tmp_path, cls, action, exc, reward, status, score, exit_reason, resolved):
    _task(tmp_path)
    _trial(tmp_path, 'f' * 32, reward=reward, exc=exc)
    r, = _harvest(tmp_path, [_meta(tmp_path, 'f' * 32, cls=cls, action=action, score=score, status=status)])
    assert r['exit_reason'] == exit_reason and r['resolved'] is resolved
    assert r['in_comparisons'] is (status == 'scored') and r['final_status'] == status and r['score'] == score
    assert r['run_id'] == r['trial_id'] == 'f' * 32 and r['task_id'] == 'task-a' and r['repo'] == 'o/r' and r['language'] == 'go'
    assert r['solution_lines'] == 2 and r['size_bucket'] == 'small' and r['block'] == 3 and r['host'] == {'load1': 1.0}
    assert r['patch'] == {'bytes': 19, 'empty': False} and r['pred_tier'] == 'standard'
    assert r['timings']['agent_execution'] == 480.0 and r['wall_s'] == 600.0
    text = json.dumps(r)
    assert 'SECRET' not in text and 'secret_test_name' not in text and '"note"' not in text


def test_harvest_pending_key_is_out_of_comparisons(tmp_path):
    _trial(tmp_path, 'a' * 32, reward=None, exc='VerifierTimeoutError')
    r, = _harvest(tmp_path, [_meta(tmp_path, 'a' * 32, cls='verifier_infra', action='reverify', score=None, status=None, is_final=False)])
    assert r['final_status'] == 'pending' and r['exit_reason'] == 'harness-error' and not r['in_comparisons'] and not r['resolved']


def test_harvest_reverified_timeout_keeps_the_original_exception(tmp_path):
    a = 'a' * 32
    _trial(tmp_path, a, reward=None, exc='AgentTimeoutError')
    _trial(tmp_path, f'{a}-rv1-abc123', reward=1)
    r, = _harvest(tmp_path, [_meta(tmp_path, a, cls='agent', action='score', score=1.0, status='scored', job_name=f'{a}-rv1-abc123')])
    assert r['resolved'] and r['exit_reason'] == 'timeout' and r['exit_detail'] == 'AgentTimeoutError'
    assert r['verifier']['reward_json']['reward'] == 1 and r['verifier']['reverified'] and r['timings']['verifier'] == 30.0
    assert r['timings']['agent_execution'] == 480.0


def test_harvest_rerun_row_is_the_deciding_attempt_with_its_calls(tmp_path):
    _task(tmp_path)
    a, b = 'a' * 32, 'b' * 32
    _trial(tmp_path, a, reward=None, exc='ApiOverloadedError')
    _trial(tmp_path, b, reward=1)
    call = {'run_id': b, 'trial_id': b, 'arm': 'B', 'seq': 1, 'leaf': 'responses', 'status': 200, 'served_model': 'global.openai.gpt-6-luna',
            'usage': {'prompt': 1000, 'uncached': 1000, 'read': 0, 'write': 0, 'output': 10, 'reasoning': 0}, 'cost_usd': 0.001,
            'router': {'x-router-decision': 'initialize;session-start;auto'}, 'runner': 1}
    r, = _harvest(tmp_path, [_meta(tmp_path, a, cls='upstream', action='rerun', score=None, status=None, is_final=False),
                             _meta(tmp_path, b, cls='agent', action='score', score=1.0, status='scored', attempt=2, rerun_of=a)], [call])
    assert r['trial_id'] == b and r['attempt'] == 2 and r['rerun_of'] == a and r['resolved']
    assert r['ledger_usd'] == pytest.approx(0.001) and r['tokens_by_model']['global.openai.gpt-6-luna']['prompt'] == 1000
    import results
    x = results.analysis_row(r, None)                # the R2E stats row takes it unchanged
    assert x['arm'] == 'B' and x['resolved'] is True and x['cost_source'] == 'ledger'


def test_codex_config_turns_off_startup_network_features():
    f = codex_config.config('http://172.17.0.1:8088/r/x/v1')['features']
    assert f['plugins'] is False and f['plugin_discovery_prefetch'] is False and f['apps'] is False and f['remote_plugin'] is False


def test_safe_code():
    assert hproxy.safe_code('context_length_exceeded') == 'context_length_exceeded'
    assert hproxy.safe_code('bad code: <x>\n') == 'badcodex' and hproxy.safe_code(None) is None and hproxy.safe_code('!!') is None
    assert len(hproxy.safe_code('a' * 100)) == 64


def test_failure_fields_for_the_classifier():
    rec = {'status': 404, 'error_shape': 'error-object', 'error_code': 'model_not_found', 'via_router': False}
    rec['origin'] = hproxy.origin(rec)
    rec['model_not_found'] = hproxy.model_not_found(rec)
    f = hproxy.failure(rec)
    assert f['status'] == 404 and f['origin'] == 'upstream' and f['model_not_found'] is True and f['code'] == 'model_not_found'
    stream = {'status': 200, 'terminal': 'response.failed', 'error_code': 'server_error', 'via_router': True}
    stream['origin'] = hproxy.origin(stream)
    assert hproxy.failure(stream)['terminal'] == 'response.failed' and stream['origin'] == 'upstream'
    assert hproxy.failure({'status': 200, 'origin': None}) is None


def test_token_max_age_remints_mid_session_and_is_counted(rig):
    clock = [0.0]
    minter, count = _minter(ttl=3600, clock=lambda: clock[0])
    tok = hproxy.SharedToken(minter, clock=lambda: clock[0], token_max_age_s=600)
    assert tok() == 'tok-1'
    clock[0] = 599
    assert tok() == 'tok-1'
    clock[0] = 600
    assert tok() == 'tok-2' and tok.stats()['remints'] == {'age': 1}
    clock[0] = 1199
    assert tok() == 'tok-2'
    clock[0] = 3600 - 119                           # expiry wins first when it comes before the age limit
    tok2 = hproxy.SharedToken(_minter(ttl=3600, clock=lambda: clock[0])[0], clock=lambda: clock[0])   # off by default
    assert tok2.token_max_age_s is None
    with pytest.raises(ValueError):
        hproxy.SharedToken(minter, token_max_age_s=0)
    # Through the proxy: a trial whose calls straddle a re-mint reports it.
    srv, _, _ = rig()
    srv.shared_token = tok
    for r in srv.routes.values():
        r.token = tok
    tid = uuid.uuid4().hex
    url = srv.register_trial(tid, 'A')
    clock[0] = 1300
    assert _post(srv, url)[0] == 200                 # tok-2 (age 700 ≥ 600 → tok-3 minted here)
    clock[0] = 1950
    assert _post(srv, url)[0] == 200                 # tok-4
    s = srv.unregister_trial(tid)
    assert s['token_remints'] == 1 and srv.summary()['token']['remints']['age'] >= 2
    summ = srv.summary()
    assert summ['token_max_age_s'] == 600 and summ['token_mints'] == tok.mints and summ['token_remints'] >= 2


def test_token_invalidation_is_rate_limited():
    clock = [1000.0]
    minter, count = _minter(ttl=3600, clock=lambda: clock[0])
    tok = hproxy.SharedToken(minter, clock=lambda: clock[0])
    assert tok.invalidate() is True and tok() == 'tok-2'
    assert tok.invalidate() is False and tok() == 'tok-2'     # a second 401 within 30 s does not re-mint
    clock[0] += 31
    assert tok.invalidate() is True and tok() == 'tok-3' and count['i'] == 3


# This module's files (other sessions' files in the directory have their own N5 checks).
MINE = ('hcommon.py', 'codex_config.py', 'harbor_job.py', 'hproxy.py', 'llmar_env.py', 'harvest.py', 'dryrun.py',
        'mock_upstream.py', 'cli.py', 'isoprobe.py', 'isolation.py', 'tests/test_harbor_integration.py', 'tests/test_llmar_env.py',
        'tests/test_isolation.py', 'compose/main-cap-drop-net-raw.json', 'taskpin.py', 'lookupscan.py', 'tests/test_taskpin.py',
        'tests/test_lookupscan.py', 'tests/test_golden_deepswe.py', 'tests/golden/deepswe_harbor_config.json', 'tests/golden/deepswe_report.zh.md')


def test_no_task_text_or_ids_in_committed_code():
    here = pathlib.Path(__file__).resolve().parents[1]
    for p in (here / m for m in MINE):
        t = p.read_text()
        assert 'public.ecr.aws/' + 'd3j8x8q7' not in t, p   # no task image ids in code
        assert not __import__('re').search(r'(?<!\d)\d{12}(?!\d)', t), p




def test_public_tasks_disable_web_search_and_drop_the_allowlist(tmp_path):
    tid = uuid.uuid4().hex
    url = f'http://172.17.0.1:8088/r/{tid}/v1'
    tb = tmp_path / 'tb'
    tb.mkdir()
    (tb / 'task.toml').write_text('[agent]\ntimeout_sec = 900.0\n[environment]\nallow_internet = true\ncpus = 1\n')
    ds = tmp_path / 'ds'
    ds.mkdir()
    (ds / 'task.toml').write_text('[agent]\nnetwork_mode = "no-network"\n[verifier]\nenvironment_mode = "separate"\n')
    assert harbor_job.task_network_public(tb) and not harbor_job.task_network_public(ds)
    assert not harbor_job.task_network_public(tmp_path / 'missing')
    for toml, want in (('[environment]\nnetwork_mode = "public"\n', True), ('[environment]\nallow_internet = false\n', False),
                       ('[environment]\nallow_internet = true\n[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = ["x.example"]\n', False),
                       ('[environment]\nnetwork_mode = "allowlist"\nallowed_hosts = ["x.example"]\n', False)):
        (tmp_path / 'v').mkdir(exist_ok=True)
        (tmp_path / 'v' / 'task.toml').write_text(toml)
        assert harbor_job.task_network_public(tmp_path / 'v') is want, toml
    a = harbor_job.job_config(arm='B', trial_id=tid, task_dir=tb, jobs_dir=tmp_path, job_name=tid, base_url=url, codex_bin=tmp_path / 'c')['agents'][0]
    assert a['kwargs']['disable_web_search'] is True and 'extra_allowed_hosts' not in a
    assert a['kwargs']['config'] == codex_config.config(url)          # the Codex config itself is the same as DeepSWE's
    d = harbor_job.job_config(arm='B', trial_id=tid, task_dir=ds, jobs_dir=tmp_path, job_name=tid, base_url=url, codex_bin=tmp_path / 'c')['agents'][0]
    assert 'disable_web_search' not in d['kwargs'] and d['extra_allowed_hosts'] == ['172.17.0.1']


# ---------------------------------------------------------------- Terminal-Bench 2.1 rows (TB design §4.7)

def _tb_task(root):
    task = root / 'tasks' / 'task-a'
    (task / 'environment').mkdir(parents=True)
    (task / 'task.toml').write_text('[metadata]\ndifficulty = "hard"\ncategory = "security"\nexpert_time_estimate_min = 120.0\n'
                                    '[agent]\ntimeout_sec = 1800.0\n[verifier]\ntimeout_sec = 900.0\n'
                                    '[environment]\nallow_internet = true\ncpus = 2\nmemory_mb = 4096\ndocker_image = "o/x:1"\n')
    (task / 'instruction.md').write_text('synthetic\n')
    (task / 'environment' / 'Dockerfile').write_text('FROM scratch\n')
    return task


def test_harvest_tb_row_has_tb_facts_lookup_and_no_patch(tmp_path):
    import lookupscan

    _tb_task(tmp_path)
    tid = 'c' * 32
    rel = _trial(tmp_path, tid, reward=1, patch=None)
    (tmp_path / rel / hcommon.NET_RECORD).write_text(json.dumps({'ip': '10.201.0.4', 'veth': 'veth1', 'iflink': 9}))
    m = _meta(tmp_path, tid, cls='agent', action='score', score=1.0, status='scored')
    m.update(dataset='tb21', flaky_env=False, lookup={'scanner': 'x', 'flag': False, 'flag_l1': False, 'flag_l2': False})
    r, = _harvest(tmp_path, [m])
    assert r['schema'] == harvest.TB_SCHEMA and r['resolved'] and r['patch'] is None and r['repo'] is None and r['size_bucket'] is None
    assert r['tb'] == {'category': 'security', 'difficulty': 'hard', 'expert_min': 120.0, 'junior_min': None, 'agent_timeout_s': 1800.0,
                       'verifier_timeout_s': 900.0, 'cpus': 2.0, 'memory_mb': 4096.0}
    assert r['tests_ran'] is True and r['flaky_env'] is False and r['net'] == {'ip': '10.201.0.4', 'veth': 'veth1'}
    assert r['lookup']['scanner'] == 'x'                               # the runner's record (17's export) wins
    m2 = dict(m)
    m2.pop('lookup')
    m2.pop('dataset')                                                 # detected from task.toml (public network)
    (tmp_path / 'rows.jsonl').unlink()
    r, = _harvest(tmp_path, [m2])
    assert r['schema'] == harvest.TB_SCHEMA and r['lookup']['scanner'] == lookupscan.VERSION and r['lookup']['source'] == 'missing'
    assert harvest.latest([r])                                        # TB rows are selectable


def test_harvest_deepswe_row_has_no_tb_fields(tmp_path):
    _task(tmp_path)
    _trial(tmp_path, 'd' * 32, reward=1)
    r, = _harvest(tmp_path, [_meta(tmp_path, 'd' * 32, cls='agent', action='score', score=1.0, status='scored')])
    assert r['schema'] == harvest.SCHEMA and not {'tb', 'tests_ran', 'lookup', 'flaky_env', 'net'} & set(r)


def test_conn_counts_join_on_veth_then_ip():
    import lookupscan

    lines = [{'ts_us': 1_000_000 * t, 'src': src, 'dst': dst, 'dpt': p, 'physin': ph} for t, src, dst, p, ph in (
        (10, '10.201.0.4', '1.1.1.1', 443, 'veth1'), (11, '10.201.0.4', '1.1.1.2', 22, 'veth1'),
        (12, '10.201.0.4', '1.1.1.1', 80, 'veth2'),                   # a later trial reusing the IP, other veth
        (50, '10.201.0.4', '1.1.1.1', 443, 'veth1'))]                  # outside the window
    c = lookupscan.conn_counts(lines, {'ip': '10.201.0.4', 'veth': 'veth1'}, 9, 20)
    assert c == {'join': 'physin', 'connections': 2, 'tcp_443': 1, 'tcp_other_rejected': 1, 'distinct_dst': 2}
    nophys = [{**x, 'physin': None} for x in lines]
    c = lookupscan.conn_counts(nophys, {'ip': '10.201.0.4', 'veth': 'veth1'}, 9, 20)
    assert c['join'] == 'ip' and c['connections'] == 3
    assert lookupscan.conn_counts(lines, None, 9, 20)['join'] is None
