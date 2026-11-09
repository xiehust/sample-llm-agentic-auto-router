"""Offline tests: pricing, ledger, Codex config, events, auth, docker guard, selection, results, router-log join,
capture, report and scheduler planning."""
import json
import tomllib

import pytest

import auth
import capture
import codex_setup
import docker_ops
import events
import ledger as lg
import pricing
import report
import results
import routerlogs
import scheduler
import selection
from dataset import Task

SOL, ASTRA, LUNA = 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-astra', 'global.openai.gpt-6-luna'


# ---------------------------------------------------------------- pricing

def test_cost_responses_usage():
    u = {'input_tokens': 10_000, 'input_tokens_details': {'cached_tokens': 6_000, 'cache_write_tokens': 1_000}, 'output_tokens': 500}
    c = pricing.cost(SOL, u)
    assert c['model'] == SOL and not c['long']
    assert c['usd'] == pytest.approx((3_000 * 2 + 6_000 * 0.1 + 1_000 * 2.5 + 500 * 10) / 1e6)
    assert pricing.cost('gpt-6.1-sol', u)['model'] == SOL                 # bare served name
    long = pricing.cost(SOL, {'input_tokens': 300_000, 'output_tokens': 0})
    assert long['long'] and long['usd'] == pytest.approx(300_000 * 4 / 1e6)
    unk = pricing.cost('mystery-model', {'input_tokens': 100_000})
    assert unk['priced_as'] == ASTRA and unk['usd'] == pytest.approx(1.0)


# ---------------------------------------------------------------- ledger

def test_ledger_caps_and_settle(tmp_path):
    led = lg.Ledger(tmp_path / 'l.json', budgets={'A': 2.0, 'B': 3.0, 'C': 5.0, 'D': 2.0})
    wa = led.worst_case('A')
    assert wa == pytest.approx(2.0 + pricing.worst_call_usd(SOL, lg.MARGIN_PROMPT_TOKENS, lg.MARGIN_OUTPUT_TOKENS))
    assert led.worst_case('B') > 3.0 + pricing.worst_call_usd(SOL, lg.MARGIN_PROMPT_TOKENS, lg.MARGIN_OUTPUT_TOKENS)  # B: Astra margin
    r1 = led.reserve('r1', 'C', 'pilot', key='pilot/C/t/r1')
    assert r1 is not None
    assert led.reserve('r2', 'C', 'pilot') is None          # two C worst cases do not fit the $10 pilot cap
    led.settle('r1', 1.25)
    assert led.committed('pilot') == pytest.approx(1.25)
    assert led.reserve('r2', 'C', 'pilot') is not None
    led2 = lg.Ledger(tmp_path / 'l.json')                    # r2 was in flight when we "crashed"
    assert led2.data['runs']['r2']['crashed'] and led2.committed('pilot') == pytest.approx(1.25 + led.worst_case('C'))


def test_ledger_total_cap_and_runner(tmp_path):
    t = [1000.0]
    led = lg.Ledger(tmp_path / 'l.json', caps={'pilot': 10, 'total': 5.0}, runner_usd_per_hour=1.0, runner_started_at=1000.0, clock=lambda: t[0])
    assert led.reserve('a', 'A', 'main') is not None
    t[0] += 3600 * 3                                         # 3 runner hours
    assert led.reserve('b', 'A', 'main') is None
    led.charge('tierpass', 0.3, 'x')
    with pytest.raises(lg.CapExceeded):
        led.check_or_raise('tierpass', 5.0)
    assert led.summary()['runner_usd'] == pytest.approx(3.0)


# ---------------------------------------------------------------- Codex config (D6)

def test_config_toml_per_arm():
    for arm, pin in (('A', SOL), ('B', None), ('C', ASTRA)):
        cfg = tomllib.loads(codex_setup.config_toml('http://172.18.0.1:8088/r/r-x/v1', arm, 'r-x', pin, SOL))
        assert cfg['model'] == 'auto' and cfg['model_provider'] == 'llmar'
        p = cfg['model_providers']['llmar']
        assert p['base_url'] == 'http://172.18.0.1:8088/r/r-x/v1' and p['wire_api'] == 'responses' and p['env_key'] == 'LLMAR_DUMMY_KEY'
        assert p['http_headers']['x-router-session'] == 'r-x'
        assert p['http_headers'].get('x-router-hint') == (f'pin={pin}' if pin else None)
        assert cfg['model_auto_compact_token_limit'] <= 200_000 and cfg['approval_policy'] == 'never'
        assert cfg['features']['multi_agent'] is False and cfg['features']['enable_request_compression'] is False
        assert cfg['otel'] == {'exporter': 'none', 'metrics_exporter': 'none', 'trace_exporter': 'none'}
    d = tomllib.loads(codex_setup.config_toml('http://172.18.0.1:8088/r/r-y/v1', 'D', 'r-y', None, SOL))
    assert d['model'] == SOL and 'http_headers' not in d['model_providers']['llmar']


def test_exec_argv_and_env():
    argv = codex_setup.exec_argv('fix it', 2400)
    assert argv[:6] == ['timeout', '-s', 'INT', '-k', '60', '2400'] and argv[6] == codex_setup.CTR_CODEX
    assert '--json' in argv and '--strict-config' in argv and argv[-1] == 'fix it'
    env = codex_setup.exec_env('/usr/bin')
    assert env['LLMAR_DUMMY_KEY'] == codex_setup.DUMMY_KEY and not any('TOKEN' in k or 'AWS' in k for k in env)
    assert '<prompt 6 chars>' in codex_setup.describe(argv)


# ---------------------------------------------------------------- events

def test_events_summary():
    lines = [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"item.completed","item":{"id":"i0","type":"error","message":"Model metadata for `auto` not found."}}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc \'pip install foo\'","aggregated_output":"","exit_code":1,"status":"failed"}}',
        '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"pytest -q","aggregated_output":"","exit_code":0,"status":"completed"}}',
        '{"type":"item.completed","item":{"id":"i3","type":"file_change","changes":[],"status":"completed"}}',
        'not json',
        '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":3}}',
    ]
    s = events.summarize(lines)
    assert s['completed'] and s['turns'] == 1 and s['commands'] == 2 and s['commands_failed'] == 1 and s['file_changes'] == 1
    assert s['usage']['cached_input_tokens'] == 40 and s['network_commands'] == {'pip-install': 1}
    assert s['errors'] == ['model metadata for <x> not found.']
    assert set(events.network_hits('curl -s https://x && git clone y && nc host 1')) == {'curl', 'git-remote', 'netcat'}


# ---------------------------------------------------------------- auth

def test_secret_and_minter():
    good = json.dumps({'client_id': 'id', 'client_secret': 'sec-XYZ', 'token_url': 'https://d.auth.example.com/oauth2/token', 'scope': 'llmar/invoke'})
    s = auth.parse_secret(good)
    for bad in ('nope', json.dumps({'client_id': 'id'}), good.replace('https', 'http')):
        with pytest.raises(auth.AuthError) as e:
            auth.parse_secret(bad)
        assert 'sec-XYZ' not in str(e.value)
    sent = []
    m = auth.TokenMinter(s, post=lambda url, data, h: (sent.append((url, data, h)) or (200, json.dumps({'access_token': 'AT1', 'expires_in': 3600}).encode())),
                         clock=lambda: 0.0)
    clock = [0.0]
    rt = auth.RunToken(m, clock=lambda: clock[0])
    assert rt() == 'AT1' and rt.mints == 1 and 'AT1' not in repr(rt)
    clock[0] = 3600 - 60
    rt()
    assert rt.mints == 2 and sent[0][1] == b'grant_type=client_credentials&scope=llmar%2Finvoke'
    bad = auth.TokenMinter(s, post=lambda *a: (400, b'{"error":"invalid_client","secret":"sec-XYZ"}'))
    with pytest.raises(auth.AuthError) as e:
        bad.mint()
    assert 'sec-XYZ' not in str(e.value) and '400' in str(e.value)


# ---------------------------------------------------------------- docker guard (F3/F4)

@pytest.mark.parametrize('argv', [
    ['docker', 'run', '--privileged', 'img'], ['docker', 'run', '--network', 'host', 'img'], ['docker', 'run', '--network=host', 'img'],
    ['docker', 'run', '-p', '8080:80', 'img'], ['docker', 'run', '--restart', 'always', 'img'], ['docker', 'run', '--cap-add', 'NET_ADMIN', 'img'],
    ['docker', 'run', '--cap-add=NET_ADMIN', 'img'], ['docker', 'network', 'create', '--ipv6', 'n'], ['docker', 'run', '-v', '/:/host', 'img'],
    ['docker', 'run', '--network', 'bridge', 'img'], ['docker', 'run', '--pid', 'host', 'img'], ['docker', 'run', '--net', 'host', 'img'],
])
def test_forbidden_docker_args(argv):
    with pytest.raises(docker_ops.ForbiddenDockerArg):
        docker_ops.check_argv(argv)


def test_docker_start_argv_is_clean():
    seen = []
    d = docker_ops.Docker(runner=lambda argv, t, i: (seen.append(list(argv)) or docker_ops.Result(0, '', '', 0.0)))
    d.start('img:tag', 'llmar-x', 'llmar-tasks', docker_ops.Limits(), 'r-1')
    argv = seen[0]
    assert argv[:2] == ['docker', 'run'] and argv[argv.index('--network') + 1] == 'llmar-tasks'
    assert '--security-opt' in argv and argv[argv.index('--cpus') + 1] == '2' and argv[argv.index('--memory') + 1] == '8g'
    d.rm('llmar-x')   # rm -v is allowed (not a creating command)
    with pytest.raises(docker_ops.ForbiddenDockerArg):
        d.start('img', 'n', 'host', docker_ops.Limits(), 'r')


# ---------------------------------------------------------------- selection

def _cands(n=500):
    repos = ['pandas', 'numpy', 'pillow', 'orange3', 'aiohttp', 'tornado', 'scrapy', 'pyramid', 'datalad', 'coveragepy']
    tiers = ['standard'] * 80 + ['fast'] * 8 + ['frontier'] * 7 + ['none'] * 5
    sizes = ['small', 'small', 'medium', 'large']
    return [{'task_id': f'{repos[i % 10]}-{i:06x}-c0ffee', 'repo': repos[i % 10], 'size': sizes[i % 4], 'pred_tier': tiers[i % 100]} for i in range(n)]


def test_candidates_deterministic():
    ids = [f't{i}' for i in range(4578)]
    a = selection.candidates(ids, 500, 7)
    assert a == selection.candidates(list(reversed(ids)), 500, 7) and len(a) == 500 and a != selection.candidates(ids, 500, 8)


def test_select_rules():
    cands = _cands()
    sel = selection.select(cands, seed=1)
    main, pilot = sel['main'], sel['pilot']
    assert len(main) == 50 and len(pilot) == 3 and not set(main) & set(pilot)
    from collections import Counter
    assert max(Counter(sel['tasks'][t]['repo'] for t in main).values()) <= selection.REPO_CAP
    assert sel['arms']['A'] == main and sel['arms']['F'] == main
    assert len(sel['arms']['C']) == 20 and len(sel['arms']['B']) == 10 and len(sel['arms']['D']) == 5
    assert all(set(sel['arms'][a]) <= set(main) for a in 'CBD')
    sizes = Counter(sel['tasks'][t]['size'] for t in main)
    c_sizes = Counter(sel['tasks'][t]['size'] for t in sel['arms']['C'])
    assert all(abs(c_sizes[k] - 20 * sizes[k] / 50) <= 1 for k in sizes)     # size-stratified subset
    assert len({sel['tasks'][p]['repo'] for p in pilot}) == 3 and all(sel['tasks'][p]['size'] != 'large' for p in pilot)
    assert not set(sel['reserves']) & (set(main) | set(pilot)) and len(sel['reserves']) == 500 - 53
    assert 'weights' not in sel and sel['pred_tier_counts'] == {'fast': 40, 'frontier': 35, 'none': 25, 'standard': 400}
    assert sel['tasks'][main[0]]['pred_tier'] in ('fast', 'standard', 'frontier', 'none') and 'problem' not in json.dumps(sel)
    assert selection.select(cands, seed=1)['main'] == main and selection.select(cands, seed=2)['main'] != main
def test_select_records_untimed_tier():
    cands = [{**c, 'pred_tier': 'none', 'pred_tier_untimed': 'standard'} for c in _cands()]
    sel = selection.select(cands, seed=2)
    assert sel['pred_tier_untimed_counts'] == {'standard': 500} and sel['tasks'][sel['main'][0]]['pred_tier_untimed'] == 'standard'
def test_replace_moves_arm_membership():
    sel = selection.select(_cands(), seed=3)
    victim = sel['arms']['C'][0]
    new = selection.replace(sel, victim, 'unstable')
    assert new and victim not in sel['main'] and new in sel['main'] and new in sel['arms']['C'] and new in sel['arms']['F']
    assert victim not in sel['arms']['C'] and new not in sel['reserves']
    assert sel['replacements'][-1] == {**sel['replacements'][-1], 'failed': victim, 'replacement': new}


# ---------------------------------------------------------------- results (D9, D10, D13)

def _call(seq, prompt, read, model=SOL, status=200, router=True, **kw):
    return {'run_id': 'r-1', 'arm': 'B', 'seq': seq, 'leaf': 'responses', 'status': status, 'served_model': model,
            'via_router': router, 'router': {'x-router-decision': 'retain;hard-lock-tool-loop;auto'} if router else {},
            'usage': {'prompt': prompt, 'uncached': prompt - read, 'read': read, 'write': 0, 'output': 50, 'reasoning': 0},
            'cost_usd': 0.01, 'prev_prompt': kw.get('prev'), 'prev_model': kw.get('prev_model', SOL), 'ttfb_ms': 100}


def test_calls_summary_cache_and_fallback():
    calls = [_call(1, 10_000, 0), _call(2, 12_000, 9_900, prev=10_000), _call(3, 13_000, 1_000, prev=12_000),
             _call(4, 5_000, 0, prev=13_000), _call(5, 6_000, 0, model=LUNA, prev=5_000), _call(6, 7_000, 0, router=False, prev=6_000, prev_model=LUNA),
             {'run_id': 'r-1', 'seq': 7, 'leaf': 'responses', 'status': 429, 'refused': 'budget'}]
    s = results.calls_summary(calls)
    assert s['cache']['first_call_read'] == 0 and s['gateway_fallback_calls'] == 1 and s['budget_stopped']
    assert s['cache']['loss_by_reason'] == {'unexplained': 1, 'compaction': 1, 'switch': 2}
    assert s['served_models'][LUNA] == 1 and s['responses_calls'] == 6 and s['ledger_usd'] == pytest.approx(0.06)
    unpriced = results.calls_summary([{'run_id': 'r', 'seq': 1, 'leaf': 'responses', 'status': 200, 'served_model': SOL,
                                       'usage': None, 'prev_prompt': 100_000, 'mid_stream': True}])
    assert unpriced['unpriced_calls'] == 1 and unpriced['ledger_usd'] == pytest.approx((100_000 * 2 + 4000 * 10) / 1e6)


# ---------------------------------------------------------------- router logs (A2, A3)

def _log(session=None, lineage=None, cost=0.02, assessor=None, family='0123456789ab', kind='model'):
    d = {'ts': '2026-11-05T00:00:00Z', 'reqId': 'q', 'kind': kind, 'status': 200, 'servedModel': SOL,
         'decision': {'action': 'initialize', 'point': 'session-start', 'reason': f'session-start: x; family={family} est=1'},
         'costUsd': {'total': cost}, 'usage': {'uncachedInputTokens': 100, 'cacheReadTokens': 900, 'cacheWriteTokens': {'30m': 10},
                                                'outputTokens': 5, 'promptTokens': 1010}, 'overheadMs': 3}
    if session:
        d['session'] = session
    if lineage:
        d['lineage'] = lineage
    if assessor:
        d['assessor'] = assessor
    return d


def test_join_by_session_label_and_assessor_cost():
    rid = 'r-0123'
    lab = routerlogs.label(rid)
    assert lab == __import__('hashlib').sha256(rid.encode()).hexdigest()[:16]
    recs = [_log(session=lab, lineage='aaaa', assessor={'tier': 'fast', 'proposedTier': 'fast', 'status': 'ok', 'costUsd': 0.0007, 'applied': True}),
            _log(session=lab, lineage='aaaa'), _log(session=routerlogs.label('other'))]
    text = '\n'.join(json.dumps({'message': json.dumps(r), 'timestamp': 1}) for r in recs) + '\n{"_aws": {}}\nnoise'
    parsed = routerlogs.parse(text)
    assert len(parsed) == 3
    j = routerlogs.join(parsed, [rid], {rid: 2})[rid]
    assert j['model_requests'] == 2 and j['complete'] and j['cost_usd'] == pytest.approx(0.04 + 0.0007)
    assert j['assessor_tier'] == 'fast' and j['cache_read_tokens'] == 1800 and j['lineages'] == 1
    assert routerlogs.unique_lineages({rid: j})['ok']


def test_parse_pretty_printed_filter_log_events_document():
    """`aws logs filter-log-events --output json` is one indented multi-line document."""
    lab = routerlogs.label('r-pp')
    recs = [_log(session=lab), _log(session=lab), {'_aws': {'CloudWatchMetrics': []}}]
    doc = {'events': [{'logStreamName': 's', 'timestamp': 1, 'message': json.dumps(r), 'eventId': str(i)}
                      for i, r in enumerate(recs)], 'searchedLogStreams': []}
    parsed = routerlogs.parse(json.dumps(doc, indent=4))
    assert len(parsed) == 2 and all(r['session'] == lab for r in parsed)
    # A top-level list of events, pretty-printed, and a single pretty-printed RequestLog also parse.
    assert len(routerlogs.parse(json.dumps(doc['events'], indent=2))) == 2
    assert len(routerlogs.parse(json.dumps(recs[0], indent=2))) == 1


def test_join_falls_back_to_lineage_label():
    rid = 'r-77'
    fam = 'abcdefabcdef'
    lin = routerlogs.label(f'{rid}/t:{fam}')
    j = routerlogs.join([_log(lineage=lin, family=fam)], [rid])
    assert j[rid]['model_requests'] == 1 and not j[rid]['complete']


def test_analysis_row_prefers_router_cost():
    row = {'schema': results.SCHEMA, 'run_id': 'r', 'phase': 'main', 'arm': 'B', 'task_id': 't', 'repo': 'numpy', 'size_bucket': 'small',
           'pred_tier': 'fast', 'resolved': True, 'strict': True, 'ledger_usd': 0.5, 'exit_reason': 'done', 'wall_s': 10,
           'calls': {'usage': {'prompt': 10, 'read': 4, 'output': 1}, 'served_models': {LUNA: 3, SOL: 1}}}
    a = results.analysis_row(row, None)
    assert a['cost_source'] == 'ledger' and a['cost_usd'] == 0.5 and a['served_model'] == LUNA and a['assessor_tier'] is None
    b = results.analysis_row(row, {'complete': True, 'cost_usd': 0.3, 'prompt_tokens': 20, 'cache_read_tokens': 8, 'output_tokens': 2, 'assessor_tier': 'fast'})
    assert b['cost_source'] == 'router' and b['cost_usd'] == 0.3 and b['assessor_tier'] == 'fast' and b['input_tokens'] == 20


# ---------------------------------------------------------------- capture

def test_template_and_task_body():
    body = {'model': 'auto', 'input': [
        {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '<environment_context>\n  <cwd>/tmp/w/testbed</cwd>\n</environment_context>'}]},
        {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': codex_setup.prompt(capture.PLACEHOLDER)}]}]}
    t = capture.template(body, '/tmp/w/testbed')
    assert '<cwd>/testbed</cwd>' in json.dumps(t)
    issue = 'Line "one"\nline two with \\ backslash'
    b = capture.task_body(t, issue)
    assert b['input'][1]['content'][0]['text'] == codex_setup.prompt(issue)
    with pytest.raises(ValueError):
        capture.template({'input': []}, '/x')


def test_mock_responses_server():
    import http.client
    import threading
    srv = capture.MockResponses(('127.0.0.1', 0))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    c = http.client.HTTPConnection(*srv.server_address)
    c.request('POST', '/r/x/v1/responses', body=json.dumps({'model': 'auto'}), headers={'authorization': 'Bearer secret', 'content-type': 'application/json'})
    data = c.getresponse().read()
    srv.shutdown()
    assert b'response.completed' in data and 'authorization' not in srv.records[0]['headers']
    assert capture.first_responses_body(srv.records) == {'model': 'auto'}


# ---------------------------------------------------------------- scheduler plan and report

def _sel():
    return selection.select(_cands(), seed=4)


def test_plan_phases():
    sel = _sel()
    pilot = scheduler.plan(sel, 'pilot', 1)
    assert sorted(p.arm for p in pilot) == ['A', 'A', 'A', 'B', 'C', 'D', 'F', 'F', 'F'] and pilot[0].arm == 'C'
    assert {p.task_id for p in pilot} == set(sel['pilot'])
    main = scheduler.plan(sel, 'main', 1)
    assert len(main) == 50 + 50 + 20 + 10 + 5 and main == scheduler.plan(sel, 'main', 1) and main != scheduler.plan(sel, 'main', 2)
    rep = scheduler.plan(sel, 'repeat', 1)
    assert len(rep) == 20 and {p.arm for p in rep} == {'A', 'F'} and all(p.rep == 2 for p in rep)
    rid = scheduler.new_run_id()
    assert rid.startswith('r-') and len(rid) == 34 and rid != scheduler.new_run_id()
def _rows(sel, resolved=lambda arm, t, rng: rng.random() < 0.5, served=SOL):
    import random
    rng = random.Random(0)
    rows = []
    for arm, ids in sel['arms'].items():
        for t in ids:
            meta = sel['tasks'][t]
            rows.append({'schema': results.SCHEMA, 'run_id': f'r-{arm}-{t}', 'phase': 'main', 'arm': arm, 'task_id': t, 'repo': meta['repo'],
                         'size_bucket': meta['size'], 'pred_tier': meta['pred_tier'], 'rep': 1, 'resolved': resolved(arm, t, rng),
                         'strict': False, 'ledger_usd': {'F': 0.05, 'C': 4.0}.get(arm, 0.8) * rng.uniform(0.5, 1.5), 'exit_reason': 'done',
                         'wall_s': 100.0, 'calls': {'usage': {'prompt': 1000, 'read': 800, 'output': 10},
                                                    'served_models': {LUNA if arm == 'F' else ASTRA if arm == 'C' else served: 5},
                                                    'cache': {'loss_by_reason': {}, 'first_call_read': 0, 'same_model_pairs': 4, 'expected_read': 1000, 'read': 900},
                                                    'gateway_fallback_calls': 0, 'refused': {}, 'statuses': {'200': 5}},
                         'events': {'network_command_total': 0}})
    return rows


def test_report_builds_and_renders():
    import re
    sel = _sel()
    sel['tierpass'] = {'n': 500, 'status': {'ok': 500}, 'pred_tier': {'none': 307, 'standard': 193}, 'pred_tier_untimed': {'standard': 488, 'none': 12},
                       'within_deadline': 198, 'latency_ms': {'p10': 1414.0, 'p50': 1532.0, 'p90': 1838.0, 'max': 2907.0}, 'cost_usd': 0.352,
                       'recorded_deadline_ms': 1500, 'deadlines': {'1500': {'pred_tier': {'none': 307, 'standard': 193}, 'within': 198},
                                                                  '5000': {'pred_tier': {'none': 12, 'standard': 488}, 'within': 500}}}
    data = report.build(_rows(sel), {}, sel, {'total': 1.0}, n_boot=200)
    json.dumps(data, allow_nan=False)
    assert data['counts'] == {'A': 50, 'B': 10, 'C': 20, 'D': 5, 'F': 50}
    assert data['F_vs_A']['primary'] and data['C_vs_A']['primary'] and not data['B_vs_A']['primary'] and not data['D_vs_A']['primary']
    ir = data['ideal_router']
    assert ir['F_A']['n'] == 50 and ir['F_A_C']['n'] == 20 and ir['noise_A_B']['n'] == 10
    assert ir['F_A']['vs']['always_sol']['arm'] == 'A' and 'assessor_choice' in ir['F_A']['vs']
    assert data['limitations'] and len(data['per_task']) == 50 and 'weights' not in json.dumps(data['selection'])
    md = report.render(data)
    assert md.startswith('# Codex × DeepSWE') and '## 9. 局限' in md and '离线 tier pass' in md and '1532.0' in md
    assert '| 5000 ms | 500/500 |' in md and '| 1500 ms | 198/500 |' in md and '试点中唯一的 B 运行仍用 1500 ms' in md
    f_line = next(line for line in md.splitlines() if line.startswith('| F vs A'))
    assert len(re.findall(r'\d\.\d{3} \[', f_line)) == 2
    assert '理想路由' in md and '纯噪声' in md
    task_line = next(line for line in md.splitlines() if line.startswith(f"| {sel['main'][0]} |"))
    assert task_line.count('|') == 11
def test_ideal_router_prefers_fast_when_it_solves():
    sel = _sel()
    rows = _rows(sel, resolved=lambda arm, t, rng: arm != 'F' or t in sel['main'][:10])
    ir = report.build(rows, {}, sel, {}, n_boot=100)['ideal_router']['F_A']
    assert ir['choice_counts']['F'] == 10 and ir['vs']['always_sol']['cost_ratio']['point'] < 1
def test_task_dataclass_size():
    assert Task('t', 'r', 'c', 'i', 50, 1).size == 'large'


# ---------------------------------------------------------------- pack

def test_pack_is_reproducible_and_excludes_local_dirs(tmp_path):
    import tarfile

    import packing
    repo = tmp_path / 'repo'
    h = repo / 'experiments' / 'codex-deepswe'
    for p in ('cli.py', 'results/ledger.json', 'data/x.parquet', 'bin/codex', '__pycache__/a.pyc', 'tests/test_a.py'):
        (h / p).parent.mkdir(parents=True, exist_ok=True)
        (h / p).write_text(p)
    (repo / 'packages' / 'pricing' / 'data').mkdir(parents=True)
    (repo / 'packages' / 'pricing' / 'data' / 'catalog.json').write_text('{}')
    a = packing.build(tmp_path / 'a.tgz', repo)
    import os
    import time
    os.utime(h / 'cli.py', (time.time() + 100, time.time() + 100))
    b = packing.build(tmp_path / 'b.tgz', repo)
    assert a['sha256'] == b['sha256'] and a['files'] == 3
    with tarfile.open(tmp_path / 'a.tgz') as t:
        names = t.getnames()
        assert all(m.mtime == 0 and m.uid == 0 and not m.uname for m in t.getmembers())
    assert 'experiments/codex-deepswe/cli.py' in names and 'packages/pricing/data/catalog.json' in names
    assert not any(x in n for n in names for x in ('results', '/data/x', 'bin', 'pycache'))
    (h / 'link').symlink_to('/etc/passwd')
    with pytest.raises(ValueError):
        packing.build(tmp_path / 'c.tgz', repo)


# ---------------------------------------------------------------- review fixes (M2, M3, L6, S1, S2, G3, T2)

@pytest.mark.parametrize('argv', [
    ['docker', 'run', '-e', 'X=1', 'img'], ['docker', 'run', '--security-opt', 'seccomp=unconfined', 'img'],
    ['docker', 'run', '--cap-drop', 'ALL', '--privileged', 'img'], ['docker', 'run', '--add-host', 'x:host-gateway', 'img'],
    ['docker', 'run', '--user', '0', 'img'], ['docker', 'network', 'create', '--subnet', '10.0.0.0/8', 'n'],
    ['docker', 'network', 'create', '--driver', 'macvlan', 'n'], ['docker', 'create', 'img'], ['docker', 'run', '--name'],
])
def test_docker_allowlist_refuses(argv):
    with pytest.raises(docker_ops.ForbiddenDockerArg):
        docker_ops.check_argv(argv)


def test_docker_allowlist_accepts_what_start_uses():
    seen = []
    d = docker_ops.Docker(runner=lambda argv, t, i: (seen.append(list(argv)) or docker_ops.Result(1, '[{"Internal": true, "IPAM": {"Config": [{"Gateway": "172.18.0.1"}]}}]', '', 0)))
    d.start('img:tag', 'llmar-x', 'llmar-tasks', docker_ops.Limits(), 'r-1')
    docker_ops.check_argv(['docker', 'network', 'create', '--driver', 'bridge', '--label', docker_ops.LABEL, '--internal', 'llmar-tasks'])
    docker_ops.check_argv(['docker', 'run', '-d', '-t', '-i', '--name', 'n', '--network=llmar-tasks', 'img', '/bin/bash', '--privileged'])  # after the image: the command


def test_patch_build_dist_top_level_only():
    import patches
    assert patches.drop_reason('build/lib/x.py', '') == 'artefact' and patches.drop_reason('dist/a.py', '') == 'artefact'
    assert patches.drop_reason('pkg/build/tool.py', '') is None and patches.drop_reason('scrapy/dist/x.py', '') is None
    assert patches.drop_reason('parsed_commit.json', '') == 'hidden-test-path'


def test_token_fetch_does_not_follow_redirects():
    import http.server
    import threading
    hits = []

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            hits.append(self.path)
            self.send_response(302)
            self.send_header('location', '/stolen')
            self.send_header('content-length', '0')
            self.end_headers()
    srv = http.server.HTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        req = auth.urllib.request.Request(f'http://127.0.0.1:{srv.server_address[1]}/oauth2/token', data=b'x', method='POST')
        try:
            auth._OPENER.open(req, timeout=5)
            status = 200
        except auth.urllib.error.HTTPError as e:
            status = e.code
    finally:
        srv.shutdown()
    assert status == 302 and hits == ['/oauth2/token']
    with pytest.raises(auth.AuthError):
        auth._https_post('http://x/oauth2/token', b'', {})


def test_replace_prefers_same_size_for_subsets_and_distinct_pilot_repos():
    sel = selection.select(_cands(), seed=8)
    victim = sel['arms']['C'][0]
    size = sel['tasks'][victim]['size']
    new = selection.replace(sel, victim, 'x')
    assert sel['tasks'][new]['size'] == size
    p = sel['pilot'][0]
    newp = selection.replace(sel, p, 'x')
    assert newp is None or sel['tasks'][newp]['repo'] not in {sel['tasks'][x]['repo'] for x in sel['pilot'] if x != newp}
def test_validation_summary_by_tier():
    sel = selection.select(_cands(), seed=9)
    for t in sel['main'][:5]:
        sel['validated'][t] = {'ok': True}
    bad = sel['main'][5]
    sel['validated'][bad] = {'ok': False}
    selection.replace(sel, bad, 'unstable')
    s = selection.validation_summary(sel)
    assert s['validated'] == 6 and s['ok'] == 5 and sum(v['validated'] for v in s['by_tier'].values()) == 6


def test_run_requires_runner_cost_flags():
    import argparse

    import cli
    with pytest.raises(SystemExit) as e:
        cli.cmd_run(argparse.Namespace(runner_usd_per_hour=0.0, runner_started_at=None))
    assert 'runner' in str(e.value)


def test_tierpass_spend_reads_rows(tmp_path):
    import cli
    p = tmp_path / 't.jsonl'
    p.write_text('{"task_id":"a","cost_usd":0.001}\n{"task_id":"b","cost_usd":0.002}\n{"task_id":"c"}\n{torn')
    assert cli.tierpass_spend(p) == (pytest.approx(0.003), 3)


def test_report_excludes_rebuild_failures_from_pairs():
    sel = _sel()
    rows = _rows(sel)
    for r in rows:
        r['grade_excluded'] = r['arm'] == 'F' and r['task_id'] == sel['main'][0]
    data = report.build(rows, {}, sel, {}, n_boot=100)
    assert data['excluded_tasks'] == [sel['main'][0]] and data['F_vs_A']['n'] == 49
    assert sel['main'][0] in report.render(data)


# ---------------------------------------------------------------- follow-ups (F1, F2)

def test_docker_exec_allowlist_and_network_binding():
    docker_ops.check_argv(['docker', 'exec', '-w', '/testbed', '-e', 'A=1', '-i', 'ctr', 'sh', '-c', '--privileged'])
    for bad in (['docker', 'exec', '--privileged', 'ctr', 'sh'], ['docker', 'exec', '-u', '0', 'ctr', 'sh'],
                ['docker', 'exec', '-d', 'ctr', 'sh'], ['docker', 'exec', '--env-file', 'f', 'ctr', 'sh'],
                ['docker', 'network', 'connect', 'bridge', 'ctr'], ['docker', 'network', 'disconnect', 'n', 'ctr'],
                ['docker', 'network', 'rm', 'n']):
        with pytest.raises(docker_ops.ForbiddenDockerArg):
            docker_ops.check_argv(bad)
    seen = []
    d = docker_ops.Docker(runner=lambda argv, t, i: (seen.append(list(argv)) or docker_ops.Result(0, '', '', 0.0)), network='llmar-tasks')
    d.start('img', 'n', 'llmar-tasks', docker_ops.Limits(), 'r')
    with pytest.raises(docker_ops.ForbiddenDockerArg):
        d.start('img', 'n', 'llmar-other', docker_ops.Limits(), 'r')
    with pytest.raises(docker_ops.ForbiddenDockerArg):
        docker_ops.check_argv(['docker', 'run', '-d', 'img'], network='llmar-tasks')       # no --network at all
    assert len(seen) == 1


def test_docker_exec_argv_goes_through_the_guard(tmp_path):
    d = docker_ops.Docker(docker='/bin/false', network='llmar-tasks')
    r = d.exec_argv('ctr', ['true'], 5, '/testbed', {'A': '1'}, tmp_path / 'o', tmp_path / 'e')
    assert r.code == 1      # ran (/bin/false), so the argv passed the guard
    import unittest.mock as um
    with um.patch.object(docker_ops, 'check_argv', side_effect=docker_ops.ForbiddenDockerArg('x')), pytest.raises(docker_ops.ForbiddenDockerArg):
        d.exec_argv('ctr', ['true'], 5, '/testbed', {}, tmp_path / 'o', tmp_path / 'e')


# ---------------------------------------------------------------- design §12: extend to 200

def test_extend_keeps_validated_tasks_and_grows_along_the_seeded_order():
    from collections import Counter
    v2 = selection.select(_cands(), seed=11)
    v2['validated'] = {t: {'ok': True} for t in v2['main'] + v2['pilot']}
    failed = v2['main'][0]
    selection.replace(v2, failed, 'gold-fails-strict')
    v3 = selection.extend(v2, n_main=200, repo_cap_frac=0.25, n_repeat=20, repeat_reps=1)
    assert set(v2['main']) <= set(v3['main']) and len(v3['main']) == 200 and failed not in v3['main']
    assert v3['pilot'] == v2['pilot'] and not set(v3['pilot']) & set(v3['main'])
    assert v3['rules']['repo_cap'] == 50 and max(v3['repo_counts'].values()) <= 50
    assert v3['repo_counts'] == dict(sorted(Counter(v3['tasks'][t]['repo'] for t in v3['main']).items()))
    assert len(v3['arms']['C']) == 60 and len(v3['arms']['B']) == 30 and len(v3['arms']['D']) == 10 and len(v3['repeat']) == 20
    assert v3['arms']['A'] == v3['arms']['F'] == v3['main'] and all(set(v3['arms'][a]) <= set(v3['main']) for a in 'CBD')
    # the new tasks are the earliest reserves in v2's seeded order (cap permitting)
    new = [t for t in v2['reserves'] if t in set(v3['main'])]
    assert v3['repo_cap_effect']['skipped_by_cap'] == 0 and new == v2['reserves'][:len(new)]
    assert v3['validated'] == v2['validated'] and v3['replacements'] == v2['replacements']
    assert not set(v3['reserves']) & set(v3['main']) and 'problem' not in json.dumps(v3)
    plan = scheduler.plan(v3, 'main', 1)
    assert len(plan) == 500 and len(scheduler.plan(v3, 'repeat', 1)) == 40
    v3b = selection.extend(v2, repeat_reps=2)
    assert {p.rep for p in scheduler.plan(v3b, 'repeat', 1)} == {2, 3} and len(scheduler.plan(v3b, 'repeat', 1)) == 80
    with pytest.raises(ValueError):
        selection.extend(v2, n_main=440, repo_cap_frac=0.05)


def test_replace_uses_the_selection_repo_cap():
    v2 = selection.select(_cands(), seed=12)
    v3 = selection.extend(v2)
    victim = v3['main'][5]
    assert selection.replace(v3, victim, 'unstable') in v3['main']


def test_repeats_report_handles_several_reps():
    rows = []
    for rep, res in ((1, True), (2, False), (3, True)):
        rows.append({'schema': results.SCHEMA, 'phase': 'main' if rep == 1 else 'repeat', 'arm': 'A', 'task_id': 't1', 'rep': rep, 'resolved': res})
        rows.append({'schema': results.SCHEMA, 'phase': 'main' if rep == 1 else 'repeat', 'arm': 'A', 'task_id': 't2', 'rep': rep, 'resolved': True})
    out = report.repeats(results.latest(rows), n_boot=100)
    a = out['A']
    assert a['tasks'] == 2 and a['mixed_tasks'] == 1 and a['task_flip_rate'] == pytest.approx(0.5)
    assert a['pair_disagreement'] == pytest.approx((2 / 3 + 0) / 2) and a['resolve_rate_by_task'] == {'t1': pytest.approx(2 / 3), 't2': 1.0}


def test_report_renders_repeat_noise_next_to_f_vs_a():
    sel = selection.extend(selection.select(_cands(), seed=13))
    rows = _rows(sel)
    for t in sel['repeat']:
        for arm in ('A', 'F'):
            rows.append({'schema': results.SCHEMA, 'run_id': f'r-rep-{arm}-{t}', 'phase': 'repeat', 'arm': arm, 'task_id': t, 'rep': 2,
                         'resolved': t.endswith('0') or t.endswith('2'), 'ledger_usd': 0.1, 'exit_reason': 'done'})
    data = report.build(rows, {}, sel, {}, n_boot=100)
    assert data['repeats']['A']['tasks'] == 20 and 'pair_disagreement_ci' in data['repeats']['F']
    md = report.render(data)
    assert '运行间噪声' in md and '对照：F vs A 不一致率（全部任务）' in md and '同一批重复任务' in md and '纯噪声基准' in md
    assert data['F_vs_A_on_repeat_tasks']['n'] == 20



def test_tierpass_summary_recomputes_deadlines_offline():
    import cli
    rows = [{'task_id': 'a', 'latency_ms': 1400, 'pred_tier_untimed': 'standard', 'pred_tier': 'standard', 'within_router_deadline': True},
            {'task_id': 'b', 'latency_ms': 2100, 'pred_tier_untimed': 'standard', 'pred_tier': 'none', 'within_router_deadline': False},
            {'task_id': 'c', 'latency_ms': 6000, 'pred_tier_untimed': 'standard', 'pred_tier': 'none', 'within_router_deadline': False},
            {'task_id': 'd', 'latency_ms': 900, 'pred_tier_untimed': 'none', 'pred_tier': 'none', 'within_router_deadline': True}]
    s = cli.tierpass_summary(rows, (1500, 5000))
    assert s['recorded_deadline_ms'] == 1500 and s['pred_tier'] == {'none': 3, 'standard': 1}
    assert s['deadlines']['1500'] == {'pred_tier': {'none': 3, 'standard': 1}, 'within': 2}
    assert s['deadlines']['5000'] == {'pred_tier': {'none': 2, 'standard': 2}, 'within': 3}
    assert cli.tierpass_summary([{**rows[0], 'deadline_ms': 5000}])['recorded_deadline_ms'] == 5000


# ---------------------------------------------------------------- final report (zero-discordance bounds, written text)

def test_join_records_assessor_latency_and_overhead_without_it():
    rid = 'r-ass'
    lab = routerlogs.label(rid)
    first = _log(session=lab, assessor={'tier': 'standard', 'status': 'ok', 'latencyMs': 1200, 'confidence': 0.88,
                                        'basis': ['bounded-change'], 'costUsd': 0.0007, 'applied': False})
    first['overheadMs'] = 1203
    j = routerlogs.join([first, _log(session=lab), _log(session=lab)], [rid])[rid]
    assert j['assessor_latency_ms'] == 1200 and j['assessor_confidence'] == 0.88 and j['assessor_basis'] == ['bounded-change']
    assert j['overhead_ms_p99'] == 1203 and j['overhead_ms_max_excl_assessor'] == 3


def test_ledger_keeps_the_runner_rate_for_later_readers(tmp_path):
    path = tmp_path / 'ledger.json'
    led = lg.Ledger(path, runner_usd_per_hour=0.5, runner_started_at=0.0, clock=lambda: 7200.0)
    led.charge('tierpass', 0.1, 'x')
    again = lg.Ledger(path, clock=lambda: 7200.0)
    assert again.runner_rate == 0.5 and again.runner_usd() == pytest.approx(1.0)


def test_zero_discordance_bounds_and_degenerate_intervals():
    assert report.zero_upper(60) == pytest.approx(0.0602, abs=1e-4) and report.zero_upper(10) == pytest.approx(0.2775, abs=1e-4)
    assert report.max_pair_disagreement(3) == pytest.approx(2 / 3) and report.max_pair_disagreement(2) == 1.0
    assert report._ci([0.0, 0.0], True) == '' and report._ci([0.1, 0.2], True) == ' [10.0, 20.0]'
    x = {'n': 30, 'resolve': {'n': 30, 'a_only': 0, 'b_only': 0, 'diff': 0.0, 'ci': [-0.08, 0.08]}}
    assert report._diff_cell(x, primary=False) == '0（0/30 不一致，差在 ±11.4 pp 内）'
    assert '[-8.0, 8.0]' in report._diff_cell(x, primary=True) and '|' not in report._diff_cell(x, primary=True)
    assert report.noise_upper({'runs_per_task': {'3': 20}, 'task_flip_ci': [0.0, 0.161]}) == pytest.approx(0.161 * 2 / 3)


def test_report_sections_from_run_rows():
    sel = _sel()
    rows = _rows(sel)
    for i, r in enumerate(rows):
        r.update(wall_s=30.0 + i % 7, codex_secs=20.0, ended_at='2026-11-05T10:00:00Z',
                 history_check={'leak': True, 'after': {'leak': False}},
                 patch={'stats': {'paths': ['a.py'], 'added': 1, 'removed': 0, 'bytes': 100 + (i % 2)}})
        r['calls'].update(calls=5 + i % 3, ttfb_ms_p50=600, usage={'prompt': 1000, 'output': 50})
        r['events'].update(commands=4, commands_failed=1)
    t0 = report._epoch('2026-11-05T08:00:00Z')
    data = report.build(rows, {}, sel, {'committed': {'main': 1.0}}, n_boot=100, runner={'started_at': t0, 'usd_per_hour': 0.5})
    assert data['runner'] == {'hours': 2.0, 'end': 'last-run-end', 'usd_per_hour': 0.5, 'usd': 1.0}
    assert data['history'] == {'runs': len(rows), 'checked': len(rows), 'leak_before': len(rows), 'leak_after': 0}
    assert data['timing']['A']['calls_p50'] is not None and data['timing']['A']['router_overhead_ms_p50'] is None
    assert data['C_vs_A']['same_patch_stats']['n'] == 20 and data['D_vs_A']['calls_sum']['D']['calls'] > 0
    eo = data['escalation_oracle']
    assert eo['n'] == 50 and eo['solved'] >= data['arms']['F']['resolved'] and set(data['failure_signals']) == {'F_solved', 'F_failed_A_solved', 'both_failed'}
    md = report.render(data)
    assert '## 摘要' in md and '## 7. 对路由策略的含义与下一步' in md and '### 实际观测' in md
    # Synthetic data breaks the premises the prose was written for: the report says so instead of printing it as fact.
    assert '⚠ 正文按下列前提写成' in md
    assert '[0.0, 0.0]' not in md
