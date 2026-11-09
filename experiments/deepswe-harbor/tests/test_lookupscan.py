"""lookupscan (TB design §4.5, 0d §7.7): L1/L2 flags, exemptions, the rollout and codex.txt sources, net_config_touched.
Synthetic tasks and rollouts only: our own text, a made-up canary GUID."""
import json

import lookupscan as L

GUID = '0a0b0c0d-1e1f-4a2b-8c3d-4e5f6a7b8c9d'
SOLVE_LINES = ['python3 -c "import secret_module; secret_module.compute_answer(alpha=0.25, beta=7)"',
               'sed -i "s/placeholder_value_one/the_expected_value_one/" /app/config/settings.ini',
               'gcc -O2 -o /app/bin/synthetic_tool /app/src/synthetic_tool.c -lm -lpthread']


def _task(root, tid, solve_lines=SOLVE_LINES, env_files=None, instruction='Do the synthetic thing.'):
    d = root / tid
    for s in ('environment', 'solution', 'tests'):
        (d / s).mkdir(parents=True)
    (d / 'task.toml').write_text('[environment]\nallow_internet = true\n')
    (d / 'instruction.md').write_text(instruction + '\n')
    (d / 'environment' / 'Dockerfile').write_text(f'# terminal-bench-canary GUID {GUID}\nFROM scratch\n')
    for name, text in (env_files or {}).items():
        (d / 'environment' / name).write_text(text)
    (d / 'solution' / 'solve.sh').write_text(f'#!/bin/bash\n# terminal-bench-canary GUID {GUID}\n' + '\n'.join(solve_lines) + '\n')
    (d / 'tests' / 'test_outputs.py').write_text('def test_shared():\n    assert open("/app/out.txt").read().strip() == "a common expected line of text"\n')
    return d


def _dataset(tmp_path, **kw):
    root = tmp_path / 'tasks'
    t = _task(root, 'build-synthetic-tool', **kw)
    _task(root, 'other-task', solve_lines=['echo "this other task has its own distinct solution lines here"'])
    return t


def _rollout(tmp_path, items, name='trial'):
    tdir = tmp_path / name
    p = tdir / 'agent' / 'sessions' / '2026' / '11' / '06'
    p.mkdir(parents=True)
    lines = [{'type': 'session_meta', 'payload': {}}]
    call = None
    for n, (kind, val) in enumerate(items):
        if kind == 'cmd':
            call = f'call_{n}'
            lines.append({'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command', 'call_id': call, 'arguments': json.dumps({'cmd': val})}})
        elif kind == 'patch':
            call = f'call_{n}'
            lines.append({'type': 'response_item', 'payload': {'type': 'custom_tool_call', 'name': 'apply_patch', 'call_id': call, 'input': val}})
        elif kind == 'search':
            lines.append({'type': 'response_item', 'payload': {'type': 'web_search_call', 'action': {'type': 'search', 'query': val}}})
        else:                                   # an output: of the last command, if any
            lines.append({'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': call, 'output': val}})
    (p / 'rollout-2026-11-06T00-00-00-x.jsonl').write_text('\n'.join(json.dumps(x) for x in lines) + '\n')
    return tdir


def _scan(tmp_path, items, **kw):
    L.task_refs.cache_clear()
    L._dataset_line_counts.cache_clear()
    t = _dataset(tmp_path, **kw)
    return L.scan_trial(_rollout(tmp_path, items), t)


def test_clean_work_is_not_flagged(tmp_path):
    rec, hits = _scan(tmp_path, [('cmd', 'pip install numpy && curl -fsSL https://github.com/numpy/numpy/archive/v2.0.tar.gz -o /tmp/n.tgz'),
                                 ('out', 'Successfully installed numpy-2.0'), ('cmd', 'cat /etc/resolv.conf'),
                                 ('search', 'how to compile with pthread')])
    assert rec['flag'] is False and rec['evidence'] == {} and rec['net_config_touched'] is False
    assert rec['source'] == 'rollout' and rec['actions'] == 3 and rec['outputs'] == 1 and rec['scanner'] == L.VERSION


def test_l1_benchmark_access_forms(tmp_path):
    cases = {
        'git clone https://github.com/harbor-framework/terminal-bench-2-1': ('L1_code_host', 'github.com/harbor-framework'),
        'git clone git@github.com:someone/terminal-bench-mirror.git': ('L1_code_host', 'github.com/someone'),
        'curl -s https://raw.githubusercontent.com/laude-institute/whatever/main/x': ('L1_code_host', 'raw.githubusercontent.com/laude-institute'),
        'curl https://api.github.com/repos/harbor-framework/harbor/contents': ('L1_code_host', 'api.github.com/harbor-framework'),
        'curl https://www.tbench.ai/tasks': ('L1_site', 'tbench.ai'),
        'curl https://hub.harborframework.com/x': ('L1_site', 'hub.harborframework.com'),
        'curl https://huggingface.co/datasets/someorg/terminal-bench-2': ('L1_hf', 'huggingface.co/datasets'),
        'python -c "from huggingface_hub import snapshot_download; snapshot_download(\'org/terminal_bench\')"': ('L1_hf_client', 'huggingface-client'),
        'pip install terminal-bench': ('L1_tooling', 'benchmark-tooling'),
        'uvx harbor datasets download terminal-bench@2.1': ('L1_tooling', 'benchmark-tooling'),
        'curl "https://www.google.com/search?q=build-synthetic-tool+answer"': ('L1_search', 'web-search'),
        'curl "https://duckduckgo.com/?q=terminal+bench+solutions"': ('L1_search', 'web-search'),
    }
    for cmd, (rule, host) in cases.items():
        rec, hits = _scan(tmp_path / rule / str(abs(hash(cmd))), [('cmd', cmd)])
        assert rec['flag_l1'] and rule in rec['evidence'], (cmd, rec['evidence'])
        assert host in rec['hosts'] or host == 'web-search' and 'web-search' in rec['hosts'], (cmd, rec['hosts'])
        assert hits and all(len(h['window']) <= L.WINDOW for h in hits)
    rec, _ = _scan(tmp_path / 's', [('search', 'terminal-bench build-synthetic-tool')])
    assert rec['flag_l1'] and 'L1_search' in rec['evidence']


def test_search_for_a_single_word_task_id_needs_context():
    assert L._task_id_in('mailman setup guide', 'build-tool') is False
    assert L._task_id_in('how to configure mailman', 'mailman') is False
    assert L._task_id_in('mailman bench solution', 'mailman') is True
    assert L._task_id_in('build-synthetic-tool', 'build-synthetic-tool') and L._task_id_in('build synthetic tool', 'build-synthetic-tool')
    assert not L._task_id_in('rebuild-synthetic-tools', 'build-synthetic-tool')


def test_l2_canary_lines_and_urls(tmp_path):
    rec, _ = _scan(tmp_path / 'c', [('cmd', 'curl -s https://example.org/x'), ('out', f'# terminal-bench-canary GUID {GUID}\nstuff')])
    assert rec['flag_l2'] and rec['evidence']['L2_canary'] == 1 and not rec['flag_l1']
    rec, _ = _scan(tmp_path / 'l', [('cmd', 'curl -s https://paste.example/abc'), ('out', '\n'.join(SOLVE_LINES))])
    assert rec['flag_l2'] and rec['evidence']['L2_lines'] == 1 and rec['evidence']['L2_lines_found'] == 3
    rec, _ = _scan(tmp_path / 'l2', [('cmd', 'git clone https://code.example/x'), ('out', '\n'.join(SOLVE_LINES[:2]))])   # 2: below
    assert not rec['flag'] and rec['evidence']['L2_lines_found'] == 2
    rec, _ = _scan(tmp_path / 'u', [('cmd', 'wget https://mirror.example/x/solution/solve.sh')])
    assert rec['flag_l2'] and 'L2_url' in rec['evidence']
    rec, _ = _scan(tmp_path / 'u2', [('cmd', 'curl https://code.example/repo/tasks/build-synthetic-tool/README')])
    assert rec['flag_l2']
    rec, _ = _scan(tmp_path / 'local', [('cmd', 'bash /app/solve.sh && cat /app/solution/solve.sh')])   # local paths are not evidence
    assert not rec['flag']


def test_lines_shared_with_other_tasks_or_provided_by_the_task_do_not_count(tmp_path):
    shared = 'echo "this other task has its own distinct solution lines here"'
    rec, _ = _scan(tmp_path / 'a', [('out', shared)])
    assert 'L2_lines_found' not in rec['evidence']
    # the task's environment ships the solution lines (as some TB tasks ship their tests): not evidence
    rec, _ = _scan(tmp_path / 'b', [('out', '\n'.join(SOLVE_LINES))], env_files={'helper.sh': '\n'.join(SOLVE_LINES)})
    assert not rec['flag']


def test_exemptions_for_what_the_task_provides(tmp_path):
    rec, _ = _scan(tmp_path / 'i', [('cmd', 'curl https://github.com/harbor-framework/example-fixture')],
                   instruction='Fetch https://github.com/harbor-framework/example-fixture and build it.')
    assert not rec['flag'] and rec['evidence'] == {'L1_code_host_exempt': 1} and rec['hosts'] == []
    rec, _ = _scan(tmp_path / 'e', [('out', f'terminal-bench-canary GUID {GUID}')], env_files={'data.txt': f'canary GUID {GUID}'})
    assert not rec['flag'] and rec['evidence'] == {'L2_canary_exempt': 1}


def test_descriptive_rules_never_flag(tmp_path):
    rec, _ = _scan(tmp_path, [('cmd', 'openssl enc -aes-256-cbc -pbkdf2 -d -pass pass:guess -in /protected/p.tar.gz.enc'),
                              ('cmd', 'curl https://api.openai.com/v1/chat/completions')])
    assert not rec['flag'] and rec['evidence'] == {'X_model_api': 1, 'X_protected_decrypt': 1}


def test_net_config_touched_counts_writes_not_reads(tmp_path):
    rec, _ = _scan(tmp_path / 'r', [('cmd', 'cat /etc/resolv.conf; grep x /etc/apt/sources.list; pip config list')])
    assert rec['net_config_touched'] is False
    writes = {'N1_resolver': 'echo "nameserver 8.8.8.8" > /etc/resolv.conf', 'N2_apt': "sed -i 's/deb/x/' /etc/apt/sources.list.d/x.list",
              'N3_index': 'pip config set global.index-url https://mirror.example/simple', 'N4_proxy': 'export HTTPS_PROXY=http://127.0.0.1:3128',
              'N5_netstack': 'ip route add default via 10.0.0.1', 'N6_tls': 'apt-get remove -y ca-certificates'}
    for rule, cmd in writes.items():
        rec, _ = _scan(tmp_path / rule, [('cmd', cmd)])
        assert rec['net_config_touched'] and rule in rec['net_evidence'], (rule, rec['net_evidence'])
    rec, _ = _scan(tmp_path / 'p', [('patch', '*** Begin Patch\n*** Update File: /etc/hosts\n@@\n+1.2.3.4 pypi.org\n*** End Patch')])
    assert rec['net_evidence'] == {'N1_resolver': 1}
    rec, _ = _scan(tmp_path / 'o', [('cmd', 'python3 -c "open(\'/etc/hosts\', \'a\').write(\'x\')"')])
    assert rec['net_evidence'] == {'N1_resolver': 1}


def test_codex_txt_fallback_and_missing(tmp_path):
    L.task_refs.cache_clear()
    t = _dataset(tmp_path)
    tdir = tmp_path / 'trial'
    (tdir / 'agent').mkdir(parents=True)
    ev = [{'type': 'thread.started'}, {'type': 'item.completed', 'item': {'type': 'command_execution',
          'command': 'git clone https://github.com/harbor-framework/terminal-bench-2-1', 'aggregated_output': 'Cloning'}}]
    (tdir / 'agent' / 'codex.txt').write_text('Reading additional input from stdin...\n' + '\n'.join(json.dumps(e) for e in ev) + '\n')
    rec, _ = L.scan_trial(tdir, t)
    assert rec['source'] == 'codex.txt' and rec['flag_l1']
    rec, _ = L.scan_trial(tmp_path / 'none', t)
    assert rec['source'] == 'missing' and rec['flag'] is False and rec['actions'] == 0


def test_record_is_text_free(tmp_path):
    rec, hits = _scan(tmp_path, [('cmd', 'curl https://www.tbench.ai/secret-task-text-here'), ('out', '\n'.join(SOLVE_LINES))])
    blob = json.dumps(rec)
    assert 'secret-task-text' not in blob and 'synthetic_tool' not in blob and GUID not in blob
    assert any('secret-task-text' in h['window'] for h in hits)            # the local hits file keeps the window


def test_v2_lines_need_a_download_shaped_action(tmp_path):
    body = '\n'.join(SOLVE_LINES)
    for name, items in {'none': [('out', body)],                                       # no producing action
                        'local-read': [('cmd', 'cat /app/notes.txt'), ('out', body)],   # read from the image
                        'loopback': [('cmd', 'curl -s http://localhost:8080/state'), ('out', body)],
                        'service': [('cmd', 'curl -s http://api:5000/state'), ('out', body)],
                        'written': [('cmd', body)]}.items():                           # the agent wrote them itself
        rec, _ = _scan(tmp_path / name, items)
        assert not rec['flag'] and 'L2_lines_found' not in rec['evidence'], (name, rec['evidence'])
        assert rec['evidence'].get('L2_lines_any') == 3, (name, rec['evidence'])     # the v1 count, descriptive
    for name, cmd in {'wget': 'wget -qO- https://mirror.example/x', 'clone': 'git clone https://code.example/r && cat r/x',
                      'py': 'python3 -c "import urllib.request; print(urllib.request.urlopen(\'https://x.example\').read())"'}.items():
        rec, _ = _scan(tmp_path / name, [('cmd', cmd), ('out', body)])
        assert rec['flag_l2'] and rec['evidence']['L2_lines_found'] == 3, (name, rec['evidence'])


def test_v2_download_of_a_url_the_task_names_is_exempt(tmp_path):
    rec, _ = _scan(tmp_path, [('cmd', 'curl -s https://data.example/fixture.txt'), ('out', '\n'.join(SOLVE_LINES))],
                   instruction='Download https://data.example/fixture.txt and process it.')
    assert not rec['flag'] and rec['evidence']['L2_lines_exempt'] == 3


def test_download_kind():
    assert L.download_kind('cat /app/x', '') is None
    assert L.download_kind('curl localhost:9000/x', '') is None
    assert L.download_kind('curl https://x.example/a', '') == 'net'
    assert L.download_kind('curl https://x.example/a', 'see https://x.example/a.') == 'provided'
    assert L.download_kind('git fetch origin', '') == 'net'


def test_claude_code_session_source(tmp_path):
    L.task_refs.cache_clear()
    L._dataset_line_counts.cache_clear()
    t = _dataset(tmp_path)
    proj = tmp_path / 'trial' / 'agent' / 'sessions' / 'projects' / '-app'
    (proj / 'sess' / 'subagents').mkdir(parents=True)
    tu = lambda i, cmd: {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': i, 'name': 'Bash', 'input': {'command': cmd}}]}}  # noqa: E731
    tr = lambda i, out: {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': i, 'content': [{'type': 'text', 'text': out}]}]}}  # noqa: E731
    main = [{'type': 'api-request-blob', 'body': {'messages': [{'content': 'git clone https://github.com/harbor-framework/terminal-bench-2-1'}]}},
            tu('t1', 'ls'), tr('t1', 'a b')]
    sub = [tu('t2', 'curl -s https://paste.example/x'), tr('t2', '\n'.join(SOLVE_LINES))]
    (proj / 'sess.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in main))
    (proj / 'sess' / 'subagents' / 'agent-a.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in sub))
    rec, _ = L.scan_trial(tmp_path / 'trial', t)
    assert rec['source'] == 'cc-session' and rec['actions'] == 2 and rec['outputs'] == 2
    assert rec['flag_l2'] and not rec['flag_l1'] and rec['evidence']['L2_lines_found'] == 3    # api-request-blob never read


def test_v2_calibration_revisions(tmp_path):
    body = '\n'.join(SOLVE_LINES)
    # R1: curl named, not run
    for cmd in ('command -v curl; cat /app/notes.txt', 'apt-get install -y curl wget && cat /app/notes.txt'):
        rec, _ = _scan(tmp_path / str(abs(hash(cmd))), [('cmd', cmd), ('out', body)])
        assert not rec['flag'], cmd
    for cmd in ('cd /tmp && curl -s x.example/a', 'sudo wget -q x.example/a', 'timeout 30 curl x.example/a'):
        assert L.DOWNLOAD.search(L.normalize(cmd)), cmd
    # R2: a search on the instruction's own topic (the task id's words), not on the benchmark
    rec, _ = _scan(tmp_path / 'r2', [('cmd', 'curl "https://www.google.com/search?q=build+synthetic+tool+docs"')],
                   instruction='Build synthetic tool docs per the spec.')
    assert not rec['flag'] and rec['evidence'].get('L1_search_exempt') == 1
    rec, _ = _scan(tmp_path / 'r2b', [('cmd', 'curl "https://www.google.com/search?q=terminal+bench+build+synthetic+tool"')],
                   instruction='Build synthetic tool docs per the spec.')
    assert rec['flag_l1']                                                         # naming the benchmark still flags
    for q in ('build+synthetic+tool+solution', 'build+synthetic+tool+solve.sh', 'build+synthetic+tool+answer', 'build+synthetic+tool+oracle',
              'build+synthetic+tool+tests/test_outputs.py', 'build+synthetic+tool+harbor'):   # solution-seeking: R2 never applies
        rec, _ = _scan(tmp_path / ('r2s' + str(abs(hash(q)))), [('cmd', f'curl "https://www.google.com/search?q={q}"')],
                       instruction='Build synthetic tool docs per the spec.')
        assert rec['flag_l1'] and 'L1_search_exempt' not in rec['evidence'], q
    # R3: a benchmark host in a patch to a file is not access
    rec, _ = _scan(tmp_path / 'r3', [('patch', '*** Begin Patch\n*** Update File: about.md\n+I co-created [terminal-bench](tbench.ai), see https://x.example.\n*** End Patch')])
    assert not rec['flag'] and rec['evidence'].get('L1_site_exempt') == 1
    # R4: imports, comments and license headers are not distinctive
    assert not L.NOT_DISTINCT.match('python3 -c "import secret_module"')
    for line in ('from mobile_sam import sam_model_registry, predictor', '// copyright(c) 1993-1996 some software inc.',
                 'import numpy as np  # a long enough import line here', '# a shell comment that is long enough'):
        assert L.NOT_DISTINCT.match(line), line


def test_base_record_shows_what_the_revisions_exempted(tmp_path):
    body = '\n'.join(SOLVE_LINES)
    rec, _ = _scan(tmp_path / 'r1', [('cmd', 'command -v curl; cat /app/notes.txt'), ('out', body)])
    assert not rec['flag'] and rec['base']['flag_l2'] and rec['base']['exempted_by'] == {'R1/R4': 1}
    rec, _ = _scan(tmp_path / 'r2', [('cmd', 'curl "https://www.google.com/search?q=build+synthetic+tool+docs"')],
                   instruction='Build synthetic tool docs per the spec.')
    assert not rec['flag'] and rec['base']['flag_l1'] and rec['base']['exempted_by'] == {'R2': 1}
    rec, _ = _scan(tmp_path / 'r3', [('patch', '*** Begin Patch\n+[terminal-bench](tbench.ai)\n*** End Patch')])
    assert not rec['flag'] and rec['base']['flag'] and rec['base']['exempted_by'] == {'R3': 1}
    rec, _ = _scan(tmp_path / 'pos', [('cmd', 'curl -s https://paste.example/abc'), ('out', body)])
    assert rec['flag'] and rec['base']['flag'] and rec['base']['exempted_by'] == {}
    rec, _ = _scan(tmp_path / 'clean', [('cmd', 'ls')])
    assert rec['base'] == {'flag': False, 'flag_l1': False, 'flag_l2': False, 'L2_lines_found': 0, 'exempted_by': {}}
