"""signals.py and simulate.py on synthetic rollouts and runs (our own text; no task data)."""
import json
import math

import signals as S
import simulate as M


def _rollout(tmp_path, events):
    p = tmp_path / 'agent' / 'sessions' / '2026' / '11' / '07'
    p.mkdir(parents=True)
    lines = [{'type': 'session_meta', 'payload': {}}]
    total = 0
    for kind, *a in events:
        if kind == 'call':                 # (call_id, name, args)
            lines.append({'type': 'response_item', 'payload': {'type': 'function_call', 'call_id': a[0], 'name': a[1], 'arguments': json.dumps(a[2])}})
        elif kind == 'out':                # (call_id, output text)
            lines.append({'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': a[0], 'output': a[1]}})
        elif kind == 'resp':               # (input tokens, output tokens): one model response
            total += a[0] + a[1]
            lines.append({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'total_tokens': total}, 'last_token_usage': {'input_tokens': a[0], 'output_tokens': a[1]}}}})
        elif kind == 'dup':                # a repeated token_count (as around a compaction)
            lines.append({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'total_tokens': total}, 'last_token_usage': {'input_tokens': 0, 'output_tokens': 0}}}})
        elif kind == 'compacted':
            lines.append({'type': 'compacted', 'payload': {}})
    f = p / 'rollout-x.jsonl'
    f.write_text('\n'.join(json.dumps(x) for x in lines) + '\n')
    return [f]


def _exit(code):
    return f'Chunk ID: ab\nWall time: 0.1 seconds\nProcess exited with code {code}\nOriginal token count: 3\nOutput:\nsynthetic\n'


def test_series_counts_exits_tests_sessions_repeats_and_compactions(tmp_path):
    # Codex order per response k: its function_call, the tool output, then token_count (the state before request k+1).
    ev = [('call', 'c1', 'exec_command', {'cmd': 'ls -la'}), ('out', 'c1', _exit(0)), ('resp', 1000, 10),
          ('call', 'c2', 'exec_command', {'cmd': 'python -m pytest -q tests'}), ('out', 'c2', _exit(1)), ('resp', 1100, 10),
          ('call', 'c3', 'exec_command', {'cmd': 'go test ./...'}), ('out', 'c3', 'Process running with session ID 7\n'), ('resp', 1300, 10),
          ('call', 'c4', 'write_stdin', {'session_id': 7, 'chars': ''}), ('out', 'c4', _exit(2)), ('dup',), ('resp', 1400, 10),
          ('compacted',), ('dup',),
          ('call', 'c5', 'exec_command', {'cmd': 'python  -m pytest -q tests'}), ('out', 'c5', _exit(0)), ('resp', 1500, 10),
          ('resp', 400, 10)]
    s = S.series(_rollout(tmp_path, ev))
    assert [x['k'] for x in s] == [1, 2, 3, 4, 5, 6]               # duplicates are not calls; the last snapshot is dropped
    assert s[0]['tool_calls'] == 0 and s[0]['prompt_tokens'] == 0
    assert s[1]['tool_calls'] == 1 and s[1]['exec_nonzero'] == 0 and s[1]['prompt_tokens'] == 1000
    assert s[2]['exec_nonzero'] == 1 and s[2]['test_fail'] == 1 and s[2]['consec_nonzero'] == 1 and s[2]['prompt_tokens'] == 1100
    assert s[3]['test_runs'] == 1                                   # the go test session is still running at call 4
    assert s[4]['test_runs'] == 2 and s[4]['consec_test_fail'] == 2 and s[4]['consec_nonzero'] == 2
    assert s[5]['compactions'] == 1 and s[5]['repeat_cmd'] == 1 and s[5]['consec_nonzero'] == 0   # whitespace-normalised repeat
    assert all(x['turn_index'] == 0 and x['prev_turn_tool_errors'] == 0 for x in s)


def test_test_and_look_command_shapes():
    for c in ('pytest -x', 'cd /app && go test ./pkg/...', 'npm run test', 'cargo test --all', './run_tests.sh', 'bash tests/test.sh'):
        assert S.is_test_cmd(c), c
    for c in ('ls', 'git diff', 'pip install pytest-cov', 'cat test_notes.txt'):
        assert not S.is_test_cmd(c), c
    assert S.is_look_cmd('sed -n 1,20p a.py') and not S.is_look_cmd('python a.py')


def _run(costs, prompts, rollout=None, timeout=1000.0, ledger=None, arm='A', task='t1', rid='r'):
    n = len(costs)
    return {'run_id': rid, 'task_id': task, 'arm': arm, 'ledger_usd': ledger if ledger is not None else sum(costs), 'agent_timeout_s': timeout,
            'call_cost': costs, 'call_prompt': prompts, 'call_t': [10.0 * i for i in range(n)], 'call_usage': [[0, p, 0, 100] for p in prompts],
            'has_rollout': rollout is not None, 'series': rollout or []}


def test_router_state_detects_compaction_by_shrink():
    r = _run([0.1] * 6, [1000, 50000, 100000, 30000, 40000, 20000])
    assert M.router_state(r, 1) == {'k': 1, 'prompt_tokens': 0, 'spend_usd': 0, 'compactions': 0}
    assert M.router_state(r, 4)['compactions'] == 0 and M.router_state(r, 5)['compactions'] == 1
    assert M.router_state(r, 6)['compactions'] == 1                 # 40k is not below 0.6 × 30k
    assert math.isclose(M.router_state(r, 4)['spend_usd'], 0.3)


def test_fire_k_router_and_body_signals_and_missing_rollout():
    body = [{'k': i + 1, 'consec_nonzero': c} for i, c in enumerate([0, 0, 1, 2, 3, 3])]
    r = _run([0.1] * 6, [1000] * 6, rollout=body)
    fb = {'kq': {'SA': {'0.75': 5}}, 'constants': {'R8_spend': 0.25}}
    assert M.fire_k(r, {'any': [{'signal': 'consec_nonzero', 'ge': 3}]}, fb, 'SA') == 5
    assert M.fire_k(r, {'any': [{'signal': 'k', 'ge_kq': 0.75}]}, fb, 'SA') == 5
    assert M.fire_k(r, {'any': [{'signal': 'spend_usd', 'ge_const': 'R8_spend'}]}, fb, 'SA') == 4
    no = _run([0.1] * 6, [1000] * 6)
    assert M.fire_k(no, {'any': [{'signal': 'consec_nonzero', 'ge': 0}]}, fb, 'SA') is None      # no rollout: body never fires
    assert M.fire_k(no, {'any': [{'signal': 'consec_nonzero', 'ge': 3}, {'signal': 'k', 'ge': 2}]}, fb, 'SA') == 2
    short = _run([0.1] * 6, [1000] * 6, rollout=body[:3])          # carried forward past the rollout's end
    assert M.fire_k(short, {'any': [{'signal': 'consec_nonzero', 'ge': 1}]}, fb, 'SA') == 3


def test_simulate_rule_scenarios_costs_and_late_fire():
    src = [_run([0.1] * 4, [10000] * 4, ledger=0.4, rid='s1'), _run([0.1] * 4, [10000] * 4, ledger=0.4, rid='s2'),
           _run([0.1] * 4, [10000] * 4, ledger=0.4, rid='s3')]
    tgt = {'t1': [_run([1.0] * 3, [10000] * 3, ledger=3.0, arm='C', rid='g1'), _run([1.0] * 3, [10000] * 3, ledger=3.0, arm='C', rid='g2')]}
    y = {'s1': False, 's2': True, 's3': False, 'g1': True, 'g2': False}
    fire = {'s1': 3, 's2': None, 's3': 4}
    src[2]['agent_timeout_s'] = 32.0               # call 4 starts at 30 s: 2 s left < 15% of 32 s → late
    sim = M.simulate_rule(src, tgt, lambda r: fire[r['run_id']], lambda r: y[r['run_id']], 'C')['t1']
    a, b, c = sim
    assert a['M1'] == 0.5 and a['M2'] == 0.5 and a['M2_self'] == 0.5 and a['M0'] == 0.0
    u = 10000 * 12.5 / 1e6
    assert math.isclose(a['high'], 0.2 + u + 3.0)
    assert math.isclose(a['tail'], 0.2 + u + 0.0)                   # the target runs have no call past k = 3
    assert math.isclose(a['splice'], 0.2 + u + 100 * 50 / 1e6 + (10000 * 1.0 + 100 * 50) / 1e6)
    assert b['M2'] == 1.0 and b['high'] == 0.4                      # not fired: own outcome and cost
    assert c['late'] and c['M1'] == 0.0 and c['M2'] == 0.0          # late fire keeps y
    rows = M.task_rows({'t1': sim}, {'t1': {'sol_p': 0.0, 'sol_c': 0.0, 'tgt_c': 3.0}}, True)
    e = M.estimands(rows)
    assert math.isclose(e['M2_vs_sol_pp'], 100 * ((0.5 + 1 + 0) / 3 - 1 / 3))
    assert math.isclose(e['spec_pp'], e['M2_vs_sol_pp'] - e['M2_self_vs_sol_pp'])


def test_auc_weighted_and_ties():
    assert M.auc([(3, 1), (2, 1)], [(1, 1), (0, 1)]) == 1.0
    assert M.auc([(1, 1)], [(1, 1)]) == 0.5
    assert M.auc([(2, 3), (0, 1)], [(1, 1)]) == 0.75
    assert M.auc([], [(1, 1)]) is None


def test_quantile_ceil_and_boot_is_deterministic():
    assert M.quantile_ceil([1, 2, 3, 4], 0.5) == 3 and M.quantile_ceil([10, 20], 0.9) == 19
    rows = [{**{s: float(i % 2) for s in M.SCEN}, **{c: 1.0 + i for c in M.COSTS}, 'sol_p': 0.5, 'tgt_p': 0.5, 'sol_c': 1.0, 'tgt_c': 2.0} for i in range(10)]
    a = M.boot(rows, ['M2_vs_sol_pp', 'cost_high_vs_sol'], 7, 200)
    assert a == M.boot(rows, ['M2_vs_sol_pp', 'cost_high_vs_sol'], 7, 200) and a['M2_vs_sol_pp'][0] <= 0 <= a['M2_vs_sol_pp'][1]


def test_prices_match_the_catalog():
    import pathlib
    import re
    cat = (pathlib.Path(M.ROOT).parent / 'packages' / 'pricing' / 'src' / 'catalog.data.ts').read_text()
    for arm, model in (('A', 'global.openai.gpt-6.1-sol'), ('C', 'global.openai.gpt-6-astra'), ('F', 'global.openai.gpt-6-luna')):
        i = cat.index(f'"modelId": "{model}"', cat.index('"ap-southeast-1"'))
        block = re.sub(r'\s', '', cat[i:i + 1200])
        m = re.search(r'"price":\{"input":([\d.]+),"output":([\d.]+),"cacheRead":([\d.]+),"cacheWrite":\{"30m":([\d.]+)\}', block)
        assert m and [float(x) for x in m.groups()] == [M.PRICES[arm][k] for k in ('input', 'output', 'read', 'write')], arm
