"""claude-code-harbor tier pass (design-assessor.md §3): template, bodies, fidelity and summary on synthetic data only, plus an
offline end-to-end run of tierpass.ts (cards built and checked, no model call)."""
import json
import pathlib
import subprocess  # nosec B404 - fixed argv: node tierpass.ts
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import tierpass as tp  # noqa: E402

REMINDER = '<system-reminder>\nAs you answer, use this context:\n# currentDate\nToday is a day.\n</system-reminder>'
TAIL = '<system-reminder>\nNo tasks yet.\n</system-reminder>'


def captured(instruction, joined=False):
    content = ([{'type': 'text', 'text': f'{REMINDER}\n{instruction}\n{TAIL}'}] if joined else
               [{'type': 'text', 'text': REMINDER}, {'type': 'text', 'text': instruction}, {'type': 'text', 'text': TAIL}])
    return {'model': 'claude-x', 'max_tokens': 1000,
            'system': [{'type': 'text', 'text': 'You are a coding CLI.'}, {'type': 'text', 'text': 'Working directory: /app\nIs git repo: yes'}],
            'tools': [{'name': 'Bash', 'input_schema': {}}, {'name': 'Read', 'input_schema': {}}],
            'messages': [{'role': 'user', 'content': content}]}


def make_tasks(root, specs):
    for tid, (text, wd) in specs.items():
        d = root / tid / 'environment'
        d.mkdir(parents=True)
        (root / tid / 'instruction.md').write_text(text, encoding='utf-8')
        (d / 'Dockerfile').write_text(f'FROM scratch\nWORKDIR {wd}\n', encoding='utf-8')


@pytest.mark.parametrize('joined', [False, True])
def test_template_round_trip(joined):
    tmpl, form = tp.template_of(captured('Fix the parser.', joined), 'Fix the parser.')
    assert form == ('joined' if joined else 'block')
    body = tp.task_body(tmpl, 'Repair the lexer.')
    texts = [c['text'] for c in tp.user_text_blocks(body)]
    assert any('Repair the lexer.' in t for t in texts) and not any(tp.PLACEHOLDER in t for t in texts)


def test_template_refuses_ambiguous_or_missing():
    with pytest.raises(ValueError):
        tp.template_of(captured('Other text.'), 'Fix the parser.')
    b = captured('Fix the parser.')
    b['messages'][0]['content'].append({'type': 'text', 'text': 'Fix the parser.'})
    with pytest.raises(ValueError):
        tp.template_of(b, 'Fix the parser.')


def test_set_workdir_is_path_bounded():
    b = captured('x')
    b['system'][1]['text'] = 'Working directory: /app\nalso /application and /app/src'
    n = tp.set_workdir(b, '/app', '/testbed')
    assert n == 2 and b['system'][1]['text'] == 'Working directory: /testbed\nalso /application and /testbed/src'
    assert tp.set_workdir(b, '/same', '/same') == 0
    # Claude Code 2.1: the cwd sits in a system-role message after the prompt.
    b['messages'].append({'role': 'system', 'content': [{'type': 'text', 'text': '# Environment\n - Primary working directory: /tmp/cap/repo'}]})
    assert tp.set_workdir(b, '/tmp/cap/repo', '/app') == 1
    assert b['messages'][-1]['content'][0]['text'].endswith('directory: /app')


def test_majority_and_kappa():
    assert tp.majority(['standard'] * 3) == 'standard'
    assert tp.majority(['standard', 'standard', 'none']) == 'standard'
    assert tp.majority(['fast', 'standard', 'frontier']) == 'mixed'
    assert tp.kappa([('a', 'a'), ('b', 'b')]) == 1.0
    assert tp.kappa([('a', 'a'), ('a', 'a')]) is None


def row(ds, tid, pred, rep, **kw):
    r = {'dataset': ds, 'task_id': tid, 'rep': rep, 'status': 'ok', 'pred': pred, 'within_deadline': True, 'latency_ms': 1400,
         'cost_usd': 0.0003, 'outcome': pred if pred != 'none' else 'low-confidence',
         'facts': {'scope': 'single-file', 'specification': 'fully-specified', 'reasoning_depth': 'routine', 'prior_failures': 0, 'edits_code': True}}
    r.update(kw)
    return r


def test_summarize_mix_agreement_and_arm_share():
    cc = [row('tb21', 't1', 'standard', i) for i in (1, 2, 3)] + [row('tb21', 't2', 'frontier', 1), row('tb21', 't2', 'frontier', 2),
                                                                   row('tb21', 't2', 'none', 3, within_deadline=False)]
    cx = [row('tb21', t, 'standard', i) for t in ('t1', 't2') for i in (1, 2, 3)]
    s = tp.summarize(cc, cx, 'tb21')
    assert s['tasks'] == 2 and s['calls'] == 6
    assert s['call_mix'] == {'fast': 0, 'standard': 3, 'frontier': 2, 'none': 1}
    assert s['task_majority'] == {'standard': 1, 'frontier': 1}
    assert s['vs_codex']['majority_agreement'] == 0.5
    assert s['no_opinion_reasons'] == {'past-deadline': 1}
    assert s['bad_calls'] == 1
    assert s['arm_b_session_share'] == {'A (Sonnet)': round((1 + 1 / 3) / 2, 3), 'C (Opus)': round((2 / 3) / 2, 3)}
    assert s['facts_vs_codex']['scope']['agreement'] == 1.0


def test_end_to_end_offline_cards_and_fidelity(tmp_path, monkeypatch):
    """bodies → tierpass.ts (offline cards, checks) → capture-bodies → fidelity, all synthetic, no model call."""
    tasks = tmp_path / 'tasks'
    make_tasks(tasks, {'task-a': ('Fix the parser so empty input is accepted.', '/app'),
                       'task-b': ('Make the build reproducible.', '/testbed')})
    cap = tmp_path / 'cap.json'
    cap.write_text(json.dumps(captured('Fix the parser so empty input is accepted.')), encoding='utf-8')
    monkeypatch.setattr(tp, 'OUT', tmp_path / 'out')
    tp.main.__globals__['sys'].argv = ['tierpass.py', 'bodies', '--dataset', 'tb21', '--tasks-dir', str(tasks),
                                       '--captured-body', str(cap), '--captured-task', 'task-a']
    tp.main()
    bodies = tmp_path / 'out' / 'bodies-tb21.jsonl'
    rows = [json.loads(x) for x in bodies.read_text().splitlines()]
    assert [r['task_id'] for r in rows] == ['task-a', 'task-b']
    assert 'Working directory: /testbed' in rows[1]['body']['system'][1]['text']
    split = tmp_path / 'split.jsonl'
    split.write_text(''.join(json.dumps({'dataset': 'tb21', 'split': 'tune', 'task_id': t}) + '\n' for t in ('task-a', 'task-b')))
    cards = tmp_path / 'cards.jsonl'
    ts = HERE / 'tierpass.ts'
    run = subprocess.run(['node', str(ts), '--bodies', str(bodies), '--split', str(split), '--pack', 'v2.2', '--region', 'ap-southeast-1',  # nosec B603 B607
                          '--cards-out', str(cards)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout)['cards'] == 2
    got = {json.loads(x)['task_id']: json.loads(x)['card'] for x in cards.read_text().splitlines()}
    assert got['task-a']['latestUser']['text'] == 'Fix the parser so empty input is accepted.'
    assert got['task-b']['latestUser']['text'] == 'Make the build reproducible.'
    # Fidelity: a "real capture" of task-b (here: the template body itself) gives the same card.
    capb = tmp_path / 'capb.json'
    capb.write_text(json.dumps(rows[1]['body']), encoding='utf-8')
    tp.main.__globals__['sys'].argv = ['tierpass.py', 'capture-bodies', '--dataset', 'tb21', '--tasks-dir', str(tasks), '--capture', f'task-b={capb}']
    tp.main()
    capcards = tmp_path / 'capcards.jsonl'
    run = subprocess.run(['node', str(ts), '--bodies', str(tmp_path / 'out' / 'capture-bodies-tb21.jsonl'), '--split', str(split),  # nosec B603 B607
                          '--pack', 'v2.2', '--region', 'ap-southeast-1', '--cards-out', str(capcards)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    tp.main.__globals__['sys'].argv = ['tierpass.py', 'fidelity', '--template-cards', str(cards), '--capture-cards', str(capcards)]
    tp.main()
    assert json.loads((tmp_path / 'out' / 'fidelity.json').read_text())['pass'] is True


def test_card_check_rejects_unfiltered_reminder(tmp_path):
    """A body whose instruction block itself starts with reminder-like text the filter keeps (middle) fails the check."""
    body = captured('x')
    body['messages'][0]['content'] = [{'type': 'text', 'text': 'Note <system-reminder>keep</system-reminder> Fix it.'}]
    bodies = tmp_path / 'b.jsonl'
    bodies.write_text(json.dumps({'dataset': 'tb21', 'task_id': 't', 'instruction_head': 'Note', 'body': body}) + '\n')
    split = tmp_path / 's.jsonl'
    split.write_text(json.dumps({'dataset': 'tb21', 'split': 'tune', 'task_id': 't'}) + '\n')
    run = subprocess.run(['node', str(HERE / 'tierpass.ts'), '--bodies', str(bodies), '--split', str(split), '--pack', 'v2.2',  # nosec B603 B607
                          '--region', 'ap-southeast-1'], capture_output=True, text=True, timeout=120)
    assert run.returncode != 0 and 'system-reminder' in run.stderr


def test_fidelity_masks_only_the_billing_suffix():
    head = 'x-anthropic-billing-header: cc_version=2.1.318.a1f; cc_entrypoint=sdk-cli;\nYou are a coding CLI.'
    card = {'role': {'systemHead': head}, 'stats': {'estPromptTokens': 1}}
    other = {'role': {'systemHead': head.replace('.a1f;', '.0c9;')}, 'stats': {'estPromptTokens': 1}}
    assert tp.masked(card) == tp.masked(other)
    assert tp.masked(card)['role']['systemHead'].startswith('x-anthropic-billing-header: cc_version=2.1.318.xxx;')
    changed = {'role': {'systemHead': head.replace('coding CLI', 'other CLI')}, 'stats': {'estPromptTokens': 1}}
    assert tp.masked(card) != tp.masked(changed)
