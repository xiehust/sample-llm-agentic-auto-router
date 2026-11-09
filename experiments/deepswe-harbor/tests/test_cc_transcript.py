"""Claude Code transcripts (cc_transcript) and the Claude Code part of a harvest row (design-harness §4).
Synthetic trial dirs only: our own text, no Claude Code prompt, no task text."""
import json

import pytest

import hcommon  # noqa: F401  isort: skip  (sys.path for codex-deepswe's common)
import cc_transcript as T
import common
import harvest

SONNET = 'global.anthropic.claude-sonnet-5-5'


def _write(p, recs):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(''.join((r if isinstance(r, str) else json.dumps(r)) + '\n' for r in recs))


def _tu(i, name, inp):
    return {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': 'hmm', 'signature': 'sig'},
                                                                              {'type': 'tool_use', 'id': i, 'name': name, 'input': inp}]}}


def _tr(i, out):
    return {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': i, 'content': out}]}}


def _trial(root, result=True):
    """<jobs>/<trial_id>/<trial_name>/ with agent/sessions (main + one subagent) and agent/claude-code.txt."""
    t = root / 'jobs' / 'tid1' / 'task__abc'
    proj = t / 'agent' / 'sessions' / 'projects' / '-testbed'
    _write(proj / 's1.jsonl', [{'type': 'api-request-blob', 'body': {'messages': [{'content': 'instruction text'}]}},
                               _tu('t1', 'Bash', {'command': 'ls', 'description': 'List'}), _tr('t1', 'a.py\nb.py'),
                               _tu('t2', 'Agent', {'prompt': 'look', 'subagent_type': 'Explore'}), _tr('t2', [{'type': 'text', 'text': 'found'}]),
                               {'type': 'system', 'subtype': 'compact_boundary'}, 'not json',
                               _tu('t3', 'WebFetch', {'url': 'https://x.example'}), _tr('t3', 'denied')])
    _write(proj / 's1' / 'subagents' / 'agent-a1.jsonl', [_tu('u1', 'Grep', {'pattern': 'def add'}), _tr('u1', 'calc.py:1')])
    events = [{'type': 'system', 'subtype': 'init'}, {'type': 'assistant'}]
    if result:
        events.append({'type': 'result', 'subtype': 'success', 'is_error': False, 'num_turns': 7, 'terminal_reason': 'completed',
                       'duration_ms': 1000, 'duration_api_ms': 800, 'api_error_status': None, 'result': 'the final answer text',
                       'permission_denials': [{'tool_name': 'WebFetch'}], 'subagent_stats': {'spawned': 1, 'failed': 0, 'by_type': {'Explore': 1}},
                       'modelUsage': {SONNET: {'inputTokens': 10, 'outputTokens': 5, 'cacheReadInputTokens': 100, 'cacheCreationInputTokens': 20,
                                               'costUSD': 0.1}}})
    _write(t / 'agent' / 'claude-code.txt', events)
    (t / 'result.json').write_text(json.dumps({'trial_name': 'task__abc', 'agent_info': {'version': '2.1.318'}}))
    return t


def test_units_pair_outputs_with_their_tool_use_and_skip_request_blobs(tmp_path):
    t = _trial(tmp_path)
    src, actions, outputs, out_src = T.units(t / 'agent')
    assert src == 'cc-session' and len(actions) == 4 and len(outputs) == 4
    assert all('instruction text' not in a for a in actions)
    assert [actions[k].split('\n')[0] for k in out_src] == ['ls', 'look', 'https://x.example', 'def add']
    assert outputs[1] == 'found'


def test_units_fall_back_to_stream_json_and_none_without_either(tmp_path):
    t = tmp_path / 'a'
    _write(t / 'claude-code.txt', [_tu('t1', 'Bash', {'command': 'pwd'}), _tr('t1', '/testbed'), {'type': 'result', 'subtype': 'success'}])
    assert T.units(t) == ('claude-code.txt', ['pwd'], ['/testbed'], [0])
    assert T.units(tmp_path / 'empty') is None


def test_summary_is_text_free(tmp_path):
    t = _trial(tmp_path)
    s = T.summary(t / 'agent')
    r = s['result']
    assert r['status'] == 'present' and r['subtype'] == 'success' and r['num_turns'] == 7 and r['permission_denials'] == 1
    assert r['subagents'] == {'spawned': 1, 'failed': 0, 'by_type': {'Explore': 1}}
    assert r['model_usage'] == {SONNET: {'inputTokens': 10, 'outputTokens': 5, 'cacheReadInputTokens': 100, 'cacheCreationInputTokens': 20}}
    assert s['transcript'] == {'files_main': 1, 'files_subagent': 1, 'compactions': 1,
                               'tool_calls': {'Agent': 1, 'Bash': 1, 'Grep': 1, 'WebFetch': 1}, 'disallowed_tool_calls': 1}
    text = json.dumps(s)
    assert 'final answer' not in text and 'a.py' not in text and 'def add' not in text


def test_summary_without_a_result_event(tmp_path):
    t = _trial(tmp_path, result=False)
    s = T.summary(t / 'agent')
    assert s['result'] == {'status': 'missing'} and s['results'] == 0


@pytest.fixture(autouse=True)
def _region():
    common.set_region('ap-southeast-1')


def _call(seq, role, cost, **kw):
    return {'run_id': 'tid1', 'trial_id': 'tid1', 'arm': 'A', 'seq': seq, 'leaf': 'messages', 'status': 200, 'call_type': 'main',
            'call_role': role, 'call_role_struct': role, 'requested_model': SONNET, 'served_model': SONNET, 'cost_usd': cost,
            'usage': {'prompt': 100, 'uncached': 10, 'read': 80, 'write': 10, 'write_5m': 0, 'write_1h': 10, 'output': 5, 'reasoning': 0},
            'run_spent_usd': cost * seq, 'terminal': 'message_stop', **kw}


def test_harvest_row_has_the_claude_code_fields(tmp_path):
    _trial(tmp_path)
    calls = [_call(1, 'main', 0.01, sanitized=['user_id']), _call(2, 'main_subagent', 0.02), _call(3, 'main', 0.03)]
    meta = {'trial_id': 'tid1', 'arm': 'A', 'jobs_dir': str(tmp_path / 'jobs'), 'is_final': True, 'final_status': 'scored',
            'class': 'agent', 'score': 1, 'task': 'some-task', 'claude_build': 'linux-x64'}
    row = harvest.row(meta, calls)
    assert row['agent'] == 'claude-code' and row['codex'] is None
    c = row['claude']
    assert c['version'] == '2.1.318' and c['build'] == 'linux-x64' and c['effort'] == 'high' and c['client_model'] == SONNET
    assert c['result']['subtype'] == 'success' and c['transcript']['files_subagent'] == 1
    by = row['calls_by_role']
    assert by['main']['calls'] == 2 and by['main_subagent']['calls'] == 1 and by['helper']['calls'] == 0
    assert by['main']['cost_usd'] == 0.04 and by['main']['served_models'] == {SONNET: 2}
    assert set(by['main']) >= {'calls', 'prompt', 'uncached', 'read', 'write_5m', 'write_1h', 'output', 'cost_usd', 'served_models'}
    assert row['roles_null'] == 0 and row['sanitized_requests'] == 1
    assert SONNET in row['tokens_by_model']
    assert 'final answer' not in json.dumps(row)


def test_codex_rows_are_unchanged(tmp_path):
    meta = {'trial_id': 'tid2', 'arm': 'A', 'is_final': True, 'final_status': 'scored', 'class': 'agent', 'score': 0}
    row = harvest.row(meta, [{**_call(1, None, 0.01), 'leaf': 'responses'}])
    assert 'agent' not in row and 'calls_by_role' not in row
